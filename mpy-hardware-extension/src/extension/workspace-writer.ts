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
  exists: (path: string) => Promise<boolean>;
  writeFile: (path: string, content: string) => Promise<void>;
  confirmOverwrite: (path: string) => Promise<boolean>;
}) {
  const paths: string[] = [];
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  for (const [name, content] of Object.entries(input.files)) {
    const safeName = normalizeGeneratedArtifactPath(name);
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
    if (name === "project-manifest.json" || name === "generate_plan.json" || name === "wiring.json" || name === "diagram.json") return name;
    if (segments[0] === "docs" && segments.length >= 2 && name.endsWith(".json")) return name;
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
  const safe = normalizeGeneratedArtifactPath(input.path, input.allowedPaths ? { allowedPaths: input.allowedPaths } : { allowProjectTree: true });
  if (!safe) return { ok: false as const, error_kind: "invalid_generated_path", path: input.path };
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
  return { ok: true as const, path: target };
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
