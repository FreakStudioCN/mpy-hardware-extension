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

export function normalizeGeneratedArtifactPath(name: string, options: { allowMain?: boolean; allowManifest?: boolean; allowLib?: boolean } = {}) {
  const { allowMain = true, allowManifest = true, allowLib = true } = options;
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) return null;
  if (allowMain && name === "main.py") return name;
  if (allowManifest && name === "manifest.json") return name;
  if (allowLib && segments[0] === "lib" && segments.length >= 2 && name.endsWith(".py")) return name;
  return null;
}

function joinPath(root: string, name: string) {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
