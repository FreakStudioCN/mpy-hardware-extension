//! `profileAssociations` cleanup: the third piece of state an install writes
//! to `storage.json`, beside the `userDataProfiles` entry and the directory.

use super::*;

/// Install writes THREE pieces of state; the uninstall used to remove two.
/// Found on the Windows Sandbox rig, 2026-09-22: after a FULLY SUCCESSFUL
/// uninstall, `storage.json` still held
/// `profileAssociations.emptyWindows = {"<id>": "blockless"}`, a dangling
/// reference to a profile whose `userDataProfiles` entry and directory were
/// both gone.
///
/// Note the key: associations name the profile's LOCATION ("blockless"),
/// while `userDataProfiles` is matched by its display NAME ("Blockless").
/// Matching on the wrong one silently prunes nothing, so this asserts a
/// foreign association SURVIVES as well as ours being removed.
#[test]
fn uninstall_prunes_profile_associations_by_location() {
    let l = layout("assoc-prune");
    write_state(&l.state_path, &default_state());
    std::fs::create_dir_all(l.storage_path.parent().unwrap()).unwrap();
    std::fs::write(
        &l.storage_path,
        serde_json::json!({
            "userDataProfiles": [{"location": "blockless", "name": "Blockless"}],
            "profileAssociations": {
                "workspaces":   {"file:///w": "blockless", "file:///keep": "someone-else"},
                "emptyWindows": {"1790059975866": "blockless", "999": "someone-else"},
            },
        })
        .to_string(),
    )
    .unwrap();
    let runner = FakeUninstallRunner::default();

    let _ = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags::default(),
    );

    let root: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&l.storage_path).unwrap()).unwrap();
    let assoc = &root["profileAssociations"];
    assert_eq!(
        assoc["workspaces"],
        serde_json::json!({"file:///keep": "someone-else"}),
        "our workspace association must go; another profile's must stay"
    );
    assert_eq!(
        assoc["emptyWindows"],
        serde_json::json!({"999": "someone-else"}),
        "our window association must go; another profile's must stay"
    );
}

/// Shape tolerance: a missing `profileAssociations` must not stop the
/// `userDataProfiles` removal, and must not panic.
#[test]
fn uninstall_without_profile_associations_still_removes_the_entry() {
    let l = layout("assoc-absent");
    write_state(&l.state_path, &default_state());
    write_storage_with_entry(&l.storage_path, "Blockless", "blockless");
    let runner = FakeUninstallRunner::default();

    let _ = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags::default(),
    );

    let root: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&l.storage_path).unwrap()).unwrap();
    assert_eq!(
        root["userDataProfiles"],
        serde_json::json!([]),
        "the entry is still removed when there are no associations at all"
    );
    assert_eq!(
        root["someOtherProfile"],
        serde_json::json!({"kept": true}),
        "unrelated keys must survive"
    );
}

/// VS Code drops `userDataProfiles` once the last custom profile is gone, and
/// a prior run may already have removed our entry. Our associations can
/// outlive both, so pruning them must not depend on the list being there.
#[test]
fn uninstall_prunes_associations_even_without_user_data_profiles() {
    let l = layout("assoc-no-list");
    write_state(&l.state_path, &default_state());
    std::fs::create_dir_all(l.storage_path.parent().unwrap()).unwrap();
    std::fs::write(
        &l.storage_path,
        serde_json::json!({
            "profileAssociations": {
                "emptyWindows": {"1790059975866": "blockless", "999": "someone-else"},
            },
        })
        .to_string(),
    )
    .unwrap();
    let runner = FakeUninstallRunner::default();

    let _ = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags::default(),
    );

    let root: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&l.storage_path).unwrap()).unwrap();
    assert_eq!(
        root["profileAssociations"]["emptyWindows"],
        serde_json::json!({"999": "someone-else"}),
        "our dangling association must go even with no userDataProfiles key"
    );
}
