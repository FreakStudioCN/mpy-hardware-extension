import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Behavioral test for scripts/baseline.mjs: it RUNS the runner against a throwaway
// fixture project (a package.json whose build/typecheck/test scripts we control) and
// asserts on real behavior — per-step PASS/FAIL, the failure summary, non-zero exit,
// and stdin being ignored — NOT on the runner's source text. Replaces the dropped
// source-grep test that green-lit a no-op runner.
//
// Mutation-check (the point of this test): a no-op runner that runs nothing and always
// exits 0 fails these (no "FAIL build", no "PASS build"); a behavior-preserving rename
// (e.g. STEP_TIMEOUT_MS -> STEP_TIMEOUT) leaves them all passing.
const runnerPath = fileURLToPath(new URL("../scripts/baseline.mjs", import.meta.url));
const PASS = 'node -e ""';

// Run the real runner in a temp cwd with the given npm scripts. No .venv in the fixture,
// so the python steps are flagged/skipped; we assert on the JS steps that run first.
function runBaseline(scripts: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "baseline-fixture-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }));
    const r = spawnSync(process.execPath, [runnerPath], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failing step is reported with a failure summary and a non-zero exit", () => {
  const { status, out } = runBaseline({ build: 'node -e "process.exit(1)"', typecheck: PASS, test: PASS });
  assert.notEqual(status, 0, "runner exits non-zero when a step fails");
  assert.match(out, /FAIL build/, "names the failing step");
  assert.match(out, /command:/, "prints the command in the failure summary");
  assert.match(out, /exit:/, "prints the exit code in the failure summary");
});

test("a passing step prints PASS (the runner actually executed the command)", () => {
  const { out } = runBaseline({ build: 'node -e "console.log(1)"', typecheck: PASS, test: PASS });
  assert.match(out, /PASS build/, "reports the step as passed");
  assert.doesNotMatch(out, /FAIL build/, "does not report a passing step as failed");
});

// The "passing step-set -> exit 0" path Haipeng asked for. The runner only exits 0 when
// nothing failed, so the fixture needs the full happy path: fake npm steps + a stub venv
// python (exit 0) + an empty skills dir (so no smoke suites are discovered). The stub is a
// posix shell script, so this case is posix-only; Windows resolves .venv/Scripts/python.exe
// and its exit-0 path is covered by the real Windows `npm run baseline`.
test(
  "a fully passing run exits 0 with BASELINE PASSED",
  { skip: process.platform === "win32" ? "stub venv is posix-only" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "baseline-pass-"));
    try {
      mkdirSync(join(root, "third_party", "MicroPython_Skills"), { recursive: true }); // exists + empty -> no smoke suites
      const proj = join(root, "proj");
      mkdirSync(join(proj, ".venv", "bin"), { recursive: true });
      writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { build: PASS, typecheck: PASS, test: PASS } }));
      const py = join(proj, ".venv", "bin", "python");
      writeFileSync(py, "#!/bin/sh\necho stub\nexit 0\n"); // stub: --version / -c / -m pytest all exit 0
      chmodSync(py, 0o755);
      const r = spawnSync(process.execPath, [runnerPath], { cwd: proj, encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(r.status, 0, "exit 0 when every step passes");
      assert.match(`${r.stdout ?? ""}${r.stderr ?? ""}`, /BASELINE PASSED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// The other half of that skip. In the fixture above the gate assets are absent because the
// fixture never had them, and skipping is right. In a REAL checkout their absence means someone
// deleted or renamed them, and skipping green unwires the regression check the step exists to be
// -- nothing else runs it, since CI runs npm test and npm run test:v0 and never baseline. The two
// cases are told apart by scripts/baseline.mjs, which a real checkout always has (npm run baseline
// IS node scripts/baseline.mjs) and the fixture never does. Same posix-only stub venv as above.
test(
  "a real checkout with the gate assets missing FAILS rather than skipping green",
  { skip: process.platform === "win32" ? "stub venv is posix-only" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "baseline-gatemissing-"));
    try {
      mkdirSync(join(root, "third_party", "MicroPython_Skills"), { recursive: true });
      const proj = join(root, "proj");
      mkdirSync(join(proj, ".venv", "bin"), { recursive: true });
      // What makes this a real checkout rather than a fixture: the runner itself is present,
      // while assert-gate-messages.mjs and test/fixtures/gate-messages are not.
      mkdirSync(join(proj, "scripts"), { recursive: true });
      writeFileSync(join(proj, "scripts", "baseline.mjs"), "// stand-in for the runner\n");
      writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { build: PASS, typecheck: PASS, test: PASS } }));
      const py = join(proj, ".venv", "bin", "python");
      writeFileSync(py, "#!/bin/sh\necho stub\nexit 0\n");
      chmodSync(py, 0o755);

      const r = spawnSync(process.execPath, [runnerPath], { cwd: proj, encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      assert.notEqual(r.status, 0, "a deleted gate script must not pass as green");
      assert.match(out, /gate messages \(assets missing\)/, "the failure summary names what is missing");
      assert.doesNotMatch(out, /BASELINE PASSED/, "the run must not report itself passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("stdin is ignored: a step that reads stdin gets EOF instead of hanging", () => {
  // readFileSync(0) blocks forever if stdin stays open; with stdio ignore it hits EOF
  // immediately. If it hung, the 30s runner timeout would trip and PASS build would be absent.
  const { out } = runBaseline({
    build: `node -e "require('fs').readFileSync(0);console.log(1)"`,
    typecheck: PASS,
    test: PASS,
  });
  assert.match(out, /PASS build/, "the stdin-reading step completed (EOF, no hang)");
});
