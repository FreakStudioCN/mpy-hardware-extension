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

test("a failed phase_complete yields a failed terminal, not complete", async () => {
  const script = { analyze: [[tu("a", "phase_complete", { result: "failed", summary: "boom", next_phase: null }), stop]] };
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.equal(result.terminal, "failed");
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
