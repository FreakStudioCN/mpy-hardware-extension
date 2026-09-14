//! The Tauri shell over the core: mirrors `cli/src/main.rs::run()`'s wiring
//! for each op, forwards `core::progress::ProgressEvent`s to the window as
//! `progress` events, and emits one terminal `op-result` event per command.
//! No operation lives here that `core::ops` does not already implement --
//! this file is wiring, the same way `cli/src/main.rs` is.
//!
//! Unlike the CLI (`cli/src/cli.rs` argument grammar vs `cli/src/main.rs`
//! dispatch), this crate is not split into an OS-gated and an OS-ungated
//! half: it inherently compiles only on macOS/Windows
//! (`blockless_installer_core::system::SystemEnvironment` is cfg-gated), and
//! is excluded from the root Cargo workspace precisely so nothing on Linux
//! ever tries to build it (see `../Cargo.toml`'s `exclude`).

use blockless_installer_core::bootstrap::{
    self, default_manifest_path, resolve_vsix_path, MANIFEST_FILE_NAME,
};
use blockless_installer_core::fetch::{download_client, FetchOptions};
use blockless_installer_core::manifest::Manifest;
use blockless_installer_core::ops;
use blockless_installer_core::platform::{code_cli_candidates, Arch, Os, Paths, RawEnv};
use blockless_installer_core::progress::{ProgressEvent, ProgressSink};
use blockless_installer_core::system::SystemEnvironment;
use blockless_installer_core::uninstall::{UninstallFlags, UninstallOutcome};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// A user who repeatedly hits Install into a stalled download accumulates
/// one abandoned watchdog thread per stalled attempt -- see
/// `core::fetch::run_attempt_with_idle_timeout`'s own doc comment, which
/// names this shell explicitly as the long-lived host that inherits the
/// concern a short-lived CLI process never had to answer. Bounding total
/// install attempts per process life caps that blast radius: past the
/// limit, quitting and reopening the app is the only way to reclaim
/// whatever a stalled peer's connections may still be holding open.
///
/// In this PR's UI the terminal screens (success/failure) offer no way
/// back to a fresh Install click, so in practice one process life already
/// means one attempt; this constant is the answer for whenever that
/// changes (a "try again"/repair affordance, `repair`/`update-extension`
/// exposed in the GUI, and so on) rather than something silently left to
/// be rediscovered then.
const MAX_INSTALL_ATTEMPTS_PER_PROCESS: u32 = 5;

fn install_attempt_allowed(attempt: u32) -> bool {
    attempt <= MAX_INSTALL_ATTEMPTS_PER_PROCESS
}

struct AppState {
    /// Shared with the window-close handler directly (not looked up via
    /// `Manager::state` from inside that closure), so the close guard never
    /// depends on exactly which handle type a future Tauri version hands
    /// that callback.
    op_running: Arc<AtomicBool>,
    install_attempts: AtomicU32,
}

/// Releases `op_running` on every exit path from the command body that
/// acquired it -- success, an early `?` return, or a panic unwinding
/// through it -- by construction, since `Drop` runs regardless of how the
/// enclosing scope ends. This is what "released on both success and error
/// paths" means here: nothing downstream has to remember to release it.
struct OpGuard<'a>(&'a AtomicBool);

impl<'a> OpGuard<'a> {
    fn try_acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| OpGuard(flag))
    }
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Forwards every `core::ops` progress event straight to the window as a
/// `progress` event; `main.js` renders the fixed per-op step list against
/// its `type`/`step`/`skipped` fields.
struct WindowProgressSink {
    app: tauri::AppHandle,
}

