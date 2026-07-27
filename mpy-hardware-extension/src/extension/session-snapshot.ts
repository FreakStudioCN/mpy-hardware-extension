// The session snapshot: written by Save Version, read by welcome-page session restore. One fixed-name
// snapshot.json per session under <sessionDir>/checkpoints/, overwritten on re-save
// (git commits are the history mechanism; the latest snapshot wins). The file is
// PORTABLE (§4.2): it carries NO absolute paths — every file reference is relative to
// the artifact root, so a snapshot copied between machines still resolves.
//
// buildSessionSnapshot is pure (unit-testable, no fs/clock side effects beyond the
// injected savedAt); writeSessionSnapshot does the mkdir + writeFile and surfaces any
// non-ENOENT fs error verbatim (never blanket-swallows — recurring reviewer finding).

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { selectRecentSessionIds, sessionsDir } from "./session-recorder.ts";

export const SNAPSHOT_SCHEMA = "blockless-session-snapshot";
export const SNAPSHOT_VERSION = 1;

// One artifact row projected from the Artifact Browser index, MINUS absolute_path
// (portability). sha256 is a REAL digest computed fresh at snapshot-write time so session restore can verify
// integrity before replaying code_updated from disk. It is `null` (never "") when no digest could
// be produced — the file was unreadable or over the hash bound — so the consumer can distinguish
// "not verified" from a valid digest instead of treating an empty string as a match.
export interface SnapshotArtifact {
  relative_path: string;
  kind: string;
  role: string;
  phase: string;
  size: number;
  sha256: string | null;
  created_at: string;
}

// The controller state a snapshot captures (getSnapshotState()), plus the panel-supplied
// context (artifacts, diagnostics, git linkage). Every field is present-or-explicit-null so
// session restore can rely on the schema shape rather than probing for missing keys.
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
  diagram: unknown;                      // authored diagram, or null (session restore derives a fallback)
  optionalNextPhases: Array<{ phase?: string; reason?: string }>; // wiring/diagram flows a successful generate offered
  generatePhaseComplete: unknown;        // the upstream generate phase_complete an optional-flow re-run needs, or null
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
  optional_flows: { offered: Array<{ phase?: string; reason?: string }>; generate_phase_complete: unknown };
  artifacts: SnapshotArtifact[];
  credits: { balance: number; daily_grant: number; resets_at: string; captured_at: string } | null;
  diagnostics: { selected_board: string; key_errors: string; recent_activity: string; last_command: string };
  git: { commit_hash: string; branch: string } | null;
  restore: { mechanism: string; phase: string; board_id: string };
}

const RESTORE_MECHANISM = "startPhase";

// Coerce a nullable string into an empty-string default so every stage/board key is a
// present string (the restore contract keys on presence, not on the key existing).
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
    optional_flows: {
      offered: Array.isArray(input.optionalNextPhases) ? input.optionalNextPhases : [],
      generate_phase_complete: input.generatePhaseComplete ?? null,
    },
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

// One commit's phase/artifact association, projected from the session snapshot that recorded it.
export interface SnapshotAssociation {
  phase: string;
  saved_at: string;
  intent: string;
  session_id: string;
  artifact_total: number;
  artifacts: Array<{ relative_path: string; phase: string }>;
}

const ASSOCIATION_ARTIFACTS_MAX = 20; // display-capped artifact rows per commit (total carried separately)

