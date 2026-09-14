//! A typed progress signal for a long-lived host (a future GUI shell) to
//! render, additive to the `tracing::info!`/`warn!` lines `ops.rs` already
//! emits -- neither replaces the other. Not a `tracing-subscriber` bridge
//! (message-string matching a log line is fragile) and not a channel (a
//! sink is the same thing without an ownership question: `OpsContext`
//! borrows it, the caller owns it, no receiver to drain or drop).
//!
//! Every `StepFinished` fires AFTER that step's own journal write
//! (`stamp_and_write`), never before, so a listener can never be told a
//! step finished that `state.json` does not yet reflect. There is no
//! `OpFailed` variant: on error an op returns `Err` (or, for `uninstall`,
//! its outcome enum) and the caller renders failure from that `Result`
//! directly.
//!
//! So the rule for `OpFinished`, in one sentence: it fires when the op
//! function RETURNS rather than propagating `Err`, which means the verdict
//! travels only in the return value and never in the event stream. Read it
//! as "the op ended", not "the op succeeded". `install`, `repair`,
//! `repair_runtime`, `update_extension` and `diagnostics` skip it on the
//! error path because `?` returns first. `verify` and `uninstall` are
//! infallible by signature and so always emit it: a 3-of-7 verify and an
//! uninstall that refused because VS Code was running have both ENDED, and
//! their verdicts live in `Vec<CheckResult>` and `UninstallOutcome`. An
//! earlier wording here said "only ever fires on the success path", which
//! reads as a promise the two infallible ops cannot keep, and was twice
//! misread as a defect in them.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ProgressEvent {
    OpStarted {
        op: &'static str,
    },
    StepStarted {
        op: &'static str,
        step: u8,
        name: &'static str,
    },
    StepFinished {
        op: &'static str,
        step: u8,
        name: &'static str,
        skipped: Option<bool>,
    },
    OpFinished {
        op: &'static str,
    },
}

/// Injected into [`crate::ops::OpsContext`] so every op stays testable
/// against a fake the same way the rest of the core is; the one real sink
/// for an actual host forwards each event on (the CLI uses [`NoopSink`], a
/// future GUI shell forwards to its window). `Sync`, not `Send + Sync`:
/// `OpsContext` only ever borrows it (`&'a dyn ProgressSink`), never moves
/// it across a thread boundary on its own.
pub trait ProgressSink: Sync {
    fn emit(&self, event: &ProgressEvent);
}

/// The CLI's sink: progress events change nothing about its output, which
/// stays exactly the `tracing` lines it already prints.
pub struct NoopSink;

impl ProgressSink for NoopSink {
    fn emit(&self, _event: &ProgressEvent) {}
}
