// Headless real-generation harness: drives the live agent loop (DeepSeek via the
// running mpyhw-api) for one intent and writes the generated files to tmp/live/.
// Unlike run-golden-path.ts (deterministic template pipeline), this exercises the
// actual LLM codegen path the extension uses.
//
// Prereqs:
//   1. mpyhw-api running (mpyhw-api/scripts/serve.ps1) with DEEPSEEK_API_KEY set.
//   2. MPYHW_DEV_JWT = a dev session token. Mint it (dev secret) from mpyhw-api/:
//      python -c "from app import session_token; print(session_token.encode({'sub':'dev','login':'dev'}, 'dev-insecure-secret', 86400))"
//
// Usage: npm run live-gen -- "your intent here"
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createAgentBackedLoop } from "../core/agent-backed-loop.ts";

const intent = process.argv.slice(2).join(" ") || "ESP32-S3：每 2 秒读 AHT20 温湿度并显示在 SSD1306 OLED 上";
const apiBaseUrl = (process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
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

const loop = createAgentBackedLoop({ apiBaseUrl, getAuthToken: async () => jwt });

const files: Record<string, string> = {};
let manifest: any;
let lastPhase = "";

let result: any;
try {
  result = await loop({
    intent,
    boardId: "auto",
    availableBoards,
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
}

console.log(`\nterminal: ${result?.terminal ?? "(none)"}`);

const outDir = join("tmp", "live");
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