impl ProgressSink for WindowProgressSink {
    fn emit(&self, event: &ProgressEvent) {
        let _ = self.app.emit("progress", event.clone());
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpResult {
    op: &'static str,
    ok: bool,
    message: String,
    log_path: Option<String>,
}

/// The bundle's own resource directory, or `None` outside a bundle (a plain
/// `cargo run`) or when Tauri cannot resolve one. Only Tauri knows where its
/// bundle put things, which is why this needs the `AppHandle` and why it is
/// read here rather than inside the worker thread.
fn bundle_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// Where `installer.manifest.json` may live, in the order it is looked for.
///
/// Exe-adjacent FIRST, always. That is the sidecar contract the rig and the
/// CLI both use -- a release binary with a freshly stamped manifest and the
/// VSIX it covers beside it -- and a stamped manifest an operator just put
/// there must beat anything baked into a bundle, or a stale bundled copy
/// silently wins and the run verifies the wrong artifact.
///
/// The bundle resource directory is the fallback, and it exists because the
/// two platforms disagree. On Windows the resource directory IS the
/// executable's directory, so a declared resource is already found by the
/// first candidate. On macOS it is `Contents/Resources` while the executable
/// sits in `Contents/MacOS`, so without this second candidate a bundle can
/// never find a manifest at all, whatever `tauri.conf.json` declares.
///
/// Deduplicated, so the Windows and development cases do not report the same
/// path twice when a lookup fails.
///
/// `tauri.conf.json` declares the manifest under `bundle.resources` in MAP
/// form. It has to be a map: a list mangles a leading `../` into `_up_/`,
/// which would break the manifest-relative path the VSIX resolves through.
/// That config file rejects unknown keys, so this note lives here.
///
/// What a bundle gets today is the COMMITTED manifest, whose hashes are all
/// zeros on purpose. So a bundle built without a stamping step finds a
/// manifest, fails the sha check and installs nothing. That is the honest
/// outcome and it is deliberate: the VSIX is not reproducible, so a stamped
/// manifest is only valid for the exact VSIX beside it, and baking a real
/// hash in would be a lie the moment the VSIX is rebuilt. A bundle that can
/// install needs a stamp-and-inject packaging step, which does not exist
/// yet.
fn manifest_candidates(exe_adjacent: PathBuf, resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut candidates = vec![exe_adjacent];
    if let Some(dir) = resource_dir {
        let bundled = dir.join(MANIFEST_FILE_NAME);
        if bundled != candidates[0] {
            candidates.push(bundled);
        }
    }
    candidates
}

/// Read the first manifest that exists among [`manifest_candidates`], and
/// resolve the VSIX relative to THAT manifest's own directory, so a bundled
/// manifest looks for a bundled VSIX and a sidecar manifest looks beside
/// itself.
///
/// On failure the error names every location searched. Naming only the first
/// sends the reader to the wrong place on the platform where the first is not
/// where the file was shipped.
/// Read the first manifest that EXISTS, in `candidates` order.
///
/// Only `NotFound` moves on to the next candidate. Every other error stops
/// here and surfaces, because a sidecar that exists but cannot be read is
/// not the same fact as one that was never placed. Treating the two alike
/// would let a damaged or unreadable sidecar fall through to the bundled
/// zero-hash manifest, which silently inverts the precedence rule the
/// candidate order exists to enforce: the operator's stamped file would
/// lose to a baked-in one, and the run would verify the wrong artifact
/// while reporting nothing.
///
/// Invalid UTF-8 arrives as `InvalidData` and surfaces here too, which is
/// right: that file was meant to be the manifest.
fn read_first_manifest(candidates: &[PathBuf]) -> Result<(&PathBuf, String), String> {
    for path in candidates {
        match std::fs::read_to_string(path) {
            Ok(json) => return Ok((path, json)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        }
    }
    let searched = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "could not read {MANIFEST_FILE_NAME}; searched: {searched}"
    ))
}

fn load_manifest_and_vsix(resource_dir: Option<PathBuf>) -> Result<(Manifest, PathBuf), String> {
    let candidates = manifest_candidates(default_manifest_path(), resource_dir);
    let (manifest_path, manifest_json) = read_first_manifest(&candidates)?;
    let manifest = Manifest::parse(&manifest_json).map_err(|e| e.to_string())?;
    let vsix_path = resolve_vsix_path(None, manifest_path, &manifest.components.extension.path);
    Ok((manifest, vsix_path))
}

/// Mirrors `cli/src/main.rs::run()`'s wiring, minus logging init (this
/// shell installs one subscriber at startup, not per-op) and minus the
/// `vsix` CLI override (the GUI always uses the manifest's bundled path).
fn build_context<'a>(
    manifest: &'a Manifest,
    vsix_path: PathBuf,
    progress: &'a dyn ProgressSink,
) -> Result<ops::OpsContext<'a>, String> {
    let raw = RawEnv::from_process();
    let os = Os::detect(&raw).map_err(|e| e.to_string())?;
    let arch = Arch::detect(os, &raw).map_err(|e| e.to_string())?;
    let paths = Paths::resolve(os, &raw).map_err(|e| e.to_string())?;
    let candidates = code_cli_candidates(os, &raw).map_err(|e| e.to_string())?;
    let mac_install_targets = bootstrap::mac_install_targets(os, &raw);
    let client = download_client().map_err(|e| e.to_string())?;
    Ok(ops::OpsContext {
        os,
        arch,
        paths,
        manifest,
        client,
        fetch_opts: FetchOptions::default(),
        code_candidates: candidates,
        mac_install_targets,
        vsix_path: Some(vsix_path),
        progress,
    })
}

