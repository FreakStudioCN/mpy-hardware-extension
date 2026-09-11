use super::*;
use crate::manifest::Manifest;
use crate::uninstall::UninstallFlags;
use crate::uninstall::UninstallOutcome;
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const COMMITTED_MANIFEST: &str = include_str!("../../../manifest/installer.manifest.json");

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-ops-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One fake implementing all five step traits, tuned so a full
/// install/repair run never needs real network: VS Code is already
/// "installed" at `code_candidates[0]`, and mpremote is already at the
/// pinned version unless a test says otherwise -- both skip their
/// download paths entirely, leaving ops.rs's own sequencing/journaling
/// as what's actually under test (the step behaviors themselves are
/// already covered in their own modules).
struct FakeEnvironment {
    code_cli: PathBuf,
    vscode_version: RefCell<Option<String>>,
    vsix_path_str: String,
    ext_id: String,
    installed_extensions: RefCell<HashSet<String>>,
    install_calls: RefCell<Vec<String>>,
    mpremote_version: RefCell<Option<String>>,
    run_uv_calls: RefCell<u32>,
    run_uv_fails: RefCell<bool>,
    remove_dir_calls: RefCell<Vec<PathBuf>>,
    spawn_calls: RefCell<Vec<Vec<String>>>,
    /// Overridable so a test can simulate "VS Code is already running"
    /// (e.g. to force `register_profile_offline` to skip seeding
    /// `storage.json`, leaving `resolve_profile_location` unable to
    /// resolve anything this run).
    running_pids: RefCell<Vec<u32>>,
}

impl FakeEnvironment {
    fn new(code_cli: &Path, vsix_path: &Path) -> FakeEnvironment {
        FakeEnvironment {
            code_cli: code_cli.to_path_buf(),
            vscode_version: RefCell::new(Some("1.99.0".to_string())),
            vsix_path_str: vsix_path.to_string_lossy().into_owned(),
            ext_id: "blockless.mpy-hardware-extension".to_string(),
            installed_extensions: RefCell::new(HashSet::new()),
            install_calls: RefCell::new(Vec::new()),
            mpremote_version: RefCell::new(Some("mpremote 1.28.0".to_string())),
            run_uv_calls: RefCell::new(0),
            run_uv_fails: RefCell::new(false),
            remove_dir_calls: RefCell::new(Vec::new()),
            spawn_calls: RefCell::new(Vec::new()),
            running_pids: RefCell::new(Vec::new()),
        }
    }
}

impl profile::CommandRunner for FakeEnvironment {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        Ok(self.running_pids.borrow().clone())
    }
    fn spawn(&self, _code_cli: &Path, args: &[&str]) -> std::io::Result<u32> {
        self.spawn_calls
            .borrow_mut()
            .push(args.iter().map(|s| s.to_string()).collect());
        Ok(1)
    }
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }
    fn request_graceful_close(&self, _pid: u32) {}
    fn force_kill(&self, _pid: u32) {}
    fn sleep(&self, _d: Duration) {}
}

impl vscode::VscodeInstaller for FakeEnvironment {
    fn version(&self, code_cli: &Path) -> Option<String> {
        if code_cli == self.code_cli {
            self.vscode_version.borrow().clone()
        } else {
            None
        }
    }
    fn is_writable(&self, _dir: &Path) -> bool {
        true
    }
    fn extract_archive(
        &self,
        _archive: &Path,
        _target_dir: &Path,
    ) -> Result<(), vscode::InstallError> {
        Ok(())
    }
    fn strip_quarantine(&self, _app_dir: &Path) {}
    fn run_silent_installer(&self, _installer_exe: &Path) -> Result<(), vscode::InstallError> {
        Ok(())
    }
    fn verify_signature(&self, _artifact: &Path) -> Result<(), vscode::SignatureError> {
        Ok(())
    }
    fn remove_unverified_install(&self, _app_dir: &Path) -> Result<(), vscode::InstallError> {
        Ok(())
    }
}

impl extensions::ExtensionsRunner for FakeEnvironment {
    fn list_extensions(&self, _code_cli: &Path, _profile_name: &str) -> Option<Vec<String>> {
        Some(self.installed_extensions.borrow().iter().cloned().collect())
    }
    fn install_extension(&self, _code_cli: &Path, _profile_name: &str, vsix_or_id: &str) -> bool {
        self.install_calls.borrow_mut().push(vsix_or_id.to_string());
        let id = if vsix_or_id == self.vsix_path_str {
            self.ext_id.clone()
        } else {
            vsix_or_id.to_string()
        };
        self.installed_extensions
            .borrow_mut()
            .insert(id.to_lowercase());
        true
    }
}

