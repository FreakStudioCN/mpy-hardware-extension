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
const onEvent = (e: any) => {
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
let terminal = "(none)";
try {
  const result = await loop({ intent, boardId: "auto", traceId: "e2e-v0-fullstack", confirmApproval, onEvent, maxTurnsPerPhase });
  terminal = result?.terminal ?? "(none)";
} catch (error) {
  console.error("\nloop threw:", error);
} finally {
  (shim as any).dispose?.();
}

// --- success gate: reached generate THROUGH THE PLUGIN with real side effects ---
const reachedGenerate = phases.some((p) => p.phase === "upy-generate-plugin" && p.result === "success");
const mainPy = join(projectDir, "firmware", "main.py");
let mainOk = false;
try { mainOk = (await stat(mainPy)).size > 100; } catch { mainOk = false; }
let commits = 0;
try { commits = Number(execFileSync("git", ["-C", projectDir, "rev-list", "--count", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0; } catch { commits = 0; }
let scaffoldApplied = false;
try { scaffoldApplied = (await stat(join(projectDir, ".flake8"))).isFile(); } catch { scaffoldApplied = false; }
const deployResult = phases.find((p) => p.phase === "upy-deploy-plugin")?.result;

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
// hand-wrote the tree, no .flake8 / .upy / lib, and the deploy-tool interface was
// unreproducible from there. apply_scaffold writes .flake8 on every render.
console.log("scaffold applied (.flake8 present):", scaffoldApplied);
// Not part of the gate: with no board attached, ending after generate is a legitimate
// code-only delivery. Printed so a missing deploy is visible rather than inferred.
console.log("deploy phase:", deployResult ?? "(never ran)");

const passed = reachedGenerate && mainOk && commits > 0 && scaffoldApplied;
console.log("\nE2E-V0-FULLSTACK:", passed ? "PASS" : "REVIEW");
process.exit(passed ? 0 : 1);