fn log_path_of(ctx: &ops::OpsContext) -> Option<String> {
    Some(
        ctx.paths
            .logs
            .join("installer.log")
            .to_string_lossy()
            .into_owned(),
    )
}

/// Ports `cli/src/main.rs`'s `UninstallOutcome` -> user-facing string
/// mapping verbatim (same wording, including the CLI's own `--all`
/// reference in the "kept but owned" note -- this GUI has no such flag, but
/// the scope calls for string parity with the CLI here, not a rewrite).
fn uninstall_outcome_message(outcome: &UninstallOutcome) -> (bool, String) {
    match outcome {
        UninstallOutcome::VscodeRunning => (
            false,
            "VS Code is running; quit it and re-run to uninstall. Nothing was removed.".to_string(),
        ),
        UninstallOutcome::ProcessCheckFailed => (
            false,
            "could not confirm VS Code is closed; nothing was removed.".to_string(),
        ),
        UninstallOutcome::AbortedUnreadableState => (
            false,
            "state.json exists but is unreadable/incomplete; cannot determine what to remove. \
             Nothing was removed."
                .to_string(),
        ),
        UninstallOutcome::Finished {
            invariant_guard_tripped: true,
            ..
        } => (
            false,
            "could not confirm the profile was fully removed; the ownership journal was left \
             intact so a re-run can finish. Nothing else was removed."
                .to_string(),
        ),
        UninstallOutcome::Finished {
            vscode_removal_failed: true,
            profile_removed,
            ..
        } => (
            false,
            format!(
                "VS Code could not be fully removed; the ownership journal was kept so a re-run \
                 can finish. profile_removed={profile_removed}; BLK was left in place."
            ),
        ),
        UninstallOutcome::Finished {
            profile_removed,
            blk_removed,
            blk_removal_partial,
            vscode_removed,
            vscode_kept_but_owned,
            ..
        } => {
            let mut message = format!(
                "done: profile_removed={profile_removed} blk_removed={blk_removed} \
                 blk_removal_partial={blk_removal_partial} vscode_removed={vscode_removed}"
            );
            if *vscode_kept_but_owned {
                message.push_str(
                    "\nnote: VS Code was installed by this installer and is being left in \
                     place; it is no longer tracked, and --all is the only way to remove it \
                     later.",
                );
            }
            (true, message)
        }
    }
}

