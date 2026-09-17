#![cfg(windows)]
//! Windows counterpart of `verify_parity_macos.rs`: same fixture shape and
//! same comparison, against `scripts/windows/verify-blockless.ps1` instead.
//! `#![cfg(windows)]`'d for the whole file -- unlike the zsh script, `pwsh`
//! `Join-Path`/path semantics only match reality on a real Windows host (see
//! `/scope.md`'s CI section), so this only compiles/runs on `windows-latest`;
//! it is an intentional no-op (zero tests) everywhere else, never a skip
//! that silently reports green.
//!
//! Unlike the mac script (which delegates settings.json parsing to a Python
//! heredoc via `$ENVPY`), `verify-blockless.ps1` parses JSON natively with
//! `ConvertFrom-Json`, so the stub `python.exe` here only ever needs to
//! answer `-m mpremote version` -- no delegation trick required.

use blockless_installer_core::extensions::ExtensionsRunner;
use blockless_installer_core::platform::{self, Os, RawEnv};
use blockless_installer_core::runtime::RuntimeRunner;
use blockless_installer_core::state::{State, Steps};
use blockless_installer_core::verify::{self, VerifyInputs};
use blockless_installer_core::vscode::VscodeInstaller;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

const PROFILE_NAME: &str = "Blockless";
const EXT_ID: &str = "blockless.mpy-hardware-extension";
const PY_EXT_ID: &str = "ms-python.python";
const PYLANCE_ID: &str = "ms-python.vscode-pylance";
const MPREMOTE_VERSION: &str = "1.28.0";

