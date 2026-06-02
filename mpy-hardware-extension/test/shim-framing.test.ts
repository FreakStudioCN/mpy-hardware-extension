import assert from "node:assert/strict";
import test from "node:test";

import { ShimProcess } from "../src/extension/shim-process.ts";

// ShimProcess.feed() is the real stdout line-framing the extension uses (extracted
// from device-shim.ts so it's testable). Real child-process stdout arrives on
// arbitrary byte boundaries: a single response can be split across reads, several
// can land in one chunk, and a CRLF or stray non-JSON line can appear. None of
// that must drop or corrupt a response.

function feedChunks(chunks: string[]): { value: any; rejected: boolean } {
  const proc = new ShimProcess({ write: () => undefined });
  let value: any;
  let rejected = false;
  proc.pending.set(1, { resolve: (v) => (value = v), reject: () => (rejected = true) });
  for (const chunk of chunks) proc.feed(chunk);
  return { value, rejected };
}

const RESPONSE = JSON.stringify({ id: 1, result: { ok: true, lines: ["MPYHW_READY"] } });

test("a response split mid-line across feeds still resolves exactly once", () => {
  const cut = Math.floor(RESPONSE.length / 2);
  const { value } = feedChunks([RESPONSE.slice(0, cut), RESPONSE.slice(cut) + "\n"]);
  assert.deepEqual(value, { ok: true, lines: ["MPYHW_READY"] });
});

test("a response split exactly on the newline resolves", () => {
  const { value } = feedChunks([RESPONSE, "\n"]);
  assert.deepEqual(value, { ok: true, lines: ["MPYHW_READY"] });
});

test("a CRLF-terminated response resolves (trailing \\r is JSON whitespace)", () => {
  const { value } = feedChunks([RESPONSE + "\r\n"]);
  assert.deepEqual(value, { ok: true, lines: ["MPYHW_READY"] });
});

test("a stray non-JSON line is swallowed and does not block the real response", () => {
  const { value, rejected } = feedChunks(["mpremote: some diagnostic noise\n", RESPONSE + "\n"]);
  assert.equal(rejected, false);
  assert.deepEqual(value, { ok: true, lines: ["MPYHW_READY"] });
});

test("two responses in one chunk both dispatch", () => {
  const proc = new ShimProcess({ write: () => undefined });
  const got: any[] = [];
  proc.pending.set(1, { resolve: (v) => got.push(v), reject: () => {} });
  proc.pending.set(2, { resolve: (v) => got.push(v), reject: () => {} });
  proc.feed(JSON.stringify({ id: 1, result: { a: 1 } }) + "\n" + JSON.stringify({ id: 2, result: { b: 2 } }) + "\n");
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});
