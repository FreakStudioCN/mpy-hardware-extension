import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { SessionController } from "../extension/session-controller.ts";
import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { ApiClient } from "../core/api-client.ts";
import { runPipeline } from "../core/pipeline.ts";
import { createAgentBackedLoop, DEV_API_BASE_URL } from "../core/agent-backed-loop.ts";
import { createDeviceShim } from "../extension/device-shim.ts";
import { JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { createGithubAuth } from "../extension/github-auth.ts";
import { CANONICAL_TOOLS } from "../core/tool-registry.ts";
import { BUNDLED_TOOLCHAIN_VERSION, toolchainOutdated } from "../core/toolchain-version.ts";
import { writeGeneratedFiles, writeProjectFile } from "../extension/workspace-writer.ts";
import { resolveApiBaseUrl } from "../extension/api-base-url.ts";

type PanelDeps = { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; log?: (message: string) => void };

// All generation output is contained under <workspace>/<PROJECT_SUBDIR>, never the
// workspace root. The scaffold (init_scaffold.py) writes README.md/LICENSE/.flake8
// and the firmware/ tree straight into its project_dir with no overwrite check, so
// pointing it at the open workspace root would clobber those files (e.g. when the
// dev repo itself is the open folder). A dedicated subfolder makes that impossible.
const PROJECT_SUBDIR = "blockless-project";

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
  const apiBaseUrl = resolveApiBaseUrl(vscode, deps.apiBaseUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Real device shim (Python serve.py). Lazy: nothing spawns until the agent
  // actually touches a device. Tests can inject deps.shim to bypass it.
  const shim = deps.shim ?? createDeviceShim({ vscode, extensionUri });
  const auth = createGithubAuth({ vscode, apiBaseUrl, fetchImpl, log: deps.log });
  const workspaceFolder = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  // Project output goes into a dedicated subfolder (see PROJECT_SUBDIR); session
  // trace logs stay at the workspace root under .mpyhw, not mixed into the project.
  const projectFolder = workspaceFolder ? join(workspaceFolder, PROJECT_SUBDIR) : undefined;
  let availableBoards: any[] = [];
  let toolchainChecked = false;
  const controller = new SessionController({
    postMessage: (message) => webview.postMessage(message),
    loop: createLoop({ ...deps, apiBaseUrl, shim, getAuthToken: () => auth.getToken(false), readWorkspaceFile: makeWorkspaceReader(projectFolder), writeProjectFile: makeWorkspaceWriter(projectFolder), projectRoot: projectFolder }),
    recorderFactory: workspaceFolder ? (traceId) => new JsonlSessionRecorder({ workspaceFolder, traceId }) : undefined,
    writeFiles: async (files) => {
      const result = await writeGeneratedFiles({
        workspaceFolder: projectFolder,
        generatedRoot: projectFolder ? undefined : join(process.cwd(), ".mpyhw", "generated"),
        files,
        exists: async (path) => existsSync(path),
        writeFile: async (path, content) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, "utf-8");
        },
        confirmOverwrite: async (path) => (await vscode.window.showWarningMessage(`Overwrite ${path}?`, "Overwrite", "Cancel")) === "Overwrite",
      });
      // Land the user on the real file: the generated code now lives in the
      // workspace (not an in-panel preview), so open main.py in the editor.
      if (result?.ok) {
        const mainPath = (result.paths ?? []).find((p: string) => p.endsWith("/main.py"));
        if (mainPath && vscode.workspace?.openTextDocument) {
          try {
            const doc = await vscode.workspace.openTextDocument(mainPath);
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch {
            // opening the editor is a nicety; ignore failures (e.g. headless host)
          }
        }
      }
      return result;
    },
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
      // Non-blocking toolchain skew check (once per window): if the live API expects
      // a newer toolchain than this VSIX bundles, the frozen scaffold/wiring scripts
      // may be off-contract. Fire-and-forget so it never adds a round-trip to
      // time-to-first-token; warn (once) if the server advertises a newer toolchain.
      if (!toolchainChecked) {
        toolchainChecked = true;
        void fetchToolchainVersion(apiBaseUrl, fetchImpl).then((serverToolchain) => {
          if (toolchainOutdated(serverToolchain)) {
            vscode.window?.showWarningMessage?.(
              `Blockless: your extension's bundled toolchain (v${BUNDLED_TOOLCHAIN_VERSION}) is older than the server's (v${serverToolchain}). Update the extension to avoid scaffold/wiring errors.`,
            );
          }
        });
      }
      // Login up front: a real VS Code host must have a GitHub session before the
      // metered loop runs. Headless/test hosts (no vscode.authentication) skip this.
      if (vscode.authentication) {
        const jwt = await auth.getToken(true, { forceRefresh: true });
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
        // The deploy card may already have picked a port; honor it and skip the
        // quickpick. Otherwise auto-pick the only one, or prompt for a choice.
        const port = (message.port && ports.includes(message.port)) ? message.port
          : ports.length === 1 ? ports[0]
          : await vscode.window.showQuickPick?.(ports, { placeHolder: "Select MicroPython device" });
        if (!port) return;
        shim.setPort?.(port);
        webview.postMessage({ type: "device_selected", port });
      } catch (error: any) {
        webview.postMessage({ type: "session_error", error: error?.message ?? "device_scan_failed" });
      }
    }
    if (message.type === "deploy_rescan") {
      // Board-connection check for the deploy checkpoint. Reports the live port
      // list back to the card; an empty list keeps the Deploy button disabled.
      try {
        webview.postMessage({ type: "deploy_ports_updated", ports: await shim.scan() });
      } catch {
        webview.postMessage({ type: "deploy_ports_updated", ports: [] });
      }
    }
    if (message.type === "copy_code") {
      // Copy the code card's source to the clipboard via the host (reliable in the
      // webview sandbox). Best-effort: a host without clipboard access is a no-op.
      try {
        await vscode.env?.clipboard?.writeText?.(String(message.text ?? ""));
      } catch {
        // clipboard unavailable (e.g. headless host) — ignore
      }
    }
    if (message.type === "ui_prompt_response") {
      // Set the deploy port (if the response carries one) before resolving, so the
      // agent's first device tool always sees the chosen port — no select_device race.
      if (message.answer === "confirm" && message.port) shim.setPort?.(message.port);
      // `feedback` rides along on a plan "revise" so the agent can re-plan; `devices`
      // rides along on a component-confirm so the host knows the kept parts.
      controller.resolvePrompt(message.promptId, message.answer, { feedback: message.feedback, devices: message.devices });
    }
    if (message.type === "cancel_session") {
      controller.cancel();
      webview.postMessage({ type: "session_done", terminal: "cancelled" });
    }
    if (message.type === "reset_session") {
      // Drop the accumulated conversation so the next request starts a brand-new
      // build instead of continuing this one. The webview clears its own feed
      // optimistically; this just resets the controller's durable state.
      controller.reset();
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

async function fetchToolchainVersion(apiBaseUrl: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/v1/skills`);
    if (!res.ok) return undefined;
    const body: any = await res.json();
    return body?.toolchain_version;
  } catch {
    return undefined;
  }
}

// Default to the real LLM-driven agent loop. The deterministic template
// pipeline stays available via MPYHW_LOOP=template for offline/no-key demos.
function createLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; getAuthToken?: () => Promise<string | undefined>; readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>; writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>; projectRoot?: string }) {
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

// write_project_file backing: writes a project-tree file (project-manifest.json +
// firmware/ + test/) relative to the workspace root. Path safety (allowed-path set
// + containment) lives in writeProjectFile; this only supplies the real fs writer
// (mkdir -p + writeFile). Falls back to .mpyhw/generated when there is no
// workspace folder, mirroring the post-loop writeGeneratedFiles fallback.
function makeWorkspaceWriter(workspaceFolder?: string) {
  const generatedRoot = workspaceFolder ? undefined : join(process.cwd(), ".mpyhw", "generated");
  return (relPath: string, content: string) =>
    writeProjectFile({
      workspaceFolder,
      generatedRoot,
      path: relPath,
      content,
      writeFile: async (path, fileContent) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, fileContent, "utf-8");
      },
    });
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
  const apiBaseUrl = deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? DEV_API_BASE_URL;
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
