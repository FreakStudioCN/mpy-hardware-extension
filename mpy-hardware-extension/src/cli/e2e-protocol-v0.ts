// FULL-STACK V0 e2e — the real product, including the plugin.
//
// Unlike mpyhw-api/scripts/e2e_protocol_v0.py (which drives the BACKEND internals in
// Python and runs scripts with its OWN faithful runner, bypassing the extension),
// this harness drives the SHIPPED extension path end to end:
//
//   real backend (/v1/llm/messages, real DeepSeek)
//     -> createProtocolLoop  (the exact factory SessionController/panel uses)
//        -> runProtocolBuild  (the real client loop)
//           -> real device-shim / serve.py  (runs the vendored V0 plugin scripts)
//           -> real project-file writer + reader  (host containment)
//
// So a fake-success script runner, a too-small per-phase turn budget, an old serve.py
// that can't resolve V0 plugin scripts, or a VSIX that doesn't bundle them all surface
// HERE as a failing run. This is the gate that "the whole product is on V0", not just
// the backend.
//
// Prereqs (same convention as run-live-gen.ts):
//   1. mpyhw-api running (mpyhw-api/scripts/serve.ps1) with DEEPSEEK_API_KEY set.
//   2. MPYHW_DEV_JWT = a dev session token signed with the backend's MPYHW_JWT_SECRET.
//   3. A Python on PATH; first run bootstraps ~/.mpyhw/venv.
// Bills several DeepSeek turns. Usage: npm run e2e:v0 -- "your intent here"
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile as fsReadFile, readdir, rename, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE_ORDER } from "../core/protocol-loop.ts";
import { createProtocolLoop } from "../core/protocol-build.ts";
import { createDeviceShim } from "../extension/device-shim.ts";
import { JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { writeProjectFile as writeContainedProjectFile } from "../extension/workspace-writer.ts";

const DEFAULT_INTENT = "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数";
const intent = process.argv.slice(2).join(" ") || DEFAULT_INTENT;
const apiBaseUrl = (process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const jwt = process.env.MPYHW_DEV_JWT;
if (!jwt) {
  console.error("MPYHW_DEV_JWT not set — provide a dev JWT signed with the backend's MPYHW_JWT_SECRET (see this file's header).");
  process.exit(2);
}

// Fail fast if the backend isn't reachable (don't silently 'pass' an unrun e2e).
let availableBoards: Array<{ board_id: string }> = [];
try {
  const res = await fetch(`${apiBaseUrl}/v1/boards`);
  const body: any = await res.json();
  availableBoards = [...(body.builtin ?? []), ...(body.community ?? [])];
} catch {
  console.error(`Could not reach ${apiBaseUrl}/v1/boards — is mpyhw-api running?`);
  process.exit(2);
}

const extRoot = fileURLToPath(new URL("../../", import.meta.url));
// E2E_RESUME=<a previous run's project dir> restarts from where that run got to, instead of
// walking the chain from analyze. The four phases before generate are stable and cost ~8
// minutes of model time per run, so iterating on deploy meant paying 40 minutes to reach the
// phase under test. The saved phase_complete carries both halves of a resume point: the
// manifest to hand forward and the next_phase to hand it to.
const resumeFrom = process.env.E2E_RESUME?.trim();

async function resumePoint(dir: string): Promise<{ phase: string; manifest: any; from: string }> {
  const names = (await readdir(dir)).filter((n) => n.startsWith("phase_complete.") && n.endsWith(".json"));
  const candidates: Array<{ name: string; phase: string; manifest: any; rank: number }> = [];
  for (const name of names) {
    const saved = JSON.parse(await fsReadFile(join(dir, name), "utf-8"));
    const payload = saved.payload ?? saved;
    const phase = payload.next_phase ?? saved.next_phase;
    const manifest = payload.manifest_content ?? saved.manifest_content;
    if (typeof phase === "string" && phase && manifest) {
      // PHASE_ORDER is a literal tuple; the saved phase is just a string off disk.
      candidates.push({ name, phase, manifest, rank: (PHASE_ORDER as readonly string[]).indexOf(phase) });
    }
  }
  if (candidates.length === 0) {
    throw new Error(`E2E_RESUME: no phase_complete in ${dir} carries next_phase + manifest_content`);
  }
  // E2E_RESUME_PHASE picks a specific restart point instead of the furthest one, which is how
  // a failing phase gets iterated: generate is the expensive one to reach, so restarting at it
  // from a scaffold checkpoint costs minutes rather than the whole chain.
  const wanted = process.env.E2E_RESUME_PHASE?.trim();
  if (wanted) {
    const picked = candidates.find((c) => c.phase === wanted);
    if (!picked) {
      const offered = candidates.map((c) => c.phase).join(", ");
      throw new Error(`E2E_RESUME_PHASE=${wanted} not saved in ${dir}; available: ${offered}`);
    }
    return { phase: picked.phase, manifest: picked.manifest, from: picked.name };
  }
  // Furthest along the CHAIN, not the newest file. mtime looked like the obvious key and is
  // worthless here: archiving a run with `cp -r` rewrites every mtime, so the ordering said
  // "flash" and the resume replayed scaffold and generate -- the two phases it exists to skip.
  // An unknown phase ranks -1 and loses to any known one.
  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates[0];
  return { phase: best.phase, manifest: best.manifest, from: best.name };
}

// E2E_PROJECT_DIR lets a single-phase iteration run beside a full one instead of fighting it
// for tmp/e2e-v0. Combined with leaving E2E_REQUIRE_BOARD unset (no pre-flight probe), a
// generate-only loop touches neither the shared project nor the board.
let projectDir = process.env.E2E_PROJECT_DIR?.trim() || join(extRoot, "tmp", "e2e-v0");
if (resumeFrom && resolve(resumeFrom) === resolve(projectDir)) {
  // Resuming the working dir in place. The copy branch below would delete the source before
  // copying it, so this case has to be caught rather than left to destroy the run it is
  // meant to continue.
  console.log("resume: continuing in place (E2E_RESUME is the working dir)");
} else if (resumeFrom) {
  // Copy rather than run in place, so the saved run stays pristine and can be resumed again
  // after this attempt breaks something.
  await rm(projectDir, { recursive: true, force: true });
  await cp(resumeFrom, projectDir, { recursive: true });
} else {
  // Reuse the stable dir; if a stale handle locks it (Windows EBUSY after a killed
  // run), fall back to a fresh timestamped dir instead of crashing.
  try {
    await rm(projectDir, { recursive: true, force: true });
  } catch {
    projectDir = join(extRoot, "tmp", `e2e-v0-${Date.now()}`);
  }
}
await mkdir(projectDir, { recursive: true });
const resume = resumeFrom ? await resumePoint(projectDir) : null;
// generate's phase_complete(success) requires a real git commit — init a repo so the
// commit (run through the plugin's script_run, not faked) has somewhere to land. `git init`
// on an existing repo is a no-op that keeps the resumed run's history.
const git = (...args: string[]) => execFileSync("git", ["-C", projectDir, ...args], { stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "e2e@blockless.local");
git("config", "user.name", "e2e");
// Keep OUR session log out of the project's git. It lives under the project root and grows
// on every turn, so a phase that commits and then checks for a clean tree can never get one:
// `git add -A` sweeps the log in, writing the log dirties the tree again. Written to
// .git/info/exclude rather than .gitignore because apply_scaffold renders its own .gitignore
// over ours, and because this is a property of how we run the build, not of the project.
await writeFile(join(projectDir, ".git", "info", "exclude"), ".mpyhw/\n", "utf-8");

const shim = createDeviceShim({ vscode: undefined, extensionUri: { fsPath: extRoot } });

// Pre-flight the board before spending a build on it. E2E_REQUIRE_BOARD says a run is meant
// to reach hardware, so a board that is present but unusable should stop the run in seconds
// rather than at deploy. Twice now a CP2102 has wedged after a day of open/close cycles --
// the device node still enumerates and mpremote and pyserial both see it, but every open
// fails with termios.error (22, 'Invalid argument') -- and each time the run did all six
// phases of work before discovering it. A replug clears it.
if (process.env.E2E_REQUIRE_BOARD?.trim()) {
  const ports = await shim.scan().catch(() => [] as string[]);
  if (ports.length === 0) {
    console.error("E2E_REQUIRE_BOARD is set but no serial port was found. Plug the board in.");
    process.exit(2);
  }
  const reachable = await shim.probeMicroPython(ports[0]).catch(() => false);
  console.log(`board pre-flight: ${ports[0]} ->`, reachable ? "REPL reachable" : "REPL did not answer");
  if (!reachable) {
    // A silent REPL has two very different causes and this cannot tell them apart from here:
    // a wedged USB bridge (raw open fails with termios (22)), or a board happily RUNNING a
    // previous build, which does not sit at a prompt. The second is normal -- deploy's clean
    // step handles it, and has said so in its own words: "its boot.py/main.py were blocking
    // the REPL". Refusing there would block a run for the most ordinary reason a board has.
    // So warn and continue: the run still fails fast at deploy if the port really is wedged.
    console.warn(
      `WARNING: ${ports[0]} enumerates but its REPL did not answer. Either the board is running ` +
      "a previous build (normal, deploy will clean it) or the USB bridge is wedged (a raw open " +
      "fails with termios.error (22, 'Invalid argument') -- unplug and replug). Continuing.",
    );
  }
}

const writeProjectFile = (path: string, content: string) =>
  writeContainedProjectFile({
    workspaceFolder: projectDir,
    path,
    content,
    writeFile: async (target: string, c: string) => { await mkdir(dirname(target), { recursive: true }); await writeFile(target, c, "utf-8"); },
  });
const readWorkspaceFile = async (path: string) => {
  try { return { ok: true, content: await fsReadFile(join(projectDir, path), "utf-8") }; }
  // Only ENOENT is absence. A blanket "not_found" told the loop a file was missing when the
  // read had actually failed (permissions, a directory), and the scaffold guard treats
  // absence as proof the phase rendered nothing.
  catch (err: any) { return { ok: false, error_kind: err?.code === "ENOENT" ? "file_not_found" : "read_failed" }; }
};
const listWorkspace = async (path: string) => {
  const base = path ? join(projectDir, path) : projectDir;
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      const rel = relative(projectDir, full).replace(/\\/g, "/");
      if (e.isDirectory()) { out.push(rel + "/"); await walk(full); }
      else out.push(rel);
    }
  };
  try { await walk(base); return { ok: true, entries: out }; }
  catch { return { ok: false, error_kind: "not_found" }; }
};
// Real mkdir/delete so generate's firmware/tools/ cleanup actually happens (matching
// the shipped panel.ts backings) — never a no-op that fakes success.
const contained = (path: string) => {
  const target = join(projectDir, path);
  return target === projectDir || target.startsWith(projectDir + "/") || target.startsWith(projectDir + "\\") ? target : null;
};
const makeProjectDir = async (path: string) => {
  const target = contained(path);
  if (!target || target === projectDir) return { ok: false, error_kind: "path_outside_workspace" };
  try { await mkdir(target, { recursive: true }); return { ok: true }; }
  catch { return { ok: false, error_kind: "mkdir_failed" }; }
};
const deleteProjectPath = async (path: string) => {
  const target = contained(path);
  if (!target || target === projectDir) return { ok: false, error_kind: "path_outside_workspace" };
  try { await rm(target, { recursive: true, force: true }); return { ok: true }; }
  catch { return { ok: false, error_kind: "delete_failed" }; }
};

const loop = createProtocolLoop({ apiBaseUrl, getAuthToken: async () => jwt, shim, projectRoot: projectDir, writeProjectFile, readWorkspaceFile, listFiles: listWorkspace, makeProjectDir, deleteProjectPath });

// Headless "no board attached" user: for any flash/device approval take the
// no-hardware action (mirrors e2e_protocol_v0.py's NO_HW_ACTIONS); otherwise the
// primary action; and select every offered item (array OR object item_groups).
const NO_HW = ["already_flashed", "use_local_firmware", "confirm_flashed", "copied_uf2", "copied", "confirmed"];
// The stand-in user ACCEPTS a finished result rather than asking for rework. Measured: after a
// clean six-phase run, deploy's "Deployment result: PASS ... optionally provide feedback" card
// was answered `regenerate`, because that was the card's primary action. The loop then routed
// back to generate and ended `awaiting_user`, so a run where every phase succeeded could not
// reach terminal `complete`. Ranked ABOVE primary; when a card offers none of these (a failed
// deploy offers retry/autofix/save_checkpoint), the old primary-then-first rule still applies.
const ACCEPT = ["accept", "accept_result", "accepted", "looks_good", "no_changes", "done", "finish", "complete", "completed", "keep", "close"];
const confirmApproval = async (card: any) => {
  const values = (card.actions ?? []).map((a: any) => a?.value).filter(Boolean);
  const action = NO_HW.find((a) => values.includes(a))
    ?? ACCEPT.find((a) => values.includes(a))
    ?? (card.actions ?? []).find((a: any) => a?.primary)?.value
    ?? values[0] ?? "confirm";
  // Printed so the next unexpected answer can be diagnosed from the run log: the session log
  // compacts these objects to "<object>", which is why this one took a guess to find.
  console.log(`  [approval] ${card.approval_id ?? "?"} -> ${action}  (offered: ${values.join(", ") || "none"})`);
  const groupList = Array.isArray(card.item_groups)
    ? card.item_groups.map((g: any) => ({ id: g?.group_id ?? g?.id, multi_select: g?.multi_select, items: g?.items }))
    : Object.entries(card.item_groups ?? {}).map(([id, meta]: [string, any]) => ({ id, multi_select: meta?.multi_select, items: meta?.items }));
  // Single-choice groups (multi_select:false) contribute one id, not all — else a
  // scaffold card would auto-select every scheduler mode at once.
  const singleChoice = new Set(groupList.filter((g: any) => g?.multi_select === false).map((g: any) => String(g?.id)));
  const perGroup = new Map<string, any[]>();
  const takeAll: any[] = [];
  // Dedup by id: an item can appear in BOTH card.items (with .group) and a group's inline items;
  // count it once (mirrors protocol-loop.ts + the webview merge, so all three agree).
  const seen = new Set<string>();
  const bucket = (it: any, gid: string) => {
    const key = it?.id != null ? String(it.id) : null;
    if (key != null) { if (seen.has(key)) return; seen.add(key); }
    if (singleChoice.has(gid)) { const arr = perGroup.get(gid) ?? []; arr.push(it); perGroup.set(gid, arr); }
    else if (it?.id != null) takeAll.push(it.id);
  };
  for (const it of (card.items ?? [])) bucket(it, it?.group == null ? "" : String(it.group));
  for (const g of groupList) for (const it of (Array.isArray(g?.items) ? g.items : [])) bucket(it, String(g?.id));
  const oneEach = [...perGroup.values()].map((list) => (list.find((i: any) => i?.selected === true) ?? list[0])?.id);
  const selected_ids = [...takeAll, ...oneEach].filter(Boolean);
  return { action, selected_ids, added_items: [], text_values: {}, notes: "" };
};

// E2E_ONLY_PHASE stops the run when the named phase finishes, so a single-phase iteration stays
// one phase. Without it the loop follows next_phase the moment the phase under test succeeds and
// silently becomes a full run whose later phases are graded against a project that already holds
// the earlier output -- which is how one "generate-only" run ended up reporting a second,
// meaningless generate pass.
const E2E_ONLY_PHASE = process.env.E2E_ONLY_PHASE?.trim() || "";
const scopeStop = new AbortController();
let stopAfterPhase = false;

// Snapshot the project tree the moment a phase finishes, into .mpyhw/checkpoints/<phase>/.
//
// Without this, no single phase can be re-run from a real starting state. Every phase
// overwrites main.py and project-manifest.json in place, and scaffold never commits, so once
// generate has run there is nothing left on disk OR in git describing the post-scaffold
// project. Resuming from a finished archive then hands the model work already done: one run
// "passed" generate having never invoked its validator once, which read as a green run and
// was not one.
//
// Best-effort by design: a failed snapshot must never fail the run it is observing. It is
// diagnostic scaffolding, not a phase result.
async function snapshotCheckpoint(phase: string): Promise<void> {
  if (!phase) return;
  const dest = join(projectDir, ".mpyhw", "checkpoints", phase);
  // Staged OUTSIDE the project, then moved in: fs.cp refuses a copy whose destination is inside
  // the source tree, up front and regardless of the filter (EINVAL, "cannot copy X to a
  // subdirectory of self"). The staging dir is a sibling of the project so the rename stays on
  // one filesystem.
  const staging = join(dirname(projectDir), `.ckpt-${phase.replace(/[^\w.-]/g, "_")}-tmp`);
  try {
    await rm(staging, { recursive: true, force: true });
    // Skip .mpyhw itself: it holds the session log and these very checkpoints, so copying it in
    // would nest the run's own history one level deeper on every phase.
    await cp(projectDir, staging, {
      recursive: true,
      filter: (src) => !src.includes(`${sep}.mpyhw`),
    });
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    console.log(`  [checkpoint] ${phase} -> .mpyhw/checkpoints/${phase}`);
  } catch (err: any) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    console.warn(`  [checkpoint] ${phase} not saved: ${err?.message ?? err}`);
  }
}

