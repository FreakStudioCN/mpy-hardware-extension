import { delimiter } from "node:path";

// Return a copy of `env` with `venvBin` prepended to PATH, so a `python`/`python3`
// spawned by a child (e.g. the shim roundtrip in `npm test`) resolves to the project
// venv first instead of a system python earlier on PATH (Windows: system 3.9 vs the
// project .venv 3.12). Finds the real PATH key case-insensitively — on Windows the var
// is usually "Path", so a naive { ...env, PATH } would leave the original "Path" in place
// and add a duplicate. Overriding the found key avoids that. Pure; caller decides when to
// apply it (only when the venv exists).
export function withVenvOnPath(env, venvBin) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: venvBin + delimiter + (env[key] ?? "") };
}
