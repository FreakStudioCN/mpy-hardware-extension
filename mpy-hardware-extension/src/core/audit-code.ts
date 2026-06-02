export function auditCode(code: string, input: { board: { available_modules: string[] }; driverContexts: Array<{ import_names: string[] }> }) {
  const allowed = new Set(input.board.available_modules);
  for (const context of input.driverContexts) {
    for (const name of context.import_names ?? []) {
      allowed.add(name);
    }
  }
  const imports = parseImports(code);
  const disallowed = imports.filter((name) => !allowed.has(name));
  return disallowed.length ? { ok: false, disallowed_imports: disallowed } : { ok: true, disallowed_imports: [] };
}

function parseImports(code: string): string[] {
  const imports: string[] = [];
  for (const line of code.split(/\r?\n/)) {
    const direct = line.match(/^\s*import\s+([A-Za-z_][\w]*)/);
    const from = line.match(/^\s*from\s+([A-Za-z_][\w]*)\s+import\s+/);
    if (direct) imports.push(direct[1]);
    if (from) imports.push(from[1]);
  }
  return imports;
}
