use super::*;
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

const EXT_ID: &str = "blockless.mpy-hardware-extension";
const PY_EXT_ID: &str = "ms-python.python";
const PYLANCE_ID: &str = "ms-python.vscode-pylance";

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-extensions-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_vsix(dir: &Path, contents: &[u8]) -> PathBuf {
    let path = dir.join("mpy-hardware-extension.vsix");
    std::fs::write(&path, contents).unwrap();
    path
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
    fn sleep(&self, _d: std::time::Duration) {}
}

struct FakeExtensionsRunner {
    vsix_path_str: String,
    ext_id: String,
    installed: RefCell<HashSet<String>>,
    install_calls: RefCell<Vec<String>>,
    fail_install_for: RefCell<HashSet<String>>,
    /// Reports success WITHOUT actually landing the extension --
    /// exercises the defensive final all-three-present check, which is
    /// otherwise unreachable through this fake (install success and
    /// "now installed" are normally the same event).
    lie_about_success_for: RefCell<HashSet<String>>,
    list_extensions_fails: RefCell<bool>,
}

impl FakeExtensionsRunner {
    fn new(vsix_path: &Path) -> FakeExtensionsRunner {
        FakeExtensionsRunner {
            vsix_path_str: vsix_path.to_string_lossy().into_owned(),
            ext_id: EXT_ID.to_string(),
            installed: RefCell::new(HashSet::new()),
            install_calls: RefCell::new(Vec::new()),
            fail_install_for: RefCell::new(HashSet::new()),
            lie_about_success_for: RefCell::new(HashSet::new()),
            list_extensions_fails: RefCell::new(false),
        }
    }

    fn seed_installed(&self, id: &str) {
        self.installed.borrow_mut().insert(id.to_lowercase());
    }
}

impl ExtensionsRunner for FakeExtensionsRunner {
    fn list_extensions(&self, _code_cli: &Path, _profile_name: &str) -> Option<Vec<String>> {
        if *self.list_extensions_fails.borrow() {
            return None;
        }
        Some(self.installed.borrow().iter().cloned().collect())
    }
    fn install_extension(&self, _code_cli: &Path, _profile_name: &str, vsix_or_id: &str) -> bool {
        self.install_calls.borrow_mut().push(vsix_or_id.to_string());
        if self.fail_install_for.borrow().contains(vsix_or_id) {
            return false;
        }
        if self.lie_about_success_for.borrow().contains(vsix_or_id) {
            return true;
        }
        let id = if vsix_or_id == self.vsix_path_str {
            self.ext_id.clone()
        } else {
            vsix_or_id.to_string()
        };
        self.installed.borrow_mut().insert(id.to_lowercase());
        true
    }
}

fn code_cli() -> PathBuf {
    PathBuf::from("/fake/code")
}

#[allow(clippy::too_many_arguments)]
fn run(
    dir: &Path,
    ext_runner: &FakeExtensionsRunner,
    vsix_path: Option<&Path>,
    prior_sha: &str,
    seed_profile_created_by_us: bool,
) -> Result<ExtensionsStepOutcome, ExtensionsError> {
    run_with_force(
        dir,
        ext_runner,
        vsix_path,
        prior_sha,
        seed_profile_created_by_us,
        false,
    )
}

