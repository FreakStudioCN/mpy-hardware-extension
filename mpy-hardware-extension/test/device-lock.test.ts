import assert from "node:assert/strict";
import test from "node:test";

import { DeviceCommandQueue } from "../src/extension/device-lock.ts";

test("runExclusive runs queued commands one at a time, in order", async () => {
  const q = new DeviceCommandQueue();
  const log: string[] = [];
  const gate = (label: string, ms: number) => () =>
    new Promise<string>((resolve) => {
      log.push(`start:${label}`);
      setTimeout(() => { log.push(`end:${label}`); resolve(label); }, ms);
    });
  // b is enqueued while the slower a is still running; it must not START until a ends.
  const a = q.runExclusive(gate("a", 20));
  const b = q.runExclusive(gate("b", 1));
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(log, ["start:a", "end:a", "start:b", "end:b"]);
});

test("a rejecting command does not wedge the queue", async () => {
  const q = new DeviceCommandQueue();
  await assert.rejects(q.runExclusive(() => Promise.reject(new Error("boom"))), /boom/);
  // the next command still runs after the failure
  assert.equal(await q.runExclusive(() => Promise.resolve("ok")), "ok");
});

test("each caller sees its own result/rejection", async () => {
  const q = new DeviceCommandQueue();
  q.runExclusive(() => Promise.reject(new Error("first"))).catch(() => {});
  assert.equal(await q.runExclusive(() => Promise.resolve("second")), "second");
});
