use super::*;
use crate::manifest::Manifest;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-runtime-test-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn manifest_uv() -> UvComponent {
    const MANIFEST: &str = include_str!("../../../manifest/installer.manifest.json");
    Manifest::parse(MANIFEST).unwrap().components.uv
}

fn fast_opts() -> FetchOptions {
    FetchOptions {
        max_attempts: 1,
        backoff_base: Duration::from_millis(1),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordedCall {
    uv_bin: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

struct FakeRuntimeRunner {
    mpremote_version_result: RefCell<Option<String>>,
    uv_version_result: RefCell<Option<String>>,
    extract_uv_result: RefCell<Result<(), String>>,
    run_uv_result: RefCell<bool>,
    calls: RefCell<Vec<RecordedCall>>,
    /// After a successful `python install` + `venv` + `pip install`
    /// sequence, flips `mpremote_version_result` to this (simulating a
    /// real provision landing).
    version_after_provision: RefCell<Option<String>>,
    /// Deterministic on purpose. The first version of the shim probed the
    /// real filesystem, so this answer came from whatever machine ran the
    /// test: it passed on a Mac with the developer tools and failed on the
    /// Windows runner without them. Defaults to `true`, meaning "tools
    /// present, do not shim", so every existing test keeps asserting the
    /// exact uv env it always did.
    developer_tools: RefCell<bool>,
}

impl FakeRuntimeRunner {
    fn new() -> FakeRuntimeRunner {
        FakeRuntimeRunner {
            mpremote_version_result: RefCell::new(None),
            uv_version_result: RefCell::new(None),
            extract_uv_result: RefCell::new(Ok(())),
            run_uv_result: RefCell::new(true),
            calls: RefCell::new(Vec::new()),
            version_after_provision: RefCell::new(None),
            developer_tools: RefCell::new(true),
        }
    }
}

impl RuntimeRunner for FakeRuntimeRunner {
    fn mpremote_version(&self, _envpy: &Path) -> Option<String> {
        self.mpremote_version_result.borrow().clone()
    }
    fn uv_version(&self, _uv_bin: &Path) -> Option<String> {
        self.uv_version_result.borrow().clone()
    }
    fn developer_tools_present(&self) -> bool {
        *self.developer_tools.borrow()
    }
    fn extract_uv(&self, _archive: &Path, _dest_dir: &Path) -> Result<(), String> {
        let r = self.extract_uv_result.borrow().clone();
        if r.is_ok() {
            *self.uv_version_result.borrow_mut() = Some("0.11.29".to_string());
        }
        r
    }
    fn run_uv(&self, uv_bin: &Path, args: &[&str], env: &[(&str, &str)]) -> bool {
        self.calls.borrow_mut().push(RecordedCall {
            uv_bin: uv_bin.to_path_buf(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        });
        let ok = *self.run_uv_result.borrow();
        if ok && self.calls.borrow().len() == 3 {
            // the third call is always pip install mpremote in this
            // step's fixed sequence
            if let Some(v) = self.version_after_provision.borrow().clone() {
                *self.mpremote_version_result.borrow_mut() = Some(v);
            }
        }
        ok
    }
}

fn mac_blk() -> PathBuf {
    PathBuf::from("/Users/erson/Library/Application Support/Blockless")
}
fn mac_envpy(blk: &Path) -> PathBuf {
    blk.join("env").join("bin").join("python")
}
fn win_blk() -> PathBuf {
    PathBuf::from(r"C:\Users\erson\AppData\Local\Blockless")
}
fn win_envpy(blk: &Path) -> PathBuf {
    blk.join("env").join("Scripts").join("python.exe")
}

#[test]
fn detect_skip_when_pinned_mpremote_already_present() {
    let runner = FakeRuntimeRunner::new();
    *runner.mpremote_version_result.borrow_mut() = Some("mpremote 1.28.0".to_string());
    let client = reqwest::blocking::Client::new();
    let blk = mac_blk();
    let envpy = mac_envpy(&blk);
    let dir = temp_dir("detect-skip");

    let outcome = ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();

    assert_eq!(outcome, RuntimeStepOutcome::AlreadyPresent);
    assert!(
        runner.calls.borrow().is_empty(),
        "skip must never invoke uv"
    );
}

#[test]
fn wrong_mpremote_version_does_not_skip() {
    let runner = FakeRuntimeRunner::new();
    *runner.mpremote_version_result.borrow_mut() = Some("mpremote 1.20.0".to_string());
    *runner.uv_version_result.borrow_mut() = Some("uv 0.11.29".to_string());
    *runner.version_after_provision.borrow_mut() = Some("mpremote 1.28.0".to_string());
    let client = reqwest::blocking::Client::new();
    let blk = mac_blk();
    let envpy = mac_envpy(&blk);
    let dir = temp_dir("wrong-version");

    let outcome = ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();

    assert_eq!(outcome, RuntimeStepOutcome::Provisioned);
    assert_eq!(
        runner.calls.borrow().len(),
        3,
        "a stale pin must trigger the full provision sequence"
    );
}

#[test]
fn exact_uv_invocation_args_and_env_mac() {
    let runner = FakeRuntimeRunner::new();
    *runner.uv_version_result.borrow_mut() = Some("uv 0.11.29".to_string());
    *runner.version_after_provision.borrow_mut() = Some("mpremote 1.28.0".to_string());
    let client = reqwest::blocking::Client::new();
    let blk = mac_blk();
    let envpy = mac_envpy(&blk);
    let dir = temp_dir("exact-args-mac");

    ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();

    let calls = runner.calls.borrow();
    assert_eq!(calls.len(), 3);
    let python_install_dir = blk.join("python").to_string_lossy().into_owned();
    let env_dir = blk.join("env").to_string_lossy().into_owned();
    let envpy_str = envpy.to_string_lossy().into_owned();

    assert_eq!(calls[0].args, vec!["python", "install", "--no-bin", "3.12"]);
    assert_eq!(
        calls[0].env,
        vec![(
            "UV_PYTHON_INSTALL_DIR".to_string(),
            python_install_dir.clone()
        )]
    );

    assert_eq!(
        calls[1].args,
        vec![
            "venv",
            env_dir.as_str(),
            "--managed-python",
            "--python",
            "3.12"
        ]
    );
    assert_eq!(
        calls[1].env,
        vec![(
            "UV_PYTHON_INSTALL_DIR".to_string(),
            python_install_dir.clone()
        )]
    );

    assert_eq!(
        calls[2].args,
        vec![
            "pip",
            "install",
            "--python",
            envpy_str.as_str(),
            "mpremote==1.28.0"
        ]
    );
    assert_eq!(
        calls[2].env,
        vec![("UV_PYTHON_INSTALL_DIR".to_string(), python_install_dir)]
    );
}

#[test]
fn contained_env_paths_differ_correctly_per_os() {
    let runner = FakeRuntimeRunner::new();
    *runner.uv_version_result.borrow_mut() = Some("uv 0.11.29".to_string());
    *runner.version_after_provision.borrow_mut() = Some("mpremote 1.28.0".to_string());
    let client = reqwest::blocking::Client::new();
    let blk = win_blk();
    let envpy = win_envpy(&blk);
    let dir = temp_dir("win-paths");

    ensure_runtime(
        &runner,
        &client,
        Os::Windows,
        Arch::X64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();

    let calls = runner.calls.borrow();
    let expected_env_dir = blk.join("env").to_string_lossy().into_owned();
    let expected_python_dir = blk.join("python").to_string_lossy().into_owned();
    let expected_envpy = envpy.to_string_lossy().into_owned();

    assert_eq!(
        calls[1].args[1], expected_env_dir,
        "venv target must be under this OS's BLK"
    );
    assert_eq!(
        calls[2].args[3], expected_envpy,
        "pip --python must be this OS's ENVPY"
    );
    assert_eq!(calls[0].env[0].1, expected_python_dir);
    assert!(expected_env_dir.starts_with(&blk.to_string_lossy().into_owned()));
    assert!(expected_envpy.starts_with(&blk.to_string_lossy().into_owned()));
}

#[test]
fn uv_already_current_skips_download() {
    let runner = FakeRuntimeRunner::new();
    *runner.uv_version_result.borrow_mut() = Some("uv 0.11.29".to_string());
    *runner.version_after_provision.borrow_mut() = Some("mpremote 1.28.0".to_string());
    let client = reqwest::blocking::Client::new();
    let blk = mac_blk();
    let envpy = mac_envpy(&blk);
    let dir = temp_dir("uv-current");

    // extract_uv would error if called (no real network/archive here);
    // if the step tried to re-download uv this test would fail loudly.
    *runner.extract_uv_result.borrow_mut() = Err("must not be called".to_string());

    ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();
}

#[test]
fn mpremote_verify_failure_after_provision_is_reported() {
    let runner = FakeRuntimeRunner::new();
    *runner.uv_version_result.borrow_mut() = Some("uv 0.11.29".to_string());
    // no version_after_provision set: mpremote_version stays None even
    // after the uv sequence "succeeds"
    let client = reqwest::blocking::Client::new();
    let blk = mac_blk();
    let envpy = mac_envpy(&blk);
    let dir = temp_dir("verify-fail");

    let err = ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap_err();

    assert!(matches!(err, RuntimeError::MpremoteVerifyFailed));
}

/// The shim has to be RUNNABLE and succeed, not merely exist. uv execs it
/// with `-id <dylib> <dylib>`; anything that is not an executable exiting 0
/// leaves uv failing, or worse, leaves macOS raising the developer-tools
/// dialog that this exists to prevent.
#[cfg(unix)]
#[test]
fn the_shim_is_executable_and_succeeds() {
    let dir = temp_dir("shim").join("toolshim");
    write_install_name_tool_shim(&dir).unwrap();
    let shim = dir.join("install_name_tool");
    assert!(shim.exists(), "no shim written");

    // Exactly the invocation observed from uv on the rig.
    let status = std::process::Command::new(&shim)
        .args([
            "-id",
            "/tmp/libpython3.12.dylib",
            "/tmp/libpython3.12.dylib",
        ])
        .status()
        .expect("the shim should be executable");
    assert!(
        status.success(),
        "the shim must exit 0, or uv treats the patch as failed"
    );
}

/// Both branches, decided by the argument rather than by whatever is
/// installed on the machine running the test.
///
/// The first version of this probed the real filesystem, so its answer
/// depended on the host: it passed on a Mac with the developer tools and
/// failed on the Windows runner without them. That is the same defect class
/// as a fixture reading the machine instead of its fixture, which this
/// component has now produced three times.
#[test]
fn shim_only_when_the_real_tool_is_missing() {
    let blk = temp_dir("shim-gate");

    // Tools present: leave PATH alone, or we would suppress a patch that
    // would really have worked.
    assert!(install_name_tool_shim(Os::MacOs, &blk, true).is_none());

    // Tools absent: shim, and the shim dir must come FIRST or the stub at
    // /usr/bin still wins and the dialog still appears.
    let path = install_name_tool_shim(Os::MacOs, &blk, false).expect("a shim was due");
    assert!(
        path.starts_with(&blk.join("toolshim").display().to_string()),
        "the shim dir must come first in PATH: {path}"
    );

    // Windows never has this problem and must never be shimmed, whatever
    // the flag says.
    assert!(install_name_tool_shim(Os::Windows, &blk, false).is_none());
}

/// The env handed to uv must gain a PATH entry when the tools are absent,
/// and nothing else. Pins the wiring, not just the decision: run 8 showed a
/// working shim, but only because this reaches `run_uv`.
#[test]
fn shim_reaches_the_uv_invocation() {
    let runner = FakeRuntimeRunner::new();
    *runner.mpremote_version_result.borrow_mut() = None;
    *runner.uv_version_result.borrow_mut() = Some("0.11.29".to_string());
    *runner.version_after_provision.borrow_mut() = Some("mpremote 1.28.0".to_string());
    *runner.developer_tools.borrow_mut() = false;

    let dir = temp_dir("shim-wiring");
    let blk = dir.join("blk");
    let envpy = blk.join("env").join("bin").join("python");
    let client = reqwest::blocking::Client::new();

    ensure_runtime(
        &runner,
        &client,
        Os::MacOs,
        Arch::Arm64,
        &manifest_uv(),
        "3.12",
        "1.28.0",
        &blk,
        &envpy,
        &dir,
        &fast_opts(),
    )
    .unwrap();

    let calls = runner.calls.borrow();
    let python_install = &calls[0];
    let path_entry = python_install
        .env
        .iter()
        .find(|(k, _)| k == "PATH")
        .expect("no PATH entry, so uv would still find the real stub");
    assert!(
        path_entry
            .1
            .starts_with(&blk.join("toolshim").display().to_string()),
        "shim dir must lead PATH: {}",
        path_entry.1
    );
}