impl runtime::RuntimeRunner for FakeEnvironment {
    fn mpremote_version(&self, _envpy: &Path) -> Option<String> {
        self.mpremote_version.borrow().clone()
    }
    fn uv_version(&self, _uv_bin: &Path) -> Option<String> {
        Some("uv 0.11.29".to_string())
    }
    fn extract_uv(&self, _archive: &Path, _dest_dir: &Path) -> Result<(), String> {
        Ok(())
    }
    fn run_uv(&self, _uv_bin: &Path, _args: &[&str], _env: &[(&str, &str)]) -> bool {
        *self.run_uv_calls.borrow_mut() += 1;
        if *self.run_uv_fails.borrow() {
            return false;
        }
        // the third call in the fixed sequence (python install, venv,
        // pip install) is what "lands" mpremote
        if *self.run_uv_calls.borrow() == 3 {
            *self.mpremote_version.borrow_mut() = Some("mpremote 1.28.0".to_string());
        }
        true
    }
    /// Deterministic, never a filesystem probe: these tests assert on the
    /// ops sequence and must not change answer with the machine running
    /// them. `true` means "tools present, do not shim".
    fn developer_tools_present(&self) -> bool {
        true
    }
}

impl UninstallRunner for FakeEnvironment {
    fn remove_dir_all(&self, path: &Path) -> Result<(), String> {
        self.remove_dir_calls.borrow_mut().push(path.to_path_buf());
        let _ = std::fs::remove_dir_all(path);
        Ok(())
    }
    fn run_vscode_uninstaller(&self, _vscode_dir: &Path) -> Result<bool, String> {
        Ok(false)
    }
}

fn test_manifest() -> Manifest {
    Manifest::parse(COMMITTED_MANIFEST).unwrap()
}

fn write_vsix(dir: &Path, contents: &[u8]) -> PathBuf {
    let path = dir.join("mpy-hardware-extension.vsix");
    std::fs::write(&path, contents).unwrap();
    path
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The committed manifest's `extension.sha256` is an all-zero placeholder
/// (the real VSIX's hash is unknown at commit time). Tests that exercise
/// a real install path need a manifest that actually matches their own
/// fixture VSIX, or `ensure_extensions`'s authenticity check (the
/// bundled VSIX's hash must match the manifest's declared value, not
/// just the journaled prior sha) correctly refuses every one of them.
fn test_manifest_matching(vsix_bytes: &[u8]) -> Manifest {
    let mut manifest = test_manifest();
    manifest.components.extension.sha256 = sha256_hex(vsix_bytes);
    manifest
}

fn make_ctx<'a>(dir: &Path, manifest: &'a Manifest, vsix: &Path) -> OpsContext<'a> {
    let code_cli = dir.join("code");
    OpsContext {
        os: Os::MacOs,
        arch: Arch::Arm64,
        paths: Paths {
            blk: dir.join("Blockless"),
            downloads: dir.join("Blockless").join("downloads"),
            logs: dir.join("Blockless").join("logs"),
            state: dir.join("Blockless").join("state.json"),
            code_user: dir.join("CodeUser"),
            storage: dir.join("CodeUser").join("storage.json"),
            env_python: dir.join("Blockless").join("env").join("bin").join("python"),
        },
        manifest,
        client: reqwest::blocking::Client::new(),
        fetch_opts: FetchOptions {
            max_attempts: 1,
            backoff_base: Duration::from_millis(1),
        },
        code_candidates: vec![code_cli],
        mac_install_targets: vec![dir.join("Applications")],
        vsix_path: Some(vsix.to_path_buf()),
    }
}

#[test]
fn install_happy_path_journals_all_four_steps_and_opens_foreground() {
    let dir = temp_dir("install-happy");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    let state = install(&env, &ctx).unwrap();

    assert!(state.steps.all_ok(), "{:?}", state.steps);
    assert_eq!(state.mpremote_version, "1.28.0");
    assert!(
        env.spawn_calls
            .borrow()
            .iter()
            .any(|args| args.contains(&"--new-window".to_string())),
        "install must end with a foreground open"
    );
}

