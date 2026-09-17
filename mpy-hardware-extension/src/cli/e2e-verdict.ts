import type { FirmwareEvidence } from "./firmware-evidence.ts";

// What the verdict is allowed to look at. Extracted from e2e-protocol-v0.ts so it can be tested:
// that file runs a whole build loop on import, so its gate could only ever be checked by doing a
// real run, which is how a defect survived in it for as long as it did.
export type VerdictInput = {
  threw: string | null;
  phaseCount: number;
  terminal: string;
  terminalOk: boolean;
  boardExpected: boolean;
  // null as well as undefined: a phase can carry a null result, and "deploy never ran" and
  // "deploy ran and recorded nothing" must both be distinguishable from "deploy succeeded".
  deployResult: string | null | undefined;
  // A run scoped to one phase stops before the later ones ON PURPOSE, so it must not be blamed
  // for never reaching deploy. The summary already says the later phases were not run.
  stopAfterPhase: boolean;
  firmwareEvidence: FirmwareEvidence;
  // Names of the deploy steps that ran against a mock instead of the board. Empty on a real deploy.
  mockedSteps: string[];
  reachedGenerate: boolean;
  mainOk: boolean;
  commits: number;
  scaffoldApplied: boolean;
};

// The sections of deploy_result.json that record how they were executed, paired with the words a
// blocker should use for them. `evidence_mode` is the direct signal that a step did not touch the
// board; firmware evidence is only a proxy for it, and a mock whose fake capture happened to name
// this run's build would satisfy the proxy while touching nothing.
const DEPLOY_STEPS: Array<[label: string, key: string]> = [
  ["upload", "upload_result"],
  ["clean", "clean_result"],
  ["device tests", "device_tests"],
  ["final reset", "final_reset"],
  ["mip install", "mip_install"],
];

// `evidence_mode` is the canonical field: "live" or "mock", nothing else. `mode` carries a step's
// OWN vocabulary instead — clean reports "project_files" or "erase_all", capture reports "pty" or
// "pipe" — so it cannot say whether a step is mocked on its own; it stays a fallback for artifacts
// written before evidence_mode existed. Only the literal "mock" is claimed on either field, so a
// step that spells its real mode differently, or whose evidence_mode reads "mocked", is never
// mistaken for a fake one.
export function mockedDeploySteps(report: unknown): string[] {
  if (!report || typeof report !== "object") return [];
  const record = report as Record<string, unknown>;
  const mocked: string[] = [];
  for (const [label, key] of DEPLOY_STEPS) {
    const step = record[key];
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.evidence_mode === "mock" || (s.evidence_mode === undefined && s.mode === "mock")) {
      mocked.push(label);
    }
  }
  return mocked;
}

// Evidence has to come from THIS run. "Newest deploy_result.json under the project" says which
// copy is current, not whose it is: an in-place resume (E2E_RESUME equal to E2E_PROJECT_DIR)
// keeps the previous run's report, and a deploy that mocked every step and wrote its own report
// only to stdout leaves that old file as the newest one there is. Its capture names the build,
// its steps are not mocked, and the verdict passes on a board the run never touched. A report
// written before the run started is not this run's evidence, whatever it says.
export function reportPredatesRun(reportMtimeMs: number, runStartedAtMs: number): boolean {
  return reportMtimeMs < runStartedAtMs;
}

// Why a mocked deploy has to be caught HERE rather than by reading the summary: a run that mocked
// every device step printed "STALE DEVICE" and "MISMATCH" in its own output and still ended in
// PASS, because the firmware evidence was computed, printed, and never consulted. The strongest
// line in the summary had no vote in the verdict. Anyone reading only the last line was told a
// build reached the board when nothing had been uploaded.
//
// The deploy's own "success" is a claim about what it attempted. The capture is the evidence about
// what happened. With a board required, the evidence decides.
function firmwareEvidenceBlocker(v: VerdictInput): string | null {
  if (!v.boardExpected) return null;
  // A deploy that FAILED is already blocked below, and a deploy that never ran says nothing about
  // firmware: adding a second blocker for either would bury the real reason under a symptom.
  if (v.deployResult !== "success") return null;
  switch (v.firmwareEvidence.kind) {
    case "ran":
      return null;
    case "foreign":
      return `deploy reported success but the capture shows a DIFFERENT build running: "${v.firmwareEvidence.line}"`;
    case "crashed":
      return `deploy reported success but the firmware on the board raised on startup: "${v.firmwareEvidence.line}"`;
    case "absent":
      return "deploy reported success but nothing in the serial capture shows the firmware running";
  }
}

