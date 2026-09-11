//! The lib API: `install`, `repair`, `repair_runtime`, `update_extension`,
//! `verify`, `diagnostics`, `uninstall`. Each op is thin orchestration over
//! the already-built step modules -- this file's only real content is
//! sequencing (which steps, in what order, journaling after each one) and
//! wiring the pinned values out of the manifest into each step's call.
//!
//! Every op is generic over [`Environment`], the union of every step
//! module's injected trait, so `ops.rs` itself needs no OS-specific code and
//! stays testable the same way every other module here is. The one real
//! implementation of `Environment` for an actual machine is
//! `blockless-installer-core::system` (cfg-gated per OS) or the CLI's own
//! wiring -- neither is exercised by this module's own tests.
//!
//! No silent auto-updates anywhere: every op here is something the user (or
//! the GUI, on their behalf) explicitly asked for. Nothing here polls for a
//! newer pin and swaps it in on its own.

use crate::extensions::{self, ExtensionsError};
use crate::fetch::FetchOptions;
use crate::manifest::Manifest;
use crate::platform::{Arch, Os, Paths};
use crate::profile;
use crate::runtime::{self, RuntimeError};
use crate::settings::{self, SettingsError};
use crate::state::{self, State};
use crate::uninstall::UninstallRunner;
use crate::vscode::{self, VscodeError};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// The union of every step module's injected capability, so ops.rs's
/// functions take one trait object instead of five.
pub trait Environment:
    profile::CommandRunner
    + vscode::VscodeInstaller
    + extensions::ExtensionsRunner
    + runtime::RuntimeRunner
    + UninstallRunner
{
}
impl<T> Environment for T where
    T: profile::CommandRunner
        + vscode::VscodeInstaller
        + extensions::ExtensionsRunner
        + runtime::RuntimeRunner
        + UninstallRunner
{
}

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error(transparent)]
    State(#[from] state::StateError),
    #[error(transparent)]
    Vscode(#[from] VscodeError),
    #[error(transparent)]
    Extensions(#[from] ExtensionsError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error("could not remove {}: {reason}", path.display())]
    RemoveEnv { path: PathBuf, reason: String },
    #[error("could not build diagnostics bundle: {0}")]
    Diagnostics(String),
    /// Checked upfront, before step 1 runs: without it, a run can seed or
    /// adopt a profile in step 1/2 and only then fail in extensions.rs's own
    /// `MissingBundledVsix`, permanently misattributing `profileCreatedByUs`
    /// (or leaving VS Code installed) for a run that could never have
    /// finished. M0 checks this before doing anything too.
    #[error("no bundled VSIX at {0}; pass --vsix")]
    MissingVsix(PathBuf),
}

/// Everything an op needs about this machine + this manifest, resolved
/// once by the caller (the CLI, or a future GUI).
pub struct OpsContext<'a> {
    pub os: Os,
    pub arch: Arch,
    pub paths: Paths,
    pub manifest: &'a Manifest,
    pub client: reqwest::blocking::Client,
    pub fetch_opts: FetchOptions,
    pub code_candidates: Vec<PathBuf>,
    /// mac only; empty on Windows (no target-selection concept there).
    pub mac_install_targets: Vec<PathBuf>,
    /// The bundled VSIX path, if supplied (`--vsix`). Our extension can
    /// never come from anywhere else (extensions.rs), so ops that touch
    /// extensions require this to be `Some` and pointing at a real file.
    pub vsix_path: Option<PathBuf>,
}

impl OpsContext<'_> {
    fn profiles_dir(&self) -> PathBuf {
        self.paths.code_user.join("profiles")
    }

    fn update_api_url(&self) -> String {
        self.manifest
            .components
            .vscode
            .update_api_url(self.os, self.arch)
    }
}

/// Read the prior journal leniently for a non-destructive op (install/
/// repair): a corrupt state.json here means "proceed as if fresh", never
/// "abort the whole install" -- unlike `uninstall`, which must fail closed.
fn read_prior_state_lenient(state_path: &Path) -> Option<State> {
    State::read(state_path).ok().flatten()
}

fn stamp_and_write(state: &mut State, path: &Path) -> Result<(), OpsError> {
    state.updated_at = state::now_iso8601();
    state.write(path)?;
    Ok(())
}

