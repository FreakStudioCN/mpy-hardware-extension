import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findPhaseCompletes, resumePoint } from "../src/cli/resume-point.ts";

const saved = (nextPhase: string) => JSON.stringify({
  payload: { result: "success", next_phase: nextPhase, manifest_content: { project: "blink" } },
});

async function runDir(layout: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "resume-point-test-"));
  for (const [rel, body] of Object.entries(layout)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf-8");
  }
  return dir;
}

// The layout a real run produced: generate wrote its phase_complete into sessions/<id>/ while the
// root held only the earlier phases. Resuming at deploy failed with "not saved in <dir>" even
// though the resume point existed, complete and correct, one directory down.
const NESTED_GENERATE = {
  "phase_complete.select_hw.json": saved("upy-flash-mpy-firmware-plugin"),
  "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
  "sessions/00000000-0000-0000-0000-000000000001/phase_complete.upy_generate_plugin.json":
    saved("upy-deploy-plugin"),
};

test("a phase_complete written below the root is still a resume point", async () => {
  const dir = await runDir(NESTED_GENERATE);
  const point = await resumePoint(dir, "upy-deploy-plugin");
  assert.equal(point.phase, "upy-deploy-plugin");
  assert.match(point.from, /sessions/);
});

test("the furthest phase is found below the root too, not just the root's best", async () => {
  const dir = await runDir(NESTED_GENERATE);
  // Without the recursive search this answers upy-generate-plugin, and the resume replays the
  // one phase it exists to skip.
  assert.equal((await resumePoint(dir)).phase, "upy-deploy-plugin");
});

test("a missing phase names the file each option came from", async () => {
  const dir = await runDir(NESTED_GENERATE);
  await assert.rejects(
    () => resumePoint(dir, "upy-wiring-plugin"),
    (error: Error) => error.message.includes("phase_complete.upy_scaffold_plugin.json")
      && error.message.includes("upy-deploy-plugin"),
  );
});

test("checkpoint copies under .mpyhw never become resume points", async () => {
  // checkpoints/<phase>/ holds a COPY of the whole project, so a naive recursive scan offers an
  // earlier phase's saved phase_complete as if it were live.
  const dir = await runDir({
    ...NESTED_GENERATE,
    ".mpyhw/checkpoints/analyze/phase_complete.analyze.json": saved("select-hw"),
    ".mpyhw/checkpoints/upy-scaffold-plugin/phase_complete.upy_scaffold_plugin.json":
      saved("upy-generate-plugin"),
  });
  const found = await findPhaseCompletes(dir);
  assert.equal(found.some((p) => p.includes(".mpyhw")), false);
  assert.equal(found.length, 3);
});

test("a root copy wins over a nested duplicate of the same phase", async () => {
  const dir = await runDir({
    "phase_complete.upy_generate_plugin.json": saved("upy-deploy-plugin"),
    "sessions/abc/phase_complete.upy_generate_plugin.json": saved("upy-deploy-plugin"),
  });
  // Both are valid, so the pick must not depend on readdir order.
  assert.equal((await resumePoint(dir, "upy-deploy-plugin")).from, "phase_complete.upy_generate_plugin.json");
});

test("an unreadable phase_complete is skipped and reported, not fatal", async () => {
  const dir = await runDir({
    ...NESTED_GENERATE,
    "phase_complete.broken.json": "{ not json",
  });
  const skips: string[] = [];
  const point = await resumePoint(dir, "upy-deploy-plugin", (m) => skips.push(m));
  assert.equal(point.phase, "upy-deploy-plugin");
  assert.equal(skips.length, 1);
  assert.match(skips[0], /phase_complete\.broken\.json/);
});

test("a run with no usable phase_complete says so", async () => {
  const dir = await runDir({ "phase_complete.analyze.json": JSON.stringify({ payload: { result: "success" } }) });
  await assert.rejects(() => resumePoint(dir), /carries next_phase \+ manifest_content/);
});

// next_phase is a string a PREVIOUS run wrote, and the resumed phase is joined into the checkpoint
// path that snapshotCheckpoint then rm -rf's and renames over. Taking it verbatim let a traversal
// reach that join: `../../..` resolves outside the project entirely. It has to fail to resolve as a
// phase, not merely be discouraged, and it has to SAY it skipped it -- a resume that quietly picks
// an earlier phase than expected is the thing nobody can explain afterwards.
test("a next_phase that is not a known phase is skipped and reported, never returned", async () => {
  const dir = await runDir({
    "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
    "phase_complete.evil.json": saved("../../../../victim"),
  });
  const skips: string[] = [];
  const point = await resumePoint(dir, undefined, (m) => skips.push(m));
  assert.equal(point.phase, "upy-generate-plugin", "the traversal must not be selected");
  assert.ok(skips.some((m) => m.includes("phase_complete.evil.json")), `the skip must be reported: ${JSON.stringify(skips)}`);
});