#[tauri::command]
async fn run_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _guard = OpGuard::try_acquire(&state.op_running)
        .ok_or_else(|| "an operation is already running".to_string())?;
    let attempt = state.install_attempts.fetch_add(1, Ordering::SeqCst) + 1;
    if !install_attempt_allowed(attempt) {
        return Err(format!(
            "too many install attempts in this session ({MAX_INSTALL_ATTEMPTS_PER_PROCESS} max); \
             restart Blockless Installer to try again"
        ));
    }

    let resource_dir = bundle_resource_dir(&app);
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> OpResult {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = match load_manifest_and_vsix(resource_dir) {
            Ok(v) => v,
            Err(message) => {
                return OpResult {
                    op: "install",
                    ok: false,
                    message,
                    log_path: None,
                }
            }
        };
        let ctx = match build_context(&manifest, vsix_path, &sink) {
            Ok(ctx) => ctx,
            Err(message) => {
                return OpResult {
                    op: "install",
                    ok: false,
                    message,
                    log_path: None,
                }
            }
        };
        // Only install creates logs/ -- never at startup (see
        // PerWriteFileWriter's own doc comment: recreating it there would
        // put BLK back on a machine reopening this app after a PRIOR
        // process already uninstalled from it, not just mid-run).
        // install's own steps are what the log exists to capture, so it
        // has to exist before ops::install runs, not after.
        let _ = std::fs::create_dir_all(&ctx.paths.logs);
        let log_path = log_path_of(&ctx);
        let env = SystemEnvironment;
        match ops::install(&env, &ctx) {
            Ok(_state) => OpResult {
                op: "install",
                ok: true,
                message: "install finished".to_string(),
                log_path,
            },
            Err(e) => OpResult {
                op: "install",
                ok: false,
                message: e.to_string(),
                log_path,
            },
        }
    })
    .await
    .unwrap_or_else(|e| OpResult {
        op: "install",
        ok: false,
        message: format!("install worker crashed: {e}"),
        log_path: None,
    });

    // Release the "op running" guard BEFORE telling the window the op is
    // over: emitting op-result is what the UI acts on to re-enable
    // Install/Advanced, so a click landing in the instant right after that
    // emit must never be refused as "already running".
    drop(_guard);
    let _ = app.emit("op-result", result);
    Ok(())
}

#[tauri::command]
async fn run_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _guard = OpGuard::try_acquire(&state.op_running)
        .ok_or_else(|| "an operation is already running".to_string())?;

    let resource_dir = bundle_resource_dir(&app);
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> OpResult {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = match load_manifest_and_vsix(resource_dir) {
            Ok(v) => v,
            Err(message) => {
                return OpResult {
                    op: "uninstall",
                    ok: false,
                    message,
                    log_path: None,
                }
            }
        };
        let ctx = match build_context(&manifest, vsix_path, &sink) {
            Ok(ctx) => ctx,
            Err(message) => {
                return OpResult {
                    op: "uninstall",
                    ok: false,
                    message,
                    log_path: None,
                }
            }
        };
        let log_path = log_path_of(&ctx);
        let env = SystemEnvironment;
        let outcome = ops::uninstall(&env, &ctx, &UninstallFlags::default());
        let (ok, message) = uninstall_outcome_message(&outcome);
        OpResult {
            op: "uninstall",
            ok,
            message,
            log_path,
        }
    })
    .await
    .unwrap_or_else(|e| OpResult {
        op: "uninstall",
        ok: false,
        message: format!("uninstall worker crashed: {e}"),
        log_path: None,
    });

    // Release the "op running" guard BEFORE telling the window the op is
    // over: emitting op-result is what the UI acts on to re-enable
    // Install/Advanced, so a click landing in the instant right after that
    // emit must never be refused as "already running".
    drop(_guard);
    let _ = app.emit("op-result", result);
    Ok(())
}

#[tauri::command]
async fn save_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let _guard = OpGuard::try_acquire(&state.op_running)
        .ok_or_else(|| "an operation is already running".to_string())?;

    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name("blockless-diagnostics.zip")
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("save-dialog worker crashed: {e}"))?;

    let Some(picked) = picked else {
        // The user cancelled the save dialog -- not an error.
        return Ok(None);
    };
    // `simplified()` normalizes a Windows UNC path before the conversion;
    // a no-op for the `Url` variant a save dialog can't actually return.
    let target_path = picked.simplified().into_path().map_err(|e| e.to_string())?;

    let resource_dir = bundle_resource_dir(&app);
    let worker_app = app.clone();
    let target_for_worker = target_path.clone();
    let result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = load_manifest_and_vsix(resource_dir)?;
        let ctx = build_context(&manifest, vsix_path, &sink)?;
        ops::diagnostics(&ctx, &target_for_worker).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("diagnostics worker crashed: {e}"))?;

    result.map(|()| Some(target_path.to_string_lossy().into_owned()))
}