// Index each session's LATEST snapshot by its git commit_hash, so the Git History view can
// associate a commit with the phase + artifacts saved at that commit. Read-only and bounded to the
// newest `cap` sessions. Association is latest-save-ONLY by design: snapshot.json is one fixed-name
// file overwritten per re-save (see the header), so an earlier same-session commit has no snapshot
// and the caller falls back to the commit subject. Error policy (recurring finding — swallow only
// ENOENT): a missing sessions dir or a session with no snapshot -> skip; a REAL fs read error
// (EACCES/EROFS) surfaces; corrupt JSON / foreign schema skips that ONE file (logged) so a single
// bad session never crashes the scan.
export async function listSessionSnapshots(sessionRoot: string, cap: number, log?: (message: string) => void): Promise<Map<string, SnapshotAssociation>> {
  const out = new Map<string, SnapshotAssociation>();
  let ids: string[];
  try {
    ids = await readdir(sessionsDir(sessionRoot));
  } catch (error: any) {
    if (error?.code === "ENOENT") return out; // no sessions dir yet
    throw error;                              // EACCES/… on the dir surfaces, never read as "empty"
  }
  for (const id of selectRecentSessionIds(ids).slice(0, Math.max(0, cap))) {
    let raw: string;
    try {
      raw = await readFile(snapshotPath(join(sessionsDir(sessionRoot), id)), "utf-8");
    } catch (error: any) {
      if (error?.code === "ENOENT") continue; // this session predates Save Version / was never saved
      throw error;                            // a real read error surfaces (recurring finding)
    }
    let snap: any;
    try { snap = JSON.parse(raw); } catch (error: any) { log?.(`git_history association: skipping ${id} (corrupt snapshot): ${error?.message ?? error}`); continue; }
    if (snap?.schema !== SNAPSHOT_SCHEMA || snap?.version !== SNAPSHOT_VERSION) continue; // foreign shape
    const hash = snap?.git?.commit_hash;
    if (typeof hash !== "string" || !hash || out.has(hash)) continue; // no linkage, or newer save already won
    const artifacts = Array.isArray(snap.artifacts) ? snap.artifacts : [];
    out.set(hash, {
      phase: (snap.stage?.current_phase || snap.state?.phase || ""),
      saved_at: snap.saved_at || "",
      intent: (snap.stage?.intent || snap.state?.intent || ""),
      session_id: snap.trace_id || id,
      artifact_total: artifacts.length,
      artifacts: artifacts.slice(0, ASSOCIATION_ARTIFACTS_MAX).map((a: any) => ({ relative_path: a?.relative_path || "", phase: a?.phase || "" })),
    });
  }
  return out;
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
  try {
    await rename(tmp, target);
  } catch (error) {
    // A failed rename would otherwise leave snapshot.json.tmp orphaned under checkpoints/. Remove it
    // best-effort — the cleanup's OWN failure (EACCES/EBUSY on rm) must never mask the rename error we
    // are about to rethrow (force:true only suppresses ENOENT).
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

// Read + validate the session snapshot for restore. Returns the parsed snapshot, or null when there
// is simply none for this session (ENOENT — a pre-Save-Version session, or one never saved). Any OTHER
// read failure (EACCES/EROFS), invalid JSON, or a schema/version mismatch THROWS — a real failure must
// never masquerade as "no snapshot" (recurring finding: fs reads swallow only ENOENT), and restore must
// not replay a shape it doesn't understand.
export async function readSessionSnapshot(sessionDir: string): Promise<SessionSnapshot | null> {
  const target = snapshotPath(sessionDir);
  let raw: string;
  try {
    raw = await readFile(target, "utf-8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null; // no snapshot for this session — caller degrades (view-log / disabled)
    throw error; // EACCES / EROFS / … — surface, never swallow
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`session snapshot at ${target} is not valid JSON: ${error?.message ?? error}`);
  }
  const snap = parsed as Partial<SessionSnapshot>;
  if (snap?.schema !== SNAPSHOT_SCHEMA) {
    throw new Error(`session snapshot at ${target} has schema "${snap?.schema}", expected "${SNAPSHOT_SCHEMA}"`);
  }
  if (snap?.version !== SNAPSHOT_VERSION) {
    throw new Error(`session snapshot at ${target} is version ${snap?.version}, unsupported (expected ${SNAPSHOT_VERSION})`);
  }
  return snap as SessionSnapshot;
}
