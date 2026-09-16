use super::*;
use crate::test_support::temp_path;

/// The ordering is the whole point. A stamped manifest an operator just
/// placed beside the executable must beat a copy baked into the bundle,
/// or a stale bundled manifest silently decides which artifact gets
/// verified.
#[test]
fn an_exe_adjacent_manifest_is_searched_before_a_bundled_one() {
    let candidates = manifest_candidates(
        PathBuf::from("/app/Contents/MacOS/installer.manifest.json"),
        Some(PathBuf::from("/app/Contents/Resources")),
    );
    assert_eq!(
        candidates,
        vec![
            PathBuf::from("/app/Contents/MacOS/installer.manifest.json"),
            PathBuf::from("/app/Contents/Resources/installer.manifest.json"),
        ]
    );
}

/// Windows puts resources in the executable's own directory, so both
/// candidates resolve to one path. Reporting it twice in a failure
/// message reads as two places having been tried.
#[test]
fn one_directory_serving_both_roles_is_listed_once() {
    let candidates = manifest_candidates(
        PathBuf::from("/install/installer.manifest.json"),
        Some(PathBuf::from("/install")),
    );
    assert_eq!(
        candidates,
        vec![PathBuf::from("/install/installer.manifest.json")]
    );
}

/// A plain `cargo run` has no bundle, so there is nothing to fall back
/// to and the sidecar path is the only one.
#[test]
fn without_a_bundle_only_the_exe_adjacent_path_is_searched() {
    let candidates =
        manifest_candidates(PathBuf::from("/target/debug/installer.manifest.json"), None);
    assert_eq!(
        candidates,
        vec![PathBuf::from("/target/debug/installer.manifest.json")]
    );
}

/// An absent sidecar is a different fact from an unreadable one. Only
/// the first may fall through to the bundle: letting the second through
/// would hand precedence to the baked-in zero-hash manifest and verify
/// the wrong artifact, reporting nothing.
#[cfg(unix)]
#[test]
fn an_unreadable_sidecar_fails_rather_than_falling_through_to_the_bundle() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_path("unreadable-sidecar");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let sidecar = dir.join(MANIFEST_FILE_NAME);
    let bundled = dir.join("bundle").join(MANIFEST_FILE_NAME);
    std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
    std::fs::write(&sidecar, "{}").unwrap();
    std::fs::write(&bundled, "{}").unwrap();
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o000)).unwrap();

    let err = read_first_manifest(&[sidecar.clone(), bundled])
        .expect_err("an unreadable sidecar must stop the search, not be skipped");
    assert!(
        err.contains(&sidecar.display().to_string()),
        "the error must name the sidecar that could not be read, got: {err}"
    );

    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o644)).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// The ordinary case the fall-through exists for: nothing beside the
/// executable, so the bundled copy is used.
#[test]
fn an_absent_sidecar_falls_through_to_the_bundled_manifest() {
    let dir = temp_path("absent-sidecar");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let missing = dir.join(MANIFEST_FILE_NAME);
    let bundled = dir.join("bundle").join(MANIFEST_FILE_NAME);
    std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
    std::fs::write(&bundled, "{\"marker\":1}").unwrap();

    let candidates = [missing, bundled.clone()];
    let (found, json) = read_first_manifest(&candidates).expect("the bundled copy is readable");
    assert_eq!(found, &bundled);
    assert!(json.contains("marker"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// The failure a user actually sees. Naming only the first candidate
/// sends them to `Contents/MacOS` when the file was shipped to
/// `Contents/Resources`.
#[test]
fn a_missing_manifest_names_every_location_searched() {
    let missing = temp_path("nonexistent-bundle");
    let err = load_manifest_and_vsix(Some(missing.clone()))
        .expect_err("no manifest exists at either candidate");
    assert!(err.contains(MANIFEST_FILE_NAME), "{err}");
    assert!(
        err.contains(&missing.join(MANIFEST_FILE_NAME).display().to_string()),
        "the bundle candidate must appear in the error, got: {err}"
    );
}
