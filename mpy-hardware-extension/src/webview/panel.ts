import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { SessionController } from "../extension/session-controller.ts";
import { listRecentSessions, sessionsDir } from "../extension/session-recorder.ts";
import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { ApiClient } from "../core/api-client.ts";
import { runPipeline } from "../core/pipeline.ts";
import { GEN_DRIVER_TABS, canStartGeneration } from "../core/gen-driver-schema.ts";
import { SUPPORT_CONTACTS, SUPPORT_DIAGNOSTICS_FIELDS, buildDiagnosticsFields, orderContactsByLocale } from "../core/support-config.ts";
import { PARTNERS } from "../core/partner-config.ts";
import { DEV_API_BASE_URL } from "../core/config.ts";
import { createProtocolLoop } from "../core/protocol-build.ts";
import { PROTOCOL_VERSION } from "../core/protocol-registry.ts";
import { createDeviceShim, detectPython, venvReady, venvMpremoteVersion, installVenvAsync } from "../extension/device-shim.ts";
import { runDoctor } from "../extension/doctor.ts";
import { CloudTelemetryRecorder, CompositeSessionRecorder, JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { createGithubAuth } from "../extension/github-auth.ts";
import { BUNDLED_TOOLCHAIN_VERSION, EXTENSION_VERSION, toolchainOutdated } from "../core/toolchain-version.ts";
import { deleteProjectPath, writeGeneratedFiles, writeProjectFile } from "../extension/workspace-writer.ts";
import { artifactOpenAction, buildArtifactIndex, classifyArtifactKind, resolveArtifactPath, resolveContainedArtifactPath, toRelativeDisplayPath } from "../extension/artifact-index.ts";
import type { Artifact, ArtifactSource } from "../extension/artifact-index.ts";
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

// Best-effort tool version (`npm --version`, `mpremote --version`); first line, short
// timeout, never throws — a headless/missing tool yields "unknown".
const DIAGNOSTICS_EXEC_TIMEOUT_MS = 2000;
function tryExecVersion(cmd: string, args: string[]): string {
  try {
    // On Windows these tools are usually `.cmd`/`.bat` shims (e.g. npm.cmd); execFileSync
    // without a shell can't launch them (EPERM), so the field would read "unknown" even
    // when installed. Run through the shell on Windows — args here are fixed literals, so
    // there is no injection surface. Matches baseline.mjs's `shell: isWin` convention.
    const out = execFileSync(cmd, args, { timeout: DIAGNOSTICS_EXEC_TIMEOUT_MS, windowsHide: true, shell: process.platform === "win32" }).toString();
    return out.trim().split("\n")[0] || "unknown";
  } catch {
    return "unknown"; // tool not installed / not on PATH / headless
  }
}

// The MicroPython_Skills submodule commit. In a packaged VSIX this is baked at build
// time (esbuild define, build-extension.mjs) and read from here — the installed extension
// has no .git. In a dev/CI checkout there is no baked value, so fall back to walking the
// cwd and its parents (package.json is nested one level under the repo root) for git.
function skillsSubmoduleCommit(): string {
  const baked = process.env.SKILLS_COMMIT; // replaced with the literal SHA in the bundle
  if (baked && baked !== "unknown") return baked;
  for (const root of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    const dir = join(root, "third_party", "MicroPython_Skills");
    if (!existsSync(dir)) continue;
    try {
      return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: DIAGNOSTICS_EXEC_TIMEOUT_MS, windowsHide: true }).toString().trim();
    } catch {
      // not a git checkout at this candidate — try the next
    }
  }
  return "unknown";
}

// The section-08 diagnostics snapshot: session-scoped fields (from the controller) merged
// with always-available host fields (versions, os/node/npm, python, mpremote). Emits every
// declared SUPPORT_DIAGNOSTICS_FIELDS key, in order, so a bug report is complete.
function collectDiagnostics(vscode: any, session: Record<string, string>): { text: string; fields: Record<string, string> } {
  let python = "unknown";
  try {
    const p = detectPython(vscode);
    python = p.ok ? (p.version ?? "found") : "not found";
  } catch {
    // detection failed (no python / headless) — leave "unknown"
  }
  const host: Record<string, string> = {
    plugin_version: BUNDLED_TOOLCHAIN_VERSION,
    extension_version: EXTENSION_VERSION,
    submodule_commit: skillsSubmoduleCommit(),
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    npm: tryExecVersion("npm", ["--version"]),
    python,
    mpremote: venvMpremoteVersion() ?? tryExecVersion("mpremote", ["--version"]),
  };
  return buildDiagnosticsFields({ ...session, ...host });
}

