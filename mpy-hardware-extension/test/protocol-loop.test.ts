import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_TOOLS } from "../src/core/protocol-registry.ts";
import { PHASE_ORDER, runProtocolBuild, executeProtocolTool } from "../src/core/protocol-loop.ts";

// A scripted LLM: per phase, an array of turns; each turn is an array of SSE events.
// Each streamMessages(body) call pops the next turn for body.phase.
function scriptedLlm(script: Record<string, any[][]>) {
  const idx: Record<string, number> = {};
  return {
    streamMessages: async (body: any) => {
      const phase = body.phase;
      const turns = script[phase] ?? [];
      const i = idx[phase] ?? 0;
      idx[phase] = i + 1;
      const events = turns[i] ?? [{ type: "message_stop" }];
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });
const stop = { type: "message_stop" };

const V0_PHASE_CHAIN = [
  "analyze",
  "select-hw",
  "upy-flash-mpy-firmware-plugin",
  "upy-scaffold-plugin",
  "upy-generate-plugin",
  "upy-deploy-plugin",
] as const;

test("PHASE_ORDER matches the backend-served V0 plugin chain", () => {
  assert.deepEqual([...PHASE_ORDER], [...V0_PHASE_CHAIN]);
});

test("protocol build walks the full V0 plugin chain and sends the cloud envelope", async () => {
  const sentBodies: any[] = [];
  const script: Record<string, any[][]> = {};
  for (const [index, phase] of V0_PHASE_CHAIN.entries()) {
    const next = V0_PHASE_CHAIN[index + 1] ?? null;
    script[phase] = [[
      tu(`p${index}`, "phase_complete", {
        result: "success",
        summary: phase,
        next_phase: next,
        manifest_content: { phase, index },
      }),
      stop,
    ]];
  }
  const baseLlm = scriptedLlm(script);
  const llm = {
    streamMessages: async (body: any) => {
      sentBodies.push(body);
      return baseLlm.streamMessages(body);
    },
  };

  const result = await runProtocolBuild({ intent: "x", traceId: "trace-v0" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases.map((p) => p.phase), [...V0_PHASE_CHAIN]);
  assert.equal(sentBodies.length, V0_PHASE_CHAIN.length);
  for (const [index, body] of sentBodies.entries()) {
    assert.equal(body.phase, V0_PHASE_CHAIN[index]);
    assert.equal(body.trace_id, "trace-v0");
    assert.deepEqual(body.tools, PROTOCOL_TOOLS);
    assert.deepEqual(body.manifest, index === 0 ? {} : { phase: V0_PHASE_CHAIN[index - 1], index: index - 1 });
  }
});

test("phase_complete next_skill wins over legacy next_phase and is normalized to the production plugin phase", async () => {
  const seen: string[] = [];
  const baseLlm = scriptedLlm({
    analyze: [[
      tu("a", "phase_complete", {
        result: "success",
        summary: "analyze done",
        next_phase: "scaffold",
        next_skill: "/upy-flash-mpy-firmware-plugin",
        manifest_content: { phase: "analyze" },
      }),
      stop,
    ]],
    "upy-flash-mpy-firmware-plugin": [[
      tu("f", "phase_complete", { result: "success", summary: "flash done", next_phase: null, manifest_content: { phase: "upy-flash-mpy-firmware-plugin" } }),
      stop,
    ]],
  });
  const llm = {
    streamMessages: async (body: any) => {
      seen.push(body.phase);
      return baseLlm.streamMessages(body);
    },
  };

  const result = await runProtocolBuild({ intent: "x" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(seen, ["analyze", "upy-flash-mpy-firmware-plugin"]);
});

test("legacy next_phase names are normalized before the next server turn", async () => {
  const seen: string[] = [];
  const baseLlm = scriptedLlm({
    "select-hw": [[
      tu("s", "phase_complete", { result: "success", summary: "selected", next_phase: "flash-mpy-firmware", manifest_content: { phase: "select-hw" } }),
      stop,
    ]],
    "upy-flash-mpy-firmware-plugin": [[
      tu("f", "phase_complete", { result: "success", summary: "flashed", next_phase: null, manifest_content: { phase: "upy-flash-mpy-firmware-plugin" } }),
      stop,
    ]],
  });
  const llm = {
    streamMessages: async (body: any) => {
      seen.push(body.phase);
      return baseLlm.streamMessages(body);
    },
  };

  const result = await runProtocolBuild({ intent: "x", startPhase: "select-hw" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(seen, ["select-hw", "upy-flash-mpy-firmware-plugin"]);
});

test("unknown next phases fail with a structured event instead of spawning a phantom phase", async () => {
  const events: any[] = [];
  const script = {
    analyze: [[
      tu("a", "phase_complete", { result: "success", summary: "bad handoff", next_phase: "does-not-exist", manifest_content: {} }),
      stop,
    ]],
  };

  const result = await runProtocolBuild({ intent: "x", onEvent: (event) => events.push(event) }, { llmClient: scriptedLlm(script) });

  assert.equal(result.terminal, "failed");
  assert.ok(events.some((event) => event.type === "phase_error" && event.error_kind === "unknown_next_phase" && event.next_phase === "does-not-exist"));
});
test("protocol build advances phases, runs codegen file write, auto-confirms approval", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const events: any[] = [];
  let approvalCard: any = null;

  const script = {
    analyze: [
      [tu("a1", "approval_request", { approval_id: "device_confirm", question: "ok?", items: [{ id: "d1", name: "SHT30" }], actions: [{ label: "纭", value: "confirm", primary: true }] }), stop],
      [tu("a2", "status_update", { level: "info", message: "鎼滅储椹卞姩..." }), stop],
      [tu("a3", "phase_complete", { result: "success", summary: "done", next_phase: "upy-generate-plugin", manifest_content: { phase: "analyze", devices: [{ name: "SHT30" }] } }), stop],
    ],
    "upy-generate-plugin": [
      [tu("g1", "file_operation", { op: "write", path: "firmware/main.py", content: "print('MPYHW_READY')\n" }), stop],
      [tu("g2", "phase_complete", { result: "success", summary: "code", next_phase: null, manifest_content: { phase: "upy-generate-plugin" } }), stop],
    ],
  };

  const result = await runProtocolBuild(
    { intent: "build a thermometer", traceId: "t", onEvent: (e) => events.push(e), confirmApproval: async (card) => { approvalCard = card; return { action: "confirm", selected_ids: ["d1"] }; } },
    {
      llmClient: scriptedLlm(script),
      writeFile: async (path, content) => { writes.push({ path, content }); return { ok: true, path }; },
    },
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "success" }, { phase: "upy-generate-plugin", result: "success" }]);
  assert.equal(result.manifest.phase, "upy-generate-plugin");
  // codegen file landed via file_operation -> writeFile
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "firmware/main.py");
  assert.match(writes[0].content, /MPYHW_READY/);
  // approval card was surfaced and a status_update + phase events emitted
  assert.equal(approvalCard.approval_id, "device_confirm");
  assert.ok(events.some((e) => e.type === "status_update"));
  assert.ok(events.some((e) => e.type === "phase_complete"));
  assert.ok(events.some((e) => e.type === "manifest_updated"));
});

test("the request body carries a context block (pre_selected_board + preferences) for server grounding", async () => {
  // The handoff requires preferences.mode/locale, pre_selected_board, existing_hardware to
  // reach the server. Previously the body was only {phase,manifest,messages,tools,trace_id}
  // 鈥?not even boardId 鈥?so the analyze phase had zero grounding on the user's real setup.
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  await runProtocolBuild(
    { intent: "x", boardId: "esp32-c3-devkitm-1", preferences: { mode: "beginner", locale: "zh", existing_hardware: "ESP32-C3 + DHT22" } },
    { llmClient: llm },
  );
  assert.ok(sentBody.context, "request must carry a context block");
  assert.equal(sentBody.context.pre_selected_board, "esp32-c3-devkitm-1");
  assert.equal(sentBody.context.mode, "beginner");
  assert.equal(sentBody.context.locale, "zh");
  assert.equal(sentBody.context.existing_hardware, "ESP32-C3 + DHT22");
});


test("protocol build carries a full pre_selected_board object when the UI selected one", async () => {
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  const board = {
    id: "esp32-s3-devkitc",
    official_id: "ESP32_GENERIC_S3",
    display_name: "ESP32-S3",
    vendor: "Espressif",
    port: "esp32",
    mcu: "esp32s3",
    features: ["BLE", "WiFi"],
    firmware: { url: "https://micropython.org/download/ESP32_GENERIC_S3/", board_name: "ESP32_GENERIC_S3" },
    download_slug: "ESP32_GENERIC_S3",
    source_url: "https://micropython.org/download/",
    support_status: "builtin_pin_layout",
    local_board_id: "esp32-s3-devkitc-1",
    skill_board_id: "esp32-s3-devkitc",
  };
  await runProtocolBuild(
    { intent: "x", boardId: "esp32-s3-devkitc-1", preSelectedBoard: board, preferences: { mode: "custom", locale: "zh" } } as any,
    { llmClient: llm },
  );
  assert.deepEqual(sentBody.context.pre_selected_board, board);
  assert.equal(sentBody.context.mode, "custom");
  assert.equal(sentBody.context.locale, "zh");
});

test("an 'auto' board is not sent as a pre_selected_board (only a real user choice is)", async () => {
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  await runProtocolBuild({ intent: "x", boardId: "auto" }, { llmClient: llm });
  assert.equal(sentBody.context, undefined, "no real preferences/board => no context block");
});

test("device_command routes to the device shim and surfaces serial output", async () => {
  const calls: string[] = [];
  const events: any[] = [];
  const { result } = await executeProtocolTool(
    tu("d", "device_command", { action: "stream", cmd_id: "c1" }) as any,
    { intent: "x", onEvent: (e) => events.push(e) },
    { llmClient: scriptedLlm({}), device: async (action) => { calls.push(action); return { ok: true, stdout: "MPYHW_READY\nok" }; } },
  );
  assert.deepEqual(calls, ["stream"]);
  assert.equal(result.ok, true);
  assert.ok(events.some((e) => e.type === "serial_output" && e.lines.includes("MPYHW_READY")));
});

test("off-protocol and invalid tools return repair results, not crashes", async () => {
  // a dead 27-tool name
  const off = await executeProtocolTool(tu("o", "scan_device", {}) as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
  assert.equal(off.result.ok, false);
  assert.equal(off.result.error_kind, "unknown_tool");
  // invalid JSON args flagged by the SSE parser
  const bad = await executeProtocolTool({ type: "tool_use_complete", id: "b", name: "file_operation", input: {}, invalidInput: "bad json" } as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
  assert.equal(bad.result.error_kind, "protocol_payload_invalid");
});

test("approval: headless auto-confirms, but a callback returning null cancels (not auto-confirm)", async () => {
  // headless (no callback) -> auto-confirm, selecting all items
  const auto = await executeProtocolTool(
    tu("u2", "approval_request", { approval_id: "x", items: [{ id: "d1" }], actions: [{ value: "go", primary: true }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(auto.result.ok, true);
  assert.equal(auto.result.action, "go");
  assert.deepEqual(auto.result.selected_ids, ["d1"]);
  // callback returns null (user dismissed) -> user_cancelled, NOT silent approval
  const cancelled = await executeProtocolTool(
    tu("u", "approval_request", { approval_id: "x", actions: [{ value: "confirm" }] }) as any,
    { intent: "x", confirmApproval: async () => null }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(cancelled.result.ok, false);
  assert.equal(cancelled.result.error_kind, "user_cancelled");
});

test("script_run routes to the host runner, forwards stdin, maps a failed gate to success=false (not faked)", async () => {
  const calls: any[] = [];
  const { result } = await executeProtocolTool(
    tu("s1", "script_run", { script_id: "q", interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"], stdin_content: "{}" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), runScript: async (interpreter: string, script: string, args: string[], extra: any) => { calls.push({ interpreter, script, args, extra }); return { ok: true, stdout: "", stderr: "GENERATE_PLAN_FILE_PATH_MISSING", exit_code: 1 }; } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interpreter, "python");
  assert.equal(calls[0].script, "check_generate_plan.py");
  assert.deepEqual(calls[0].args, ["--require-plan"]);
  assert.equal(calls[0].extra.stdin_content, "{}");
  assert.equal(result.ok, true);        // the script RAN (transport ok)
  assert.equal(result.success, false);  // but the gate FAILED (exit 1) 鈥?not faked
  assert.equal(result.exit_code, 1);
  assert.equal(result.script_id, "q");
});

test("file_operation mkdir/delete run the real host deps (no faked no-op success)", async () => {
  const calls: any[] = [];
  const deps = {
    llmClient: scriptedLlm({}),
    makeDir: async (path: string) => { calls.push(["mkdir", path]); return { ok: true }; },
    deletePath: async (path: string) => { calls.push(["delete", path]); return { ok: true }; },
  };
  const mk = await executeProtocolTool(tu("m", "file_operation", { op: "mkdir", path: "firmware/lib", op_id: "o1" }) as any, { intent: "x" }, deps);
  assert.equal(mk.result.ok, true);
  assert.equal(mk.result.success, true);
  const del = await executeProtocolTool(tu("d", "file_operation", { op: "delete", path: "firmware/tools", op_id: "o2" }) as any, { intent: "x" }, deps);
  assert.equal(del.result.ok, true);
  assert.equal(del.result.success, true);
  assert.deepEqual(calls, [["mkdir", "firmware/lib"], ["delete", "firmware/tools"]]);
});

test("file_operation mkdir/delete/list fail loud when the host dep is absent (not faked ok)", async () => {
  for (const op of ["mkdir", "delete", "list"]) {
    const r = await executeProtocolTool(tu("f", "file_operation", { op, path: "firmware/tools" }) as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
    assert.equal(r.result.ok, false, op);
    assert.equal(r.result.error_kind, "workspace_unavailable", op);
  }
});

test("file_operation delete surfaces the host error_kind, never a fake success", async () => {
  const r = await executeProtocolTool(
    tu("d", "file_operation", { op: "delete", path: "../escape" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), deletePath: async () => ({ ok: false, error_kind: "path_outside_workspace" }) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "path_outside_workspace");
});

test("script_run ambiguous error forwards the candidate plugin-qualified names to the model", async () => {
  // serve.py lists the plugin-qualified candidates on an ambiguous bare name; the
  // protocol host route must forward them so the model can retry with a real qualified
  // name instead of re-sending the bare name and getting stuck again.
  const { result } = await executeProtocolTool(
    tu("s", "script_run", { interpreter: "python", script: "list_serial_ports.py", script_id: "q" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      runScript: async () => ({ ok: false, error_kind: "ambiguous_script_name", stderr: "qualify it", candidates: ["upy-deploy-plugin/list_serial_ports.py", "upy-flash-mpy-firmware-plugin/list_serial_ports.py"] }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "ambiguous_script_name");
  assert.ok(Array.isArray(result.candidates), "the model needs the candidate list to retry with a qualified name");
  assert.ok(result.candidates.includes("upy-deploy-plugin/list_serial_ports.py"), result);
});

test("script_run with no host runner fails loud (no fake success)", async () => {
  const { result } = await executeProtocolTool(
    tu("s2", "script_run", { interpreter: "python", script: "x.py" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "host_runner_absent");
});

test("script_run surfaces a script_not_found from the runner as a failure, not success", async () => {
  const { result } = await executeProtocolTool(
    tu("s3", "script_run", { interpreter: "python", script: "ghost.py" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), runScript: async () => ({ ok: false, error_kind: "script_not_found", stderr: "no such script" }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "script_not_found");
});

test("runProtocolBuild honors input.maxTurnsPerPhase (V0 phases need a high budget)", async () => {
  const mkScript = () => ({
    analyze: [
      [tu("t0", "status_update", { message: "1" }), stop],
      [tu("t1", "status_update", { message: "2" }), stop],
      [tu("t2", "phase_complete", { result: "success", summary: "ok", next_phase: null, manifest_content: {} }), stop],
    ],
  });
  // 3 turns needed; budget of 2 stalls before phase_complete.
  const stalled = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 2 }, { llmClient: scriptedLlm(mkScript()) });
  assert.equal(stalled.terminal, "stalled");
  // budget of 3 reaches phase_complete.
  const done = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 3 }, { llmClient: scriptedLlm(mkScript()) });
  assert.equal(done.terminal, "complete");
});

test("headless approval takes the no-hardware action when one is offered (not the flash primary)", async () => {
  const r = await executeProtocolTool(
    tu("f", "approval_request", { approval_id: "firmware_action_select", actions: [{ value: "download_and_flash", primary: true }, { value: "already_flashed" }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, true);
  assert.equal(r.result.action, "already_flashed");
});

test("headless approval handles object-form item_groups without crashing (selects all)", async () => {
  const r = await executeProtocolTool(
    tu("g", "approval_request", { approval_id: "x", item_groups: { sensors: { items: [{ id: "s1" }] }, actuators: { items: [{ id: "a1" }] } }, actions: [{ value: "go", primary: true }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, true);
  assert.deepEqual([...r.result.selected_ids].sort(), ["a1", "s1"]);
});

test("a failed phase_complete yields a failed terminal, not complete", async () => {
  const script = { analyze: [[tu("a", "phase_complete", { result: "failed", summary: "boom", next_phase: null }), stop]] };
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.equal(result.terminal, "failed");
});

test("a phase_complete missing result is rejected so the phase retries (not silently terminal)", async () => {
  // The model occasionally emits a truncated/empty phase_complete (no result). That
  // must NOT end the build as 'complete' 鈥?feed back an error so the model re-emits.
  let turns = 0;
  const llm = {
    streamMessages: async () => {
      turns++;
      const ev = turns === 1
        ? [tu("p1", "phase_complete", { summary: "oops, no result field" }), stop]
        : [tu("p2", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "success" }]);
  assert.ok(turns >= 2, "incomplete phase_complete must not end the phase");
});

test("executeProtocolTool rejects a phase_complete with no result", async () => {
  const r = await executeProtocolTool(
    tu("x", "phase_complete", { summary: "no result" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.phaseControl, undefined);
});

test("a string 'null' next_phase is terminal, not run as a real phase", async () => {
  // The model sometimes emits next_phase as the literal string "null"; that must end
  // the build, not spawn a phantom phase named "null".
  const script = { analyze: [[tu("a", "phase_complete", { result: "partial", summary: "stop", next_phase: "null" }), stop]] };
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "partial" }]);
});

test("an already-aborted signal cancels before any LLM call", async () => {
  let called = 0;
  const llm = { streamMessages: async () => { called++; return (async function* () { })(); } };
  const result = await runProtocolBuild({ intent: "x", signal: { aborted: true } }, { llmClient: llm });
  assert.equal(result.terminal, "cancelled");
  assert.equal(called, 0);
});

test("a phase that never emits phase_complete stalls cleanly", async () => {
  const script = { analyze: [[tu("s", "status_update", { level: "info", message: "..." }), stop]] };
  // every subsequent turn returns just message_stop (no tools) -> stall
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.equal(result.terminal, "stalled");
  assert.equal(result.phases.at(-1)?.result, null);
});

test("a prose-only turn is re-prompted, not an instant stall, so the build still advances (search-drivers freeze fix)", async () => {
  // The bug: one chatty model turn (text, no protocol tool) immediately stalled the
  // phase, and the loop mapped that to awaiting_user 鈥?the UI froze on "姝ｅ湪鎼滅储椹卞姩"
  // with no error. The loop must nudge the model to emit a tool instead of giving up.
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [{ type: "text_delta", text: "Let me think about which drivers to use..." }, stop] // prose only, no tool
        : [tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.ok(calls >= 2, "a prose-only turn must re-prompt the model, not stall on the first reply");
});

test("a persistently prose-only phase stalls AND surfaces a phase_stalled event (no silent freeze)", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () { yield { type: "text_delta", text: "thinking..." }; yield stop; })(),
  };
  const result = await runProtocolBuild(
    { intent: "x", maxTurnsPerPhase: 10, onEvent: (e) => events.push(e) },
    { llmClient: llm },
  );
  assert.equal(result.terminal, "stalled");
  assert.ok(
    events.some((e) => e.type === "phase_stalled"),
    "a real stall must surface a phase_stalled event so the UI shows a stuck/retry state, not a frozen step",
  );
});

test("generate phase rejects a turn-0 failed bail to analyze and retries", async () => {
  // Direct unit check (same pattern as "executeProtocolTool rejects a phase_complete
  // with no result" above): on turn 0 of the generate phase, a failed bail to analyze
  // is a hallucination (scaffold already ran) -> rejected with a corrective error_kind,
  // no phaseControl, so the phase loop is not ended.
  const rejected = await executeProtocolTool(
    tu("g0", "phase_complete", { result: "failed", summary: "project looks empty", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 0 },
  );
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.error_kind, "empty_project_hallucination");
  assert.equal(rejected.phaseControl, undefined);

  // Guard must NOT fire outside its exact trigger: wrong phase, later turn, or a
  // genuine (non-hallucinated) failed result all pass through to normal acceptance.
  const wrongPhase = await executeProtocolTool(
    tu("w", "phase_complete", { result: "failed", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-scaffold-plugin", turn: 0 },
  );
  assert.equal(wrongPhase.result.ok, true, "guard is generate-phase-only");
  assert.ok(wrongPhase.phaseControl, "non-generate phases accept a failed bail to analyze normally");

  const laterTurn = await executeProtocolTool(
    tu("l", "phase_complete", { result: "failed", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 1 },
  );
  assert.equal(laterTurn.result.ok, true, "guard is turn-0-only");
  assert.ok(laterTurn.phaseControl, "a failed bail on turn 1+ is accepted, not rejected as a hallucination");

  const genuineFailure = await executeProtocolTool(
    tu("f", "phase_complete", { result: "failed", next_phase: null }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 0 },
  );
  assert.equal(genuineFailure.result.ok, true, "guard only fires when next_phase names analyze");
  assert.ok(genuineFailure.phaseControl);

  // Full phase run: turn 0 emits the hallucinated bail; turn 1 emits a normal
  // successful phase_complete. The loop must not end "failed" at turn 0 -- it retries
  // and the phase result reflects the turn-1 success (bounded naturally by maxTurns).
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [tu("g0", "phase_complete", { result: "failed", summary: "project looks empty", next_phase: "upy-analyze-plugin" }), stop]
        : [tu("g1", "phase_complete", { result: "success", summary: "generated", next_phase: null, manifest_content: { phase: "upy-generate-plugin" } }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "upy-generate-plugin", result: "success" }]);
  assert.ok(calls >= 2, "turn-0 hallucinated bail must not end the phase; the model must be re-prompted");
});

test("quality-gate GENERATE_PLAN errors inject a deterministic corrective message", async () => {
  const bodies: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async (body: any) => {
      // body.messages is the SAME array reference across turns (mutated in place by
      // later turns) -- snapshot it now (message objects themselves are never mutated
      // after being pushed, only appended-to), or a later turn's push would corrupt
      // what this turn actually saw.
      bodies.push({ ...body, messages: [...body.messages] });
      calls++;
      const ev = calls === 1
        ? [tu("q0", "script_run", { script_id: "q", interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"] }), stop]
        : [tu("q1", "phase_complete", { result: "success", summary: "fixed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const runScript = async () => ({
    ok: true,
    exit_code: 2,
    stdout: "",
    stderr: "",
    structured_errors: [{ code: "GENERATE_PLAN_FILE_PATH_MISSING", path: "firmware/app/x.py" }],
  });

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 },
    { llmClient: llm, runScript },
  );

  assert.equal(result.terminal, "complete");
  assert.equal(calls, 2);
  // The turn-1 request body's messages must carry a deterministic corrective as the
  // latest user entry -- not just the raw tool_result JSON the model would have to parse.
  const secondBody = bodies[1];
  const lastMessage = secondBody.messages.at(-1);
  assert.equal(lastMessage.role, "user");
  const lastText = lastMessage.content.map((c: any) => c.text ?? "").join("\n");
  assert.match(lastText, /GENERATE_PLAN_FILE_PATH_MISSING/);
  assert.match(lastText, /firmware\/app\/x\.py/);
});

test("quality-gate JSON on script stdout (the REAL host shape) surfaces structured_errors and fires the corrective message", async () => {
  // Production reality check: the real host shim (protocol-build.ts runScript) never
  // populates a structured_errors field -- it returns the script's JSON report as a
  // stdout STRING (re-serialized result_json). The loop must parse that stdout shape
  // itself, or the corrective path never fires outside tests.
  const bodies: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async (body: any) => {
      bodies.push({ ...body, messages: [...body.messages] });
      calls++;
      const ev = calls === 1
        ? [tu("q0", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py", args: ["--project-dir", "."] }), stop]
        : [tu("q1", "phase_complete", { result: "success", summary: "fixed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  // Exactly what the real shim returns for a failed run_quality_gates.py: ok:true
  // (transport ok), non-zero exit, and the gate's JSON report as a stdout string.
  const gateReport = {
    check: "quality_gates",
    ok: false,
    structured_errors: [
      { code: "GENERATE_PLAN_FAILED", severity: "error", phase_step: "generate_plan", message: "generate_plan quality gate failed" },
      { code: "GENERATE_PLAN_FILE_PATH_MISSING", path: "firmware/app/x.py" },
    ],
    warnings: [],
  };
  const runScript = async () => ({ ok: true, exit_code: 2, stdout: JSON.stringify(gateReport), stderr: "" });

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 },
    { llmClient: llm, runScript },
  );

  assert.equal(result.terminal, "complete");
  assert.equal(calls, 2);
  const lastMessage = bodies[1].messages.at(-1);
  assert.equal(lastMessage.role, "user");
  const lastText = lastMessage.content.map((c: any) => c.text ?? "").join("\n");
  assert.match(lastText, /GENERATE_PLAN_FAILED/);
  assert.match(lastText, /GENERATE_PLAN_FILE_PATH_MISSING/);
  assert.match(lastText, /firmware\/app\/x\.py/);
});

test("non-JSON or JSON-without-structured_errors stdout changes nothing (no corrective, raw result intact)", async () => {
  // Parse defensively: plain-text stdout, broken JSON, and JSON with no
  // structured_errors array must leave the host result exactly as today.
  for (const stdout of ["all checks passed", "{not json", JSON.stringify({ check: "generate_plan", ok: true, errors: [] })]) {
    const { result } = await executeProtocolTool(
      tu("s", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }) as any,
      { intent: "x" },
      { llmClient: scriptedLlm({}), runScript: async () => ({ ok: true, exit_code: 0, stdout, stderr: "" }) },
    );
    assert.equal(result.ok, true, stdout);
    assert.equal(result.stdout, stdout, "raw stdout must flow to the model unchanged");
    assert.equal(result.structured_errors, undefined, stdout);
  }
});
