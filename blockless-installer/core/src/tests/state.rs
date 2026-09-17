use super::*;

fn temp_path(name: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "blockless-installer-state-test-{name}-{}-{n}.json",
        std::process::id()
    ))
}

const M0_STATE_JSON: &str = r#"{
  "productVersion": "1.99.0",
  "vscodeInstalledByUs": true,
  "profileCreatedByUs": true,
  "profileLocation": "blockless",
  "steps": { "vscode": true, "extension": true, "python": true, "settings": true },
  "mpremoteVersion": "1.28.0",
  "envPython": "/Users/erson/Library/Application Support/Blockless/env/bin/python",
  "extVsixSha256": "abc123def456",
  "settingsMechanism": "A",
  "updatedAt": "2026-07-05T12:00:00Z"
}"#;

#[test]
fn m0_written_state_round_trips_unchanged() {
    let path = temp_path("round-trip");
    std::fs::write(&path, M0_STATE_JSON).unwrap();

    let parsed = State::read(&path).unwrap().expect("state.json exists");
    assert_eq!(parsed.product_version, "1.99.0");
    assert!(parsed.vscode_installed_by_us);
    assert!(parsed.profile_created_by_us);
    assert_eq!(parsed.profile_location, "blockless");
    assert!(parsed.steps.all_ok());
    assert_eq!(parsed.mpremote_version, "1.28.0");
    assert_eq!(parsed.ext_vsix_sha256, "abc123def456");
    assert_eq!(parsed.settings_mechanism, "A");
    assert_eq!(parsed.updated_at, "2026-07-05T12:00:00Z");

    parsed.write(&path).unwrap();
    let reparsed = State::read(&path)
        .unwrap()
        .expect("state.json still exists");
    assert_eq!(
        reparsed, parsed,
        "round-trip through write() must be lossless"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn read_missing_file_is_ok_none() {
    let path = temp_path("missing");
    assert_eq!(State::read(&path).unwrap(), None);
}

#[test]
fn read_corrupt_file_fails_loudly_not_silently() {
    let path = temp_path("corrupt");
    std::fs::write(&path, "{ this is not json").unwrap();
    let err = State::read(&path).unwrap_err();
    assert!(matches!(err, StateError::Parse { .. }), "got {err:?}");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn write_is_atomic_no_tmp_left_behind() {
    let path = temp_path("atomic");
    let state = State {
        product_version: "1.0.0".to_string(),
        ..Default::default()
    };
    state.write(&path).unwrap();
    assert!(path.exists());
    let tmp = path.parent().unwrap().join(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    assert!(
        !tmp.exists(),
        "temp file must be renamed away, not left behind"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn seed_with_no_prior_state_is_all_default() {
    let seed = seed_from_prior(None, "blockless");
    assert_eq!(
        seed,
        Seed {
            vscode_installed_by_us: false,
            profile_created_by_us: false,
            profile_location: "blockless".to_string(),
            prior_ext_vsix_sha256: String::new(),
        }
    );
}

#[test]
fn vscode_installed_by_us_is_sticky_true() {
    let prior = State {
        vscode_installed_by_us: true,
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert!(
        seed.vscode_installed_by_us,
        "a prior true must carry forward, even though this run hasn't run step 1 yet"
    );
}

#[test]
fn vscode_installed_by_us_stays_false_when_never_set() {
    let prior = State {
        vscode_installed_by_us: false,
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert!(!seed.vscode_installed_by_us);
}

#[test]
fn profile_created_by_us_is_sticky_true() {
    let prior = State {
        profile_created_by_us: true,
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert!(seed.profile_created_by_us);
}

#[test]
fn prior_profile_location_is_authoritative() {
    let prior = State {
        // VS Code's own fallback registration gives a hashed id, not the
        // "blockless" seed constant -- exactly the case this guards.
        profile_location: "a1b2c3d4e5f6".to_string(),
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert_eq!(seed.profile_location, "a1b2c3d4e5f6");
}

#[test]
fn empty_prior_profile_location_falls_back_to_the_seed_constant() {
    let prior = State {
        profile_location: String::new(),
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert_eq!(seed.profile_location, "blockless");
}

#[test]
fn ext_vsix_sha256_carries_forward_into_prior_ext_vsix_sha256() {
    let prior = State {
        ext_vsix_sha256: "deadbeef".to_string(),
        ..Default::default()
    };
    let seed = seed_from_prior(Some(&prior), "blockless");
    assert_eq!(seed.prior_ext_vsix_sha256, "deadbeef");
}

#[test]
fn now_iso8601_formats_known_epoch_seconds() {
    assert_eq!(format_unix_seconds(0), "1970-01-01T00:00:00Z");
    assert_eq!(format_unix_seconds(86400), "1970-01-02T00:00:00Z");
    assert_eq!(format_unix_seconds(1_000_000_000), "2001-09-09T01:46:40Z");
    assert_eq!(format_unix_seconds(1_700_000_000), "2023-11-14T22:13:20Z");
    assert_eq!(format_unix_seconds(1_893_456_000), "2030-01-01T00:00:00Z");
}
