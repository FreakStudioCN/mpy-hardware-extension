export async function discoverPython(input: {
  settingPath?: string;
  vscodePythonPath?: string;
  pathPython?: string;
  exists: (path: string) => Promise<boolean>;
}) {
  const candidates = [
    ["setting", input.settingPath],
    ["vscode-python", input.vscodePythonPath],
    ["path", input.pathPython ?? "python"],
  ] as const;
  for (const [source, path] of candidates) {
    if (path && await input.exists(path)) {
      return { ok: true, path, source };
    }
  }
  return { ok: false, error_kind: "python_not_found" };
}
