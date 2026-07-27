import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { PLUGIN_DIRS } from "../scripts/plugin-dirs.mjs";

// Ask the REAL shim module for its indexed dirs (not a source scan): whatever serve.py indexes at
// runtime is what a run can resolve scripts from. Uses the project venv when present so the shim
// imports the same way the baseline runs it.
function shimPluginDirs(): string[] | null {
  const venvPython = resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = existsSync(venvPython) ? venvPython : (process.platform === "win32" ? "python" : "python3");
  const r = spawnSync(python, ["-c", "import json,serve; print(json.dumps(list(serve._V0_PLUGIN_DIRS)))"], {
    cwd: resolve("python/shim"),
    encoding: "utf-8",
  });
  if (r.error || r.status !== 0) return null;
  return JSON.parse(r.stdout.trim());
}

test("every skill dir the shim indexes is also bundled into the VSIX", () => {
  // The dev-vs-packaged trap: with the dir indexed but not bundled, a script_run resolves on a
  // developer machine (full submodule on disk) and fails script_not_found for every user of the
  // packaged extension. Mutation: add a plugin to serve.py's _V0_PLUGIN_DIRS only, and this fails.
  const indexed = shimPluginDirs();
  assert.ok(indexed, "could not read serve._V0_PLUGIN_DIRS — is the shim venv/python available?");
  assert.ok(indexed.length >= 6, `expected the shim to index the V0 plugin dirs, got ${indexed.length}`);
  const bundled = new Set(PLUGIN_DIRS);
  const missing = indexed.filter((dir) => !bundled.has(dir));
  assert.deepEqual(missing, [], `indexed but not bundled by prepare-vsce: ${missing.join(", ")}`);
});
