import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageGenDriverSources } from "../src/extension/gen-driver-staging.ts";
import type { GenDriverSource } from "../src/core/gen-driver-schema.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function scratch(): Promise<{ project: string; picked: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gd-stage-"));
  const project = join(root, "blockless-project");
  const pickDir = join(root, "picked");
  await mkdir(project, { recursive: true });
  await mkdir(pickDir, { recursive: true });
  return { project, picked: pickDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function fileSource(name: string, path: string, sha: string): GenDriverSource {
  return { type: "pdf", artifact_path: null, sha256: sha, primary: true, metadata: { pdf_file: { name, path, size: 3, uploaded_at: null }, chip_model: "SHT30" } };
}

test("stageGenDriverSources copies a picked file under projectFolder with a relative POSIX artifact_path", async () => {
  const { project, picked, cleanup } = await scratch();
  try {
    const bytes = Buffer.from("PDF");
    const src = join(picked, "SHT30.pdf");
    await writeFile(src, bytes);
    const [out] = await stageGenDriverSources([fileSource("SHT30.pdf", src, sha256(bytes))], project);

    assert.equal(out.artifact_path, "gen-driver/input/SHT30.pdf", "relative POSIX path, reachable by containment");
    const stagedBytes = await readFile(join(project, "gen-driver", "input", "SHT30.pdf"));
    assert.deepEqual(stagedBytes, bytes, "the bytes are copied verbatim (binary-safe)");
  } finally { await cleanup(); }
});

test("stageGenDriverSources rejects a source whose file no longer matches the picked sha256 (register #1/#11)", async () => {
  const { project, picked, cleanup } = await scratch();
  try {
    const src = join(picked, "swapped.pdf");
    await writeFile(src, Buffer.from("ATTACKER"));       // file on disk differs from...
    const src0 = fileSource("swapped.pdf", src, sha256(Buffer.from("ORIGINAL"))); // ...the sha256 captured at pick time
    // Mutation: drop the sha256 re-hash check -> an arbitrary swapped host file stages silently.
    await assert.rejects(() => stageGenDriverSources([src0], project), /integrity check/);
  } finally { await cleanup(); }
});

test("stageGenDriverSources rejects a traversal file name (register #11)", async () => {
  const { project, picked, cleanup } = await scratch();
  try {
    const bytes = Buffer.from("PWNED");
    const src = join(picked, "evil");
    await writeFile(src, bytes);
    // The webview-echoed name escapes gen-driver/input; without a containment check copyFile would
    // overwrite an arbitrary host path. Mutation: drop the name check -> this stages/writes outside.
    const evil = fileSource("../../evil.txt", src, sha256(bytes));
    await assert.rejects(() => stageGenDriverSources([evil], project), /not a plain file name/);
    const backslash = fileSource("..\\evil.txt", src, sha256(bytes));
    await assert.rejects(() => stageGenDriverSources([backslash], project), /not a plain file name/);
  } finally { await cleanup(); }
});

test("stageGenDriverSources passes non-file sources through unchanged", async () => {
  const { project, cleanup } = await scratch();
  try {
    const cold: GenDriverSource = { type: "current_cold_driver_item", artifact_path: null, sha256: null, primary: true, metadata: { driver_status: "cold_driver_required" } };
    const [out] = await stageGenDriverSources([cold], project);
    assert.equal(out.artifact_path, null, "a cold-driver source has no file to stage");
    assert.equal(out, cold, "passed through by reference, not copied");
  } finally { await cleanup(); }
});
