//! `storage.json` edits for the uninstall: removing our profile entry and its
//! associations, and confirming the entry is gone. Split out of
//! `uninstall.rs` for size only.

use serde_json::Value;
use std::path::Path;

fn read_storage(storage_path: &Path) -> Option<Value> {
    let bytes = std::fs::read(storage_path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "storage.json".to_string());
    let tmp = parent.join(format!("{file_name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest)
}

/// Best-effort: filters our entry out if the file exists and parses.
/// Silent on any failure (missing, unreadable, unparseable, wrong shape) --
/// the invariant guard right after this is what actually enforces safety,
/// not this function's return value (it has none).
pub(super) fn remove_storage_entry(
    storage_path: &Path,
    profile_name: &str,
    profile_location: &str,
) {
    let Some(mut root) = read_storage(storage_path) else {
        return;
    };
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if let Some(list) = obj
        .get_mut("userDataProfiles")
        .and_then(Value::as_array_mut)
    {
        list.retain(|e| e.get("name").and_then(Value::as_str) != Some(profile_name));
    }
    // Independent of the list above: VS Code drops `userDataProfiles` once
    // its last custom profile is gone, and a prior run may already have
    // removed our entry, while our associations can still be there.
    remove_profile_associations(obj, profile_location);
    let Ok(body) = serde_json::to_vec_pretty(&root) else {
        return;
    };
    let _ = write_atomic(storage_path, &body);
}

/// Drop every window/workspace association pointing at our profile.
///
/// These live beside `userDataProfiles` and key off the profile's LOCATION
/// (`"blockless"`), not its display name (`"Blockless"`):
///
/// ```json
/// "profileAssociations": {
///   "workspaces":   { "<workspace uri>": "blockless" },
///   "emptyWindows": { "<window id>":     "blockless" }
/// }
/// ```
///
/// Found on the Windows Sandbox rig, 2026-09-22. An install writes THREE
/// pieces of state -- the `userDataProfiles` entry, the `profiles/<loc>/`
/// directory, and these associations -- and the uninstall removed only the
/// first two. What survived a fully successful uninstall was a dangling
/// association naming a profile that no longer existed. The acceptance
/// checklist's step 8 calls this out exactly: "the entry and the directory
/// are two removals, so an orphan survives while everything else looks gone".
/// There are three.
///
/// Best-effort and shape-tolerant, like its caller: a missing or oddly-shaped
/// `profileAssociations` is simply left alone. It is NOT wired into
/// [`storage_entry_confirmed_absent`], so a failure to prune here can never
/// trip the invariant guard and abort an otherwise good uninstall -- a stale
/// association is untidy, not dangerous.
fn remove_profile_associations(obj: &mut serde_json::Map<String, Value>, profile_location: &str) {
    let Some(assoc) = obj
        .get_mut("profileAssociations")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for key in ["workspaces", "emptyWindows"] {
        if let Some(map) = assoc.get_mut(key).and_then(Value::as_object_mut) {
            map.retain(|_, v| v.as_str() != Some(profile_location));
        }
    }
}

/// Fail-closed: `true` only when we can POSITIVELY confirm the entry is
/// gone. Missing file = confirmed gone. Unreadable/unparseable/wrong-shape
/// = cannot confirm = treated as still present.
pub(super) fn storage_entry_confirmed_absent(storage_path: &Path, profile_name: &str) -> bool {
    if !storage_path.exists() {
        return true;
    }
    let Some(root) = read_storage(storage_path) else {
        return false; // exists but unreadable/unparseable: cannot confirm
    };
    let present = root
        .get("userDataProfiles")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .any(|e| e.get("name").and_then(Value::as_str) == Some(profile_name))
        })
        .unwrap_or(false);
    !present
}
