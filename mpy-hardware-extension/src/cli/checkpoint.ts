// Per-phase snapshots of the project tree, into <project>/.mpyhw/checkpoints/<phase>/.
//
// Without these, no single phase can be re-run from a real starting state. Every phase overwrites
// main.py and project-manifest.json in place, and scaffold never commits, so once generate has run
// there is nothing left on disk OR in git describing the post-scaffold project. Resuming from a
// finished archive then hands the model work already done: one run "passed" generate having never
// invoked its validator once, which read as a green run and was not one.
//
// Best-effort by design: a failed snapshot must never fail the run it is observing. It is
// diagnostic scaffolding, not a phase result. Note that "never fail the run" is a reason not to
// THROW, and not a reason not to await -- see createCheckpointQueue.
//
// Extracted from the e2e harness so it can be tested at all. The harness module runs a whole build
// at import (top-level await, process.exit), so nothing inside it can be reached from a test. The
// two other pieces this CLI relies on, resume-point and firmware-evidence, were pulled out for the
// same reason; this one was left behind and its guards therefore had no tests.
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export type CheckpointLog = (message: string) => void;

/**
 * The single path segment a phase is allowed to become.
 *
 * `dest` is handed to a recursive rm and then to a rename, so it is the destructive one, and it
 * must not be able to leave the checkpoints directory. Two separate things are needed. Replacing
 * the separators stops `a/../b`. Refusing the all-dot tokens stops `..`, which is a traversal
 * WITHOUT a separator and which the character class alone passes through untouched -- and `..`
 * here resolves dest to `.mpyhw` itself, so the rm would take the session log and every other
 * checkpoint with it.
 *
 * A canonical phase (`upy-deploy-plugin`) passes through unchanged.
 */
export function checkpointSegment(phase: string): string {
  return /^\.+$/.test(phase) ? "_" : phase.replace(/[^\w.-]/g, "_");
}

/** Copy the project tree into its checkpoint slot. Resolves even when it fails. */
export async function snapshotCheckpoint(
  projectDir: string,
  phase: string,
  log: CheckpointLog = console.log,
  warn: CheckpointLog = console.warn,
): Promise<void> {
  if (!phase) return;
  const safePhase = checkpointSegment(phase);
  const dest = join(projectDir, ".mpyhw", "checkpoints", safePhase);
  // Staged OUTSIDE the project, then moved in: fs.cp refuses a copy whose destination is inside
  // the source tree, up front and regardless of the filter (EINVAL, "cannot copy X to a
  // subdirectory of self"). The staging dir is a sibling of the project so the rename stays on
  // one filesystem.
  const staging = join(dirname(projectDir), `.ckpt-${safePhase}-tmp`);
  try {
    await rm(staging, { recursive: true, force: true });
    // Skip .mpyhw itself: it holds the session log and these very checkpoints, so copying it in
    // would nest the run's own history one level deeper on every phase.
    await cp(projectDir, staging, {
      recursive: true,
      filter: (src) => !src.includes(`${sep}.mpyhw`),
    });
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    log(`  [checkpoint] ${phase} -> .mpyhw/checkpoints/${safePhase}`);
  } catch (err: any) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    warn(`  [checkpoint] ${phase} not saved: ${err?.message ?? err}`);
  }
}

/**
 * Snapshots taken in order, with one point where the run can wait for them.
 *
 * The harness takes these from a void event callback the protocol loop never awaits, so the
 * original `void snapshotCheckpoint(current)` raced two things: the NEXT phase, which rewrites
 * main.py while cp is reading it, and process.exit, which killed the last phase's copy before its
 * rename. Serializing closes the exit truncation and stops two copies of one tree fighting over
 * the same staging-then-rename. It does NOT stop the next phase writing while a copy reads --
 * nothing awaits the queue mid-run, deliberately, so a slow copy never blocks the phase that
 * follows.
 *
 * `snapshot` takes the phase as an ARGUMENT, which is the part that matters. Reading a mutable
 * `current` inside the queued callback filed a delayed snapshot under whichever phase had started
 * by the time it ran -- precisely when a copy was slow, which is the case the queue exists for.
 * As a parameter it is captured when the call is made and cannot drift.
 */
export function createCheckpointQueue(
  projectDir: string,
  log: CheckpointLog = console.log,
  warn: CheckpointLog = console.warn,
) {
  let chain: Promise<void> = Promise.resolve();
  return {
    snapshot(phase: string): void {
      chain = chain.then(() => snapshotCheckpoint(projectDir, phase, log, warn));
    },
    /** Every snapshot taken so far, finished. Never rejects, so it cannot fail a passing run. */
    drain(): Promise<void> {
      return chain;
    },
  };
}
