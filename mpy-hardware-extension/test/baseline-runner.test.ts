import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/baseline.mjs", "utf-8");

test("baseline runner ignores stdin for every step", () => {
  // stdin "ignore" is the portable fix for the plugin smoke harness TTY hang.
  assert.match(script, /stdio:\s*\["ignore"/);
});

test("baseline runner applies a per-step timeout", () => {
  assert.match(script, /STEP_TIMEOUT_MS/);
  assert.match(script, /SMOKE_TIMEOUT_MS/);
  assert.match(script, /timeout,/);
});

test("baseline runner resolves the venv python per-OS", () => {
  assert.match(script, /Scripts\/python\.exe/);
  assert.match(script, /bin\/python/);
});

test("baseline runner prints node, npm, python, and mpremote versions", () => {
  for (const tool of ["node", "npm", "python", "mpremote"]) {
    assert.match(script, new RegExp(tool));
  }
});

test("on failure it reports command, cwd, duration, and exit code", () => {
  assert.match(script, /command:/);
  assert.match(script, /cwd:/);
  assert.match(script, /duration:/);
  assert.match(script, /exit:/);
});

test("baseline runner auto-discovers plugin smoke suites", () => {
  assert.match(script, /upy-\.\*-plugin/);
  assert.match(script, /smoke_tests\.py/);
});

test("baseline runner runs build, typecheck, TS tests, shim pytest, and smoke", () => {
  assert.match(script, /"run", "build"/);
  assert.match(script, /"run", "typecheck"/);
  assert.match(script, /"test"\]/);
  assert.match(script, /pytest/);
});

test("baseline runner exits non-zero if any step fails", () => {
  assert.match(script, /failures\.length/);
  assert.match(script, /process\.exit\(1\)/);
});

test("package.json wires npm run baseline to the orchestrator", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  assert.equal(pkg.scripts.baseline, "node scripts/baseline.mjs");
});