// Reconstruct the phase->result trail from loop events (createProtocolLoop only
// returns the last phase). phase_start sets the current phase; phase_complete records it.
const phases: Array<{ phase: string; result: string | null }> = [];
const stalls: Array<{ phase: string; reason: string | null; detail: any[] }> = [];
let current = "analyze";
// Every event, verbatim, to <project>/.mpyhw/sessions/<trace>/session.jsonl. The panel has
// recorded this since the start; a headless run recorded NOTHING but this file's own stdout,
// which prints a phase_complete summary truncated at 300 chars and no tool payloads at all.
// Concretely lost that way: why a deploy that plainly worked (firmware on the board, LED
// blinking) reported "the firmware upload failed: the ", and the exact script_run arguments a
// teammate asked for. Same recorder the extension uses, so both paths produce one format.
const recorder = new JsonlSessionRecorder({ workspaceFolder: projectDir, traceId: "e2e-v0-fullstack" });
const onEvent = (e: any) => {
  void recorder.record(e);
  if (e.type === "phase_start") { current = e.phase; console.log(`\n----- PHASE: ${e.phase} -----`); }
  else if (e.type === "phase_complete") {
    phases.push({ phase: current, result: e.payload?.result ?? null });
    console.log(`  phase_complete: ${e.payload?.result} -> ${e.payload?.next_phase}`);
    if (e.payload?.result !== "success" && e.payload?.summary) console.log(`    reason: ${String(e.payload.summary).slice(0, 300)}`);
    void snapshotCheckpoint(current);
    // A single-phase iteration is only "single phase" while the phase under test keeps failing:
    // the moment it succeeds, the loop follows next_phase and quietly becomes a full run. That
    // happened -- a generate-only run carried on into deploy, a re-flash and a SECOND generate,
    // whose result told us nothing about the phase we were iterating on because the project
    // already held the first pass's output. Say so, rather than leaving it to be noticed in the
    // transcript an hour later.
    if (E2E_ONLY_PHASE && current === E2E_ONLY_PHASE && e.payload?.next_phase) {
      console.log(`\n  [scope] ${E2E_ONLY_PHASE} finished; E2E_ONLY_PHASE stops here rather than continuing to ${e.payload.next_phase}.`);
      console.log("  [scope] anything past this point would run against a project that already holds this phase's output.");
      stopAfterPhase = true;
      scopeStop.abort();
    }
  }
  // A refusal is invisible otherwise, and it is the loop's most important verdict: the model
  // claimed the phase was done and the gate disagreed. Printed where the run is triaged, so a
  // phase that ends at its turn cap shows WHY it kept going after claiming success.
  else if (e.type === "phase_complete_refused") {
    console.log(`  [refused] ${e.phase}: phase_complete(success) rejected by ${e.gate} (${e.reason}) at turn ${e.turn}`);
  }
  // A stall is the most common way a run ends, and this harness printed nothing for it: the
  // reason ("no_tool_call" / "max_turns" / "stream_error") and the detail array of recent
  // failing tool calls both went to waste, so every diagnosis started from turn counts and
  // leftover files instead of the loop's own account of why it gave up.
  else if (e.type === "phase_stalled") {
    // The event's own `phase`, not the phase reconstructed from the last phase_start: a stall
    // reported for any other phase would be printed under the wrong name, in the very output
    // added to make a stall diagnosable. Guard `detail` once and use that ONE value for both
    // the inline print and the stored record -- storing the raw value threw
    // "s.detail is not iterable" out of the summary loop, losing the whole verdict of a run
    // that had already finished.
    const phase = e.phase ?? current;
    const detail = Array.isArray(e.detail) ? e.detail : [];
    console.log(`  !! phase_stalled: ${phase} — reason: ${e.reason ?? "(none)"}`);
    for (const d of detail) console.log(`       ${JSON.stringify(d)}`);
    stalls.push({ phase, reason: e.reason ?? null, detail });
  }
  // The replayed history could not be brought under the cap. The request still went out, so
  // the run may continue -- but if it dies on a non-retryable 400 a few turns later, this is
  // the line that says why.
  else if (e.type === "history_over_cap") console.log(`  !! history over cap: ${e.chars} chars on ${e.phase} turn ${e.turn}`);
  else if (e.type === "phase_error") console.log(`  !! phase_error: ${e.error_kind ?? "(none)"} ${e.next_phase ?? ""}`);
  else if (e.type === "file_written") console.log(`  [file] ${e.path}`);
  else if (e.type === "status_update") console.log(`  [status] ${e.payload?.message ?? ""}`.slice(0, 120));
};

