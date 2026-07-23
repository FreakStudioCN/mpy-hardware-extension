import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { GEN_DRIVER_TABS, GEN_DRIVER_ENVELOPE_PHASE, buildGenDriverDispatch, canStartGeneration, materializeGenDriverTabs } from "../core/gen-driver-schema.ts";
import { stageGenDriverSources } from "../extension/gen-driver-staging.ts";
import { buildOptionalFlowDispatch, isNetworkRenderDenied, OPTIONAL_FLOW_PHASE_BY_FLOW, wrapGeneratePhaseComplete } from "../core/optional-flow-schema.ts";
import { ISSUE_TYPES, SUPPORT_CONTACTS, SUPPORT_DIAGNOSTICS_FIELDS, buildDiagnosticsFields, buildIssueReportUrl, orderContactsByLocale, sliceCodePoints } from "../core/support-config.ts";
import { PARTNERS } from "../core/partner-config.ts";
import { DEV_API_BASE_URL } from "../core/config.ts";
import { createProtocolLoop } from "../core/protocol-build.ts";
import { PROTOCOL_VERSION } from "../core/protocol-registry.ts";
import { createDeviceShim, detectPython, venvReady, venvExists, venvMpremoteVersion, installVenvAsync } from "../extension/device-shim.ts";
import { DeviceCommandQueue } from "../extension/device-lock.ts";
import { runDoctor } from "../extension/doctor.ts";
import { CloudTelemetryRecorder, CompositeSessionRecorder, JsonlSessionRecorder } from "../extension/session-recorder.ts";
import { createGithubAuth } from "../extension/github-auth.ts";
import { BUNDLED_TOOLCHAIN_VERSION, EXTENSION_VERSION, toolchainOutdated } from "../core/toolchain-version.ts";
import { canonicalPathKey, deleteProjectPath, isRealContained, snapshotExistingPaths, writeGeneratedFiles, writeProjectFile } from "../extension/workspace-writer.ts";
import { artifactOpenAction, buildArtifactIndex, classifyArtifactKind, resolveArtifactPath, resolveContainedArtifactPath, toRelativeDisplayPath } from "../extension/artifact-index.ts";
import type { Artifact, ArtifactSource } from "../extension/artifact-index.ts";
import { resolveApiBaseUrl } from "../extension/api-base-url.ts";
import { GitUnavailableError, gitBranch, gitCommit, gitStatusPorcelain, isGitRepo } from "../extension/project-git.ts";
import { buildSessionSnapshot, readSessionSnapshot, writeSessionSnapshot } from "../extension/session-snapshot.ts";
import type { SessionSnapshot, SnapshotArtifact } from "../extension/session-snapshot.ts";

type PanelDeps = { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; venvReady?: () => boolean; venvExists?: () => boolean; loopMode?: "agent" | "template"; log?: (message: string) => void; globalStoragePath?: string; onWebviewReady?: (webview: any) => void };

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
  // Pin the repo search to projectFolder: `git config` walks UP to find the repo, so if .git
  // vanished between the caller's existsSync check and this write, the value would land in a
  // PARENT repo's .git/config. GIT_CEILING_DIRECTORIES stops the walk at the parent (mirrors the
  // pin in project-git.ts's git()).
  const opts = { windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(projectFolder) } };
  try {
    await execFileAsync("git", ["-C", projectFolder, "config", "--get", key], opts);
  } catch {
    await execFileAsync("git", ["-C", projectFolder, "config", key, value], opts);
  }
}

// All generation output is contained under <workspace>/<PROJECT_SUBDIR>, never the
// workspace root. The scaffold (init_scaffold.py) writes README.md/LICENSE/.flake8
// and the firmware/ tree straight into its project_dir with no overwrite check, so
// pointing it at the open workspace root would clobber those files (e.g. when the
// dev repo itself is the open folder). A dedicated subfolder makes that impossible.
const PROJECT_SUBDIR = "blockless-project";
// Bound the "x (n).py" rename search when a device download would clobber a workspace file.
const MAX_DOWNLOAD_DEDUP = 1000;
// How long a host-issued device-delete nonce stays valid for the webview to echo back
// (spec §4). Longer than the webview's 3s UI arm so the confirm click is never rejected
// by a host/webview clock race; short enough that a leaked nonce is not reusable later.
const DELETE_ARM_TTL_MS = 10_000;

// Save Version (#95): its own global-tool surface (toolSaveVersion), driven by save_version_open /
// _commit / _snapshot messages. Failure/outcome taxonomy (§D). Named so no code is a bare string.
const SAVE_VERSION_STATUS = {
  savedCommit: "saved_commit",
  savedSnapshot: "saved_snapshot",
  nothing: "nothing_to_save",
  busy: "busy",
  gitUnavailable: "git_unavailable",
  nothingToCommit: "nothing_to_commit",
  commitFailed: "git_commit_failed",
  snapshotWriteFailed: "snapshot_write_failed",
  workspaceUnavailable: "workspace_unavailable",
  inFlight: "in_flight", // a second act arrived while one is already saving (e.g. a re-opened panel)
} as const;
// Keep the proposed commit summary to a readable one-liner (§C deterministic template).
const SAVE_VERSION_INTENT_MAX = 60;
const SAVE_VERSION_FILE_ITEMS_MAX = 50; // display-only file rows shown on the card
const SAVE_VERSION_ARTIFACT_ITEMS_MAX = 20; // display-only artifact rows shown on the card
// Detail shown when a flow run (gen-driver / optional-flow) is refused because a run or a save is
// active. Posted via the flow-specific status so the trigger button restores (message-bus.js
// restores those buttons only on their own status, never on bare session_busy).
const RUN_BUSY_DETAIL = "A build is already running — try again once it finishes.";

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
function collectDiagnostics(vscode: any, session: Record<string, string>, serialPort: string): { text: string; fields: Record<string, string> } {
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
    // The selected device port lives in the shim, not the session — merge it here (host
    // keys win). Reflects the last-selected device; may be stale after unplug (display-only).
    serial_port: serialPort,
  };
  return buildDiagnosticsFields({ ...session, ...host });
}

// How many past sessions the "View Recent Sessions" launch entry lists (newest first).
const RECENT_SESSIONS_LIMIT = 20;

// Caps for the host-validated issue-report form (webview input is untrusted). Generous, just
// bounds against a pathological paste before the URL builder truncates the attached diagnostics.
const ISSUE_DESC_MAX = 5000;
const ISSUE_CONTACT_MAX = 200;

// Maps a gen-driver file field's `accept` group to a vscode open-dialog filter.
const GEN_DRIVER_FILE_FILTERS: Record<string, Record<string, string[]>> = {
  pdf: { "PDF datasheet": ["pdf"] },
  arduino: { "Arduino / C / C++ / zip": ["ino", "c", "cpp", "cc", "h", "hpp", "zip"] },
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

// Deterministic proposed commit message (§C, no LLM): "blockless: <intent> (<phase>, <board>)".
// P0-deterministic so the same state always proposes the same message; the user edits it on
// the card (the prefilled text_input). Missing pieces are dropped, never rendered as "()".
function buildCommitMessage(intent: string | undefined, phase: string | null, boardId: string | null): string {
  // Slice by whole code points so a CJK/emoji intent isn't cut mid-surrogate into a U+FFFD.
  const head = sliceCodePoints((intent ?? "").trim(), SAVE_VERSION_INTENT_MAX) || "save version";
  const context = [phase, boardId && boardId !== "auto" ? boardId : null].filter(Boolean).join(", ");
  return context ? `blockless: ${head} (${context})` : `blockless: ${head}`;
}

// Parse one `git status --porcelain` line ("XY path") into a display row for the Save Version card:
// a friendly status kind (drives the color-coded badge in the webview) + the clean path with the
// XY code stripped. Checks the most specific code first; XY is index+worktree, so a mixed code like
// "MM"/"AM" maps to its most salient action.
export function parseGitStatusRow(line: string, index: number): { id: string; name: string; status: string; badge: string; staged: boolean } {
  const code = line.slice(0, 2);
  const path = line.slice(3).trim() || line.trim();
  // The index (first) column is set for a STAGED change; " " means worktree-only (unstaged) and "?" is
  // untracked. Drives the staged marker so the card can show which files the commit will actually take.
  const staged = code[0] !== " " && code[0] !== "?";
  // status = color-class kind; badge = the compact VS Code SCM letter (U/A/M/D/R).
  const [status, badge] = code.includes("?") ? ["new", "U"]
    : code.includes("D") ? ["deleted", "D"]
    : code.includes("R") ? ["renamed", "R"]
    : code.includes("A") ? ["added", "A"]
    : code.includes("M") ? ["modified", "M"]
    : ["changed", "•"];
  return { id: `chg-${index}`, name: path, status, badge, staged };
}

// One source of truth for the Save Version file summary — used by BOTH the open summary and the
// post-commit refresh, so the two never drift (the post-commit path was the un-fixed sibling of the
// display cap). Capped display rows, the true total (the commit spans all of them), and the mode the
// commit will use: staged-only when the index has staged changes, else add -A.
function summarizeGitStatus(porcelain: string[]): { files: ReturnType<typeof parseGitStatusRow>[]; fileTotal: number; commitMode: "staged" | "all" } {
  const rows = porcelain.map((line, i) => parseGitStatusRow(line, i));
  return {
    files: rows.slice(0, SAVE_VERSION_FILE_ITEMS_MAX),
    fileTotal: rows.length,
    commitMode: rows.some((r) => r.staged) ? "staged" : "all",
  };
}

// The session snapshot is written to checkpoints/snapshot.json, which the session-tree scan then
// indexes. Left in, the NEXT save's artifacts[] would list the PREVIOUS snapshot.json with the
// sha of the file this write is about to replace — a guaranteed sha256 mismatch for session restore's
// replay-verify. Exclude the snapshot's own path so it never self-references. (It stays browsable
// in the display index — this only shapes the persisted, integrity-checked artifacts[].)
const SNAPSHOT_SELF_PATH_SUFFIX = "checkpoints/snapshot.json";

// Segment-anchored: matches the session snapshot ".mpyhw/sessions/<id>/checkpoints/snapshot.json"
// (always preceded by "/") and a bare "checkpoints/snapshot.json", but NOT a lookalike segment like
// "mycheckpoints/snapshot.json". Residual: a user file at "<project>/checkpoints/snapshot.json"
// would also match and be dropped from the persisted artifacts[] — an accepted ceiling (the display
// index is unaffected, and that exact path under a generated project is not a real artifact).
export function isSnapshotSelfPath(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, "/");
  return norm === SNAPSHOT_SELF_PATH_SUFFIX || norm.endsWith("/" + SNAPSHOT_SELF_PATH_SUFFIX);
}

