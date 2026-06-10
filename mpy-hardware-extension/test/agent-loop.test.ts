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

test("a tool call with invalid argument JSON feeds an error result back and lets the model retry", async () => {
  // The production crash: the SSE parser couldn't decode a write_project_file's
  // arguments (unescaped quote in a code string). The loop must NOT dispatch the
  // half-formed call or crash — it feeds an invalid_tool_input error back, and a
  // valid retry still drives the build to success.
  const recorded: any[] = [];
  const calls: string[] = [];
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: scripted([
      [{ type: "tool_use_complete", id: "1", name: "write_project_file", input: {}, invalidInput: "Expected ',' or '}' after property value in JSON at position 5516" }, { type: "message_stop" }],
      [{ type: "tool_use_complete", id: "2", name: "read_serial_until", input: {} }, { type: "message_stop" }],
    ]),
    dispatchTool: async (tool) => {
      calls.push(tool.name);
      return { ok: true, lines: ["MPYHW_READY", "TEMP_C=24.0"] };
    },
    recorder: { record: async (event: any) => void recorded.push(event) },
  });

  assert.equal(result.terminal, "success");
  // The invalid call was never dispatched; only the valid retry was.
  assert.deepEqual(calls, ["read_serial_until"]);
  // It still produced a paired tool_result carrying the error (so DeepSeek's
  // tool_call/tool_result pairing stays valid and the model sees what to fix).
  const firstResult = recorded.find((event) => event.type === "tool_result" && event.id === "1");
  assert.ok(firstResult);
  assert.equal(firstResult.observation.ok, false);
  assert.equal(firstResult.observation.error_kind, "invalid_tool_input");
  assert.match(firstResult.observation.output.message, /valid JSON/);
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

test("a tool-less stall right after the manifest (no code yet) is nudged onward", async () => {
  // The desk-companion dead-end: after propose_manifest + the inline component card
  // resolved, the model narrated the plan and handed back with no tool call,
  // stranding the build at "analyze" before any code was generated. The loop must
  // nudge it (one synthetic user turn) instead of ending as awaiting_user.
  const state = { ...baseState(), manifest: { phase: "analyze" }, phase: "analyze", files: {} };
  let turn = 0;
  const result = await runAgentLoop({
    state,
    sseClient: async () => {
      turn++;
      // Turn 1: text-only stall. Turn 2 (post-nudge): proceeds to a real tool.
      return turn === 1
        ? [{ type: "text_delta", text: "Here's the plan. Confirm the parts above." }, { type: "message_stop" }]
        : [{ type: "tool_use_complete", id: "1", name: "read_serial_until", input: {} }, { type: "message_stop" }];
    },
    dispatchTool: async () => ({ ok: true, lines: ["MPYHW_READY", "TEMP_C=24.0"] }),
  });

  assert.equal(result.terminal, "success");
  assert.equal(turn, 2); // the nudge drove a second turn
  assert.equal(state.stallNudges, 1);
  // The nudge was appended as a string-content user message.
  assert.equal(state.messages.filter((m: any) => m.role === "user" && typeof m.content === "string").length, 1);
});

