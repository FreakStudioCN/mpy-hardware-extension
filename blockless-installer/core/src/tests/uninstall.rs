use super::*;
use crate::state::Steps;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-uninstall-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `BLK`, VS Code's own data dir, and the VS Code install dir are three
/// SIBLING trees in reality (never nested in each other) -- state.json
/// lives inside BLK, but storage.json/profiles and the VS Code install
/// never do. A fixture that nests them would make BLK removal silently
/// also delete storage.json or the VS Code dir, masking real bugs (or
/// creating fake ones) that don't exist in production.
struct Layout {
    blk: PathBuf,
    state_path: PathBuf,
    storage_path: PathBuf,
    profiles_dir: PathBuf,
    vscode_dir: PathBuf,
}

fn layout(name: &str) -> Layout {
    let root = temp_dir(name);
    let blk = root.join("Blockless");
    let code_user = root.join("CodeUser");
    Layout {
        state_path: blk.join("state.json"),
        storage_path: code_user.join("storage.json"),
        profiles_dir: code_user.join("profiles"),
        vscode_dir: root.join("vscode"),
        blk,
    }
}

struct FakeCommandRunner {
    running: Vec<u32>,
}
impl profile::CommandRunner for FakeCommandRunner {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        Ok(self.running.clone())
    }
    fn spawn(&self, _code_cli: &Path, _args: &[&str]) -> std::io::Result<u32> {
        unimplemented!()
    }
    fn is_alive(&self, _pid: u32) -> bool {
        unimplemented!()
    }
    fn request_graceful_close(&self, _pid: u32) {}
    fn force_kill(&self, _pid: u32) {}
    fn sleep(&self, _d: Duration) {}
}
fn not_running() -> FakeCommandRunner {
    FakeCommandRunner { running: vec![] }
}

struct FailedProcessCheck;
impl profile::CommandRunner for FailedProcessCheck {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        Err("process query failed".to_string())
    }
    fn spawn(&self, _code_cli: &Path, _args: &[&str]) -> std::io::Result<u32> {
        unimplemented!()
    }
    fn is_alive(&self, _pid: u32) -> bool {
        unimplemented!()
    }
    fn request_graceful_close(&self, _pid: u32) {}
    fn force_kill(&self, _pid: u32) {}
    fn sleep(&self, _d: Duration) {}
}

#[derive(Default)]
struct FakeUninstallRunner {
    remove_dir_calls: RefCell<Vec<std::path::PathBuf>>,
    fail_remove_for: RefCell<Vec<std::path::PathBuf>>,
    uninstaller_result: RefCell<Option<Result<bool, String>>>,
}
impl UninstallRunner for FakeUninstallRunner {
    fn remove_dir_all(&self, path: &Path) -> Result<(), String> {
        self.remove_dir_calls.borrow_mut().push(path.to_path_buf());
        if self.fail_remove_for.borrow().contains(&path.to_path_buf()) {
            return Err("locked".to_string());
        }
        let _ = std::fs::remove_dir_all(path);
        Ok(())
    }
    fn run_vscode_uninstaller(&self, _vscode_dir: &Path) -> Result<bool, String> {
        self.uninstaller_result
            .borrow()
            .clone()
            .unwrap_or(Ok(false))
    }
}

fn write_state(path: &Path, state: &State) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    state.write(path).unwrap();
}

fn write_storage_with_entry(path: &Path, profile_name: &str, location: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        serde_json::json!({
            "userDataProfiles": [{"location": location, "name": profile_name}],
            "someOtherProfile": {"kept": true},
        })
        .to_string(),
    )
    .unwrap();
}

fn default_state() -> State {
    State {
        profile_created_by_us: true,
        vscode_installed_by_us: false,
        profile_location: "blockless".to_string(),
        steps: Steps {
            vscode: true,
            extension: true,
            python: true,
            settings: true,
        },
        ..Default::default()
    }
}

// --- fail-closed matrix ---