/// A `tracing` writer that captures formatted output into a shared
/// buffer, so a test can assert on log content.
#[derive(Clone, Default)]
struct CapturingWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for CapturingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturingWriter {
    type Writer = CapturingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// The one `tracing` subscriber every log-capturing test in this module
/// shares, installed at most once process-wide.
///
/// `cargo test`'s default parallel runner has many OTHER tests calling
/// `install`/`repair` concurrently on other threads, sharing these same
/// `info!`/`warn!` callsites. A THREAD-LOCAL subscriber
/// (`tracing::subscriber::with_default`) loses this race: a callsite's
/// process-wide interest is cached on first-ever use, and a concurrent
/// thread still running under the no-op default can win that race and
/// cache it "not interested" out from under a test -- empirically,
/// roughly 1 run in 3 under the full suite. A single global default
/// instead makes every callsite's interest resolve once, globally, with
/// no thread-local toggling and thus no window for the race.
///
/// Only the FIRST caller's `try_init` actually succeeds (global default
/// can only be set once per process); every caller gets back a clone of
/// the SAME shared writer regardless of which one won, via `OnceLock`,
/// so which log-capturing test happens to run first doesn't matter --
/// they all observe the one real subscriber. Other, non-capturing
/// parallel tests free-ride on it harmlessly (their lines just add
/// noise a `contains` check ignores).
fn capturing_log_writer() -> CapturingWriter {
    static WRITER: std::sync::OnceLock<CapturingWriter> = std::sync::OnceLock::new();
    WRITER
        .get_or_init(|| {
            let writer = CapturingWriter::default();
            let _ = tracing_subscriber::fmt()
                .with_writer(writer.clone())
                .with_ansi(false)
                .try_init();
            writer
        })
        .clone()
}

#[test]
fn install_logs_every_step() {
    // Proves ops.rs actually emits a log line per step (the reviewer's
    // finding: nothing logged, so diagnostics bundled an empty logs/),
    // not just that the tracing macro calls compile.
    let writer = capturing_log_writer();

    let dir = temp_dir("install-logs");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    let before = writer.0.lock().unwrap().len();
    install(&env, &ctx).unwrap();
    let logged = String::from_utf8(writer.0.lock().unwrap()[before..].to_vec()).unwrap();
    for expected in [
        "install: starting",
        "install: step 1 (vscode) done skipped=true",
        "install: step 2 (extension) done",
        "install: step 3 (runtime) done",
        "install: step 4 (settings) done applied=true",
        "install: finished",
    ] {
        assert!(
            logged.contains(expected),
            "missing {expected:?} in:\n{logged}"
        );
    }
}

#[test]
fn repair_never_touches_runtime() {
    let dir = temp_dir("repair-no-runtime");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // mpremote is NOT present -- if repair touched runtime.rs at all, it
    // would try to provision it (run_uv calls > 0).
    *env.mpremote_version.borrow_mut() = None;

    let state = repair(&env, &ctx).unwrap();

    assert!(state.steps.vscode);
    assert!(state.steps.extension);
    assert!(state.steps.settings);
    assert!(!state.steps.python, "repair must never touch step 3");
    assert_eq!(
        *env.run_uv_calls.borrow(),
        0,
        "repair must never invoke uv at all"
    );
}

#[test]
fn repair_runtime_removes_env_dir_before_reprovisioning() {
    let dir = temp_dir("repair-runtime");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env_dir = ctx.paths.blk.join("env");
    std::fs::create_dir_all(&env_dir).unwrap();
    std::fs::write(env_dir.join("stale-marker"), b"old").unwrap();
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // force a real re-provision: without this, "mpremote already
    // present" would skip before even checking env/ at all.
    *env.mpremote_version.borrow_mut() = None;

    let state = repair_runtime(&env, &ctx).unwrap();

    assert!(state.steps.python);
    assert!(
        env.remove_dir_calls.borrow().contains(&env_dir),
        "must remove env/ deterministically rather than trust uv over a stale venv"
    );
    assert!(*env.run_uv_calls.borrow() > 0, "must actually reprovision");
}

#[test]
fn update_extension_forces_reinstall_bypassing_the_sha_match_skip() {
    let dir = temp_dir("update-ext-force");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let sha = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(std::fs::read(&vsix).unwrap());
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // fully current already: matching sha journaled, all three
    // extensions present -- a non-forced call would skip entirely.
    env.installed_extensions
        .borrow_mut()
        .insert("blockless.mpy-hardware-extension".to_string());
    env.installed_extensions
        .borrow_mut()
        .insert("ms-python.python".to_string());
    env.installed_extensions
        .borrow_mut()
        .insert("ms-python.vscode-pylance".to_string());
    let prior = State {
        ext_vsix_sha256: sha.clone(),
        ..Default::default()
    };
    prior.write(&ctx.paths.state).unwrap();

    let state = update_extension(&env, &ctx).unwrap();

    assert!(
        env.install_calls
            .borrow()
            .iter()
            .any(|c| c == &vsix.to_string_lossy()),
        "force must reinstall even though the sha already matched"
    );
    assert_eq!(state.ext_vsix_sha256, sha);
}

#[test]
fn install_resets_stale_steps_so_an_aborted_run_never_journals_a_step_it_never_reverified() {
    // A prior COMPLETE install left every step true. If this run then
    // dies during step 3 (runtime), the incremental writes from steps 1
    // and 2 (persisted before step 3 is even attempted) must not carry
    // the stale `steps.python: true` forward -- otherwise `verify`'s
    // check 5 would pass against a runtime this run never actually
    // re-confirmed.
    let dir = temp_dir("install-resets-steps");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    std::fs::create_dir_all(&ctx.paths.blk).unwrap();
    let prior = State {
        steps: crate::state::Steps {
            vscode: true,
            extension: true,
            python: true,
            settings: true,
        },
        ..Default::default()
    };
    prior.write(&ctx.paths.state).unwrap();
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // force step 3 to fail so the run dies before its own
    // `current.steps.python = true` write -- only the STALE prior value
    // could end up on disk at that point if the reset didn't happen.
    *env.mpremote_version.borrow_mut() = None;
    *env.run_uv_fails.borrow_mut() = true;

    let writer = capturing_log_writer();
    let before = writer.0.lock().unwrap().len();
    let result = install(&env, &ctx);
    let logged = String::from_utf8(writer.0.lock().unwrap()[before..].to_vec()).unwrap();
    assert!(
        logged.contains("install: step 3 (runtime) failed"),
        "the failure warn! line, with its error field, must reach the \
             logs a real run's diagnostics bundle would export; got:\n{logged}"
    );

    assert!(result.is_err(), "test setup: step 3 must actually fail");
    let persisted = State::read(&ctx.paths.state).unwrap().unwrap();
    assert!(
        persisted.steps.vscode && persisted.steps.extension,
        "steps this run genuinely completed must still be journaled true"
    );
    assert!(
        !persisted.steps.python,
        "steps.python must not carry forward stale from the prior \
             journal when this run never got to re-verify it"
    );
}

#[test]
fn install_against_the_unmodified_committed_manifest_refuses_the_real_vsix() {
    // The committed manifest's `extension.sha256` is a deliberate
    // all-zero placeholder (the real VSIX's hash is unknown at commit
    // time; the real value is stamped in outside this repo, before a
    // real rig run, by
    // `mpy-hardware-extension/scripts/stamp-installer-manifest.mjs`).
    // This is a WIRING test, not a placeholder canary by itself: it
    // proves `ops.rs` actually passes
    // `manifest.components.extension.sha256` through to
    // `ensure_extensions` end to end (a fixture vsix, `b"vsix
    // contents"`, would refuse against ANY manifest sha it doesn't
    // equal -- placeholder or a real one that just doesn't match this
    // fixture). `manifest::tests::committed_manifest_sha256_pins_are_the_documented_values`
    // is the actual canary that fails the moment the pin gets stamped
    // without a matching test update.
    let dir = temp_dir("unmodified-manifest-refuses-real-vsix");
    let manifest = test_manifest(); // NOT test_manifest_matching -- the real, unmodified file
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    let err = install(&env, &ctx).unwrap_err();

    assert!(
        matches!(
            err,
            OpsError::Extensions(ExtensionsError::VsixShaMismatch { .. })
        ),
        "expected VsixShaMismatch against the placeholder sha, got {err:?}"
    );
}

#[test]
fn install_refuses_a_missing_vsix_before_any_step_runs() {
    let dir = temp_dir("missing-vsix-upfront");
    let manifest = test_manifest_matching(b"vsix contents");
    let missing = dir.join("does-not-exist.vsix");
    let ctx = make_ctx(&dir, &manifest, &missing);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &missing);

