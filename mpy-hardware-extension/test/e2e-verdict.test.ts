import assert from "node:assert/strict";
import test from "node:test";

import { mockedDeploySteps, verdictBlockers, type VerdictInput } from "../src/cli/e2e-verdict.ts";

// A run that passed everything the gate used to look at. Each test below changes ONE field, so a
// blocker that appears is attributable to that field and nothing else.
function passingRun(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    threw: null,
    phaseCount: 6,
    terminal: "complete",
    terminalOk: true,
    boardExpected: true,
    deployResult: "success",
    firmwareEvidence: { kind: "ran", line: "[t=5404ms] DHT11 Monitor booting" },
    mockedSteps: [],
    reachedGenerate: true,
    mainOk: true,
    commits: 1,
    scaffoldApplied: true,
    ...over,
  };
}

test("a run with real firmware evidence passes", () => {
  assert.deepEqual(verdictBlockers(passingRun()), []);
});

// This is run 162, reconstructed from its artifacts. Every device step ran in mock mode, so the
// capture held a template string from a different build. The deploy reported success, the summary
// printed STALE DEVICE and MISMATCH, and the verdict was PASS. It must not be.
test("a deploy that succeeded on a capture from a DIFFERENT build is blocked", () => {
  const blockers = verdictBlockers(
    passingRun({ firmwareEvidence: { kind: "foreign", line: "[sensor] value=23.5" } }),
  );
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /DIFFERENT build/);
  // The offending line belongs in the message: the whole point is that a reader does not have to
  // open the jsonl to find out what the board was actually running.
  assert.match(blockers[0], /\[sensor\] value=23\.5/);
});

test("a deploy that succeeded while the firmware crashed on startup is blocked", () => {
  const blockers = verdictBlockers(
    passingRun({ firmwareEvidence: { kind: "crashed", line: "KeyboardInterrupt:" } }),
  );
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /raised on startup/);
});

test("a deploy that succeeded with no capture evidence at all is blocked", () => {
  const blockers = verdictBlockers(passingRun({ firmwareEvidence: { kind: "absent" } }));
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /nothing in the serial capture/);
});

// The gate must not fire on a code-only delivery. Ending after generate with no board attached is
// a legitimate pass, and was the harness's behaviour before this check existed.
test("without a board required, absent firmware evidence does not block", () => {
  const blockers = verdictBlockers(
    passingRun({ boardExpected: false, firmwareEvidence: { kind: "absent" } }),
  );
  assert.deepEqual(blockers, []);
});

// A failed deploy is already named by its own blocker. Reporting the missing evidence as well
// would bury the cause under one of its symptoms.
test("a failed deploy is blocked once, by the deploy, not twice", () => {
  const blockers = verdictBlockers(
    passingRun({ deployResult: "failed", firmwareEvidence: { kind: "absent" } }),
  );
  assert.deepEqual(blockers, ["the deploy phase failed"]);
});

test("a deploy that never ran is not blamed for missing firmware evidence", () => {
  const blockers = verdictBlockers(
    passingRun({ deployResult: undefined, firmwareEvidence: { kind: "absent" } }),
  );
  assert.deepEqual(blockers, []);
});

// A phase can record a null result, which is a different value from "no deploy phase at all" and
// reaches this code by a different route. Both mean "no success to check evidence against".
test("a null deploy result is treated like a deploy that never ran", () => {
  const blockers = verdictBlockers(
    passingRun({ deployResult: null, firmwareEvidence: { kind: "absent" } }),
  );
  assert.deepEqual(blockers, []);
});

// The conditions that already existed must still fire, so the extraction from e2e-protocol-v0.ts
// is provably behaviour-preserving rather than merely compiling.
test("the pre-existing blockers still fire, each naming itself", () => {
  assert.match(verdictBlockers(passingRun({ threw: "boom" }))[0], /threw before finishing — boom/);
  assert.deepEqual(verdictBlockers({ ...passingRun(), threw: null, phaseCount: 0 })[0], "no phase executed");
  assert.match(
    verdictBlockers(passingRun({ terminalOk: false, terminal: "stalled" }))[0],
    /terminal is stalled, not complete/,
  );
  assert.match(verdictBlockers(passingRun({ reachedGenerate: false }))[0], /generate did not report success/);
  assert.match(verdictBlockers(passingRun({ mainOk: false }))[0], /under 100 bytes/);
  assert.match(verdictBlockers(passingRun({ commits: 0 }))[0], /no git commit/);
  assert.match(verdictBlockers(passingRun({ scaffoldApplied: false }))[0], /no scaffold marker/);
});

