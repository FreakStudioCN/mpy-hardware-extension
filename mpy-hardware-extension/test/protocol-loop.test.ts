import assert from "node:assert/strict";
import test from "node:test";

import { runProtocolBuild, executeProtocolTool } from "../src/core/protocol-loop.ts";

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

test("protocol build advances phases, runs codegen file write, auto-confirms approval", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const events: any[] = [];
  let approvalCard: any = null;

  const script = {
    analyze: [
      [tu("a1", "approval_request", { approval_id: "device_confirm", question: "ok?", items: [{ id: "d1", name: "SHT30" }], actions: [{ label: "确认", value: "confirm", primary: true }] }), stop],
      [tu("a2", "status_update", { level: "info", message: "搜索驱动..." }), stop],
      [tu("a3", "phase_complete", { result: "success", summary: "done", next_phase: "generate", manifest_content: { phase: "analyze", devices: [{ name: "SHT30" }] } }), stop],
    ],
    generate: [
      [tu("g1", "file_operation", { op: "write", path: "firmware/main.py", content: "print('MPYHW_READY')\n" }), stop],
      [tu("g2", "phase_complete", { result: "success", summary: "code", next_phase: null, manifest_content: { phase: "generate" } }), stop],
    ],
  };

  const result = await runProtocolBuild(
    { intent: "做一个温湿度监测仪", traceId: "t", onEvent: (e) => events.push(e), confirmApproval: async (card) => { approvalCard = card; return { action: "confirm", selected_ids: ["d1"] }; } },
    {
      llmClient: scriptedLlm(script),
      writeFile: async (path, content) => { writes.push({ path, content }); return { ok: true, path }; },
    },
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "success" }, { phase: "generate", result: "success" }]);
  assert.equal(result.manifest.phase, "generate");
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
  assert.equal(result.success, false);  // but the gate FAILED (exit 1) — not faked
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
  // must NOT end the build as 'complete' — feed back an error so the model re-emits.
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
