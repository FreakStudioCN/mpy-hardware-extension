import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelemetryOutbox, isProcessAlive } from "../src/extension/telemetry-outbox.ts";

const transient = () => new Error("offline"); // no `status` → retryable
function permanent() {
  return Object.assign(new Error("telemetry_post_failed:422"), { status: 422 });
}

test("an append that lands mid-drain survives the drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-append-race-"));
  const path = join(root, "telemetry-outbox.jsonl");
  const outbox = new TelemetryOutbox({ path });
  await outbox.append({ event_type: "session_started" });

  // A second extension host (a second VS Code window on this workspace) buffers an event while
  // this drain is posting. Nothing in-process can order the two, so the drain must not own the
  // shared file: a read-then-rewrite drain would erase this append when it rewrote or removed
  // the file it had already read.
  const posted: string[] = [];
  await outbox.drain(async (event) => {
    posted.push(event.event_type);
    if (posted.length === 1) await appendFile(path, `${JSON.stringify({ event_type: "runtime_error" })}\n`, "utf-8");
  });

  assert.deepEqual(posted, ["session_started"], "only what was buffered when the drain began");
  assert.match(await readFile(path, "utf-8"), /runtime_error/, "the concurrent append is still buffered");

  const later: string[] = [];
  await outbox.drain(async (event) => { later.push(event.event_type); });
  assert.deepEqual(later, ["runtime_error"], "and the next drain delivers it");
});

test("a claim abandoned by a killed drain is adopted by the next one", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-claim-"));
  const path = join(root, "telemetry-outbox.jsonl");
  // A drain claims the outbox by renaming it, then its host is killed before the events are
  // posted. Only the claim file is left; nothing may strand in it.
  await writeFile(`${path}.${process.pid}-999.claim`, `${JSON.stringify({ event_type: "session_finished" })}\n`, "utf-8");

  const posted: string[] = [];
  await new TelemetryOutbox({ path }).drain(async (event) => { posted.push(event.event_type); });
  assert.deepEqual(posted, ["session_finished"], "the stranded event is delivered");
});

test("a drain stops at the budget and keeps the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-budget-"));
  const path = join(root, "telemetry-outbox.jsonl");
  // flush() is awaited in run()'s finally and in deactivate(); a backlog of events, each of
  // which can burn 30s on a hung backend, must not decide how long either takes.
  // The budget covers the whole drain, claim and file reads included, so it must comfortably
  // outlast those (single-digit ms) while one post outlasts it.
  const outbox = new TelemetryOutbox({ path, drainBudgetMs: 200 });
  await outbox.append({ event_type: "session_started" });
  await outbox.append({ event_type: "session_finished" });

  const posted: string[] = [];
  await outbox.drain(async (event) => {
    posted.push(event.event_type);
    await new Promise((resolve) => setTimeout(resolve, 300)); // outlives the budget
  });

  assert.deepEqual(posted, ["session_started"], "the budget cuts the drain short");
  assert.match(await readFile(path, "utf-8"), /session_finished/, "the undelivered remainder is kept, not dropped");
});

test("the byte ceiling drops new events instead of growing without bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-cap-"));
  const path = join(root, "telemetry-outbox.jsonl");
  const outbox = new TelemetryOutbox({ path, maxBytes: 120 });

  assert.equal(await outbox.append({ event_type: "session_started" }), true);
  let accepted = 1;
  for (let i = 0; i < 20; i++) if (await outbox.append({ event_type: "runtime_error", i })) accepted++;

  assert.ok(accepted < 21, "the ceiling refused events");
  const size = (await readFile(path, "utf-8")).length;
  assert.ok(size < 120 + 60, `outbox stays near its ceiling (was ${size})`);
});

test("a still-transient failure keeps the queue; a permanent one drops only that event", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-outbox-verdict-"));
  const path = join(root, "telemetry-outbox.jsonl");
  const outbox = new TelemetryOutbox({ path });
  await outbox.append({ event_type: "rejected" });
  await outbox.append({ event_type: "session_finished" });

  // A 422 is the server refusing this event forever — retrying it would poison the queue.
  await outbox.drain(async (event) => { if (event.event_type === "rejected") throw permanent(); });
  await assert.rejects(readFile(path, "utf-8"), /ENOENT/, "queue emptied: one dropped, one delivered");

  await outbox.append({ event_type: "session_finished" });
  await outbox.drain(async () => { throw transient(); });
  assert.match(await readFile(path, "utf-8"), /session_finished/, "a network failure keeps the event buffered");
});

test("isProcessAlive answers for this process and rejects nonsense pids", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});
