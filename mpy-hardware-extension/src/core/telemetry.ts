import { createHash } from "node:crypto";

const SERIAL_LIMIT = 20;

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

export function sanitizePayload(payload: Record<string, any>) {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "code" && typeof value === "string") {
      sanitized.code_sha256 = createHash("sha256").update(value).digest("hex");
      continue;
    }
    if ((key === "intent" || key === "prompt") && typeof value === "string") {
      sanitized.intent_hash = createHash("sha256").update(value).digest("hex");
      continue;
    }
    if (key === "serial_lines" && Array.isArray(value)) {
      sanitized.serial_lines = value.slice(-SERIAL_LIMIT);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
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
    return { eventType: "session_finished", payload: { terminal: event.terminal } };
  }
  if (event.type === "trace_event") {
    return traceEventPayload(event.event);
  }
  return null;
}

function traceEventPayload(event: any): { eventType: string; payload: Record<string, any> } | null {
  if (event?.type === "tool_dispatch") return { eventType: "tool_dispatch", payload: { tool: event.tool } };
  if (event?.type === "tool_result") return { eventType: "tool_result", payload: { tool: event.tool, ok: event.ok, error_kind: event.error_kind } };
  if (event?.type === "package_resolved") return { eventType: "package_resolved", payload: { name: event.name, version: event.version } };
  if (event?.type === "audit_passed") return { eventType: "audit_passed", payload: {} };
  if (event?.type === "audit_failed") return { eventType: "audit_failed", payload: { error_kind: event.error_kind, disallowed_imports: event.disallowed_imports } };
  if (event?.type === "runtime_error") return { eventType: "runtime_error", payload: { error_kind: event.error_kind, error: event.error } };
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
