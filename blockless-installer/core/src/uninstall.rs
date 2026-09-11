//! The fail-closed uninstaller. Ports `uninstall-blockless.{zsh,ps1}`'s
//! invariant structure exactly: read the journal BEFORE any deletion, never
//! guess ownership, and stop rather than guess when a check can't be
//! confirmed.
//!
//! Three separate fail-closed postures, all deliberate:
//! - Reading `state.json`: any failure (unreadable, unparseable, or missing
//!   a required field like `profileCreatedByUs`) aborts with NOTHING
//!   removed -- we cannot determine what we own, so we touch nothing.
//! - Editing `storage.json` (removing our profile entry): best-effort and
//!   silent on failure (never replaces an unparseable file) -- there IS a
//!   fallback, the invariant guard right after it.
//! - The invariant guard: after attempting the profile removal, re-check
//!   whether the storage.json entry or the profile directory still
//!   "provably remains". An UNREADABLE storage.json at this point counts as
//!   "still present" (cannot confirm gone = not gone), matching the
//!   Windows script's `catch { $entryPresent = $true }` exactly. If
//!   anything remains, stop before touching `BLK` or the journal, so a
//!   re-run can still finish.

use crate::profile;
use crate::state::State;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// OS-native deletion operations, injected so this is unit-testable without
/// a real filesystem-tree removal or a real VS Code uninstaller.
pub trait UninstallRunner {
    /// Recursively delete a directory tree. `Ok(())` only when the caller
    /// should trust it worked; the invariant guard and the BLK-removal
    /// report both re-check the filesystem afterward rather than trusting
    /// this alone, matching the scripts' "don't claim success over a
    /// partial delete" posture.
    fn remove_dir_all(&self, path: &Path) -> Result<(), String>;
    /// Run the platform's own VS Code uninstaller if one exists at
    /// `vscode_dir` (Windows: `unins000.exe /VERYSILENT`). `Ok(true)` if it
    /// ran, `Ok(false)` if there's no such uninstaller (caller falls back to
    /// `remove_dir_all`), `Err` if it exists but failed to run.
    fn run_vscode_uninstaller(&self, vscode_dir: &Path) -> Result<bool, String>;
}

