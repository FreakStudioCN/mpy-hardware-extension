//! Step 3: a contained Python + mpremote, provisioned entirely through `uv`.
//! Ports `step3_python`/`Step-Python`.
//!
//! Diverges from M0 on purpose (`/scope.md` "uv delivery"): M0 fetches the
//! `astral.sh` install SCRIPT (sha-pinned at the script level); this core
//! pins the uv BINARY itself, downloaded straight from a GitHub release
//! asset and sha256-verified against the manifest, then extracted. The
//! astral.sh script path does not carry over.
//!
//! No system Python is ever invoked: the venv is always built with
//! `--managed-python --python <series>` against the interpreter uv itself
//! just installed under `BLK/python`, and every subsequent operation targets
//! `ENVPY` (`BLK/env/...`) explicitly. `verify.rs` (commit 10) is the
//! acceptance-level guard for this invariant (`pyvenv.cfg`'s `home`
//! containment check); this module's contribution is simply never
//! constructing a path that could point anywhere else.

use crate::fetch::{self, FetchOptions};
use crate::manifest::{UvComponent, UvPlatformKey};
use crate::platform::{Arch, Os};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("uv download failed: {0}")]
    Download(#[from] fetch::FetchError),
    #[error("could not extract uv: {0}")]
    Extract(String),
    #[error("uv not runnable after install")]
    UvNotRunnableAfterInstall,
    #[error("uv {0} failed")]
    UvCommandFailed(String),
    #[error("mpremote verify failed after install")]
    MpremoteVerifyFailed,
}

/// `uv`/mpremote operations this step needs, injected so it is unit-testable
/// without a real `uv` binary or a real Python. Production impl lands with
/// `ops.rs`.
pub trait RuntimeRunner {
    /// `<envpy> -m mpremote version`. `None` if `envpy` doesn't exist or
    /// isn't runnable.
    fn mpremote_version(&self, envpy: &Path) -> Option<String>;
    /// `<uv_bin> --version`. `None` if not executable.
    fn uv_version(&self, uv_bin: &Path) -> Option<String>;
    /// Extract the downloaded uv release archive into `dest_dir` (mac:
    /// `tar -xzf`; Windows: `Expand-Archive`).
    fn extract_uv(&self, archive: &Path, dest_dir: &Path) -> Result<(), String>;
    /// Run `<uv_bin> <args>` with `env` set in addition to the inherited
    /// environment. `true` on success.
    fn run_uv(&self, uv_bin: &Path, args: &[&str], env: &[(&str, &str)]) -> bool;
    /// Are Xcode Command Line Tools (or a full Xcode) installed?
    ///
    /// Injected rather than probed inline, for the reason every other system
    /// call here is: a first version read the real filesystem from inside
    /// `ensure_runtime`, which made a unit test's result depend on what was
    /// installed on the machine running it. It passed on a Mac with the tools
    /// and failed on the Windows runner without them.
    fn developer_tools_present(&self) -> bool;
}

fn uv_binary_name(os: Os) -> &'static str {
    match os {
        Os::MacOs => "uv",
        Os::Windows => "uv.exe",
    }
}

