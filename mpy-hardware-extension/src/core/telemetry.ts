// Per-field byte budget for the size guard. Telemetry is stored RAW (no hashing)
// so a trace is replayable, but a single oversized field (a flapping device's
// serial flood, a giant generated file) is truncated — with a _truncated marker —
// rather than dropped, keeping each event well under the server's MAX_TELEMETRY_BYTES.
const FIELD_BYTE_BUDGET = 48 * 1024;

export function createTelemetryEvent(traceId: string, eventType: string, payload: Record<string, any>) {
  return {
    trace_id: traceId,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    payload: sanitizePayload(payload),
  };
}

export function sessionEventToTelemetry(traceId: string, event: Record<string, any>) {
  const mapped = mapSessionEvent(event);
  return mapped ? createTelemetryEvent(traceId, mapped.eventType, mapped.payload) : null;
}

// Size guard, not a redactor: fields pass through verbatim (we want the real
// intent/code/serial/error for debugging), but any string or array that blows the
// per-field budget is truncated and the payload is flagged `_truncated`. Recurses
// into nested objects/arrays so a big value buried inside an observation is caught
// too. Never drops the event.
export function sanitizePayload(payload: Record<string, any>) {
  const state = { truncated: false };
  const guarded = guardValue(payload, state) as Record<string, any>;
  if (state.truncated) guarded._truncated = true;
  return guarded;
}

function guardValue(value: any, state: { truncated: boolean }): any {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > FIELD_BYTE_BUDGET) {
      state.truncated = true;
      return Buffer.from(value, "utf8").subarray(0, FIELD_BYTE_BUDGET).toString("utf8");
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Keep the TAIL within budget (most recent serial lines matter most), guarding
    // each kept element.
    const kept: any[] = [];
    let size = 0;
    for (let i = value.length - 1; i >= 0; i--) {
      const element = guardValue(value[i], state);
      const len = Buffer.byteLength(JSON.stringify(element) ?? "", "utf8");
      if (size + len > FIELD_BYTE_BUDGET && kept.length > 0) {
        state.truncated = true;
        break;
      }
      kept.unshift(element);
      size += len;
    }
    return kept;
  }
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = guardValue(inner, state);
    return out;
  }
  return value;
}

function mapSessionEvent(event: Record<string, any>): { eventType: string; payload: Record<string, any> } | null {
  if (event.type === "session_started") {
    return { eventType: "session_started", payload: { intent: event.intent, board_id: event.boardId } };
  }
  if (event.type === "user_message") {
    return { eventType: "intent_submitted", payload: { intent: event.intent, board_id: event.boardId } };
  }
  if (event.type === "plan_proposed") {
    return { eventType: "manifest_proposed", payload: planPayload(event.plan) };
  }
  if (event.type === "deploy_proposed") {
    return { eventType: "deploy_checkpoint_shown", payload: manifestPayload(event.manifest) };
  }
  if (event.type === "ui_prompt_answer") {
    if (String(event.promptId ?? "").startsWith("plan-")) {
      return { eventType: event.answer === "confirm" ? "plan_confirmed" : "plan_cancelled", payload: {} };
    }
    if (String(event.promptId ?? "").startsWith("deploy-")) {
      return { eventType: event.answer === "confirm" ? "deploy_confirmed" : "deploy_cancelled", payload: {} };
    }
  }
  if (event.type === "artifact" && event.kind === "code") {
    return { eventType: "code_generated", payload: { code: event.code } };
  }
  // Diagnostic tier — events the agent loop records directly (agent-loop.ts /
  // agent-backed-loop.ts). Without these cases the cloud recorder dropped the whole
  // failure spine (which tool ran, the device runtime error, audit rejections), so a
  // repair_exhausted was undiagnosable from the DB.
  if (event.type === "tool_use") {
    return { eventType: "tool_dispatch", payload: { tool: event.name, input: event.input } };
  }
  if (event.type === "tool_result") {
    return compactToolResult(event.name, event.observation ?? {});
  }
  if (event.type === "llm_error") {
    return { eventType: "llm_upstream_error", payload: { kind: event.kind, error: event.error } };
  }
  if (event.type === "serial_output") {
    return { eventType: "serial_output", payload: { lines: event.lines } };
  }
  if (event.type === "session_event" && event.event?.kind === "credits") {
    return {
      eventType: "credits_charged",
      payload: { balance: event.event.balance, daily_grant: event.event.dailyGrant, resets_at: event.event.resetsAt },
    };
  }
  if (event.type === "session_error") {
    return { eventType: "session_error", payload: { error: event.error } };
  }
  if (event.type === "session_finished") {
    return {
      eventType: "session_finished",
      payload: { terminal: event.terminal, repair_round: event.state?.repairRound, no_progress_streak: event.state?.noProgressStreak },
    };
  }
  if (event.type === "trace_event") {
    return traceEventPayload(event.event);
  }
  return null;
}

// Shared shaping for a tool observation, used by BOTH the direct tool_result path
// above and the trace_event-wrapped path below. A runtime_error maps to its own
// event_type (the server increments sessions.repair_count on it); an audit rejection
// carries the disallowed imports; every other failure/success is a compact tool_result.
function compactToolResult(name: string, obs: any): { eventType: string; payload: Record<string, any> } {
  const errorKind = obs?.error_kind;
  if (errorKind === "runtime_error") {
    return { eventType: "runtime_error", payload: { error_kind: errorKind, error: obs.error, lines: obs.lines, tool: name } };
  }
  if (errorKind === "audit_failed") {
    return { eventType: "audit_failed", payload: { error_kind: errorKind, disallowed_imports: obs.disallowed_imports, tool: name } };
  }
  if (obs?.ok === false) {
    return { eventType: "tool_result", payload: { tool: name, ok: false, error_kind: errorKind, error: obs.error } };
  }
  return { eventType: "tool_result", payload: { tool: name, ok: true } };
}

function traceEventPayload(event: any): { eventType: string; payload: Record<string, any> } | null {
  if (event?.type === "tool_dispatch") return { eventType: "tool_dispatch", payload: { tool: event.tool, input: event.input } };
  if (event?.type === "tool_result") return compactToolResult(event.tool, event);
  if (event?.type === "package_resolved") return { eventType: "package_resolved", payload: { name: event.name, version: event.version } };
  if (event?.type === "audit_passed") return { eventType: "audit_passed", payload: {} };
  if (event?.type === "audit_failed") return { eventType: "audit_failed", payload: { error_kind: event.error_kind, disallowed_imports: event.disallowed_imports, tool: event.tool } };
  if (event?.type === "runtime_error") return { eventType: "runtime_error", payload: { error_kind: event.error_kind, error: event.error, lines: event.lines, tool: event.tool } };
  return null;
}

function planPayload(plan: any): Record<string, any> {
  return {
    board_id: plan?.board_id ?? plan?.manifest?.board_id,
    estimated_credits: plan?.estimatedCredits ?? plan?.estimated_credits,
    device_count: Array.isArray(plan?.devices) ? plan.devices.length
      : Array.isArray(plan?.manifest?.devices) ? plan.manifest.devices.length
      : undefined,
  };
}

function manifestPayload(manifest: any): Record<string, any> {
  return {
    board_id: manifest?.board_id ?? manifest?.mcu?.board_id,
    device_count: Array.isArray(manifest?.devices) ? manifest.devices.length : undefined,
  };
}
