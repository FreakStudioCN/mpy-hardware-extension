import assert from "node:assert/strict";
import test from "node:test";

import { discoverPython } from "../src/extension/python-env.ts";

test("python discovery uses configured path first", async () => {
  const result = await discoverPython({ settingPath: "C:/Python/python.exe", exists: async () => true });

  assert.deepEqual(result, { ok: true, path: "C:/Python/python.exe", source: "setting" });
});

test("python discovery falls back through VS Code extension and PATH", async () => {
  const vscode = await discoverPython({ vscodePythonPath: "py-vscode", exists: async (path) => path === "py-vscode" });
  const path = await discoverPython({ pathPython: "python", exists: async (candidate) => candidate === "python" });
  const missing = await discoverPython({ exists: async () => false });

  assert.equal(vscode.source, "vscode-python");
  assert.equal(path.source, "path");
  assert.equal(missing.error_kind, "python_not_found");
});
