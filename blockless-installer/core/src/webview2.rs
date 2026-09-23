//! Provisioning the WebView2 runtime the GUI needs on Windows.
//!
//! WHY THIS EXISTS. The GUI ships as an NSIS bundle, and that bundle is
//! configured to provision this runtime
//! (`webviewInstallMode: downloadBootstrapper`). It cannot be relied on to do
//! so. Tauri's NSIS template decides by reading a registry string:
//!
//! ```nsis
//! ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}" "pv"
//! ${If} $4 == ""
//!   ; downloadBootstrapper / embedBootstrapper / offlineInstaller all live here
//! ```
//!
//! Microsoft Edge registers that same client GUID. On a machine where Edge has
//! registered it but the runtime was never installed -- a stock Windows
//! Sandbox image, and anything like it -- the probe finds a version string,
//! concludes the runtime is present, and provisions nothing. Found on the rig,
//! 2026-09-21: the bundle "installed" in 1.1s and the app opened a bare window
//! titled `Error`.
//!
//! Of the five `webviewInstallMode` values, three are nested inside that
//! `${If}` and are therefore skipped together. The interesting exception is
//! `fixedRuntime`, which ships a runtime alongside the app and never consults
//! the probe at all -- a real alternative, at roughly 180 MB of shipped
//! bundle, and the one ARCHITECTURE.md previously recorded as the fallback for
//! exactly this failure.
//!
//! This module is the other alternative and costs nothing at rest: the app
//! checks for itself before building a window, and provisions the runtime if
//! it is genuinely absent. Detection is injected via
//! [`Webview2Runner::runtime_available`] because only the GUI crate can call
//! it. In the common case -- a clean registry -- the bundle has already done
//! the work and this is a no-op.
//!
//! SECURITY POSTURE. The bootstrapper is downloaded without a sha256 pin -- it
//! comes from a redirector that always serves the current build, so no stable
//! digest exists to pin, and fabricating one is exactly what the rig
//! documentation forbids. Integrity comes from its Authenticode signature,
//! verified BEFORE the file is executed, through the same
//! `VscodeInstaller::verify_signature` gate the VS Code installer passes
//! (Microsoft subject pin included). A failed signature is a hard stop: the
//! artifact is never run.
//!
//! CONSENT is the caller's job, not this module's. `ensure_webview2` downloads
//! and installs as soon as it is called; the GUI asks the user first. Keeping
//! the prompt out of here is what lets this be unit-tested without a UI.

use crate::vscode::{InstallError, SignatureError};
use std::path::{Path, PathBuf};

/// Microsoft's Evergreen bootstrapper. A redirector, always current.
pub const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// The OS-native half, injected so this module is testable without a real
/// download, a real signature check, or a real runtime installation.
pub trait Webview2Runner {
    /// Is the runtime ACTUALLY available? Implemented over Microsoft's
    /// `GetAvailableCoreWebView2BrowserVersionString` (what
    /// `tauri::webview_version()` calls).
    ///
    /// That API VALIDATES the installation rather than merely reading the
    /// EdgeUpdate registration, which is the difference that matters here: on
    /// the phantom machine it returned `HRESULT(0x80070002)`, "the system
    /// cannot find the file specified", where the NSIS probe read the same
    /// machine's `pv` and concluded the runtime was present. It is not that
    /// the API ignores the registry -- Microsoft's loader uses those keys to
    /// locate a runtime -- it is that it then checks the files are there.
    ///
    /// Caveat worth knowing: the API also reports preview Edge channels
    /// (Beta/Dev/Canary) as available, so a machine carrying only Edge Canary
    /// would be judged provisioned and would run on it.
    fn runtime_available(&self) -> bool;
    /// Fetch the Evergreen bootstrapper to `dest`.
    ///
    /// Injected rather than called directly so this module has NO network
    /// dependency in tests. The first version of these tests called
    /// `fetch::download_unverified` for real: on a machine with internet the
    /// download succeeded and the test asserted the wrong branch, while on an
    /// offline runner it would have "passed" for the wrong reason. A test that
    /// reads the machine it runs on instead of its fixture is exactly the
    /// defect class the rig documentation keeps flagging, so the seam moved
    /// here.
    fn download_bootstrapper(&self, dest: &Path) -> Result<(), String>;
    /// Authenticode-verify a downloaded artifact, pinned to Microsoft.
    fn verify_signature(&self, artifact: &Path) -> Result<(), SignatureError>;
    /// Run the bootstrapper without a prompt. Documented to install per-user
    /// when run non-elevated -- not demonstrated here; see
    /// `system/windows.rs::run_webview2_bootstrapper`.
    fn run_bootstrapper(&self, exe: &Path) -> Result<(), InstallError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Webview2Outcome {
    /// Nothing to do.
    AlreadyPresent,
    /// Installed just now, and confirmed present afterwards.
    Installed,
    /// Ran, but the runtime still is not there. Distinct from `Failed`: every
    /// step reported success, so the machine is in a stranger state than a
    /// download or signature failure leaves it, and the message says so.
    RanButStillMissing,
    /// Could not provision it. The string is user-facing.
    Failed(String),
}

/// Ensure the WebView2 runtime is present, installing it if it is not.
///
/// Re-checks availability AFTER running the bootstrapper rather than trusting
/// its exit code -- the same "confirm, do not assume" posture the uninstall
/// learned the hard way, and the reason `RanButStillMissing` is its own
/// outcome rather than being folded into success.
pub fn ensure_webview2(runner: &dyn Webview2Runner, download_dir: &Path) -> Webview2Outcome {
    if runner.runtime_available() {
        return Webview2Outcome::AlreadyPresent;
    }

    let dest: PathBuf = download_dir.join("MicrosoftEdgeWebview2Setup.exe");
    if let Err(e) = runner.download_bootstrapper(&dest) {
        return Webview2Outcome::Failed(format!("could not download the WebView2 installer: {e}"));
    }

    // Signature BEFORE execution, always. This is the only integrity gate on
    // this artifact, so a failure here must never fall through to running it.
    if let Err(e) = runner.verify_signature(&dest) {
        let _ = std::fs::remove_file(&dest);
        return Webview2Outcome::Failed(format!(
            "the downloaded WebView2 installer is not authentically signed by Microsoft, \
             so it was discarded and not run: {e}"
        ));
    }

    let ran = runner.run_bootstrapper(&dest);
    let _ = std::fs::remove_file(&dest);

    // The exit code is not the verdict in EITHER direction. A non-zero exit
    // can still leave a usable runtime (a per-machine install or Edge Updater
    // satisfied it, a "reboot recommended" code), and refusing to start on a
    // machine that now works would be the same mistake as trusting a zero.
    match (ran, runner.runtime_available()) {
        (_, true) => Webview2Outcome::Installed,
        (Ok(()), false) => Webview2Outcome::RanButStillMissing,
        (Err(e), false) => Webview2Outcome::Failed(format!("the WebView2 installer failed: {e}")),
    }
}

#[cfg(test)]
#[path = "tests/webview2.rs"]
mod tests;
