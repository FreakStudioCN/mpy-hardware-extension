//! The wiring recipe every shell (the CLI, a future GUI) needs before it can
//! call an op: where the manifest lives by default, how the bundled VSIX
//! path resolves against it, and macOS's install-target search order. `cli`
//! is a bin-only crate the GUI cannot depend on, so this lives in the core
//! instead -- a behavior-identical move from `cli/src/cli.rs` and
//! `cli/src/main.rs`, not a rewrite.

use crate::fetch::{download_client, FetchOptions};
use crate::manifest::Manifest;
use crate::ops::OpsContext;
use crate::platform::{code_cli_candidates, Arch, Os, Paths, RawEnv};
use crate::progress::ProgressSink;
use std::path::{Path, PathBuf};

/// The manifest's file name, wherever it is looked for. Public because a
/// shell that searches more than one directory (the GUI looks exe-adjacent
/// first, then in its bundle's resource directory) has to build the other
/// candidates itself, and must not spell this a second time.
pub const MANIFEST_FILE_NAME: &str = "installer.manifest.json";

/// [`MANIFEST_FILE_NAME`], exe-adjacent. Falls back to a bare relative
/// path only if the current exe's own location can't be determined.
pub fn default_manifest_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(MANIFEST_FILE_NAME)))
        .unwrap_or_else(|| PathBuf::from(MANIFEST_FILE_NAME))
}

/// The bundled VSIX path: an explicit override wins outright; otherwise the
/// manifest's own `components.extension.path` is resolved relative to the
/// manifest file's own directory (or taken as-is if already absolute).
pub fn resolve_vsix_path(
    override_path: Option<&Path>,
    manifest_path: &Path,
    bundled_path: &str,
) -> PathBuf {
    if let Some(path) = override_path {
        return path.to_path_buf();
    }
    let path = PathBuf::from(bundled_path);
    if path.is_absolute() {
        path
    } else {
        manifest_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(path)
    }
}

/// macOS candidate install roots, in the order `vscode.rs`'s own
/// writability fallback tries them: the system `/Applications` first, then
/// the user's own `~/Applications`. Empty on Windows, which has no
/// target-selection concept (always exactly one install location).
pub fn mac_install_targets(os: Os, raw: &RawEnv) -> Vec<PathBuf> {
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

/// This machine, resolved once from a [`RawEnv`]: everything an
/// [`OpsContext`] needs that does not come from the manifest. Resolved
/// before the manifest is even read, so a shell can still find `logs/` and
/// `state.json` -- for logging, or for a diagnostics bundle -- when the
/// manifest turns out to be missing or damaged.
#[derive(Debug, Clone)]
pub struct Machine {
    pub os: Os,
    pub arch: Arch,
    pub paths: Paths,
    pub code_candidates: Vec<PathBuf>,
    pub mac_install_targets: Vec<PathBuf>,
}

impl Machine {
    pub fn detect(raw: &RawEnv) -> Result<Machine, String> {
        let os = Os::detect(raw).map_err(|e| e.to_string())?;
        let arch = Arch::detect(os, raw).map_err(|e| e.to_string())?;
        let paths = Paths::resolve(os, raw).map_err(|e| e.to_string())?;
        let code_candidates = code_cli_candidates(os, raw).map_err(|e| e.to_string())?;
        let mac_install_targets = mac_install_targets(os, raw);
        Ok(Machine {
            os,
            arch,
            paths,
            code_candidates,
            mac_install_targets,
        })
    }
}

/// The one [`OpsContext`] recipe every shell uses: this machine, this
/// manifest, the VSIX beside it, the shared download client with its
/// default retry policy, and wherever the shell wants progress reported.
/// The CLI and the GUI both call this, so the two can never wire an op
/// differently by accident.
pub fn build_ops_context<'a>(
    machine: Machine,
    manifest: &'a Manifest,
    vsix_path: PathBuf,
    progress: &'a dyn ProgressSink,
) -> Result<OpsContext<'a>, String> {
    let client = download_client().map_err(|e| e.to_string())?;
    Ok(OpsContext {
        os: machine.os,
        arch: machine.arch,
        paths: machine.paths,
        manifest,
        client,
        fetch_opts: FetchOptions::default(),
        code_candidates: machine.code_candidates,
        mac_install_targets: machine.mac_install_targets,
        vsix_path: Some(vsix_path),
        progress,
    })
}

#[cfg(test)]
#[path = "tests/bootstrap.rs"]
mod tests;