/// `^[A-Za-z0-9_-]+$`, hand-rolled (no regex dependency for one allowlist
/// check): the profile directory is deleted ONLY when the journaled
/// location matches this shape, so a tampered/corrupt journal (`.`, `..`,
/// anything with a path separator) can never escape `profiles/` on delete.
fn is_safe_location(loc: &str) -> bool {
    !loc.is_empty()
        && loc
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn read_storage(storage_path: &Path) -> Option<Value> {
    let bytes = std::fs::read(storage_path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "storage.json".to_string());
    let tmp = parent.join(format!("{file_name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest)
}

/// Best-effort: filters our entry out if the file exists and parses.
/// Silent on any failure (missing, unreadable, unparseable, wrong shape) --
/// the invariant guard right after this is what actually enforces safety,
/// not this function's return value (it has none).
fn remove_storage_entry(storage_path: &Path, profile_name: &str) {
    let Some(mut root) = read_storage(storage_path) else {
        return;
    };
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if let Some(list) = obj
        .get_mut("userDataProfiles")
        .and_then(Value::as_array_mut)
    {
        list.retain(|e| e.get("name").and_then(Value::as_str) != Some(profile_name));
    } else {
        return;
    }
    let Ok(body) = serde_json::to_vec_pretty(&root) else {
        return;
    };
    let _ = write_atomic(storage_path, &body);
}

/// Fail-closed: `true` only when we can POSITIVELY confirm the entry is
/// gone. Missing file = confirmed gone. Unreadable/unparseable/wrong-shape
/// = cannot confirm = treated as still present.
fn storage_entry_confirmed_absent(storage_path: &Path, profile_name: &str) -> bool {
    if !storage_path.exists() {
        return true;
    }
    let Some(root) = read_storage(storage_path) else {
        return false; // exists but unreadable/unparseable: cannot confirm
    };
    let present = root
        .get("userDataProfiles")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .any(|e| e.get("name").and_then(Value::as_str) == Some(profile_name))
        })
        .unwrap_or(false);
    !present
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UninstallFlags {
    pub all: bool,
    pub keep_vscode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UninstallOutcome {
    /// VS Code is running: nothing was touched. Quit it and re-run.
    VscodeRunning,
    /// The process check failed, so we cannot prove VS Code is closed.
    /// Nothing was touched.
    ProcessCheckFailed,
    /// `state.json` exists but is unreadable/unparseable/incomplete: nothing
    /// was touched. Fix it (or delete `BLK` manually) and re-run.
    AbortedUnreadableState,
    Finished {
        profile_removed: bool,
        blk_removed: bool,
        /// `BLK` existed and an attempt was made, but something remains
        /// (locked/protected file) -- reported honestly, not as success.
        blk_removal_partial: bool,
        vscode_removed: bool,
        /// The profile removal could not be confirmed complete (storage.json
        /// entry or profile dir still provably present, or unreadable).
        /// `BLK` and the journal were left untouched so a re-run can finish.
        invariant_guard_tripped: bool,
    },
}

#[allow(clippy::too_many_arguments)]
pub fn uninstall(
    command_runner: &dyn profile::CommandRunner,
    runner: &dyn UninstallRunner,
    state_path: &Path,
    storage_path: &Path,
    profiles_dir: &Path,
    profile_name: &str,
    blk: &Path,
    // Every location this install could plausibly have put VS Code (mac: up
    // to two -- /Applications and ~/Applications, since `vscode.rs`'s own
    // writability fallback can land at either; Windows: always exactly one).
    // Each one that exists on disk gets removed, not just whichever the
    // caller happened to derive from a currently-runnable `code` CLI -- a
    // broken/stale candidate must not leave a real install undetected.
    vscode_dirs: &[PathBuf],
    flags: &UninstallFlags,
) -> UninstallOutcome {
    // Read state BEFORE any deletion. Any failure to positively confirm
    // ownership means we abort with nothing removed.
    let state = match State::read(state_path) {
        Ok(s) => s,
        Err(_) => return UninstallOutcome::AbortedUnreadableState,
    };

    // A running VS Code owns storage.json in memory and would clobber our
    // edit; do nothing and ask the user to quit it and re-run.
    match command_runner.running_vscode_pids() {
        Ok(pids) if !pids.is_empty() => return UninstallOutcome::VscodeRunning,
        Ok(_) => {}
        Err(_) => return UninstallOutcome::ProcessCheckFailed,
    }

    let (profile_created_by_us, vscode_installed_by_us, profile_location) = match &state {
        Some(s) => (
            s.profile_created_by_us,
            s.vscode_installed_by_us,
            s.profile_location.clone(),
        ),
        None => (false, false, String::new()),
    };

    let mut profile_removed = false;
    if profile_created_by_us {
        remove_storage_entry(storage_path, profile_name);

        let loc_safe = is_safe_location(&profile_location);
        if loc_safe {
            let dir = profiles_dir.join(&profile_location);
            if dir.exists() {
                let _ = runner.remove_dir_all(&dir);
            }
        }
        // An unsafe (or empty) location is deliberately never touched --
        // refuse to act on a tampered/corrupt journal rather than guess.

        let entry_gone = storage_entry_confirmed_absent(storage_path, profile_name);
        // Mirrors the scripts exactly: for an unsafe location, presence is
        // never even checked (there is nothing we attempted to remove at an
        // untrusted path), so it never blocks the guard on its own.
        let dir_still_present = loc_safe && profiles_dir.join(&profile_location).exists();

        if !entry_gone || dir_still_present {
            return UninstallOutcome::Finished {
                profile_removed: false,
                blk_removed: false,
                blk_removal_partial: false,
                vscode_removed: false,
                invariant_guard_tripped: true,
            };
        }
        profile_removed = true;
    }

    let should_remove_vscode = !flags.keep_vscode && (flags.all || vscode_installed_by_us);
    // `true` only once every EXISTING candidate was actually removed -- a
    // partial removal (e.g. a locked file at one location) must not report
    // success, matching this function's existing honesty posture for BLK.
    let (vscode_removed, vscode_cleanup_complete) = if should_remove_vscode {
        let mut all_removed = true;
        let mut any_existed = false;
        for vscode_dir in vscode_dirs {
            if !vscode_dir.exists() {
                continue;
            }
            any_existed = true;
            let removed = match runner.run_vscode_uninstaller(vscode_dir) {
                Ok(true) => !vscode_dir.exists(),
                Ok(false) => runner.remove_dir_all(vscode_dir).is_ok() && !vscode_dir.exists(),
                Err(_) => false,
            };
            all_removed &= removed;
        }
        (any_existed && all_removed, !any_existed || all_removed)
    } else {
        (false, true)
    };

    // state.json is the only ownership journal for the VS Code install.
    // Keep BLK intact when that uninstall is incomplete so a re-run still
    // knows it owns, and may safely remove, the remaining installation.
    if !vscode_cleanup_complete {
        return UninstallOutcome::Finished {
            profile_removed,
            blk_removed: false,
            blk_removal_partial: false,
            vscode_removed,
            invariant_guard_tripped: false,
        };
    }

    let (blk_removed, blk_removal_partial) = if blk.exists() {
        let attempted = runner.remove_dir_all(blk);
        if attempted.is_ok() && !blk.exists() {
            (true, false)
        } else {
            (false, true)
        }
    } else {
        (true, false)
    };

    UninstallOutcome::Finished {
        profile_removed,
        blk_removed,
        blk_removal_partial,
        vscode_removed,
        invariant_guard_tripped: false,
    }
}

#[cfg(test)]
#[path = "tests/uninstall.rs"]
mod tests;