/// `expected_vsix_sha256` self-matches the given `vsix_path`'s own real
/// hash (the manifest, in real use, would declare exactly the file we
/// bundle) -- so every existing test here, none of which exercise the
/// manifest-authenticity check, keeps passing unmodified.
/// [`run_with_expected_sha`] is the one that overrides it.
#[allow(clippy::too_many_arguments)]
fn run_with_force(
    dir: &Path,
    ext_runner: &FakeExtensionsRunner,
    vsix_path: Option<&Path>,
    prior_sha: &str,
    seed_profile_created_by_us: bool,
    force: bool,
) -> Result<ExtensionsStepOutcome, ExtensionsError> {
    let expected_sha = vsix_path
        .map(|p| sha256_of_file(p).unwrap_or_default())
        .unwrap_or_default();
    run_with_expected_sha(
        dir,
        ext_runner,
        vsix_path,
        &expected_sha,
        prior_sha,
        seed_profile_created_by_us,
        force,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_with_expected_sha(
    dir: &Path,
    ext_runner: &FakeExtensionsRunner,
    vsix_path: Option<&Path>,
    expected_sha: &str,
    prior_sha: &str,
    seed_profile_created_by_us: bool,
    force: bool,
) -> Result<ExtensionsStepOutcome, ExtensionsError> {
    let storage = dir.join("storage.json");
    let profiles_dir = dir.join("profiles");
    ensure_extensions(
        &NoopCommandRunner,
        ext_runner,
        &code_cli(),
        &storage,
        &profiles_dir,
        "Blockless",
        "blockless",
        EXT_ID,
        PY_EXT_ID,
        PYLANCE_ID,
        vsix_path,
        expected_sha,
        prior_sha,
        seed_profile_created_by_us,
        force,
    )
}

#[test]
fn currency_requires_sha_match_not_just_presence() {
    let dir = temp_dir("sha-currency");
    let vsix = write_vsix(&dir, b"vsix v2 contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    // present, but journaled from a DIFFERENT (older) build
    runner.seed_installed(EXT_ID);
    runner.seed_installed(PY_EXT_ID);
    runner.seed_installed(PYLANCE_ID);

    let sha_of_v2 = sha256_of_file(&vsix).unwrap();
    let outcome = run(&dir, &runner, Some(&vsix), "sha-of-an-older-build", false).unwrap();

    // must NOT have skipped: install_extension was called for the ext id
    assert!(
        runner
            .install_calls
            .borrow()
            .iter()
            .any(|c| c == &vsix.to_string_lossy()),
        "a stale sha must trigger a real reinstall, not a skip"
    );
    assert_eq!(outcome.ext_vsix_sha256, sha_of_v2);
}

#[test]
fn matching_sha_and_all_three_present_skips_entirely() {
    let dir = temp_dir("skip");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner.seed_installed(EXT_ID);
    runner.seed_installed(PY_EXT_ID);
    runner.seed_installed(PYLANCE_ID);
    let sha = sha256_of_file(&vsix).unwrap();

    let outcome = run(&dir, &runner, Some(&vsix), &sha, false).unwrap();

    assert!(
        runner.install_calls.borrow().is_empty(),
        "a fully current profile must skip without any install call"
    );
    assert_eq!(outcome.ext_vsix_sha256, sha);
}

#[test]
fn force_bypasses_the_currency_skip_even_when_fully_current() {
    let dir = temp_dir("force-bypass");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner.seed_installed(EXT_ID);
    runner.seed_installed(PY_EXT_ID);
    runner.seed_installed(PYLANCE_ID);
    let sha = sha256_of_file(&vsix).unwrap();

    let outcome = run_with_force(&dir, &runner, Some(&vsix), &sha, false, true).unwrap();

    assert!(
        runner
            .install_calls
            .borrow()
            .iter()
            .any(|c| c == &vsix.to_string_lossy()),
        "force=true must reinstall our extension even though the sha already matched"
    );
    assert_eq!(outcome.ext_vsix_sha256, sha);
}

#[test]
fn three_id_requirement_pylance_missing_is_not_current() {
    let dir = temp_dir("three-id");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner.seed_installed(EXT_ID);
    runner.seed_installed(PY_EXT_ID);
    // pylance NOT seeded
    let sha = sha256_of_file(&vsix).unwrap();

    let outcome = run(&dir, &runner, Some(&vsix), &sha, false).unwrap();

    assert!(
        runner
            .install_calls
            .borrow()
            .iter()
            .any(|c| c == PYLANCE_ID),
        "pylance missing alone must break currency and trigger its install"
    );
    assert_eq!(outcome.ext_vsix_sha256, sha);
}

#[test]
fn pylance_repair_path_installs_only_pylance_explicitly() {
    let dir = temp_dir("pylance-repair");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner.seed_installed(EXT_ID);
    runner.seed_installed(PY_EXT_ID);
    let sha = sha256_of_file(&vsix).unwrap();

    run(&dir, &runner, Some(&vsix), &sha, false).unwrap();

    // pylance ends up present, via an explicit install call naming it
    assert!(runner
        .installed
        .borrow()
        .contains(&PYLANCE_ID.to_lowercase()));
    assert!(runner
        .install_calls
        .borrow()
        .iter()
        .any(|c| c == PYLANCE_ID));
}

#[test]
fn ours_never_from_marketplace_always_uses_the_vsix_path() {
    let dir = temp_dir("never-marketplace");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    // nothing installed yet: forces the full install path

    run(&dir, &runner, Some(&vsix), "", false).unwrap();

    let calls = runner.install_calls.borrow();
    assert!(
        calls.iter().any(|c| c == &vsix.to_string_lossy()),
        "our extension must be installed from the vsix PATH"
    );
    assert!(
            !calls.iter().any(|c| c == EXT_ID),
            "our extension id must never be passed to install_extension directly (that would be a Marketplace install)"
        );
}

#[test]
fn vsix_sha_mismatch_against_manifest_refuses_loudly_before_any_install_call() {
    let dir = temp_dir("vsix-sha-mismatch");
    // A tampered/corrupted vsix: its real bytes don't match what the
    // manifest declares, even though nothing about the journaled prior
    // sha (empty here -- a fresh install) would have caught it.
    let vsix = write_vsix(&dir, b"a tampered vsix, not what we shipped");
    let runner = FakeExtensionsRunner::new(&vsix);

    let err = run_with_expected_sha(
        &dir,
        &runner,
        Some(&vsix),
        &"0".repeat(64), // manifest expects an entirely different sha
        "",
        false,
        false,
    )
    .unwrap_err();

    match err {
        ExtensionsError::VsixShaMismatch {
            path,
            expected,
            actual,
        } => {
            assert_eq!(path, vsix);
            assert_eq!(expected, "0".repeat(64));
            assert_ne!(actual, "0".repeat(64));
        }
        other => panic!("expected VsixShaMismatch, got {other:?}"),
    }
    assert!(
        runner.install_calls.borrow().is_empty(),
        "a tampered vsix must never be handed to install_extension"
    );
}

#[test]
fn missing_vsix_refuses_loudly() {
    let dir = temp_dir("missing-vsix");
    let missing = dir.join("does-not-exist.vsix");
    let runner = FakeExtensionsRunner::new(&missing);

    let err = run(&dir, &runner, Some(&missing), "", false).unwrap_err();

    assert!(matches!(err, ExtensionsError::MissingBundledVsix(id) if id == EXT_ID));
    assert!(
        runner.install_calls.borrow().is_empty(),
        "must never call install_extension when the bundled vsix is missing"
    );
}

#[test]
fn missing_vsix_refuses_even_with_no_vsix_path_at_all() {
    let dir = temp_dir("no-vsix-arg");
    let runner = FakeExtensionsRunner::new(Path::new("/unused"));

    let err = run(&dir, &runner, None, "", false).unwrap_err();

    assert!(matches!(err, ExtensionsError::MissingBundledVsix(id) if id == EXT_ID));
}

#[test]
fn profile_created_by_us_recorded_pre_seed_when_not_yet_registered() {
    let dir = temp_dir("created-by-us-fresh");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    // storage.json does not exist -> profile is not registered yet

    let outcome = run(&dir, &runner, Some(&vsix), "", false).unwrap();

    assert!(
        outcome.profile_created_by_us,
        "we are the ones about to create this profile"
    );
}

#[test]
fn profile_created_by_us_false_when_adopting_an_existing_profile() {
    let dir = temp_dir("created-by-us-adopt");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    let storage = dir.join("storage.json");
    std::fs::write(
        &storage,
        serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]})
            .to_string(),
    )
    .unwrap();
    // extensions still need installing, but the PROFILE itself already
    // existed before we touched anything -- never claim it as ours.
    let sha = sha256_of_file(&vsix).unwrap();

    let outcome = run(&dir, &runner, Some(&vsix), &sha, false).unwrap();

    assert!(
        !outcome.profile_created_by_us,
        "must not claim ownership of a profile that already existed"
    );
}

