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
            UninstallOutcome::Finished {
                vscode_removal_failed: true,
                profile_removed,
                ..
            } => (
                false,
                format!(
                    "VS Code could not be fully removed; the ownership journal was kept so a \
                     re-run can finish. profile_removed={profile_removed}; BLK was left in place."
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
                let mut message = format!(
                    "done: profile_removed={profile_removed} blk_removed={blk_removed} \
                     blk_removal_partial={blk_removal_partial} vscode_removed={vscode_removed}"
                );
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
