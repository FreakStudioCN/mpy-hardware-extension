import assert from "node:assert/strict";
import test from "node:test";

import { evidenceKey, runProtocolBuild } from "../src/core/protocol-loop.ts";
import { flagValue, flagValues, hasFlag, splitFlag } from "../src/core/protocol-argv.ts";

// The guards that decide whether a phase's evidence can be trusted, each pinned against the input
// that used to slip past it. Kept apart from protocol-loop.test.ts, which is already too long to
// read; the harness is the same three lines.
const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });
const stop = { type: "message_stop" };
function scripted(plan: (turn: number) => any[]) {
  let turn = 0;
  return {
    streamMessages: async () => {
      turn += 1;
      const ev = plan(turn);
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
}
const givingUp = tu("q", "phase_complete", { result: "partial", summary: "gave up", next_phase: null, manifest_content: {} });

test("argv flags: --flag value and --flag=value read the same", () => {
  assert.deepEqual(splitFlag("--output-json=x.json"), { flag: "--output-json", value: "x.json" });
  assert.deepEqual(splitFlag("--output-json"), { flag: "--output-json", value: undefined });
  assert.deepEqual(splitFlag("main.py"), { flag: "main.py", value: undefined });
  const args = ["--input", "a.json", "--compare-manifest=v.json", "--input=b.json", "--expected-artifact"];
  assert.ok(hasFlag(args, "--compare-manifest"));
  assert.ok(hasFlag(args, "--expected-artifact"));
  assert.equal(flagValue(args, "--compare-manifest"), "v.json");
  assert.deepEqual(flagValues(args, "--input"), ["a.json", "b.json"]);
  assert.deepEqual(flagValues(args, "--expected-artifact"), [], "a trailing bare flag names nothing");
});

test("evidenceKey folds the redundant project/ root the writer strips", () => {
  // The writer reports `select_hw_validated.json` for a write to `project/select_hw_validated.json`;
  // the gate argv keeps the prefix. One file, one key.
  assert.equal(evidenceKey("project/select_hw_validated.json"), evidenceKey("select_hw_validated.json"));
  assert.equal(evidenceKey("./project/x/y.json"), evidenceKey("x/y.json"));
  assert.notEqual(evidenceKey("firmware/x.json"), evidenceKey("x.json"), "only the KNOWN redundant root folds");
});

test("a phase_complete whose result is not a string is rejected, not coerced through String()", async () => {
  // String(["success"]) === "success" passed the allowlist, then every `=== "success"` guard
  // downstream was false, so both refusals were skipped and the build advanced on an array.
  const llm = scripted((turn) => (turn === 1
    ? [tu("p", "phase_complete", { result: ["success"], summary: "x", next_phase: "upy-deploy-plugin", manifest_content: {} }), stop]
    : [givingUp, stop]));
  const out = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3 },
    { llmClient: llm } as any,
  );
  assert.deepEqual(out.phases, [{ phase: "upy-generate-plugin", result: "partial" }], "the array must not be recorded or advanced on");
  assert.equal(out.terminal, "partial");
});

test("deploy_result.py run with no upload record records no verdict, so the strict gate refuses the success", async () => {
  // deploy_result.py prints PASS with every evidence flag omitted (verified against the script:
  // `--strategy mpremote` alone exits 0 with errors: []), so a gate table without requiredArgs let
  // that bare run stand in for graded evidence.
  const events: any[] = [];
  const llm = scripted((turn) => (turn === 1
    ? [tu("g", "script_run", { interpreter: "python", script: "scripts/deploy_result.py", args: ["--strategy", "mpremote"] }), stop]
    : [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop]));
  const out = await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, success: true, stdout: '{"status":"PASS","errors":[]}' }) } as any,
  );
  assert.ok(events.some((e) => e.type === "phase_complete_refused" && e.reason === "gate_never_ran"), "a gate run without --upload-json is not a verdict");
  assert.notEqual(out.terminal, "complete");
});

test("a required gate flag in --flag=value form counts", async () => {
  // select-hw is strict: with the `=` spelling unrecognized, the verdict was never recorded and the
  // honest success was refused as gate_never_ran on every turn until the phase stalled.
  const events: any[] = [];
  const llm = scripted((turn) => (turn === 1
    ? [tu("g", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: ["--validate-phase-complete", "--input", "pc.json", "--compare-manifest=v.json", "--expected-artifact=d.json"] }), stop]
    : turn === 2
      ? [tu("p", "phase_complete", { result: "success", summary: "board picked", next_phase: "upy-flash-mpy-firmware-plugin", manifest_content: {} }), stop]
      : [givingUp, stop]));
  const out = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, success: true, stdout: '{"status":"pass","errors":[]}' }) } as any,
  );
  assert.ok(!events.some((e) => e.type === "phase_complete_refused"), "the gate ran with every required flag");
  assert.equal(out.phases[0]?.result, "success");
});

test("an upload carrying --output-json=upload_summary.json is not evidence-less", async () => {
  const run = async (outputFlag: string[]) => {
    const events: any[] = [];
    const llm = scripted((turn) => (turn === 1
      ? [tu("u", "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args: ["--run", "--port", "COM3", ...outputFlag, "--", "fs", "cp", "main.py", ":main.py"] }), stop]
      : [givingUp, stop]));
    await runProtocolBuild(
      { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 2, onEvent: (e: any) => events.push(e) },
      { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, success: true, stdout: '{"status":"success"}' }) } as any,
    );
    return events.some((e) => e.type === "upload_without_evidence");
  };
  assert.equal(await run(["--output-json=upload_summary.json"]), false, "the `=` spelling writes the file just the same");
  assert.equal(await run([]), true, "and an upload with no output flag is still refused");
});

test("a final reset that observed no reboot does not latch, so the corrected retry stays legal", async () => {
  // capture_repl.py exits 0 whenever the capture ran; deploy_result.py then rejects the record as
  // final_reset_soft_reboot_not_observed. Latching on the exit code refused the retry that fixes it.
  const run = async (report: string) => {
    const events: any[] = [];
    const capture = tu("f", "script_run", { interpreter: "python", script: "scripts/capture_repl.py", args: ["--reset-first", "--output-json", "final_reset_capture.json"] });
    const llm = scripted((turn) => (turn <= 2 ? [{ ...capture, id: `f${turn}` }, stop] : [givingUp, stop]));
    await runProtocolBuild(
      { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
      { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, success: true, stdout: report }) } as any,
    );
    return events.some((e) => e.type === "device_after_final_reset");
  };
  assert.equal(await run('{"status":"success","observed_soft_reboot":false,"observed_fresh_boot":false}'), false, "no reboot seen: the retry is the fix, not a violation");
  assert.equal(await run('{"status":"success","observed_soft_reboot":true}'), true, "a reset that showed the reboot still closes the phase to device calls");
});