fn uv_archive_name(os: Os) -> &'static str {
    match os {
        Os::MacOs => "uv.tar.gz",
        Os::Windows => "uv.zip",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStepOutcome {
    AlreadyPresent,
    Provisioned,
}

/// Where a WORKING `install_name_tool` lives when the developer tools are
/// installed. Read by the real `RuntimeRunner`, never from inside this module.
///
/// `/usr/bin/install_name_tool` is deliberately not in this list, and testing
/// for it would be the obvious mistake: macOS ships a stub at that path whose
/// entire job is to raise the "would you like to install the tools now?"
/// dialog. Measured on a Mac with no developer tools: it is present, 118 KB,
/// root:wheel. Existence there proves nothing.
pub const DEVELOPER_TOOL_PATHS: [&str; 2] = [
    "/Library/Developer/CommandLineTools/usr/bin/install_name_tool",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/install_name_tool",
];

/// A no-op `install_name_tool` written into `dir`.
fn write_install_name_tool_shim(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let shim = dir.join("install_name_tool");
    std::fs::write(&shim, "#!/bin/sh\nexit 0\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// The `PATH` uv should run with, or `None` to leave it inherited.
///
/// Only ever shims where the real tool is absent, so nothing that would
/// otherwise work is suppressed. Failing to write the shim is not fatal: the
/// worst case is the dialog we were trying to avoid, which is what happens
/// today anyway.
fn install_name_tool_shim(os: Os, blk: &Path, developer_tools_present: bool) -> Option<String> {
    if os != Os::MacOs || developer_tools_present {
        return None;
    }
    let dir = blk.join("toolshim");
    if let Err(e) = write_install_name_tool_shim(&dir) {
        tracing::warn!("could not write the install_name_tool shim: {e}");
        return None;
    }
    // The one place this module reads the process environment. Prepending
    // requires knowing what to prepend to, and replacing PATH outright would
    // take away whatever else uv needs to find.
    let inherited = std::env::var("PATH").unwrap_or_default();
    tracing::info!("no developer tools found; shimming install_name_tool for uv");
    Some(format!("{}:{}", dir.display(), inherited))
}

/// The full step: detect/skip on the pinned mpremote -> ensure uv (detect or
/// download+verify+extract) -> `uv python install` -> `uv venv` -> `uv pip
/// install mpremote==<pinned>` -> verify.
#[allow(clippy::too_many_arguments)]
pub fn ensure_runtime(
    runner: &dyn RuntimeRunner,
    client: &reqwest::blocking::Client,
    os: Os,
    arch: Arch,
    manifest_uv: &UvComponent,
    python_series: &str,
    mpremote_version: &str,
    blk: &Path,
    env_python: &Path,
    downloads_dir: &Path,
    fetch_opts: &FetchOptions,
) -> Result<RuntimeStepOutcome, RuntimeError> {
    if runner
        .mpremote_version(env_python)
        .is_some_and(|v| v.contains(mpremote_version))
    {
        return Ok(RuntimeStepOutcome::AlreadyPresent);
    }

    let uv_dir = blk.join("uv");
    let uv_bin = uv_dir.join(uv_binary_name(os));
    let uv_current = runner
        .uv_version(&uv_bin)
        .is_some_and(|v| v.contains(&manifest_uv.version));
    if !uv_current {
        let key = UvPlatformKey::for_target(os, arch);
        let archive_path = downloads_dir.join(uv_archive_name(os));
        fetch::fetch_and_verify(
            client,
            &manifest_uv.download_url(key),
            manifest_uv.sha256_for(key),
            &archive_path,
            fetch_opts,
        )?;
        runner
            .extract_uv(&archive_path, &uv_dir)
            .map_err(RuntimeError::Extract)?;
        if runner.uv_version(&uv_bin).is_none() {
            return Err(RuntimeError::UvNotRunnableAfterInstall);
        }
    }

    // Contained on purpose: the interpreter installs under BLK/python
    // (UV_PYTHON_INSTALL_DIR), and --managed-python forces the venv to build
    // on THAT interpreter. Without --managed-python, `uv venv --python
    // <series>` would match any discoverable interpreter (a dev's Anaconda,
    // a system python) and the env would silently depend on it.
    let python_install_dir = blk.join("python").to_string_lossy().into_owned();
    let env_dir = blk.join("env").to_string_lossy().into_owned();
    let env_python_str = env_python.to_string_lossy().into_owned();

    // uv patches the managed interpreter's dylib id with `install_name_tool`,
    // which ships with Xcode Command Line Tools. On a Mac without them, macOS
    // answers the exec with a dialog -- "The install_name_tool command requires
    // the command line developer tools. Would you like to install the tools
    // now?" -- during what is meant to be a one-click install. Measured on the
    // rig: it does not block, and the patch failing is harmless here (it only
    // matters when building native extensions, and this runtime installs
    // mpremote, pyserial and platformdirs, all pure Python), but a system
    // prompt mid-install is a real defect against the acceptance.
    //
    // uv resolves the tool through PATH, measured on the rig, so a no-op ahead
    // of it silences the dialog. Only where the real tool is absent: the patch
    // could not have happened there anyway, so nothing is suppressed that would
    // otherwise work.
    let shim_path_entry = install_name_tool_shim(os, blk, runner.developer_tools_present());
    let mut uv_env: Vec<(&str, &str)> =
        vec![("UV_PYTHON_INSTALL_DIR", python_install_dir.as_str())];
    if let Some(path_value) = shim_path_entry.as_deref() {
        uv_env.push(("PATH", path_value));
    }

    if !runner.run_uv(
        &uv_bin,
        &["python", "install", "--no-bin", python_series],
        &uv_env,
    ) {
        return Err(RuntimeError::UvCommandFailed("python install".to_string()));
    }
    if !runner.run_uv(
        &uv_bin,
        &[
            "venv",
            &env_dir,
            "--managed-python",
            "--python",
            python_series,
        ],
        &uv_env,
    ) {
        return Err(RuntimeError::UvCommandFailed("venv".to_string()));
    }
    let mpremote_spec = format!("mpremote=={mpremote_version}");
    if !runner.run_uv(
        &uv_bin,
        &[
            "pip",
            "install",
            "--python",
            &env_python_str,
            &mpremote_spec,
        ],
        &uv_env,
    ) {
        return Err(RuntimeError::UvCommandFailed("pip install".to_string()));
    }

    if runner
        .mpremote_version(env_python)
        .is_some_and(|v| v.contains(mpremote_version))
    {
        Ok(RuntimeStepOutcome::Provisioned)
    } else {
        Err(RuntimeError::MpremoteVerifyFailed)
    }
}

#[cfg(test)]
#[path = "tests/runtime.rs"]
mod tests;
