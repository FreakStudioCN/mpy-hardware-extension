//! The wiring recipe every shell (the CLI, a future GUI) needs before it can
//! call an op: where the manifest lives by default, how the bundled VSIX
//! path resolves against it, and macOS's install-target search order. `cli`
//! is a bin-only crate the GUI cannot depend on, so this lives in the core
//! instead -- a behavior-identical move from `cli/src/cli.rs` and
//! `cli/src/main.rs`, not a rewrite.

use crate::platform::{Os, RawEnv};
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

#[cfg(test)]
#[path = "tests/bootstrap.rs"]
mod tests;
