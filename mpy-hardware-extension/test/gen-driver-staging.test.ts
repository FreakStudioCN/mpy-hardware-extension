import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
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
    const sha = sha256(bytes);
    const src = join(picked, "SHT30.pdf");
    await writeFile(src, bytes);
    const [out] = await stageGenDriverSources([fileSource("SHT30.pdf", src, sha)], project);

    const stagedName = `${sha.slice(0, 12)}-SHT30.pdf`;
    assert.equal(out.artifact_path, `gen-driver/input/${stagedName}`, "relative POSIX path with a collision-resistant name");
    const stagedBytes = await readFile(join(project, "gen-driver", "input", stagedName));
    assert.deepEqual(stagedBytes, bytes, "the bytes are copied verbatim (binary-safe)");
    // The absolute host path must NOT ride the dispatch envelope: metadata now carries the relative staged
    // path. Mutation: forward source.metadata unchanged -> the picked dir leaks and this fails.
    assert.ok(!JSON.stringify(out.metadata).includes(picked), "no absolute host path leaks in the forwarded metadata");
  } finally { await cleanup(); }
});

test("stageGenDriverSources: two same-basename sources don't overwrite (#2)", async () => {
  const { project, picked, cleanup } = await scratch();
  try {
    const aBytes = Buffer.from("AAA");
    const bBytes = Buffer.from("BBB");
    const aSrc = join(picked, "a");
    const bSrc = join(picked, "b");
    await writeFile(aSrc, aBytes);
    await writeFile(bSrc, bBytes);
    // Both picked files share the basename "datasheet.pdf" (from different host dirs) but differ in content.
    const staged = await stageGenDriverSources([
      fileSource("datasheet.pdf", aSrc, sha256(aBytes)),
      fileSource("datasheet.pdf", bSrc, sha256(bBytes)),
    ], project);
    // Distinct staged paths, and each staged file still holds its OWN content. Mutation: stage under the
    // bare basename -> both map to gen-driver/input/datasheet.pdf, the second copy clobbers the first, and
    // staged[0] on disk reads "BBB" (sha mismatch) -> this fails.
    assert.notEqual(staged[0].artifact_path, staged[1].artifact_path, "same basename -> distinct staged paths");
    for (const s of staged) {
      const onDisk = await readFile(join(project, s.artifact_path as string));
      assert.equal(sha256(onDisk), s.sha256, `staged ${s.artifact_path} keeps its own bytes (no overwrite)`);
    }
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

test("stageGenDriverSources rejects a malformed sha256 that would escape the staging dir (register #11)", async () => {
  const { project, picked, cleanup } = await scratch();
  try {
    const bytes = Buffer.from("X");
    const src = join(picked, "x");
    await writeFile(src, bytes);
    // sha256 is echoed by the untrusted webview and is interpolated into the staged path; a "../" value
    // escapes gen-driver/input via copyFile BEFORE the integrity check throws. Mutation: drop the digest
    // guard -> the file is written outside the root and this rejects with /integrity check/ (after the
    // escaping copy), not /malformed sha256/ -> the specific-message assertion fails.
    const evil = fileSource("note.py", src, "../../../../evilhash");
    await assert.rejects(() => stageGenDriverSources([evil], project), /malformed sha256/);
    // The guard throws BEFORE mkdir/copy, so no staging even began (nothing could escape the root).
    await assert.rejects(() => stat(join(project, "gen-driver", "input")), /ENOENT/, "staging dir never created");
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
