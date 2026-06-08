import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudTelemetryRecorder, JsonlSessionRecorder } from "../src/extension/session-recorder.ts";

test("JSONL session recorder writes complete ordered events under the session trace id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-sessions-"));
  const recorder = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "trace-1" });

  await recorder.record({ type: "session_started", intent: "build an AI companion", boardId: "esp32-s3-devkitc-1" });
  await recorder.record({
    type: "tool_use",
    id: "toolu_1",
    name: "ask_user",
    input: { question: "OLED or speaker?" },
  });
  await recorder.record({
    type: "tool_result",
    id: "toolu_1",
    name: "ask_user",
    observation: { ok: true, answer: "OLED" },
  });

  const text = await readFile(join(root, ".mpyhw", "sessions", "trace-1", "session.jsonl"), "utf-8");
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3]);
  assert.ok(lines.every((line) => typeof line.ts === "string"));
  assert.equal(lines[0].traceId, "trace-1");
  assert.deepEqual(lines[1].input, { question: "OLED or speaker?" });
  assert.deepEqual(lines[2].observation, { ok: true, answer: "OLED" });
});

test("cloud telemetry recorder maps session events to backend telemetry", async () => {
  const requests: any[] = [];
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, status: 204 } as Response;
    },
    getAuthToken: async () => "jwt-123",
  });

  await recorder.record({ type: "session_started", intent: "build a secret robot", boardId: "esp32-s3-devkitc-1" });
  await recorder.record({ type: "artifact", kind: "code", code: "print('secret')" });
  await recorder.flush();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://api.test/v1/telemetry");
  assert.equal((requests[0].init.headers as any).authorization, "Bearer jwt-123");
  const first = JSON.parse(String(requests[0].init.body));
  assert.equal(first.events[0].trace_id, "trace-1");
  assert.equal(first.events[0].event_type, "session_started");
  assert.equal(first.events[0].payload.board_id, "esp32-s3-devkitc-1");
  assert.equal("intent" in first.events[0].payload, false);
  assert.match(first.events[0].payload.intent_hash, /^[a-f0-9]{64}$/);
  const second = JSON.parse(String(requests[1].init.body));
  assert.equal(second.events[0].event_type, "code_generated");
  assert.equal("code" in second.events[0].payload, false);
  assert.match(second.events[0].payload.code_sha256, /^[a-f0-9]{64}$/);
});

test("cloud telemetry recorder ignores post failures", async () => {
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => { throw new Error("offline"); },
  });

  await recorder.record({ type: "session_finished", terminal: "generated" });
  await recorder.flush();
});
