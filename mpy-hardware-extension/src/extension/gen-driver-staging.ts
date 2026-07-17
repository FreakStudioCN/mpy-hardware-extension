import { createHash } from "node:crypto";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GenDriverSource } from "../core/gen-driver-schema.ts";

// Where picked sources are staged: UNDER projectFolder, so file_operation/script_run containment can
// reach them (they root at projectFolder). NOT the workspace-root .mpyhw/sessions dir, which a relative
// artifact_path can't reach without a "..". The plugin receives this as a relative POSIX path.
const STAGE_DIR = "gen-driver/input";

type PickedFile = { name: string; path: string };

// A file field lands in metadata as { name, path, size, uploaded_at } (buildSourceFromFields); the text
// fields are strings. Find the one file descriptor (a tab holds at most one file field).
function pickedFileEntry(metadata: unknown): PickedFile | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const value of Object.values(metadata as Record<string, unknown>)) {
    if (value && typeof value === "object"
      && typeof (value as PickedFile).path === "string"
      && typeof (value as PickedFile).name === "string") {
      return value as PickedFile;
    }
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// Rewrite the picked-file descriptor in metadata so it no longer carries the absolute HOST path (which
// would ride the dispatch envelope up to the cloud). The file entry keeps its shape but points at the
// relative staged path. `file` is the exact object pickedFileEntry returned, so match it by reference.
function withStagedFilePath(metadata: unknown, file: PickedFile, stagedRelPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    out[key] = value === file ? { ...file, path: stagedRelPath } : value;
  }
  return out;
}

// Stage each file-bearing source's picked file under <projectFolder>/gen-driver/input and set
// artifact_path to the relative POSIX path the plugin receives. The source path is echoed back by the
// untrusted webview, so re-hash the staged copy and require it match the sha256 captured at pick time
// (register #1/#11) — a swapped path fails loudly rather than shipping an arbitrary host file to the LLM.
// Non-file sources pass through unchanged. A copy failure throws (register #8: never read as "staged").
export async function stageGenDriverSources(
  sources: GenDriverSource[],
  projectFolder: string,
): Promise<GenDriverSource[]> {
  const destDir = join(projectFolder, "gen-driver", "input");
  let ensuredDir = false;
  const staged: GenDriverSource[] = [];
  for (const source of sources) {
    const file = pickedFileEntry(source.metadata);
    if (!file || !source.sha256) {
      staged.push(source);
      continue;
    }
    // file.name is echoed by the untrusted webview: it must be a plain basename, or "../.." would let
    // copyFile write outside gen-driver/input (register #11 — contain external paths, don't just hash).
    if (/[\\/\0]/.test(file.name) || file.name === "." || file.name === "..") {
      throw new Error(`gen-driver source name "${file.name}" is not a plain file name`);
    }
    // source.sha256 is ALSO webview-echoed and is interpolated into the staged path below; a non-digest
    // value like "../../.." would escape gen-driver/input via copyFile BEFORE the integrity check throws
    // (register #11). Require a real 64-hex digest before it ever touches a path.
    if (!/^[0-9a-f]{64}$/.test(source.sha256)) {
      throw new Error(`gen-driver source "${file.name}" has a malformed sha256`);
    }
    if (!ensuredDir) {
      await mkdir(destDir, { recursive: true });
      ensuredDir = true;
    }
    // Stage under a collision-resistant name: two picked files sharing a basename (vendor-a/datasheet.pdf
    // and vendor-b/datasheet.pdf) must NOT overwrite one staged target — the second copy would land after
    // the first's hash check, leaving the first source pointing at the wrong bytes. Prefix with the picked
    // sha256 so distinct content gets distinct names; identical content collapses to one file (idempotent).
    const stagedName = `${source.sha256.slice(0, 12)}-${file.name}`;
    const dest = join(destDir, stagedName);
    await copyFile(file.path, dest);
    const actual = await sha256File(dest);
    if (actual !== source.sha256) {
      throw new Error(`gen-driver source "${file.name}" failed integrity check: picked sha256 ${source.sha256}, staged ${actual}`);
    }
    const artifactPath = `${STAGE_DIR}/${stagedName}`;
    staged.push({ ...source, artifact_path: artifactPath, metadata: withStagedFilePath(source.metadata, file, artifactPath) });
  }
  return staged;
}