console.log("=== FULL-STACK V0 e2e (real backend + real plugin) ===");
console.log("intent:", intent);
console.log("project:", projectDir);

// Undefined, not a number: the loop's own MAX_TURNS_PER_PHASE then applies, so the e2e always
// measures the cap the product ships. Hardcoding 75 here meant the harness ran a phase 25%
// longer than any user's would, and every run that mattered had to remember to pass the real
// number on the command line. E2E_MAX_TURNS still overrides, for deliberately short runs.
const maxTurnsPerPhase = process.env.E2E_MAX_TURNS ? Number(process.env.E2E_MAX_TURNS) : undefined;

// E2E_BOARD picks the board the way the panel's board picker does, instead of leaving the
// phase on "auto". This matters because select-hw is given a board profile only when a
// candidate id resolves: on "auto" the injected `Board profile` is literally {}, and a model
// then either refuses ("board definition not available") or invents an id that exists in no
// library. A bare id is NOT enough — the server only takes an OBJECT-shaped pre_selected_board
// as a profile candidate — so an id is expanded into the same id fields the picker sends.
// Unset keeps the old behaviour, so existing runs are unchanged.
const boardEnv = process.env.E2E_BOARD?.trim();
const preSelectedBoard = !boardEnv
  ? undefined
  : boardEnv.startsWith("{")
    ? JSON.parse(boardEnv)
    : { id: boardEnv, local_board_id: boardEnv, skill_board_id: boardEnv };
