// Which python a test should spawn.
//
// A test that resolves a bare `python` off PATH is only correct when its CALLER arranged the PATH.
// `npm run baseline` does exactly that, via withVenvOnPath in scripts/venv-path.mjs, which is why
// the suite passes there and why the workaround has been invisible. `npm test` is a documented
// script and arranges nothing: on Windows the first `python` that answers --version is usually a
// system install with none of the project's dependencies, so spawning the real serve.py under it
// fails. That was reported from a Windows checkout as three shim-roundtrip failures, against a
// project whose own .venv was correct and one directory away.
//
// So the test resolves its own interpreter instead of depending on how it was invoked, and the
// baseline's PATH wrapper goes back to being belt-and-braces rather than load-bearing.
//
// The root is a PARAMETER because the callers do not share a venv: the shim round-trip needs the
// extension's .venv, where the shim's dependencies are installed, while the api contract test
// needs mpyhw-api/.venv, where uvicorn and app.main are. Resolving both against one root would
// simply move the failure.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const isWin = process.platform === "win32";

/** The venv interpreter for a project root, or null when that project has no venv. */
export function venvPython(projectRoot: string): string | null {
  const candidate = isWin
    ? join(projectRoot, ".venv", "Scripts", "python.exe")
    : join(projectRoot, ".venv", "bin", "python");
  return answers(candidate) ? candidate : null;
}

/**
 * The interpreter a test should use: the project's own venv when it exists, otherwise whatever
 * PATH offers. Null when nothing answers, which every caller treats as "skip this suite" — a
 * minimal CI image legitimately has no python, and that is not a failure.
 */
export function resolvePython(projectRoot: string): string | null {
  const fromVenv = venvPython(projectRoot);
  if (fromVenv) return fromVenv;
  for (const candidate of ["python", "python3"]) {
    if (answers(candidate)) return candidate;
  }
  return null;
}

function answers(command: string): boolean {
  try {
    return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;  // not on PATH, or not executable
  }
}
