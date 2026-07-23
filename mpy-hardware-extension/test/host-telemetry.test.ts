import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlSessionRecorder } from "../src/extension/session-recorder.ts";
import { buildFaultEvent, isOwnError, sweepAbandonedSessions } from "../src/extension/host-telemetry.ts";

test("isOwnError only claims a fault whose stack points at this extension", () => {
  assert.equal(isOwnError("at foo (/ext/mpy-hardware-extension/dist/x.js:1)", "/ext/mpy-hardware-extension"), true);
  assert.equal(isOwnError("at bar (/other-extension/dist/y.js:1)", "/ext/mpy-hardware-extension"), false);
  assert.equal(isOwnError(undefined, "/ext/mpy-hardware-extension"), false);
  assert.equal(isOwnError("at z (/x)", undefined), false);
});

test("buildFaultEvent attaches message+stack for OUR fault but never for another extension's", () => {
  const ownStack = "Error: boom\n    at f (/ext/mpy-hardware-extension/dist/x.js:1:1)";
  const own = buildFaultEvent(Object.assign(new Error("boom"), { stack: ownStack }), "uncaughtException", "/ext/mpy-hardware-extension");
  assert.equal(own.type, "extension_error");
  assert.equal(own.message, "boom");
  assert.equal(own.stack, ownStack);

  // A foreign extension's error: the shared host process surfaces it to us, but its message
  // and stack may carry that extension's tokens/paths/source — we must upload neither.
  const foreignStack = "Error: secret token ghp_abcd\n    at g (/other-extension/dist/y.js:2:2)";
  const foreign = buildFaultEvent(Object.assign(new Error("secret token ghp_abcd"), { stack: foreignStack }), "unhandledRejection", "/ext/mpy-hardware-extension");
  assert.equal(foreign.type, "extension_host_error_observed");
  assert.equal(foreign.origin, "unhandledRejection");
  assert.equal(foreign.message, undefined, "no foreign message uploaded");
  assert.equal(foreign.stack, undefined, "no foreign stack uploaded");
});

test("sweepAbandonedSessions reports only unfinished sessions, posts them, and does not re-report", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-abandoned-"));
  // A finished session — must NOT be swept.
  const done = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0001-done" });
  await done.record({ type: "session_started", intent: "x", boardId: "esp32" });
  await done.record({ type: "session_finished", terminal: "generated" });
  // An abandoned session (started, never finished, i.e. the host crashed) — must be swept.
  const dead = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-aaaa0002-dead" });
  await dead.record({ type: "session_started", intent: "y", boardId: "pico" });

  const requests: any[] = [];
  const deps = {
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
    sessionRoot: root,
  };

  const swept = await sweepAbandonedSessions(deps);
  assert.deepEqual(swept, ["session-aaaa0002-dead"], "only the unfinished session is swept");
  const posted = requests.map((r) => JSON.parse(String(r.body)).events[0]);
  assert.ok(posted.some((e) => e.event_type === "session_abandoned"), "session_abandoned posted to cloud");
  // Marker written back into the JSONL → finalPhase non-empty → not re-swept next time.
  assert.match(await readFile(join(root, ".mpyhw", "sessions", "session-aaaa0002-dead", "session.jsonl"), "utf-8"), /session_abandoned/);

  const again = await sweepAbandonedSessions(deps);
  assert.deepEqual(again, [], "a session reported once is not reported again");
});

test("sweepAbandonedSessions still marks a session locally when the cloud is unreachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-abandoned-offline-"));
  const dead = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-bbbb0001-dead" });
  await dead.record({ type: "session_started", intent: "y", boardId: "pico" });

  // Backend down during the sweep: the cloud post fails, but it fails as a transient error
  // that buffers to the durable outbox — the sweep must not reject, and it must still append
  // the local session_abandoned marker so the session is not re-swept next activation.
  const deps = {
    apiBaseUrl: "http://api.test",
    fetchImpl: async () => { throw new Error("offline"); },
    sessionRoot: root,
  };
  const swept = await sweepAbandonedSessions(deps);
  assert.deepEqual(swept, ["session-bbbb0001-dead"], "sweep completes despite the cloud being down");
  assert.match(await readFile(join(root, ".mpyhw", "sessions", "session-bbbb0001-dead", "session.jsonl"), "utf-8"), /session_abandoned/);

  const again = await sweepAbandonedSessions(deps);
  assert.deepEqual(again, [], "local marker means it is not re-swept even though the cloud never got it");
});
