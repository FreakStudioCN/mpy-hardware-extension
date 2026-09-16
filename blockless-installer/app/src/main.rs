//! The Tauri shell over the core: mirrors `cli/src/main.rs::run()`'s wiring
//! for each op, forwards `core::progress::ProgressEvent`s to the window as
//! `progress` events, and emits one terminal `op-result` event per command.
//! No operation lives here that `core::ops` does not already implement --
//! this crate is wiring, the same way `cli/src/main.rs` is.
//!
//! Unlike the CLI (`cli/src/cli.rs` argument grammar vs `cli/src/main.rs`
//! dispatch), this crate is not split into an OS-gated and an OS-ungated
//! half: it inherently compiles only on macOS/Windows
//! (`blockless_installer_core::system::SystemEnvironment` is cfg-gated), and
//! is excluded from the root Cargo workspace precisely so nothing on Linux
//! ever tries to build it (see `../Cargo.toml`'s `exclude`).
//!
//! Layout: this file holds the process-wide state and the window loop;
//! `commands.rs` the three window commands; `manifest_lookup.rs` where the
//! sidecar manifest is searched for; `logging.rs` the per-write log file.

mod commands;
mod logging;
mod manifest_lookup;
#[cfg(test)]
mod test_support;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::Emitter;

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

fn main() {
    logging::init_logging();
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
            commands::run_install,
            commands::run_uninstall,
            commands::save_diagnostics
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
#[path = "tests/state.rs"]
mod tests;