// With a board required, the run has to REACH deploy and deploy has to succeed. Anything else is
// a run that proved nothing about hardware, and it must not print PASS.
//
// The hole this closes is the sibling of the mocked-deploy bug: `=== "failed"` alone let two shapes
// through. A deploy that never ran leaves deployResult undefined, and a deploy that reported
// "partial" is neither "failed" nor "success" -- and a partial deploy with a next_phase keeps the
// loop going, so a later generate ending with next_phase null gives terminal "complete" and every
// other condition satisfied. Both printed PASS with zero board contact.
//
// The evidence blocker below deliberately does not also fire for these: this one names the cause,
// and a second line about missing capture evidence would bury it under a symptom.
function deployOutcomeBlocker(v: VerdictInput): string | null {
  if (!v.boardExpected) return null;
  // The scoped exemption covers ONLY "never reached deploy". A blanket exemption also swallowed a
  // deploy that RAN and failed, which the old failed-only check had always blocked -- and it was
  // reachable in the very workflow the exemption serves, E2E_ONLY_PHASE=deploy against a board.
  // The narrow condition is the one the comment above claims.
  const deployNeverRan = v.deployResult === undefined || v.deployResult === null;
  if (v.stopAfterPhase && deployNeverRan) return null;
  if (v.deployResult === "success") return null;
  if (v.deployResult === "failed") return "the deploy phase failed";
  if (v.deployResult === undefined || v.deployResult === null) {
    return "a board was required but the deploy phase never ran";
  }
  return `a board was required but the deploy phase reported ${v.deployResult}, not success`;
}

// A mocked step is blocked on its own, independently of what the capture shows and of whether the
// deploy called itself a success. The acceptance spec is explicit that a P0 run fails when "only
// mock is used, without real device logs", and `--mock` is a legitimate flag for contract tests, so
// the goal is that a mocked run cannot be MISTAKEN for a hardware run rather than that mock stops
// working. It is reported separately from the evidence blocker because the two answer different
// questions: this one is "did we touch the board at all", the other is "did the board run ours".
function mockedStepsBlocker(v: VerdictInput): string | null {
  if (!v.boardExpected || v.mockedSteps.length === 0) return null;
  return `a board was required but these deploy steps ran against a mock: ${v.mockedSteps.join(", ")}`;
}

// Every condition names itself: a REVIEW that said nothing sent three runs to the jsonl for an
// answer that belonged on one line here.
export function verdictBlockers(v: VerdictInput): string[] {
  const blockers: string[] = [];
  if (v.threw !== null) blockers.push(`the loop threw before finishing — ${v.threw}`);
  else if (v.phaseCount === 0) blockers.push("no phase executed");
  if (v.boardExpected && !v.terminalOk) blockers.push(`terminal is ${v.terminal}, not complete`);
  const deploy = deployOutcomeBlocker(v);
  if (deploy) blockers.push(deploy);
  const mocked = mockedStepsBlocker(v);
  if (mocked) blockers.push(mocked);
  const evidence = firmwareEvidenceBlocker(v);
  if (evidence) blockers.push(evidence);
  if (!v.reachedGenerate) blockers.push("generate did not report success (in this run or the resumed archive)");
  if (!v.mainOk) blockers.push("firmware/main.py is missing or under 100 bytes");
  if (v.commits === 0) blockers.push("the project has no git commit");
  if (!v.scaffoldApplied) blockers.push("no scaffold marker on disk");
  return blockers;
}
