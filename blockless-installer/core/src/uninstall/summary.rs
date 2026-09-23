//! The user-facing rendering of an [`UninstallOutcome`], shared by every
//! shell. Split out of `uninstall.rs` for size only.

use super::UninstallOutcome;

/// What a shell tells the user about an [`UninstallOutcome`]. One mapping
/// for every shell, so the CLI and the GUI can never drift apart on the
/// wording -- a copy in each shell with a test asserting the literals stay
/// equal is what this replaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeSummary {
    /// `false` whenever the user still has something to do (quit VS Code,
    /// fix `state.json`, re-run to finish). Every such outcome left the
    /// machine in a state a re-run can pick up from, so a shell should
    /// offer the re-run, not a dead end.
    pub ok: bool,
    /// The full user-facing text. A `Finished` run that gave up VS Code's
    /// ownership record appends a `note:` line, separated by `\n`.
    pub message: String,
}

impl UninstallOutcome {
    /// `later_removal_hint` completes the ownership note's last sentence,
    /// "it is no longer tracked, and {hint}." Each shell says what IT can
    /// offer: the CLI names its `--all` flag, the GUI has no such flag and
    /// must not pretend to.
    pub fn summary(&self, later_removal_hint: &str) -> OutcomeSummary {
        let (ok, message) = match self {
            UninstallOutcome::VscodeRunning => (
                false,
                "VS Code is running; quit it and re-run to uninstall. Nothing was removed."
                    .to_string(),
            ),
            UninstallOutcome::ProcessCheckFailed => (
                false,
                "could not confirm VS Code is closed; nothing was removed.".to_string(),
            ),
            UninstallOutcome::AbortedUnreadableState => (
                false,
                "state.json exists but is unreadable/incomplete; cannot determine what to \
                 remove. Nothing was removed."
                    .to_string(),
            ),
            UninstallOutcome::Finished {
                invariant_guard_tripped: true,
                ..
            } => (
                false,
                "could not confirm the profile was fully removed; the ownership journal was \
                 left intact so a re-run can finish. Nothing else was removed."
                    .to_string(),
            ),
            // Worded for the person reading it, not for the codebase. This
            // used to say "profile_removed={bool}; BLK was left in place" --
            // a raw struct field and an M0 shell variable name (see
            // `platform.rs`'s `BLK`/`CODE_USER`/`STORAGE`/`ENVPY`), shown in
            // red to a student running a one-click installer. It was precise
            // and honest, which is the hard part; it just named things in our
            // vocabulary rather than theirs. Keep the precision, drop the
            // jargon, and say what to do next.
            UninstallOutcome::Finished {
                vscode_removal_failed: true,
                profile_removed,
                ..
            } => (
                false,
                format!(
                    "VS Code could not be fully removed, so the uninstall stopped before \
                     deleting your Blockless folder. It is still on disk and this installer \
                     still knows it owns it, so running Uninstall again will finish the job.{}",
                    if *profile_removed {
                        " The Blockless editor profile was removed before that."
                    } else {
                        " The Blockless editor profile was not removed either."
                    }
                ),
            ),
            UninstallOutcome::Finished {
                profile_removed,
                blk_removed,
                blk_removal_partial,
                vscode_removed,
                vscode_kept_but_owned,
                ..
            } => {
                // Also worded for the person reading it. This used to render
                // as "done: profile_removed=true blk_removed=true
                // blk_removal_partial=false vscode_removed=true" -- four raw
                // struct fields, shown in the GUI on the SUCCESS path, so
                // every user who uninstalls cleanly saw it. Caught by the
                // rig's own "no internal identifiers in user-facing text"
                // check on 2026-09-22, after the failure-path wording had
                // already been fixed and this one deliberately left alone.
                let mut removed: Vec<&str> = Vec::new();
                if *profile_removed {
                    removed.push("the Blockless editor profile");
                }
                if *blk_removed {
                    removed.push("the Blockless folder");
                }
                if *vscode_removed {
                    removed.push("VS Code");
                }
                // Leftover files make "Uninstalled." and "nothing left to
                // remove" untrue, so a partial removal changes the lead too.
                let lead = if *blk_removal_partial {
                    "Partly uninstalled."
                } else {
                    "Uninstalled."
                };
                let mut message = match removed.len() {
                    0 if *blk_removal_partial => lead.to_string(),
                    0 => format!("{lead} There was nothing left to remove."),
                    1 => format!("{lead} Removed {}.", removed[0]),
                    _ => {
                        let last = removed.pop().expect("len >= 2");
                        format!("{lead} Removed {} and {last}.", removed.join(", "))
                    }
                };
                if *blk_removal_partial {
                    message.push_str(
                        " Some files in the Blockless folder could not be deleted and are \
                         still on disk.",
                    );
                }
                if *vscode_kept_but_owned {
                    message.push_str(&format!(
                        "\nnote: VS Code was installed by this installer and is being left in \
                         place; it is no longer tracked, and {later_removal_hint}."
                    ));
                }
                (true, message)
            }
        };
        OutcomeSummary { ok, message }
    }
}