// --- mode: "mock" read directly, rather than inferred from the capture -------------------------

// The shape below is lifted from run 162's deploy_result.json. Its clean was NOT mocked, which is
// what made that run destructive: it really deleted ten files and then faked everything after.
const RUN_162_REPORT = {
  status: "PASS",
  upload_result: { status: "success", mode: "mock", returncode: 0, stdout: "" },
  clean_result: { status: "success", mode: "project_files", delete_count: 10 },
  device_tests: { status: "success", mode: "mock", test_count: 1, passed: 1 },
  final_reset: { status: "success", mode: "mock", matched_stop: "starting scheduler" },
  errors: [],
  warnings: [],
};

test("mockedDeploySteps names every step that ran against a mock", () => {
  assert.deepEqual(mockedDeploySteps(RUN_162_REPORT), ["upload", "device tests", "final reset"]);
});

// Every step in the list must actually be inspected. Run 162 happened to have a REAL clean, which
// is why it deleted ten files for real, so that run alone does not prove the clean step is read.
// Without this case, dropping clean from the inspected list changes no test.
test("mockedDeploySteps inspects every deploy step, not only the ones run 162 mocked", () => {
  const everyStepMocked = {
    upload_result: { mode: "mock" },
    clean_result: { mode: "mock" },
    device_tests: { mode: "mock" },
    final_reset: { mode: "mock" },
    mip_install: { mode: "mock" },
  };
  assert.deepEqual(mockedDeploySteps(everyStepMocked), [
    "upload",
    "clean",
    "device tests",
    "final reset",
    "mip install",
  ]);
});

// `mode` is each step's OWN vocabulary: clean says "project_files", a capture says "pty" or "pipe".
// Only the literal "mock" may be claimed, or a real step gets called fake.
test("mockedDeploySteps does not mistake another step's mode vocabulary for a mock", () => {
  assert.deepEqual(mockedDeploySteps({ clean_result: { mode: "project_files" } }), []);
  assert.deepEqual(mockedDeploySteps({ final_reset: { mode: "pty" } }), []);
  assert.deepEqual(mockedDeploySteps({ upload_result: { mode: "mocked" } }), []);
});

test("mockedDeploySteps survives a missing, empty or malformed report", () => {
  assert.deepEqual(mockedDeploySteps(null), []);
  assert.deepEqual(mockedDeploySteps({}), []);
  assert.deepEqual(mockedDeploySteps("not an object"), []);
  assert.deepEqual(mockedDeploySteps({ upload_result: null }), []);
});

test("a mocked step blocks when a board was required", () => {
  const blockers = verdictBlockers(passingRun({ mockedSteps: ["upload", "final reset"] }));
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /ran against a mock: upload, final reset/);
});

// The point of reading `mode` at all: a mock whose fake capture happened to name this run's build
// satisfies the firmware-evidence proxy, so evidence alone would pass it.
test("a mocked step blocks even when the capture names this run's own build", () => {
  const blockers = verdictBlockers(
    passingRun({
      mockedSteps: ["upload"],
      firmwareEvidence: { kind: "ran", line: "[t=5404ms] DHT11 Monitor booting" },
    }),
  );
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /ran against a mock/);
});

// Contract tests legitimately use --mock. Without a board required, that is not a failure.
test("mocked steps do not block when no board is required", () => {
  const blockers = verdictBlockers(
    passingRun({ boardExpected: false, mockedSteps: ["upload", "device tests"] }),
  );
  assert.deepEqual(blockers, []);
});

// A stalled run with no board required still blocks on the loop never finishing, via generate.
test("terminal is only gated when a board is required", () => {
  const blockers = verdictBlockers(passingRun({ boardExpected: false, terminalOk: false, terminal: "stalled" }));
  assert.deepEqual(blockers, []);
});