    let err = install(&env, &ctx).unwrap_err();

    assert!(matches!(err, OpsError::MissingVsix(p) if p == missing));
    assert!(
        env.spawn_calls.borrow().is_empty(),
        "must never spawn/register a profile when the vsix is missing"
    );
    assert!(
        !ctx.paths.state.exists(),
        "must never journal any step (not even step 1) before the vsix check"
    );
}

#[test]
fn repair_and_update_extension_also_refuse_a_missing_vsix_upfront() {
    let dir = temp_dir("missing-vsix-upfront-others");
    let manifest = test_manifest_matching(b"vsix contents");
    let missing = dir.join("does-not-exist.vsix");
    let ctx = make_ctx(&dir, &manifest, &missing);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &missing);

    assert!(matches!(
        repair(&env, &ctx).unwrap_err(),
        OpsError::MissingVsix(p) if p == missing
    ));
    assert!(matches!(
        update_extension(&env, &ctx).unwrap_err(),
        OpsError::MissingVsix(p) if p == missing
    ));
}

type OpFn = fn(&dyn Environment, &OpsContext) -> Result<State, OpsError>;

/// `repair` and `install` both re-derive `vscode_installed_by_us` and
/// `profile_location` with the byte-identical carry-forward expressions
/// (`ops.rs`'s repair/install bodies are intentionally parallel) -- a
/// round-2 review proved by mutation that testing only `repair` left
/// `install`'s copy of each expression uncovered (both mutations shipped
/// silently under the full suite). Every invariant test below runs
/// against both ops, not just one.
const CARRY_FORWARD_OPS: [(&str, OpFn); 2] = [("repair", repair), ("install", install)];

