//! Step 2: the Blockless extension + its two Marketplace dependencies into
//! the branded profile. Ports `our_ext_is_bundled_build`/`Test-OurExtBundled`,
//! `all_ext_current`/`Test-AllExtCurrent`, `install_ext`/`Install-Ext`, and
//! `step2_extension`/`Step-Extension`.
//!
//! Reuses `profile.rs`'s seed-first / window-fallback-second registration
//! directly; this module only adds extension install/list operations
//! ([`ExtensionsRunner`], injected for the same reason `profile.rs`'s
//! `CommandRunner` is: no real `code` CLI in tests).

use crate::profile;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum ExtensionsError {
    /// Our extension is installed ONLY from the sha256-verified bundled
    /// VSIX, never the Marketplace: a same-numbered-but-older Marketplace
    /// build has broken auto-open before (ARCHITECTURE §6) and `verify`
    /// checks the SETTING we write, not the extension build, so it would
    /// never catch a silently-wrong install. A missing VSIX fails loudly.
    #[error("no bundled VSIX for {0}; refusing the stale Marketplace build")]
    MissingBundledVsix(String),
    #[error("failed to install {0}")]
    InstallFailed(String),
    #[error("extensions missing after install")]
    MissingAfterInstall,
    #[error("could not register the profile: {0}")]
    Profile(#[from] profile::ProfileError),
    #[error("could not hash the bundled VSIX at {path}: {source}")]
    VsixHash {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The bundled VSIX's own hash never matched what the manifest declares
    /// for it. `prior_ext_vsix_sha256` (the journaled sha from our OWN last
    /// install) only detects drift against ourselves -- it has nothing to
    /// say about whether the file on disk right now is the one the manifest
    /// actually shipped. This is the authenticity check the manifest's
    /// `components.extension.sha256` field exists for.
    #[error(
        "bundled VSIX at {path} does not match the manifest: expected sha256 {expected}, got {actual}"
    )]
    VsixShaMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
}

/// `code` CLI operations this step needs, injected so it is unit-testable
/// without a real VS Code binary. Production impl lands with `ops.rs`.
pub trait ExtensionsRunner {
    /// `code --profile <profile_name> --list-extensions`. `None` if the CLI
    /// call itself failed (e.g. the profile doesn't exist yet) -- `has_ext`
    /// then correctly reads as "not present", never as "present".
    fn list_extensions(&self, code_cli: &Path, profile_name: &str) -> Option<Vec<String>>;
    /// `code --profile <profile_name> --install-extension <vsix_or_id>
    /// --force`. `vsix_or_id` is either a filesystem path (our bundled VSIX)
    /// or a Marketplace id, indistinguishable at this layer -- the caller
    /// decides which by construction, never this trait.
    fn install_extension(&self, code_cli: &Path, profile_name: &str, vsix_or_id: &str) -> bool;
}

fn has_ext(runner: &dyn ExtensionsRunner, code_cli: &Path, profile_name: &str, id: &str) -> bool {
    runner
        .list_extensions(code_cli, profile_name)
        .unwrap_or_default()
        .iter()
        .any(|installed| installed.eq_ignore_ascii_case(id))
}

/// Present AND installed from the exact VSIX we bundle NOW (matched by the
/// sha journaled in `state.json`). Presence alone never counts: a
/// Marketplace build with the same version number but built before
/// `mpyhw.autoOpenPanel` existed would pass an id/version check yet break
/// auto-open, and `verify` (which checks the SETTING we write, not the
/// build) would not catch it.
fn our_ext_is_bundled_build(
    runner: &dyn ExtensionsRunner,
    code_cli: &Path,
    profile_name: &str,
    ext_id: &str,
    vsix_sha256: &str,
    prior_ext_vsix_sha256: &str,
) -> bool {
    has_ext(runner, code_cli, profile_name, ext_id)
        && !vsix_sha256.is_empty()
        && prior_ext_vsix_sha256 == vsix_sha256
}

#[allow(clippy::too_many_arguments)]
fn all_ext_current(
    runner: &dyn ExtensionsRunner,
    code_cli: &Path,
    profile_name: &str,
    ext_id: &str,
    py_ext_id: &str,
    pylance_id: &str,
    vsix_sha256: &str,
    prior_ext_vsix_sha256: &str,
) -> bool {
    our_ext_is_bundled_build(
        runner,
        code_cli,
        profile_name,
        ext_id,
        vsix_sha256,
        prior_ext_vsix_sha256,
    ) && has_ext(runner, code_cli, profile_name, py_ext_id)
        && has_ext(runner, code_cli, profile_name, pylance_id)
}

/// Install one id. For `ext_id` (ours): ONLY the bundled, existing VSIX --
/// never a fallback to the Marketplace. Every other id installs from the
/// Marketplace directly (the id itself is the argument `code` expects).
fn install_ext(
    runner: &dyn ExtensionsRunner,
    code_cli: &Path,
    profile_name: &str,
    id: &str,
    ext_id: &str,
    vsix_path: Option<&Path>,
) -> Result<(), ExtensionsError> {
    let arg = if id == ext_id {
        let vsix = vsix_path
            .filter(|p| p.exists())
            .ok_or_else(|| ExtensionsError::MissingBundledVsix(id.to_string()))?;
        vsix.to_string_lossy().into_owned()
    } else {
        id.to_string()
    };
    if runner.install_extension(code_cli, profile_name, &arg) {
        Ok(())
    } else {
        Err(ExtensionsError::InstallFailed(id.to_string()))
    }
}

