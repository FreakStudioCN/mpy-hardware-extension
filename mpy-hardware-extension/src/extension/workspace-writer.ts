import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// Resolve p to its real (symlink-followed) absolute path, tolerating a not-yet-created
// tail: realpath the nearest EXISTING ancestor, then re-append the missing segments.
// Returns null only if nothing along the chain exists (walked past the fs root) or realpath
// fails — the caller treats that as "not contained" rather than falling back to a lexical
// path, so a half-resolved comparison can't be mistaken for containment.
function realResolve(p: string): string | null {
  let existing = resolve(p);
  const tail: string[] = [];
  // Walk up to the nearest existing filesystem ENTRY. lstatSync (the link itself, not its
  // target) with throwIfNoEntry:false: a DANGLING symlink returns Stats (truthy) and stops
  // the walk here, so it is never mistaken for an innocent not-yet-created tail — realpathSync
  // below then throws on the dangling link and we fail closed. existsSync would instead FOLLOW
  // the link, see its missing target, report "absent", and let a write escape through the link
  // to its outside-root target (security P1-C, dangling-symlink case).
  while (!lstatSync(existing, { throwIfNoEntry: false })) {
    const parent = dirname(existing);
    if (parent === existing) return null; // walked past the fs root with nothing present
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    const real = realpathSync(existing);
    return tail.length ? join(real, ...tail) : real;
  } catch {
    return null;
  }
}

// Real-path containment (security P1-C). The lexical resolve()+startsWith checks used by the
// reader / writer / lister / deleter catch `..` but NOT symlinks: a symlink placed under the
// project root (by a workspace the user opened) can redirect a model-driven read/write/delete
// outside the root. Resolve BOTH root and target through realResolve (nearest existing
// ancestor, symlinks followed) so a symlink anywhere in their shared prefix — e.g. a
// symlink/junction-opened workspace whose project root does not exist YET — is normalized
// consistently on both sides; a lexical root vs a realpathed target would otherwise falsely
// report "outside" and break the initial scaffold. Returns true for the root itself and
// anything inside it.
export function isRealContained(root: string, target: string): boolean {
  const realRoot = realResolve(root);
  const realTarget = realResolve(target);
  if (realRoot === null || realTarget === null) return false;
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

// Canonical Set key for pre-existing-path comparisons. resolve() normalizes separators
// and relative segments but NOT letter case — and Windows and (default) macOS filesystems
// are case-insensitive, so `firmware/Main.py` and `firmware/main.py` are the SAME file
// there. Folding case on those platforms keeps the overwrite/delete gate from being
// bypassed by a case-mismatched model path; on Linux different case = different file,
// so the key must stay case-sensitive.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
export function canonicalPathKey(p: string): string {
  const resolved = resolve(p);
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

// Start-of-run project-tree snapshot (deliverables 07 §4): record every existing FILE and
// DIRECTORY (as canonicalPathKey for cross-platform Set matching) into `into`. Called
// before the loop writes anything, so the set is exactly the user's pre-build tree — the
// overwrite/delete gate prompts only for these, never for build output created during the
// run. Directories matter: file_operation(delete) accepts a directory and removes it
// recursively, so a pre-existing dir absent from the set would wipe user files with no
// confirm. Same skip list as the lister (.git / node_modules); unreadable dirs are
// skipped, not fatal.
export function snapshotExistingPaths(root: string | undefined, into: Set<string>) {
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
      into.add(canonicalPathKey(full));
      if (isDir) walk(full);
    }
  };
  walk(resolve(root));
}

// The narrow file-tool scope a fixed-output run installs for its duration: the exact writable
// paths, and the one subtree its mkdir/delete may touch. Both are project-relative POSIX paths.
export type WriteRestriction = { allowedPaths: readonly string[]; subtree: string };

