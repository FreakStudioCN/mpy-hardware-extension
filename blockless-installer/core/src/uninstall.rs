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
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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

    /// How long to keep re-checking that a removed directory has actually
    /// disappeared before concluding the removal failed.
    ///
    /// WHAT WAS OBSERVED, on the Windows Sandbox rig 2026-09-22: checking once,
    /// immediately, reported a failed uninstall on EVERY first attempt. The
    /// same snapshot that carried "VS Code could not be fully removed" also
    /// showed the directory gone, and a second uninstall then succeeded with
    /// nothing else changed. That false failure is not cosmetic -- it trips the
    /// `!vscode_cleanup_complete` bail-out below, so BLK is left on disk and
    /// the rest of the uninstall never runs.
    ///
    /// WHY, less certainly. Two mechanisms both fit, and the rig did not
    /// distinguish them:
    /// - Windows keeps a directory entry visible until the last handle to
    ///   anything inside it closes ("delete-pending"), so a tree that WAS
    ///   deleted can still answer `exists() == true` briefly.
    /// - Inno Setup's uninstaller is two-phase: `unins000.exe` (what
    ///   `run_vscode_uninstaller` waits on) exits when the second phase signals
    ///   it, and that second phase THEN deletes the directory. On this reading
    ///   the call returns before removal by design, with no handle race at all.
    ///
    /// Waiting fixes both, which is why this is written as a wait rather than
    /// as a claim about which one it is. The 10s default is a guess with
    /// headroom, not a measurement: the rig sampled every 30s and never
    /// bracketed the actual interval.
    ///
    /// Zero means check once and never sleep; the test runners return that, so
    /// the suite stays fast while production gets real tolerance.
    fn removal_settle_timeout(&self) -> Duration {
        Duration::from_secs(10)
    }
}

/// `true` once `path` is really gone, re-checking until the runner's
/// [`UninstallRunner::removal_settle_timeout`] elapses.
///
/// Returns immediately when the path is already absent, so the common case
/// costs nothing. Only a genuinely surviving directory pays the full wait,
/// and that one deserves to.
///
/// The rig documentation warns observers that "sampling 'is it gone?'
/// immediately after uninstall returns is not a measurement". The same applies
/// to the code doing the removing, where being fooled changes behaviour rather
/// than merely misleading a reader -- whichever of the two mechanisms in
/// [`UninstallRunner::removal_settle_timeout`] is responsible.
fn removal_settled(runner: &dyn UninstallRunner, path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    let deadline = Instant::now() + runner.removal_settle_timeout();
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if !path.exists() {
            return true;
        }
    }
    !path.exists()
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

#[path = "uninstall/storage.rs"]
mod storage;
use storage::{remove_storage_entry, storage_entry_confirmed_absent};

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
        /// `--keep-vscode` left an install this installer owns in place,
        /// AND `state.json` (the only ownership journal) is actually gone
        /// after this run. Checked directly against the journal's own
        /// path, not inferred from `blk_removed`: `remove_dir_all` is not
        /// atomic, so a `blk_removal_partial` run (a locked file elsewhere
        /// under `BLK`) can still have deleted `state.json` itself. Only
        /// `true` when tracking has actually been erased; an early return
        /// that leaves `BLK` intact for a re-run always sets this `false`,
        /// since `state.json` there still knows what it owns.
        vscode_kept_but_owned: bool,
        /// VS Code removal was attempted and did not fully complete, so
        /// this run stopped early with `BLK` and the journal deliberately
        /// left in place for a re-run to finish. Distinct from
        /// `vscode_removed: false` on a normal finish, which means either
        /// nothing was there to remove or removal was never attempted.
        vscode_removal_failed: bool,
    },
}

#[path = "uninstall/summary.rs"]
mod summary;
pub use summary::OutcomeSummary;

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
        remove_storage_entry(storage_path, profile_name, &profile_location);

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
        //
        // `removal_settled`, not a bare `exists()`, for the same reason the VS
        // Code and BLK removals use it: a directory removed moments ago can
        // still answer `exists() == true`. This path matters MORE than those
        // two, not less -- a false positive here trips the invariant guard,
        // which abandons the whole uninstall rather than just one step, and
        // leaves the journal claiming the profile is still ours.
        //
        // Missed in the first pass at this defect, which patched the other two
        // call sites and left the most severe one alone.
        let dir_still_present =
            loc_safe && !removal_settled(runner, &profiles_dir.join(&profile_location));

        if !entry_gone || dir_still_present {
            return UninstallOutcome::Finished {
                profile_removed: false,
                blk_removed: false,
                blk_removal_partial: false,
                vscode_removed: false,
                invariant_guard_tripped: true,
                // BLK, and the state.json inside it, are untouched on this
                // path -- ownership is still tracked, so nothing has been
                // silently dropped yet regardless of `flags.keep_vscode`.
                vscode_kept_but_owned: false,
                vscode_removal_failed: false,
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
                // `removal_settled`, not a bare `exists()`: VS Code's own
                // `unins000.exe` can return before its work is visible, and
                // Windows keeps the directory entry until the last handle
                // closes either way.
                Ok(true) => removal_settled(runner, vscode_dir),
                Ok(false) => {
                    runner.remove_dir_all(vscode_dir).is_ok() && removal_settled(runner, vscode_dir)
                }
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
            // `should_remove_vscode` (a precondition for reaching this
            // branch) requires `!flags.keep_vscode`, so this is always
            // false here; BLK is also untouched, so nothing has gone
            // untracked either way.
            vscode_kept_but_owned: false,
            vscode_removal_failed: true,
        };
    }

    let (blk_removed, blk_removal_partial) = if blk.exists() {
        let attempted = runner.remove_dir_all(blk);
        // Same delete-pending tolerance as the VS Code removal above: without
        // it, a successful BLK delete can report `blk_removal_partial`.
        if attempted.is_ok() && removal_settled(runner, blk) {
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
        // Checked against state.json directly, not `blk_removed`:
        // remove_dir_all is not atomic, so a locked file elsewhere under
        // BLK can still leave blk_removed: false while state.json itself
        // is already gone -- inferring from blk_removed would then wrongly
        // skip telling the operator that tracking really was lost.
        //
        // And only when an owned install is actually still THERE: a journal
        // that says "installed by us" for an editor the user already removed
        // by hand describes nothing left in place, and the note would send
        // them to remove something that does not exist.
        vscode_kept_but_owned: flags.keep_vscode
            && vscode_installed_by_us
            && !state_path.exists()
            && vscode_dirs.iter().any(|dir| dir.exists()),
        vscode_removal_failed: false,
    }
}

#[cfg(test)]
#[path = "tests/uninstall.rs"]
mod tests;