#[test]
fn vscode_installed_by_us_stays_sticky_true_across_a_skip_run() {
    // Mutation-tested against the reviewer's own finding: replacing
    // `seed.vscode_installed_by_us || vscode_outcome.installed_by_us`
    // with just `vscode_outcome.installed_by_us` left every existing
    // test green, because none of them seeded a prior journal with the
    // flag already true. This run's own step 1 detects VS Code already
    // present (a skip -- `installed_by_us` is false for THIS run), so
    // only the sticky carry-forward from the prior journal can be what
    // keeps the flag true.
    for (op_name, op) in CARRY_FORWARD_OPS {
        let dir = temp_dir(&format!("vscode-sticky-{op_name}"));
        let manifest = test_manifest_matching(b"vsix contents");
        let vsix = write_vsix(&dir, b"vsix contents");
        let ctx = make_ctx(&dir, &manifest, &vsix);
        std::fs::create_dir_all(&ctx.paths.blk).unwrap();
        let prior = State {
            vscode_installed_by_us: true,
            ..Default::default()
        };
        prior.write(&ctx.paths.state).unwrap();
        let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

        let state = op(&env, &ctx).unwrap();

        assert!(
            state.vscode_installed_by_us,
            "{op_name}: a prior true must survive a run whose own step 1 was a skip"
        );
    }
}

#[test]
fn profile_location_survives_step_2_when_storage_json_never_resolves() {
    // Mutation-tested against the reviewer's own finding: replacing the
    // guarded `if let Some(loc) = resolve_profile_location(..) { current
    // .profile_location = loc }` (right after step 2) with an
    // unconditional `.unwrap_or_default()` (blanking a known-good id
    // whenever resolution fails) left every existing test green too,
    // because none of them exercised a run where step 2 completes
    // without ever producing a resolvable storage.json entry.
    //
    // Simulated by reporting VS Code as already running: extensions.rs's
    // `register_profile_offline` then skips seeding storage.json, and
    // since this fake's extension installs always succeed, the
    // window-registration fallback (which would otherwise create the
    // entry) never triggers either -- so storage.json stays entryless
    // through the point ops.rs's step-2 carry-forward check runs.
    //
    // The run as a whole still fails (settings.rs's OWN fallback also
    // can't resolve a profile against a fake that never actually writes
    // storage.json), so this asserts against the state.json PERSISTED
    // right after step 2 -- exactly the incremental write the carry-
    // forward check protects -- rather than repair()'s return value.
    for (op_name, op) in CARRY_FORWARD_OPS {
        let dir = temp_dir(&format!("profile-location-survives-{op_name}"));
        let manifest = test_manifest_matching(b"vsix contents");
        let vsix = write_vsix(&dir, b"vsix contents");
        let ctx = make_ctx(&dir, &manifest, &vsix);
        std::fs::create_dir_all(&ctx.paths.blk).unwrap();
        let prior = State {
            profile_location: "a1b2c3d4e5f6".to_string(),
            ..Default::default()
        };
        prior.write(&ctx.paths.state).unwrap();
        let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
        *env.running_pids.borrow_mut() = vec![4242];

        let result = op(&env, &ctx);

        assert!(
            result.is_err(),
            "{op_name}: expected settings.rs to also fail to resolve a profile \
                 against a fake that never writes storage.json (test setup check)"
        );
        assert!(
            !ctx.paths.storage.exists(),
            "{op_name}: storage.json must never have been written before step 2's \
                 incremental write (test setup check)"
        );
        let persisted = State::read(&ctx.paths.state).unwrap().unwrap();
        assert_eq!(
            persisted.profile_location, "a1b2c3d4e5f6",
            "{op_name}: a known-good prior location must survive step 2's incremental \
                 write when step 2 never resolved a fresh one"
        );
    }
}

