import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionSnapshot,
  writeSessionSnapshot,
  snapshotPath,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_VERSION,
  type SnapshotInput,
} from "../src/extension/session-snapshot.ts";

// A fully-populated input, mirroring what the panel passes from the controller state bundle.
function fullInput(): SnapshotInput {
  return {
    traceId: "session-abc",
    savedAt: "2026-07-22T02:00:00.000Z",
    currentPhase: "generate",
    terminal: "done",
    state: { manifest: { devices: [{ id: "dht22" }] }, phase: "generate", intent: "temp logger" },
    boardId: "ESP32_GENERIC_C6",
    preSelectedBoard: { id: "ESP32_GENERIC_C6", display_name: "ESP32-C6-DevKitC-1" },
    boardSelectionMode: "recommend",
    preferences: { mode: "beginner", locale: "en", existing_hardware: "none" },
    manifest: { devices: [{ id: "dht22", wiring: { pin: 4 } }] },
    diagram: { nodes: 3 },
    credits: { balance: 42, dailyGrant: 100, resetsAt: "2026-07-23T00:00:00Z", capturedAt: "2026-07-22T01:59:00Z" },
    diagnostics: { selected_board: "ESP32-C6-DevKitC-1", key_errors: "", recent_activity: "generate; deploy", last_command: "deploy" },
    artifacts: [
      { relative_path: "blockless-project/main.py", kind: "code", role: "firmware", phase: "generate", size: 512, sha256: "deadbeef", created_at: "2026-07-22T01:58:00Z" },
    ],
    git: { commit_hash: "1234567", branch: "main" },
  };
}

test("buildSessionSnapshot: every session-restore field is present and carries the source data", () => {
  const snap = buildSessionSnapshot(fullInput());
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  // The six session-restore fields — presence is the contract (restore keys on the schema, not on probing).
  assert.deepEqual(snap.board, { board_id: "ESP32_GENERIC_C6", pre_selected_board: { id: "ESP32_GENERIC_C6", display_name: "ESP32-C6-DevKitC-1" }, board_selection_mode: "recommend" });
  assert.equal(snap.state.phase, "generate");
  assert.equal(snap.manifest && (snap.manifest as any).devices[0].wiring.pin, 4, "wiring rides in the manifest");
  assert.deepEqual(snap.preferences, { mode: "beginner", locale: "en", existing_hardware: "none" });
  assert.equal(snap.credits?.balance, 42, "credits captured (advisory)");
  assert.equal(snap.artifacts[0].relative_path, "blockless-project/main.py", "code captured by reference");
  // Restore entry (the acceptance field session restore invokes).
  assert.deepEqual(snap.restore, { mechanism: "startPhase", phase: "generate", board_id: "ESP32_GENERIC_C6" });
});

test("buildSessionSnapshot: missing pieces are explicit nulls/empties, never dropped keys", () => {
  const snap = buildSessionSnapshot({
    traceId: null, savedAt: "2026-07-22T02:00:00.000Z", currentPhase: null, terminal: null,
    state: undefined, boardId: null, preSelectedBoard: undefined, boardSelectionMode: undefined,
    preferences: undefined, manifest: undefined, diagram: undefined, credits: null,
    diagnostics: {}, artifacts: [], git: null,
  });
  // Keys exist with explicit empty/null so session restore can rely on the shape.
  for (const key of ["stage", "state", "board", "preferences", "manifest", "diagram", "credits", "diagnostics", "artifacts", "git", "restore"]) {
    assert.ok(key in snap, `key ${key} present`);
  }
  assert.equal(snap.credits, null);
  assert.equal(snap.git, null);
  assert.equal(snap.manifest, null);
  assert.equal(snap.board.board_id, "");
  assert.deepEqual(snap.artifacts, []);
});

test("buildSessionSnapshot: JSON round-trips losslessly over a sweep of inputs — an undefined value never drops a key (property)", () => {
  // JSON.stringify DROPS any key whose value is `undefined`, so if build() emits an undefined
  // VALUE for a field (e.g. a `?? null` guard removed), the WRITTEN snapshot silently loses that
  // key and session restore's "every key present" contract breaks. The old fixture-only "no absolute path"
  // test was vacuous (build() copies artifacts verbatim; the strip lives upstream in the panel).
  // Assert parse(stringify(x)) deep-equals x across full / all-empty / partial inputs.
  const base = fullInput();
  const allEmpty: SnapshotInput = {
    traceId: null, savedAt: "2026-07-22T02:00:00.000Z", currentPhase: null, terminal: null,
    state: undefined, boardId: null, preSelectedBoard: undefined, boardSelectionMode: undefined,
    preferences: undefined, manifest: undefined, diagram: undefined, credits: null,
    diagnostics: {}, artifacts: [], git: null,
  };
  const inputs: SnapshotInput[] = [
    base,
    allEmpty,
    { ...base, diagram: undefined },
    { ...base, manifest: undefined, state: undefined },
    { ...base, preferences: undefined, credits: null, git: null },
    { ...base, preSelectedBoard: undefined, boardSelectionMode: undefined },
    // Pin the nullable integrity digest: a null sha256 (an over-bound / unreadable artifact) must
    // survive the schema round-trip as null, never coerced to "" or dropped.
    { ...base, artifacts: [{ relative_path: "firmware.bin", kind: "firmware", role: "", phase: "", size: 5 * 1024 * 1024, sha256: null, created_at: "2026-07-22T02:00:00.000Z" }] },
  ];
  for (const [i, input] of inputs.entries()) {
    const snap = buildSessionSnapshot(input);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(snap)), snap, `input ${i}: no key dropped by an undefined value (round-trip lossless)`);
    assert.ok(!JSON.stringify(snap).includes("absolute_path"), `input ${i}: no absolute_path key leaked`);
  }
});

test("writeSessionSnapshot: writes checkpoints/snapshot.json round-trippable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-snap-"));
  try {
    const snap = buildSessionSnapshot(fullInput());
    const written = await writeSessionSnapshot(dir, snap);
    assert.equal(written, snapshotPath(dir));
    const back = JSON.parse(readFileSync(written, "utf-8"));
    assert.deepEqual(back, snap, "the file round-trips the snapshot verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
