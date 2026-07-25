import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionSnapshot,
  writeSessionSnapshot,
  readSessionSnapshot,
  listSessionSnapshots,
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
    optionalNextPhases: [{ phase: "upy-wiring-plugin" }, { phase: "upy-diagram-plugin" }],
    generatePhaseComplete: { type: "phase_complete", payload: { phase: "generate", result: "success" } },
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
  // Optional flows: the offered set + the upstream generate result a restored session re-runs against.
  assert.deepEqual(snap.optional_flows.offered, [{ phase: "upy-wiring-plugin" }, { phase: "upy-diagram-plugin" }]);
  assert.equal((snap.optional_flows.generate_phase_complete as any)?.payload?.result, "success", "upstream generate persisted");
  // Restore entry (the acceptance field session restore invokes).
  assert.deepEqual(snap.restore, { mechanism: "startPhase", phase: "generate", board_id: "ESP32_GENERIC_C6" });
});

test("buildSessionSnapshot: missing pieces are explicit nulls/empties, never dropped keys", () => {
  const snap = buildSessionSnapshot({
    traceId: null, savedAt: "2026-07-22T02:00:00.000Z", currentPhase: null, terminal: null,
    state: undefined, boardId: null, preSelectedBoard: undefined, boardSelectionMode: undefined,
    preferences: undefined, manifest: undefined, diagram: undefined, credits: null,
    optionalNextPhases: [], generatePhaseComplete: null,
    diagnostics: {}, artifacts: [], git: null,
  });
  // Keys exist with explicit empty/null so session restore can rely on the shape.
  for (const key of ["stage", "state", "board", "preferences", "manifest", "diagram", "optional_flows", "credits", "diagnostics", "artifacts", "git", "restore"]) {
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
    optionalNextPhases: [], generatePhaseComplete: null,
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

test("readSessionSnapshot round-trips a written snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-snap-"));
  try {
    const snap = buildSessionSnapshot(fullInput());
    await writeSessionSnapshot(dir, snap);
    assert.deepEqual(await readSessionSnapshot(dir), snap, "reader returns the exact written snapshot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSessionSnapshot returns null when there is no snapshot (ENOENT), throws on a real read/parse/schema failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-snap-"));
  try {
    // No snapshot for this session -> null (caller degrades: view-log / disabled), NOT an error.
    assert.equal(await readSessionSnapshot(dir), null, "missing snapshot is null, not a throw");
    // Corrupt JSON -> throws (never a silent null that would look like "no snapshot").
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
    writeFileSync(snapshotPath(dir), "{ not json", "utf-8");
    await assert.rejects(readSessionSnapshot(dir), /not valid JSON/, "corrupt snapshot surfaces, not swallowed");
    // Wrong schema -> throws (don't replay an unknown shape).
    writeFileSync(snapshotPath(dir), JSON.stringify({ schema: "something-else", version: SNAPSHOT_VERSION }), "utf-8");
    await assert.rejects(readSessionSnapshot(dir), /schema/, "a foreign schema is rejected");
    // Future/unsupported version -> throws.
    writeFileSync(snapshotPath(dir), JSON.stringify({ schema: SNAPSHOT_SCHEMA, version: SNAPSHOT_VERSION + 1 }), "utf-8");
    await assert.rejects(readSessionSnapshot(dir), /version/, "an unsupported version is rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("listSessionSnapshots: indexes commits by hash, newest session wins a shared hash, corrupt/no-git skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mpyhw-assoc-"));
  const sdir = (id: string) => join(root, ".mpyhw", "sessions", id);
  try {
    // A and B both record commit "abc123"; B has the newer (higher) id, so it must win the hash.
    await writeSessionSnapshot(sdir("session-aaa-1"), buildSessionSnapshot({ ...fullInput(), traceId: "session-aaa-1", currentPhase: "generate", git: { commit_hash: "abc123", branch: "main" } }));
    await writeSessionSnapshot(sdir("session-bbb-1"), buildSessionSnapshot({ ...fullInput(), traceId: "session-bbb-1", currentPhase: "deploy", git: { commit_hash: "abc123", branch: "main" }, artifacts: [] }));
    // C has no git linkage -> skipped; D is corrupt JSON -> skipped (never a throw).
    await writeSessionSnapshot(sdir("session-ccc-1"), buildSessionSnapshot({ ...fullInput(), traceId: "session-ccc-1", git: null }));
    mkdirSync(join(sdir("session-ddd-1"), "checkpoints"), { recursive: true });
    writeFileSync(snapshotPath(sdir("session-ddd-1")), "{ corrupt", "utf-8");
    const map = await listSessionSnapshots(root, 50);
    assert.equal(map.size, 1, "only the git-linked hash is indexed (no-git + corrupt skipped, no throw)");
    const assoc = map.get("abc123");
    assert.equal(assoc?.phase, "deploy", "the newest session (bbb > aaa) wins the shared hash");
    assert.equal(assoc?.session_id, "session-bbb-1");
    assert.equal(assoc?.artifact_total, 0, "association projected from the winning snapshot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("listSessionSnapshots: a matching snapshot carries phase + artifacts; missing sessions dir is empty (ENOENT), not a throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "mpyhw-assoc-"));
  try {
    assert.equal((await listSessionSnapshots(root, 50)).size, 0, "no sessions dir -> empty map");
    await writeSessionSnapshot(join(root, ".mpyhw", "sessions", "session-zzz-1"), buildSessionSnapshot({
      ...fullInput(), traceId: "session-zzz-1", currentPhase: "generate", git: { commit_hash: "deadbeef", branch: "main" },
      artifacts: [{ relative_path: "main.py", kind: "code", role: "firmware", phase: "generate", size: 10, sha256: "aa", created_at: "2026-07-24T00:00:00Z" }],
    }));
    const assoc = (await listSessionSnapshots(root, 50)).get("deadbeef");
    assert.equal(assoc?.phase, "generate");
    assert.equal(assoc?.artifact_total, 1);
    assert.deepEqual(assoc?.artifacts, [{ relative_path: "main.py", phase: "generate" }], "artifacts projected to relative_path + phase only");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeSessionSnapshot: a failed rename unlinks the .tmp and rethrows (no orphaned tmp, original error surfaced)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-snap-"));
  try {
    // Make the target a NON-EMPTY directory so rename(tmp, snapshot.json) fails on every platform
    // (ENOTEMPTY/EISDIR on POSIX, EPERM on Windows).
    mkdirSync(join(dir, "checkpoints", "snapshot.json", "blocker"), { recursive: true });
    // Match the error CLASS (not just "rejects with something") so a mutation that surfaced the rm's
    // error instead of the rename's would fail: the rename-over-a-dir fails with one of these codes.
    await assert.rejects(writeSessionSnapshot(dir, buildSessionSnapshot(fullInput())), /EISDIR|ENOTEMPTY|EPERM|ENOTDIR/);
    assert.equal(existsSync(join(dir, "checkpoints", "snapshot.json.tmp")), false, "the orphaned .tmp is cleaned up on failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
