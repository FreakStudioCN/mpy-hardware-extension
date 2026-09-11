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

use blockless_installer_core::bootstrap::{self, default_manifest_path, resolve_vsix_path};
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
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

/// A user who repeatedly hits Install into a stalled download accumulates
/// one abandoned watchdog thread per stalled attempt -- see
/// `core::fetch::run_attempt_with_idle_timeout`'s own doc comment, which
/// names this shell explicitly as the long-lived host that inherits the
/// concern a short-lived CLI process never had to answer. Bounding total
/// install attempts per process life caps that blast radius: past the
/// limit, quitting and reopening the app is the only way to reclaim
/// whatever a stalled peer's connections may still be holding open, and the
/// UI is told to say so rather than let the user keep retrying forever in
/// the same process.
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

fn load_manifest_and_vsix() -> Result<(Manifest, PathBuf), String> {
    let manifest_path = default_manifest_path();
    let manifest_json = std::fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "could not read manifest at {}: {e}",
            manifest_path.display()
        )
    })?;
    let manifest = Manifest::parse(&manifest_json).map_err(|e| e.to_string())?;
    let vsix_path = resolve_vsix_path(None, &manifest_path, &manifest.components.extension.path);
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

    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> OpResult {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = match load_manifest_and_vsix() {
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

    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> OpResult {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = match load_manifest_and_vsix() {
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

    let worker_app = app.clone();
    let target_for_worker = target_path.clone();
    let result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        let sink = WindowProgressSink { app: worker_app };
        let (manifest, vsix_path) = load_manifest_and_vsix()?;
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
/// (`cli/src/main.rs`), just per-write instead of per-process. An
/// unwritable/missing/just-uninstalled `logs/` degrades to dropping the
/// line, never a panic.
#[derive(Clone)]
struct PerWriteFileWriter {
    logs_dir: PathBuf,
}

impl std::io::Write for PerWriteFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if std::fs::create_dir_all(&self.logs_dir).is_err() {
            return Ok(buf.len());
        }
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        assert_eq!(
            uninstall_outcome_message(&UninstallOutcome::AbortedUnreadableState).0,
            false
        );

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
}
