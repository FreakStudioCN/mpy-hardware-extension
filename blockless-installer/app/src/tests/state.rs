use super::*;

#[test]
fn install_attempts_are_allowed_up_to_the_limit_then_refused() {
    for attempt in 1..=MAX_INSTALL_ATTEMPTS_PER_PROCESS {
        assert!(install_attempt_allowed(attempt), "attempt {attempt}");
    }
    assert!(!install_attempt_allowed(
        MAX_INSTALL_ATTEMPTS_PER_PROCESS + 1
    ));
}

#[test]
fn op_guard_refuses_a_second_acquire_while_held_and_releases_on_drop() {
    let flag = AtomicBool::new(false);
    let first = OpGuard::try_acquire(&flag).expect("first acquire must succeed");
    assert!(
        OpGuard::try_acquire(&flag).is_none(),
        "must refuse a second concurrent acquire"
    );
    drop(first);
    assert!(
        OpGuard::try_acquire(&flag).is_some(),
        "must be acquirable again once the first guard is dropped"
    );
}

/// The GUI's version must equal the core's.
///
/// `app/` is excluded from the root cargo workspace, so `app/Cargo.toml` has
/// its own literal `version` and cannot inherit `[workspace.package]`. Nothing
/// compared the two, and `tauri.conf.json` used to hold a THIRD copy (removed:
/// with no `version` key Tauri takes it from `Cargo.toml`). The manifest's
/// `installerVersion` is guarded separately, in
/// `core::manifest::tests::committed_manifest_installer_version_matches_this_crate`.
///
/// Between them, every surviving copy of the number is now checked against the
/// crate version, so a bump cannot silently leave one behind and show a user
/// two different versions of the same program.
#[test]
fn gui_version_matches_core() {
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        blockless_installer_core::VERSION,
        "app/Cargo.toml's version has drifted from the core crate's"
    );
}
