import assert from "node:assert/strict";
import test from "node:test";

import { executeProtocolTool } from "../src/core/protocol-loop.ts";

// §3.3 host-side idempotency: a mutating op replayed with the SAME id (op_id / cmd_id)
// within one build must run its side effect exactly once and replay the first result.
// The store is the per-run Map threaded from runProtocolBuild; these tests exercise the
// executor directly with a shared Map, the way the loop passes it.

const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });

test("a file write replayed with the same op_id runs the side effect once", async () => {
  const writes: Array<[string, string]> = [];
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    writeFile: async (path: string, content: string) => { writes.push([path, content]); return { ok: true, path }; },
  } as any;
  const idem = new Map<string, any>();
  const msg = tu("t1", "file_operation", { op: "write", path: "firmware/main.py", content: "print(1)", op_id: "w1" }) as any;

  const first = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);
  const second = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);

  assert.equal(first.result.ok, true);
  assert.equal(first.result.deduped, undefined, "the first call is not a replay");
  assert.equal(second.result.deduped, true, "the second call is served from the idempotency store");
  assert.equal(writes.length, 1, "the workspace write must run exactly once");
});

test("different op_ids both execute (dedup is per-id, not per-path)", async () => {
  const writes: string[] = [];
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    writeFile: async (path: string) => { writes.push(path); return { ok: true, path }; },
  } as any;
  const idem = new Map<string, any>();

  await executeProtocolTool(tu("a", "file_operation", { op: "write", path: "firmware/main.py", content: "a", op_id: "w1" }) as any, { intent: "x" } as any, deps, idem);
  await executeProtocolTool(tu("b", "file_operation", { op: "write", path: "firmware/main.py", content: "b", op_id: "w2" }) as any, { intent: "x" } as any, deps, idem);

  assert.equal(writes.length, 2);
});

test("read operations are never cached (a re-read returns fresh content, not a stale replay)", async () => {
  let reads = 0;
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    readFile: async () => { reads += 1; return { ok: true, content: `read-${reads}` }; },
  } as any;
  const idem = new Map<string, any>();
  const msg = tu("r", "file_operation", { op: "read", path: "firmware/main.py", op_id: "r1" }) as any;

  const first = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);
  const second = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);

  assert.equal(first.result.content, "read-1");
  assert.equal(second.result.content, "read-2", "the read ran again");
  assert.equal(second.result.deduped, undefined);
});

test("an irreversible device flash replayed with the same cmd_id flashes once", async () => {
  let flashes = 0;
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    device: async (action: string) => { if (action === "flash_firmware") flashes += 1; return { ok: true, stdout: "flashed" }; },
  } as any;
  const idem = new Map<string, any>();
  const msg = tu("f", "device_command", { action: "flash_firmware", cmd_id: "c1" }) as any;

  await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);
  const replay = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);

  assert.equal(flashes, 1, "the board must be flashed exactly once, not twice");
  assert.equal(replay.result.deduped, true);
});

test("a failed op is NOT cached, so a retry re-runs the side effect", async () => {
  const attempts: boolean[] = [];
  let ok = false;
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    // First attempt fails (transient), second succeeds.
    writeFile: async () => { attempts.push(ok); const r = { ok, path: "firmware/main.py" }; ok = true; return r; },
  } as any;
  const idem = new Map<string, any>();
  const msg = tu("t", "file_operation", { op: "write", path: "firmware/main.py", content: "x", op_id: "w1" }) as any;

  const first = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);
  const second = await executeProtocolTool(msg, { intent: "x" } as any, deps, idem);

  assert.equal(first.result.ok, false, "first attempt failed");
  assert.equal(second.result.ok, true, "retry actually re-ran and succeeded");
  assert.equal(second.result.deduped, undefined, "a failure must not be served from the cache");
  assert.equal(attempts.length, 2);
});

test("without an idempotency store (a one-off call), behavior is unchanged — no dedup", async () => {
  const writes: string[] = [];
  const deps = {
    llmClient: { streamMessages: async () => (async function* () {})() },
    writeFile: async (path: string) => { writes.push(path); return { ok: true, path }; },
  } as any;
  const msg = tu("t", "file_operation", { op: "write", path: "firmware/main.py", content: "x", op_id: "w1" }) as any;

  const first = await executeProtocolTool(msg, { intent: "x" } as any, deps);
  const second = await executeProtocolTool(msg, { intent: "x" } as any, deps);

  assert.equal(first.result.ok, true);
  assert.equal(second.result.deduped, undefined);
  assert.equal(writes.length, 2, "no store means no cross-call dedup (backward compatible)");
});
