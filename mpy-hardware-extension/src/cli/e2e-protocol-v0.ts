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
import { mkdir, readFile as fsReadFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
// Reuse the stable dir; if a stale handle locks it (Windows EBUSY after a killed
// run), fall back to a fresh timestamped dir instead of crashing.
let projectDir = join(extRoot, "tmp", "e2e-v0");
try {
  await rm(projectDir, { recursive: true, force: true });
} catch {
  projectDir = join(extRoot, "tmp", `e2e-v0-${Date.now()}`);
}
await mkdir(projectDir, { recursive: true });
// generate's phase_complete(success) requires a real git commit — init a repo so the
// commit (run through the plugin's script_run, not faked) has somewhere to land.
const git = (...args: string[]) => execFileSync("git", ["-C", projectDir, ...args], { stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "e2e@blockless.local");
git("config", "user.name", "e2e");

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
const confirmApproval = async (card: any) => {
  const values = (card.actions ?? []).map((a: any) => a?.value).filter(Boolean);
  const action = NO_HW.find((a) => values.includes(a))
    ?? (card.actions ?? []).find((a: any) => a?.primary)?.value
    ?? values[0] ?? "confirm";
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
  else if (e.type === "phase_complete") { phases.push({ phase: current, result: e.payload?.result ?? null }); console.log(`  phase_complete: ${e.payload?.result} -> ${e.payload?.next_phase}`); if (e.payload?.result !== "success" && e.payload?.summary) console.log(`    reason: ${String(e.payload.summary).slice(0, 300)}`); }
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

const maxTurnsPerPhase = Number(process.env.E2E_MAX_TURNS ?? "75");

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

let terminal = "(none)";
let threw: string | null = null;
try {
  // No boardId: it is only ever the fallback for pre_selected_board, and that branch ignores
  // "auto" anyway, so passing it alongside preSelectedBoard said nothing.
  const result = await loop({ intent, preSelectedBoard, traceId: "e2e-v0-fullstack", confirmApproval, onEvent, maxTurnsPerPhase });
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
let deviceFiles: string[] | null = null;
if (deployResult) {
  try { deviceFiles = await shim.listDir(); }
  catch { deviceFiles = null; }  // no board, or it went away: nothing to compare against
}
const firmwareOnDevice = Array.isArray(deviceFiles) && deviceFiles.some((f) => String(f).replace(/^:/, "") === "main.py");

// PRESENCE IS NOT EXECUTION. A file listing says the upload landed; it says nothing about
// whether the board is running it. Measured: a run finished green with main.py on the device
// and the LED dark, because the device tests drive the raw REPL (which stops main.py) and
// nothing resets the board afterwards -- it only started when the board was replugged. The
// serial capture deploy already writes is the one artifact that proves execution, e.g.
// "[t=13275ms] [blink] toggle #1 (led=1)" after the soft reboot.
const MPREMOTE_BANNER = /^(MPY:|Connected to MicroPython|Use Ctrl-)/;
let firmwareRan: string | null = null;
try {
  const report = JSON.parse(await fsReadFile(join(projectDir, "deploy_result.json"), "utf-8"));
  const lines = String(report.serial_excerpt ?? "").split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
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
// And the question that one cannot answer: is the board running it NOW, after deploy finished.
// In the run this was written for, the capture proved the firmware ran and the board was still
// left idle, because the device tests drive the raw REPL (which stops main.py) and nothing
// resets it afterwards. A REPL that answers instantly is itself the tell: a board executing
// main.py does not sit at a prompt.
if (deployResult === "success" && deviceFiles) {
  const idle = await shim.probeMicroPython((await shim.scan())[0]).catch(() => false);
  console.log("board state after deploy:", idle
    ? "REPL answers immediately — the board is NOT running the deployed firmware (needs a reset)"
    : "REPL busy or unreachable — consistent with the firmware running");
}

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
else if (terminal !== "complete") console.log(`verdict blocked: terminal is ${terminal}, not complete`);
else if (deployFailed) console.log("verdict blocked: the deploy phase failed");
// Where the full account lives: stdout truncates a phase_complete summary at 300 chars and
// carries no tool payloads, so a REVIEW that says nothing here is answerable from the jsonl.
console.log("session log:", join(projectDir, ".mpyhw", "sessions", "e2e-v0-fullstack", "session.jsonl"));
console.log("\nE2E-V0-FULLSTACK:", passed ? "PASS" : "REVIEW");
process.exit(passed ? 0 : 1);