fn sha256_of_file(path: &Path) -> Result<String, ExtensionsError> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|source| ExtensionsError::VsixHash {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionsStepOutcome {
    /// Whether THIS run created the profile (vs adopting a user's
    /// pre-existing profile of the same name) -- recorded from the on-disk
    /// state as it was BEFORE this function does anything, so it reflects
    /// true ownership regardless of whether the seed or the window fallback
    /// ends up being what actually registers it.
    pub profile_created_by_us: bool,
    pub ext_vsix_sha256: String,
}

/// The full step. `seed_profile_created_by_us` is the sticky carry-forward
/// from `state.rs` (already true on a repair run where we made the profile
/// last time); `prior_ext_vsix_sha256` is the sha this run started with
/// (`state::Seed::prior_ext_vsix_sha256`). `expected_vsix_sha256` is the
/// manifest's declared `components.extension.sha256` -- the bundled VSIX on
/// disk is refused before anything else if it doesn't match, so a corrupted
/// or tampered file can never be installed just because it happens to match
/// our own prior journal. `force`: bypass the currency skip and reinstall
/// our extension unconditionally -- `ops::update_extension` sets this so a
/// forced update actually forces, rather than silently no-op'ing when the
/// sha already happens to match.
#[allow(clippy::too_many_arguments)]
pub fn ensure_extensions(
    command_runner: &dyn profile::CommandRunner,
    ext_runner: &dyn ExtensionsRunner,
    code_cli: &Path,
    storage_path: &Path,
    profiles_dir: &Path,
    profile_name: &str,
    seed_location: &str,
    ext_id: &str,
    py_ext_id: &str,
    pylance_id: &str,
    vsix_path: Option<&Path>,
    expected_vsix_sha256: &str,
    prior_ext_vsix_sha256: &str,
    seed_profile_created_by_us: bool,
    force: bool,
) -> Result<ExtensionsStepOutcome, ExtensionsError> {
    let vsix_sha256 = match vsix_path.filter(|p| p.exists()) {
        Some(p) => sha256_of_file(p)?,
        None => String::new(),
    };

    if !vsix_sha256.is_empty() && !vsix_sha256.eq_ignore_ascii_case(expected_vsix_sha256) {
        return Err(ExtensionsError::VsixShaMismatch {
            path: vsix_path
                .expect("vsix_sha256 non-empty implies vsix_path was Some")
                .to_path_buf(),
            expected: expected_vsix_sha256.to_string(),
            actual: vsix_sha256,
        });
    }

    // Recorded BEFORE any registration attempt below: whether WE create the
    // profile (vs adopt one that already exists), snapshotted from the
    // on-disk state as it stands right now.
    let profile_created_by_us =
        seed_profile_created_by_us || !profile::profile_registered(storage_path, profile_name);

    if !force
        && all_ext_current(
            ext_runner,
            code_cli,
            profile_name,
            ext_id,
            py_ext_id,
            pylance_id,
            &vsix_sha256,
            prior_ext_vsix_sha256,
        )
    {
        return Ok(ExtensionsStepOutcome {
            profile_created_by_us,
            ext_vsix_sha256: vsix_sha256,
        });
    }

    // Seed-first: no VS Code window may exist before the final launch (see
    // profile.rs::register_profile_offline for why -- the panel-auto-open
    // fix). Errors here are non-fatal at this layer (a seed failure just
    // means the window fallback below has to do the work); genuine I/O
    // failures (can't create the profile dir) still propagate.
    profile::register_profile_offline(
        command_runner,
        storage_path,
        profiles_dir,
        profile_name,
        seed_location,
    )?;

    let ext_result = install_ext(
        ext_runner,
        code_cli,
        profile_name,
        ext_id,
        ext_id,
        vsix_path,
    );
    if let Err(ExtensionsError::MissingBundledVsix(id)) = &ext_result {
        return Err(ExtensionsError::MissingBundledVsix(id.clone()));
    }
    let py_result = if ext_result.is_ok() {
        install_ext(
            ext_runner,
            code_cli,
            profile_name,
            py_ext_id,
            ext_id,
            vsix_path,
        )
    } else {
        Err(ExtensionsError::InstallFailed(py_ext_id.to_string()))
    };

    if ext_result.is_err() || py_result.is_err() {
        // Window-registration fallback: a never-launched (or seed-ignoring)
        // VS Code may still lack the profile, and a headless
        // --install-extension into a missing profile fails.
        profile::register_profile(command_runner, code_cli, storage_path, profile_name);
        install_ext(
            ext_runner,
            code_cli,
            profile_name,
            ext_id,
            ext_id,
            vsix_path,
        )?;
        install_ext(
            ext_runner,
            code_cli,
            profile_name,
            py_ext_id,
            ext_id,
            vsix_path,
        )?;
    }

    // Pylance ships as a dependency of ms-python.python; if it did not
    // resolve, install it explicitly so a repair run has a path forward
    // instead of failing the same way forever.
    if !has_ext(ext_runner, code_cli, profile_name, pylance_id) {
        install_ext(
            ext_runner,
            code_cli,
            profile_name,
            pylance_id,
            ext_id,
            vsix_path,
        )?;
    }

    let all_present = has_ext(ext_runner, code_cli, profile_name, ext_id)
        && has_ext(ext_runner, code_cli, profile_name, py_ext_id)
        && has_ext(ext_runner, code_cli, profile_name, pylance_id);
    if !all_present {
        return Err(ExtensionsError::MissingAfterInstall);
    }

    Ok(ExtensionsStepOutcome {
        profile_created_by_us,
        ext_vsix_sha256: vsix_sha256,
    })
}

#[cfg(test)]
#[path = "tests/extensions.rs"]
mod tests;
