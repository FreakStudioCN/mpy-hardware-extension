// Dynamic-execution builtins that sidestep static import analysis entirely; they
// are never legitimate in generated device code, so they are always disallowed.
const DANGEROUS_CONSTRUCTS: Array<{ token: string; re: RegExp }> = [
  { token: "__import__", re: /\b__import__\s*\(/ },
  { token: "exec", re: /\bexec\s*\(/ },
  { token: "eval", re: /\beval\s*\(/ },
];

export function auditCode(code: string, input: { board: { available_modules: string[] }; driverContexts: Array<{ import_names: string[] }> }) {
  const allowed = new Set(input.board.available_modules);
  for (const context of input.driverContexts) {
    for (const name of context.import_names ?? []) {
      allowed.add(name);
    }
  }
  const disallowed = parseImports(code).filter((name) => !allowed.has(name));
  // Scan for dynamic-exec calls on code with comments and string literals removed,
  // so a comment ("# never use eval()") or a string ("type eval(x)") mentioning a
  // construct isn't mistaken for a real call and made to reject valid code.
  const scannable = stripCommentsAndStrings(code);
  for (const { token, re } of DANGEROUS_CONSTRUCTS) {
    if (re.test(scannable)) disallowed.push(token);
  }
  return disallowed.length ? { ok: false, disallowed_imports: disallowed } : { ok: true, disallowed_imports: [] };
}

function stripCommentsAndStrings(code: string): string {
  // Blank out string contents (triple-quoted first, then single-line) and drop
  // `#` comments. A real exec()/eval() call is never inside quotes or after a `#`,
  // so it survives; text that only mentions one inside a string/comment does not.
  return code
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '""')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
    .replace(/#[^\n]*/g, "");
}

function parseImports(code: string): string[] {
  const imports: string[] = [];
  for (const line of code.split(/\r?\n/)) {
    // Split on ';' so an import chained after another statement (x = 1; import os)
    // is still inspected, not just line-leading imports.
    for (const statement of line.split(";")) {
      const direct = statement.match(/^\s*import\s+([A-Za-z_][\w]*)/);
      const from = statement.match(/^\s*from\s+([A-Za-z_][\w]*)\s+import\s+/);
      if (direct) imports.push(direct[1]);
      if (from) imports.push(from[1]);
    }
  }
  return imports;
}
