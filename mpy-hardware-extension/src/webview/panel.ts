import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { SessionController } from "../extension/session-controller.ts";
import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { ApiClient } from "../core/api-client.ts";
import { runPipeline } from "../core/pipeline.ts";
import { GEN_DRIVER_TABS, validateFields, buildSourceFromFields } from "../core/gen-driver-schema.ts";
import { DEV_API_BASE_URL } from "../core/config.ts";
import { createProtocolLoop } from "../core/protocol-build.ts";
import { PROTOCOL_VERSION } from "../core/protocol-registry.ts";
import { createDeviceShim, detectPython, venvReady, installVenvAsync } from "../extension/device-shim.ts";
import { runDoctor } from "../extension/doctor.ts";
import { CloudTelemetryRecorder, CompositeSessionRecorder, JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { createGithubAuth } from "../extension/github-auth.ts";
import { BUNDLED_TOOLCHAIN_VERSION, toolchainOutdated } from "../core/toolchain-version.ts";
import { writeGeneratedFiles, writeProjectFile } from "../extension/workspace-writer.ts";
import { resolveApiBaseUrl } from "../extension/api-base-url.ts";

type PanelDeps = { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; log?: (message: string) => void; globalStoragePath?: string; onWebviewReady?: (webview: any) => void };

const execFileAsync = promisify(execFile);

async function ensureProjectGitRepo(projectFolder?: string, log?: (message: string) => void) {
  if (!projectFolder) return;
  try {
    await mkdir(projectFolder, { recursive: true });
    if (!existsSync(join(projectFolder, ".git"))) {
      await execFileAsync("git", ["-C", projectFolder, "init", "-q"], { windowsHide: true });
    }
    await ensureGitConfig(projectFolder, "user.email", "blockless@local");
    await ensureGitConfig(projectFolder, "user.name", "Blockless");
  } catch (error: any) {
    log?.(`Blockless: project git init skipped: ${error?.message ?? error}`);
  }
}

async function ensureGitConfig(projectFolder: string, key: string, value: string) {
  try {
    await execFileAsync("git", ["-C", projectFolder, "config", "--get", key], { windowsHide: true });
  } catch {
    await execFileAsync("git", ["-C", projectFolder, "config", key, value], { windowsHide: true });
  }
}

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
  deps.onWebviewReady?.(webview);
  const apiBaseUrl = resolveApiBaseUrl(vscode, deps.apiBaseUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Real device shim (Python serve.py). Lazy: nothing spawns until the agent
  // actually touches a device. Tests can inject deps.shim to bypass it.
  const shim = deps.shim ?? createDeviceShim({ vscode, extensionUri });
  const auth = createGithubAuth({ vscode, apiBaseUrl, fetchImpl, log: deps.log });
  const workspaceFolder = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  // Project output goes into a dedicated subfolder (see PROJECT_SUBDIR); session
  // trace logs stay at the workspace root under .mpyhw, not mixed into the project.
  // With no workspace open, fall back to the extension's guaranteed-writable
  // globalStorage dir (never process.cwd(), which may be System32/Program Files
  // → EPERM, or an unfindable hidden dir). usingFallback drives the "saved here"
  // notice so the user can find their project.
  const fallbackRoot = deps.globalStoragePath ? join(deps.globalStoragePath, PROJECT_SUBDIR) : undefined;
  const projectFolder = workspaceFolder ? join(workspaceFolder, PROJECT_SUBDIR) : fallbackRoot;
  const usingFallback = !workspaceFolder && !!fallbackRoot;
  let availableBoards: any[] = [];
  let toolchainChecked = false;
  const recorderFactory = workspaceFolder || vscode.authentication
    ? (traceId: string) => {
      const recorders = [];
      if (workspaceFolder) recorders.push(new JsonlSessionRecorder({ workspaceFolder, traceId }));
      if (vscode.authentication) recorders.push(new CloudTelemetryRecorder({ traceId, apiBaseUrl, fetchImpl, getAuthToken: () => auth.getToken(false), log: deps.log }));
      return recorders.length === 1 ? recorders[0] : new CompositeSessionRecorder(recorders);
    }
    : undefined;
  const controller = new SessionController({
    postMessage: (message) => webview.postMessage(message),
    loop: createLoop({ ...deps, apiBaseUrl, shim, getAuthToken: () => auth.getToken(false), readWorkspaceFile: makeWorkspaceReader(projectFolder), writeProjectFile: makeWorkspaceWriter(projectFolder), listFiles: makeWorkspaceLister(projectFolder), makeProjectDir: makeWorkspaceMkdir(projectFolder), deleteProjectPath: makeWorkspaceDeleter(projectFolder), projectRoot: projectFolder }),
    recorderFactory,
    writeFiles: async (files) => {
      if (!projectFolder) return { ok: false, error_kind: "workspace_unavailable" };
      const result = await writeGeneratedFiles({
        workspaceFolder: projectFolder,
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
        // No workspace open → files went to the globalStorage fallback. Tell the
        // user where, with a one-click "reveal in file manager" so it's findable.
        if (usingFallback) {
          webview.postMessage({ type: "session_event", event: { kind: "saved_location", path: projectFolder } });
        }
      }
      return result;
    },
  });
  webview.onDidReceiveMessage(async (message: any) => {
    if (message.type === "request_gen_driver_config") {
      // The panel renders its input tabs from the schema module (single source of truth).
      webview.postMessage({ type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
      return;
    }
    if (message.type === "start_gen_driver") {
      // Validate + assemble the source from the schema (the source of truth). The
      // global-tools entry is standalone; pipeline is chosen from the manifest when
      // the session-controller drives the loop. ponytail: start_phase dispatch/run is Day 6/8.
      const tab = GEN_DRIVER_TABS.find((t) => t.id === message.tabId);
      const values = message.values ?? {};
      const missing = tab ? validateFields(tab, values) : [];
      if (missing.length) {
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: `Missing required: ${missing.join(", ")}` });
        return;
      }
      const source = tab ? buildSourceFromFields(tab, values) : null;
      const mode = source?.type === "current_cold_driver_item" ? "pipeline" : "standalone";
      webview.postMessage({
        type: "gen_driver_status",
        detail: `Received ${source?.type ?? "request"} (mode=${mode}). Driver generation run is wired in a later step.`,
      });
      return;
    }
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
        const res = await fetchImpl(`${apiBaseUrl}/v1/micropython/boards`);
        const body: any = await res.json();
        webview.postMessage({ type: "micropython_boards", ...body });
      } catch {
        webview.postMessage({ type: "micropython_boards", boards: [], filters: {}, stale: true });
      }
      // Surface whether this backend runs the real LLM or the deterministic stub.
      // The stub returns a fixed reply and never thinks, so without this the UI
      // can't tell a stub instance from a hang. Best-effort: a server that doesn't
      // report a mode leaves the badge hidden (assumed live).
      try {
        const res = await fetchImpl(`${apiBaseUrl}/v1/health`);
        const body: any = await res.json();
        webview.postMessage({ type: "server_mode", mode: body?.mode === "stub" ? "stub" : "live" });
      } catch {
        // health unreachable — leave the badge hidden
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
      const registry = await checkProtocolVersion(apiBaseUrl, fetchImpl);
      if (registry.warning === "protocol_version_mismatch") {
        webview.postMessage({ type: "session_error", error: "protocol_version_mismatch" });
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
      await ensureProjectGitRepo(projectFolder, deps.log);
      await controller.start({
        intent: message.intent,
        boardId: message.boardId,
        availableBoards,
        preSelectedBoard: message.pre_selected_board ?? undefined,
        preferences: { ...(message.preferences ?? {}), locale: vscode.env?.language },
      });
    }
    if (message.type === "retry_session") {
      // Manual retry after a transport failure (the webview's Retry button).
      // Re-run the auth gate with a forced refresh first: an expired token is
      // itself one of the failure modes a long session can die on.
      if (vscode.authentication) {
        const jwt = await auth.getToken(true, { forceRefresh: true });
        if (!jwt) {
          webview.postMessage({ type: "session_error", error: auth.getLastError() ?? "sign_in_required" });
          webview.postMessage({ type: "session_done", terminal: "session_error" });
          return;
        }
      }
      await controller.retry();
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
    if (message.type === "run_doctor_check" || message.type === "doctor_action") {
      // Environment preflight for the Doctor tab. "install_deps" runs the async (non-
      // blocking) venv installer first; every action then re-runs the same checks and
      // posts the fresh structured results. detectPython/venvReady are host-side probes
      // bound here; scan/probe drive the shim (runDoctor skips them until deps are ready).
      if (message.type === "doctor_action" && message.action === "install_deps") {
        await installVenvAsync({ vscode, extensionUri });
      }
      const items = await runDoctor({
        detectPython: () => detectPython(vscode),
        venvReady,
        scan: () => shim.scan(),
        probeMicroPython: (port: string) => shim.probeMicroPython(port),
      }, { probe: message.probe === true }); // probe only on an explicit Re-check — it interrupts a running board
      webview.postMessage({ type: "doctor_results", items });
    }
    if (message.type === "open_path" && typeof message.path === "string") {
      // Reveal the fallback project folder in the OS file manager so the user can
      // find code generated when no workspace was open. Best-effort.
      try {
        await vscode.commands?.executeCommand?.("revealFileInOS", vscode.Uri.file(message.path));
      } catch {
        // command/Uri unavailable (e.g. headless host) — ignore
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
      // rides along on a component-confirm so the host knows the kept parts. The
      // protocol approval card also rides selected_ids/text_values/added_items here,
      // which confirmApproval unpacks into the approval_response.
      controller.resolvePrompt(message.promptId, message.answer, { feedback: message.feedback, devices: message.devices, selected_ids: message.selected_ids, text_values: message.text_values, added_items: message.added_items });
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

async function checkProtocolVersion(apiBaseUrl: string, fetchImpl: typeof fetch) {
  try {
    return await new ApiClient(apiBaseUrl, fetchImpl).checkProtocolVersion(PROTOCOL_VERSION);
  } catch {
    // Reachability problems surface elsewhere (auth/credits/health); a failed skew
    // check must not block the session.
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
function createLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; getAuthToken?: () => Promise<string | undefined>; readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>; writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>; listFiles?: (path: string) => Promise<{ ok: boolean; entries?: string[]; error_kind?: string }>; makeProjectDir?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>; deleteProjectPath?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>; projectRoot?: string }) {
  const mode = deps.loopMode ?? process.env.MPYHW_LOOP;
  if (mode === "template") {
    return createApiPipelineLoop(deps);
  }
  // Protocol path: the server drives via the 7-message plugin-interface, the
  // extension is the dumb executor. The protocol loop is the only agent path;
  // the deterministic template pipeline (MPYHW_LOOP=template) remains for offline/no-key demos and tests.
  return createProtocolLoop(deps);
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
// (mkdir -p + writeFile). Returns undefined when there is no project root (mirrors
// makeWorkspaceReader) so write_project_file reports workspace_unavailable instead
// of writing somewhere unfindable; the caller passes a globalStorage fallback root.
function makeWorkspaceWriter(workspaceFolder?: string) {
  if (!workspaceFolder) return undefined;
  return (relPath: string, content: string) =>
    writeProjectFile({
      workspaceFolder,
      path: relPath,
      content,
      writeFile: async (path, fileContent) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, fileContent, "utf-8");
      },
    });
}

// file_operation(list) backing: lists the project tree (relative POSIX paths, dirs
// suffixed with "/") so the model can introspect what scaffold already wrote and not
// wrongly conclude the project is empty. Same containment as makeWorkspaceReader.
function makeWorkspaceLister(workspaceFolder?: string) {
  if (!workspaceFolder) return undefined;
  const root = resolve(workspaceFolder);
  return async (relPath: string) => {
    const base = relPath ? resolve(root, relPath) : root;
    if (base !== root && !base.startsWith(root + sep)) {
      return { ok: false as const, error_kind: "path_outside_workspace" };
    }
    const entries: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(dir, name);
        const rel = full.slice(root.length + 1).split(sep).join("/");
        if (statSync(full).isDirectory()) { entries.push(rel + "/"); walk(full); }
        else entries.push(rel);
      }
    };
    try { walk(base); return { ok: true as const, entries }; }
    catch { return { ok: false as const, error_kind: "not_found" }; }
  };
}

// file_operation(mkdir) backing: creates a project-tree directory (recursive).
// Same containment as makeWorkspaceReader — a path escaping the root is refused.
function makeWorkspaceMkdir(workspaceFolder?: string) {
  if (!workspaceFolder) return undefined;
  const root = resolve(workspaceFolder);
  return async (relPath: string) => {
    const target = resolve(root, relPath);
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false as const, error_kind: "path_outside_workspace" };
    }
    try { await mkdir(target, { recursive: true }); return { ok: true as const }; }
    catch { return { ok: false as const, error_kind: "mkdir_failed" }; }
  };
}

// file_operation(delete) backing: removes a project-tree path (recursive). The
// generate phase deletes firmware/tools/ before the mpy_imports gate. Containment
// refuses anything outside the root AND the root itself (never wipe the workspace).
// force:true makes "delete an already-absent path" succeed — the desired end-state
// (path gone) holds — which is not a fake success.
function makeWorkspaceDeleter(workspaceFolder?: string) {
  if (!workspaceFolder) return undefined;
  const root = resolve(workspaceFolder);
  return async (relPath: string) => {
    const target = resolve(root, relPath);
    if (target === root || !target.startsWith(root + sep)) {
      return { ok: false as const, error_kind: "path_outside_workspace" };
    }
    try { await rm(target, { recursive: true, force: true }); return { ok: true as const }; }
    catch { return { ok: false as const, error_kind: "delete_failed" }; }
  };
}

function readWebviewHtml(): string {
  // Dev/test runs this module directly (import.meta.url -> src/webview/), so
  // "./index.html" resolves. The bundled entry lives at dist/extension/, where
  // the packaged files sit at ../../src/webview/. Try both. The css/js live in
  // sibling files (Phase B split) and are inlined here so the webview still
  // receives a single self-contained HTML string.
  const candidates = ["./", "../../src/webview/"];
  for (const base of candidates) {
    try {
      const html = readFileSync(new URL(base + "index.html", import.meta.url), "utf-8");
      const css = readFileSync(new URL(base + "webview.css", import.meta.url), "utf-8");
      const js = readFileSync(new URL(base + "webview.js", import.meta.url), "utf-8");
      return html.replace("/*__WEBVIEW_CSS__*/", () => css).replace("//__WEBVIEW_JS__", () => js);
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