/// `VscodeStepOutcome::product_version_mismatch`'s own doc says "logged by
/// the caller, never a failure" -- this is that logging, shared by
/// `install` and `repair` (the two callers of step 1).
fn log_version_mismatch(op: &str, outcome: &vscode::VscodeStepOutcome) {
    if let Some(api) = &outcome.product_version_mismatch {
        info!(
            installed = %outcome.product_version,
            api_reported = %api,
            "{op}: step 1 installed version differs from the update API"
        );
    }
}

/// Checked before any step runs in ops that touch extensions
/// (`install`/`repair`/`update_extension`): our extension only ever installs
/// from this bundled VSIX (never the Marketplace, see `extensions.rs`), so a
/// missing one can never let the run finish. Failing here -- before step 1
/// -- rather than inside `extensions.rs`'s own `MissingBundledVsix` avoids a
/// run that seeds or adopts a profile (and possibly installs VS Code) in
/// steps 1/2, only to fail with no path forward except a full re-run.
fn require_vsix(ctx: &OpsContext) -> Result<(), OpsError> {
    match ctx.vsix_path.as_deref() {
        Some(p) if p.exists() => Ok(()),
        _ => Err(OpsError::MissingVsix(
            ctx.vsix_path
                .clone()
                .unwrap_or_else(|| PathBuf::from("(none supplied)")),
        )),
    }
}

/// Steps 1, 2, 4 (never 3/runtime) -- ports `repair`'s scope exactly:
/// detect-skip-do on VS Code, the extension, and settings.
pub fn repair(env: &dyn Environment, ctx: &OpsContext) -> Result<State, OpsError> {
    info!("repair: starting");
    require_vsix(ctx)?;
    let prior = read_prior_state_lenient(&ctx.paths.state);
    let seed = state::seed_from_prior(prior.as_ref(), "blockless");
    let mut current = prior.unwrap_or_default();
    current.profile_location = seed.profile_location.clone();

    let vscode_outcome = vscode::ensure_vscode(
        env,
        &ctx.client,
        ctx.os,
        &ctx.code_candidates,
        &ctx.mac_install_targets,
        &ctx.update_api_url(),
        &ctx.paths.downloads,
        &ctx.fetch_opts,
    )
    .inspect_err(|e| warn!(error = %e, "repair: step 1 (vscode) failed"))?;
    current.product_version = vscode_outcome.product_version.clone();
    current.vscode_installed_by_us = seed.vscode_installed_by_us || vscode_outcome.installed_by_us;
    current.steps.vscode = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    log_version_mismatch("repair", &vscode_outcome);
    info!(
        skipped = !vscode_outcome.installed_by_us,
        "repair: step 1 (vscode) done"
    );

    let ext_outcome = extensions::ensure_extensions(
        env,
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.manifest.components.extension.id,
        &ctx.manifest.components.python_extension.id,
        PYLANCE_ID,
        ctx.vsix_path.as_deref(),
        &ctx.manifest.components.extension.sha256,
        &seed.prior_ext_vsix_sha256,
        seed.profile_created_by_us,
        false,
    )
    .inspect_err(|e| warn!(error = %e, "repair: step 2 (extension) failed"))?;
    current.profile_created_by_us = ext_outcome.profile_created_by_us;
    current.ext_vsix_sha256 = ext_outcome.ext_vsix_sha256;
    current.steps.extension = true;
    if let Some(loc) =
        profile::resolve_profile_location(&ctx.paths.storage, &ctx.manifest.profile_name)
    {
        current.profile_location = loc;
    }
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!("repair: step 2 (extension) done");

    let settings_outcome = settings::ensure_settings(
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.paths.env_python,
        &ctx.manifest.settings,
    )
    .inspect_err(|e| warn!(error = %e, "repair: step 4 (settings) failed"))?;
    current.profile_location = settings_outcome.profile_location;
    current.settings_mechanism = "A".to_string();
    current.steps.settings = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!(
        applied = settings_outcome.applied,
        "repair: step 4 (settings) done, repair finished"
    );

    Ok(current)
}

