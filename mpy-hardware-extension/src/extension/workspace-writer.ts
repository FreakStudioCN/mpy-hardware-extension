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
    if (await input.exists(item.path) && !await input.confirmOverwrite(item.path)) {
      return { ok: false, error_kind: "overwrite_rejected", path: item.path };
    }
    await input.writeFile(item.path, item.content);
    paths.push(item.path);
  }
  return { ok: true, paths };
}

export function normalizeGeneratedArtifactPath(name: string, options: { allowMain?: boolean; allowManifest?: boolean; allowLib?: boolean; allowProjectTree?: boolean } = {}) {
  const { allowMain = true, allowManifest = true, allowLib = true, allowProjectTree = false } = options;
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) return null;
  if (allowMain && name === "main.py") return name;
  if (allowManifest && name === "manifest.json") return name;
  if (allowLib && segments[0] === "lib" && segments.length >= 2 && name.endsWith(".py")) return name;
  if (allowProjectTree) {
    // The upstream project tree the agent fills during the phase-driven build: the
    // manifest at the project root, plus .py files anywhere under the firmware/ and
    // test/ trees (drivers, tasks, lib, test/pc, test/device). Path traversal,
    // absolute paths, and backslashes are already rejected above, so any accepted
    // path stays inside the project root by construction.
    if (name === "project-manifest.json") return name;
    if ((segments[0] === "firmware" || segments[0] === "test") && segments.length >= 2 && name.endsWith(".py")) return name;
  }
  return null;
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
}) {
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  const safe = normalizeGeneratedArtifactPath(input.path, { allowProjectTree: true });
  if (!safe) return { ok: false as const, error_kind: "invalid_generated_path", path: input.path };
  const target = joinPath(root, safe);
  await input.writeFile(target, input.content);
  return { ok: true as const, path: target };
}

function joinPath(root: string, name: string) {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