console.log("board:", preSelectedBoard ? JSON.stringify(preSelectedBoard) : "auto (no pre-selection)");
if (resume) console.log(`resume: ${resume.phase} (from ${resume.from} in ${resumeFrom})`);

let terminal = "(none)";
let threw: string | null = null;
try {
  // No boardId: it is only ever the fallback for pre_selected_board, and that branch ignores
  // "auto" anyway, so passing it alongside preSelectedBoard said nothing.
  const result = await loop({
    intent,
    preSelectedBoard,
    traceId: "e2e-v0-fullstack",
    confirmApproval,
    onEvent,
    maxTurnsPerPhase,
    ...(resume ? { state: { phase: resume.phase, manifest: resume.manifest } } : {}),
    ...(E2E_ONLY_PHASE ? { signal: scopeStop.signal } : {}),
  });
  terminal = result?.terminal ?? "(none)";
} catch (error: any) {
  // A thrown loop ran NOTHING. Recorded so the verdict can say so: a run that died on an
  // expired token printed REVIEW, which reads like a build that went wrong rather than one
  // that never started.
  threw = error?.message ?? String(error);
  console.error("\nloop threw:", error);
} finally {
  (shim as any).dispose?.();
  // Writes are queued behind a promise chain, so without this the last events of a run --
  // the phase_complete that explains why it ended, above all -- are the ones lost.
  await recorder.flush?.();
}