export function planWorkspaceWrites(input: { workspaceFolder?: string; generatedRoot?: string; files: Record<string, string> }) {
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  // Apply the same containment as writeGeneratedFiles: skip any name that fails
  // normalization rather than falling back to the raw name, which would let a
  // path like "../../x" escape the root.
  return Object.keys(input.files)
    .map((name) => ({ name, safe: normalizeGeneratedArtifactPath(name) }))
    .filter((entry): entry is { name: string; safe: string } => entry.safe !== null)
    .map((entry) => ({ path: joinPath(root, entry.safe), content: input.files[entry.name] }));
}

export async function writeGeneratedFiles(input: {
  workspaceFolder?: string;
  generatedRoot?: string;
  files: Record<string, string>;
  // Fixed-output run: the ONLY writable paths for its duration (see normalizeGeneratedArtifactPath).
  allowedPaths?: readonly string[];
  exists: (path: string) => Promise<boolean>;
  writeFile: (path: string, content: string) => Promise<void>;
  confirmOverwrite: (path: string) => Promise<boolean>;
}) {
  const paths: string[] = [];
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  for (const [name, content] of Object.entries(input.files)) {
    const safeName = normalizeGeneratedArtifactPath(name, input.allowedPaths ? { allowedPaths: input.allowedPaths } : {});
    if (!safeName) {
      return { ok: false, error_kind: "invalid_generated_path", path: name };
    }
    const item = { path: joinPath(root, safeName), content };
    // Symlink containment (P1-C): normalizeGeneratedArtifactPath already rejects `..`/absolute,
    // but a pre-existing symlinked dir under root (e.g. `lib`) could still redirect this batch
    // write outside the project — refuse via real-path containment, same as writeProjectFile.
    if (!isRealContained(root, item.path)) {
      return { ok: false, error_kind: "invalid_generated_path", path: name };
    }
    if (await input.exists(item.path) && !await input.confirmOverwrite(item.path)) {
      return { ok: false, error_kind: "overwrite_rejected", path: item.path };
    }
    try {
      await input.writeFile(item.path, item.content);
    } catch {
      // A protected/full/locked target (e.g. EPERM) must surface as a readable
      // result, not an uncaught throw the caller turns into a raw session_error.
      return { ok: false, error_kind: "file_write_failed", path: item.path };
    }
    paths.push(item.path);
  }
  return { ok: true, paths };
}

// Every pattern the project-tree allowlist accepts, each paired with a path that must satisfy
// it. WRITABLE_PATHS_HINT is built from the labels, so a claim cannot be added to the hint
// without adding an example, and the drift guard in workspace-writer.test.ts asserts every
// example is genuinely accepted. That closes the loop: the hint cannot advertise a path the
// writer then refuses, which would send the model into a confident loop -- worse than no hint.
// Exported so the drift guard iterates the SAME source the hint is built from, rather than a
// hand-copied list that could fall out of step with it.
export const WRITABLE_PATTERNS: ReadonlyArray<{ label: string; example: string }> = [
  { label: "any *.json at the project root", example: "manifest_draft.json" },
  { label: "firmware/**.py and firmware/**.md", example: "firmware/main.py" },
  { label: "test/**.py and test/**.md", example: "test/pc/test_x.py" },
  { label: "tools/**.py", example: "tools/flash_device.py" },
  { label: "lib/**.py", example: "lib/helper.py" },
  { label: "docs/**.json", example: "docs/wiring.json" },
  { label: "sessions/**.json and sessions/**.md", example: "sessions/s1/phase_complete.json" },
  { label: ".upy/**.py and .upy/**.json", example: ".upy/scripts/validate.py" },
  { label: "any **/.gitkeep", example: "firmware/assets/.gitkeep" },
  { label: ".flake8, .gitignore, .gitattributes, README.md and LICENSE at the root", example: ".flake8" },
];

// Fed back on every rejected path so a wrong guess costs ONE turn instead of a phase.
// `invalid_generated_path` on its own told the model nothing, so it probed: 12 rejected paths
// in a single run before the turn cap ended the phase.
export const WRITABLE_PATHS_HINT =
  `Writable: ${WRITABLE_PATTERNS.map((p) => p.label).join("; ")}. ` +
  "Executable code must live under firmware/, test/, tools/, lib/ or .upy/, not at the project root.";

