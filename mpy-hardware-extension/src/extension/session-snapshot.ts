// The session snapshot (#95 Save Version / #88 restore contract). One fixed-name
// snapshot.json per session under <sessionDir>/checkpoints/, overwritten on re-save
// (git commits are the history mechanism; the latest snapshot wins). The file is
// PORTABLE (§4.2): it carries NO absolute paths — every file reference is relative to
// the artifact root, so a snapshot copied between machines still resolves.
//
// buildSessionSnapshot is pure (unit-testable, no fs/clock side effects beyond the
// injected savedAt); writeSessionSnapshot does the mkdir + writeFile and surfaces any
// non-ENOENT fs error verbatim (never blanket-swallows — recurring reviewer finding).

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SNAPSHOT_SCHEMA = "blockless-session-snapshot";
export const SNAPSHOT_VERSION = 1;

// One artifact row projected from the Artifact Browser index, MINUS absolute_path
// (portability). sha256 lets #88 verify integrity before replaying code_updated from disk.
export interface SnapshotArtifact {
  relative_path: string;
  kind: string;
  role: string;
  phase: string;
  size: number;
  sha256: string;
  created_at: string;
}

// The controller state a snapshot captures (getSnapshotState()), plus the panel-supplied
// context (artifacts, diagnostics, git linkage). Every field is present-or-explicit-null so
// #88 can rely on the schema shape rather than probing for missing keys.
export interface SnapshotInput {
  traceId: string | null;
  savedAt: string;                       // ISO, injected (pure function stays deterministic)
  currentPhase: string | null;
  terminal: string | null;               // last session_done terminal (new accumulator)
  state: { manifest?: unknown; phase?: string; intent?: string } | undefined; // controller.state
  boardId: string | null;
  preSelectedBoard: unknown;
  boardSelectionMode: string | undefined;
  preferences: { mode?: string; locale?: string; existing_hardware?: string } | undefined;
  manifest: unknown;                     // enriched wiring-bearing manifest
  diagram: unknown;                      // authored diagram, or null (derive fallback in #88)
  credits: { balance?: number; dailyGrant?: number; resetsAt?: string; capturedAt?: string } | null;
  diagnostics: Record<string, string>;
  artifacts: SnapshotArtifact[];
  git: { commit_hash: string; branch: string } | null;
}

export interface SessionSnapshot {
  schema: string;
  version: number;
  saved_at: string;
  trace_id: string;
  stage: { current_phase: string; state_phase: string; terminal: string; intent: string };
  state: { manifest: unknown; phase: string; intent: string };
  board: { board_id: string; pre_selected_board: unknown; board_selection_mode: string };
  preferences: { mode: string; locale: string; existing_hardware: string };
  manifest: unknown;
  diagram: unknown;
  artifacts: SnapshotArtifact[];
  credits: { balance: number; daily_grant: number; resets_at: string; captured_at: string } | null;
  diagnostics: { selected_board: string; key_errors: string; recent_activity: string; last_command: string };
  git: { commit_hash: string; branch: string } | null;
  restore: { mechanism: string; phase: string; board_id: string };
}

const RESTORE_MECHANISM = "startPhase";

// Coerce a nullable string into an empty-string default so every stage/board key is a
// present string (the #88 contract keys on presence, not on the key existing).
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Pure projection of controller + panel context into the schema-v1 object. No absolute
// paths (artifacts carry relative_path only); no fs access.
export function buildSessionSnapshot(input: SnapshotInput): SessionSnapshot {
  const statePhase = str(input.state?.phase);
  const intent = str(input.state?.intent);
  return {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    saved_at: input.savedAt,
    trace_id: str(input.traceId),
    stage: {
      current_phase: str(input.currentPhase),
      state_phase: statePhase,
      terminal: str(input.terminal),
      intent,
    },
    state: {
      manifest: input.state?.manifest ?? null,
      phase: statePhase,
      intent,
    },
    board: {
      board_id: str(input.boardId),
      pre_selected_board: input.preSelectedBoard ?? null,
      board_selection_mode: str(input.boardSelectionMode),
    },
    preferences: {
      mode: str(input.preferences?.mode),
      locale: str(input.preferences?.locale),
      existing_hardware: str(input.preferences?.existing_hardware),
    },
    manifest: input.manifest ?? null,
    diagram: input.diagram ?? null,
    artifacts: input.artifacts,
    credits: input.credits
      ? {
        balance: input.credits.balance ?? 0,
        daily_grant: input.credits.dailyGrant ?? 0,
        resets_at: str(input.credits.resetsAt),
        captured_at: str(input.credits.capturedAt),
      }
      : null,
    diagnostics: {
      selected_board: str(input.diagnostics.selected_board),
      key_errors: str(input.diagnostics.key_errors),
      recent_activity: str(input.diagnostics.recent_activity),
      last_command: str(input.diagnostics.last_command),
    },
    git: input.git,
    restore: {
      mechanism: RESTORE_MECHANISM,
      phase: statePhase,
      board_id: str(input.boardId),
    },
  };
}

// The single-source path for the snapshot (checkpoints/snapshot.json under the session dir).
export function snapshotPath(sessionDir: string): string {
  return join(sessionDir, "checkpoints", "snapshot.json");
}

// mkdir -p checkpoints/ then write snapshot.json. A missing parent is created (never an
// error); any OTHER fs error (EACCES/EROFS/ENOTDIR) surfaces verbatim — the caller turns it
// into the snapshot_write_failed taxonomy code. Never blanket-swallow (recurring finding).
export async function writeSessionSnapshot(sessionDir: string, snapshot: SessionSnapshot): Promise<string> {
  const target = snapshotPath(sessionDir);
  await mkdir(join(sessionDir, "checkpoints"), { recursive: true });
  // Atomic overwrite: write a temp file then rename over the target. snapshot.json is the ONLY
  // restore point (fixed name, previous content replaced), so a crash mid-write must not truncate
  // it to a half-written, unparseable file. rename() is atomic on the same filesystem.
  const tmp = target + ".tmp";
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
  await rename(tmp, target);
  return target;
}
