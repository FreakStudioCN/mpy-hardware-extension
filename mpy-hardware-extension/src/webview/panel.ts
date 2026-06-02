import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { SessionController } from "../extension/session-controller.ts";
import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { ApiClient } from "../core/api-client.ts";
import { runPipeline } from "../core/pipeline.ts";
import { createAgentBackedLoop } from "../core/agent-backed-loop.ts";
import { createDeviceShim } from "../extension/device-shim.ts";
import { JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { createGithubAuth } from "../extension/github-auth.ts";
import { CANONICAL_TOOLS } from "../core/tool-registry.ts";
import { writeGeneratedFiles } from "../extension/workspace-writer.ts";

type PanelDeps = { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; log?: (message: string) => void };

// Open the UI as an editor-area tab. Kept for the mpyhw.openPanel command and
// existing tests; the docked sidebar uses createViewProvider below.
export function createPanel(vscode: any, extensionUri: any, deps: PanelDeps = {}) {
  const panel = vscode.window.createWebviewPanel("mpyhw", "Blockless", vscode.ViewColumn.One, { enableScripts: true });
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
  const auth = createGithubAuth({ vscode, apiBaseUrl, fetchImpl, log: deps.log });
  const workspaceFolder = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  let availableBoards: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => webview.postMessage(message),
    confirmTool: async (tool) => {
      const choice = await vscode.window.showWarningMessage(`Allow ${tool.name}?`, "Allow", "Cancel");
      return choice === "Allow";
    },
    loop: createLoop({ ...deps, shim, getAuthToken: () => auth.getToken(false), readWorkspaceFile: makeWorkspaceReader(workspaceFolder) }),
    recorderFactory: workspaceFolder ? (traceId) => new JsonlSessionRecorder({ workspaceFolder, traceId }) : undefined,
    writeFiles: async (files) => writeGeneratedFiles({
      workspaceFolder,
      generatedRoot: workspaceFolder ? undefined : join(process.cwd(), ".mpyhw", "generated"),
      files,
      exists: async (path) => existsSync(path),
      writeFile: async (path, content) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf-8");
      },
      confirmOverwrite: async (path) => (await vscode.window.showWarningMessage(`Overwrite ${path}?`, "Overwrite", "Cancel")) === "Overwrite",
    }),
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
      // Credit balance for the bar. Only meaningful once signed in; silent auth
      // never prompts, so a signed-out user just leaves the bar hidden.
      if (vscode.authentication) {
        try {
          const jwt = await auth.getToken(false);
          if (jwt) {
            const cr = await fetchImpl(`${apiBaseUrl}/v1/credits`, { headers: { authorization: `Bearer ${jwt}` } });
            const c: any = await cr.json();
            webview.postMessage({ type: "session_event", event: { kind: "credits", balance: c.balance, dailyGrant: c.daily_grant, resetsAt: c.resets_at } });
          }
        } catch {
          // credits unavailable — webview leaves the bar hidden
        }
      }
    }
    if (message.type === "start_session") {
      const registry = await checkToolRegistry(apiBaseUrl, fetchImpl);
      if (registry.warning === "tool_registry_mismatch") {
        webview.postMessage({ type: "session_error", error: "tool_registry_mismatch" });
        webview.postMessage({ type: "session_done", terminal: "session_error" });
        return;
      }
      // Login up front: a real VS Code host must have a GitHub session before the
      // metered loop runs. Headless/test hosts (no vscode.authentication) skip this.
      if (vscode.authentication) {
        const jwt = await auth.getToken(true);
        if (!jwt) {
          webview.postMessage({ type: "session_error", error: auth.getLastError() ?? "sign_in_required" });
          webview.postMessage({ type: "session_done", terminal: "session_error" });
          return;
        }
      }
      await controller.start({ intent: message.intent, boardId: message.boardId, availableBoards });
    }
    if (message.type === "select_device") {
      try {
        const ports = await shim.scan();
        if (!ports.length) {
          webview.postMessage({ type: "session_error", error: "device_unavailable" });
          return;
        }
        const port = ports.length === 1 ? ports[0] : await vscode.window.showQuickPick?.(ports, { placeHolder: "Select MicroPython device" });
        if (!port) return;
        shim.setPort?.(port);
        webview.postMessage({ type: "device_selected", port });
      } catch (error: any) {
        webview.postMessage({ type: "session_error", error: error?.message ?? "device_scan_failed" });
      }
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

async function checkToolRegistry(apiBaseUrl: string, fetchImpl: typeof fetch) {
  try {
    return await new ApiClient(apiBaseUrl, fetchImpl).checkToolRegistry(CANONICAL_TOOLS);
  } catch {
    return { ok: true };
  }
}

// Default to the real LLM-driven agent loop. The deterministic template
// pipeline stays available via MPYHW_LOOP=template for offline/no-key demos.
function createLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; getAuthToken?: () => Promise<string | undefined>; readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }> }) {
  const mode = deps.loopMode ?? process.env.MPYHW_LOOP;
  if (mode === "template") {
    return createApiPipelineLoop(deps);
  }
  return createAgentBackedLoop(deps);
}

// read_workspace_file backing: reads a workspace-relative file, refusing any path
// that escapes the workspace root (path containment is the host's responsibility,
// mirroring the future run_host_tool design). Returns undefined reader when there
// is no workspace folder, so the loop reports workspace_unavailable.
function makeWorkspaceReader(workspaceFolder?: string) {
  if (!workspaceFolder) return undefined;
  const root = resolve(workspaceFolder);
  return async (relPath: string) => {
    const target = resolve(root, relPath);
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false as const, error_kind: "path_outside_workspace" };
    }
    try {
      return { ok: true as const, content: readFileSync(target, "utf-8") };
    } catch {
      return { ok: false as const, error_kind: "file_not_found" };
    }
  };
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
    if (!result.ok || !result.files) {
      input.onEvent({ type: "trace", text: `API pipeline failed: ${result.error}` });
      return { terminal: result.error ?? "pipeline_failed" };
    }
    input.onEvent({ type: "manifest_updated", manifest: result.manifest });
    input.onEvent({ type: "code_updated", code: result.files["main.py"] });
    input.onEvent({ type: "trace", text: "API pipeline generated main.py and manifest.json" });
    return { terminal: "generated", files: result.files, manifest: result.manifest };
  };
}
