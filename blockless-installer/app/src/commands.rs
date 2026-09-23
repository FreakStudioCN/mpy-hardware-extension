//! The three window commands: `run_install`, `run_uninstall`,
//! `save_diagnostics`. Each is wiring over `core::ops`, exactly as the
//! CLI's dispatch is; the two ops that mutate the machine share one
//! skeleton ([`run_op`]) so their pre-flight, crash handling and the
//! release-guard-then-emit ordering exist once.

use crate::logging::LOG_FILE_NAME;
use crate::manifest_lookup::{bundle_resource_dir, load_manifest_and_vsix};
use crate::{install_attempt_allowed, AppState, OpGuard, MAX_INSTALL_ATTEMPTS_PER_PROCESS};
use blockless_installer_core::bootstrap::{build_ops_context, Machine};
use blockless_installer_core::manifest::Manifest;
use blockless_installer_core::ops;
use blockless_installer_core::platform::RawEnv;
use blockless_installer_core::progress::{ProgressEvent, ProgressSink};
use blockless_installer_core::system::SystemEnvironment;
use blockless_installer_core::uninstall::UninstallFlags;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

/// Completes `UninstallOutcome::summary`'s ownership note for THIS shell.
/// The CLI's own hint names its `--all` flag; this window has no flags, so
/// it says where that flag actually lives instead of pretending to have
/// one. Unreachable today -- the window never passes `keep_vscode` -- but
/// the text must be right for the day it does.
const LATER_REMOVAL_HINT: &str =
    "only the command-line installer can remove it later (uninstall --all)";

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

impl OpResult {
    /// A run that ended before the op itself started: nothing was logged,
    /// so there is no log path to offer.
    fn failed_before_op(op: &'static str, message: String) -> OpResult {
        OpResult {
            op,
            ok: false,
            message,
            log_path: None,
        }
    }
}

/// What an op body hands back to [`run_op`]: the verdict plus, when the op
/// actually ran far enough to write one, where its log is.
struct Verdict {
    ok: bool,
    message: String,
    log_path: Option<String>,
}

/// The CLI's wiring, through the same `bootstrap` recipe it uses, minus
/// logging init (this shell installs one subscriber at startup, not
/// per-op) and minus the `vsix` CLI override (the GUI always uses the
/// manifest's bundled path).
fn build_context<'a>(
    manifest: &'a Manifest,
    vsix_path: PathBuf,
    progress: &'a dyn ProgressSink,
) -> Result<ops::OpsContext<'a>, String> {
    let machine = Machine::detect(&RawEnv::from_process())?;
    build_ops_context(machine, manifest, vsix_path, progress)
}

fn log_path_of(ctx: &ops::OpsContext) -> Option<String> {
    Some(
        ctx.paths
            .logs
            .join(LOG_FILE_NAME)
            .to_string_lossy()
            .into_owned(),
    )
}

/// The skeleton `run_install` and `run_uninstall` share: resolve the
/// manifest and the machine on a blocking thread, hand the op body a
/// context, and turn a worker panic into a result instead of a hang. A
/// pre-op failure (no manifest, an unsupported machine) is reported under
/// the op's own name, with no log path, since nothing ran.
async fn run_op(
    app: tauri::AppHandle,
    op: &'static str,
    body: impl FnOnce(&ops::OpsContext) -> Verdict + Send + 'static,
) -> OpResult {
    let resource_dir = bundle_resource_dir(&app);
    tauri::async_runtime::spawn_blocking(move || -> OpResult {
        let sink = WindowProgressSink { app };
        let (manifest, vsix_path) = match load_manifest_and_vsix(resource_dir) {
            Ok(v) => v,
            Err(message) => return OpResult::failed_before_op(op, message),
        };
        let ctx = match build_context(&manifest, vsix_path, &sink) {
            Ok(ctx) => ctx,
            Err(message) => return OpResult::failed_before_op(op, message),
        };
        let verdict = body(&ctx);
        OpResult {
            op,
            ok: verdict.ok,
            message: verdict.message,
            log_path: verdict.log_path,
        }
    })
    .await
    .unwrap_or_else(|e| OpResult::failed_before_op(op, format!("{op} worker crashed: {e}")))
}

