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
    textOnlyTurns: 0,
    loadedSkills: [],
    skillBodies: {},
    messages: [],
    lastRuntimeMarker: undefined,
    runtimeVerified: false,
    board: undefined,
    driverContexts: [],
  });
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
  assert.equal(shouldTerminate({ turnSeq: 1, repairRound: 0, lastRuntimeMarker: "TEMP_C=31.2 LED=ON" }).reason, "success");
  assert.equal(shouldTerminate({ turnSeq: 20, repairRound: 0 }).reason, "max_turns");
  assert.equal(shouldTerminate({ turnSeq: 2, repairRound: 3 }).reason, "repair_exhausted");
});
