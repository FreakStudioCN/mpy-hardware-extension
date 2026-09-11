//! Step 1: VS Code itself. Detect via the explicit candidate paths (never
//! PATH); if absent, resolve the update API, download, sha256-verify,
//! authenticate the signature, install silently, then confirm the CLI is
//! runnable. Ports `step1_vscode`/`Step-VSCode`.
//!
//! Every OS-native operation (running `--version`, checking writability,
//! extracting the archive, stripping the quarantine xattr, running the
//! silent Windows installer, verifying the code signature) goes through
//! [`VscodeInstaller`], injected so the whole step is unit-testable without a
//! real VS Code binary, a real `codesign`/`WinVerifyTrust`, or a real
//! network. The production implementation is OS-specific and lands with
//! `ops.rs` (commit 12), the first caller that runs for real.
//!
//! `ensure_vscode` takes the update-API URL as a plain string built by the
//! caller (`manifest::VscodeComponent::update_api_url`), not a manifest
//! reference -- this is the only thing this step needs from the manifest,
//! and taking it directly (rather than manifest + os + arch) is what makes
//! the whole step testable against a local server instead of the real,
//! sandbox-unreachable `update.code.visualstudio.com`.

use crate::fetch::{self, FetchOptions};
use crate::manifest::{self, VscodeUpdateApiResponse};
use crate::platform::Os;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SignatureError(pub String);

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct InstallError(pub String);

#[derive(Debug, thiserror::Error)]
pub enum VscodeError {
    #[error("could not reach the VS Code update API at {url}: {source}")]
    UpdateApiRequest {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("update API response at {url} did not match the expected shape: {source}")]
    UpdateApiParse {
        url: String,
        #[source]
        source: manifest::ManifestError,
    },
    #[error("VS Code download failed: {0}")]
    Download(#[from] fetch::FetchError),
    /// The sha256 above only matches what the update API returned over TLS
    /// (trust-on-first-use): it catches a corrupt/MITM'd download, not a
    /// compromised API response serving a malicious URL + its own matching
    /// digest. The signature chains to Apple/Microsoft independent of that
    /// response. On Windows it gates the downloaded installer exe before
    /// that exe is ever run. On mac, `codesign --verify` only understands an
    /// extracted `.app` bundle, not a zip. macOS therefore extracts into an
    /// isolated staging directory and moves the app into Applications only
    /// after this check passes.
    #[error("VS Code artifact failed signature verification: {0}")]
    Signature(SignatureError),
    #[error("VS Code artifact failed signature verification ({signature}) and cleanup failed ({cleanup})")]
    SignatureCleanup {
        signature: SignatureError,
        cleanup: InstallError,
    },
    #[error("no writable install target (tried: {0:?})")]
    NoWritableInstallTarget(Vec<PathBuf>),
    #[error("could not install VS Code: {0}")]
    Install(InstallError),
    #[error("VS Code CLI not runnable after install")]
    NotRunnableAfterInstall,
}

/// Every OS-native operation this step needs. Mac-only methods are unused on
/// the Windows branch and vice versa; `ensure_vscode` only ever calls the
/// subset that matches `os`.
pub trait VscodeInstaller {
    /// Run `code_cli --version`. `Some(first line of output)` if runnable.
    fn version(&self, code_cli: &Path) -> Option<String>;
    /// Is `dir` writable (mac's `/Applications` vs `~/Applications` fallback;
    /// unused on Windows, which always installs under `%LOCALAPPDATA%`).
    fn is_writable(&self, dir: &Path) -> bool;
    /// Extract the downloaded archive into `target_dir` (mac: `ditto -x -k`).
    fn extract_archive(&self, archive: &Path, target_dir: &Path) -> Result<(), InstallError>;
    /// Move the already-authenticated macOS app from its isolated extraction
    /// directory into the selected Applications directory.
    fn install_verified_app(
        &self,
        _app_dir: &Path,
        _target_dir: &Path,
    ) -> Result<(), InstallError> {
        Err(InstallError(
            "install_verified_app is unsupported".to_string(),
        ))
    }
    /// Strip the quarantine xattr recursively (mac: `xattr -dr
    /// com.apple.quarantine`; a fresh `ditto` extract is otherwise Gatekeeper
    /// quarantined). No-op on Windows.
    fn strip_quarantine(&self, app_dir: &Path);
    /// Run the downloaded installer silently (Windows User Setup:
    /// `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /MERGETASKS=!runcode`).
    /// Unused on mac (extraction alone is the install).
    fn run_silent_installer(&self, installer_exe: &Path) -> Result<(), InstallError>;
    /// Authenticate the artifact against its OS-native signing chain (mac: a
    /// codesign REQUIREMENT string anchored to Apple + pinned to Microsoft's
    /// Team ID leaf OU, run against the extracted `.app` bundle -- `codesign
    /// --verify` only understands bundles, not zip archives; Windows:
    /// `WinVerifyTrust` + a subject pin on `O=Microsoft Corporation`, run
    /// against the downloaded installer exe directly). Never weakened to a
    /// bare integrity check.
    fn verify_signature(&self, artifact: &Path) -> Result<(), SignatureError>;
    fn remove_unverified_install(&self, app_dir: &Path) -> Result<(), InstallError>;
}

fn detect(installer: &dyn VscodeInstaller, candidates: &[PathBuf]) -> Option<(PathBuf, String)> {
    candidates
        .iter()
        .find_map(|c| installer.version(c).map(|v| (c.clone(), v)))
}

fn archive_file_name(os: Os) -> &'static str {
    match os {
        Os::MacOs => "VSCode-darwin-universal.zip",
        Os::Windows => "VSCodeUserSetup.exe",
    }
}

