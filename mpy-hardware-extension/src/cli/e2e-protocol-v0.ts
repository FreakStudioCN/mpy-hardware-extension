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
  catch { return { ok: false, error_kind: "not_found" }; }
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
  const groups = card.item_groups ?? [];
  const groupList = Array.isArray(groups) ? groups : Object.values(groups);
  const selected_ids = [
    ...((card.items ?? []).map((i: any) => i?.id)),
    ...groupList.flatMap((g: any) => ((g?.items ?? []).map((i: any) => i?.id))),
  ].filter(Boolean);
  return { action, selected_ids, added_items: [], text_values: {}, notes: "" };
};

// Reconstruct the phase->result trail from loop events (createProtocolLoop only
// returns the last phase). phase_start sets the current phase; phase_complete records it.
const phases: Array<{ phase: string; result: string | null }> = [];
let current = "analyze";
const onEvent = (e: any) => {
  if (e.type === "phase_start") { current = e.phase; console.log(`\n----- PHASE: ${e.phase} -----`); }
  else if (e.type === "phase_complete") { phases.push({ phase: current, result: e.payload?.result ?? null }); console.log(`  phase_complete: ${e.payload?.result} -> ${e.payload?.next_phase}`); if (e.payload?.result !== "success" && e.payload?.summary) console.log(`    reason: ${String(e.payload.summary).slice(0, 300)}`); }
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

console.log("\n=== SUMMARY ===");
console.log("phases:", phases.map((p) => `${p.phase}(${p.result})`).join(" -> ") || "(none)");
console.log("terminal:", terminal);
console.log("reached generate (success):", reachedGenerate);
console.log("firmware/main.py nontrivial:", mainOk);
console.log("real git commits in project:", commits);

const passed = reachedGenerate && mainOk && commits > 0;
console.log("\nE2E-V0-FULLSTACK:", passed ? "PASS" : "REVIEW");
process.exit(passed ? 0 : 1);