// The traversal alone would still pass if it merely lost the rank sort, so pin the case where it is
// the ONLY candidate: it must leave nothing to resume from rather than becoming the resume point.
test("a traversal next_phase alone leaves nothing to resume from", async () => {
  const dir = await runDir({ "phase_complete.evil.json": saved("../../../../victim") });
  await assert.rejects(() => resumePoint(dir, undefined, () => {}), /carries next_phase \+ manifest_content/);
});

// PHASE_ORDER holds only the canonical `-plugin` spellings, so ranking the raw string gave a legal
// short alias -1 -- behind every real phase. A saved "deploy" then lost to an EARLIER phase and the
// resume replayed the one it exists to skip. The phase handed back must be canonical too, because
// the loop asks the backend for a skill by that name.
test("a short alias resumes as its canonical phase, and outranks earlier phases", async () => {
  const dir = await runDir({
    "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
    "phase_complete.upy_generate_plugin.json": saved("deploy"),
  });
  const point = await resumePoint(dir);
  assert.equal(point.phase, "upy-deploy-plugin", "the furthest phase wins and comes back canonical");
});

// PHASE_ALIASES is an object literal, so a bare lookup walks the prototype chain: "toString",
// "constructor", "__proto__" and friends all come back truthy, as FUNCTIONS, and `?? null` never
// fires. The guard's whole promise is that anything outside the table is refused, and it was false
// for about ten inputs. A Function reaching the loop as a phase name is bad enough; one reaching
// checkpointSegment's replace() throws where nothing catches it.
test("a next_phase that only exists on Object.prototype is refused like any other unknown", async () => {
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    const dir = await runDir({
      "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
      "phase_complete.proto.json": saved(key),
    });
    const skips: string[] = [];
    const point = await resumePoint(dir, undefined, (m) => skips.push(m));
    assert.equal(point.phase, "upy-generate-plugin", `${key} must not become the resume point`);
    assert.equal(typeof point.phase, "string", `${key} produced a non-string phase`);
    // The REASON, not just the filename: a regression that skipped this as unreadable rather than
    // as an unknown phase would otherwise stay green while reporting the wrong cause.
    assert.ok(
      skips.some((m) => m.includes("phase_complete.proto.json") && m.includes("not a known phase")),
      `${key} must be reported as skipped for naming no known phase, got ${JSON.stringify(skips)}`,
    );
  }
});

// The other side of canonicalizing `wanted`: it falls back to the raw string when it does not
// resolve, so pin that the fallback cannot smuggle a traversal through. Every candidate is
// canonical now, so an unresolvable wanted value matches nothing and the run stops instead of
// resuming at a phase named "../../..".
test("E2E_RESUME_PHASE naming a traversal matches nothing and stops the run", async () => {
  const dir = await runDir({
    "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
    // The evil candidate has to be PRESENT for this to test anything. Without it the traversal
    // matches nothing whatever the code does, and the test passes with both canonicalization
    // sites reverted -- proving only that a name absent from disk is absent from disk.
    "phase_complete.evil.json": saved("../../../../victim"),
  });
  await assert.rejects(() => resumePoint(dir, "../../../../victim", () => {}), /not saved under/);
});

// E2E_RESUME_PHASE is typed by a person, and "deploy" is what a person types. Canonicalizing the
// candidates without canonicalizing the wanted value would have rejected it.
test("E2E_RESUME_PHASE accepts the short alias a person actually types", async () => {
  const dir = await runDir({
    "phase_complete.upy_scaffold_plugin.json": saved("upy-generate-plugin"),
    "phase_complete.upy_generate_plugin.json": saved("upy-deploy-plugin"),
  });
  const point = await resumePoint(dir, "deploy");
  assert.equal(point.phase, "upy-deploy-plugin");
  assert.equal(point.from, "phase_complete.upy_generate_plugin.json");
});

// A file whose JSON parses to something that is not an object -- the literal `null` was the one
// seen -- used to throw TypeError out of resumePoint on `saved.payload`, sinking the whole resume.
test("a phase_complete that parses to null is skipped and reported, not fatal", async () => {
  const skips: string[] = [];
  const dir = await runDir({
    "phase_complete.analyze.json": "null",
    "phase_complete.upy_generate_plugin.json": saved("upy-deploy-plugin"),
  });
  const point = await resumePoint(dir, undefined, (m) => skips.push(m));
  assert.equal(point.phase, "upy-deploy-plugin");
  assert.ok(skips.some((m) => m.includes("phase_complete.analyze.json")), `the skip must be reported: ${JSON.stringify(skips)}`);
});
