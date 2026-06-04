import assert from "node:assert/strict";
import test from "node:test";

import { createSessionState } from "../src/core/session-state.ts";
import { normalizeObservation, toToolResultBlock } from "../src/core/observations.ts";
import { shouldTerminate } from "../src/core/termination.ts";

test("session state starts with a fully deterministic initial shape", () => {
  const state = createSessionState({ traceId: "t1", intent: "read temperature", boardId: "esp32-s3-devkitc-1" });

  // Pin the whole contract other code relies on across multi-turn continuation,
  // not just the counters — a regressed default (e.g. runtimeVerified=true) or a
  // dropped field initializer must fail here.
  assert.deepEqual(state, {
    traceId: "t1",
    intent: "read temperature",
    boardId: "esp32-s3-devkitc-1",
    turnSeq: 0,
    repairRound: 0,
    noProgressStreak: 0,
    textOnlyTurns: 0,
    loadedSkills: [],
    skillBodies: {},
    messages: [],
    lastRuntimeMarker: undefined,
    runtimeVerified: false,
    deployDeclined: false,
    componentsConfirmed: false,
    board: undefined,
    driverContexts: [],
    projectDir: undefined,
    phase: "analyze",
    manifest: undefined,
  });
});

test("a build that reaches the complete phase terminates cleanly", () => {
  // A PC-only build finishes without a runtime marker; the terminal phase ends it.
  assert.equal(shouldTerminate({ turnSeq: 5, repairRound: 0, phase: "complete" }).reason, "complete");
  assert.equal(shouldTerminate({ turnSeq: 5, repairRound: 0, phase: "generate" }).done, false);
});

test("serial observations are truncated to tail content", () => {
  const observation = normalizeObservation("read_serial_until", { lines: Array.from({ length: 30 }, (_, index) => `line-${index}`) });

  assert.equal(observation.output.lines[0], "line-10");
  assert.equal(observation.truncated, true);
});

test("tool errors preserve error_kind and serialize as tool_result", () => {
  const observation = normalizeObservation("install_package", { ok: false, error_kind: "network", message: "offline" });
  const block = toToolResultBlock("toolu_1", observation);

  assert.equal(observation.error_kind, "network");
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_1");
});

test("termination detects success, max turns, and repair exhaustion", () => {
  assert.equal(shouldTerminate({ turnSeq: 1, repairRound: 0, runtimeVerified: true }).reason, "success");
  assert.equal(shouldTerminate({ turnSeq: 1, repairRound: 0, lastRuntimeMarker: "TEMP_C=31.2 LED=ON" }).done, false);
  assert.equal(shouldTerminate({ turnSeq: 39, repairRound: 0 }).done, false);
  assert.equal(shouldTerminate({ turnSeq: 40, repairRound: 0 }).reason, "max_turns");
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 3 }).reason, "repair_exhausted");
});

test("termination stops a no-progress streak as manifest_unresolved", () => {
  // Repeated non-runtime failures (e.g. propose_manifest manifest_invalid) must
  // fail fast with a clear reason instead of grinding to max_turns.
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 0, noProgressStreak: 4 }).reason, "manifest_unresolved");
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 0, noProgressStreak: 3 }).done, false);
  // Runtime repair exhaustion is the more specific signal and takes precedence.
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 3, noProgressStreak: 9 }).reason, "repair_exhausted");
});

test("a declined deploy ends cleanly as generated, not manifest_unresolved", () => {
  // The user declined the deploy gate (or no board): the code is generated, flashing
  // was a deliberate skip. End "generated" — and beat a no-progress streak that may
  // have built from the cancelled deploy-tool retries under the old behaviour.
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 0, deployDeclined: true }).reason, "generated");
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 0, deployDeclined: true, noProgressStreak: 9 }).reason, "generated");
  // A verified runtime is still the stronger, more specific success signal.
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 0, deployDeclined: true, runtimeVerified: true }).reason, "success");
});