// --- success gate: reached generate THROUGH THE PLUGIN with real side effects ---
const reachedGenerate = phases.some((p) => p.phase === "upy-generate-plugin" && p.result === "success");
const mainPy = join(projectDir, "firmware", "main.py");
let mainOk = false;
try { mainOk = (await stat(mainPy)).size > 100; } catch { mainOk = false; }
let commits = 0;
try { commits = Number(execFileSync("git", ["-C", projectDir, "rev-list", "--count", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0; } catch { commits = 0; }
// Same markers the loop guard uses, and for the same reason: a run that skipped apply_scaffold
// hand-wrote its own .flake8, so checking THAT reported "scaffold applied" for a project whose
// whole tree the model had invented. These two are written by the scaffold scripts and a model
// has no reason to produce them. Either one proves a render: the file manifest goes to
// --session-dir (so it is not always at the root), the .upy schema is copied unconditionally.
const SCAFFOLD_MARKERS = ["scaffold_file_manifest.json", ".upy/schemas/project-manifest.schema.json"];
let scaffoldApplied = false;
for (const marker of SCAFFOLD_MARKERS) {
  try { if ((await stat(join(projectDir, marker))).isFile()) { scaffoldApplied = true; break; } } catch { /* absent — try the next */ }
}
const deployResult = phases.find((p) => p.phase === "upy-deploy-plugin")?.result;

// Ask the DEVICE what happened, rather than trusting the phase's account of itself. Twice now
// the two have disagreed, in opposite directions: one run reported deploy success while writing
// none of the six artifacts deploy_manifest.py requires, and one reported "the firmware upload
// failed" while the board was running the new firmware with its LED blinking. Read-only: this
// reports the disagreement, it does not overrule the phase, because which side is wrong is
// exactly what nobody can currently tell.
// Read from the UPLOAD RECORD, not from the board. `shim.listDir()` was the obvious way to
// answer "what is on the device", and it cost us the thing the run exists to produce: listing
// the filesystem enters the raw REPL, which stops main.py, so a deploy that correctly left the
// board blinking went dark the moment this summary printed. Measured twice -- once through
// probeMicroPython, removed earlier, and once here, which is the same mistake wearing a
// different call. Deploy already writes what it uploaded; reading that touches nothing.
// TWO producers write this file, and reading only the first is how this check cried wolf: a run
// whose board was demonstrably blinking was reported as "NO main.py (0 entries)". The deploy
// plugin's upload script emits `uploaded_files`; a bare `mpremote_runtime.py` upload emits its
// raw process result instead, where the files are the `cp` arguments. Same filename, same phase,
// different shape.
function uploadedFromSummary(summary: any): string[] | null {
  const listed = summary?.uploaded_files ?? summary?.files;
  if (Array.isArray(listed)) {
    // Basename here too, not only on the command path below. A summary that lists HOST paths
    // ("firmware/main.py", which is what `cp -r firmware/... :` uploads) never matched the
    // device name, so a deploy that had genuinely uploaded main.py was reported as "NO main.py".
    return listed
      .map((f: any) => String(f?.target ?? f?.remote ?? f?.path ?? f))
      .filter(Boolean)
      .map((f: string) => f.replace(/^:/, "").split("/").pop() ?? f)
      .filter(Boolean);
  }
  // `mpremote ... resume cp -r <src>... :` -- every argument between `cp` and the `:` target.
  const argv = Array.isArray(summary?.command) ? summary.command.map(String) : [];
  const cp = argv.indexOf("cp");
  if (cp === -1) return null;
  const sources = argv.slice(cp + 1).filter((a: string) => a !== "-r" && a !== ":");
  // Compare on basename: the record holds host paths (firmware/main.py), the device holds main.py.
  return sources.map((a: string) => a.split("/").pop() ?? a).filter(Boolean);
}

let deviceFiles: string[] | null = null;
if (deployResult) {
  try {
    const summary = JSON.parse(await fsReadFile(join(projectDir, "upload_summary.json"), "utf-8"));
    deviceFiles = uploadedFromSummary(summary);
  } catch {
    deviceFiles = null;  // no upload record: nothing to compare against, and still no probing
  }
}
const firmwareOnDevice = Array.isArray(deviceFiles) && deviceFiles.some((f) => String(f).replace(/^:/, "") === "main.py");

// PRESENCE IS NOT EXECUTION. A file listing says the upload landed; it says nothing about
// whether the board is running it. Measured: a run finished green with main.py on the device
// and the LED dark, because the device tests drive the raw REPL (which stops main.py) and
// nothing resets the board afterwards -- it only started when the board was replugged. The
// serial capture deploy already writes is the one artifact that proves execution, e.g.
// "[t=13275ms] [blink] toggle #1 (led=1)" after the soft reboot.
const MPREMOTE_BANNER = /^(MPY:|Connected to MicroPython|Use Ctrl-)/;
// FOUND, not assumed at the project root. The model chooses where its artifacts go, and one
// run wrote them to deploy/ and sessions/deploy_artifacts/ -- so this reported "NOT OBSERVED"
// and printed a MISMATCH warning about a deploy that had in fact produced every artifact and
// passed its gate. A checker that only looks where it expects will keep calling correct runs
// broken.
async function findArtifact(root: string, name: string, depth = 3): Promise<string | null> {
  const direct = join(root, name);
  if (await stat(direct).then(() => true, () => false)) return direct;
  if (depth <= 0) return null;
  let entries: any[] = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    // .mpyhw holds the session log and the checkpoints, which are copies of the tree: descending
    // into it would find a stale artifact from an earlier phase and report it as this one's.
    if (!entry.isDirectory() || entry.name === ".mpyhw" || entry.name === ".git") continue;
    const found = await findArtifact(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

let firmwareRan: string | null = null;
try {
  const reportPath = await findArtifact(projectDir, "deploy_result.json");
  if (!reportPath) throw new Error("no deploy_result.json anywhere under the project");
  const report = JSON.parse(await fsReadFile(reportPath, "utf-8"));
  // BOTH captures, not just the serial one. The final reset is by contract the LAST device
  // operation, so a deploy that runs one capture puts its only proof in final_reset_excerpt and
  // leaves serial_excerpt empty -- and two runs were then reported as "firmware ran: NOT
  // OBSERVED" while their final reset held "MPY: soft reboot" and the boot line. The better the
  // deploy contract gets at making the reset the single capture, the more often reading only
  // serial_excerpt is wrong.
  const captured = [report.serial_excerpt, report.final_reset_excerpt,
                    report.final_reset?.output_excerpt, report.final_reset?.output]
    .map((v: unknown) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .join("\n");
  const lines = captured.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  const rebootAt = lines.findIndex((l: string) => l.includes("soft reboot"));
  const fromFirmware = lines.slice(rebootAt + 1).filter((l: string) => !MPREMOTE_BANNER.test(l));
  firmwareRan = fromFirmware.length ? fromFirmware[0].slice(0, 70) : null;
} catch { firmwareRan = null; }  // no report, unreadable, or no capture: report it as unknown

console.log("\n=== SUMMARY ===");
console.log("phases:", phases.map((p) => `${p.phase}(${p.result})`).join(" -> ") || "(none)");
console.log("terminal:", terminal);
// In the summary as well as inline: a stall scrolls past under hundreds of [file] lines,
// and the reason is the first thing anyone reading a failed run needs.
for (const s of stalls) {
  console.log(`stalled: ${s.phase} — ${s.reason ?? "(no reason recorded)"}`);
  for (const d of s.detail) console.log(`         ${JSON.stringify(d)}`);
}
console.log("reached generate (success):", reachedGenerate);
console.log("firmware/main.py nontrivial:", mainOk);
console.log("real git commits in project:", commits);
// A run whose scaffold rendered nothing used to PASS on generate alone: the model
// hand-wrote the tree and the deploy-tool interface was unreproducible from there.
console.log("scaffold applied (scaffold-authored marker present):", scaffoldApplied);
// A deploy that never ran is NOT a failure: with no board attached, ending after generate is
// a legitimate code-only delivery. A deploy that ran and FAILED is.
console.log("deploy phase:", deployResult ?? "(never ran)");
if (deviceFiles) {
  console.log("device after run:", firmwareOnDevice ? `main.py present (${deviceFiles.length} entries)` : `NO main.py (${deviceFiles.length} entries)`);
  // Presence is the weaker claim and is reported as such; a main.py an earlier run left behind
  // looks identical to one this run uploaded.
  if (deployResult === "failed" && firmwareOnDevice) {
    console.log("NOTE: deploy reported failed while a main.py is on the device — it may be a previous run's. Compare the @Generated stamp.");
  }
  if (deployResult === "success" && !firmwareOnDevice) {
    console.log("MISMATCH: deploy reported success, but the device has no main.py.");
  }
}
// The stronger claim: did the board actually RUN it. This is the line that would have caught a
// green run leaving the device idle at the REPL.
console.log("firmware ran during deploy:", firmwareRan ? `yes — "${firmwareRan}"` : "NOT OBSERVED (no serial evidence in deploy_result.json)");
if (deployResult === "success" && !firmwareRan) {
  console.log("MISMATCH: deploy reported success, but nothing in the serial capture shows the firmware running.");
}
// There WAS a probe here that connected to the board to report whether it was still running
// the firmware. It is gone, for two reasons, both learned the hard way.
//
// It was wrong: it read "the REPL answers" as "the board is idle". That only held while the
// scaffold scheduler spun without yielding and starved USB. The scheduler yields now, so a
// running board answers a REPL perfectly well and the probe called every healthy run idle.
//
// Worse, it was destructive: connecting enters the raw REPL, which STOPS main.py. So the
// check that asked "is the firmware running" was itself the reason it stopped -- a green run
// ended with the LED dark and the board needing a replug, caused entirely by our own
// verdict code. The serial capture above already answers the question from evidence deploy
// collected, without touching the device.

// The verdict reads the RUN, not just the files it left behind. Two misreports drove this:
// a PASS on a run whose deploy failed to open the port (terminal "failed"), and a REVIEW on
// a run that threw on an expired token before any phase executed -- the second is not a build
// that went wrong, it is a build that never started, and the files on disk were a previous
// run's. Anything short of a completed loop is now a hard fail that names itself.
const deployFailed = deployResult === "failed";
const ranAtAll = threw === null && phases.length > 0;
const passed = ranAtAll && terminal === "complete" && !deployFailed
  && reachedGenerate && mainOk && commits > 0 && scaffoldApplied;
if (threw) console.log("verdict blocked: the loop threw before finishing —", threw);
else if (phases.length === 0) console.log("verdict blocked: no phase executed");
// A scoped stop cancels the loop on purpose, so "cancelled" here is the run doing as it was
// told. Reporting it as a blocked verdict would read like a failure and invite exactly the
// misreading this option exists to prevent.
else if (stopAfterPhase) {
  const scoped = phases.find((p) => p.phase === E2E_ONLY_PHASE);
  console.log(`scoped run: ${E2E_ONLY_PHASE} finished with result=${scoped?.result ?? "(unknown)"}; later phases were not run, so this says nothing about them`);
}
else if (terminal !== "complete") console.log(`verdict blocked: terminal is ${terminal}, not complete`);
else if (deployFailed) console.log("verdict blocked: the deploy phase failed");
// Where the full account lives: stdout truncates a phase_complete summary at 300 chars and
// carries no tool payloads, so a REVIEW that says nothing here is answerable from the jsonl.
console.log("session log:", join(projectDir, ".mpyhw", "sessions", "e2e-v0-fullstack", "session.jsonl"));
console.log("\nE2E-V0-FULLSTACK:", passed ? "PASS" : "REVIEW");
process.exit(passed ? 0 : 1);
