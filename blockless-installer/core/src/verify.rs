//! The 7 acceptance checks, ported with M0 semantics from
//! `verify-blockless.{zsh,ps1}`. Read-only throughout: no check ever writes
//! anything, and the profile settings target comes from the JOURNALED
//! `profileLocation` in `state.json`, never a fresh `storage.json` read (the
//! whole point of journaling it in `profile.rs`/`settings.rs` is that
//! `verify` doesn't need to re-derive it).
//!
//! Reuses the capability traits already built for the install steps
//! ([`vscode::VscodeInstaller`] for `--version`, [`extensions::ExtensionsRunner`]
//! for `--list-extensions`, [`runtime::RuntimeRunner`] for `-m mpremote
//! version`) rather than inventing parallel ones -- the parity harness
//! (`core/tests/verify_parity_macos.rs`) is what actually proves this
//! matches the scripts; duplicating "how do I ask code/uv/python something"
//! a fourth time would only be a second place for that logic to drift.

use crate::extensions::ExtensionsRunner;
use crate::runtime::RuntimeRunner;
use crate::state::State;
use crate::vscode::VscodeInstaller;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckId {
    CodeCliRunnable,
    ExtensionsPresent,
    MpremoteImportable,
    EnvContained,
    PythonPathSetting,
    AutoOpenPanelSetting,
    StateStepsOk,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub id: CheckId,
    pub pass: bool,
    pub message: String,
}

impl CheckResult {
    fn pass(id: CheckId, message: impl Into<String>) -> CheckResult {
        CheckResult {
            id,
            pass: true,
            message: message.into(),
        }
    }
    fn fail(id: CheckId, message: impl Into<String>) -> CheckResult {
        CheckResult {
            id,
            pass: false,
            message: message.into(),
        }
    }
}

