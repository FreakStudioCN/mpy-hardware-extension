import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudTelemetryRecorder, CompositeSessionRecorder, JsonlSessionRecorder, listRecentSessions, selectRecentSessionIds, withTimeout } from "../src/extension/session-recorder.ts";

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

test("listRecentSessions summarizes past sessions newest-first, capped at the limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-recent-"));

  // Realistic trace ids: `session-<base36 creation ms>-<rand>`, so the newer session's
  // dir name sorts after the older one (which is how the cap-before-read selects them).
  // Older session (finished).
  const older = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0001-old0" });
  await older.record({ type: "session_started", intent: "read a sensor", boardId: "pico" });
  await older.record({ type: "session_finished", terminal: "cancelled" });
  // Newer session (finished) — written second so its first-event ts is later.
  const newer = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0002-new0" });
  await newer.record({ type: "session_started", intent: "blink an LED", boardId: "esp32" });
  await newer.record({ type: "session_finished", terminal: "generated" });

  const all = await listRecentSessions(root, 20);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, "session-aaaa0002-new0", "newest session first");
  assert.equal(all[0].intent, "blink an LED");
  assert.equal(all[0].finalPhase, "generated");
  assert.match(all[0].path, /session-aaaa0002-new0[\\/]session\.jsonl$/);
  assert.equal(all[1].id, "session-aaaa0001-old0");
  assert.equal(all[1].finalPhase, "cancelled");

  const capped = await listRecentSessions(root, 1);
  assert.deepEqual(capped.map((s) => s.id), ["session-aaaa0002-new0"], "limit caps the list to newest N");
});

test("listRecentSessions returns [] when no sessions dir exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-recent-empty-"));
  assert.deepEqual(await listRecentSessions(root, 20), []);
});

test("selectRecentSessionIds ranks real session dirs newest-first and drops foreign entries", () => {
  // JsonlSessionRecorder names each dir `session-<base36 creation ms>-<rand>`, so a
  // descending name sort is recency order. Non-session entries (.DS_Store, a legacy
  // "trace-*" id that sorts ahead of "session-*") must be dropped so they can't consume
  // a slot or misorder the ranking.
  const ids = [
    "session-aaaa0001-old",
    ".DS_Store",
    "session-aaaa0003-new",
    "trace-legacy-1",
    "session-aaaa0002-mid",
  ];
  assert.deepEqual(selectRecentSessionIds(ids), [
    "session-aaaa0003-new",
    "session-aaaa0002-mid",
    "session-aaaa0001-old",
  ]);
});

test("selectRecentSessionIds keeps an empty-random-suffix id but drops malformed shapes", () => {
  // Math.random()===0 makes createTraceId emit `session-<ts>-` (empty suffix); that is a
  // real id and must be kept. Multi-dash / non-base36 names are still dropped.
  assert.deepEqual(
    selectRecentSessionIds(["session-abc0-", "session-abc0-x1", "session-a-b-c", "session--x"]),
    ["session-abc0-x1", "session-abc0-"],
  );
});

test("listRecentSessions backfills past a whole batch of crashed/empty newest dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-recent-backfill-"));

  const a = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0001-aaaa" });
  await a.record({ type: "session_started", intent: "read a sensor", boardId: "pico" });
  await a.record({ type: "session_finished", terminal: "generated" });
  const b = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0002-bbbb" });
  await b.record({ type: "session_started", intent: "blink an LED", boardId: "esp32" });
  await b.record({ type: "session_finished", terminal: "generated" });
  // Two crashed sessions, both newer by name than the valid ones: dir exists but the
  // session.jsonl was never written. With limit=2 they fill an entire first read batch,
  // so a naive newest-N cap would starve; the backfill must read the next batch.
  await mkdir(join(root, ".mpyhw", "sessions", "session-aaaa0003-dead"), { recursive: true });
  await mkdir(join(root, ".mpyhw", "sessions", "session-aaaa0004-dead"), { recursive: true });

  const recent = await listRecentSessions(root, 2);
  assert.deepEqual(recent.map((s) => s.intent), ["blink an LED", "read a sensor"], "empty dirs skipped, both valid sessions returned");
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
  // Raw storage: the actual intent and code survive (no hashing).
  assert.equal(first.events[0].payload.intent, "build a secret robot");
  const second = JSON.parse(String(requests[1].init.body));
  assert.equal(second.events[0].event_type, "code_generated");
  assert.equal(second.events[0].payload.code, "print('secret')");
});

