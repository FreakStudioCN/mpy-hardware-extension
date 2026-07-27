import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryEvent, sanitizePayload, sessionEventToTelemetry } from "../src/core/telemetry.ts";

test("telemetry event keeps raw fields (no hashing) and includes metadata", () => {
  const event = createTelemetryEvent("trace-1", "code_generated", { code: "print('secret')" });

  assert.equal(event.trace_id, "trace-1");
  assert.equal(event.event_type, "code_generated");
  assert.ok(event.timestamp);
  // Raw storage: the actual code survives, no code_sha256/hash.
  assert.equal(event.payload.code, "print('secret')");
  assert.equal("code_sha256" in event.payload, false);
});

test("size guard truncates an oversized field and flags _truncated", () => {
  const huge = "x".repeat(60 * 1024);
  const payload = sanitizePayload({ error: huge, tool: "read_serial_until" });

  assert.ok(payload.error.length < huge.length, "oversized field truncated");
  assert.equal(payload._truncated, true);
  assert.equal(payload.tool, "read_serial_until");
});

test("size guard counts UTF-8 bytes, not characters (CJK field over byte budget)", () => {
  // 20k CJK chars = 60KB UTF-8 but only 20k code units: under the old char-based check
  // this slipped past the 48KB byte budget untruncated. Must now truncate.
  const cjk = "晶".repeat(20 * 1024);
  const payload = sanitizePayload({ intent: cjk });

  assert.ok(Buffer.byteLength(payload.intent, "utf8") <= 48 * 1024 + 4, "truncated to byte budget");
  assert.ok(payload.intent.length < cjk.length, "oversized CJK field truncated");
  assert.equal(payload._truncated, true);
});