/// The extension version this installer will install, for the ready screen.
///
/// The installer carries its OWN version (`0.1.0` at time of writing) and the
/// extension moves on its own cadence (`0.4.3`), deliberately: the installer
/// is fixed and released without the extension changing, and vice versa, and
/// coupling them would force an installer rebuild -- plus a re-stamp, since
/// the VSIX is not reproducible -- for every extension patch. See
/// `manifest.installerVersion` vs `manifest.components.extension.version`.
///
/// That leaves a fair question from a user: which number am I getting? This
/// answers it by showing the one they actually care about, rather than making
/// the two artifacts share a version they do not share a lifecycle with.
///
/// `Err` carries the reason to the window, which logs it and omits the text.
/// A missing sidecar is already reported loudly by the first Install click,
/// naming every path searched; repeating it as a startup error would be noise,
/// and must never be mistaken for the machine being unusable.
#[tauri::command]
pub(crate) async fn extension_version(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = bundle_resource_dir(&app);
    load_manifest_and_vsix(resource_dir).map(|(manifest, _)| manifest.components.extension.version)
}

#[tauri::command]
pub(crate) async fn run_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let guard = OpGuard::try_acquire(&state.op_running)
        .ok_or_else(|| "an operation is already running".to_string())?;
    let attempt = state.install_attempts.fetch_add(1, Ordering::SeqCst) + 1;
    if !install_attempt_allowed(attempt) {
        return Err(format!(
            "too many install attempts in this session ({MAX_INSTALL_ATTEMPTS_PER_PROCESS} max); \
             restart Blockless Installer to try again"
        ));
    }

    let result = run_op(app.clone(), "install", |ctx| {
        // Nothing is created on disk until the run can actually install.
        // A click with no VSIX beside the manifest (every unstamped set,
        // including a dev window) must leave the machine exactly as it
        // found it -- in particular it must not put `BLK/logs` back on a
        // machine a prior uninstall cleaned. `ops::install` runs this same
        // check first thing; doing it here too is what lets `logs/` be
        // created after it rather than before.
        if let Err(e) = ops::require_vsix(ctx) {
            return Verdict {
                ok: false,
                message: e.to_string(),
                log_path: None,
            };
        }
        // Only install creates logs/ -- never at startup (see
        // logging::PerWriteFileWriter's own doc comment). install's own
        // steps are what the log exists to capture, so it has to exist
        // before ops::install runs, not after.
        let _ = std::fs::create_dir_all(&ctx.paths.logs);
        let log_path = log_path_of(ctx);
        match ops::install(&SystemEnvironment, ctx) {
            Ok(_state) => Verdict {
                ok: true,
                message: "install finished".to_string(),
                log_path,
            },
            Err(e) => Verdict {
                ok: false,
                message: e.to_string(),
                log_path,
            },
        }
    })
    .await;

    // Release the "op running" guard BEFORE telling the window the op is
    // over: emitting op-result is what the UI acts on to re-enable
    // Install/Advanced, so a click landing in the instant right after that
    // emit must never be refused as "already running".
    drop(guard);
    let _ = app.emit("op-result", result);
    Ok(())
}

#[tauri::command]
pub(crate) async fn run_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let guard = OpGuard::try_acquire(&state.op_running)
        .ok_or_else(|| "an operation is already running".to_string())?;

    let result = run_op(app.clone(), "uninstall", |ctx| {
        let log_path = log_path_of(ctx);
        let outcome = ops::uninstall(&SystemEnvironment, ctx, &UninstallFlags::default());
        // The wording lives on the outcome itself (core), shared with the
        // CLI. `ok: false` here always means "nothing was lost, re-run once
        // the named condition is cleared" -- main.js keeps the user on the
        // ready screen for it, where the re-run is one click away.
        let summary = outcome.summary(LATER_REMOVAL_HINT);
        Verdict {
            ok: summary.ok,
            message: summary.message,
            log_path,
        }
    })
    .await;

    // Same ordering as run_install, for the same reason.
    drop(guard);
    let _ = app.emit("op-result", result);
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_diagnostics(
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
        // The machine is resolved BEFORE the manifest, on purpose: `logs/`
        // and `state.json` are what support needs and neither depends on
        // the manifest, so a manifest that is missing, unreadable or
        // unparseable -- the very failure that brought the user to this
        // button -- must not also take the bundle away. The load error
        // goes into the bundle instead, as `facts.json`'s `manifestError`.
        let machine = Machine::detect(&RawEnv::from_process())?;
        match load_manifest_and_vsix(resource_dir) {
            Ok((manifest, vsix_path)) => {
                let ctx = build_ops_context(machine, &manifest, vsix_path, &sink)?;
                ops::diagnostics(&ctx, &target_for_worker).map_err(|e| e.to_string())
            }
            Err(manifest_error) => ops::write_diagnostics_bundle(
                &machine.paths,
                machine.os,
                machine.arch,
                Err(&manifest_error),
                &target_for_worker,
            )
            .map_err(|e| e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("diagnostics worker crashed: {e}"))?;

    result.map(|()| Some(target_path.to_string_lossy().into_owned()))
}

#[cfg(test)]
#[path = "tests/commands.rs"]
mod tests;