// Roots the model prefixes when it describes the project from OUTSIDE the workspace. The
// Skill documents the layout as sessions/<id>/project/firmware/, but a write path here is
// relative to the project dir itself, so these segments are redundant rather than wrong.
// Observed cost: one run spent 5 of its turns re-sending `project/firmware/main.py` and
// `project/generate_plan.json` AFTER the allowlist hint had already been returned, then
// ended on max_turns. The hint says what is allowed; this says what the model probably meant.
const REDUNDANT_PATH_ROOTS: readonly string[] = ["project", "blockless-project", "."];

// The path with ONE known-redundant leading segment removed, or undefined when there is none.
// Deliberately not a general search: stripping arbitrary leading segments would happily turn
// docs/firmware/main.py into firmware/main.py and send the model somewhere it never asked to
// go. Shared so that every fs op resolves a model-supplied path the SAME way. The writer
// accepts `project/firmware/main.py`, so a read, list, mkdir or delete of that path has to
// reach the file the write created, or the model cannot act on its own work.
export function stripRedundantPathRoot(name: string): string | undefined {
  const raw = String(name ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = raw.split("/");
  const [head, ...rest] = segments;
  if (!REDUNDANT_PATH_ROOTS.includes(head)) return undefined;
  // "" when the path IS a bare redundant root: `project` means the project root itself. Callers
  // must test `=== undefined`, not truthiness. suggestWritablePath treats "" as no suggestion,
  // so a bare root is still not a writable target.
  return rest.join("/");
}

export function suggestWritablePath(
  name: string,
  options: Parameters<typeof normalizeGeneratedArtifactPath>[1] = {},
): string | undefined {
  const candidate = stripRedundantPathRoot(name);
  if (!candidate) return undefined;
  return normalizeGeneratedArtifactPath(candidate, options) ? candidate : undefined;
}

export function normalizeGeneratedArtifactPath(name: string, options: { allowMain?: boolean; allowManifest?: boolean; allowLib?: boolean; allowFirmware?: boolean; allowProjectTree?: boolean; allowedPaths?: readonly string[] } = {}) {
  const { allowMain = true, allowManifest = true, allowLib = true, allowFirmware = false, allowProjectTree = false, allowedPaths } = options;
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) return null;
  // A fixed-output run (the Sipeed MaixPy export tool) REPLACES the allowlist instead of extending
  // it: only these exact paths may be written, so firmware/**, project-manifest.json and the rest of
  // the project tree stay denied for as long as the restriction is in force. Checked before the
  // allowMain/allowLib defaults, which are on unless a caller turns them off.
  if (allowedPaths) return allowedPaths.includes(name) ? name : null;
  if (allowMain && name === "main.py") return name;
  if (allowManifest && name === "manifest.json") return name;
  if (allowLib && segments[0] === "lib" && segments.length >= 2 && name.endsWith(".py")) return name;
  // Device-deployable firmware code (drivers/tasks/lib under firmware/). Used by the
  // device deploy step, which flashes code but NOT manifests/docs/PC-tests.
  if (allowFirmware && segments[0] === "firmware" && segments.length >= 2 && name.endsWith(".py")) return name;
  if (allowProjectTree) {
    // The upstream project tree the agent fills during the phase-driven build: the
    // manifest + wiring/diagram JSON at the project root or under docs/, plus .py
    // files anywhere under the firmware/ and test/ trees (drivers, tasks, lib,
    // test/pc, test/device). Path traversal, absolute paths, and backslashes are
    // already rejected above, so any accepted path stays inside the project root.
    // Any JSON at the project root. The plugin flow hands off between phases through root
    // working files (manifest_draft.json, phase_complete_draft.json, current_manifest.json,
    // ...), and permitting only a fixed four sent the model guessing: one run burned its whole
    // turn budget on 12 rejected paths, including a literal `test_write.json` probe. Data only,
    // so this never widens where executable code may land; traversal, absolute paths and the
    // segment charset are already rejected above, and writeProjectFile still enforces real-path
    // containment. Keep WRITABLE_PATHS_HINT in step with any change here.
    if (segments.length === 1 && name.endsWith(".json")) return name;
    if (segments[0] === "docs" && segments.length >= 2 && name.endsWith(".json")) return name;
    // The plugin's per-session bookkeeping under `sessions/<session_id>/`: phase_complete.*.json,
    // session_state*.json and generate_phase_log.md (upy-generate-plugin SKILL.md declares
    // session_root there, and makes the phase_complete artifact a precondition of result=success).
    // Without this the generate phase finished ALL its work, failed the final write, and burned its
    // turn budget reporting a bare max_turns stall. Note makeDir already allowed `sessions/...`, so
    // the model could create the directory and then never write into it.
    // .json/.md ONLY, deliberately: this widens where BOOKKEEPING may be written, never where
    // executable code may be. Traversal/absolute/backslash and the segment charset are rejected
    // above, and writeProjectFile still enforces real-path containment against symlink redirection.
    if (segments[0] === "sessions" && segments.length >= 2 && (name.endsWith(".json") || name.endsWith(".md"))) return name;
    if ((segments[0] === "firmware" || segments[0] === "test") && segments.length >= 2 && name.endsWith(".py")) return name;
    // Scaffold skeleton infrastructure (upy-scaffold-plugin output): standard project config/docs at
    // the root, the tools/ deploy+log scripts, .upy toolchain resources, README markdown, and .gitkeep
    // dir placeholders. Without these the scaffold write fails and the phase reports partial, which can
    // stall the pipeline before generate. Fixed in-tree scaffolding files; traversal/absolute/backslash
    // are already rejected above, and existing files still hit the overwrite guard.
    const base = segments[segments.length - 1];
    if (segments.length === 1 && (name === ".flake8" || name === ".gitignore" || name === ".gitattributes" || name === "README.md" || name === "LICENSE")) return name;
    if (base === ".gitkeep") return name;
    if (segments[0] === "tools" && segments.length >= 2 && name.endsWith(".py")) return name;
    if (segments[0] === ".upy" && segments.length >= 2 && (name.endsWith(".py") || name.endsWith(".json"))) return name;
    if ((segments[0] === "firmware" || segments[0] === "test") && segments.length >= 2 && name.endsWith(".md")) return name;
  }
  return null;
}