#[test]
fn missing_state_json_proceeds_without_aborting() {
    let l = layout("missing-state");
    std::fs::create_dir_all(&l.blk).unwrap(); // BLK exists, empty
    let runner = FakeUninstallRunner::default();
    let outcome = uninstall(
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
    match outcome {
        UninstallOutcome::Finished {
            profile_removed, ..
        } => assert!(!profile_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
#[cfg(unix)]
fn unreadable_state_json_aborts_nothing_removed() {
    use std::os::unix::fs::PermissionsExt;
    let l = layout("unreadable-state");
    std::fs::create_dir_all(l.state_path.parent().unwrap()).unwrap();
    std::fs::write(&l.state_path, b"{}").unwrap();
    std::fs::set_permissions(&l.state_path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    std::fs::set_permissions(&l.state_path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(outcome, UninstallOutcome::AbortedUnreadableState);
    assert!(
        runner.remove_dir_calls.borrow().is_empty(),
        "nothing may be removed on abort"
    );
    assert!(l.blk.exists(), "BLK must survive an aborted uninstall");
}

#[test]
fn state_json_missing_profile_created_by_us_key_aborts() {
    let l = layout("missing-key");
    std::fs::create_dir_all(l.state_path.parent().unwrap()).unwrap();
    // valid JSON, but not the State shape at all -- missing every
    // required field including profileCreatedByUs
    std::fs::write(&l.state_path, serde_json::json!({"foo": "bar"}).to_string()).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    assert_eq!(outcome, UninstallOutcome::AbortedUnreadableState);
    assert!(runner.remove_dir_calls.borrow().is_empty());
}

#[test]
fn suspicious_location_is_never_passed_to_remove_dir_all() {
    let l = layout("suspicious-location");
    // A traversal target that genuinely resolves to something outside
    // profiles_dir on this filesystem (profiles_dir/../../etc -> the
    // layout root's "etc"), not just an unsafe-looking string that
    // happens not to exist -- otherwise a broken allowlist check would
    // pass this test for free (the delete would be a no-op regardless,
    // since nothing exists at the traversal target).
    let root = l.blk.parent().unwrap();
    let outside_sentinel = root.join("etc");
    std::fs::create_dir_all(&outside_sentinel).unwrap();
    // profiles_dir itself must exist on disk too: the OS resolves ".."
    // by walking into "profiles" first, so a non-existent profiles_dir
    // makes `.exists()` false at that component alone -- masking the
    // traversal regardless of what the safety check does.
    std::fs::create_dir_all(&l.profiles_dir).unwrap();

    let mut state = default_state();
    state.profile_location = "../../etc".to_string();
    write_state(&l.state_path, &state);
    write_storage_with_entry(&l.storage_path, "Blockless", "../../etc");
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    assert!(
        outside_sentinel.exists(),
        "a suspicious location must never be deleted, traversal target or not"
    );
    for call in runner.remove_dir_calls.borrow().iter() {
        assert!(
            !call.to_string_lossy().contains(".."),
            "must never attempt to delete a path derived from an unsafe location: {call:?}"
        );
    }
    // the storage entry itself WAS removable (valid JSON), so the
    // invariant guard doesn't trip on that alone -- matches the scripts.
    match outcome {
        UninstallOutcome::Finished {
            invariant_guard_tripped,
            ..
        } => {
            assert!(!invariant_guard_tripped)
        }
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn invariant_guard_trips_and_leaves_journal_and_blk_intact() {
    let l = layout("guard-trips");
    write_state(&l.state_path, &default_state());
    // unparseable storage.json: remove_storage_entry can't touch it, and
    // the post-check can't confirm the entry is gone either
    std::fs::create_dir_all(l.storage_path.parent().unwrap()).unwrap();
    std::fs::write(&l.storage_path, b"{ not valid json").unwrap();
    let sentinel = l.blk.join("sentinel.txt");
    std::fs::write(&sentinel, b"still here").unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished {
            invariant_guard_tripped,
            blk_removed,
            profile_removed,
            ..
        } => {
            assert!(invariant_guard_tripped);
            assert!(!blk_removed);
            assert!(!profile_removed);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(
        l.state_path.exists(),
        "journal must survive a tripped guard"
    );
    assert!(
        sentinel.exists(),
        "BLK must never be touched once the guard trips"
    );
}

// --- VS Code running ---

#[test]
fn vscode_running_touches_nothing() {
    let l = layout("vscode-running");
    write_state(&l.state_path, &default_state());
    write_storage_with_entry(&l.storage_path, "Blockless", "blockless");
    let runner = FakeUninstallRunner::default();
    let running = FakeCommandRunner {
        running: vec![4242],
    };

    let outcome = uninstall(
        &running,
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags::default(),
    );

    assert_eq!(outcome, UninstallOutcome::VscodeRunning);
    assert!(runner.remove_dir_calls.borrow().is_empty());
    assert!(l.state_path.exists());
    assert!(l.blk.exists());
}

#[test]
fn failed_process_check_touches_nothing() {
    let l = layout("process-check-failed");
    write_state(&l.state_path, &default_state());
    write_storage_with_entry(&l.storage_path, "Blockless", "blockless");
    let storage_before = std::fs::read(&l.storage_path).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
        &FailedProcessCheck,
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags::default(),
    );

    assert_eq!(outcome, UninstallOutcome::ProcessCheckFailed);
    assert!(runner.remove_dir_calls.borrow().is_empty());
    assert_eq!(std::fs::read(&l.storage_path).unwrap(), storage_before);
    assert!(l.state_path.exists());
}

// --- ownership gating ---

#[test]
fn profile_not_created_by_us_is_never_touched() {
    let l = layout("not-ours");
    let mut state = default_state();
    state.profile_created_by_us = false;
    write_state(&l.state_path, &state);
    write_storage_with_entry(&l.storage_path, "Blockless", "blockless");
    let before = std::fs::read(&l.storage_path).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished {
            profile_removed, ..
        } => assert!(!profile_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(&l.storage_path).unwrap(),
        before,
        "a profile we didn't create must never be edited"
    );
}

#[test]
fn vscode_installed_by_us_true_removes_it() {
    let l = layout("vscode-installed-true");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn successful_native_uninstaller_must_also_remove_the_directory() {
    let l = layout("native-uninstaller-left-directory");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();
    *runner.uninstaller_result.borrow_mut() = Some(Ok(true));

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished {
            blk_removed,
            vscode_removed,
            ..
        } => {
            assert!(!vscode_removed);
            assert!(!blk_removed);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(l.vscode_dir.exists());
    assert!(l.state_path.exists(), "ownership journal must survive");
}

#[test]
fn removes_every_existing_vscode_location_not_just_the_first() {
    // Mirrors the reviewer's finding: a mac install can plausibly have
    // landed at either /Applications or ~/Applications (`vscode.rs`'s
    // own writability fallback), and a stale/broken `code` CLI candidate
    // must not leave a real install at the OTHER location undetected.
    let l = layout("multi-location");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    let root = l.blk.parent().unwrap();
    let apps = root.join("Applications");
    let home_apps = root.join("HomeApplications");
    std::fs::create_dir_all(&apps).unwrap();
    std::fs::create_dir_all(&home_apps).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        &[apps.clone(), home_apps.clone()],
        &UninstallFlags::default(),
    );

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(!apps.exists(), "the first location must be removed");
    assert!(
        !home_apps.exists(),
        "the second location must ALSO be removed"
    );
}

#[test]
fn a_locked_second_location_reports_vscode_removed_false_not_true() {
    // Honesty check: removing the first location but failing on the
    // second must not report overall success.
    let l = layout("multi-location-partial");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    let root = l.blk.parent().unwrap();
    let apps = root.join("Applications");
    let home_apps = root.join("HomeApplications");
    std::fs::create_dir_all(&apps).unwrap();
    std::fs::create_dir_all(&home_apps).unwrap();
    let runner = FakeUninstallRunner::default();
    runner.fail_remove_for.borrow_mut().push(home_apps.clone());

    let outcome = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        &[apps.clone(), home_apps.clone()],
        &UninstallFlags::default(),
    );

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(!vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(!apps.exists(), "the removable location is still removed");
    assert!(home_apps.exists(), "the locked location must survive");
    assert!(
        l.state_path.exists(),
        "the ownership journal must survive until every VS Code location is removed"
    );
}

#[test]
fn vscode_installed_by_us_false_leaves_it() {
    let l = layout("vscode-installed-false");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = false;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(!vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(l.vscode_dir.exists());
}

// --- flag combinations ---

#[test]
fn keep_vscode_wins_over_installed_by_us_and_all() {
    let l = layout("keep-vscode-wins");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags {
            all: true,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(!vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(l.vscode_dir.exists());
}

#[test]
fn all_flag_forces_removal_even_when_not_installed_by_us() {
    let l = layout("all-flag-forces");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = false;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();

    let outcome = uninstall(
        &not_running(),
        &runner,
        &l.state_path,
        &l.storage_path,
        &l.profiles_dir,
        "Blockless",
        &l.blk,
        std::slice::from_ref(&l.vscode_dir),
        &UninstallFlags {
            all: true,
            keep_vscode: false,
        },
    );

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => assert!(vscode_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
}

// --- BLK removal honesty ---

#[test]
fn blk_partial_removal_is_reported_honestly() {
    let l = layout("blk-partial");
    let mut state = default_state();
    state.profile_created_by_us = false;
    write_state(&l.state_path, &state);
    let runner = FakeUninstallRunner::default();
    runner.fail_remove_for.borrow_mut().push(l.blk.clone());

    let outcome = uninstall(
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

    match outcome {
        UninstallOutcome::Finished {
            blk_removed,
            blk_removal_partial,
            ..
        } => {
            assert!(!blk_removed);
            assert!(blk_removal_partial);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(
        l.blk.exists(),
        "a failed remove_dir_all must leave the directory as evidence, not lie about it"
    );
}
