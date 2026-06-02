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

export function sanitizePayload(payload: Record<string, any>) {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "code" && typeof value === "string") {
      sanitized.code_sha256 = createHash("sha256").update(value).digest("hex");
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
