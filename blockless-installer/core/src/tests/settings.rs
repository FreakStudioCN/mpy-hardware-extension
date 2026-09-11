use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-settings-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct NoopCommandRunner;
impl profile::CommandRunner for NoopCommandRunner {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        Ok(vec![])
    }
    fn spawn(&self, _code_cli: &Path, _args: &[&str]) -> std::io::Result<u32> {
        Ok(1)
    }
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }
    fn request_graceful_close(&self, _pid: u32) {}
    fn force_kill(&self, _pid: u32) {}
    fn sleep(&self, _d: Duration) {}
}

fn manifest_settings() -> ManifestSettings {
    ManifestSettings {
        color_theme: "Default Dark Modern".to_string(),
        auto_open_panel: true,
        secondary_side_bar_default_visibility: "hidden".to_string(),
    }
}

fn register(dir: &Path, loc: &str, name: &str) {
    let storage = dir.join("storage.json");
    std::fs::write(
        &storage,
        serde_json::json!({"userDataProfiles": [{"location": loc, "name": name}]}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("profiles").join(loc)).unwrap();
}

#[test]
fn merge_preserves_foreign_keys() {
    let dir = temp_dir("preserve-foreign");
    register(&dir, "blockless", "Blockless");
    let target = dir.join("profiles").join("blockless").join("settings.json");
    std::fs::write(
        &target,
        serde_json::json!({
            "editor.fontSize": 14,
            "files.autoSave": "onFocusChange",
            "some.deeply.nested": {"a": [1, 2, {"b": true}]}
        })
        .to_string(),
    )
    .unwrap();
    let envpy = dir.join("env").join("bin").join("python");

    ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();

    let after: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
    assert_eq!(after["editor.fontSize"], serde_json::json!(14));
    assert_eq!(after["files.autoSave"], serde_json::json!("onFocusChange"));
    assert_eq!(
        after["some.deeply.nested"],
        serde_json::json!({"a": [1, 2, {"b": true}]})
    );
    assert_eq!(after["mpyhw.autoOpenPanel"], serde_json::json!(true));
    assert_eq!(
        after["mpyhw.pythonPath"],
        serde_json::json!(envpy.to_string_lossy())
    );
}

#[test]
fn refuses_unparseable_existing_settings() {
    let dir = temp_dir("unparseable");
    register(&dir, "blockless", "Blockless");
    let target = dir.join("profiles").join("blockless").join("settings.json");
    std::fs::write(&target, b"{ not valid json, has // comments too").unwrap();
    let original = std::fs::read(&target).unwrap();
    let envpy = dir.join("env").join("bin").join("python");

    let err = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap_err();

    assert!(matches!(err, SettingsError::Unparseable(_)));
    assert_eq!(
        std::fs::read(&target).unwrap(),
        original,
        "an unparseable settings.json must never be touched"
    );
}

#[test]
fn skip_requires_all_four_keys_to_match() {
    let dir = temp_dir("four-keys");
    register(&dir, "blockless", "Blockless");
    let target = dir.join("profiles").join("blockless").join("settings.json");
    let envpy = dir.join("env").join("bin").join("python");

    // first call applies all four keys
    let first = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();
    assert!(first.applied);
    let after_first = std::fs::read(&target).unwrap();

    // second call with everything already correct: must skip (no write)
    let second = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();
    assert!(!second.applied);
    assert_eq!(
        std::fs::read(&target).unwrap(),
        after_first,
        "skip must not rewrite the file"
    );

    // now break just ONE of the four keys (autoOpenPanel) directly on
    // disk -- must be detected as no-longer-current and re-applied
    let mut broken: Value = serde_json::from_slice(&after_first).unwrap();
    broken["mpyhw.autoOpenPanel"] = serde_json::json!(false);
    std::fs::write(&target, serde_json::to_vec(&broken).unwrap()).unwrap();

    let third = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();
    assert!(
        third.applied,
        "one wrong key out of four must still trigger a re-apply"
    );
    let repaired: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
    assert_eq!(repaired["mpyhw.autoOpenPanel"], serde_json::json!(true));
}

#[test]
fn journal_adopts_the_resolved_id_not_the_seed_constant() {
    let dir = temp_dir("resolved-id");
    // simulate a VS-Code-created fallback profile: a hashed id, not "blockless"
    register(&dir, "a1b2c3d4e5f6", "Blockless");
    let envpy = dir.join("env").join("bin").join("python");

    let outcome = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless", // the seed constant -- must NOT be what gets journaled
        &envpy,
        &manifest_settings(),
    )
    .unwrap();

    assert_eq!(outcome.profile_location, "a1b2c3d4e5f6");
    assert!(
        dir.join("profiles")
            .join("a1b2c3d4e5f6")
            .join("settings.json")
            .exists(),
        "must write to the RESOLVED location"
    );
    assert!(!dir.join("profiles").join("blockless").exists());
}

#[test]
fn resolves_via_offline_seed_when_profile_not_yet_registered() {
    let dir = temp_dir("via-seed");
    let envpy = dir.join("env").join("bin").join("python");
    // nothing registered yet at all: ensure_settings must itself seed it

    let outcome = ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();

    assert_eq!(outcome.profile_location, "blockless");
    assert!(outcome.applied);
}

#[test]
fn write_is_atomic_no_tmp_left_behind() {
    let dir = temp_dir("atomic");
    register(&dir, "blockless", "Blockless");
    let envpy = dir.join("env").join("bin").join("python");

    ensure_settings(
        &NoopCommandRunner,
        &dir.join("code"),
        &dir.join("storage.json"),
        &dir.join("profiles"),
        "Blockless",
        "blockless",
        &envpy,
        &manifest_settings(),
    )
    .unwrap();

    let target = dir.join("profiles").join("blockless").join("settings.json");
    assert!(target.exists());
    assert!(!dir
        .join("profiles")
        .join("blockless")
        .join("settings.json.tmp")
        .exists());
}