// A user-chosen device (MicroPython, POSIX) path for the Device Tools upload flow.
// UNLIKE normalizeGeneratedArtifactPath (the narrow codegen allowlist: only lib/**
// and firmware/** .py), the user picked the file and the target dir, so allow any
// filename/extension and nested dirs; only reject what is unsafe or ambiguous: NUL,
// backslash (not a device separator; would confuse the host-side basename split),
// and empty / "." / ".." segments (traversal). Absolute (leading /) is fine on a
// device. Collapses redundant slashes and preserves absolute-vs-relative.
export function sanitizeDevicePath(path: string): string | null {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\")) return null;
  const absolute = path.startsWith("/");
  const segments = path.split("/").filter((segment) => segment !== "");
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  return (absolute ? "/" : "") + segments.join("/");
}

// Agent-driven single-file write (the write_project_file tool), versus the
// post-loop batch in writeGeneratedFiles. The agent writes into the project tree
// (project-manifest.json + firmware/ + test/) one file at a time as the build
// progresses. Path safety is the allowProjectTree allowlist above; the caller
// injects the real fs writer (mkdir -p + writeFile).
export async function writeProjectFile(input: {
  workspaceFolder?: string;
  generatedRoot?: string;
  path: string;
  content: string;
  writeFile: (path: string, content: string) => Promise<void>;
  // Overwrite gate (deliverables 07 §4): return true to proceed, false to decline. The host
  // injects a guard that returns true for new / session-created targets (silent write) and
  // only asks the user on a still-present pre-existing file. Absent = prior write-through
  // behavior (headless/e2e callers), so this stays backward-compatible.
  guardOverwrite?: (target: string) => Promise<boolean>;
  // Fixed-output run: the ONLY writable paths for the duration of that run (see
  // normalizeGeneratedArtifactPath). Absent = the normal project-tree allowlist.
  allowedPaths?: readonly string[];
}) {
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  const pathOptions = input.allowedPaths ? { allowedPaths: input.allowedPaths } : { allowProjectTree: true };
  // Telling the model the corrected path did NOT work: a measured run was handed
  // the exact corrected path on 12 of 12 rejections and re-sent `project/firmware/main.py` nine times
  // anyway, then died on max_turns. Refusing a path whose meaning is unambiguous costs the
  // whole phase to make a point, so accept it and write where it meant. This is not a guess:
  // the corrected path is re-validated against the SAME allowlist before it is used, and only
  // ONE known-redundant leading segment is ever dropped. Anything else is still refused.
  const safe = normalizeGeneratedArtifactPath(input.path, pathOptions) || suggestWritablePath(input.path, pathOptions);
  if (!safe) {
    return { ok: false as const, error_kind: "invalid_generated_path", path: input.path, allowed: WRITABLE_PATHS_HINT };
  }
  const target = joinPath(root, safe);
  // normalizeGeneratedArtifactPath already rejects `..`/absolute, but a symlinked dir in the
  // project tree could still redirect the write outside root — refuse via real-path containment.
  if (!isRealContained(root, target)) {
    return { ok: false as const, error_kind: "invalid_generated_path", path: input.path };
  }
  if (input.guardOverwrite && !(await input.guardOverwrite(target))) {
    return { ok: false as const, error_kind: "overwrite_declined", path: target };
  }
  try {
    await input.writeFile(target, input.content);
  } catch {
    return { ok: false as const, error_kind: "file_write_failed", path: target };
  }
  // `path` is absolute: the file_written event feeds the artifact index, which wants an
  // absolute path. `relative_path` is what the MODEL may be told, because an absolute path
  // is refused by this very allowlist if the model sends it back on the next write.
  return { ok: true as const, path: target, relative_path: safe };
}

