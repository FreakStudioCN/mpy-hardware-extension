import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

test("packaged runtime uses API-backed pipeline instead of preview literals", () => {
  const runtime = readFileSync(pkg.main, "utf-8");

  assert.match(runtime, /\/v1\/packages\/resolve/);
  assert.doesNotMatch(runtime, /postPreviewSession/);
  assert.doesNotMatch(runtime, /preview_complete/);
  assert.doesNotMatch(runtime, /TEMP_C=30\.1 LED=ON/);
});

test("extension entry loads in a CommonJS host and exports activate", () => {
  // VS Code's extension host loads the entry via CommonJS require() and injects
  // the vscode API through require("vscode"). An ESM entry can't obtain it and
  // fails to activate. Load the real packaged entry the same way to catch that.
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  loader._load = (request, parent, isMain) =>
    request === "vscode"
      ? { commands: { registerCommand: () => ({}) }, window: {}, ViewColumn: { One: 1 } }
      : original(request, parent, isMain);
  try {
    const entry = require(resolve(pkg.main)) as { activate?: unknown; deactivate?: unknown };
    assert.equal(typeof entry.activate, "function");
    assert.equal(typeof entry.deactivate, "function");
  } finally {
    loader._load = original;
  }
});
