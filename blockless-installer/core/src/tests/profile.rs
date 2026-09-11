use super::*;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-profile-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct FakeRunner {
    /// The live process list, extended by `spawn()` with
    /// `pids_on_spawn` -- lets a test simulate "spawn()'s own returned
    /// PID is a short-lived wrapper; DIFFERENT PID(s) are what actually
    /// show up in the process list."
    running_pids: RefCell<Vec<u32>>,
    pids_on_spawn: Vec<u32>,
    spawn_result: std::io::Result<u32>,
    graceful_close_calls: RefCell<Vec<u32>>,
    force_kill_calls: RefCell<Vec<u32>>,
    /// Index into `alive_sequence` advanced by each `is_alive` call.
    alive_sequence: RefCell<std::vec::IntoIter<bool>>,
    /// Runs on every injected `sleep()`, letting a test seed
    /// `storage.json` partway through a poll loop (simulating "VS Code,
    /// which we spawned, registered the profile").
    on_sleep: RefCell<Box<dyn FnMut()>>,
}

impl FakeRunner {
    fn new(running_before: Vec<u32>, spawn_result: std::io::Result<u32>) -> FakeRunner {
        FakeRunner {
            running_pids: RefCell::new(running_before),
            pids_on_spawn: Vec::new(),
            spawn_result,
            graceful_close_calls: RefCell::new(Vec::new()),
            force_kill_calls: RefCell::new(Vec::new()),
            alive_sequence: RefCell::new(Vec::new().into_iter()),
            on_sleep: RefCell::new(Box::new(|| {})),
        }
    }

    fn with_alive_sequence(self, seq: Vec<bool>) -> Self {
        *self.alive_sequence.borrow_mut() = seq.into_iter();
        self
    }

    /// The PID(s) that "appear" in `running_vscode_pids()` once
    /// `spawn()` is called -- simulates the real Electron process(es),
    /// distinct from whatever PID `spawn()` itself returns.
    fn with_pids_on_spawn(mut self, pids: Vec<u32>) -> Self {
        self.pids_on_spawn = pids;
        self
    }
}

impl CommandRunner for FakeRunner {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        Ok(self.running_pids.borrow().clone())
    }
    fn spawn(&self, _code_cli: &Path, _args: &[&str]) -> std::io::Result<u32> {
        match &self.spawn_result {
            Ok(pid) => {
                self.running_pids
                    .borrow_mut()
                    .extend(self.pids_on_spawn.iter().copied());
                Ok(*pid)
            }
            Err(e) => Err(std::io::Error::new(e.kind(), e.to_string())),
        }
    }
    fn is_alive(&self, _pid: u32) -> bool {
        self.alive_sequence.borrow_mut().next().unwrap_or(false)
    }
    fn request_graceful_close(&self, pid: u32) {
        self.graceful_close_calls.borrow_mut().push(pid);
    }
    fn force_kill(&self, pid: u32) {
        self.force_kill_calls.borrow_mut().push(pid);
    }
    fn sleep(&self, _d: Duration) {
        (self.on_sleep.borrow_mut())();
    }
}

fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

// --- register_profile_offline: seed into every storage.json shape ---

#[test]
fn seeds_into_missing_storage_json() {
    let dir = temp_dir("missing");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    let runner = FakeRunner::new(vec![], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::Registered);
    let written: Value = serde_json::from_slice(&std::fs::read(&storage).unwrap()).unwrap();
    assert_eq!(
        written["userDataProfiles"][0],
        serde_json::json!({"location": "blockless", "name": "Blockless"})
    );
    assert!(profiles_dir.join("blockless").is_dir());
}

#[test]
fn seeds_into_empty_object_storage_json() {
    let dir = temp_dir("empty");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    write_json(&storage, &serde_json::json!({}));
    let runner = FakeRunner::new(vec![], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::Registered);
    let written: Value = serde_json::from_slice(&std::fs::read(&storage).unwrap()).unwrap();
    assert_eq!(written["userDataProfiles"].as_array().unwrap().len(), 1);
}