test("the post-manifest stall nudge is bounded then hands back", async () => {
  // If the model keeps narrating without generating code, the nudge fires at most
  // MAX_STALL_NUDGES times and then the loop hands back instead of looping forever.
  const state = { ...baseState(), manifest: { phase: "analyze" }, phase: "analyze", files: {} };
  let turn = 0;
  const result = await runAgentLoop({
    state,
    sseClient: async () => (turn++, [{ type: "text_delta", text: "still thinking out loud" }, { type: "message_stop" }]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "awaiting_user");
  assert.equal(state.stallNudges, 2); // capped
  assert.equal(turn, 3); // initial stall + 2 nudged retries, then hand back
});

test("a tool-less hand-back AFTER code is generated is NOT nudged (no regression to the old re-ask bug)", async () => {
  // A build that already produced code (state.files populated) but can't flash
  // headless legitimately hands back. It must end as awaiting_user — re-nudging it
  // is exactly the "what do you want to do next?" regression that got the blanket
  // nudge removed.
  const state = { ...baseState(), manifest: { phase: "deploy" }, phase: "deploy", files: { "main.py": "print('x')" } };
  let turn = 0;
  const result = await runAgentLoop({
    state,
    sseClient: async () => (turn++, [{ type: "text_delta", text: "Code is ready; flash when a board is connected." }, { type: "message_stop" }]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "awaiting_user");
  assert.equal(turn, 1); // ended on the first hand-back, no nudge
  assert.equal(state.stallNudges ?? 0, 0); // never incremented
});

test("max turns and repair exhaustion are deterministic", async () => {
  // max_turns is reached by turns that keep calling tools but never hit the
  // success marker or repair exhaustion (a tool-less turn now ends as awaiting_user).
  const max = await runAgentLoop({ state: baseState(), sseClient: scripted(Array.from({ length: 81 }, (_, i) => [{ type: "tool_use_complete", id: String(i), name: "search_packages", input: {} }, { type: "message_stop" }])), dispatchTool: async () => ({ ok: true }) });
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
  assert.ok(result.state.turnSeq < 80, "stops well before the max_turns cap");
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

test("a turn that never reaches message_stop retries then ends as interrupted", async () => {
  // A truncated turn (no message_stop) is transient: the loop retries it a bounded
  // number of times, then ends as sse_stream_interrupted instead of looping forever.
  let attempts = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: async () => (attempts++, [{ type: "text_delta", text: "partial answer" }]),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "sse_stream_interrupted");
  assert.equal(attempts, 3); // 1 initial + MAX_STREAM_RETRIES (2)
});

test("a mid-stream throw retries the turn instead of crashing the loop", async () => {
  // The production crash: the SSE body dropped mid-read (undici "terminated") while the
  // model was streaming its next turn, and the throw escaped as a fatal session_error.
  // The loop must catch it, re-issue the same turn (no durable state was committed), and
  // a clean retry still drives the build to a normal terminal.
  let attempt = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: async () => {
      const n = attempt++;
      return (async function* () {
        if (n === 0) {
          yield { type: "text_delta", text: "Now allocating pins and updating the manifest" };
          throw new TypeError("terminated");
        }
        yield { type: "tool_use_complete", id: "1", name: "read_serial_until", input: {} };
        yield { type: "message_stop" };
      })();
    },
    dispatchTool: async () => ({ ok: true, lines: ["MPYHW_READY", "TEMP_C=24.0"] }),
  });

  assert.equal(result.terminal, "success");
  assert.equal(attempt, 2); // first attempt threw, the single retry succeeded
});

test("a mid-stream throw that never recovers ends as sse_stream_interrupted", async () => {
  let attempt = 0;
  const result = await runAgentLoop({
    state: baseState(),
    sseClient: async () => {
      attempt++;
      return (async function* () {
        yield { type: "text_delta", text: "partial" };
        throw new TypeError("terminated");
      })();
    },
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "sse_stream_interrupted");
  assert.equal(attempt, 3); // 1 initial + MAX_STREAM_RETRIES (2)
});

test("an abort during the stream ends as cancelled, not interrupted", async () => {
  // A user Cancel aborts the in-flight fetch, so the same read rejects. The loop must
  // distinguish that from a transient drop and end as cancelled (no retry).
  const signal = { aborted: false };
  const result = await runAgentLoop({
    state: baseState(),
    signal,
    sseClient: async () => (async function* () {
      yield { type: "text_delta", text: "working" };
      signal.aborted = true;
      throw new TypeError("terminated");
    })(),
    dispatchTool: async () => ({ ok: true }),
  });

  assert.equal(result.terminal, "cancelled");
});

test("a non-200 from the LLM endpoint is not retried and surfaces as a thrown error", async () => {
  // Application errors (out_of_credits, llm_upstream_error, …) are thrown by the client
  // when the request itself fails (before any stream). Those must NOT be swallowed by the
  // stream-drop retry: they propagate so session-controller surfaces the real detail.
  let calls = 0;
  await assert.rejects(
    runAgentLoop({
      state: baseState(),
      sseClient: async () => { calls++; throw new Error("out_of_credits"); },
      dispatchTool: async () => ({ ok: true }),
    }),
    /out_of_credits/,
  );
  assert.equal(calls, 1); // thrown from sseClient(), no retry
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
