//! Where `installer.manifest.json` is looked for, and the VSIX beside it.
//! The sidecar contract the CLI and the rig use, extended by one fallback
//! for the bundle case -- see [`manifest_candidates`] for why.

use blockless_installer_core::bootstrap::{
    default_manifest_path, resolve_vsix_path, MANIFEST_FILE_NAME,
};
use blockless_installer_core::manifest::Manifest;
use std::path::PathBuf;
use tauri::Manager;

/// The bundle's own resource directory, or `None` when Tauri cannot resolve
/// one. Only Tauri knows where its bundle put things, which is why this
/// needs the `AppHandle` and why it is read here rather than inside the
/// worker thread.
///
/// `None` is rarer than it looks, and NOT the development case: a binary
/// under a cargo target directory resolves to its own directory, as does
/// any binary on Windows, so the usual answer there is `Some(exe_dir)`,
/// which [`manifest_candidates`] then deduplicates away. The case that
/// really reaches `None` is a bare macOS release binary sitting outside a
/// bundle, where `<exe_dir>/../Resources` does not resolve -- which is
/// exactly how the rig runs this.
pub(crate) fn bundle_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// Where `installer.manifest.json` may live, in the order it is looked for.
///
/// Exe-adjacent FIRST, always. That is the sidecar contract the rig and the
/// CLI both use -- a release binary with a freshly stamped manifest and the
/// VSIX it covers beside it -- and a stamped manifest an operator just put
/// there must beat anything baked into a bundle, or a stale bundled copy
/// silently wins and the run verifies the wrong artifact.
///
/// The bundle resource directory is the fallback, and it exists because the
/// two platforms disagree. On Windows the resource directory IS the
/// executable's directory, so a declared resource is already found by the
/// first candidate. On macOS it is `Contents/Resources` while the executable
/// sits in `Contents/MacOS`, so without this second candidate a bundle can
/// never find a manifest at all, whatever `tauri.conf.json` declares.
///
/// Deduplicated, so the Windows and development cases do not report the same
/// path twice when a lookup fails.
///
/// `tauri.conf.json` declares the manifest under `bundle.resources` in MAP
/// form. It has to be a map: a list mangles a leading `../` into `_up_/`,
/// which would break the manifest-relative path the VSIX resolves through.
/// That config file rejects unknown keys, so this note lives here.
///
/// What a bundle gets today is the COMMITTED manifest, whose hashes are all
/// zeros on purpose. So a bundle built without a stamping step finds a
/// manifest, fails the sha check and installs nothing. That is the honest
/// outcome and it is deliberate: the VSIX is not reproducible, so a stamped
/// manifest is only valid for the exact VSIX beside it, and baking a real
/// hash in would be a lie the moment the VSIX is rebuilt. A bundle that can
/// install needs a stamp-and-inject packaging step, which does not exist
/// yet.
pub(crate) fn manifest_candidates(
    exe_adjacent: PathBuf,
    resource_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = vec![exe_adjacent];
    if let Some(dir) = resource_dir {
        let bundled = dir.join(MANIFEST_FILE_NAME);
        if bundled != candidates[0] {
            candidates.push(bundled);
        }
    }
    candidates
}

/// Read the first manifest that EXISTS, in `candidates` order.
///
/// Only `NotFound` moves on to the next candidate. Every other error stops
/// here and surfaces, because a sidecar that exists but cannot be read is
/// not the same fact as one that was never placed. Treating the two alike
/// would let a damaged or unreadable sidecar fall through to the bundled
/// zero-hash manifest, which silently inverts the precedence rule the
/// candidate order exists to enforce: the operator's stamped file would
/// lose to a baked-in one, and the run would verify the wrong artifact
/// while reporting nothing.
///
/// Invalid UTF-8 arrives as `InvalidData` and surfaces here too, which is
/// right: that file was meant to be the manifest.
///
/// When no candidate exists the error names every location searched.
/// Naming only the first sends the reader to the wrong place on the
/// platform where the first is not where the file was shipped.
pub(crate) fn read_first_manifest(candidates: &[PathBuf]) -> Result<(&PathBuf, String), String> {
    for path in candidates {
        match std::fs::read_to_string(path) {
            Ok(json) => return Ok((path, json)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        }
    }
    let searched = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "could not read {MANIFEST_FILE_NAME}; searched: {searched}"
    ))
}

/// The manifest that won the search, and the VSIX resolved relative to THAT
/// manifest's own directory -- so a bundled manifest looks for a bundled
/// VSIX and a sidecar manifest looks beside itself.
pub(crate) fn load_manifest_and_vsix(
    resource_dir: Option<PathBuf>,
) -> Result<(Manifest, PathBuf), String> {
    let candidates = manifest_candidates(default_manifest_path(), resource_dir);
    let (manifest_path, manifest_json) = read_first_manifest(&candidates)?;
    let manifest = Manifest::parse(&manifest_json).map_err(|e| e.to_string())?;
    let vsix_path = resolve_vsix_path(None, manifest_path, &manifest.components.extension.path);
    Ok((manifest, vsix_path))
}

#[cfg(test)]
#[path = "tests/manifest_lookup.rs"]
mod tests;
