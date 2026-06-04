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

test("successful serial observation terminates success without temperature markers", async () => {
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([
      [{ type: "tool_use_complete", id: "1", name: "read_serial_until", input: {} }, { type: "message_stop" }],
      [{ type: "tool_use_complete", id: "2", name: "search_packages", input: {} }, { type: "message_stop" }],
    ]),
    dispatchTool: async () => ({ ok: true, lines: ["MPYHW_READY", "OLED_OK"] }),
  });

  assert.equal(result.terminal, "success");
  assert.equal(result.state.turnSeq, 1);
});

test("successful serial observation with no lines terminates success", async () => {
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([[{ type: "tool_use_complete", id: "1", name: "read_serial_until", input: {} }, { type: "message_stop" }]]),
    dispatchTool: async () => ({ ok: true, lines: [] }),
  });

  assert.equal(result.terminal, "success");
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

test("a failed serial read whose last line contains TEMP_C= is not graded success", async () => {
  // Device printed one reading then hung: the read fails (runtime_error) but its
  // last buffered line still contains the success marker. This must NOT terminate
  // as success — it's a runtime failure that should repair-exhaust.
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 5 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "read_serial_until", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: "runtime_error", error: "serial_read_timeout", lines: ["MPYHW_READY", "TEMP_C=24.0"] }),
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
  const max = await runAgentLoop({ state: baseState(), sseClient: scripted(Array.from({ length: 41 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "search_packages", input: {} }, { type: "message_stop" }])), dispatchTool: async () => ({ ok: true }) });
  const repair = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 4 }, (_, index) => [{ type: "tool_use_complete", id: String(index), name: "flash_and_run", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: "runtime_error" }),
  });

  assert.equal(max.terminal, "max_turns");
  assert.equal(repair.terminal, "repair_exhausted");
});

test("repeated non-runtime tool failures stop fast as manifest_unresolved", async () => {
  // The desktop-pet failure: propose_manifest fails validation over and over.
  // manifest_invalid does not count toward repair, so without a no-progress
  // backstop the loop ground silently to max_turns. It must stop at N=4 instead.
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 6 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "propose_manifest", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: "manifest_invalid", errors: [{ code: "pin_role_not_allowed", message: "x" }] }),
  });

  assert.equal(result.terminal, "manifest_unresolved");
  assert.ok(result.state.turnSeq < 40, "stops well before the max_turns cap");
});

test("a success resets the no-progress streak so it does not fire", async () => {
  // Three validation failures then a successful run: the streak resets on the
  // success and 3 < 4 never fired, so the build still terminates success.
  const names = ["propose_manifest", "propose_manifest", "propose_manifest", "read_serial_until"];
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(names.map((name, i) => [{ type: "tool_use_complete", id: String(i), name, input: {} }, { type: "message_stop" }])),
    dispatchTool: async (tool) => tool.name === "read_serial_until"
      ? { ok: true, lines: ["MPYHW_READY", "TEMP_C=24.0"] }
      : { ok: false, error_kind: "manifest_invalid", errors: [] },
  });

  assert.equal(result.terminal, "success");
});

test("interleaved single failures never trip the no-progress backstop", async () => {
  // fail/ok alternation keeps resetting the streak; it must not accumulate to N.
  let n = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(Array.from({ length: 8 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "propose_manifest", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => (n++ % 2 === 0 ? { ok: false, error_kind: "manifest_invalid", errors: [] } : { ok: true }),
  });

  assert.notEqual(result.terminal, "manifest_unresolved");
});

test("environment/user incapability is neutral and never trips manifest_unresolved", async () => {
  // A headless run (no shim) + a declined deploy gate make host/deploy tools fail
  // with device_unavailable / user_cancelled. These are not the model failing to
  // produce a valid manifest, so they must NOT accumulate the no-progress streak —
  // otherwise a missing board / declined flash is mislabeled "manifest_unresolved".
  const kinds = ["device_unavailable", "user_cancelled", "device_unavailable", "user_cancelled", "device_unavailable"];
  let i = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted(kinds.map((_, n) => [{ type: "tool_use_complete", id: String(n), name: "run_validate", input: {} }, { type: "message_stop" }])),
    dispatchTool: async () => ({ ok: false, error_kind: kinds[i++] ?? "device_unavailable" }),
  });

  // 5 consecutive neutral failures (> the streak cap of 4) never trip the backstop;
  // the run ends only when the model hands back with no tool call.
  assert.notEqual(result.terminal, "manifest_unresolved");
  assert.equal(result.terminal, "awaiting_user");
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