/// `install` = `repair` (steps 1, 2, 4) plus step 3 (runtime) plus the final
/// foreground open. Steps run in the M0 order (1, 2, 3, 4), not repair's
/// (1, 2, 4) then 3 tacked on, so a fresh machine's env_python already
/// exists by the time step 4 writes `mpyhw.pythonPath`.
pub fn install(env: &dyn Environment, ctx: &OpsContext) -> Result<State, OpsError> {
    info!("install: starting");
    require_vsix(ctx)?;
    let prior = read_prior_state_lenient(&ctx.paths.state);
    let seed = state::seed_from_prior(prior.as_ref(), "blockless");
    let mut current = prior.unwrap_or_default();
    // `install` always re-attempts all four steps, unlike `repair`/
    // `repair_runtime` which intentionally touch only a subset -- so unlike
    // those, a prior journal's step flags carry no meaning for THIS run and
    // must not survive into it. Without this reset, an incremental write
    // from an early step (still holding the stale prior flags for steps not
    // yet reached) can leave e.g. a stale `steps.python: true` on disk if
    // this run then dies before actually re-verifying that step.
    current.steps = state::Steps::default();
    current.profile_location = seed.profile_location.clone();
    current.mpremote_version = ctx.manifest.components.mpremote.version.clone();
    current.env_python = ctx.paths.env_python.to_string_lossy().into_owned();

    let vscode_outcome = vscode::ensure_vscode(
        env,
        &ctx.client,
        ctx.os,
        &ctx.code_candidates,
        &ctx.mac_install_targets,
        &ctx.update_api_url(),
        &ctx.paths.downloads,
        &ctx.fetch_opts,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 1 (vscode) failed"))?;
    current.product_version = vscode_outcome.product_version.clone();
    current.vscode_installed_by_us = seed.vscode_installed_by_us || vscode_outcome.installed_by_us;
    current.steps.vscode = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    log_version_mismatch("install", &vscode_outcome);
    info!(
        skipped = !vscode_outcome.installed_by_us,
        "install: step 1 (vscode) done"
    );

    let ext_outcome = extensions::ensure_extensions(
        env,
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.manifest.components.extension.id,
        &ctx.manifest.components.python_extension.id,
        PYLANCE_ID,
        ctx.vsix_path.as_deref(),
        &ctx.manifest.components.extension.sha256,
        &seed.prior_ext_vsix_sha256,
        seed.profile_created_by_us,
        false,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 2 (extension) failed"))?;
    current.profile_created_by_us = ext_outcome.profile_created_by_us;
    current.ext_vsix_sha256 = ext_outcome.ext_vsix_sha256;
    current.steps.extension = true;
    if let Some(loc) =
        profile::resolve_profile_location(&ctx.paths.storage, &ctx.manifest.profile_name)
    {
        current.profile_location = loc;
    }
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!("install: step 2 (extension) done");

    runtime::ensure_runtime(
        env,
        &ctx.client,
        ctx.os,
        ctx.arch,
        &ctx.manifest.components.uv,
        &ctx.manifest.components.python.series,
        &ctx.manifest.components.mpremote.version,
        &ctx.paths.blk,
        &ctx.paths.env_python,
        &ctx.paths.downloads,
        &ctx.fetch_opts,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 3 (runtime) failed"))?;
    current.steps.python = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!("install: step 3 (runtime) done");

    let settings_outcome = settings::ensure_settings(
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.paths.env_python,
        &ctx.manifest.settings,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 4 (settings) failed"))?;
    current.profile_location = settings_outcome.profile_location;
    current.settings_mechanism = "A".to_string();
    current.steps.settings = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!(
        applied = settings_outcome.applied,
        "install: step 4 (settings) done"
    );

    // Final: foreground open into the profile. Every earlier step that
    // spawned a child of its own (register_profile's window fallback) has
    // already closed it before returning, so this is always a fresh
    // extension host -- never an attach to a lingering child, never the
    // user's own session.
    if let Err(e) = env.spawn(
        &vscode_outcome.code_cli,
        &["--profile", &ctx.manifest.profile_name, "--new-window"],
    ) {
        warn!(error = %e, "install: final foreground open failed to spawn");
    }
    info!("install: finished");

    Ok(current)
}

#[path = "ops/repair_runtime.rs"]
mod repair_runtime;
pub use repair_runtime::repair_runtime;
/// Force-reinstall the bundled VSIX regardless of the sha-match skip, and
/// re-journal the sha. Steps 1/3/4 are untouched.
#[path = "ops/update_extension.rs"]
mod update_extension;
pub use update_extension::update_extension;

#[path = "ops/support.rs"]
mod support;
#[cfg(test)]
use support::vscode_install_locations;
pub use support::{diagnostics, uninstall, verify};
const PYLANCE_ID: &str = "ms-python.vscode-pylance";

#[cfg(test)]
#[path = "tests/ops.rs"]
mod tests;