/// `home = ...` out of `pyvenv.cfg`'s flat `key = value` lines (ports the
/// `grep -E '^home[[:space:]]*=' | sed` / `Select-String '^home\s*=\s*(.+)$'`
/// extraction).
fn parse_pyvenv_home(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("home") {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix('=') {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// Exact-or-path-boundary containment, case-folded (APFS/NTFS are both
/// case-insensitive by default, so a casing difference alone is the same
/// directory, not a breach). A bare string prefix is NOT enough -- it would
/// also accept a sibling like `Blockless-foreign`, so the boundary character
/// (`/` or `\`) right after `blk` is required. Checks both separators rather
/// than the compile target's native one so this one function is correct
/// (and testable) against a real path from either OS.
pub fn env_is_contained(pyvenv_cfg_home: &str, blk: &Path) -> bool {
    let home_l = pyvenv_cfg_home.to_lowercase();
    let blk_l = blk.to_string_lossy().to_lowercase();
    if home_l == blk_l {
        return true;
    }
    home_l.starts_with(&format!("{blk_l}/")) || home_l.starts_with(&format!("{blk_l}\\"))
}

fn check_code_cli(
    vscode: &dyn VscodeInstaller,
    candidates: &[PathBuf],
) -> (CheckResult, Option<PathBuf>) {
    for c in candidates {
        if let Some(v) = vscode.version(c) {
            return (
                CheckResult::pass(CheckId::CodeCliRunnable, format!("VS Code CLI ({v})")),
                Some(c.clone()),
            );
        }
    }
    (
        CheckResult::fail(CheckId::CodeCliRunnable, "VS Code CLI not runnable"),
        None,
    )
}

fn check_extensions(
    ext_runner: &dyn ExtensionsRunner,
    code_cli: Option<&Path>,
    profile_name: &str,
    ids: [&str; 3],
) -> CheckResult {
    let Some(code_cli) = code_cli else {
        return CheckResult::fail(
            CheckId::ExtensionsPresent,
            "extension check skipped (no code CLI)",
        );
    };
    let list = ext_runner
        .list_extensions(code_cli, profile_name)
        .unwrap_or_default();
    let all_present = ids.iter().all(|id| {
        list.iter()
            .any(|installed| installed.eq_ignore_ascii_case(id))
    });
    if all_present {
        CheckResult::pass(
            CheckId::ExtensionsPresent,
            format!("extensions in profile '{profile_name}' (blockless + python + pylance)"),
        )
    } else {
        CheckResult::fail(
            CheckId::ExtensionsPresent,
            format!("extensions missing in profile '{profile_name}'"),
        )
    }
}

fn check_mpremote(
    runtime_runner: &dyn RuntimeRunner,
    env_python: &Path,
    pinned_version: &str,
) -> CheckResult {
    if runtime_runner
        .mpremote_version(env_python)
        .is_some_and(|v| v.contains(pinned_version))
    {
        CheckResult::pass(
            CheckId::MpremoteImportable,
            format!("mpremote {pinned_version} in env"),
        )
    } else {
        CheckResult::fail(
            CheckId::MpremoteImportable,
            format!(
                "mpremote {pinned_version} not found (envPython='{}')",
                env_python.display()
            ),
        )
    }
}

fn check_env_contained(blk: &Path) -> CheckResult {
    let cfg_path = blk.join("env").join("pyvenv.cfg");
    let Ok(text) = std::fs::read_to_string(&cfg_path) else {
        return CheckResult::fail(
            CheckId::EnvContained,
            "env/pyvenv.cfg not found or unreadable",
        );
    };
    match parse_pyvenv_home(&text) {
        Some(home) if env_is_contained(&home, blk) => CheckResult::pass(
            CheckId::EnvContained,
            format!("env base interpreter is contained ({home})"),
        ),
        Some(home) => CheckResult::fail(
            CheckId::EnvContained,
            format!(
                "env base interpreter NOT contained (home='{home}', expected under {})",
                blk.display()
            ),
        ),
        None => CheckResult::fail(CheckId::EnvContained, "pyvenv.cfg has no home line"),
    }
}

fn read_profile_settings(code_user: &Path, profile_location: &str) -> Option<Value> {
    let target = code_user
        .join("profiles")
        .join(profile_location)
        .join("settings.json");
    let bytes = std::fs::read(target).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn check_python_path_setting(settings: Option<&Value>, env_python: &Path) -> CheckResult {
    let ok = settings
        .and_then(|s| s.get("mpyhw.pythonPath"))
        .and_then(Value::as_str)
        .is_some_and(|p| p == env_python.to_string_lossy() && Path::new(p).exists());
    if ok {
        CheckResult::pass(
            CheckId::PythonPathSetting,
            "mpyhw.pythonPath set in the profile settings and points at a real exe",
        )
    } else {
        CheckResult::fail(CheckId::PythonPathSetting, "mpyhw.pythonPath wrong/missing")
    }
}

fn check_auto_open_panel_setting(settings: Option<&Value>) -> CheckResult {
    let ok = settings.and_then(|s| s.get("mpyhw.autoOpenPanel")) == Some(&Value::Bool(true));
    if ok {
        CheckResult::pass(
            CheckId::AutoOpenPanelSetting,
            "mpyhw.autoOpenPanel enabled in the profile settings",
        )
    } else {
        CheckResult::fail(
            CheckId::AutoOpenPanelSetting,
            "mpyhw.autoOpenPanel not enabled",
        )
    }
}

fn check_state_steps(state: Option<&State>) -> CheckResult {
    match state {
        Some(s) if s.steps.all_ok() => {
            CheckResult::pass(CheckId::StateStepsOk, "state.json marks all four steps ok")
        }
        _ => CheckResult::fail(
            CheckId::StateStepsOk,
            "state.json missing or a step is not ok",
        ),
    }
}

pub struct VerifyInputs<'a> {
    pub code_candidates: &'a [PathBuf],
    pub profile_name: &'a str,
    pub ext_id: &'a str,
    pub py_ext_id: &'a str,
    pub pylance_id: &'a str,
    pub mpremote_version: &'a str,
    pub blk: &'a Path,
    pub code_user: &'a Path,
    pub state_path: &'a Path,
}

/// Runs all 7 checks in the scripts' order. `Ok` for every check iff the
/// whole verify passes (mirrors the scripts' `exit 0` only when `fails==0`).
pub fn run_checks(
    vscode: &dyn VscodeInstaller,
    ext_runner: &dyn ExtensionsRunner,
    runtime_runner: &dyn RuntimeRunner,
    inputs: &VerifyInputs,
) -> Vec<CheckResult> {
    let state = State::read(inputs.state_path).ok().flatten();

    let (check1, code_cli) = check_code_cli(vscode, inputs.code_candidates);
    let check2 = check_extensions(
        ext_runner,
        code_cli.as_deref(),
        inputs.profile_name,
        [inputs.ext_id, inputs.py_ext_id, inputs.pylance_id],
    );

    let env_python = state
        .as_ref()
        .map(|s| PathBuf::from(&s.env_python))
        .unwrap_or_default();
    let check3 = check_mpremote(runtime_runner, &env_python, inputs.mpremote_version);
    let check3b = check_env_contained(inputs.blk);

    let settings = state
        .as_ref()
        .and_then(|s| read_profile_settings(inputs.code_user, &s.profile_location));
    let check4 = check_python_path_setting(settings.as_ref(), &env_python);
    let check4b = check_auto_open_panel_setting(settings.as_ref());

    let check5 = check_state_steps(state.as_ref());

    vec![check1, check2, check3, check3b, check4, check4b, check5]
}

pub fn all_pass(results: &[CheckResult]) -> bool {
    results.iter().all(|r| r.pass)
}

#[cfg(test)]
#[path = "tests/verify.rs"]
mod tests;
