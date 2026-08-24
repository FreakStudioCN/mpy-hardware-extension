// Where a resumed run restarts from.
//
// E2E_RESUME=<a previous run's project dir> restarts from where that run got to, instead of
// walking the chain from analyze. The four phases before generate are stable and cost ~8 minutes
// of model time per run, so iterating on deploy meant paying 40 minutes to reach the phase under
// test. The saved phase_complete carries both halves of a resume point: the manifest to hand
// forward and the next_phase to hand it to.
import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { PHASE_ORDER } from "../core/protocol-loop.ts";

export type ResumePoint = { phase: string; manifest: any; from: string };

type Candidate = ResumePoint & { rank: number; depth: number };

const SEARCH_DEPTH = 3;
// checkpoints/<phase>/ under .mpyhw holds a COPY of the whole project per phase, so descending
// into it surfaces every earlier phase's saved phase_complete and offers stale resume points
// indistinguishable from live ones. .git holds the same by another route.
const SKIPPED_DIRS = new Set([".mpyhw", ".git"]);

/**
 * Every phase_complete under a run directory, FOUND rather than assumed at its root.
 *
 * The model chooses where its phase_complete goes. Measured: one run wrote generate's to
 * sessions/<id>/ while the root held only scaffold's, so resuming at deploy died with
 * "not saved in <dir>" while the resume point it asked for sat one directory down, complete and
 * correct. findArtifact in the harness learned this first; this is the second place to need it.
 */
export async function findPhaseCompletes(root: string, depth = SEARCH_DEPTH): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>> | any[] = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const found: string[] = [];
  for (const entry of entries as any[]) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.startsWith("phase_complete.") && entry.name.endsWith(".json")) {
      found.push(full);
    } else if (entry.isDirectory() && depth > 0 && !SKIPPED_DIRS.has(entry.name)) {
      found.push(...await findPhaseCompletes(full, depth - 1));
    }
  }
  return found;
}

async function readCandidates(dir: string, onSkip: (message: string) => void): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const path of await findPhaseCompletes(dir)) {
    const name = relative(dir, path);
    let saved: any;
    // One unreadable file must not sink a resume that other files can satisfy, but it does not
    // get to vanish either: a phase_complete that cannot be parsed is exactly the kind of thing
    // someone needs told when the resume then picks an earlier phase than they expected.
    try { saved = JSON.parse(await fsReadFile(path, "utf-8")); }
    catch (error) { onSkip(`resume: skipping unreadable ${name} — ${(error as Error).message}`); continue; }
    const payload = saved.payload ?? saved;
    const phase = payload.next_phase ?? saved.next_phase;
    const manifest = payload.manifest_content ?? saved.manifest_content;
    if (typeof phase !== "string" || !phase || !manifest) continue;
    // PHASE_ORDER is a literal tuple; the saved phase is just a string off disk.
    candidates.push({
      from: name, phase, manifest,
      rank: (PHASE_ORDER as readonly string[]).indexOf(phase),
      depth: name.split(sep).length,
    });
  }
  // Shallowest first, so a root copy beats a nested duplicate of the same phase and the pick does
  // not depend on readdir order. Sort is stable, so this survives the rank sort in the caller.
  return candidates.sort((a, b) => a.depth - b.depth);
}

/**
 * Pick the phase a resumed run should restart at.
 *
 * `wanted` (E2E_RESUME_PHASE) names a specific restart point instead of the furthest one, which
 * is how a failing phase gets iterated: generate is the expensive one to reach, so restarting at
 * it from a scaffold checkpoint costs minutes rather than the whole chain.
 */
export async function resumePoint(
  dir: string,
  wanted?: string,
  onSkip: (message: string) => void = console.log,
): Promise<ResumePoint> {
  const candidates = await readCandidates(dir, onSkip);
  if (candidates.length === 0) {
    throw new Error(`E2E_RESUME: no phase_complete under ${dir} carries next_phase + manifest_content`);
  }
  if (wanted) {
    const picked = candidates.find((c) => c.phase === wanted);
    if (!picked) {
      // Name the FILE each option came from, not just the phase. When the wanted phase is missing
      // the next question is always "where did it look", and a bare phase list cannot answer it.
      const offered = candidates.map((c) => `${c.phase} (${c.from})`).join(", ");
      throw new Error(`E2E_RESUME_PHASE=${wanted} not saved under ${dir}; available: ${offered}`);
    }
    return { phase: picked.phase, manifest: picked.manifest, from: picked.from };
  }
  // Furthest along the CHAIN, not the newest file. mtime looked like the obvious key and is
  // worthless here: archiving a run with `cp -r` rewrites every mtime, so the ordering said
  // "flash" and the resume replayed scaffold and generate -- the two phases it exists to skip.
  // An unknown phase ranks -1 and loses to any known one.
  const best = [...candidates].sort((a, b) => b.rank - a.rank)[0];
  return { phase: best.phase, manifest: best.manifest, from: best.from };
}
