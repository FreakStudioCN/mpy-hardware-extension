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

test("records assistant text, tool use, and complete tool result observations", async () => {
  const recorded: any[] = [];
  await runAgentLoop({
    state: baseState(),
    sseClient: scripted([
      [
        { type: "text_delta", text: "Checking packages." },
        { type: "tool_use_complete", id: "1", name: "search_packages", input: { query: "oled", capabilities: ["display_text"] } },
        { type: "message_stop" },
      ],
      [{ type: "message_stop" }],
    ]),
    dispatchTool: async () => ({ ok: true, results: [{ name: "ssd1306_driver", version: "1.0.0" }] }),
    recorder: { record: async (event: any) => void recorded.push(event) },
  });

  assert.deepEqual(recorded.map((event) => event.type), ["assistant_text", "tool_use", "tool_result"]);
  assert.equal(recorded[0].text, "Checking packages.");
  assert.deepEqual(recorded[1].input, { query: "oled", capabilities: ["display_text"] });
  assert.deepEqual(recorded[2].observation.output.results, [{ name: "ssd1306_driver", version: "1.0.0" }]);
});

test("a text-only turn ends immediately as awaiting_user with no nudge", async () => {
  // A turn with no tool call is the model handing control back to the user (a
  // final summary, an answer, or a clarification). The loop ends right there —
  // it never nudges the model into another turn (which used to make it re-ask
  // "what do you want to do next" via ask_user after a finished build).
  let turns = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: async () => (turns++, [{ type: "text_delta", text: "Could you tell me what device you want to build?" }, { type: "message_stop" }]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "awaiting_user");
  assert.equal(turns, 1);
  // No nudge message was appended — the only user-role string message would be a nudge.
  assert.equal(result.state.messages.filter((m: any) => m.role === "user" && typeof m.content === "string").length, 0);
});

test("a tool-less narration ends the turn without reaching the next turn", async () => {
  // Accepted tradeoff: a chatty mid-build narration (text, no tool call) ends the
  // turn instead of being nudged onward. The second scripted turn is never reached.
  let dispatched = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([
      [{ type: "text_delta", text: "Let me allocate the pins first." }, { type: "message_stop" }],
      [{ type: "tool_use_complete", id: "1", name: "read_serial_until", input: {} }, { type: "message_stop" }],
    ]),
    dispatchTool: async () => (dispatched++, { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] }),
  });

  assert.equal(result.terminal, "awaiting_user");
  // The second (tool-calling) turn is never reached, so no tool is dispatched.
  assert.equal(dispatched, 0);
});

test("max turns and repair exhaustion are deterministic", async () => {
  // max_turns is reached by turns that keep calling tools but never hit the
  // success marker or repair exhaustion (a tool-less turn now ends as awaiting_user).
  const max = await runAgentLoop({ state: baseState(), sseClient: scripted(Array.from({ length: 21 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "search_packages", input: {} }, { type: "message_stop" }])), dispatchTool: async () => ({ ok: true }) });
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

test("agent loop consumes async streaming events", async () => {
  const state = baseState();
  async function* events() {
    yield { type: "tool_use_complete", id: "serial", name: "read_serial_until", input: {} };
    yield { type: "message_stop" };
  }

  const result = await runAgentLoop({
    state,
    sseClient: async () => events(),
    dispatchTool: async () => ({ ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2"] }),
  });

  assert.equal(result.terminal, "success");
});

function baseState() {
  return { traceId: "t1", intent: "x", boardId: "esp32-s3-devkitc-1", turnSeq: 0, repairRound: 0, textOnlyTurns: 0, loadedSkills: [], messages: [] };
}

function scripted(turns: any[][]) {
  let index = 0;
  return async () => turns[index++] ?? [{ type: "message_stop" }];
}