fn temp_root(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-verify-parity-win-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_batch_stub(path: &Path, script: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, script).unwrap();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Break {
    None,
    CodeCli,
    Extensions,
    Mpremote,
    EnvContained,
    PythonPath,
    AutoOpenPanel,
    StateSteps,
}

struct Fixture {
    local_appdata: PathBuf,
    appdata: PathBuf,
    blk: PathBuf,
    code_user: PathBuf,
    state_path: PathBuf,
}

/// A `.cmd` shim (not a raw `.exe`): `code.cmd` is exactly what the real VS
/// Code User install places at this path, and both `Command::new` and
/// PowerShell's `&` invoke `.cmd` files the same way (through `cmd.exe`).
fn build_fixture(name: &str, brk: Break) -> Fixture {
    let root = temp_root(name);
    let local_appdata = root.join("Local");
    let appdata = root.join("Roaming");
    let blk = local_appdata.join("Blockless");
    let code_user = appdata.join("Code").join("User");
    let env_python = blk.join("env").join("Scripts").join("python.exe");
    let code_cli = local_appdata
        .join("Programs")
        .join("Microsoft VS Code")
        .join("bin")
        .join("code.cmd");

    let extensions = if brk == Break::Extensions {
        vec![EXT_ID, PY_EXT_ID]
    } else {
        vec![EXT_ID, PY_EXT_ID, PYLANCE_ID]
    };
    let version_early_exit = if brk == Break::CodeCli {
        "exit /b 1"
    } else {
        ""
    };
    let code_script = format!(
        "@echo off\r\nif \"%~1\"==\"--version\" (\r\n  {version_early_exit}\r\n  echo 1.99.0\r\n  echo abcdef0123456789\r\n  echo arm64\r\n  exit /b 0\r\n)\r\nif \"%~1\"==\"--profile\" (\r\n{ext_lines}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n",
        version_early_exit = version_early_exit,
        ext_lines = extensions
            .iter()
            .map(|e| format!("  echo {e}"))
            .collect::<Vec<_>>()
            .join("\r\n"),
    );
    write_batch_stub(&code_cli, &code_script);

    let mpremote_reported = if brk == Break::Mpremote {
        "1.20.0"
    } else {
        MPREMOTE_VERSION
    };
    // A REAL executable, copied rather than written. Windows will not run a
    // script placed at a `.exe` path: this fixture used to write a batch file
    // here, on the belief that Windows resolves an executable by content rather
    // than by extension, and it does not. Both `& $ENVPY` in the ps1 and
    // Command::new on the Rust side failed on it, which failed all nine parity
    // cases and hid a defect in verify-blockless.ps1 that let it report ALL PASS
    // with a check missing.
    //
    // The reported version travels in a file beside the exe rather than in the
    // environment, so the Mpremote break differs from its neighbours without any
    // state shared between tests running in parallel.
    std::fs::create_dir_all(env_python.parent().unwrap()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_fixture-fake-python"), &env_python).unwrap();
    std::fs::write(
        env_python.with_file_name("mpremote-version.txt"),
        mpremote_reported,
    )
    .unwrap();

    let pyvenv_home = if brk == Break::EnvContained {
        format!(r"{}-foreign\python\cpython-3.12.4", blk.display())
    } else {
        blk.join("python")
            .join("cpython-3.12.4")
            .display()
            .to_string()
    };
    std::fs::create_dir_all(blk.join("env")).unwrap();
    std::fs::write(
        blk.join("env").join("pyvenv.cfg"),
        format!("home = {pyvenv_home}\r\n"),
    )
    .unwrap();

    let steps = if brk == Break::StateSteps {
        Steps {
            vscode: true,
            extension: false,
            python: true,
            settings: true,
        }
    } else {
        Steps {
            vscode: true,
            extension: true,
            python: true,
            settings: true,
        }
    };
    let state = State {
        product_version: "1.99.0".to_string(),
        vscode_installed_by_us: true,
        profile_created_by_us: true,
        profile_location: "blockless".to_string(),
        steps,
        mpremote_version: MPREMOTE_VERSION.to_string(),
        env_python: env_python.to_string_lossy().into_owned(),
        ext_vsix_sha256: "abc123def456".to_string(),
        settings_mechanism: "A".to_string(),
        updated_at: "2026-07-05T12:00:00Z".to_string(),
    };
    let state_path = blk.join("state.json");
    state.write(&state_path).unwrap();

    let python_path_value = if brk == Break::PythonPath {
        "C:\\some\\other\\python.exe".to_string()
    } else {
        env_python.to_string_lossy().into_owned()
    };
    let auto_open_panel = brk != Break::AutoOpenPanel;
    let settings_target = code_user
        .join("profiles")
        .join("blockless")
        .join("settings.json");
    std::fs::create_dir_all(settings_target.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_target,
        serde_json::to_vec_pretty(&serde_json::json!({
            "mpyhw.pythonPath": python_path_value,
            "workbench.colorTheme": "Default Dark Modern",
            "mpyhw.autoOpenPanel": auto_open_panel,
            "workbench.secondarySideBar.defaultVisibility": "hidden",
        }))
        .unwrap(),
    )
    .unwrap();

    Fixture {
        local_appdata,
        appdata,
        blk,
        code_user,
        state_path,
    }
}

fn run_real_script(fixture: &Fixture) -> (Vec<bool>, i32) {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(r"..\scripts\windows\verify-blockless.ps1");
    let output = Command::new("pwsh")
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(&script)
        .env("LOCALAPPDATA", &fixture.local_appdata)
        .env("APPDATA", &fixture.appdata)
        .output()
        .expect("failed to run verify-blockless.ps1 (is pwsh installed?)");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let bits: Vec<bool> = stdout
        .lines()
        .filter_map(|l| {
            if l.starts_with("PASS:") {
                Some(true)
            } else if l.starts_with("FAIL:") {
                Some(false)
            } else {
                None
            }
        })
        .collect();
    (bits, output.status.code().unwrap_or(-1))
}

struct ShellVscode;
impl VscodeInstaller for ShellVscode {
    fn version(&self, code_cli: &Path) -> Option<String> {
        let out = Command::new(code_cli).arg("--version").output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout)
            .ok()?
            .lines()
            .next()
            .map(|s| s.to_string())
    }
    fn is_writable(&self, _dir: &Path) -> bool {
        unimplemented!()
    }
    fn extract_archive(
        &self,
        _archive: &Path,
        _target_dir: &Path,
    ) -> Result<(), blockless_installer_core::vscode::InstallError> {
        unimplemented!()
    }
    fn strip_quarantine(&self, _app_dir: &Path) {
        unimplemented!()
    }
    fn run_silent_installer(
        &self,
        _installer_exe: &Path,
    ) -> Result<(), blockless_installer_core::vscode::InstallError> {
        unimplemented!()
    }
    fn verify_signature(
        &self,
        _artifact: &Path,
    ) -> Result<(), blockless_installer_core::vscode::SignatureError> {
        unimplemented!()
    }
    fn remove_unverified_install(
        &self,
        _app_dir: &Path,
    ) -> Result<(), blockless_installer_core::vscode::InstallError> {
        unimplemented!()
    }
}

struct ShellExtensions;
impl ExtensionsRunner for ShellExtensions {
    fn list_extensions(&self, code_cli: &Path, profile_name: &str) -> Option<Vec<String>> {
        let out = Command::new(code_cli)
            .args(["--profile", profile_name, "--list-extensions"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|s| s.to_string())
                .collect(),
        )
    }
    fn install_extension(&self, _code_cli: &Path, _profile_name: &str, _vsix_or_id: &str) -> bool {
        unimplemented!()
    }
}

struct ShellRuntime;
impl RuntimeRunner for ShellRuntime {
    fn mpremote_version(&self, envpy: &Path) -> Option<String> {
        let out = Command::new(envpy)
            .args(["-m", "mpremote", "version"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    }
    fn uv_version(&self, _uv_bin: &Path) -> Option<String> {
        unimplemented!()
    }
    fn extract_uv(&self, _archive: &Path, _dest_dir: &Path) -> Result<(), String> {
        unimplemented!()
    }
    fn run_uv(&self, _uv_bin: &Path, _args: &[&str], _env: &[(&str, &str)]) -> bool {
        unimplemented!()
    }
    fn developer_tools_present(&self) -> bool {
        unimplemented!("verify never provisions")
    }
}

fn run_rust_checks(fixture: &Fixture) -> (Vec<bool>, bool) {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        target_arch: "x86_64".to_string(),
        local_appdata: Some(fixture.local_appdata.to_string_lossy().into_owned()),
        appdata: Some(fixture.appdata.to_string_lossy().into_owned()),
        processor_architecture: Some("AMD64".to_string()),
        ..Default::default()
    };
    let candidates = platform::code_cli_candidates(Os::Windows, &raw).unwrap();

    let inputs = VerifyInputs {
        code_candidates: &candidates,
        profile_name: PROFILE_NAME,
        ext_id: EXT_ID,
        py_ext_id: PY_EXT_ID,
        pylance_id: PYLANCE_ID,
        mpremote_version: MPREMOTE_VERSION,
        blk: &fixture.blk,
        code_user: &fixture.code_user,
        state_path: &fixture.state_path,
    };
    let results = verify::run_checks(&ShellVscode, &ShellExtensions, &ShellRuntime, &inputs);
    let bits: Vec<bool> = results.iter().map(|r| r.pass).collect();
    let overall = verify::all_pass(&results);
    (bits, overall)
}

fn assert_parity(name: &str, brk: Break) {
    let fixture = build_fixture(name, brk);
    let (script_bits, script_exit) = run_real_script(&fixture);
    let (rust_bits, rust_overall) = run_rust_checks(&fixture);

    assert_eq!(
        script_bits.len(),
        7,
        "{name}: expected 7 PASS/FAIL lines, got {script_bits:?}"
    );
    assert_eq!(
        rust_bits.len(),
        7,
        "{name}: expected 7 checks from run_checks"
    );
    assert_eq!(
        script_bits, rust_bits,
        "{name}: per-check PASS/FAIL sequence diverged between the script and verify.rs"
    );
    assert_eq!(
        script_exit == 0,
        rust_overall,
        "{name}: overall verdict diverged (script exit={script_exit}, rust all_pass={rust_overall})"
    );
}

#[test]
fn parity_all_green() {
    assert_parity("all-green", Break::None);
}

#[test]
fn parity_code_cli_broken() {
    assert_parity("code-cli-broken", Break::CodeCli);
}

#[test]
fn parity_extensions_broken() {
    assert_parity("extensions-broken", Break::Extensions);
}

#[test]
fn parity_mpremote_broken() {
    assert_parity("mpremote-broken", Break::Mpremote);
}

#[test]
fn parity_env_contained_broken() {
    assert_parity("env-contained-broken", Break::EnvContained);
}

#[test]
fn parity_python_path_broken() {
    assert_parity("python-path-broken", Break::PythonPath);
}

#[test]
fn parity_auto_open_panel_broken() {
    assert_parity("auto-open-panel-broken", Break::AutoOpenPanel);
}

#[test]
fn parity_state_steps_broken() {
    assert_parity("state-steps-broken", Break::StateSteps);
}

#[test]
fn parity_m0_installed_tree_shape() {
    assert_parity("m0-installed-tree", Break::None);
}

/// An `env\Scripts\python.exe` that EXISTS but is not a runnable PE must fail
/// its check, not delete it.
///
/// `&` on such a file raises ApplicationFailedException, which is
/// statement-terminating: PowerShell abandoned the entire if/else, so neither
/// `pass` nor `fail` ran, `$script:fails` stayed 0, and the script reported ALL
/// PASS and exited 0 with one assertion silently missing. That is a verifier
/// blessing an install it never checked, and a present-but-unrunnable python is
/// exactly what a half-finished or corrupted install leaves behind.
///
/// Deliberately writes a non-PE file rather than relying on what the fixture
/// happens to produce, so this keeps testing the same thing once the fixture's
/// stub becomes a real executable.
///
/// Kills the fix: drop `invoke_tool`'s try/catch and this reports 6 lines and
/// exit 0 instead of 7 and non-zero.
#[test]
fn script_fails_closed_when_envpy_exists_but_cannot_run() {
    let fixture = build_fixture("envpy-not-runnable", Break::None);
    let envpy = fixture.blk.join("env").join("Scripts").join("python.exe");
    assert!(
        envpy.exists(),
        "fixture should have placed an ENVPY to break"
    );
    std::fs::write(&envpy, b"not a PE binary").unwrap();

    let (bits, exit) = run_real_script(&fixture);

    assert_eq!(
        bits.len(),
        7,
        "a check vanished instead of failing: the script emitted {} PASS/FAIL \
         lines, so one if/else was abandoned mid-statement. bits={bits:?}",
        bits.len()
    );
    assert!(
        !bits[2],
        "check 3 (pinned mpremote) must FAIL when ENVPY cannot run, got {bits:?}"
    );
    assert_ne!(
        exit, 0,
        "the script reported success while a check could not be performed"
    );
}
