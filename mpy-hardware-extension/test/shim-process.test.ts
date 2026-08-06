import assert from "node:assert/strict";
import test from "node:test";

import { ShimProcess } from "../src/extension/shim-process.ts";

test("shim process frames JSON-RPC requests and resolves matching response", async () => {
  const writes: string[] = [];
  const shim = new ShimProcess({ write: (line: string) => writes.push(line) });
  const pending = shim.request("device.scan", {});
  const sent = JSON.parse(writes[0]);

  assert.equal(sent.method, "device.scan");
  assert.equal(sent.id, 1);

  shim.handleStdoutLine(JSON.stringify({ id: 1, result: { ports: ["COM3"] } }));
  assert.deepEqual(await pending, { ports: ["COM3"] });
});

test("shim stderr and crash become diagnostic events", () => {
  const events: any[] = [];
  const shim = new ShimProcess({ write: () => undefined, onEvent: (event) => events.push(event) });

  shim.handleStderr("bad serial");
  shim.handleExit(1);

  assert.deepEqual(events, [{ type: "stderr", message: "bad serial" }, { type: "shim_crash", code: 1 }]);
});

test("shim crash rejects pending requests", async () => {
  const shim = new ShimProcess({ write: () => undefined });
  const pending = shim.request("device.scan", {});

  shim.handleExit(1);

  await assert.rejects(
    Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 20)),
    ]),
    /shim exited/,
  );
});

test("shim request rejects on timeout and clears the pending request", async () => {
  const shim = new ShimProcess({ write: () => undefined });

  await assert.rejects(() => shim.request("device.scan", {}, 5), /shim_request_timeout/);
  assert.equal(shim.pending.size, 0);
});

test("late shim response after timeout is ignored", async () => {
  const shim = new ShimProcess({ write: () => undefined });

  await assert.rejects(() => shim.request("device.scan", {}, 5), /shim_request_timeout/);
  assert.doesNotThrow(() => shim.handleStdoutLine(JSON.stringify({ id: 1, result: { devices: [] } })));
  assert.equal(shim.pending.size, 0);
});

test("a serial.data notification (method, no matching pending id) fires onEvent, not a pending RPC", () => {
  const events: any[] = [];
  const shim = new ShimProcess({ write: () => undefined, onEvent: (event) => events.push(event) });

  // No pending map entries at all — the monitor can push before/between any RPC.
  assert.doesNotThrow(() => shim.handleStdoutLine(JSON.stringify({ jsonrpc: "2.0", method: "serial.data", params: { lines: ["boot", "MPYHW_READY"] } })));

  assert.deepEqual(events, [{ type: "serial_data", lines: ["boot", "MPYHW_READY"] }]);
  assert.equal(shim.pending.size, 0);
});

test("a serial.data notification never resolves an in-flight RPC of the same shape", async () => {
  // Regression: a naive dispatch keyed only on `id` could treat a notification (id
  // undefined) as a response to whatever pending entry happens to key on undefined.
  // Mutation: drop the `message.method !== undefined` branch -> this test still passes
  // today (no entry keys on undefined), but guards the invariant explicitly.
  const shim = new ShimProcess({ write: () => undefined });
  const pending = shim.request("device.scan", {});

  shim.handleStdoutLine(JSON.stringify({ jsonrpc: "2.0", method: "serial.data", params: { lines: ["x"] } }));
  shim.handleStdoutLine(JSON.stringify({ id: 1, result: { devices: [] } }));

  assert.deepEqual(await pending, { devices: [] });
});

test("an unrecognized notification method is ignored, not thrown", () => {
  const events: any[] = [];
  const shim = new ShimProcess({ write: () => undefined, onEvent: (event) => events.push(event) });

  assert.doesNotThrow(() => shim.handleStdoutLine(JSON.stringify({ jsonrpc: "2.0", method: "future.thing", params: {} })));
  assert.deepEqual(events, []);
});
