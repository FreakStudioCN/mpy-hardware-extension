import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlSessionRecorder } from "../src/extension/session-recorder.ts";
import { buildFaultEvent, isOwnError, sweepAbandonedSessions } from "../src/extension/host-telemetry.ts";

// A pid that is certainly gone: run a process to completion and take its id. The sweep must
// distinguish a session whose recording host DIED from one a live host is still writing, and
// the test process itself is alive — so a session recorded here can never stand in for a crash.
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(done.pid && done.status === 0, "helper process ran");
  return done.pid;
}

// Write a session.jsonl exactly as JsonlSessionRecorder does, but owned by a chosen host.
async function writeSession(root: string, id: string, owner: { pid: number; host: string }, events: Record<string, any>[]) {
  const dir = join(root, ".mpyhw", "sessions", id);
  await mkdir(dir, { recursive: true });
  const lines = events.map((event, i) => JSON.stringify({ ...event, seq: i + 1, ts: new Date().toISOString(), traceId: id, ...(i === 0 ? owner : {}) }));
  await writeFile(join(dir, "session.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

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
  // An abandoned session: started, never finished, and the host that was recording it is gone.
  await writeSession(root, "session-aaaa0002-dead", { pid: deadPid(), host: hostname() }, [
    { type: "session_started", intent: "y", boardId: "pico" },
  ]);

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
  await writeSession(root, "session-bbbb0001-dead", { pid: deadPid(), host: hostname() }, [
    { type: "session_started", intent: "y", boardId: "pico" },
  ]);

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

test("sweepAbandonedSessions leaves alone a session a live extension host is still recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-abandoned-live-"));
  // Two VS Code windows on one workspace share this sessions dir. Window A is mid-build:
  // session_started written, no session_finished yet — indistinguishable from a crash by
  // event shape alone, which is why the first line stamps the recording host. This process
  // stands in for window A (it is alive), the sweep for window B activating.
  const live = new JsonlSessionRecorder({ workspaceFolder: root, traceId: "session-cccc0001-live" });
  await live.record({ type: "session_started", intent: "still building", boardId: "esp32" });
  // Same workspace, but recorded by another machine (a synced folder): its pid means nothing
  // here, so the sweep must not judge it either.
  await writeSession(root, "session-cccc0002-remote", { pid: process.pid, host: `${hostname()}-other` }, [
    { type: "session_started", intent: "elsewhere", boardId: "pico" },
  ]);

  const requests: any[] = [];
  const swept = await sweepAbandonedSessions({
    apiBaseUrl: "http://api.test",
    fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; },
    sessionRoot: root,
  });

  assert.deepEqual(swept, [], "a live owner is not a crash");
  assert.equal(requests.length, 0, "nothing reported to the cloud");
  const text = await readFile(join(root, ".mpyhw", "sessions", "session-cccc0001-live", "session.jsonl"), "utf-8");
  assert.doesNotMatch(text, /session_abandoned/, "a live session's log is not stamped terminal under it");
});

test("sweepAbandonedSessions holds the local marker back when the report is neither sent nor buffered", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-abandoned-lost-"));
  await writeSession(root, "session-dddd0001-dead", { pid: deadPid(), host: hostname() }, [
    { type: "session_started", intent: "y", boardId: "pico" },
  ]);
  // Backend down AND the outbox already at its byte ceiling, so the report can be neither
  // delivered nor buffered. The local marker is one-shot — spending it here would erase the
  // only trace that this crash was never reported.
  const outbox = join(root, ".mpyhw", "telemetry-outbox.jsonl");
  await mkdir(join(root, ".mpyhw"), { recursive: true });
  await writeFile(outbox, `${JSON.stringify({ event_type: "session_finished", payload: { blob: "x".repeat(2 * 1024 * 1024) } })}\n`, "utf-8");

  const offline = { apiBaseUrl: "http://api.test", fetchImpl: async () => { throw new Error("offline"); }, sessionRoot: root };
  assert.deepEqual(await sweepAbandonedSessions(offline), [], "nothing is claimed as reported");
  const jsonl = join(root, ".mpyhw", "sessions", "session-dddd0001-dead", "session.jsonl");
  assert.doesNotMatch(await readFile(jsonl, "utf-8"), /session_abandoned/, "no marker burned on a lost report");

  // Room in the outbox again and a reachable backend: the same session is still sweepable.
  await writeFile(outbox, "", "utf-8");
  const requests: any[] = [];
  const up = { apiBaseUrl: "http://api.test", fetchImpl: async (_url: string, init?: RequestInit) => { requests.push(init); return { ok: true, status: 204 } as Response; }, sessionRoot: root };
  assert.deepEqual(await sweepAbandonedSessions(up), ["session-dddd0001-dead"], "reported once the report can actually land");
  assert.ok(requests.some((r) => JSON.parse(String(r.body)).events[0].event_type === "session_abandoned"));
  assert.match(await readFile(jsonl, "utf-8"), /session_abandoned/, "marker written now that the report is durable");
});