/// Never keeps `installer.log` open persistently: this window is long-lived
/// and holds Uninstall, which may delete the very directory a held handle
/// lives under (a real risk on Windows). Opens, appends, and closes on
/// every single write -- the GUI's version of the CLI's
/// `init_stderr_logging`/`init_logging` per-process posture
/// (`cli/src/main.rs`), just per-write instead of per-process.
///
/// `logs_dir` is never created inside `write` -- only `run_install`
/// creates it (once, before `ops::install` runs, since install's own
/// steps are what the log exists to capture). NOT at startup either: this
/// directory sits inside `BLK`, which a PRIOR process's `uninstall` may
/// have deleted, and re-creating it the moment this window opens would
/// silently put `BLK` back on a machine that was supposed to be clean --
/// the same failure one layer out from recreating it mid-run. A missing/
/// unwritable `logs/` (including "uninstalled, never reinstalled since")
/// is exactly the case this must degrade out of: drop the line, never
/// panic, and never recreate what uninstall removed.
#[derive(Clone)]
struct PerWriteFileWriter {
    logs_dir: PathBuf,
}

impl std::io::Write for PerWriteFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let path = self.logs_dir.join("installer.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = std::io::Write::write_all(&mut file, buf);
            let _ = std::io::Write::flush(&mut file);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for PerWriteFileWriter {
    type Writer = PerWriteFileWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn init_logging() {
    let raw = RawEnv::from_process();
    let Some(logs_dir) = Os::detect(&raw)
        .ok()
        .and_then(|os| Paths::resolve(os, &raw).ok())
        .map(|paths| paths.logs)
    else {
        return;
    };
    // No create_dir_all here -- see PerWriteFileWriter's own doc comment
    // for why startup is exactly the wrong place for it too, not just
    // inside write().
    let writer = PerWriteFileWriter { logs_dir };
    let _ = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
}

fn main() {
    init_logging();

    let op_running = Arc::new(AtomicBool::new(false));
    let op_running_for_close = op_running.clone();
    // Guards the two real RunEvent::ExitRequested producers: the last
    // window being destroyed (pre-empted anyway by the CloseRequested
    // guard above while an op runs) and a future AppHandle::exit/restart
    // call, should one ever be added. NOT a guard against macOS Cmd+Q /
    // the app menu's Quit: Tauri's default macOS Quit item goes straight
    // to the OS `terminate:` selector, which this stack never intercepts,
    // so it reaches RunEvent::Exit (unpreventable) without ever visiting
    // ExitRequested. Closing that specific gap needs a custom Quit
    // MenuItem routed through AppHandle::exit -- not done here; the
    // window's own close button is what scope's review focus actually
    // names, and that path stays fully guarded above.
    let op_running_for_exit = op_running.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            op_running,
            install_attempts: AtomicU32::new(0),
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if op_running_for_close.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("close-refused", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_install,
            run_uninstall,
            save_diagnostics
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if op_running_for_exit.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_attempts_are_allowed_up_to_the_limit_then_refused() {
        for attempt in 1..=MAX_INSTALL_ATTEMPTS_PER_PROCESS {
            assert!(install_attempt_allowed(attempt), "attempt {attempt}");
        }
        assert!(!install_attempt_allowed(
            MAX_INSTALL_ATTEMPTS_PER_PROCESS + 1
        ));
    }

    #[test]
    fn op_guard_refuses_a_second_acquire_while_held_and_releases_on_drop() {
        let flag = AtomicBool::new(false);
        let first = OpGuard::try_acquire(&flag).expect("first acquire must succeed");
        assert!(
            OpGuard::try_acquire(&flag).is_none(),
            "must refuse a second concurrent acquire"
        );
        drop(first);
        assert!(
            OpGuard::try_acquire(&flag).is_some(),
            "must be acquirable again once the first guard is dropped"
        );
    }

    /// Regression test for the round-1 finding: `write` used to
    /// `create_dir_all` the log directory on every call, which silently
    /// put `BLK` back on disk the moment anything logged after
    /// `ops::uninstall` had already removed it. A write against a
    /// directory that does not exist must be dropped, not recreate it.
    #[test]
    fn a_write_after_the_logs_dir_is_gone_drops_the_line_and_never_recreates_it() {
        use std::sync::atomic::AtomicU64;
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let logs_dir = std::env::temp_dir().join(format!(
            "blockless-installer-gui-writer-test-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&logs_dir);
        assert!(!logs_dir.exists(), "test setup: must start absent");

        let mut writer = PerWriteFileWriter {
            logs_dir: logs_dir.clone(),
        };
        let written = std::io::Write::write(&mut writer, b"a log line\n").unwrap();

        assert_eq!(
            written, 11,
            "must report the full buffer written even on drop"
        );
        assert!(
            !logs_dir.exists(),
            "a write against a missing logs/ must never recreate it"
        );
    }

    #[test]
    fn uninstall_outcome_message_matches_cli_wording_for_every_variant() {
        assert_eq!(
            uninstall_outcome_message(&UninstallOutcome::VscodeRunning),
            (
                false,
                "VS Code is running; quit it and re-run to uninstall. Nothing was removed."
                    .to_string()
            )
        );
        assert_eq!(
            uninstall_outcome_message(&UninstallOutcome::ProcessCheckFailed),
            (
                false,
                "could not confirm VS Code is closed; nothing was removed.".to_string()
            )
        );
        assert!(!uninstall_outcome_message(&UninstallOutcome::AbortedUnreadableState).0);

        let guard_tripped = UninstallOutcome::Finished {
            profile_removed: false,
            blk_removed: false,
            blk_removal_partial: false,
            vscode_removed: false,
            invariant_guard_tripped: true,
            vscode_kept_but_owned: false,
            vscode_removal_failed: false,
        };
        let (ok, message) = uninstall_outcome_message(&guard_tripped);
        assert!(!ok);
        assert!(message.contains("ownership journal was left intact"));

        let vscode_failed = UninstallOutcome::Finished {
            profile_removed: true,
            blk_removed: false,
            blk_removal_partial: false,
            vscode_removed: false,
            invariant_guard_tripped: false,
            vscode_kept_but_owned: false,
            vscode_removal_failed: true,
        };
        let (ok, message) = uninstall_outcome_message(&vscode_failed);
        assert!(!ok);
        assert!(message.contains("profile_removed=true"));
        assert!(message.contains("BLK was left in place"));

        let kept_but_owned = UninstallOutcome::Finished {
            profile_removed: true,
            blk_removed: true,
            blk_removal_partial: false,
            vscode_removed: false,
            invariant_guard_tripped: false,
            vscode_kept_but_owned: true,
            vscode_removal_failed: false,
        };
        let (ok, message) = uninstall_outcome_message(&kept_but_owned);
        assert!(ok);
        assert!(message.contains("done: profile_removed=true"));
        assert!(message.contains("--all is the only way to remove it later"));

        let plain_finish = UninstallOutcome::Finished {
            profile_removed: true,
            blk_removed: true,
            blk_removal_partial: false,
            vscode_removed: true,
            invariant_guard_tripped: false,
            vscode_kept_but_owned: false,
            vscode_removal_failed: false,
        };
        let (ok, message) = uninstall_outcome_message(&plain_finish);
        assert!(ok);
        assert_eq!(
            message,
            "done: profile_removed=true blk_removed=true blk_removal_partial=false \
             vscode_removed=true"
        );
    }

    /// The exact JSON shape `app/ui/main.js` switches on: a `type` tag plus
    /// the event's own fields, camelCase-free (these are already
    /// single-word field names).
    #[test]
    fn progress_event_json_shape_matches_what_the_frontend_expects() {
        let started = ProgressEvent::StepStarted {
            op: "install",
            step: 1,
            name: "vscode",
        };
        let json = serde_json::to_value(&started).unwrap();
        assert_eq!(json["type"], "StepStarted");
        assert_eq!(json["op"], "install");
        assert_eq!(json["step"], 1);
        assert_eq!(json["name"], "vscode");

        let finished = ProgressEvent::StepFinished {
            op: "install",
            step: 1,
            name: "vscode",
            skipped: Some(true),
        };
        let json = serde_json::to_value(&finished).unwrap();
        assert_eq!(json["type"], "StepFinished");
        assert_eq!(json["skipped"], true);
    }

    #[test]
    fn op_result_json_shape_is_camel_case_for_log_path() {
        let result = OpResult {
            op: "install",
            ok: false,
            message: "boom".to_string(),
            log_path: Some("/tmp/installer.log".to_string()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["op"], "install");
        assert_eq!(json["ok"], false);
        assert_eq!(json["message"], "boom");
        assert_eq!(json["logPath"], "/tmp/installer.log");
    }

    /// The ordering is the whole point. A stamped manifest an operator just
    /// placed beside the executable must beat a copy baked into the bundle,
    /// or a stale bundled manifest silently decides which artifact gets
    /// verified.
    #[test]
    fn an_exe_adjacent_manifest_is_searched_before_a_bundled_one() {
        let candidates = manifest_candidates(
            PathBuf::from("/app/Contents/MacOS/installer.manifest.json"),
            Some(PathBuf::from("/app/Contents/Resources")),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/app/Contents/MacOS/installer.manifest.json"),
                PathBuf::from("/app/Contents/Resources/installer.manifest.json"),
            ]
        );
    }

    /// Windows puts resources in the executable's own directory, so both
    /// candidates resolve to one path. Reporting it twice in a failure
    /// message reads as two places having been tried.
    #[test]
    fn one_directory_serving_both_roles_is_listed_once() {
        let candidates = manifest_candidates(
            PathBuf::from("/install/installer.manifest.json"),
            Some(PathBuf::from("/install")),
        );
        assert_eq!(
            candidates,
            vec![PathBuf::from("/install/installer.manifest.json")]
        );
    }

    /// A plain `cargo run` has no bundle, so there is nothing to fall back
    /// to and the sidecar path is the only one.
    #[test]
    fn without_a_bundle_only_the_exe_adjacent_path_is_searched() {
        let candidates =
            manifest_candidates(PathBuf::from("/target/debug/installer.manifest.json"), None);
        assert_eq!(
            candidates,
            vec![PathBuf::from("/target/debug/installer.manifest.json")]
        );
    }

    /// An absent sidecar is a different fact from an unreadable one. Only
    /// the first may fall through to the bundle: letting the second through
    /// would hand precedence to the baked-in zero-hash manifest and verify
    /// the wrong artifact, reporting nothing.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_sidecar_fails_rather_than_falling_through_to_the_bundle() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("blockless-unreadable-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sidecar = dir.join(MANIFEST_FILE_NAME);
        let bundled = dir.join("bundle").join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, "{}").unwrap();
        std::fs::write(&bundled, "{}").unwrap();
        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o000)).unwrap();

        let err = read_first_manifest(&[sidecar.clone(), bundled])
            .expect_err("an unreadable sidecar must stop the search, not be skipped");
        assert!(
            err.contains(&sidecar.display().to_string()),
            "the error must name the sidecar that could not be read, got: {err}"
        );

        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The ordinary case the fall-through exists for: nothing beside the
    /// executable, so the bundled copy is used.
    #[test]
    fn an_absent_sidecar_falls_through_to_the_bundled_manifest() {
        let dir = std::env::temp_dir().join("blockless-absent-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join(MANIFEST_FILE_NAME);
        let bundled = dir.join("bundle").join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, "{\"marker\":1}").unwrap();

        let candidates = [missing, bundled.clone()];
        let (found, json) = read_first_manifest(&candidates).expect("the bundled copy is readable");
        assert_eq!(found, &bundled);
        assert!(json.contains("marker"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The failure a user actually sees. Naming only the first candidate
    /// sends them to `Contents/MacOS` when the file was shipped to
    /// `Contents/Resources`.
    #[test]
    fn a_missing_manifest_names_every_location_searched() {
        let missing = std::env::temp_dir().join("blockless-nonexistent-bundle");
        let err = load_manifest_and_vsix(Some(missing.clone()))
            .expect_err("no manifest exists at either candidate");
        assert!(err.contains(MANIFEST_FILE_NAME), "{err}");
        assert!(
            err.contains(&missing.join(MANIFEST_FILE_NAME).display().to_string()),
            "the bundle candidate must appear in the error, got: {err}"
        );
    }
}