test("cloud telemetry recorder forwards a failed runtime tool_result as a runtime_error", async () => {
  const requests: any[] = [];
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, status: 204 } as Response;
    },
  });

  // A successful tool_result is a compact row; the runtime failure carries the real
  // device error + serial so a repair_exhausted is diagnosable.
  await recorder.record({ type: "tool_use", name: "write_main_py", input: { path: "main.py" } });
  await recorder.record({ type: "tool_result", name: "read_serial_until", observation: { ok: false, error_kind: "runtime_error", error: "ImportError: no module named ssd1306", lines: ["MPYHW_READY"] } });
  await recorder.flush();

  assert.equal(requests.length, 2);
  const dispatch = JSON.parse(String(requests[0].init.body)).events[0];
  assert.equal(dispatch.event_type, "tool_dispatch");
  assert.equal(dispatch.payload.tool, "write_main_py");
  const runtime = JSON.parse(String(requests[1].init.body)).events[0];
  assert.equal(runtime.event_type, "runtime_error");
  assert.equal(runtime.payload.error, "ImportError: no module named ssd1306");
  assert.deepEqual(runtime.payload.lines, ["MPYHW_READY"]);
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

test("cloud telemetry recorder stamps client attribution on every event", async () => {
  const requests: any[] = [];
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
    clientMeta: { extension_version: "0.4.1", vscode_version: "1.99.0", platform: "win32 x64" },
  });

  await recorder.record({ type: "session_started", intent: "x", boardId: "esp32" });
  await recorder.flush();

  const ev = JSON.parse(String(requests[0].body)).events[0];
  assert.equal(ev.extension_version, "0.4.1");
  assert.equal(ev.vscode_version, "1.99.0");
  assert.equal(ev.platform, "win32 x64");
});

test("cloud telemetry recorder buffers a transient failure and a later session drains it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-"));
  const outboxPath = join(root, "telemetry-outbox.jsonl");

  // First session: backend unreachable (network error) -> event buffered, not lost.
  const down = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => { throw new Error("offline"); },
    outboxPath,
  });
  await down.record({ type: "session_finished", terminal: "generated" });
  await down.flush();
  assert.match(await readFile(outboxPath, "utf-8"), /session_finished/, "transient failure is buffered");

  // Next session: backend up -> the constructor drain redelivers it and empties the outbox.
  const requests: any[] = [];
  const up = new CloudTelemetryRecorder({
    traceId: "trace-2",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
    outboxPath,
  });
  await up.flush();

  assert.equal(requests.length, 1, "buffered event redelivered on next session");
  assert.equal(JSON.parse(String(requests[0].body)).events[0].event_type, "session_finished");
  await assert.rejects(readFile(outboxPath, "utf-8"), /ENOENT/, "outbox emptied after a successful drain");
});

test("cloud telemetry recorder drops a permanent 4xx instead of buffering it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-4xx-"));
  const outboxPath = join(root, "telemetry-outbox.jsonl");
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => ({ ok: false, status: 422 } as Response),
    outboxPath,
  });

  await recorder.record({ type: "session_finished", terminal: "generated" });
  await recorder.flush();

  await assert.rejects(readFile(outboxPath, "utf-8"), /ENOENT/, "a 422 is permanent — never buffered, so no retry loop");
});

test("composite recorder flush fans out to both children", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-composite-"));
  const requests: any[] = [];
  const cloud = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
  });
  const jsonl = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "trace-1" });
  const composite = new CompositeSessionRecorder([jsonl, cloud]);

  await composite.record({ type: "session_started", intent: "x", boardId: "esp32" });
  await composite.flush();

  assert.equal(requests.length, 1, "cloud child posted");
  assert.match(await readFile(join(root, ".mpyhw", "sessions", "trace-1", "session.jsonl"), "utf-8"), /session_started/, "jsonl child wrote");
});