test("size guard keeps the tail of an oversized serial array", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ` + "y".repeat(40));
  const payload = sanitizePayload({ lines });

  assert.ok(payload.lines.length < lines.length, "array truncated");
  assert.equal(payload.lines[payload.lines.length - 1], lines[lines.length - 1], "tail (most recent) kept");
  assert.equal(payload._truncated, true);
});

test("maps tool_use to tool_dispatch with raw input", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "tool_use", name: "generate_code", input: { target_path: "main.py" } });
  assert.equal(t?.event_type, "tool_dispatch");
  assert.deepEqual(t?.payload, { tool: "generate_code", input: { target_path: "main.py" } });
});

test("maps a runtime_error tool_result to a runtime_error event with raw error + serial", () => {
  const t = sessionEventToTelemetry("trace-1", {
    type: "tool_result",
    name: "read_serial_until",
    observation: { ok: false, error_kind: "runtime_error", error: "Traceback: ImportError ssd1306", lines: ["MPYHW_READY", "boom"] },
  });
  assert.equal(t?.event_type, "runtime_error");
  assert.equal(t?.payload.error_kind, "runtime_error");
  assert.equal(t?.payload.error, "Traceback: ImportError ssd1306");
  assert.deepEqual(t?.payload.lines, ["MPYHW_READY", "boom"]);
  assert.equal(t?.payload.tool, "read_serial_until");
});

test("maps a runtime_error whose detail is nested under observation.output (the real normalized shape)", () => {
  // normalizeObservation wraps the raw tool result under `output`; the serial-timeout
  // path carries { error, lines } there. The mapper must read through `output`, not
  // just the top level (top-level error/lines are undefined on a real observation).
  const t = sessionEventToTelemetry("trace-1", {
    type: "tool_result",
    name: "read_serial_until",
    observation: {
      tool: "read_serial_until",
      ok: false,
      error_kind: "runtime_error",
      output: { ok: false, error_kind: "runtime_error", error: "serial_read_timeout", lines: ["MPYHW_READY", "boom"] },
    },
  });
  assert.equal(t?.event_type, "runtime_error");
  assert.equal(t?.payload.error, "serial_read_timeout");
  assert.deepEqual(t?.payload.lines, ["MPYHW_READY", "boom"]);
});

test("maps a runtime_error from a thrown shim tool (detail in output.message) so install failures are not blank in the DB", () => {
  // The shim catch-all returns { error_kind:'runtime_error', message } — the install
  // failure reason lives in `message`, nested under `output`. Without reading it, the
  // cloud row was just { tool, error_kind } and repair_exhausted stayed undiagnosable.
  const t = sessionEventToTelemetry("trace-1", {
    type: "tool_result",
    name: "install_package",
    observation: {
      tool: "install_package",
      ok: false,
      error_kind: "runtime_error",
      output: { ok: false, error_kind: "runtime_error", message: "network: could not resolve raw.githubusercontent.com" },
    },
  });
  assert.equal(t?.event_type, "runtime_error");
  assert.equal(t?.payload.error, "network: could not resolve raw.githubusercontent.com");
  assert.equal(t?.payload.tool, "install_package");
});

test("maps an audit_failed tool_result to an audit_failed event with disallowed imports", () => {
  const t = sessionEventToTelemetry("trace-1", {
    type: "tool_result",
    name: "audit_code",
    observation: { ok: false, error_kind: "audit_failed", disallowed_imports: ["socket"] },
  });
  assert.equal(t?.event_type, "audit_failed");
  assert.deepEqual(t?.payload.disallowed_imports, ["socket"]);
});

test("maps a successful tool_result to a compact tool_result (no observation dump)", () => {
  const t = sessionEventToTelemetry("trace-1", {
    type: "tool_result",
    name: "generate_code",
    observation: { ok: true, code: "print('lots of code')" },
  });
  assert.equal(t?.event_type, "tool_result");
  assert.deepEqual(t?.payload, { tool: "generate_code", ok: true });
  // The generated code is NOT duplicated here — it rides on the code_generated event.
  assert.equal("code" in (t?.payload ?? {}), false);
});

test("maps a codegen llm_error to llm_upstream_error", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "llm_error", kind: "codegen", error: "codegen_upstream_unavailable" });
  assert.equal(t?.event_type, "llm_upstream_error");
  assert.deepEqual(t?.payload, { kind: "codegen", error: "codegen_upstream_unavailable" });
});

test("maps serial_output with raw lines", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "serial_output", lines: ["MPYHW_READY", "TEMP_C=24.0"] });
  assert.equal(t?.event_type, "serial_output");
  assert.deepEqual(t?.payload.lines, ["MPYHW_READY", "TEMP_C=24.0"]);
});

test("enriches session_finished with repair + no-progress counters from loop state", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "session_finished", terminal: "repair_exhausted", state: { repairRound: 3, noProgressStreak: 1 } });
  assert.equal(t?.event_type, "session_finished");
  assert.equal(t?.payload.terminal, "repair_exhausted");
  assert.equal(t?.payload.repair_round, 3);
  assert.equal(t?.payload.no_progress_streak, 1);
});

test("session_started carries raw intent (no hash) and the host UI locale", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "session_started", intent: "blink an LED", boardId: "esp32-c3", locale: "zh-cn" });
  assert.equal(t?.event_type, "session_started");
  assert.equal(t?.payload.intent, "blink an LED");
  assert.equal(t?.payload.locale, "zh-cn");
  assert.equal("intent_hash" in (t?.payload ?? {}), false);
});

test("maps connect_retry to a telemetry event carrying the transport cause", () => {
  // Without this mapping the cloud recorder drops the auto-retry spine, and a
  // session that died on network flaps shows nothing between the last tool_result
  // and session_error — exactly the prod blind spot of 2026-06-11.
  const t = sessionEventToTelemetry("trace-1", { type: "connect_retry", attempt: 2, detail: "fetch failed (ECONNRESET)" });
  assert.equal(t?.event_type, "connect_retry");
  assert.equal(t?.payload.attempt, 2);
  assert.match(String(t?.payload.detail), /ECONNRESET/);
});

test("maps session_retry to a telemetry event", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "session_retry" });
  assert.equal(t?.event_type, "session_retry");
});

// Protocol-loop observability: the V0 protocol loop emits phase_start / status_update /
// phase_complete / approval_requested / components_proposed. mapSessionEvent only knew the
// old agent-backed-loop vocabulary, so these returned null and the cloud DB was blind to
// every phase boundary and approval gate — exactly why a stalled "搜索驱动" was undiagnosable.
test("maps protocol phase_start to a phase_started telemetry event", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "phase_start", phase: "select-hw" });
  assert.equal(t?.event_type, "phase_started");
  assert.equal(t?.payload.phase, "select-hw");
});

test("maps protocol status_update to a status_update telemetry event with its raw payload", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "status_update", payload: { title: "正在搜索驱动", step: "2/3" } });
  assert.equal(t?.event_type, "status_update");
  assert.equal(t?.payload.title, "正在搜索驱动");
  assert.equal(t?.payload.step, "2/3");
});

test("maps protocol phase_complete to a phase_completed event carrying result + next_phase", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "phase_complete", payload: { result: "success", next_phase: "generate" } });
  assert.equal(t?.event_type, "phase_completed");
  assert.equal(t?.payload.result, "success");
  assert.equal(t?.payload.next_phase, "generate");
});

test("maps approval_requested so the approval gate is visible in the DB", () => {
  const t = sessionEventToTelemetry("trace-1", {
    type: "approval_requested",
    promptId: "approval-1",
    card: { kind: "components", actions: [{ value: "confirm", primary: true }, { value: "modify" }] },
  });
  assert.equal(t?.event_type, "approval_requested");
  assert.equal(t?.payload.prompt_id, "approval-1");
  assert.deepEqual(t?.payload.actions, ["confirm", "modify"]);
});

test("maps components_proposed with a device count", () => {
  const t = sessionEventToTelemetry("trace-1", {
    type: "components_proposed",
    promptId: "approval-1",
    devices: [{ name: "DHT22" }, { name: "BH1750" }],
  });
  assert.equal(t?.event_type, "components_proposed");
  assert.equal(t?.payload.prompt_id, "approval-1");
  assert.equal(t?.payload.device_count, 2);
});

test("maps phase_stalled so a stuck phase is visible in the DB (not a silent awaiting_user)", () => {
  const t = sessionEventToTelemetry("trace-1", { type: "phase_stalled", phase: "select-hw", reason: "no_tool_call" });
  assert.equal(t?.event_type, "phase_stalled");
  assert.equal(t?.payload.phase, "select-hw");
  assert.equal(t?.payload.reason, "no_tool_call");
});

test("createTelemetryEvent stamps client meta at the top level when provided", () => {
  const event = createTelemetryEvent("trace-1", "session_started", { a: 1 }, { extension_version: "0.4.1", vscode_version: "1.99.0", platform: "win32 x64" });
  assert.equal(event.extension_version, "0.4.1");
  assert.equal(event.vscode_version, "1.99.0");
  assert.equal(event.platform, "win32 x64");
});

test("createTelemetryEvent omits client meta entirely when absent (backward compatible)", () => {
  const event = createTelemetryEvent("trace-1", "session_started", { a: 1 });
  assert.equal("extension_version" in event, false);
  assert.equal("platform" in event, false);
});

test("maps client self-observability events (error / abandoned / dropped)", () => {
  const err = sessionEventToTelemetry("trace-1", { type: "extension_error", message: "boom", stack: "at x", origin: "onDidReceiveMessage" });
  assert.equal(err?.event_type, "extension_error");
  assert.equal(err?.payload.message, "boom");

  const abandoned = sessionEventToTelemetry("trace-1", { type: "session_abandoned", lastPhase: "generate" });
  assert.equal(abandoned?.event_type, "session_abandoned");
  assert.equal(abandoned?.payload.terminal, "abandoned");
  assert.equal(abandoned?.payload.last_phase, "generate");

  const dropped = sessionEventToTelemetry("trace-1", { type: "telemetry_dropped", dropped: { summary: 3 } });
  assert.equal(dropped?.event_type, "telemetry_dropped");
  assert.deepEqual(dropped?.payload.dropped, { summary: 3 });
});

test("credits_charged carries the per-phase credit-usage record, not just the balance", () => {
  // Card #87: balance-only told the DB that a credit was spent but nothing about what it was
  // spent on, so the free-quota decision had no per-phase or complexity dimension to read.
  // Mutation: drop the usage spread -> the payload is balance/grant/resets only and this fails.
  const usage = { operation: "generate", phase: "upy-generate-plugin", device_count: 3, code_line_count: 210, credits_consumed: 2, remaining_quota: 46, retry_count: 1, cold_driver: true };
  const event = sessionEventToTelemetry("trace-9", {
    type: "session_event",
    event: { kind: "credits", balance: 46, dailyGrant: 50, resetsAt: "2026-07-26T00:00:00Z", usage },
  });

  assert.equal(event?.event_type, "credits_charged");
  assert.equal(event?.payload.balance, 46);
  assert.equal(event?.payload.daily_grant, 50);
  assert.equal(event?.payload.resets_at, "2026-07-26T00:00:00Z");
  assert.equal(event?.payload.operation, "generate");
  assert.equal(event?.payload.phase, "upy-generate-plugin");
  assert.equal(event?.payload.device_count, 3);
  assert.equal(event?.payload.code_line_count, 210);
  assert.equal(event?.payload.credits_consumed, 2);
  assert.equal(event?.payload.cold_driver, true);
});

test("a credits event without a usage record still maps (older recorded sessions)", () => {
  const event = sessionEventToTelemetry("trace-9", {
    type: "session_event",
    event: { kind: "credits", balance: 46, dailyGrant: 50, resetsAt: "2026-07-26T00:00:00Z" },
  });

  assert.equal(event?.event_type, "credits_charged");
  assert.deepEqual(event?.payload, { balance: 46, daily_grant: 50, resets_at: "2026-07-26T00:00:00Z" });
});

test("credit_usage is local-only — it never becomes a second cloud event", () => {
  // Its numbers already ride on credits_charged; posting them again would double-count every
  // turn in the aggregate the free quota is sized from. Mutation: map it -> a second event.
  const event = sessionEventToTelemetry("trace-9", { type: "credit_usage", usage: { operation: "generate", credits_consumed: 2 } });

  assert.equal(event, null);
});
