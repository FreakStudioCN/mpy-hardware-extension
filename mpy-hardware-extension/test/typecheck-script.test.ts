import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("typecheck script runs the TypeScript compiler", () => {
  const script = readFileSync("scripts/typecheck.mjs", "utf-8");

  assert.match(script, /tsc/);
  assert.match(script, /--noEmit/);
  assert.doesNotMatch(script, /experimental-strip-types/);
});