// How many past sessions the "View Recent Sessions" launch entry lists (newest first).
const RECENT_SESSIONS_LIMIT = 20;

// Maps a gen-driver file field's `accept` group to a vscode open-dialog filter.
const GEN_DRIVER_FILE_FILTERS: Record<string, Record<string, string[]>> = {
  pdf: { "PDF datasheet": ["pdf"] },
  arduino: { "Arduino / C / C++": ["ino", "c", "cpp", "cc", "h", "hpp"] },
  image: { Images: ["png", "jpg", "jpeg", "webp", "bmp"] },
};

// Artifact-file discovery on disk (spec §8.3: browse the project AND session trees). Lets a
// reopened/resumed panel show prior artifacts before any new build runs — the live session's
// producedPaths only cover what THIS session wrote. Bounded so a large tree can't stall.
const ARTIFACT_EXTS = new Set(["py", "json", "jsonl", "md", "svg", "png", "html", "log", "uf2", "bin"]);
const ARTIFACT_SCAN_MAX_FILES = 500;
const ARTIFACT_SCAN_MAX_DEPTH = 6;
// Breadth cap (#28 F5): a tree with no matching files never consumes the file budget, so an
// artifact-free but wide/deep tree could be walked in full. Cap total entries visited too.
const ARTIFACT_SCAN_MAX_ENTRIES = 5000;
function scanArtifactTree(root: string, origin: "session" | "disk"): ArtifactSource[] {
  const out: ArtifactSource[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && out.length < ARTIFACT_SCAN_MAX_FILES && visited < ARTIFACT_SCAN_MAX_ENTRIES) {
    const { dir, depth } = stack.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable dir — skip, not fatal
    for (const entry of entries) {
      // Enforce both caps INSIDE the loop (#28 F5): the while-condition alone lets a single
      // directory append far more than the budget before it is re-checked.
      if (out.length >= ARTIFACT_SCAN_MAX_FILES || visited >= ARTIFACT_SCAN_MAX_ENTRIES) break;
      visited++;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue; // hidden/vendor
      // Never index or descend a symlink (#28 F2): its target can live outside the root, and
      // stat/hash/open would follow it. isDirectory() is false for a file symlink, so without
      // this it would be indexed and openable as an out-of-tree file.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < ARTIFACT_SCAN_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
      if (ARTIFACT_EXTS.has(ext)) out.push({ absolute_path: full, kind: classifyArtifactKind(full), phase: "", origin });
    }
  }
  return out;
}

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
  // Start-of-run snapshot of the project tree (deliverables 07 §4): files present when a
  // build starts are the user's; anything created during the run (codegen output, build
  // scratch) is not in here, so overwriting/deleting it never prompts. Repopulated on each
  // start_session before the loop writes anything (see snapshotExistingPaths).
  const preExistingPaths = new Set<string>();
  const isPreExisting = (p: string) => preExistingPaths.has(resolve(p));
  const confirmOverwrite = async (target: string) =>
    (await vscode.window?.showWarningMessage?.(`Overwrite ${target}?`, "Overwrite", "Cancel")) === "Overwrite";
  const confirmDelete = async (target: string) =>
    (await vscode.window?.showWarningMessage?.(`Delete ${target}?`, "Delete", "Cancel")) === "Delete";
  // Let the webview load artifact images (svg/png) it references via asWebviewUri (task-03).
  // Roots cover the workspace (project + .mpyhw logs), the globalStorage fallback, and the
  // extension assets. Guarded: a headless/test host may not have vscode.Uri or settable options.
  if (vscode.Uri?.file) {
    const roots = [workspaceFolder, deps.globalStoragePath].filter(Boolean).map((p: string) => vscode.Uri.file(p));
    if (extensionUri) roots.push(extensionUri);
    try { webview.options = { ...(webview.options ?? {}), enableScripts: true, localResourceRoots: roots }; }
    catch { /* host without settable options — skip */ }
  }
  let availableBoards: any[] = [];
  let toolchainChecked = false;
  // Session logs live under <sessionRoot>/.mpyhw/sessions. Prefer the open workspace; fall back
  // to globalStorage so recording + Recent Sessions work with no folder open. Safe unlike the
  // shared blockless-project dir: session dirs are id-scoped (session-<id>/), so no collision.
  const sessionRoot = workspaceFolder ?? deps.globalStoragePath;
  const recorderFactory = sessionRoot || vscode.authentication
    ? (traceId: string) => {
      const recorders = [];
      if (sessionRoot) recorders.push(new JsonlSessionRecorder({ workspaceFolder: sessionRoot, traceId }));
      if (vscode.authentication) recorders.push(new CloudTelemetryRecorder({ traceId, apiBaseUrl, fetchImpl, getAuthToken: () => auth.getToken(false), log: deps.log }));
      return recorders.length === 1 ? recorders[0] : new CompositeSessionRecorder(recorders);
    }
    : undefined;
  const controller = new SessionController({
    // Relativize the files_written paths before they cross to the webview (#28 F3): the
    // controller carries absolute persisted paths, but §4.2 forbids a drive-letter path
    // reaching the UI (this message renders them in the activity feed). The Artifacts index
    // has its own relative paths; nothing downstream needs these absolute.
    postMessage: (message: any) => {
      if (message?.type === "files_written" && Array.isArray(message.paths)) {
        const root = workspaceFolder ?? deps.globalStoragePath ?? projectFolder ?? "";
        message = { ...message, paths: message.paths.map((p: string) => toRelativeDisplayPath(root, p)) };
      }
      webview.postMessage(message);
    },
    loop: createLoop({ ...deps, apiBaseUrl, shim, getAuthToken: () => auth.getToken(false), readWorkspaceFile: makeWorkspaceReader(projectFolder), writeProjectFile: makeWorkspaceWriter(projectFolder, isPreExisting, confirmOverwrite), listFiles: makeWorkspaceLister(projectFolder), makeProjectDir: makeWorkspaceMkdir(projectFolder), deleteProjectPath: makeWorkspaceDeleter(projectFolder, isPreExisting, confirmDelete), projectRoot: projectFolder }),
    // Stop must hard-interrupt an in-flight device op, not just abort the loop signal
    // (deliverables 07 §4). shim.kill() dies the blocked mpremote/script now and frees
    // the serial lock; idempotent, so a Stop with nothing in flight is a no-op.
    killDevice: () => shim.kill?.(),
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

  // Artifact Browser (spec §8.3): the current session's artifacts, indexed with metadata
  // and RELATIVE display paths (the P0 rule — never a hardcoded drive path to the UI).
  // Relativized against the workspace/storage root, the common ancestor of both the
  // generated project (blockless-project/) and the session log (.mpyhw/sessions/).
  let artifactIndex: Artifact[] = [];
  const artifactRoot = workspaceFolder ?? deps.globalStoragePath ?? projectFolder ?? "";
  // sha256 the file contents, but bounded (#28 F4): the index rebuilds on every
  // phase_complete, and reading a whole multi-MB .bin/.uf2 synchronously on the extension-host
  // thread each time would jank the UI. Skip the hash above a size cap (the row still shows
  // size/kind), and memoize by path:size:mtime so an unchanged file is hashed at most once.
  // Known limit: a same-size rewrite within one mtime tick serves a stale digest — acceptable
  // for a display-only field (opens/reveals never key off the sha).
  const ARTIFACT_MAX_HASH_BYTES = 4 * 1024 * 1024;
  const hashCache = new Map<string, string>();
  const artifactIo = {
    stat: (p: string) => {
      try { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
    },
    hash: (p: string) => {
      try {
        const s = statSync(p);
        if (s.size > ARTIFACT_MAX_HASH_BYTES) return ""; // too big to hash on the host thread
        const key = `${p}:${s.size}:${s.mtimeMs}`;
        const cached = hashCache.get(key);
        if (cached !== undefined) return cached;
        const digest = createHash("sha256").update(readFileSync(p)).digest("hex");
        hashCache.set(key, digest);
        return digest;
      } catch { return null; }
    },
    isoFromMs: (ms: number) => new Date(ms).toISOString(),
  };
  // Resolve a phase-declared artifact path (relative, from the Skill) to an absolute file.
  // The path's base is not fixed (project vs session vs workspace), so try each candidate
  // and pick the first that exists on disk; unresolved paths are dropped, not indexed.
  // Containment-checked (#28 F1): absolute or `..`-escaping declarations are refused so a
  // buggy/hostile phase payload can't inject an out-of-tree file into the openable index.
  function resolvePhaseArtifactPath(relativePath: string): string | null {
    const bases = [projectFolder, workspaceFolder, deps.globalStoragePath].filter(Boolean) as string[];
    return resolveContainedArtifactPath(bases, relativePath, existsSync);
  }

  function refreshArtifacts() {
    // Phase-declared artifacts FIRST so their real role (Skill `type`) and producing phase
    // win the dedup over the same file found via file_written or the disk walk. These cover
    // pre-generate outputs (analyze manifest, select-hw plan) that host scripts write directly.
    const sources: ArtifactSource[] = [];
    for (const rec of controller.phaseArtifactRecords()) {
      const abs = resolvePhaseArtifactPath(rec.path);
      if (abs) sources.push({ absolute_path: abs, kind: classifyArtifactKind(abs), phase: rec.phase, role: rec.role, origin: "session" });
    }
    // Live-session sources next (they carry the producing phase) so they win the
    // absolute_path dedup in buildArtifactIndex over the same files found on disk.
    sources.push(...controller.artifactSources());
    // Only walk the on-disk project when a real workspace is open: each workspace is a
    // distinct project, so browsing its blockless-project/ on reopen is meaningful. The
    // no-workspace globalStorage fallback is ONE shared scratch dir reused across sessions,
    // so walking it would surface stale cross-session files — there we stay session-scoped.
    if (workspaceFolder && projectFolder) sources.push(...scanArtifactTree(projectFolder, "disk"));
    // Walk THIS session's tree (§8.3 sessions/<id>/: logs, checkpoints, artifacts). Safe in
    // either mode — the dir is id-scoped (no shared-bucket cross-session mixing), so we use
    // sessionRoot (workspace or globalStorage) rather than gating on a workspace.
    const sessionId = controller.getDiagnostics().session_id;
    if (sessionRoot && sessionId) {
      sources.push(...scanArtifactTree(join(sessionRoot, ".mpyhw", "sessions", sessionId), "session"));
    }
    artifactIndex = buildArtifactIndex(sources, artifactRoot, artifactIo);
    // The host keeps the full index (with absolute_path) to resolve opens; the webview
    // gets a projection WITHOUT absolute_path — it only needs the relative path (which it
    // echoes back on open), so an absolute/drive-letter path never crosses to the UI (§4.2).
    // For images (svg/png) we attach a webview-safe URI so the browser can show a preview
    // inline under the strict CSP (img-src ${webviewCspSource}); still no filesystem path.
    const forWebview = artifactIndex.map(({ absolute_path, ...rest }) => {
      const isImage = rest.mime === "image/png" || rest.mime === "image/svg+xml";
      if (isImage && webview.asWebviewUri && vscode.Uri?.file) {
        try { return { ...rest, webview_uri: String(webview.asWebviewUri(vscode.Uri.file(absolute_path))) }; }
        catch { /* asWebviewUri unavailable (headless host) — omit the preview URI */ }
      }
      return rest;
    });
    webview.postMessage({ type: "artifacts_index", artifacts: forWebview });
  }

  webview.onDidReceiveMessage(async (message: any) => {
    if (message.type === "request_gen_driver_config") {
      // The panel renders its input tabs from the schema module (single source of truth).
      webview.postMessage({ type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
      return;
    }
    if (message.type === "request_support_config") {
      // Contacts/diagnostics come from the config module (single source of truth), never
      // hardcoded in the webview render.
      const contacts = orderContactsByLocale(SUPPORT_CONTACTS, vscode.env?.language ?? "en");
      webview.postMessage({ type: "support_config", contacts, diagnosticsFields: SUPPORT_DIAGNOSTICS_FIELDS });
      return;
    }
    if (message.type === "request_partners") {
      // Serve the home partner logos as data URIs (config-driven; logos read from disk).
      const partners = PARTNERS.map((p) => ({ id: p.id, name: p.name, url: p.url, logo: readPartnerLogo(p.file) })).filter((p) => p.logo);
      webview.postMessage({ type: "partners_config", partners });
      return;
    }
    if (message.type === "request_diagnostics") {
      // Gather env diagnostics on demand so a bug report carries an actionable snapshot.
      webview.postMessage({ type: "diagnostics", ...collectDiagnostics(vscode, controller.getDiagnostics()) });
      return;
    }
    if (message.type === "request_artifacts") {
      // The browser pulls the artifact index (on load and after files land).
      refreshArtifacts();
      return;
    }
    if (message.type === "open_artifact" && typeof message.relative_path === "string") {
      // Trust boundary: resolve the webview-supplied RELATIVE path only if it exactly
      // matches an indexed artifact — never open a path the webview hands us directly
      // (rejects traversal / absolute / drive-letter / out-of-index). Text opens in the
      // editor; binary (png/bin/uf2) reveals in the OS file manager.
      const absolute = resolveArtifactPath(artifactIndex, message.relative_path);
      if (absolute) {
        const entry = artifactIndex.find((a) => a.absolute_path === absolute);
        const uri = vscode.Uri.file(absolute);
        // Route by mime via the pure helper (unit-tested): markdown -> native preview,
        // png/svg/html -> native viewer, other text -> editor, binary -> reveal.
        const action = entry ? artifactOpenAction(entry.mime, entry.is_binary) : "reveal";
        try {
          if (action === "preview") {
            await vscode.commands?.executeCommand?.("markdown.showPreview", uri);
          } else if (action === "open") {
            await vscode.commands?.executeCommand?.("vscode.open", uri);
          } else if (action === "editor") {
            const doc = await vscode.workspace?.openTextDocument?.(uri);
            if (doc) await vscode.window?.showTextDocument?.(doc, { preview: false });
          } else {
            await vscode.commands?.executeCommand?.("revealFileInOS", uri);
          }
        } catch {
          // editor/command unavailable (e.g. headless host) — ignore
        }
      }
      return;
    }
    if (message.type === "open_external" && typeof message.url === "string") {
      // Open a support / partner / board URL in the OS default handler. The webview sandbox
      // can't openExternal itself, so it asks the host. Some of these URLs are backend-supplied
      // (a board's official download page), so validate the scheme before handing it off:
      // allow only http/https/mailto, never file://, UNC, or other exotic schemes.
      try {
        const uri = vscode.Uri.parse(message.url, true);
        if (/^(https?|mailto)$/.test(uri.scheme)) {
          await vscode.env?.openExternal?.(uri);
        }
      } catch {
        // malformed URL or headless host without openExternal — ignore
      }
      return;
    }
    if (message.type === "start_gen_driver") {
      // Normalized contract (Ruili 2026-07-06): canonical input is sources[]. Gate on
      // >=1 source or a driver_request; mode is pipeline when a cold-driver source is present.
      // ponytail: start_phase dispatch/run is Day 6/8.
      const sources = Array.isArray(message.sources) ? message.sources : [];
      if (!canStartGeneration(sources, message.driverRequest)) {
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: "Add at least one source (or a target driver) before generating." });
        return;
      }
      const mode = sources.some((s: any) => s?.type === "current_cold_driver_item") ? "pipeline" : "standalone";
      webview.postMessage({
        type: "gen_driver_status",
        detail: `Received ${sources.length} source(s) (mode=${mode}). Driver generation run is wired in a later step.`,
      });
      return;
    }
    if (message.type === "pick_gen_driver_file") {
      // The host owns the file dialog; return the path plus integrity metadata so the
      // source payload records what was uploaded (sha256 lets the plugin dedupe/verify).
      const filters = GEN_DRIVER_FILE_FILTERS[message.accept];
      const picked = await vscode.window.showOpenDialog?.({ canSelectMany: false, ...(filters ? { filters } : {}) });
      const path = picked?.[0]?.fsPath;
      if (!path) return;
      const bytes = readFileSync(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      webview.postMessage({ type: "gen_driver_file_picked", tabId: message.tabId, key: message.key, name: basename(path), path, size: bytes.length, sha256 });
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
      // Snapshot the user's pre-build files BEFORE the loop writes anything, so the
      // overwrite/delete gate (deliverables 07 §4) only prompts for these — never for the
      // build's own codegen output or scratch created during this run.
      snapshotExistingPaths(projectFolder, preExistingPaths);
      await controller.start({
        intent: message.intent,
        boardId: message.boardId,
        availableBoards,
        preSelectedBoard: message.pre_selected_board ?? undefined,
        preferences: { ...(message.preferences ?? {}), locale: vscode.env?.language },
        boardSelectionMode: message.board_selection_mode,
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
    if (message.type === "import_project") {
      // Open an existing MicroPython project folder as the workspace root so
      // generate/deploy target it. Native folder picker, then vscode.openFolder.
      try {
        const picked = await vscode.window?.showOpenDialog?.({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Open Project" });
        if (picked && picked[0]) await vscode.commands?.executeCommand?.("vscode.openFolder", picked[0]);
      } catch {
        // dialog/command unavailable (e.g. headless host) — ignore
      }
    }
    if (message.type === "request_recent_sessions") {
      // List past session summaries (read-only) from <sessionRoot>/.mpyhw/sessions — the same
      // root the recorder writes to (workspace, or globalStorage when no folder is open).
      let sessions: any[] = [];
      try {
        if (sessionRoot) sessions = await listRecentSessions(sessionRoot, RECENT_SESSIONS_LIMIT);
      } catch {
        // unreadable sessions dir — return an empty list, the panel shows its empty state
      }
      webview.postMessage({ type: "recent_sessions", sessions });
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
    if (message.type === "reveal_logs_folder") {
      // Open <sessionRoot>/.mpyhw/sessions in the OS file manager so users can grab the raw
      // session.jsonl logs (per-session transcript) for Skill debugging. Best-effort.
      const root = sessionRoot ? sessionsDir(sessionRoot) : undefined;
      if (root && existsSync(root)) {
        try {
          await vscode.commands?.executeCommand?.("revealFileInOS", vscode.Uri.file(root));
        } catch {
          // command/Uri unavailable (e.g. headless host) — ignore
        }
      } else {
        webview.postMessage({ type: "logs_status", text: "No session logs yet." });
      }
    }
    if (message.type === "export_session_log") {
      // Save the newest session's session.jsonl to a location the user picks, so it can be
      // handed over for Skill debugging (correlatable with the cloud trace by session id).
      // Fail-fast: a real listing error (EACCES, etc.) surfaces as "Export failed", not a
      // misleading "No session logs yet." (listRecentSessions only swallows ENOENT now).
      let sessions: any[] = [];
      try {
        sessions = sessionRoot ? await listRecentSessions(sessionRoot, 1) : [];
      } catch (error: any) {
        webview.postMessage({ type: "logs_status", text: `Export failed: ${error?.message ?? error}` });
        return;
      }
      if (!sessionRoot || sessions.length === 0) {
        webview.postMessage({ type: "logs_status", text: "No session logs yet." });
      } else {
        const src = sessions[0].path;
        // The session id already begins with "session-", so don't prepend it again.
        const defaultUri = vscode.Uri?.file?.(join(sessionRoot, `${sessions[0].id}.jsonl`));
        const target = await vscode.window?.showSaveDialog?.({ defaultUri, filters: { "Session log": ["jsonl"] } });
        if (target?.fsPath) {
          try {
            await writeFile(target.fsPath, readFileSync(src, "utf-8"), "utf-8");
            webview.postMessage({ type: "logs_status", text: "Session log exported." });
          } catch (error: any) {
            webview.postMessage({ type: "logs_status", text: `Export failed: ${error?.message ?? error}` });
          }
        }
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
    if (message.type === "user_supplement" && typeof message.text === "string") {
      // A note the user added mid-build (deliverables 07): queue it, don't interrupt.
      // It's consumed at the next safe point (after phase_complete).
      controller.submitSupplement(message.text, message.attachments);
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
function makeWorkspaceWriter(
  workspaceFolder: string | undefined,
  isPreExisting: (target: string) => boolean,
  confirmOverwrite: (target: string) => Promise<boolean>,
) {
  if (!workspaceFolder) return undefined;
  return (relPath: string, content: string) =>
    writeProjectFile({
      workspaceFolder,
      path: relPath,
      content,
      // Prompt only when clobbering a still-present pre-existing user file (deliverables 07
      // §4). New and session-created files write silently, so iterative codegen (which
      // rewrites its own output on gate retries) is never spammed with a confirm.
      guardOverwrite: async (target) =>
        isPreExisting(target) && existsSync(target) ? confirmOverwrite(target) : true,
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

// Start-of-run project-tree snapshot (deliverables 07 §4): record every existing FILE
// (absolute, resolved for cross-platform Set matching) into `into`. Called before the loop
// writes anything, so the set is exactly the user's pre-build files — the overwrite/delete
// gate prompts only for these, never for build output created during the run. Same skip
// list as the lister (.git / node_modules); unreadable dirs are skipped, not fatal.
function snapshotExistingPaths(root: string | undefined, into: Set<string>) {
  into.clear();
  if (!root) return;
  // lstatSync (not statSync): a symlink is recorded as a leaf, never followed, so a symlink
  // loop can't hang the walk. An unreadable dir is skipped (best-effort snapshot — the gate
  // is a confirmation, not a security boundary; containment in deleteProjectPath is).
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      let isDir = false;
      try { isDir = lstatSync(full).isDirectory(); } catch { continue; }
      if (isDir) walk(full);
      else into.add(resolve(full));
    }
  };
  walk(resolve(root));
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
function makeWorkspaceDeleter(
  workspaceFolder: string | undefined,
  isPreExisting: (target: string) => boolean,
  confirmDelete: (target: string) => Promise<boolean>,
) {
  if (!workspaceFolder) return undefined;
  return (relPath: string) =>
    deleteProjectPath({
      workspaceFolder,
      path: relPath,
      removePath: (target) => rm(target, { recursive: true, force: true }),
      // Confirm only for a still-present pre-existing user file (deliverables 07 §4); the
      // build's own scratch (e.g. firmware/tools/ removed before the mpy_imports gate) is
      // session-created, not in the start snapshot, so it deletes silently.
      guardDelete: async (target) =>
        isPreExisting(target) && existsSync(target) ? confirmDelete(target) : true,
    });
}

// Read a committed partner logo and inline it as a data URI. Reuses the readWebviewHtml
// base resolution (src in dev/test, ../../src/webview in the bundled build).
function readPartnerLogo(file: string): string | null {
  for (const base of ["./assets/partners/", "../../src/webview/assets/partners/"]) {
    try {
      const buf = readFileSync(new URL(base + file, import.meta.url));
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function readWebviewHtml(): string {
  // Dev/test runs this module directly (import.meta.url -> src/webview/), so
  // "./index.html" resolves. The bundled entry lives at dist/extension/, where
  // the packaged files sit at ../../src/webview/. Try both. The css/js live in
  // sibling files (Phase B split) and are inlined here so the webview still
  // receives a single self-contained HTML string.
  const candidates = ["./", "../../src/webview/"];
  let lastError: unknown;
  for (const base of candidates) {
    try {
      const html = readFileSync(new URL(base + "index.html", import.meta.url), "utf-8");
      const css = readFileSync(new URL(base + "webview.css", import.meta.url), "utf-8");
      // The webview JS is split by functionality into src/webview/components/ (spec §6.2).
      // components/manifest.json lists the components in load order (= concatenation order):
      // the webview is one shared inline <script> with no bundler, so they must load as one
      // script and order is load-bearing (Shared first, Dispatch last). Concatenating them
      // in manifest order reproduces the single script byte-for-byte.
      const compDir = new URL(base + "components/", import.meta.url);
      const order: string[] = JSON.parse(readFileSync(new URL("manifest.json", compDir), "utf-8"));
      const js = order.map((f) => readFileSync(new URL(f, compDir), "utf-8")).join("");
      return html.replace("/*__WEBVIEW_CSS__*/", () => css).replace("//__WEBVIEW_JS__", () => js);
    } catch (error) {
      // Keep the real cause visible: a missing/renamed component (e.g. a case-only
      // mismatch that only bites case-sensitive filesystems) would otherwise vanish
      // into the generic webview_html_not_found thrown below.
      lastError = error;
      console.error(`readWebviewHtml: candidate "${base}" failed`, error);
    }
  }
  // Message stays stable (asserted by tests / used as an error contract); the cause
  // carries the underlying readFileSync/JSON.parse failure for diagnosis.
  throw new Error("webview_html_not_found", { cause: lastError });
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