#[test]
fn seed_true_stays_sticky_even_if_profile_already_registered() {
    let dir = temp_dir("created-by-us-sticky");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    let storage = dir.join("storage.json");
    std::fs::write(
        &storage,
        serde_json::json!({"userDataProfiles": [{"location": "blockless", "name": "Blockless"}]})
            .to_string(),
    )
    .unwrap();
    let sha = sha256_of_file(&vsix).unwrap();

    // seeded true from a PRIOR run (we created it before); a repair run
    // must not lose that fact just because the profile is now present.
    let outcome = run(&dir, &runner, Some(&vsix), &sha, true).unwrap();

    assert!(outcome.profile_created_by_us);
}

#[test]
fn window_fallback_retries_after_a_failed_first_attempt() {
    let dir = temp_dir("window-fallback");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    // the FIRST install_extension call (for our vsix) fails, forcing the
    // window-registration fallback + retry.
    runner
        .fail_install_for
        .borrow_mut()
        .insert(vsix.to_string_lossy().into_owned());

    // remove the failure after the first attempt is recorded, so the
    // retry succeeds -- simulated by clearing it once we see one call.
    // Simpler: just let it succeed on retry by not failing at all past
    // the first observed call count.
    let outcome = run(&dir, &runner, Some(&vsix), "", false);

    // With the failure permanently configured, the retry ALSO fails, so
    // this should surface as an InstallFailed -- proving the fallback
    // path really did retry (not silently swallow the first failure).
    assert!(matches!(outcome, Err(ExtensionsError::InstallFailed(id)) if id == EXT_ID));
    let calls = runner.install_calls.borrow();
    assert!(
        calls
            .iter()
            .filter(|c| **c == vsix.to_string_lossy())
            .count()
            >= 2,
        "expected at least 2 attempts (initial + fallback retry), got {calls:?}"
    );
}

