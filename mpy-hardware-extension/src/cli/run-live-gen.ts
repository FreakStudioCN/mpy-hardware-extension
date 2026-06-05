// Headless real-generation harness: drives the live agent loop (DeepSeek via the
// running mpyhw-api) for one intent and writes the generated project into tmp/live/.
// Unlike run-golden-path.ts (deterministic template pipeline), this exercises the
// actual LLM codegen path the extension uses.
//
// It wires a real HOST shim (createDeviceShim) + project dir so the host verify
// track (run_validate / run_scaffold / run_static_check / run_simulate — all
// CPython, no device) actually runs. Device deploy is declined (no board), which
// now ends the loop cleanly as "generated" instead of grinding to manifest_unresolved.
//
// Prereqs:
//   1. mpyhw-api running (mpyhw-api/scripts/serve.ps1) with DEEPSEEK_API_KEY set.
//   2. MPYHW_DEV_JWT = a dev session token signed with the backend's MPYHW_JWT_SECRET
//      (the live serve.ps1 loads the real secret from mpyhw-api/.env, not the dev default).
//   3. A Python on PATH; first run bootstraps ~/.mpyhw/venv (jsonschema/flake8/pylint/...).
//
// Usage: npm run live-gen -- "your intent here"
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentBackedLoop, DEV_API_BASE_URL } from "../core/agent-backed-loop.ts";
import { createDeviceShim } from "../extension/device-shim.ts";
import { writeProjectFile as writeContainedProjectFile } from "../extension/workspace-writer.ts";

const intent = process.argv.slice(2).join(" ") || "ESP32-S3：每 2 秒读 AHT20 温湿度并显示在 SSD1306 OLED 上";
const apiBaseUrl = (process.env.MPYHW_API_BASE ?? DEV_API_BASE_URL).replace(/\/$/, "");
const jwt = process.env.MPYHW_DEV_JWT;
if (!jwt) {
  console.error("MPYHW_DEV_JWT not set. Mint a dev token (see header) and export it first.");
  process.exit(1);
}

// Real board list, exactly as the panel fetches it on load.
let availableBoards: Array<{ board_id: string; display_name?: string }> = [];
try {
  const res = await fetch(`${apiBaseUrl}/v1/boards`);
  const body: any = await res.json();
  availableBoards = [...(body.builtin ?? []), ...(body.community ?? [])];
} catch {
  console.error(`Could not reach ${apiBaseUrl}/v1/boards — is the API running?`);
  process.exit(1);
}
console.log(`intent: ${intent}`);
console.log(`boards: ${availableBoards.map((b) => b.board_id).join(", ") || "(none)"}\n`);

// Extension root (this file is src/cli/run-live-gen.ts) — createDeviceShim joins
// `${extRoot}/python/shim` for serve.py and the venv probe.
const extRoot = fileURLToPath(new URL("../../", import.meta.url));
const projectDir = join(extRoot, "tmp", "live");
await mkdir(projectDir, { recursive: true });

// Real host shim: the script.* RPCs (validate/scaffold/static_check/simulate) run on
// CPython via the venv with no device. Device RPCs would need a board, but deploy is
// declined below so they never run. vscode is undefined → resolvePython falls back to
// python3/python.
const shim = createDeviceShim({ vscode: undefined, extensionUri: { fsPath: extRoot } });

const loop = createAgentBackedLoop({
  apiBaseUrl,
  getAuthToken: async () => jwt,
  shim,
  projectRoot: projectDir,
  // write_project_file: same project-tree containment the extension host enforces,
  // writing into projectDir so the verify scripts (which read projectDir) see the files.
  writeProjectFile: (path: string, content: string) =>
    writeContainedProjectFile({
      workspaceFolder: projectDir,
      path,
      content,
      writeFile: async (target: string, c: string) => { await mkdir(dirname(target), { recursive: true }); await writeFile(target, c, "utf-8"); },
    }),
});

const files: Record<string, string> = {};
let manifest: any;
let lastPhase = "";

let result: any;
try {
  result = await loop({
    intent,
    boardId: "auto",
    availableBoards,
    // Self-documenting per-tool log: the loop records a tool_result for every
    // dispatch, so a failing/declined step is visible (name + ok + error_kind).
    recorder: {
      record: async (e: any) => {
        if (e.type === "tool_result") {
          const o = e.observation ?? {};
          console.log(`  [tool] ${e.name} -> ${o.ok ? "ok" : "FAIL " + (o.error_kind ?? "?")}`);
        }
      },
    },
    onEvent: (event: any) => {
      if (event.type === "code_updated") {
        files[event.path ?? "main.py"] = event.code;
        console.log(`[code] ${event.path ?? "main.py"} — ${event.code.length} chars`);
      } else if (event.type === "manifest_updated") {
        manifest = event.manifest;
      } else if (event.kind === "credits") {
        console.log(`[credits] remaining ${event.balance}`);
      } else if (event.type === "trace" && typeof event.text === "string") {
        const t = event.text.trim();
        if (t && t !== lastPhase && t.length < 40) { lastPhase = t; console.log(`· ${t}`); }
      }
    },
    // Non-interactive: take the agent's recommendation on any question, approve the
    // build plan, and decline device deploy (no hardware — codegen already captured).
    askUser: async (_question: string, options?: string[]) =>
      options && options.length ? options[0] : "你来决定，按你的推荐继续",
    confirmPlan: async () => ({ action: "confirm" as const }),
    confirmDeploy: async () => false,
  });
} catch (error) {
  console.error("\nloop threw:", error);
} finally {
  // The shim spawned a child Python process; release it so node can exit.
  (shim as any).dispose?.();
}

console.log(`\nterminal: ${result?.terminal ?? "(none)"}`);

const outDir = projectDir;
const written: string[] = [];
for (const [path, code] of Object.entries(files)) {
  const full = join(outDir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, code, "utf-8");
  written.push(full);
}
if (manifest) {
  const m = join(outDir, "manifest.json");
  await mkdir(dirname(m), { recursive: true });
  await writeFile(m, JSON.stringify(manifest, null, 2), "utf-8");
  written.push(m);
}

console.log(`\nWrote ${written.length} file(s) to ${outDir}/:`);
written.forEach((p) => console.log("  " + p));
for (const [path, code] of Object.entries(files)) {
  console.log(`\n===== ${path} =====\n${code}`);
}
if (!written.length) process.exit(1);
