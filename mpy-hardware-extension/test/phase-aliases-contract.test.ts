// mpy-hardware-extension/test/phase-aliases-contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PHASE_ALIASES, PHASE_ORDER } from "../src/core/protocol-loop.ts";

const contract = JSON.parse(readFileSync(new URL("../../contracts/phase_aliases.json", import.meta.url), "utf-8"));

test("PHASE_ALIASES matches contracts/phase_aliases.json exactly", () => {
  assert.deepEqual({ ...PHASE_ALIASES }, contract.aliases);
});

test("PHASE_ORDER matches the contract's canonical phases exactly", () => {
  assert.deepEqual([...PHASE_ORDER], contract.canonical_phases);
});