#[test]
fn case_insensitive_extension_compare() {
    let dir = temp_dir("case-insensitive");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner.seed_installed("Blockless.MPY-Hardware-Extension");
    runner.seed_installed("MS-Python.Python");
    runner.seed_installed("MS-Python.Vscode-Pylance");
    let sha = sha256_of_file(&vsix).unwrap();

    let outcome = run(&dir, &runner, Some(&vsix), &sha, false).unwrap();

    assert!(
        runner.install_calls.borrow().is_empty(),
        "differently-cased ids must still count as present"
    );
    assert_eq!(outcome.ext_vsix_sha256, sha);
}

#[test]
fn install_failure_surfaces_the_failing_id() {
    let dir = temp_dir("install-failure");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    runner
        .fail_install_for
        .borrow_mut()
        .insert(PYLANCE_ID.to_string());

    let err = run(&dir, &runner, Some(&vsix), "", false).unwrap_err();

    assert!(matches!(err, ExtensionsError::InstallFailed(id) if id == PYLANCE_ID));
}

#[test]
fn missing_after_install_fails_loudly_even_when_the_cli_reported_success() {
    let dir = temp_dir("missing-after-install");
    let vsix = write_vsix(&dir, b"vsix contents");
    let runner = FakeExtensionsRunner::new(&vsix);
    // pylance's install call reports success, but never actually lands
    // (a defensive belt-and-braces scenario: don't just trust the exit
    // code, re-check presence before declaring the step done).
    runner
        .lie_about_success_for
        .borrow_mut()
        .insert(PYLANCE_ID.to_string());

    let err = run(&dir, &runner, Some(&vsix), "", false).unwrap_err();

    assert!(matches!(err, ExtensionsError::MissingAfterInstall));
}
