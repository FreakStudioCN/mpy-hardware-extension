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