// file_operation(delete) core: containment (refuse the workspace root itself and any path
// outside it — never wipe the project or escape it), an optional guardDelete gate
// (deliverables 07 §4 — confirm before removing a pre-existing user file), then the injected
// remove. force-removing an already-absent path is a success (the desired end-state holds).
// The injected removePath keeps this unit-testable without touching the real fs.
export async function deleteProjectPath(input: {
  workspaceFolder?: string;
  generatedRoot?: string;
  path: string;
  removePath: (target: string) => Promise<void>;
  guardDelete?: (target: string) => Promise<boolean>;
  // Fixed-output run: a project-relative directory the delete may not leave. The recursive remove is
  // the most destructive tool the loop has, so a run allowed to write only sipeed_vision/ must not
  // be able to delete firmware/ or the user's sources. Absent = the whole project tree, as before.
  restrictToSubtree?: string;
}) {
  const root = resolve(input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated");
  const target = resolve(root, input.path);
  if (target === root || !isRealContained(root, target)) {
    return { ok: false as const, error_kind: "path_outside_workspace" };
  }
  // Contained in the restricted subtree (the subtree itself may be removed — it is the run's own
  // output dir — but nothing beside it).
  if (input.restrictToSubtree && !isRealContained(resolve(root, input.restrictToSubtree), target)) {
    return { ok: false as const, error_kind: "path_outside_workspace" };
  }
  if (input.guardDelete && !(await input.guardDelete(target))) {
    return { ok: false as const, error_kind: "delete_declined", path: target };
  }
  try {
    await input.removePath(target);
  } catch {
    return { ok: false as const, error_kind: "delete_failed" };
  }
  return { ok: true as const };
}

function joinPath(root: string, name: string) {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
