import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryEvent, sanitizePayload } from "../src/core/telemetry.ts";

test("telemetry event includes required metadata and sanitizes payload", () => {
  const event = createTelemetryEvent("trace-1", "tool_dispatch", {
    code: "print('secret')",
    serial_lines: Array.from({ length: 50 }, (_, index) => `line-${index}`),
  });

  assert.equal(event.trace_id, "trace-1");
  assert.equal(event.event_type, "tool_dispatch");
  assert.ok(event.timestamp);
  assert.equal("code" in event.payload, false);
  assert.match(event.payload.code_sha256, /^[a-f0-9]{64}$/);
  assert.equal(event.payload.serial_lines.length, 20);
});

test("sanitize payload omits raw full code", () => {
  const payload = sanitizePayload({ code: "import socket\nprint('x')" });

  assert.deepEqual(Object.keys(payload), ["code_sha256"]);
});
