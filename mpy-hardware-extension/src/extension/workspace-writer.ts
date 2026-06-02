export function planWorkspaceWrites(input: { workspaceFolder?: string; generatedRoot?: string; files: Record<string, string> }) {
  const root = input.workspaceFolder ?? input.generatedRoot ?? ".mpyhw/generated";
  return Object.keys(input.files).map((name) => ({ path: joinPath(root, name), content: input.files[name] }));
}

export async function writeGeneratedFiles(input: {
  workspaceFolder?: string;
  generatedRoot?: string;
  files: Record<string, string>;
  exists: (path: string) => Promise<boolean>;
  writeFile: (path: string, content: string) => Promise<void>;
  confirmOverwrite: (path: string) => Promise<boolean>;
}) {
  for (const item of planWorkspaceWrites(input)) {
    if (await input.exists(item.path) && !await input.confirmOverwrite(item.path)) {
      return { ok: false, error_kind: "overwrite_rejected", path: item.path };
    }
    await input.writeFile(item.path, item.content);
  }
  return { ok: true };
}

function joinPath(root: string, name: string) {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