#[test]
fn seeds_into_populated_storage_json_preserving_unknown_fields() {
    let dir = temp_dir("populated");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    let before = serde_json::json!({
        "userDataProfiles": [
            {"location": "abc123", "name": "SomeOtherProfile"}
        ],
        "windowsState": {"lastActiveWindow": {"backupPath": "/foo/bar", "deep": {"nested": [1,2,3]}}},
        "backupWorkspaces": {"workspaces": [], "folders": ["/a", "/b"]},
        "telemetry.machineId": "deadbeef"
    });
    write_json(&storage, &before);
    let runner = FakeRunner::new(vec![], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::Registered);
    let after: Value = serde_json::from_slice(&std::fs::read(&storage).unwrap()).unwrap();
    // untouched keys preserved exactly (deep equality, not just presence)
    assert_eq!(after["windowsState"], before["windowsState"]);
    assert_eq!(after["backupWorkspaces"], before["backupWorkspaces"]);
    assert_eq!(after["telemetry.machineId"], before["telemetry.machineId"]);
    assert_eq!(after["userDataProfiles"][0], before["userDataProfiles"][0]);
    // ours appended, not replacing the existing entry
    assert_eq!(after["userDataProfiles"].as_array().unwrap().len(), 2);
    assert_eq!(
        after["userDataProfiles"][1],
        serde_json::json!({"location": "blockless", "name": "Blockless"})
    );
}

#[test]
fn skips_unparseable_storage_json_never_replaces_it() {
    let dir = temp_dir("unparseable");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    std::fs::write(&storage, b"{ not valid json at all").unwrap();
    let original_bytes = std::fs::read(&storage).unwrap();
    let runner = FakeRunner::new(vec![], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::SkippedUnparseableStorage);
    assert_eq!(
        std::fs::read(&storage).unwrap(),
        original_bytes,
        "an unparseable file must never be touched"
    );
}

#[test]
fn skips_when_already_registered() {
    let dir = temp_dir("already");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    write_json(
        &storage,
        &serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]}),
    );
    let before = std::fs::read(&storage).unwrap();
    let runner = FakeRunner::new(vec![], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::AlreadyRegistered);
    assert_eq!(std::fs::read(&storage).unwrap(), before);
}

#[test]
fn skips_when_vscode_is_running() {
    let dir = temp_dir("running");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    let runner = FakeRunner::new(vec![4242], Ok(1));

    let outcome =
        register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless")
            .unwrap();

    assert_eq!(outcome, RegisterOfflineOutcome::SkippedVscodeRunning);
    assert!(
        !storage.exists(),
        "must not create storage.json while VS Code is running"
    );
}

#[test]
fn write_is_atomic_no_tmp_left_behind() {
    let dir = temp_dir("atomic");
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    let runner = FakeRunner::new(vec![], Ok(1));

    register_profile_offline(&runner, &storage, &profiles_dir, "Blockless", "blockless").unwrap();

    assert!(storage.exists());
    assert!(!dir.join("storage.json.tmp").exists());
}

// --- register_profile: window-launch fallback + exact-PID teardown ---

#[test]
fn fallback_polls_until_registered_then_gracefully_closes_the_real_pid_not_the_spawn_return() {
    let dir = temp_dir("fallback-poll");
    let storage = dir.join("storage.json");
    let code_cli = dir.join("code");

    // spawn() returns 4242 (the launcher/wrapper's PID), but 9001 is what
    // actually shows up in the process list once spawned -- teardown
    // must target 9001, never the value spawn() returned.
    let runner = FakeRunner::new(vec![], Ok(4242))
        .with_pids_on_spawn(vec![9001])
        .with_alive_sequence(vec![false]);
    let storage_for_sleep = storage.clone();
    let calls = std::rc::Rc::new(RefCell::new(0u32));
    let calls_for_closure = calls.clone();
    *runner.on_sleep.borrow_mut() = Box::new(move || {
        let mut c = calls_for_closure.borrow_mut();
        *c += 1;
        if *c == 3 {
            write_json(
                &storage_for_sleep,
                &serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]}),
            );
        }
    });

    let outcome = register_profile(&runner, &code_cli, &storage, "Blockless");

    assert_eq!(outcome, RegisterProfileOutcome::Registered);
    assert_eq!(
        *runner.graceful_close_calls.borrow(),
        vec![9001],
        "must tear down the PID that newly appeared in the process list, \
             not the (possibly already-exited wrapper) PID spawn() returned"
    );
    assert!(
        runner.force_kill_calls.borrow().is_empty(),
        "graceful close succeeded (is_alive -> false); force_kill must not run"
    );
}