#[test]
fn ext_vsix_sha256_survives_step_1_when_step_2_never_completes() {
    // The third carry-forward invariant `scope.md`'s review focus names
    // alongside `vscodeInstalledByUs`/`profileLocation`
    // (`extVsixSha256`) had zero ops-level coverage: `current =
    // prior.unwrap_or_default()` carries it through every incremental
    // write until step 2 explicitly overwrites it, but nothing asserted
    // that a run whose step 2 never REACHES that overwrite still leaves
    // the prior value on disk after step 1's write. Forced here by
    // using the real (unmodified, placeholder-sha) committed manifest
    // against a fixture vsix that can never match it: `ensure_extensions`
    // refuses with `VsixShaMismatch` before touching
    // `ext_vsix_sha256` at all, so step 1's persisted state is the last
    // word.
    for (op_name, op) in CARRY_FORWARD_OPS {
        let dir = temp_dir(&format!("ext-sha-survives-step1-{op_name}"));
        let manifest = test_manifest(); // NOT test_manifest_matching -- placeholder sha
        let vsix = write_vsix(&dir, b"vsix contents");
        let ctx = make_ctx(&dir, &manifest, &vsix);
        std::fs::create_dir_all(&ctx.paths.blk).unwrap();
        let prior = State {
            ext_vsix_sha256: "deadbeef".to_string(),
            ..Default::default()
        };
        prior.write(&ctx.paths.state).unwrap();
        let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

        let err = op(&env, &ctx).unwrap_err();

        assert!(
            matches!(
                err,
                OpsError::Extensions(ExtensionsError::VsixShaMismatch { .. })
            ),
            "{op_name}: expected step 2 to refuse before touching ext_vsix_sha256 \
                 (test setup check), got {err:?}"
        );
        let persisted = State::read(&ctx.paths.state).unwrap().unwrap();
        assert_eq!(
            persisted.ext_vsix_sha256, "deadbeef",
            "{op_name}: a known-good prior sha must survive step 1's incremental \
                 write when step 2 never reached its own overwrite"
        );
    }
}

#[test]
fn verify_op_runs_all_seven_checks() {
    let dir = temp_dir("verify-op");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    let results = verify(&env, &ctx);

    assert_eq!(results.len(), 7);
}

#[test]
fn uninstall_op_routes_through_the_real_uninstaller() {
    let dir = temp_dir("uninstall-op");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // no state.json at all -> the fail-closed "missing" path (proceeds,
    // nothing to attribute), proving this op actually calls through to
    // uninstall::uninstall rather than reimplementing anything.
    let outcome = uninstall(&env, &ctx, &UninstallFlags::default());
    match outcome {
        UninstallOutcome::Finished {
            profile_removed, ..
        } => assert!(!profile_removed),
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn windows_uninstall_locations_include_a_candidate_that_fails_version() {
    // Mirrors the reviewer's finding: `vscode_install_locations` must not
    // filter Windows candidates through `env.version(c).is_some()` --
    // that only finds a RUNNABLE `code.cmd`, so a corrupt or
    // half-deleted install (candidate path exists, `--version` no longer
    // works) would be silently skipped, the same class already fixed for
    // mac.
    let dir = temp_dir("windows-locations");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let mut ctx = make_ctx(&dir, &manifest, &vsix);
    ctx.os = Os::Windows;
    let code_cli = dir
        .join("LOCALAPPDATA")
        .join("Programs")
        .join("Microsoft VS Code")
        .join("bin")
        .join("code.cmd");
    ctx.code_candidates = vec![code_cli];
    ctx.mac_install_targets = vec![];

    let locations = vscode_install_locations(&ctx);

    assert_eq!(
        locations,
        vec![dir
            .join("LOCALAPPDATA")
            .join("Programs")
            .join("Microsoft VS Code")],
        "the Windows candidate must be included even though no \
             Environment was consulted about its runnability"
    );
}

#[path = "ops/diagnostics.rs"]
mod diagnostics;
#[path = "ops/uninstall.rs"]
mod uninstall_tests;
