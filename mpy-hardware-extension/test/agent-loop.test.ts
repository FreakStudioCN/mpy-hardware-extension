import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "../src/core/agent-loop.ts";

test("happy path terminates success only after serial marker observation", async () => {
  const calls: string[] = [];
  const result = await runAgentLoop({
    state: { traceId: "t1", intent: "temp led", boardId: "esp32-s3-devkitc-1", turnSeq: 0, repairRound: 0, loadedSkills: [], messages: [] },
    sseClient: scripted([
      [{ type: "tool_use_complete", id: "1", name: "search_packages", input: {} }, { type: "message_stop" }],
      [{ type: "tool_use_complete", id: "2", name: "read_serial_until", input: {} }, { type: "message_stop" }],
    ]),
    dispatchTool: async (tool) => {
      calls.push(tool.name);
      return tool.name === "read_serial_until" ? { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] } : { ok: true };
    },
  });

  assert.equal(result.terminal, "success");
  assert.deepEqual(calls, ["search_packages", "read_serial_until"]);
});

test("a failed device observation (error_kind) counts toward repair exhaustion", async () => {
  // A read_serial_until that fails carries error_kind: "runtime_error"; the loop
  // must increment repairRound on each so it terminates as repair_exhausted
  // instead of spinning to max_turns.
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 5 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "read_serial_until", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: "runtime_error", error: "serial_read_timeout", lines: [] }),
  });

  assert.equal(result.terminal, "repair_exhausted");
});

test("unknown tool observation lets loop continue", async () => {
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([
      [{ type: "tool_use_complete", id: "1", name: "unknown_tool", input: {} }, { type: "message_stop" }],
      [{ type: "tool_use_complete", id: "2", name: "read_serial_until", input: {} }, { type: "message_stop" }],
    ]),
    dispatchTool: async (tool) => tool.name === "unknown_tool" ? { ok: false, error_kind: "UnknownToolError" } : { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] },
  });

  assert.equal(result.terminal, "success");
  // Each turn now records an assistant turn (text + tool_use blocks) and a user
  // turn (tool_result blocks): 2 turns -> 4 messages.
  assert.equal(result.state.messages.length, 4);
  const [assistant, toolResult] = result.state.messages;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content[0].type, "tool_use");
  assert.equal(assistant.content[0].id, "1");
  assert.equal(toolResult.role, "user");
  assert.equal(toolResult.content[0].type, "tool_result");
  assert.equal(toolResult.content[0].tool_use_id, "1");
});

test("max turns and repair exhaustion are deterministic", async () => {
  const max = await runAgentLoop({ state: baseState(), sseClient: scripted(Array.from({ length: 21 }, () => [{ type: "message_stop" }])), dispatchTool: async () => ({ ok: true }) });
  const repair = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 4 }, (_, index) => [{ type: "tool_use_complete", id: String(index), name: "flash_and_run", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: "runtime_error" }),
  });

  assert.equal(max.terminal, "max_turns");
  assert.equal(repair.terminal, "repair_exhausted");
});

test("a turn without message_stop terminates as interrupted instead of looping", async () => {
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([[{ type: "text_delta", text: "partial answer" }]]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "sse_stream_interrupted");
});

test("stream_error terminates as interrupted", async () => {
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([[{ type: "stream_error", message: "upstream_stream_interrupted" }]]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "sse_stream_interrupted");
});

function baseState() {
  return { traceId: "t1", intent: "x", boardId: "esp32-s3-devkitc-1", turnSeq: 0, repairRound: 0, loadedSkills: [], messages: [] };
}

function scripted(turns: any[][]) {
  let index = 0;
  return async () => turns[index++] ?? [{ type: "message_stop" }];
}
