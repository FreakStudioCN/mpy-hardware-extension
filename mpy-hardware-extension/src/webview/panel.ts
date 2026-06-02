import { readFileSync } from "node:fs";

import { SessionController } from "../extension/session-controller.ts";
import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { runPipeline } from "../core/pipeline.ts";
import { createAgentBackedLoop } from "../core/agent-backed-loop.ts";
import { createDeviceShim } from "../extension/device-shim.ts";

type PanelDeps = { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template" };

// Open the UI as an editor-area tab. Kept for the mpyhw.openPanel command and
// existing tests; the docked sidebar uses createViewProvider below.
export function createPanel(vscode: any, extensionUri: any, deps: PanelDeps = {}) {
  const panel = vscode.window.createWebviewPanel("mpyhw", "MPY Hardware", vscode.ViewColumn.One, { enableScripts: true });
  wireWebview(vscode, panel.webview, extensionUri, deps);
  return panel;
}

// WebviewViewProvider so the UI docks as a side-bar view (activity-bar container)
// instead of an editor tab. The user can drag it to the secondary (right) sidebar.
export function createViewProvider(vscode: any, extensionUri: any, deps: PanelDeps = {}) {
  return {
    resolveWebviewView(view: any) {
      view.webview.options = { enableScripts: true };
      wireWebview(vscode, view.webview, extensionUri, deps);
    },
  };
}

// Shared wiring: inject HTML, drive a SessionController, route inbound messages.
// Works for any webview host (panel.webview or view.webview).
function wireWebview(vscode: any, webview: any, extensionUri: any, deps: PanelDeps) {
  const html = readWebviewHtml();
  webview.html = html.replaceAll("${webviewCspSource}", webview.cspSource ?? "");
  const apiBaseUrl = (deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Real device shim (Python serve.py). Lazy: nothing spawns until the agent
  // actually touches a device. Tests can inject deps.shim to bypass it.
  const shim = deps.shim ?? createDeviceShim({ vscode, extensionUri });
  let availableBoards: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => webview.postMessage(message),
    confirmTool: async (tool) => {
      const choice = await vscode.window.showWarningMessage(`Allow ${tool.name}?`, "Allow", "Cancel");
      return choice === "Allow";
    },
    loop: createLoop({ ...deps, shim }),
  });
  webview.onDidReceiveMessage(async (message: any) => {
    if (message.type === "request_boards") {
      // Real device/board list comes from the API — never hardcoded in the UI.
      try {
        const res = await fetchImpl(`${apiBaseUrl}/v1/boards`);
        const body: any = await res.json();
        const boards = [...(body.builtin ?? []), ...(body.community ?? [])];
        availableBoards = boards;
        webview.postMessage({ type: "boards", boards });
      } catch {
        webview.postMessage({ type: "boards", boards: [] });
      }
      try {
        const qr = await fetchImpl(`${apiBaseUrl}/v1/quota`, { headers: { "x-quota-used": "0" } });
        const q: any = await qr.json();
        webview.postMessage({ type: "session_event", event: { kind: "quota", used: q.used, limit: q.limit } });
      } catch {
        // quota unavailable — webview leaves the bar hidden
      }
    }
    if (message.type === "start_session") {
      await controller.start({ intent: message.intent, boardId: message.boardId, availableBoards });
    }
    if (message.type === "ui_prompt_response") {
      controller.resolvePrompt(message.promptId, message.answer);
    }
    if (message.type === "cancel_session") {
      controller.cancel();
      webview.postMessage({ type: "session_done", terminal: "cancelled" });
    }
  });
}

// Default to the real LLM-driven agent loop. The deterministic template
// pipeline stays available via MPYHW_LOOP=template for offline/no-key demos.
function createLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template" }) {
  const mode = deps.loopMode ?? process.env.MPYHW_LOOP;
  if (mode === "template") {
    return createApiPipelineLoop(deps);
  }
  return createAgentBackedLoop(deps);
}

function readWebviewHtml(): string {
  // Dev/test runs this module directly (import.meta.url -> src/webview/), so
  // "./index.html" resolves. The bundled entry lives at dist/extension/, where
  // the packaged html sits at ../../src/webview/index.html. Try both.
  const candidates = ["./index.html", "../../src/webview/index.html"];
  for (const candidate of candidates) {
    try {
      return readFileSync(new URL(candidate, import.meta.url), "utf-8");
    } catch {
      // try next candidate
    }
  }
  throw new Error("webview_html_not_found");
}

function createApiPipelineLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch }) {
  const apiBaseUrl = deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787";
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async function apiPipelineLoop(input: { intent: string; boardId: string; onEvent: (event: any) => void }) {
    input.onEvent({ type: "trace", text: `API pipeline started: ${input.intent}` });
    const result = await runPipeline({
      intent: input.intent,
      board_id: input.boardId,
      packageClient: new PackageClient(apiBaseUrl, fetchImpl),
      boardClient: new BoardClient(apiBaseUrl, fetchImpl),
    });
    if (!result.ok) {
      input.onEvent({ type: "trace", text: `API pipeline failed: ${result.error}` });
      return { terminal: result.error };
    }
    input.onEvent({ type: "manifest_updated", manifest: result.manifest });
    input.onEvent({ type: "code_updated", code: result.files["main.py"] });
    input.onEvent({ type: "trace", text: "API pipeline generated main.py and manifest.json" });
    return { terminal: "generated", files: result.files, manifest: result.manifest };
  };
}
