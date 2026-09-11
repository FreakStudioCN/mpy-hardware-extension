//! clap subcommand per op (the same operations a future GUI would call
//! through `ops.rs` directly): `install`, `repair`, `repair-runtime`,
//! `update-extension`, `verify`, `diagnostics`, `uninstall`. The argument
//! grammar itself lives in `cli.rs`, ungated, so it's unit-tested on every
//! target; only the dispatch body below needs an OS.
//!
//! The real body only compiles on macOS/Windows: it references
//! `blockless_installer_core::system::SystemEnvironment`, which is itself
//! cfg-gated per target (see `core/src/system.rs`'s module doc for why). On
//! any other target -- this workspace's own `cargo test`/`clippy` sandbox
//! included -- `main` is a trivial stub, so the crate still compiles and
//! lints cleanly everywhere the ubuntu CI job runs it, without pretending
//! this binary is meant to run there.

mod cli;

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn main() {
    real_main::run();
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn main() {
    eprintln!("blockless-installer only supports macOS and Windows.");
    std::process::exit(1);
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod real_main {
    use crate::cli::{resolve_vsix_path, Cli, Command};
    use blockless_installer_core::fetch::{download_client, FetchOptions};
    use blockless_installer_core::manifest::Manifest;
    use blockless_installer_core::platform::{Arch, Os, Paths, RawEnv};
    use blockless_installer_core::state::State;
    use blockless_installer_core::system::SystemEnvironment;
    use blockless_installer_core::uninstall::{UninstallFlags, UninstallOutcome};
    use blockless_installer_core::verify::CheckResult;
    use blockless_installer_core::{ops, verify};
    use clap::Parser;
    use std::path::PathBuf;

    fn default_manifest_path() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join("installer.manifest.json")))
            .unwrap_or_else(|| PathBuf::from("installer.manifest.json"))
    }

    fn die(msg: impl std::fmt::Display) -> ! {
        eprintln!("blockless-installer: {msg}");
        std::process::exit(1);
    }

    /// A single ever-appended `logs/installer.log` (ARCHITECTURE §9), so a
    /// repeat run's steps land alongside the first rather than overwriting
    /// them -- ops.rs's own `install`/`repair` step 1 and step 4 lines carry
    /// a `skipped`/`applied` field, so a support engineer reading the file
    /// can tell a skip from a re-do on those two steps (§13); steps 2/3
    /// expose no skip signal from their own step modules, so they log a
    /// bare "done" either way. Synchronous (a `Mutex<File>` writer, no
    /// background-thread appender crate): every
    /// line is on disk
    /// before the `info!`/`warn!` call returns, so a line can never be lost
    /// to `std::process::exit` -- every failure path in this binary
    /// (`die`, the verify-failure exit) calls it directly, with no `Drop`
    /// to flush a buffered writer first.
    ///
    /// Best-effort: an unwritable/full `BLK` must never abort an install
    /// over a support-only feature, so a failure to create the directory or
    /// open the file just skips file logging (a one-line stderr note),
    /// never panics.
    fn init_logging(logs_dir: &std::path::Path) {
        if let Err(e) = std::fs::create_dir_all(logs_dir) {
            eprintln!(
                "blockless-installer: could not create {}: {e} (continuing without file logging)",
                logs_dir.display()
            );
            return;
        }
        let path = logs_dir.join("installer.log");
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "blockless-installer: could not open {}: {e} (continuing without file logging)",
                    path.display()
                );
                return;
            }
        };
        let _ = tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false)
            .try_init();
    }

    /// `uninstall`'s variant: never hold a log file handle inside `BLK`
    /// while this run might `remove_dir_all` it (a real risk on Windows).
    /// Three of `uninstall`'s four outcomes (`VscodeRunning`,
    /// `AbortedUnreadableState`, a tripped invariant guard) never delete
    /// `BLK` at all -- exactly the cases worth a diagnosis -- so this
    /// stays useful to the operator on the console instead of dropping the
    /// op's `info!`/`warn!` lines entirely.
    fn init_stderr_logging() {
        let _ = tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .try_init();
    }

    fn mac_install_targets(os: Os, raw: &RawEnv) -> Vec<PathBuf> {
        match os {
            Os::MacOs => {
                let home = raw.home.as_deref().unwrap_or_default();
                vec![
                    PathBuf::from("/Applications"),
                    PathBuf::from(home).join("Applications"),
                ]
            }
            Os::Windows => vec![],
        }
    }

    fn print_verify_results(results: &[CheckResult]) -> bool {
        for r in results {
            let tag = if r.pass { "PASS" } else { "FAIL" };
            println!("{tag}: {}", r.message);
        }
        println!("----");
        let ok = verify::all_pass(results);
        if ok {
            println!("ALL PASS");
        } else {
            let n = results.iter().filter(|r| !r.pass).count();
            println!("{n} FAILED");
        }
        ok
    }

    fn report_state(result: Result<State, ops::OpsError>) {
        match result {
            Ok(state) => {
                println!(
                    "done: vscode={} extension={} python={} settings={}",
                    state.steps.vscode,
                    state.steps.extension,
                    state.steps.python,
                    state.steps.settings
                );
            }
            Err(e) => die(e),
        }
    }

    pub fn run() {
        let cli = Cli::parse();

        let manifest_path = cli.manifest.clone().unwrap_or_else(default_manifest_path);
        let manifest_json = std::fs::read_to_string(&manifest_path).unwrap_or_else(|e| {
            die(format!(
                "could not read manifest at {}: {e}",
                manifest_path.display()
            ))
        });
        let manifest = Manifest::parse(&manifest_json).unwrap_or_else(|e| die(e));
        let vsix_path = resolve_vsix_path(
            cli.vsix.as_deref(),
            &manifest_path,
            &manifest.components.extension.path,
        );

        let raw = RawEnv::from_process();
        let os = Os::detect(&raw).unwrap_or_else(|e| die(e));
        let arch = Arch::detect(os, &raw).unwrap_or_else(|e| die(e));
        let paths = Paths::resolve(os, &raw).unwrap_or_else(|e| die(e));
        // Uninstall may delete BLK (which owns logs/) this run -- never hold
        // an open log file handle inside a tree we're about to remove (a
        // real risk on Windows, where a still-open file can block or
        // partially defeat the delete).
        if matches!(cli.command, Command::Uninstall { .. }) {
            init_stderr_logging();
        } else {
            init_logging(&paths.logs);
        }
        let code_candidates = blockless_installer_core::platform::code_cli_candidates(os, &raw)
            .unwrap_or_else(|e| die(e));
        let targets = mac_install_targets(os, &raw);

        let ctx = ops::OpsContext {
            os,
            arch,
            paths,
            manifest: &manifest,
            client: download_client().unwrap_or_else(|e| die(e)),
            fetch_opts: FetchOptions::default(),
            code_candidates,
            mac_install_targets: targets,
            vsix_path: Some(vsix_path),
        };

        let env = SystemEnvironment;

        match &cli.command {
            Command::Install => report_state(ops::install(&env, &ctx)),
            Command::Repair => report_state(ops::repair(&env, &ctx)),
            Command::RepairRuntime => report_state(ops::repair_runtime(&env, &ctx)),
            Command::UpdateExtension => report_state(ops::update_extension(&env, &ctx)),
            Command::Verify => {
                let results = ops::verify(&env, &ctx);
                if !print_verify_results(&results) {
                    std::process::exit(1);
                }
            }
            Command::Diagnostics { output } => match ops::diagnostics(&ctx, output) {
                Ok(()) => println!("diagnostics bundle written to {}", output.display()),
                Err(e) => die(e),
            },
            Command::Uninstall { all, keep_vscode } => {
                let flags = UninstallFlags {
                    all: *all,
                    keep_vscode: *keep_vscode,
                };
                match ops::uninstall(&env, &ctx, &flags) {
                    UninstallOutcome::VscodeRunning => {
                        println!("VS Code is running; quit it and re-run to uninstall. Nothing was removed.");
                    }
                    UninstallOutcome::ProcessCheckFailed => {
                        die("could not confirm VS Code is closed; nothing was removed.");
                    }
                    UninstallOutcome::AbortedUnreadableState => {
                        die("state.json exists but is unreadable/incomplete; cannot determine what to remove. Nothing was removed.");
                    }
                    UninstallOutcome::Finished {
                        profile_removed,
                        blk_removed,
                        blk_removal_partial,
                        vscode_removed,
                        invariant_guard_tripped,
                    } => {
                        if invariant_guard_tripped {
                            die("could not confirm the profile was fully removed; the ownership journal was left intact so a re-run can finish. Nothing else was removed.");
                        }
                        println!(
                            "done: profile_removed={profile_removed} blk_removed={blk_removed} blk_removal_partial={blk_removal_partial} vscode_removed={vscode_removed}"
                        );
                    }
                }
            }
        }
    }
}