// Session-restore replay-verify needs a REAL digest — NOT the Artifact index's display-only sha (which is ""
// over a 4 MiB cap, so firmware .bin/.uf2 land unverified, and is memoized on path:size:mtime, so a
// same-size rewrite within one mtime tick serves a stale digest). Re-hash fresh from disk here at
// snapshot-write time, no memo and a far higher bound. Over the bound or unreadable -> null (an
// honest "not verified"), never "" (which the consumer would read as a match).
const SNAPSHOT_MAX_HASH_BYTES = 64 * 1024 * 1024;
// ponytail: per-file bound only, no aggregate budget across the (≤500) indexed artifacts. A real
// project tree is a handful of small code files + one firmware image, so a save hashes sub-second;
// the unbounded-total case (hundreds of large files) can't arise from the generators. Upgrade path
// if that changes: track a running byte total here and return null past an aggregate cap.
function snapshotSha256(absolutePath: string): string | null {
  try {
    if (statSync(absolutePath).size > SNAPSHOT_MAX_HASH_BYTES) return null;
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch { return null; }
}

// Project the host artifact index into the portable snapshot rows (§4.2): relative_path only,
// NO absolute_path. sha256 recomputed fresh from disk (see snapshotSha256) — the integrity hash session restore
// verifies against before replaying code, not the display-only index value.
function toSnapshotArtifacts(index: Artifact[]): SnapshotArtifact[] {
  return index.filter((a) => !isSnapshotSelfPath(a.relative_path)).map((a) => ({
    relative_path: a.relative_path,
    kind: a.kind,
    role: a.role,
    phase: a.phase,
    size: a.size,
    sha256: snapshotSha256(a.absolute_path),
    created_at: a.created_at,
  }));
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
  // Package browser (Device Tools): search standard sources + resolve uPyPI metadata.
  const packageBrowserClient = new PackageClient(apiBaseUrl, fetchImpl);
  // Real device shim (Python serve.py). Lazy: nothing spawns until the agent
  // actually touches a device. Tests can inject deps.shim to bypass it.
  const shim = deps.shim ?? createDeviceShim({ vscode, extensionUri });
  // Injectable so tests can drive the "broken venv" branch of the presence poll + doctor.
  const venvReadyFn = deps.venvReady ?? venvReady;
  // The presence poll fires every 2.5s and venvReadyFn() is a synchronous 7-import python
  // spawn (~130-260ms, worse on Windows). A venv that has imported its deps once does not
  // spontaneously lose them, so memoize the first success and never re-probe on the hot
  // path. A NOT-ready probe backs off VENV_REPROBE_MS instead of re-spawning every tick:
  // a present-but-broken venv would otherwise block the extension host on each poll. The
  // backoff (not a failure memo) keeps recovery automatic — after install_deps succeeds,
  // the next allowed probe flips the poll to ready without a reload. The Doctor keeps
  // calling venvReadyFn directly, so its Re-check still detects a deleted/broken venv live.
  // ponytail: ceiling — if the user deletes the venv mid-session, the poll won't notice
  // until shim.scan() itself fails; the Doctor Re-check is the recovery path. Upgrade to a
  // shim-is-running check if that edge ever bites.
  const VENV_REPROBE_MS = 10_000;
  let venvConfirmed = false;
  let venvLastProbeAt = 0;
  const venvReadyForPoll = (): boolean => {
    if (venvConfirmed) return true;
    if (Date.now() - venvLastProbeAt < VENV_REPROBE_MS) return false;
    const ready = venvReadyFn();
    // Stamp AFTER the probe returns: the probe itself can block up to its 15s spawnSync
    // timeout, so a before-stamp would let a stalled probe outlive its own quiet window
    // and a queued poll re-spawn back-to-back. (Synchronous, so no reentrancy in between.)
    venvLastProbeAt = Date.now();
    return (venvConfirmed = ready);
  };
  // Cheap absent-vs-broken split for the presence poll: an ABSENT venv (never set up) surfaces a
  // "set up environment" affordance in Device Tools; a present-but-broken one stays silent (the
  // Doctor Re-check recovers it). venvExists is existsSync-only, so it's fine on the hot path.
  const venvExistsFn = deps.venvExists ?? venvExists;
  // Serializes user-initiated device-tool commands so two never overlap on the one
  // serial port (#54, spec §41). The active-run gate is checked per command below.
  const deviceQueue = new DeviceCommandQueue();
  // Host-enforced two-step for the destructive device delete (spec §4). The webview's
  // "Confirm?" arm is UI-only, so a stale/duplicated device_tool_delete would otherwise
  // delete with no gate. The host issues a one-shot nonce on the first (bare) delete and
  // only removes the file when the webview echoes that exact nonce back for the same path
  // in time; the nonce is consumed on use, so a replay cannot delete again.
  let pendingDelete: { path: string; nonce: string; expiresAt: number } | null = null;
  // Uninstall is a recursive `rm -r :/lib/<name>` -- host-enforce the same one-shot nonce as
  // delete so a stale/duplicated/crafted bare message can't wipe a package dir (the webview
  // two-click alone is not a security boundary). Keyed by package name.
  let pendingUninstall: { name: string; nonce: string; expiresAt: number } | null = null;
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
  const isPreExisting = (p: string) => preExistingPaths.has(canonicalPathKey(p));
  // The destructive-file confirm is shown as an in-panel card by the controller (deliverables
  // 07 §4). Late-bound: the writer/deleter capture these stable closures now, but the real
  // controller.confirmFileOp is wired in after the controller exists (below). Until then (and
  // in any host with no controller) they resolve false — keep the file — the safe default.
  let confirmFileOp: (op: "overwrite" | "delete" | "device_delete", target: string) => Promise<boolean> = async () => false;
  const confirmOverwrite = (target: string) => confirmFileOp("overwrite", target);
  const confirmDelete = (target: string) => confirmFileOp("delete", target);
  // A device file delete is irreversible (no git, no trash), so deliverables 07 §4 row 60 asks
  // for a *second* confirmation beyond the host-file single card. Ask the plain delete card first,
  // then this stronger "permanently erases" card; the device rm runs only if BOTH proceed.
  const confirmDeviceErase = (target: string) => confirmFileOp("device_delete", target);
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
    loop: createLoop({ ...deps, apiBaseUrl, shim, getAuthToken: () => auth.getToken(false), readWorkspaceFile: makeWorkspaceReader(projectFolder), writeProjectFile: makeWorkspaceWriter(projectFolder, isPreExisting, confirmOverwrite), listFiles: makeWorkspaceLister(projectFolder), makeProjectDir: makeWorkspaceMkdir(projectFolder), deleteProjectPath: makeWorkspaceDeleter(projectFolder, isPreExisting, confirmDelete), confirmDeviceDelete: async (p: string) => (await confirmDelete("device:" + p)) && (await confirmDeviceErase("device:" + p)), confirmDeviceCopyOverwrite: async (target: string) => isPreExisting(target) && existsSync(target) ? confirmOverwrite(target) : true, projectRoot: projectFolder }),
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
  // Wire the destructive-file confirm to the controller's in-panel card (deliverables 07 §4),
  // showing a RELATIVE path (§4.2 forbids an absolute/drive-letter path reaching the UI).
  confirmFileOp = (op, target) => controller.confirmFileOp(op, toRelativeDisplayPath(artifactRoot, target));
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

  function refreshArtifacts(extraSessionDir?: string) {
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
    // Restore: also index the RESTORED session's tree (a different id from the current one) so its
    // artifacts populate the tab — the live session_id above is empty right after a restore.
    if (extraSessionDir) sources.push(...scanArtifactTree(extraSessionDir, "session"));
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

  // Save Version (#95 §D): host-initiated confirm → git commit OR session snapshot. Never
  // mid-run. Detect-only git (never init, §3.6.3). The card offers only the actions the
  // current state supports, so commit/snapshot/cancel always mean exactly what they say.
  // Save Version is its OWN global-tool surface (the toolSaveVersion view), not an Activity-feed
  // card — a user utility with no agent/LLM involvement, so it doesn't belong in the build feed.
  // The panel opens (save_version_open -> save_version_data), the user confirms in the view
  // (save_version_commit / save_version_snapshot). saveInFlight serializes the two acts, and each
  // act re-checks isRunning() at act time (a busy gate is not a lock — a build may have started
  // while the panel was open).
  let saveInFlight = false;
  // True from the moment beginRun() commits a build to running until that run releases. isRunning()
  // alone is not enough: start_gen_driver/start_optional_flow do async work (source staging /
  // phase-complete write) between beginRun() and controller.startPhase() flipping isRunning(), so a
  // save arriving in that window would pass the isRunning() gate and race the starting run's writes.
  // saveVersionContext refuses on runPending, closing that window for every entry point.
  let runPending = false;

  // Gather the save summary the panel renders (changed files parsed to friendly status, the
  // proposed commit message, whether a git commit is possible, a stage line). Posts a status
  // instead when a run is active / no workspace / nothing to save.
  async function computeSaveVersionData(): Promise<void> {
    if (controller.isRunning() || runPending) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.busy }); return; }
    if (!projectFolder && !sessionRoot) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.workspaceUnavailable }); return; }
    // Detect-only git probe: a .git present AND git on PATH enables the commit action.
    const repoPresent = !!projectFolder && isGitRepo(projectFolder);
    let gitFiles: string[] = [];
    let canCommit = false;
    if (repoPresent && projectFolder) {
      try { gitFiles = await gitStatusPorcelain(projectFolder); canCommit = true; }
      catch (error: any) { if (!(error instanceof GitUnavailableError)) deps.log?.(`save_version: git status failed: ${error?.message ?? error}`); }
    }
    if (!canCommit && !controller.hasSnapshotState()) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.nothing }); return; }
    refreshArtifacts();
    const snap = controller.getSnapshotState();
    const diag = controller.getDiagnostics();
    // Capped rows + the true total (the commit spans all of them) + the mode the commit will use.
    const summary = summarizeGitStatus(gitFiles);
    webview.postMessage({
      type: "save_version_data",
      canCommit,
      proposed: buildCommitMessage(snap.state?.intent, snap.currentPhase, snap.boardId),
      files: summary.files,
      fileTotal: summary.fileTotal,
      commitMode: canCommit ? summary.commitMode : "", // no commit mode when there's no repo (snapshot path)
      stage: [diag.current_phase && `phase: ${diag.current_phase}`, diag.selected_board && `board: ${diag.selected_board}`, `${artifactIndex.length} artifact(s)`].filter(Boolean).join("  |  "),
      // repoPresent-but-!canCommit covers BOTH a missing git binary AND a git status that failed
      // (e.g. a corrupt repo) — so the note names the outcome ("commit unavailable"), not a cause
      // it can't distinguish here.
      note: canCommit ? "" : (repoPresent ? "Git commit is unavailable — a session snapshot will be saved instead." : "Not a git repo — a session snapshot will be saved instead."),
      // The rest of the §3.6.3 summary the card must cover: the resume/session state, the
      // phase-associated artifacts (listed, not just counted), and the diagnostics — all
      // read locally from the controller; nothing is sourced from the plugin.
      session: {
        intent: snap.state?.intent ?? "",
        phase: (snap.state?.phase ?? snap.currentPhase) || "",
        board: diag.selected_board || (snap.boardId && snap.boardId !== "auto" ? snap.boardId : ""),
        mode: snap.preferences?.mode ?? "",
      },
      artifacts: artifactIndex.slice(0, SAVE_VERSION_ARTIFACT_ITEMS_MAX).map((a) => ({ path: a.relative_path, kind: a.kind, phase: a.phase })),
      artifactTotal: artifactIndex.length,
      diagnostics: { activity: diag.recent_activity || diag.last_command || "", errors: diag.key_errors || "", session_id: diag.session_id || "" },
    });
  }

  // Fresh-state gate shared by the two acts: re-checks isRunning() at act time and re-reads the
  // controller state + session dir. Returns null (and posts busy) when a run is active.
  function saveVersionContext(): { snap: ReturnType<typeof controller.getSnapshotState>; diag: Record<string, string>; sessionDir?: string } | null {
    // runPending as well as isRunning(): a build that has acquired the run but not yet flipped
    // isRunning() (mid staging / phase-complete write) must still block the save, or its add -A
    // races the build's writes.
    if (controller.isRunning() || runPending) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.busy }); return null; }
    const diag = controller.getDiagnostics();
    const sessionId = diag.session_id;
    return { snap: controller.getSnapshotState(), diag, sessionDir: sessionRoot && sessionId ? join(sessionRoot, ".mpyhw", "sessions", sessionId) : undefined };
  }

  async function doSaveVersionCommit(rawMessage: unknown): Promise<void> {
    if (saveInFlight) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.inFlight }); return; }
    saveInFlight = true;
    try {
      const ctx = saveVersionContext(); if (!ctx) return;
      if (!(projectFolder && isGitRepo(projectFolder))) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.gitUnavailable }); return; }
      const message = String(rawMessage ?? "").trim() || buildCommitMessage(ctx.snap.state?.intent, ctx.snap.currentPhase, ctx.snap.boardId);
      let hash: string;
      try { hash = await gitCommit(projectFolder, message); }
      catch (error: any) {
        if (error instanceof GitUnavailableError) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.gitUnavailable }); return; }
        const detail = String(error?.message ?? error);
        const status = /nothing to commit/i.test(detail) ? SAVE_VERSION_STATUS.nothingToCommit : SAVE_VERSION_STATUS.commitFailed;
        webview.postMessage({ type: "save_version_status", status, error: detail }); return;
      }
      // Rebuild the artifact index at CONFIRM time (not the stale panel-open build): writeSaveSnapshot
      // projects the closure artifactIndex, so a file created/changed while the confirmation sat open
      // would otherwise persist a stale path/size/digest into the session-restore contract (CWE-367 capture timing).
      refreshArtifacts();
      // One save = one restorable point: also snapshot with the commit hash. A snapshot miss must
      // NOT undo the commit.
      if (controller.hasSnapshotState() && ctx.sessionDir) {
        try { await writeSaveSnapshot(ctx.sessionDir, ctx.snap, ctx.diag, { commit_hash: hash, branch: await gitBranch(projectFolder) }); }
        catch (error: any) { deps.log?.(`save_version: post-commit snapshot failed: ${error?.message ?? error}`); }
      }
      refreshArtifacts();
      // Re-read the tree so the panel's file list reflects the POST-commit truth: empty after an
      // add -A ("save everything"), or the remaining unstaged files after a staged-only commit --
      // not the just-committed files as if they were still pending. Best-effort; the commit stands
      // regardless.
      // Same summary as the open path (fileTotal + commitMode too, not just the rows) so the post-commit
      // refresh doesn't drift from it: a staged-only commit can leave >50 unstaged files (needs "+N more")
      // and flips the next click's mode to add -A (the note must update).
      let summary: ReturnType<typeof summarizeGitStatus> | undefined;
      try { summary = summarizeGitStatus(await gitStatusPorcelain(projectFolder)); }
      catch (error: any) { deps.log?.(`save_version: post-commit status refresh failed: ${error?.message ?? error}`); } // leave undefined -> panel keeps its list, not a false "no changes"
      webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.savedCommit, hash, files: summary?.files, fileTotal: summary?.fileTotal, commitMode: summary?.commitMode });
    } finally { saveInFlight = false; }
  }

  async function doSaveVersionSnapshot(): Promise<void> {
    if (saveInFlight) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.inFlight }); return; }
    saveInFlight = true;
    try {
      const ctx = saveVersionContext(); if (!ctx) return;
      if (!controller.hasSnapshotState() || !ctx.sessionDir) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.nothing }); return; }
      // Rebuild the artifact index at CONFIRM time so the snapshot captures the tree as it is NOW,
      // not the stale panel-open build (CWE-367 capture timing — blocker 2).
      refreshArtifacts();
      try { await writeSaveSnapshot(ctx.sessionDir, ctx.snap, ctx.diag, null); }
      catch (error: any) { webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.snapshotWriteFailed, error: String(error?.code ?? error?.message ?? error) }); return; }
      refreshArtifacts();
      webview.postMessage({ type: "save_version_status", status: SAVE_VERSION_STATUS.savedSnapshot });
    } finally { saveInFlight = false; }
  }

  // Build + write the session snapshot from the controller state bundle + diagnostics (§A).
  async function writeSaveSnapshot(sessionDir: string, snap: ReturnType<typeof controller.getSnapshotState>, diag: Record<string, string>, git: { commit_hash: string; branch: string } | null) {
    const snapshot = buildSessionSnapshot({
      traceId: snap.traceId,
      savedAt: new Date().toISOString(),
      currentPhase: snap.currentPhase,
      terminal: snap.terminal,
      state: snap.state,
      boardId: snap.boardId,
      preSelectedBoard: snap.preSelectedBoard,
      boardSelectionMode: snap.boardSelectionMode,
      preferences: snap.preferences,
      manifest: controller.getLatestManifest() ?? null,
      diagram: snap.diagram ?? null,
      credits: snap.credits,
      diagnostics: {
        selected_board: diag.selected_board ?? "",
        key_errors: diag.key_errors ?? "",
        recent_activity: diag.recent_activity ?? "",
        last_command: diag.last_command ?? "",
      },
      artifacts: toSnapshotArtifacts(artifactIndex),
      git,
    });
    await writeSessionSnapshot(sessionDir, snapshot);
  }

  // Live credit balance for the quota bar (signed-in only; silent auth never prompts). Shared by
  // session start, request_boards, and restore — the snapshot's credits are advisory, so a restored
  // session refetches the truth. Best-effort: any failure leaves the bar as it was.
  async function refreshCredits(): Promise<void> {
    if (!vscode.authentication) return;
    try {
      const jwt = await auth.getToken(false);
      if (!jwt) return;
      const cr = await fetchImpl(`${apiBaseUrl}/v1/credits`, { headers: { authorization: `Bearer ${jwt}` } });
      const c: any = await cr.json();
      webview.postMessage({ type: "session_event", event: { kind: "credits", balance: c.balance, dailyGrant: c.daily_grant, resetsAt: c.resets_at } });
    } catch {
      // credits unavailable — webview leaves the bar hidden
    }
  }

  // Session restore (the consumer of the snapshot Save Version writes): read a saved snapshot and
  // rehydrate the session + the webview tabs from it. Refuses while a run is active (a live session owns
  // the state). A session with NO snapshot (a pre-Save-Version session) is not an error — it just can't
  // be restored, so the caller is told and degrades (view its log) rather than showing a broken restore.
  async function doRestoreFromDir(sessionDir: string, sessionId: string): Promise<void> {
    if (controller.isRunning() || runPending) { vscode.window?.showInformationMessage?.("Finish the current build before restoring a session."); return; }
    let snap: SessionSnapshot | null;
    try { snap = await readSessionSnapshot(sessionDir); }
    catch (error: any) { vscode.window?.showErrorMessage?.(`Restore failed: ${String(error?.message ?? error)}`); return; }
    if (!snap) {
      // No snapshot (a pre-Save-Version session, or one deleted since the list was built). Degrade to
      // view-log: reveal the session.jsonl if it's there, so an old session isn't a dead end.
      const log = join(sessionDir, "session.jsonl");
      if (existsSync(log)) { try { await vscode.commands?.executeCommand?.("revealFileInOS", vscode.Uri.file(log)); } catch { /* headless host — ignore */ } }
      vscode.window?.showInformationMessage?.("This session has no saved snapshot to restore (it predates Save Version) — showing its log instead.");
      return;
    }
    // Controller-side: seed state/board/preferences so a later save()/retry() operates on the restored
    // session. No run is started — this only loads the state.
    controller.seedFromSnapshot({
      state: snap.state,
      boardId: snap.board?.board_id || null,
      preSelectedBoard: snap.board?.pre_selected_board ?? undefined,
      boardSelectionMode: snap.board?.board_selection_mode || undefined,
      preferences: snap.preferences,
      currentPhase: snap.stage?.current_phase || null,
      manifest: snap.manifest ?? undefined,
      diagram: snap.diagram ?? undefined,
    });
    // Webview-side: replay the tabs (the inverse of clearConversation) — wiring, diagram, code.
    if (snap.manifest) webview.postMessage({ type: "manifest_updated", manifest: snap.manifest });
    if (snap.diagram) webview.postMessage({ type: "diagram_updated", diagram: snap.diagram });
    // Code cards: replay each code artifact's on-disk content, but VERIFY its digest against the snapshot
    // first — never replay a file whose sha256 no longer matches (the snapshot's integrity guarantee).
    for (const a of snap.artifacts ?? []) {
      if (a.kind !== "code") continue;
      const abs = resolvePhaseArtifactPath(a.relative_path);
      if (!abs) continue;
      try {
        const bytes = readFileSync(abs);
        if (a.sha256 && createHash("sha256").update(bytes).digest("hex") !== a.sha256) continue; // changed on disk — skip, don't replay stale
        webview.postMessage({ type: "code_updated", code: bytes.toString("utf-8"), path: a.relative_path });
      } catch { /* unreadable — skip this file, restore the rest */ }
    }
    refreshArtifacts(sessionDir); // populate the Artifacts tab from the restored session's tree (D1)
    await refreshCredits(); // the snapshot's credits are advisory — refetch the live quota (D2)
    vscode.window?.showInformationMessage?.(`Restored session${snap.state?.intent ? `: ${snap.state.intent}` : ""}.`);
  }

  // Device Tools (#54): run a user-initiated device command. Refuse while a session
  // run owns the port (device_busy — never silently compete with flash/deploy/
  // gen-driver, spec §41); otherwise serialize on deviceQueue, log it, and post the
  // result. `fn` returns the payload sent back with device_tool_result.
  async function runDeviceTool(command: string, params: any, fn: () => Promise<any>) {
    if (controller.isRunning()) {
      webview.postMessage({ type: "device_busy", command, phase: controller.runningPhase() });
      return;
    }
    try {
      // Re-check ownership at DEQUEUE, not just enqueue: a command queued behind a slow
      // one (e.g. a mip install) must not fire if a session run took the port meanwhile.
      const result = await deviceQueue.runExclusive(() => {
        if (controller.isRunning()) {
          const busy: any = new Error("device_busy");
          busy.deviceBusy = true; busy.phase = controller.runningPhase();
          throw busy;
        }
        return fn();
      });
      await controller.recordDeviceTool(command, params, { ok: true });
      webview.postMessage({ type: "device_tool_result", command, result });
    } catch (error: any) {
      if (error?.deviceBusy) { webview.postMessage({ type: "device_busy", command, phase: error.phase }); return; }
      const msg = error?.message ?? "device_tool_failed";
      await controller.recordDeviceTool(command, params, { ok: false, error: msg });
      webview.postMessage({ type: "device_tool_error", command, error: msg });
    }
  }

  // Package browser search (Device Tools). The two standard sources are live upstreams:
  // uPyPI (search returns name+url; the browser resolves package.json on expand) and
  // micropython-lib (search returns full records). "Auto" searches BOTH at once and merges;
  // there is no separate local catalog to query (graftsense content is identical to uPyPI).
  // Every result carries its own `source` so the accordion knows whether to resolve on expand.
  const AUTO_RESULT_LIMIT = 30;

  function tagUpypi(results: any): any[] {
    // Coerce name to a string (defensive: a non-string upstream name would crash the merge sort).
    return (Array.isArray(results) ? results : []).map((hit: any) => ({ ...hit, name: String(hit?.name ?? ""), source: "upypi" }));
  }

  // Dedup by normalized name keeping the micropython-lib record (official + full metadata,
  // renders without a resolve round-trip); order prefix-matches first, then by name, lib
  // before uPyPI. Deterministic.
  function mergePackages(query: string, libHits: any[], upypiHits: any[]): any[] {
    const prefix = (query || "").trim().toLowerCase();
    const norm = (name: string) => String(name || "").toLowerCase().replace(/[-_]/g, "_");
    const byName = new Map<string, any>();
    for (const hit of [...libHits, ...upypiHits]) { // lib first -> wins the dedup
      const key = norm(hit?.name);
      // Coerce name to a string on the survivor: a non-string lib name would throw in the sort's
      // toLowerCase() (tagUpypi already coerces uPyPI hits; the backend coerces lib -- defense in
      // depth for both).
      if (key && !byName.has(key)) byName.set(key, { ...hit, name: String(hit?.name ?? "") });
    }
    return [...byName.values()].sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(prefix) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(prefix) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      // Names are unique after the normalized-name dedup, so the name comparison is total here --
      // the old source tiebreak was unreachable (lib-before-uPyPI is already enforced by the
      // lib-first dedup above), so it's dropped as dead code.
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    }).slice(0, AUTO_RESULT_LIMIT);
  }

  async function handlePackageSearch(source: string, query: string) {
    if (source === "micropython_lib") {
      try {
        const body = await packageBrowserClient.micropythonLibSearch(query);
        webview.postMessage({ type: "package_search_result", source, query, results: body?.results ?? [] });
      } catch (error: any) {
        webview.postMessage({ type: "package_search_error", source, query, error: error?.code ?? "search_failed" });
      }
      return;
    }
    if (source === "upypi") {
      try {
        const body = await packageBrowserClient.upypiSearch(query);
        webview.postMessage({ type: "package_search_result", source, query, results: tagUpypi(body?.results) });
      } catch (error: any) {
        webview.postMessage({ type: "package_search_error", source, query, error: error?.code ?? "search_failed" });
      }
      return;
    }
    // Auto: search both live sources at once; return whatever came back, error only if BOTH fail.
    const [up, lib] = await Promise.allSettled([
      packageBrowserClient.upypiSearch(query),
      packageBrowserClient.micropythonLibSearch(query),
    ]);
    if (up.status === "rejected" && lib.status === "rejected") {
      webview.postMessage({ type: "package_search_error", source: "auto", query, error: "search_failed" });
      return;
    }
    const upypiHits = up.status === "fulfilled" ? tagUpypi(up.value?.results) : [];
    const libHits = lib.status === "fulfilled" ? (lib.value?.results ?? []) : [];
    webview.postMessage({ type: "package_search_result", source: "auto", query, results: mergePackages(query, libHits, upypiHits) });
  }

  // Acquire run ownership of the serial port before a session run takes it: wait for any
  // in-flight device-tool command on deviceQueue (spec §41, run<-device-tool direction), then
  // HOLD the queue for the run's whole duration and return a release() the caller invokes in a
  // finally. Holding (not just draining) makes the "no tool interleaves onto the port mid-run"
  // guarantee structural, not dependent on the isRunning() check winning a microtask race.
  // BOTH run entry points — start_session AND retry_session — must go through this; a lock
  // enforced only in start() lets a retry flash over a tool (e.g. a slow mip install) that
  // still holds the port.
  const acquireRunOwnership = () => deviceQueue.acquire();

  // Every build entry point (start_session / retry_session / start_gen_driver / start_optional_flow)
  // acquires the run through here. Besides the entry's synchronous saveInFlight fast-fail, re-check
  // AFTER the queue is held: a Save Version act can begin during the entry's pre-run awaits
  // (checkProtocolVersion / auth.getToken / ensureProjectGitRepo), and its `add -A` would then race
  // the run about to start. saveInFlight is set synchronously by the save acts, and controller.run()
  // flips isRunning() synchronously before its first await, so this post-acquire point is the
  // airtight barrier — a build that finds a save in flight releases the queue and bails as busy.
  async function beginRun(): Promise<(() => void) | null> {
    const release = await acquireRunOwnership();
    // A Save Version act may have started during the entry's pre-run awaits (protocol / auth /
    // ensureGitRepo) — refuse the run so its add -A can't race the save. The caller posts the
    // entry-appropriate busy status (session_busy vs the flow-specific status) on this null.
    if (saveInFlight) { release(); return null; }
    // Commit this run: block saves until it releases (covers the post-acquire async gap before
    // isRunning() flips). The wrapped release clears the flag in the caller's finally.
    runPending = true;
    return () => { runPending = false; release(); };
  }

  // Upload: pick a local file, write it to the current device dir under its basename.
  // The read + write run INSIDE runDeviceTool so a read failure surfaces as device_tool_error
  // (not an unhandled rejection); the device path is validated by writeUserDeviceFile.
  async function handleDeviceUpload(dir: string) {
    const picked = await vscode.window.showOpenDialog?.({ canSelectMany: false });
    const uri = picked?.[0];
    if (!uri) return;
    const base = uri.fsPath.split(/[\\/]/).pop();
    const remote = dir ? `${dir.replace(/\/$/, "")}/${base}` : base;
    await runDeviceTool("upload", { remote }, async () => {
      // Raw bytes, not a decoded string: writeUserDeviceFile base64s them so binaries
      // (.mpy, images) round-trip intact. TextDecoder would corrupt non-UTF-8 silently.
      await shim.writeUserDeviceFile(remote, await vscode.workspace.fs.readFile(uri));
      return { path: remote };
    });
  }

  // A workspace path for `base` that does not clobber an existing file: x.py -> x (1).py.
  // Throws once every dedup slot is taken rather than returning the clobbering path — the
  // caller runs this inside runDeviceTool, so the throw surfaces as device_tool_error.
  function uniqueLocalPath(base: string): string {
    const first = join(workspaceFolder!, base);
    if (!existsSync(first)) return first;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 1; n <= MAX_DOWNLOAD_DEDUP; n++) {
      const candidate = join(workspaceFolder!, `${stem} (${n})${ext}`);
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("too_many_download_duplicates");
  }

  // Download: copy a device file into the workspace and open it — device files have no
  // read-to-string on the shim, so copy+open is the "view" path. Basename only, split on
  // BOTH separators (a device name with a backslash must not escape the workspace on
  // Windows) and rejecting traversal; never silently clobber an existing workspace file.
  async function handleDeviceDownload(remotePath: string) {
    if (!workspaceFolder) { webview.postMessage({ type: "device_tool_error", command: "download", error: "no_workspace_folder" }); return; }
    const base = remotePath.split(/[\\/]/).pop() ?? "";
    if (!base || base === "." || base === "..") { webview.postMessage({ type: "device_tool_error", command: "download", error: "invalid_device_path" }); return; }
    // uniqueLocalPath runs INSIDE runDeviceTool so a dedup-exhaustion throw surfaces as
    // device_tool_error (not an unhandled rejection).
    await runDeviceTool("download", { remotePath }, async () => {
      const localPath = uniqueLocalPath(base);
      await shim.copyFromDevice(remotePath, localPath);
      // The copy IS the success signal. Opening the saved file is a best-effort nicety, and VS Code
      // rejects showTextDocument on binary content — that must NOT turn a good download into a
      // device_tool_error. Fall back to revealing it in the OS file manager (PR #31 review,
      // finding 4). This swallow is a post-save UI open, not an fs read, so register #8 (swallow
      // only ENOENT) does not apply.
      try { await vscode.window.showTextDocument?.(vscode.Uri.file(localPath)); }
      catch { try { await vscode.commands?.executeCommand?.("revealFileInOS", vscode.Uri.file(localPath)); } catch { /* open is optional */ } }
      return { path: remotePath, localPath };
    });
  }

  webview.onDidReceiveMessage(async (message: any) => {
    if (message.type === "request_gen_driver_config") {
      // The panel renders its input tabs from the schema module (single source of truth). The
      // current-missing-driver tab is materialized from this session's manifest so its cold-driver
      // picker reflects the live project (or shows an empty state when there is none).
      webview.postMessage({ type: "gen_driver_config", tabs: materializeGenDriverTabs(GEN_DRIVER_TABS, controller.getLatestManifest(), controller.getDriverReadyBlocks()) });
      return;
    }
    if (message.type === "request_support_config") {
      // Contacts/diagnostics come from the config module (single source of truth), never
      // hardcoded in the webview render.
      const contacts = orderContactsByLocale(SUPPORT_CONTACTS, vscode.env?.language ?? "en");
      webview.postMessage({ type: "support_config", contacts, diagnosticsFields: SUPPORT_DIAGNOSTICS_FIELDS, issueTypes: ISSUE_TYPES });
      return;
    }
    if (message.type === "open_support_panel") {
      // §6.3: opening the support entry is recorded in Activity (§8.1 support_feedback_opened).
      controller.recordSupportAction({ type: "support_feedback_opened", entry: "panel" });
      return;
    }
    if (message.type === "copy_support_contact" && typeof message.contactId === "string") {
      // Copy a support contact's value. Look it up in the config BY ID (never copy the
      // webview-echoed text — untrusted), then record the §8.1 event.
      const contact = SUPPORT_CONTACTS.find((c) => c.id === message.contactId);
      if (contact?.value) {
        try {
          await vscode.env?.clipboard?.writeText?.(contact.value);
        } catch {
          // clipboard unavailable (e.g. headless host) — ignore
        }
        controller.recordSupportAction({ type: "support_feedback_opened", entry: contact.id, action: "copy" });
      }
      return;
    }
    if (message.type === "request_partners") {
      // Serve the home partner logos as data URIs (config-driven; logos read from disk).
      // A partner whose logo fails to resolve is still sent (logo: null) so the webview
      // renders its name as a text fallback instead of dropping the whole partner area.
      const partners = PARTNERS.map((p) => ({ id: p.id, name: p.name, url: p.url, logo: readPartnerLogo(p.file) }));
      webview.postMessage({ type: "partners_config", partners });
      return;
    }
    if (message.type === "request_diagnostics") {
      // Gather env diagnostics on demand so a bug report carries an actionable snapshot.
      const diag = collectDiagnostics(vscode, controller.getDiagnostics(), shim.getPort?.() ?? "");
      webview.postMessage({ type: "diagnostics", ...diag });
      // §6.3: exporting diagnostics must be recorded in Activity (§8.1 support_diagnostics_exported).
      controller.recordSupportAction({ type: "support_diagnostics_exported", scope: diag.fields.session_id ? "session" : "plugin" });
      return;
    }
    if (message.type === "submit_issue_report") {
      // Host-validate the untrusted form: require a description, allowlist the type (else
      // "other"), cap lengths. Attach the diagnostics snapshot when asked, then open a
      // prefilled GitHub issue URL through the same scheme-guarded path as open_external.
      const description = String(message.description ?? "").trim().slice(0, ISSUE_DESC_MAX);
      if (!description) return;
      const issueType = (ISSUE_TYPES as readonly string[]).includes(message.issueType) ? message.issueType : "other";
      const contact = String(message.contact ?? "").trim().slice(0, ISSUE_CONTACT_MAX);
      const diagnosticsText = message.attachDiagnostics ? collectDiagnostics(vscode, controller.getDiagnostics(), shim.getPort?.() ?? "").text : undefined;
      try {
        // Build inside the try: buildIssueReportUrl is code-point-safe, but a malformed input must
        // degrade gracefully rather than throw an unhandled rejection that also skips the §8.1 event.
        const url = buildIssueReportUrl({ issueType, description, contact, diagnosticsText });
        const uri = vscode.Uri.parse(url, true);
        if (/^https?$/.test(uri.scheme)) await vscode.env?.openExternal?.(uri);
      } catch {
        // malformed URL or headless host without openExternal — ignore
      }
      controller.recordSupportAction({ type: "support_feedback_opened", entry: "report_issue" });
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
          // Record only when the opened URL is a known support contact (host-side match, so
          // partner/board links never record and the webview can't spoof the entry). §8.1.
          const contact = SUPPORT_CONTACTS.find((c) => c.url === message.url);
          if (contact) controller.recordSupportAction({ type: "support_feedback_opened", entry: contact.id });
        }
      } catch {
        // malformed URL or headless host without openExternal — ignore
      }
      return;
    }
    if (message.type === "start_gen_driver") {
      // Normalized contract (Ruili 2026-07-06): canonical input is sources[]. Gate on >=1 source or a
      // driver_request, then dispatch the run with the SAME safety as start_session.
      const sources = Array.isArray(message.sources) ? message.sources : [];
      if (!canStartGeneration(sources, message.driverRequest)) {
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: "Add at least one source (or a target driver) before generating." });
        return;
      }
      if (!projectFolder) {
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: "Open a workspace folder to generate a driver." });
        return;
      }
      // Reject a re-entrant run OR a run during a save (register #1/#16), posting the flow-specific
      // status so the gen-driver button un-sticks; then gate protocol + auth like start_session.
      if (controller.isRunning() || saveInFlight) { webview.postMessage({ type: "gen_driver_status", status: "failed", detail: RUN_BUSY_DETAIL }); return; }
      const registry = await checkProtocolVersion(apiBaseUrl, fetchImpl);
      if (registry.warning === "protocol_version_mismatch") {
        webview.postMessage({ type: "session_error", error: "protocol_version_mismatch" });
        webview.postMessage({ type: "session_done", terminal: "session_error" });
        return;
      }
      if (vscode.authentication) {
        const jwt = await auth.getToken(true, { forceRefresh: true });
        if (!jwt) {
          webview.postMessage({ type: "session_error", error: auth.getLastError() ?? "sign_in_required" });
          webview.postMessage({ type: "session_done", terminal: "session_error" });
          return;
        }
      }
      await ensureProjectGitRepo(projectFolder, deps.log);
      // Snapshot the manifest to build the dispatch envelope so mode inference + the pipeline envelope
      // see the cold-driver devices even if the run streams a thin manifest_content (preserveManifest
      // keeps latestManifest from being clobbered by that thin manifest during the excursion).
      const manifestSnapshot = controller.getLatestManifest();
      const releaseRun = await beginRun();
      if (!releaseRun) { webview.postMessage({ type: "gen_driver_status", status: "failed", detail: RUN_BUSY_DETAIL }); return; } // a save slipped in during the pre-run awaits
      try {
        snapshotExistingPaths(projectFolder, preExistingPaths);
        // Stage picked files under projectFolder (containment-reachable), sha256-verified.
        const staged = await stageGenDriverSources(sources, projectFolder);
        const sessionId = randomUUID();
        const envelope = buildGenDriverDispatch({
          sessionId,
          msgId: randomUUID(),
          timestamp: new Date().toISOString(),
          sources: staged,
          manifestContent: manifestSnapshot,
          // Thread the stored gate result: an error-code-only block (e.g. DRIVER_STATUS_UNSUPPORTED) isn't
          // re-derivable from the snapshot manifest alone, so force pipeline when the gate flagged a block.
          blocked: controller.getDriverReadyBlocks().length > 0,
          driverRequest: message.driverRequest,
          verification: message.verification,
        });
        await controller.startPhase({
          phase: GEN_DRIVER_ENVELOPE_PHASE,
          envelope: JSON.stringify(envelope),
          manifest: manifestSnapshot,
          boardId: message.boardId,
          label: "gen-driver run",
        });
      } catch (error: any) {
        // Staging integrity/copy failure (register #8: surface, never proceed as if staged).
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: error?.message ?? "gen-driver dispatch failed" });
      } finally { releaseRun(); }
      return;
    }
    if (message.type === "start_optional_flow") {
      // Wiring (#60) / diagram (#61) run. Allowlist-map the webview's {flow} to a plugin token (register
      // #1: never let the untrusted string reach body.phase unmapped), and HOST-side re-check that generate
      // actually offered this flow (the webview button gate is not the trust boundary).
      const flow = message.flow;
      const token = flow === "wiring" ? OPTIONAL_FLOW_PHASE_BY_FLOW.wiring : flow === "diagram" ? OPTIONAL_FLOW_PHASE_BY_FLOW.diagram : null;
      if (!token) {
        webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: "Unknown optional flow." });
        return;
      }
      if (!controller.getOptionalNextPhases().some((o) => o?.phase === token)) {
        webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: "Run generate first — this flow is offered after a successful generate." });
        return;
      }
      if (!projectFolder) {
        webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: "Open a workspace folder to run this flow." });
        return;
      }
      // Post the flow-specific status (not bare session_busy) so the optional-flow button un-sticks.
      if (controller.isRunning() || saveInFlight) { webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: RUN_BUSY_DETAIL }); return; }
      const registry = await checkProtocolVersion(apiBaseUrl, fetchImpl);
      if (registry.warning === "protocol_version_mismatch") {
        webview.postMessage({ type: "session_error", error: "protocol_version_mismatch" });
        webview.postMessage({ type: "session_done", terminal: "session_error" });
        return;
      }
      if (vscode.authentication) {
        const jwt = await auth.getToken(true, { forceRefresh: true });
        if (!jwt) {
          webview.postMessage({ type: "session_error", error: auth.getLastError() ?? "sign_in_required" });
          webview.postMessage({ type: "session_done", terminal: "session_error" });
          return;
        }
      }
      await ensureProjectGitRepo(projectFolder, deps.log);
      const releaseRun = await beginRun();
      if (!releaseRun) { webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: RUN_BUSY_DETAIL }); return; } // a save slipped in during the pre-run awaits
      try {
        snapshotExistingPaths(projectFolder, preExistingPaths);
        const sessionId = randomUUID();
        // Persist the upstream generate result under projectFolder so the run can read it via
        // source_phase_complete_path. The plugins' validate_upstream requires the FULL phase_complete
        // MESSAGE (type + message-level phase + payload), not the bare payload the controller stores, so
        // wrap it. Relative POSIX path (register #10), reachable by the run's cwd containment.
        let sourcePhaseCompletePath: string | undefined;
        const generatePc = controller.getLatestGeneratePhaseComplete();
        if (generatePc) {
          sourcePhaseCompletePath = ".mpyhw/phase_complete.upy_generate_plugin.json";
          const upstream = wrapGeneratePhaseComplete(generatePc, controller.getOptionalNextPhases(), { sessionId, msgId: randomUUID(), timestamp: new Date().toISOString() });
          await mkdir(join(projectFolder, ".mpyhw"), { recursive: true });
          await writeFile(join(projectFolder, ".mpyhw", "phase_complete.upy_generate_plugin.json"), JSON.stringify(upstream), "utf8");
        }
        const envelope = buildOptionalFlowDispatch(flow, { sessionId, msgId: randomUUID(), timestamp: new Date().toISOString(), sourcePhaseCompletePath });
        const runStartMs = Date.now();
        await controller.startPhase({ phase: token, envelope: JSON.stringify(envelope), boardId: message.boardId, label: `${flow} run` });
        // The plugin can't render in its sandbox, so it reports the run "partial" even when the diagram
        // JSON is complete — that partial is EXACTLY why the host renders, so accept success OR partial.
        // But require THIS run to have freshly written docs/<kind>.json (mtime at/after run start), so a
        // cancel/error that wrote nothing, or a stale prior-run doc, still skips (reviewer high-a). Always
        // post a status so the trigger button restores either way.
        const runInfo = controller.getLastPhaseComplete();
        const producedOutput = runInfo?.result === "success" || runInfo?.result === "partial";
        // Honor an explicit network-render denial: the plugin asks (network_rendering "ask") and a deny
        // yields partial + a structured network_permission.decision "deny" and/or a *_PERMISSION_DENIED
        // code (DIAGRAM_/WIRING_IMAGE_RENDER_). The host must NOT then send the diagram to mermaid.ink
        // anyway. (A transient *_NETWORK_FAILED is not a denial, so it still renders/retries.)
        const deniedNetwork = isNetworkRenderDenied(runInfo);
        const docJson = join(projectFolder, "docs", flow === "wiring" ? "wiring.json" : "diagram.json");
        let freshDoc = false;
        try { freshDoc = existsSync(docJson) && statSync(docJson).mtimeMs >= runStartMs; }
        catch (statErr: any) { freshDoc = false; deps.log?.(`optional-flow ${flow} stat failed: ${statErr?.message ?? statErr}`); }
        if (!producedOutput) {
          webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: `The ${flow} run did not complete — retry to generate it.` });
        } else if (deniedNetwork) {
          webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: `Network render declined — ${flow} data saved, no image. Retry and allow the network render to generate it.` });
        } else if (!freshDoc) {
          webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: `The ${flow} run wrote no fresh ${flow}.json to render — retry.` });
        } else {
          // Post-run render: the plugin authors docs/<kind>.json but can't render the image in its
          // sandbox, so the host runs render_<kind>_local.py (-> mermaid.ink) to produce the png, then
          // re-indexes so the tab shows it and drops a jump card into Activity. render_mermaid_image has
          // no per-call retry, so one transient mermaid.ink blip fails the whole render — retry once
          // (idempotent, overwrites the same pngs) with a short backoff before surfacing a failure.
          const renderOnce = () => (flow === "wiring" ? shim.renderWiring(projectFolder, "png") : shim.renderDiagram(projectFolder, "png"));
          let rendered = false;
          for (let attempt = 0; attempt < 2 && !rendered; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
            try { await renderOnce(); rendered = true; }
            catch (renderErr: any) { deps.log?.(`optional-flow ${flow} render attempt ${attempt + 1} failed: ${renderErr?.message ?? renderErr}`); }
          }
          if (rendered) {
            refreshArtifacts();
            webview.postMessage({ type: "optional_flow_done", flow });
          } else {
            webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: `${flow} data generated, but the image render (mermaid.ink) failed — retry to render it.` });
          }
        }
      } catch (error: any) {
        webview.postMessage({ type: "optional_flow_status", flow, status: "failed", detail: error?.message ?? "optional flow dispatch failed" });
      } finally { releaseRun(); }
      return;
    }
    if (message.type === "pick_gen_driver_file") {
      // The host owns the file dialog; return the path plus integrity metadata so the
      // source payload records what was uploaded (sha256 lets the plugin dedupe/verify).
      const filters = GEN_DRIVER_FILE_FILTERS[message.accept];
      const picked = await vscode.window.showOpenDialog?.({ canSelectMany: false, ...(filters ? { filters } : {}) });
      const path = picked?.[0]?.fsPath;
      if (!path) return;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (error) {
        // Surface a read failure instead of an unhandled rejection (a picked file can vanish
        // or be unreadable between the dialog and the read).
        webview.postMessage({ type: "gen_driver_status", status: "failed", detail: `Could not read the picked file: ${(error as NodeJS.ErrnoException).message}` });
        return;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      webview.postMessage({ type: "gen_driver_file_picked", tabId: message.tabId, key: message.key, name: basename(path), path, size: bytes.length, sha256, uploaded_at: new Date().toISOString() });
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
      await refreshCredits();
    }
    if (message.type === "start_session") {
      // Reject a re-entrant run at the entry point (register #1: the webview is not the trust
      // boundary). acquireRunOwnership() now HOLDS the queue for the whole run, so without this a
      // second start_session would block on the queue and then run a duplicate once the first run's
      // finally clears controller.abort — the reject-while-busy guard in controller.start() would be
      // dead by then. The queue lock only orders legitimate owners.
      if (controller.isRunning()) { webview.postMessage({ type: "session_busy" }); return; }
      // A Save Version act (commit/snapshot) is a sub-second host round-trip that does `add -A`.
      // Refuse to start a build while one is in flight so the commit can't capture half-written
      // build output, and the build can't race the index — the save clears saveInFlight in finally.
      if (saveInFlight) { webview.postMessage({ type: "session_busy" }); return; }
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
      // Serial-port lock (spec §41), other direction: wait for any in-flight device-tool
      // command (e.g. a slow mip install) to finish before the run takes the port, so a
      // flash/deploy never competes with a user device command.
      const releaseRun = await beginRun();
      if (!releaseRun) { webview.postMessage({ type: "session_busy" }); return; } // a save slipped in during the pre-run awaits
      try {
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
      } finally { releaseRun(); } // free the port for device tools once the run reaches its terminal
    }
    if (message.type === "retry_session") {
      // Same re-entrancy guard as start_session: a stale retry must not queue behind the held run
      // and then re-issue the last turn after it finishes (register #1). retry() re-enters run().
      if (controller.isRunning()) { webview.postMessage({ type: "session_busy" }); return; }
      if (saveInFlight) { webview.postMessage({ type: "session_busy" }); return; } // a save's add -A must not race this run
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
      // Same acquire step as start_session: retry() re-enters run() which takes the port,
      // so it must also drain the device queue first (otherwise the lock is one-directional).
      const releaseRun = await beginRun();
      if (!releaseRun) { webview.postMessage({ type: "session_busy" }); return; } // a save slipped in during the pre-run awaits
      try { await controller.retry(); }
      finally { releaseRun(); } // hold the port for the retried run, release at its terminal
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
    if (message.type === "device_tool_list") {
      const path = typeof message.path === "string" ? message.path : "";
      await runDeviceTool("list", { path }, async () => ({ path, entries: await shim.listDir(path) }));
    }
    // Distinct command ("list_lib") so the /lib listing for the Packages "Installed" view
    // does NOT repaint the Board files pane (which keys on command "list").
    if (message.type === "device_tool_list_lib") {
      await runDeviceTool("list_lib", {}, async () => ({ entries: await shim.listDir("/lib") }));
    }
    if (message.type === "device_tool_mkdir" && typeof message.path === "string") {
      await runDeviceTool("mkdir", { path: message.path }, async () => { await shim.makeDir(message.path); return { path: message.path }; });
    }
    if (message.type === "device_tool_delete" && typeof message.path === "string") {
      const now = Date.now();
      const armed = pendingDelete;
      if (armed && armed.path === message.path && armed.nonce === message.nonce && now < armed.expiresAt) {
        pendingDelete = null; // one-shot: consume the nonce so a duplicate confirm can't re-delete
        await runDeviceTool("delete", { path: message.path }, async () => { await shim.removePath(message.path); return { path: message.path }; });
      } else {
        // First click, or a stale/expired/mismatched nonce: arm and wait for the webview to
        // echo the nonce. Nothing is deleted, so a duplicated bare message is harmless.
        const nonce = randomUUID();
        pendingDelete = { path: message.path, nonce, expiresAt: now + DELETE_ARM_TTL_MS };
        webview.postMessage({ type: "device_tool_delete_armed", path: message.path, nonce });
      }
    }
    if (message.type === "device_tool_mip" && typeof message.url === "string") {
      const version = typeof message.version === "string" && message.version ? message.version : undefined;
      await runDeviceTool("mip_install", { url: message.url, version }, async () => { await shim.installPackage(message.url, version); return { url: message.url }; });
    }
    if (message.type === "device_tool_uninstall" && typeof message.name === "string") {
      const now = Date.now();
      const armed = pendingUninstall;
      if (armed && armed.name === message.name && armed.nonce === message.nonce && now < armed.expiresAt) {
        pendingUninstall = null; // one-shot: consume the nonce so a duplicate confirm can't re-run
        await runDeviceTool("uninstall", { name: message.name }, async () => { const removed = await shim.uninstallPackage(message.name); return { name: message.name, removed }; });
      } else {
        // First click, or a stale/expired/mismatched nonce: arm and wait for the webview to echo
        // the nonce. Nothing is removed, so a duplicated bare message is harmless.
        const nonce = randomUUID();
        pendingUninstall = { name: message.name, nonce, expiresAt: now + DELETE_ARM_TTL_MS };
        webview.postMessage({ type: "device_tool_uninstall_armed", name: message.name, nonce });
      }
    }
    if (message.type === "package_search") {
      await handlePackageSearch(
        typeof message.source === "string" ? message.source : "auto",
        typeof message.query === "string" ? message.query : "",
      );
    }
    if (message.type === "package_resolve" && typeof message.url === "string") {
      try {
        const record = await packageBrowserClient.upypiResolve(message.url);
        // Echo the requested url so the webview can drop a late resolve that would fill the
        // wrong (since-collapsed / re-expanded) row — else Install under B installs A.
        webview.postMessage({ type: "package_resolve_result", record, url: message.url });
      } catch (error: any) {
        webview.postMessage({ type: "package_resolve_error", url: message.url, error: error?.code ?? "resolve_failed" });
      }
    }
    if (message.type === "device_tool_upload") {
      await handleDeviceUpload(typeof message.dir === "string" ? message.dir : "");
    }
    if (message.type === "device_tool_download" && typeof message.path === "string") {
      await handleDeviceDownload(message.path);
    }
    if (message.type === "device_presence") {
      // Device Tools presence poll: a host-side port scan (lists ports, never opens one, so
      // it's safe during a flash) lets the tab show "no device" and revert on unplug. Carry the
      // ports so the webview can detect a board SWAP (A on COM3 -> B on COM7) between polls that
      // never reports zero, and drop A's installed state instead of deleting off the wrong board.
      // Gate on venvReady() first: shim.scan() lazily bootstraps the venv (a blocking
      // pip/venv install), and this poll fires every 2.5s — a broken venv would otherwise
      // retrigger that install on every tick. No venv -> answer "no device", don't spawn.
      // Memoized (venvReadyForPoll) so the healthy steady state doesn't re-spawn the probe.
      if (!venvReadyForPoll()) {
        // Absent venv (never set up) -> tell Device Tools to offer environment setup instead of a
        // silent "No device": the presence poll USED to bootstrap the venv via shim.scan(), and
        // gating it (venvReadyForPoll) removed that, so a fresh install would hide the board
        // forever. A present-but-broken venv (exists but venvReady() false) stays silent.
        webview.postMessage({ type: "device_present", present: false, ports: [], needsEnvSetup: !venvExistsFn() });
      } else {
        try { const ports = await shim.scan(); webview.postMessage({ type: "device_present", present: ports.length > 0, ports }); }
        catch { webview.postMessage({ type: "device_present", present: false, ports: [] }); }
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
        venvReady: venvReadyFn,
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
    if (message.type === "open_project_folder") {
      // Open a LOCAL project folder as the workspace root so generate/deploy target it. Its own entry,
      // distinct from Import (which restores a saved SESSION) — this is the old "import_project" body,
      // now honestly labeled. Native folder picker, then vscode.openFolder.
      try {
        const picked = await vscode.window?.showOpenDialog?.({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Open Folder" });
        if (picked && picked[0]) await vscode.commands?.executeCommand?.("vscode.openFolder", picked[0]);
      } catch {
        // dialog/command unavailable (e.g. headless host) — ignore
      }
    }
    if (message.type === "import_session") {
      // Restore a saved session: pick its session FOLDER (portable — a snapshot copied from another
      // machine works too), then rehydrate from its checkpoints/snapshot.json.
      let picked: any;
      try { picked = await vscode.window?.showOpenDialog?.({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Import Session" }); }
      catch { picked = undefined; } // dialog unavailable (headless) — nothing to do
      if (picked && picked[0]) { const dir = String(picked[0].fsPath); await doRestoreFromDir(dir, basename(dir)); }
    }
    if (message.type === "restore_session" && typeof message.id === "string" && message.id) {
      // Restore one of THIS project's recent sessions (selected in the Recent Sessions list). The id
      // resolves to its dir under the session root; a session with no snapshot degrades in doRestoreFromDir.
      if (sessionRoot) await doRestoreFromDir(join(sessionRoot, ".mpyhw", "sessions", message.id), message.id);
      else vscode.window?.showInformationMessage?.("No session storage available to restore from.");
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
            // §8.1: a session-log export is a diagnostics export (closest-fit event name).
            controller.recordSupportAction({ type: "support_diagnostics_exported", scope: "session", kind: "session_log" });
          } catch (error: any) {
            webview.postMessage({ type: "logs_status", text: `Export failed: ${error?.message ?? error}` });
          }
        }
      }
    }
    if (message.type === "save_version_open") { await computeSaveVersionData(); return; }
    if (message.type === "save_version_commit") { await doSaveVersionCommit(message.message); return; }
    if (message.type === "save_version_snapshot") { await doSaveVersionSnapshot(); return; }
    if (message.type === "ui_prompt_response") {
      // Set the deploy port (if the response carries one) before resolving, so the
      // agent's first device tool always sees the chosen port — no select_device race.
      if (message.answer === "confirm" && message.port) shim.setPort?.(message.port);
      // Flash-confirm card rides serial_port/baud: set the port before resolving so the
      // agent's flash tool sees it (same no-race rationale as the deploy card's port).
      if (message.answer === "flash_now" && message.serial_port) shim.setPort?.(message.serial_port);
      // `feedback` rides along on a plan "revise" so the agent can re-plan; `devices`
      // rides along on a component-confirm so the host knows the kept parts. The
      // protocol approval card also rides selected_ids/text_values/added_items here,
      // which confirmApproval unpacks into the approval_response.
      controller.resolvePrompt(message.promptId, message.answer, { feedback: message.feedback, devices: message.devices, selected_ids: message.selected_ids, text_values: message.text_values, added_items: message.added_items, serial_port: message.serial_port, baud: message.baud });
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
function createLoop(deps: { apiBaseUrl?: string; fetchImpl?: typeof fetch; shim?: any; loopMode?: "agent" | "template"; getAuthToken?: () => Promise<string | undefined>; readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>; writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>; listFiles?: (path: string) => Promise<{ ok: boolean; entries?: string[]; error_kind?: string }>; makeProjectDir?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>; deleteProjectPath?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>; confirmDeviceDelete?: (devicePath: string) => Promise<boolean>; confirmDeviceCopyOverwrite?: (hostPath: string) => Promise<boolean>; projectRoot?: string }) {
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
    if (!isRealContained(root, target)) {
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
    if (!isRealContained(root, base)) {
      return { ok: false as const, error_kind: "path_outside_workspace" };
    }
    const entries: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(dir, name);
        const rel = full.slice(root.length + 1).split(sep).join("/");
        if (lstatSync(full).isDirectory()) { entries.push(rel + "/"); walk(full); } // lstat: a symlinked dir lists as a leaf, never followed (P1-C: no external-name leak / symlink-loop recursion)
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
    if (!isRealContained(root, target)) {
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
    } catch (error) {
      // ENOENT is expected — one of the two candidate bases never exists (dev tree
      // vs packaged VSIX), so a miss on it is normal. Surface anything else
      // (EACCES/EPERM etc.) instead of silently degrading to the text fallback with
      // no diagnostics (recurring finding #8). Log, don't throw: killing the handler
      // for one unreadable logo is worse than falling back to the partner name.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`readPartnerLogo: "${base}${file}" failed`, error);
      }
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
