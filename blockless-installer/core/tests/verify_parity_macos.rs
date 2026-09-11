#![cfg(unix)]
//! Script-parity matrix: builds a faked `$HOME` fixture tree (state.json,
//! storage.json-shaped profile settings, `pyvenv.cfg`, stub `code` and
//! python executables) and runs BOTH the real
//! `scripts/macos/verify-blockless.zsh` and `verify::run_checks` against it,
//! comparing the per-check PASS/FAIL sequence and the overall verdict.
//! Across: all-green, each single check broken, and a realistic
//! M0-installed-tree shape.
//!
//! zsh (not pwsh) on purpose, on any host: the script's own logic is plain
//! text/file manipulation (no macOS-only APIs), so it runs correctly under
//! Linux zsh too -- only the Windows script's `Join-Path` behavior needs a
//! real Windows host (see `/scope.md`'s CI section), which is why this file
//! is `-macos` and the Windows counterpart runs on `windows-latest`.

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
/// What the fixture's stub `code` reports for `--version`, and nothing else on a
/// real machine does. Doubles as the marker that the script resolved the stub
/// rather than an installed editor.
const STUB_CODE_VERSION: &str = "1.99.0";

fn temp_home(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-verify-parity-{name}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_executable(path: &Path, script: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
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
    /// Not a "break" at all -- both sides are expected to stay green. The
    /// extension ids the `code` CLI reports are mixed-case (VS Code itself
    /// can report extension ids in whatever case the publisher used); both
    /// `verify.rs` (`eq_ignore_ascii_case`) and the real script (`grep -qi`)
    /// are supposed to treat this as present. Exercised here (not just as a
    /// Rust unit test) so a regression in either side's case-folding shows
    /// up as a genuine PASS/FAIL divergence against the real script.
    ExtensionsCaseVariant,
    /// Not a "break" either. `pyvenv.cfg`'s `home` line differs from the
    /// real prefix only in case (APFS is case-insensitive by default, so a
    /// real machine can produce this). Both `verify.rs`
    /// (`env_is_contained`'s case-folded compare) and the real script
    /// (documented case-insensitive compare at its "env base interpreter is
    /// contained" check) must still treat it as contained.
    EnvContainedCaseVariant,
    /// Not a "break" -- VS Code pre-existed (this install did NOT put it
    /// there). Distinct tree shape from `Break::None` (differs in
    /// `vscodeInstalledByUs`, which `verify.rs`'s checks never read at all,
    /// so this must still verify fully green on both sides) rather than a
    /// copy of it under a different name.
    PreexistingVscode,
}

struct Fixture {
    home: PathBuf,
    blk: PathBuf,
    code_user: PathBuf,
    state_path: PathBuf,
}

/// Builds a full fixture tree under a fresh `$HOME`, matching exactly what
/// M0's install flow would have left behind, with one aspect optionally
/// corrupted to exercise a single check's negative path.
fn build_fixture(name: &str, brk: Break) -> Fixture {
    let home = temp_home(name);
    let blk = home
        .join("Library")
        .join("Application Support")
        .join("Blockless");
    let code_user = home
        .join("Library")
        .join("Application Support")
        .join("Code")
        .join("User");
    let env_python = blk.join("env").join("bin").join("python");
    let code_cli = home
        .join("Applications")
        .join("Visual Studio Code.app")
        .join("Contents")
        .join("Resources")
        .join("app")
        .join("bin")
        .join("code");

    // --- stub `code`: --version, and --profile <name> --list-extensions ---
    let extensions: Vec<String> = if brk == Break::Extensions {
        vec![EXT_ID.to_string(), PY_EXT_ID.to_string()] // pylance missing
    } else if brk == Break::ExtensionsCaseVariant {
        vec![
            "Blockless.MPY-Hardware-Extension".to_string(),
            "MS-Python.Python".to_string(),
            "MS-Python.Vscode-Pylance".to_string(),
        ]
    } else {
        vec![
            EXT_ID.to_string(),
            PY_EXT_ID.to_string(),
            PYLANCE_ID.to_string(),
        ]
    };
    // A broken code CLI bails out BEFORE printing anything (simulates a
    // binary that exits nonzero on --version); the normal case falls
    // through to the prints below untouched.
    let version_early_exit = if brk == Break::CodeCli { "exit 1" } else { "" };
    let code_script = format!(
        r#"#!/usr/bin/env zsh
if [[ "$1" == "--version" ]]; then
  {version_early_exit}
  print -r -- "{STUB_CODE_VERSION}"
  print -r -- "abcdef0123456789"
  print -r -- "arm64"
  exit 0
fi
if [[ "$1" == "--profile" ]]; then
{ext_lines}
  exit 0
fi
exit 1
"#,
        version_early_exit = version_early_exit,
        ext_lines = extensions
            .iter()
            .map(|e| format!("  print -r -- \"{e}\""))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    write_executable(&code_cli, &code_script);

    // --- stub python: -m mpremote version, else delegate to a real python3
    // (the script also invokes $ENVPY as `- <script.py> args...`, reading a
    // genuine Python heredoc from stdin, to check settings.json -- that
    // needs an actual interpreter, not a fake).
    let mpremote_reported = if brk == Break::Mpremote {
        "1.20.0"
    } else {
        MPREMOTE_VERSION
    };
    let python_script = format!(
        "#!/usr/bin/env zsh\nif [[ \"$1\" == \"-m\" && \"$2\" == \"mpremote\" && \"$3\" == \"version\" ]]; then\n  print -r -- \"mpremote {mpremote_reported}\"\n  exit 0\nfi\nexec python3 \"$@\"\n"
    );
    write_executable(&env_python, &python_script);

    // --- env/pyvenv.cfg ---
    let pyvenv_home = if brk == Break::EnvContained {
        // a sibling dir, not a real subpath -- the exact "bare prefix"
        // false-positive this check exists to reject.
        format!("{}-foreign/python/cpython-3.12.4", blk.display())
    } else if brk == Break::EnvContainedCaseVariant {
        // same real path, differing only in case from `blk` -- APFS is
        // case-insensitive by default, so this is a real-world shape, not a
        // synthetic one.
        blk.join("python")
            .join("cpython-3.12.4")
            .display()
            .to_string()
            .to_uppercase()
    } else {
        blk.join("python")
            .join("cpython-3.12.4")
            .display()
            .to_string()
    };
    std::fs::create_dir_all(blk.join("env")).unwrap();
    std::fs::write(
        blk.join("env").join("pyvenv.cfg"),
        format!("home = {pyvenv_home}\n"),
    )
    .unwrap();

    // --- state.json ---
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
    // `Break::PreexistingVscode`'s tree shape is meant to be genuinely
    // distinct from the offline-seeded default, not just a copy of it under
    // a different name: a VS-Code-registered (not offline-seeded) profile
    // gets a hashed directory id, never the seed constant "blockless" --
    // checks 4/4b/6 (settings.json location, python path, auto-open-panel)
    // all consume this journaled id, not a hardcoded one.
    let profile_location = if brk == Break::PreexistingVscode {
        "a1b2c3d4e5"
    } else {
        "blockless"
    };
    let state = State {
        product_version: "1.99.0".to_string(),
        vscode_installed_by_us: brk != Break::PreexistingVscode,
        profile_created_by_us: true,
        profile_location: profile_location.to_string(),
        steps,
        mpremote_version: MPREMOTE_VERSION.to_string(),
        env_python: env_python.to_string_lossy().into_owned(),
        ext_vsix_sha256: "abc123def456".to_string(),
        settings_mechanism: "A".to_string(),
        updated_at: "2026-07-05T12:00:00Z".to_string(),
    };
    let state_path = blk.join("state.json");
    state.write(&state_path).unwrap();

    // --- profile settings.json ---
    let python_path_value = if brk == Break::PythonPath {
        "/some/other/python".to_string()
    } else {
        env_python.to_string_lossy().into_owned()
    };
    let auto_open_panel = brk != Break::AutoOpenPanel;
    let settings_target = code_user
        .join("profiles")
        .join(profile_location)
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
        home,
        blk,
        code_user,
        state_path,
    }
}

/// The system-wide applications root both sides are pointed at: a directory
/// under the fixture that is deliberately never created, so the system `code`
/// candidate cannot match and resolution falls through to the fixture's stub.
fn no_system_apps(home: &Path) -> PathBuf {
    home.join("NoSystemApps")
}

fn run_real_script(fixture: &Fixture, brk: Break) -> (Vec<bool>, i32) {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/macos/verify-blockless.zsh");
    // Faking $HOME is not enough on its own. The script's FIRST `code` candidate
    // is an absolute /Applications path, which no amount of $HOME redirection can
    // shadow, so on a developer machine with VS Code installed the script resolved
    // the REAL editor and answered every check about that machine instead of the
    // fixture. Point the system-wide root at a directory the fixture deliberately
    // never creates, so resolution falls through to the fixture's own stub.
    let output = Command::new("zsh")
        .arg(&script)
        .env("HOME", &fixture.home)
        .env("BLOCKLESS_APPS_ROOT", no_system_apps(&fixture.home))
        .output()
        .expect("failed to run verify-blockless.zsh (is zsh installed?)");
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Prove the redirection actually took, rather than trusting it. The stub is
    // the only `code` that reports this version, so check 1 naming anything else
    // means a real editor answered and the whole comparison below is about the
    // wrong machine -- which fails loudly here instead of as seven confusing
    // per-check divergences. Skipped for CodeCli, whose stub exits before
    // printing a version on purpose.
    if brk != Break::CodeCli {
        assert!(
            stdout.contains(STUB_CODE_VERSION),
            "verify-blockless.zsh resolved a `code` outside the fixture: check 1 did not report \
             the stub version {STUB_CODE_VERSION}. BLOCKLESS_APPS_ROOT is not being honoured, so \
             this run is reading the host machine.\n{stdout}"
        );
    }
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
        target_os: "macos".to_string(),
        target_arch: "aarch64".to_string(),
        home: Some(fixture.home.to_string_lossy().into_owned()),
        // Must match what run_real_script exports, or the two sides resolve
        // different `code` binaries and the comparison is meaningless.
        apps_root: Some(no_system_apps(&fixture.home).to_string_lossy().into_owned()),
        ..Default::default()
    };
    let candidates = platform::code_cli_candidates(Os::MacOs, &raw).unwrap();

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
    let (script_bits, script_exit) = run_real_script(&fixture, brk);
    let (rust_bits, rust_overall) = run_rust_checks(&fixture);

    assert_eq!(
        script_bits.len(),
        7,
        "{name}: expected 7 PASS/FAIL lines from the script, got {script_bits:?}"
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

/// A realistic full M0-installed tree where VS Code pre-existed (this
/// install did not put it there) -- genuinely distinct from
/// `parity_all_green`'s shape (`vscodeInstalledByUs: false` and a
/// VS-Code-generated hashed `profileLocation` rather than the seed
/// constant), not a copy of it under a different name. Still fully green on
/// both sides: `vscodeInstalledByUs` is journal-only bookkeeping none of the
/// 7 checks read, and checks 4/4b/6 correctly resolve the hashed location.
#[test]
fn parity_m0_installed_tree_with_preexisting_vscode_shape() {
    assert_parity(
        "m0-installed-tree-preexisting-vscode",
        Break::PreexistingVscode,
    );
}

#[test]
fn parity_extensions_case_insensitive() {
    assert_parity("extensions-case-variant", Break::ExtensionsCaseVariant);
}

#[test]
fn parity_env_contained_case_folded() {
    assert_parity("env-contained-case-variant", Break::EnvContainedCaseVariant);
}