test("concurrent drains of a shared outbox deliver each buffered event exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-race-"));
  const outboxPath = join(root, "telemetry-outbox.jsonl");

  // Buffer three events while the backend is down.
  const down = new CloudTelemetryRecorder({
    traceId: "trace-down",
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => { throw new Error("offline"); },
    outboxPath,
  });
  await down.record({ type: "session_started", intent: "a", boardId: "esp32" });
  await down.record({ type: "tool_result", name: "read_serial_until", observation: { ok: false, error_kind: "runtime_error", error: "boom" } });
  await down.record({ type: "session_finished", terminal: "generated" });
  await down.flush();

  // Two recorders share the SAME outbox and drain it at the same time. Each post yields a
  // macrotask first, so without serialization both drains would read the same file and
  // re-post every buffered event (the server has no dedup key). withOutboxLock must make the
  // second drain see an already-emptied file, so each event is delivered exactly once.
  const posted: string[] = [];
  const slowOk = async (_url: string, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    posted.push(JSON.parse(String(init!.body)).events[0].event_type);
    return { ok: true, status: 204 } as Response;
  };
  const a = new CloudTelemetryRecorder({ traceId: "trace-a", apiBaseUrl: "http://api.test", fetchImpl: slowOk, outboxPath });
  const b = new CloudTelemetryRecorder({ traceId: "trace-b", apiBaseUrl: "http://api.test", fetchImpl: slowOk, outboxPath });
  await Promise.all([a.flush(), b.flush()]);

  assert.deepEqual(posted.sort(), ["runtime_error", "session_finished", "session_started"], "each buffered event delivered exactly once");
  await assert.rejects(readFile(outboxPath, "utf-8"), /ENOENT/, "outbox emptied after the concurrent drains");
});

test("withTimeout rejects a slow await so a hung auth-token fetch can't stall flush", async () => {
  // post() wraps getAuthToken() in withTimeout: a token exchange that responds too late (here,
  // never within the window) must not hang post() -> flush() -> run()'s finally. The rejection
  // has no `status`, so isTransient() buffers the event for a later retry.
  // The keepalive timer is REF'd on purpose: withTimeout's own timer is unref'd (production
  // hygiene — it must not hold the extension host open at shutdown), so without a ref'd handle
  // the event loop would drain before the 5ms deadline fires. Cleared after the assertion.
  let keepalive: any;
  const slow = new Promise((resolve) => { keepalive = setTimeout(resolve, 2000); });
  await assert.rejects(withTimeout(slow, 5), /telemetry_timeout/);
  clearTimeout(keepalive);
});

test("withTimeout passes a value through unchanged when it settles in time", async () => {
  assert.equal(await withTimeout(Promise.resolve("jwt-abc"), 1000), "jwt-abc");
  await assert.rejects(withTimeout(Promise.reject(new Error("auth_down")), 1000), /auth_down/);
});

test("flush resolves even when the outbox path is unusable (never throws out of run's finally)", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-bad-"));
  // The outbox "file" is actually a directory, so every outbox read/write fails. flush() is
  // awaited in run()'s finally; a throw there would mask the run's real result, so a drain
  // failure must be swallowed and flush() must still resolve.
  const outboxPath = join(root, "outbox-is-a-dir");
  await mkdir(outboxPath, { recursive: true });
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => { throw new Error("offline"); },
    outboxPath,
  });

  await recorder.record({ type: "session_finished", terminal: "generated" });
  await recorder.flush(); // resolves — the assertion is simply that this line does not throw
});

test("cloud telemetry recorder emits a telemetry_dropped histogram on flush", async () => {
  const requests: any[] = [];
  const recorder = new CloudTelemetryRecorder({
    traceId: "trace-1",
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
  });

  // assistant_text maps to null (local-only) -> counted, not posted.
  await recorder.record({ type: "assistant_text", text: "hi" });
  await recorder.record({ type: "assistant_text", text: "again" });
  assert.deepEqual(recorder.getDroppedCounts(), { assistant_text: 2 });

  await recorder.flush();
  const dropped = requests.map((r) => JSON.parse(String(r.body)).events[0]).find((e) => e.event_type === "telemetry_dropped");
  assert.ok(dropped, "a telemetry_dropped event is posted on flush");
  assert.deepEqual(dropped.payload.dropped, { assistant_text: 2 });
});