fn fetch_update_api_response(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<VscodeUpdateApiResponse, VscodeError> {
    let body = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|source| VscodeError::UpdateApiRequest {
            url: url.to_string(),
            source,
        })?;
    VscodeUpdateApiResponse::parse(&body).map_err(|source| VscodeError::UpdateApiParse {
        url: url.to_string(),
        source,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VscodeStepOutcome {
    pub code_cli: PathBuf,
    pub product_version: String,
    /// True only on the path that actually installed VS Code this run --
    /// never forced true or reset on a skip, so `state.rs`'s sticky
    /// carry-forward stays correct across repair runs.
    pub installed_by_us: bool,
    /// `Some(api-reported version)` when a fresh install's own `--version`
    /// disagrees with what the update API reported. Logged by the caller,
    /// never a failure -- ports `log "note: installed $X, API reported $Y"`.
    pub product_version_mismatch: Option<String>,
}

/// The full step: detect -> skip, or resolve+download+verify+authenticate+
/// install -> confirm runnable. `update_api_url` is built by the caller via
/// `manifest::VscodeComponent::update_api_url(os, arch)`.
#[allow(clippy::too_many_arguments)]
pub fn ensure_vscode(
    installer: &dyn VscodeInstaller,
    client: &reqwest::blocking::Client,
    os: Os,
    code_candidates: &[PathBuf],
    mac_install_targets: &[PathBuf],
    update_api_url: &str,
    downloads_dir: &Path,
    fetch_opts: &FetchOptions,
) -> Result<VscodeStepOutcome, VscodeError> {
    if let Some((code_cli, product_version)) = detect(installer, code_candidates) {
        return Ok(VscodeStepOutcome {
            code_cli,
            product_version,
            installed_by_us: false,
            product_version_mismatch: None,
        });
    }

    let api = fetch_update_api_response(client, update_api_url)?;

    let archive_path = downloads_dir.join(archive_file_name(os));
    fetch::fetch_and_verify(
        client,
        &api.url,
        &api.sha256_hash,
        &archive_path,
        fetch_opts,
    )?;

    match os {
        Os::MacOs => {
            // `codesign --verify` authenticates a bundle, not a zip. Extract
            // into staging, authenticate there, and only then move the bundle
            // into Applications. Failed verification removes the staging
            // tree, so a later run cannot adopt unverified residue.

            let target = mac_install_targets
                .iter()
                .find(|t| installer.is_writable(t))
                .ok_or_else(|| {
                    VscodeError::NoWritableInstallTarget(mac_install_targets.to_vec())
                })?;
            let staging = downloads_dir.join("vscode-extract");
            installer
                .remove_unverified_install(&staging)
                .map_err(VscodeError::Install)?;
            installer
                .extract_archive(&archive_path, &staging)
                .map_err(VscodeError::Install)?;
            let app_dir = staging.join("Visual Studio Code.app");
            if let Err(signature) = installer.verify_signature(&app_dir) {
                return match installer.remove_unverified_install(&staging) {
                    Ok(()) => Err(VscodeError::Signature(signature)),
                    Err(cleanup) => Err(VscodeError::SignatureCleanup { signature, cleanup }),
                };
            }
            installer
                .install_verified_app(&app_dir, target)
                .map_err(VscodeError::Install)?;
            let installed_app = target.join("Visual Studio Code.app");
            installer.strip_quarantine(&installed_app);
            installer
                .remove_unverified_install(&staging)
                .map_err(VscodeError::Install)?;
        }
        Os::Windows => {
            // The downloaded installer exe is itself what's signed and what
            // gets executed, so the check stays on `archive_path` and runs
            // before it is ever invoked.
            installer
                .verify_signature(&archive_path)
                .map_err(VscodeError::Signature)?;
            installer
                .run_silent_installer(&archive_path)
                .map_err(VscodeError::Install)?;
        }
    }

    let (code_cli, product_version) =
        detect(installer, code_candidates).ok_or(VscodeError::NotRunnableAfterInstall)?;

    let product_version_mismatch = if product_version != api.product_version {
        Some(api.product_version.clone())
    } else {
        None
    };

    Ok(VscodeStepOutcome {
        code_cli,
        product_version,
        installed_by_us: true,
        product_version_mismatch,
    })
}

#[cfg(test)]
#[path = "tests/vscode.rs"]
mod tests;
