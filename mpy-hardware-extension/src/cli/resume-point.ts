// Where a resumed run restarts from.
//
// E2E_RESUME=<a previous run's project dir> restarts from where that run got to, instead of
// walking the chain from analyze. The four phases before generate are stable and cost ~8 minutes
// of model time per run, so iterating on deploy meant paying 40 minutes to reach the phase under
// test. The saved phase_complete carries both halves of a resume point: the manifest to hand
// forward and the next_phase to hand it to.
import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { PHASE_ALIASES, PHASE_ORDER } from "../core/protocol-loop.ts";

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

// The saved next_phase is a STRING OFF DISK, and until it resolves to a canonical phase it is not
// a resume point -- it is just text a previous run wrote. Three things went wrong by taking it
// verbatim. It is joined into a checkpoint path that a recursive rm then deletes, so `../../x`
// escaped the project. It is ranked with PHASE_ORDER.indexOf, which holds only the canonical
// `-plugin` spellings, so a legal short alias ranked -1 and lost to an EARLIER phase -- resume then
// replayed the phase it exists to skip. And it is handed to the loop as the phase to run, which
// asks the backend for a skill by that name and gets none.
//
// PHASE_ALIASES is imported rather than restated: it is the authoritative table and it changes.
// Only the trimming is local, to keep this file off protocol-loop.ts, which a sibling branch owns.
// Anything not IN that table resolves to null, which is what makes a traversal string unusable
// here rather than merely discouraged.
function canonicalPhase(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim().replace(/^\/+/, "");
  if (!raw || ["null", "none"].includes(raw.toLowerCase())) return null;
  // hasOwn, not a bare lookup. PHASE_ALIASES is an object literal, so a plain index walks the
  // prototype chain and "toString", "constructor", "__proto__", "valueOf" and friends all come
  // back truthy -- as FUNCTIONS. `?? null` never fires on those, so the one thing this guard
  // promises, that anything outside the table is refused, was false for about ten inputs. They
  // reach the loop as a phase, and a Function handed to checkpointSegment's replace() throws
  // where nothing catches it, which would reject the checkpoint queue that must never reject.
  return Object.hasOwn(PHASE_ALIASES, raw) ? PHASE_ALIASES[raw] : null;
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
    // Resolved here, once, so everything downstream -- the rank, the phase handed to the loop, and
    // the checkpoint path built from it -- sees a canonical phase and never the raw string.
    const canonical = canonicalPhase(phase);
    if (!canonical) {
      // Said out loud for the same reason an unreadable file is: a resume that silently picks an
      // earlier phase than expected is the thing nobody can explain afterwards.
      onSkip(`resume: skipping ${name} — next_phase ${JSON.stringify(phase)} is not a known phase`);
      continue;
    }
    candidates.push({
      from: name, phase: canonical, manifest,
      rank: (PHASE_ORDER as readonly string[]).indexOf(canonical),
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
    // Names both ways a file can fail to be a resume point, because they are now different
    // failures: missing fields, or a next_phase that named no known phase. The skip lines above
    // say which, and this line is what someone reads first.
    throw new Error(`E2E_RESUME: no phase_complete under ${dir} carries next_phase + manifest_content naming a known phase`);
  }
  if (wanted) {
    // Normalized on BOTH sides. The candidates are canonical now, so comparing them against a raw
    // env value would reject `E2E_RESUME_PHASE=deploy` -- the spelling a person actually types, and
    // one the alias table has always accepted.
    const wantedPhase = canonicalPhase(wanted) ?? wanted;
    const picked = candidates.find((c) => c.phase === wantedPhase);
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
