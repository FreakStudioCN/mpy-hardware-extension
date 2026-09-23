//! The two `--keep-vscode` / removal-failed flags on `Finished`, and the
//! user-facing summary every shell renders from an outcome.

use super::*;

#[test]
fn keep_vscode_reports_ownership_when_journal_says_owned() {
    let l = layout("keep-vscode-owned");
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
            all: false,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished {
            vscode_kept_but_owned,
            ..
        } => assert!(vscode_kept_but_owned),
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn keep_vscode_with_partial_blk_removal_is_still_tracked() {
    // The exact scenario vscode_kept_but_owned's `blk_removed` conjunct
    // exists for: BLK removal is attempted (because --keep-vscode already
    // decided VS Code itself is left alone) but a locked file leaves it
    // only partially removed, so state.json survives -- tracking is
    // NOT lost, and the field must say so.
    let l = layout("keep-vscode-partial-blk");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
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
        &UninstallFlags {
            all: false,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished {
            vscode_kept_but_owned,
            blk_removed,
            blk_removal_partial,
            ..
        } => {
            assert!(
                !vscode_kept_but_owned,
                "BLK removal failed, so state.json survives -- tracking is not actually lost"
            );
            assert!(!blk_removed);
            assert!(blk_removal_partial);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(
        l.state_path.exists(),
        "the ownership journal must survive a failed BLK removal"
    );
}

#[test]
fn keep_vscode_with_state_json_gone_despite_partial_blk_removal_is_tracked_lost() {
    // remove_dir_all is not atomic: it can remove state.json itself before
    // hitting a locked SIBLING elsewhere under BLK, leaving blk_removed:
    // false (the directory still contains that sibling) while the journal
    // is already gone. vscode_kept_but_owned must check state.json
    // directly -- inferring it from blk_removed would wrongly skip warning
    // the operator that tracking really has been lost.
    let l = layout("keep-vscode-state-json-gone");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::write(l.blk.join("locked-sibling"), b"still here").unwrap();
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();
    runner.fail_remove_for.borrow_mut().push(l.blk.clone());
    *runner.delete_before_failing.borrow_mut() = Some(l.state_path.clone());

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
            all: false,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished {
            vscode_kept_but_owned,
            blk_removed,
            ..
        } => {
            assert!(
                !blk_removed,
                "the locked sibling must still block blk_removed"
            );
            assert!(
                vscode_kept_but_owned,
                "state.json is already gone, so tracking really is lost -- \
                 blk_removed alone must not be allowed to hide that"
            );
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(
        !l.state_path.exists(),
        "fixture sanity: state.json really is gone"
    );
}

#[test]
fn keep_vscode_reports_no_ownership_when_journal_says_not_owned() {
    let l = layout("keep-vscode-not-owned");
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
            all: false,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished {
            vscode_kept_but_owned,
            ..
        } => assert!(!vscode_kept_but_owned),
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn incomplete_vscode_removal_reports_removal_failed() {
    let l = layout("vscode-removal-incomplete");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    std::fs::create_dir_all(&l.vscode_dir).unwrap();
    let runner = FakeUninstallRunner::default();
    runner
        .fail_remove_for
        .borrow_mut()
        .push(l.vscode_dir.clone());

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
            vscode_removal_failed,
            blk_removed,
            ..
        } => {
            assert!(vscode_removal_failed);
            assert!(!blk_removed);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(l.vscode_dir.exists(), "the locked location must survive");
    assert!(
        l.state_path.exists(),
        "the ownership journal must survive so a re-run can finish"
    );
}

#[test]
fn clean_uninstall_does_not_report_removal_failed() {
    let l = layout("vscode-removal-clean");
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
        UninstallOutcome::Finished {
            vscode_removal_failed,
            vscode_removed,
            vscode_kept_but_owned,
            ..
        } => {
            assert!(!vscode_removal_failed);
            assert!(vscode_removed);
            assert!(
                !vscode_kept_but_owned,
                "--keep-vscode was not passed; nothing was kept"
            );
        }
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn owned_but_already_gone_reports_neither_removed_nor_failed() {
    // should_remove_vscode is true here (owned, no --keep-vscode), but the
    // location never existed -- covers the same `any_existed` branch as
    // `nothing_to_remove_reports_neither_kept_nor_failed` below, except with
    // vscode_installed_by_us TRUE, so should_remove_vscode's own `any_existed
    // && all_removed` / `!any_existed || all_removed` pair is actually
    // exercised here rather than short-circuited by `should_remove_vscode`
    // being false.
    let l = layout("vscode-owned-already-gone");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    // `l.vscode_dir` is deliberately never created.
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
            vscode_removal_failed,
            vscode_removed,
            blk_removed,
            ..
        } => {
            assert!(!vscode_removal_failed);
            assert!(!vscode_removed);
            assert!(blk_removed);
        }
        other => panic!("expected Finished, got {other:?}"),
    }
}

#[test]
fn nothing_to_remove_reports_neither_kept_nor_failed() {
    let l = layout("vscode-nothing-to-remove");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = false;
    write_state(&l.state_path, &state);
    // `l.vscode_dir` is deliberately never created: nothing exists to remove.
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
            vscode_kept_but_owned,
            vscode_removal_failed,
            vscode_removed,
            ..
        } => {
            assert!(!vscode_kept_but_owned);
            assert!(!vscode_removal_failed);
            assert!(!vscode_removed);
        }
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

/// The note says VS Code "is being left in place". A journal that still
/// says "installed by us" for an editor the user already removed by hand
/// describes nothing in place, and the note would send them to remove
/// something that does not exist.
#[test]
fn keep_vscode_reports_no_ownership_when_the_owned_install_is_already_gone() {
    let l = layout("keep-vscode-owned-but-gone");
    let mut state = default_state();
    state.profile_created_by_us = false;
    state.vscode_installed_by_us = true;
    write_state(&l.state_path, &state);
    // `l.vscode_dir` is deliberately never created.
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
            all: false,
            keep_vscode: true,
        },
    );

    match outcome {
        UninstallOutcome::Finished {
            vscode_kept_but_owned,
            blk_removed,
            ..
        } => {
            assert!(blk_removed, "the journal really was removed");
            assert!(
                !vscode_kept_but_owned,
                "nothing was left in place, so nothing may be reported as kept"
            );
        }
        other => panic!("expected Finished, got {other:?}"),
    }
}

fn finished(
    invariant_guard_tripped: bool,
    vscode_removal_failed: bool,
    vscode_kept_but_owned: bool,
) -> UninstallOutcome {
    UninstallOutcome::Finished {
        profile_removed: true,
        blk_removed: !invariant_guard_tripped && !vscode_removal_failed,
        blk_removal_partial: false,
        vscode_removed: false,
        invariant_guard_tripped,
        vscode_kept_but_owned,
        vscode_removal_failed,
    }
}

/// One mapping for every shell. `ok` is false exactly when the user still
/// has something to do before a re-run can finish; the wording is what the
/// CLI has always printed, so a GUI user and a CLI user read the same
/// sentence for the same outcome.
#[test]
fn summary_marks_every_outcome_the_user_must_act_on_as_not_ok() {
    let hint = "HINT";
    let s = UninstallOutcome::VscodeRunning.summary(hint);
    assert!(!s.ok);
    assert_eq!(
        s.message,
        "VS Code is running; quit it and re-run to uninstall. Nothing was removed."
    );

    let s = UninstallOutcome::ProcessCheckFailed.summary(hint);
    assert!(!s.ok);
    assert_eq!(
        s.message,
        "could not confirm VS Code is closed; nothing was removed."
    );

    let s = UninstallOutcome::AbortedUnreadableState.summary(hint);
    assert!(!s.ok);
    assert!(s
        .message
        .starts_with("state.json exists but is unreadable/incomplete"));
    assert!(s.message.ends_with("Nothing was removed."));

    let s = finished(true, false, false).summary(hint);
    assert!(!s.ok);
    assert!(s.message.contains("ownership journal was left intact"));

    let s = finished(false, true, false).summary(hint);
    assert!(!s.ok);
    // Assert the SHAPE, not a literal: it must still say what happened and
    // what to do, and must not leak internal identifiers into text a user
    // reads. Pinning the exact sentence is what let
    // "profile_removed=true; BLK was left in place" survive into the GUI.
    assert!(
        s.message.contains("Uninstall again"),
        "a recoverable failure must tell the user how to finish: {}",
        s.message
    );
    assert!(
        s.message.contains("profile was removed"),
        "must still report the profile outcome: {}",
        s.message
    );
    assert!(
        !s.message.contains("BLK"),
        "internal shell variable name leaked into user-facing text: {}",
        s.message
    );
    assert!(
        !s.message.contains("profile_removed="),
        "raw struct field name leaked into user-facing text: {}",
        s.message
    );

    let s = finished(false, false, false).summary(hint);
    assert!(s.ok);
    assert_eq!(
        s.message,
        "Uninstalled. Removed the Blockless editor profile and the Blockless folder."
    );
    // The success path is user-facing too, and is the one EVERY clean
    // uninstall shows. It used to read
    // "done: profile_removed=true blk_removed=true blk_removal_partial=false
    // vscode_removed=false".
    assert!(
        !s.message.contains("profile_removed=") && !s.message.contains("blk_removed="),
        "raw struct field names leaked into user-facing text: {}",
        s.message
    );
}

/// Two sentences of one message must not contradict each other: a partial
/// removal is neither "Uninstalled." nor "nothing left to remove", and a VS
/// Code failure after the profile went is not "nothing else was deleted".
#[test]
fn summary_never_contradicts_itself() {
    let partial = UninstallOutcome::Finished {
        profile_removed: false,
        blk_removed: false,
        blk_removal_partial: true,
        vscode_removed: false,
        invariant_guard_tripped: false,
        vscode_kept_but_owned: false,
        vscode_removal_failed: false,
    }
    .summary("HINT");
    assert!(
        !partial.message.contains("nothing left to remove")
            && !partial.message.starts_with("Uninstalled."),
        "{}",
        partial.message
    );
    assert!(partial.message.contains("could not be deleted"));

    let failed = finished(false, true, false).summary("HINT");
    assert!(
        !failed.message.contains("nothing else was deleted"),
        "the profile WAS deleted in this outcome: {}",
        failed.message
    );
}

/// The ownership note ends with whatever the shell can actually offer: the
/// CLI names its `--all` flag, the GUI has no flags and must not name one.
#[test]
fn summary_ownership_note_takes_the_shells_own_removal_hint() {
    let s = finished(false, false, true).summary("--all is the only way to remove it later");
    assert!(s.ok);
    let (first, note) = s
        .message
        .split_once('\n')
        .expect("the note is its own line after the summary");
    assert!(first.starts_with("Uninstalled. "));
    assert_eq!(
        note,
        "note: VS Code was installed by this installer and is being left in place; it is no \
         longer tracked, and --all is the only way to remove it later."
    );

    let s = finished(false, false, true).summary("remove it by hand");
    assert!(s.message.ends_with("and remove it by hand."));
    assert!(!s.message.contains("--all"));
}