#[test]
fn fallback_tears_down_every_pid_that_newly_appeared() {
    // VS Code's launch can bring up more than one process matching the
    // running-pids probe (e.g. main + a helper); every one that's new
    // since before spawning must be torn down, not just the first.
    let dir = temp_dir("fallback-multi-pid");
    let storage = dir.join("storage.json");
    let code_cli = dir.join("code");

    let runner = FakeRunner::new(vec![], Ok(4242))
        .with_pids_on_spawn(vec![9001, 9002])
        .with_alive_sequence(vec![false, false]);
    // profile isn't registered yet under that name -- overwrite with the
    // real entry on first sleep so the poll succeeds immediately.
    let storage_for_sleep = storage.clone();
    *runner.on_sleep.borrow_mut() = Box::new(move || {
        write_json(
            &storage_for_sleep,
            &serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]}),
        );
    });

    let outcome = register_profile(&runner, &code_cli, &storage, "Blockless");

    assert_eq!(outcome, RegisterProfileOutcome::Registered);
    let mut closed = runner.graceful_close_calls.borrow().clone();
    closed.sort();
    assert_eq!(closed, vec![9001, 9002]);
}

#[test]
fn attach_to_existing_instance_never_torn_down() {
    let dir = temp_dir("attach-existing");
    let storage = dir.join("storage.json");
    let code_cli = dir.join("code");

    // Something was ALREADY running before we spawned -- the re-probe
    // must see this and register_profile must never attempt teardown,
    // since --new-window may have attached to that existing session.
    let runner = FakeRunner::new(vec![999], Ok(4242));
    let storage_for_sleep = storage.clone();
    *runner.on_sleep.borrow_mut() = Box::new(move || {
        if !storage_for_sleep.exists() {
            write_json(
                &storage_for_sleep,
                &serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]}),
            );
        }
    });

    let outcome = register_profile(&runner, &code_cli, &storage, "Blockless");

    assert_eq!(outcome, RegisterProfileOutcome::Registered);
    assert!(
        runner.graceful_close_calls.borrow().is_empty(),
        "must never close a process when something was already running before spawn"
    );
    assert!(runner.force_kill_calls.borrow().is_empty());
}

#[test]
fn register_profile_already_registered_never_spawns() {
    let dir = temp_dir("already-registered");
    let storage = dir.join("storage.json");
    let code_cli = dir.join("code");
    write_json(
        &storage,
        &serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]}),
    );
    // spawn_result is Err, so if register_profile spawned anyway this
    // test would see SpawnFailed instead of AlreadyRegistered.
    let runner = FakeRunner::new(vec![], Err(std::io::Error::other("must not be called")));

    let outcome = register_profile(&runner, &code_cli, &storage, "Blockless");
    assert_eq!(outcome, RegisterProfileOutcome::AlreadyRegistered);
}

// --- stop_and_wait: graceful-then-force teardown ---

#[test]
fn stop_and_wait_returns_once_graceful_close_takes() {
    let runner = FakeRunner::new(vec![], Ok(1)).with_alive_sequence(vec![true, true, false]);
    stop_and_wait(&runner, 777);
    assert_eq!(*runner.graceful_close_calls.borrow(), vec![777]);
    assert!(runner.force_kill_calls.borrow().is_empty());
}

#[test]
fn stop_and_wait_force_kills_when_graceful_close_never_takes() {
    // `is_alive` stays true for the whole graceful-wait window (60
    // polls), so stop_and_wait must fall back to force_kill.
    let alive_forever = vec![true; 60];
    let runner = FakeRunner::new(vec![], Ok(1)).with_alive_sequence(alive_forever);
    stop_and_wait(&runner, 555);
    assert_eq!(*runner.graceful_close_calls.borrow(), vec![555]);
    assert_eq!(*runner.force_kill_calls.borrow(), vec![555]);
}
