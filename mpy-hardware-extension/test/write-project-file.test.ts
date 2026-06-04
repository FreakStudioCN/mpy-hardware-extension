import assert from "node:assert/strict";
import test from "node:test";

import { writeProjectFile, normalizeGeneratedArtifactPath } from "../src/extension/workspace-writer.ts";

function capturingWriter() {
  const writes = new Map<string, string>();
  return { writes, writeFile: async (path: string, content: string) => { writes.set(path, content); } };
}

test("write_project_file writes the manifest and firmware/test tree files", async () => {
  const allowed = [
    "project-manifest.json",
    "wiring.json",
    "diagram.json",
    "docs/diagram.json",
    "docs/wiring.json",
    "firmware/main.py",
    "firmware/conf.py",
    "firmware/drivers/aht20_driver/__init__.py",
    "firmware/drivers/aht20_driver/mock.py",
    "firmware/tasks/sensor.py",
    "test/pc/test_sensor.py",
    "test/device/test_smoke.py",
  ];
  for (const path of allowed) {
    const { writes, writeFile } = capturingWriter();
    const result = await writeProjectFile({ workspaceFolder: "C:/project", path, content: "x", writeFile });
    assert.equal(result.ok, true, path);
    assert.equal(result.path, `C:/project/${path}`, path);
    assert.equal(writes.get(`C:/project/${path}`), "x", path);
  }
});

test("write_project_file rejects paths outside the allowed project tree", async () => {
  const rejected = [
    "../outside.py",            // traversal up
    "firmware/../secret.py",    // traversal mid-path
    "/etc/passwd",              // absolute posix
    "C:/Windows/x.py",          // absolute windows
    "firmware\\main.py",        // backslash
    "firmware/notes.txt",       // non-.py under firmware
    "test/pc/data.json",        // non-.py under test
    "notes.txt",                // stray top-level
    "src/extension/x.py",       // outside firmware/test
    ".vscode/settings.json",    // host config
  ];
  for (const path of rejected) {
    const { writes, writeFile } = capturingWriter();
    const result = await writeProjectFile({ workspaceFolder: "C:/project", path, content: "x", writeFile });
    assert.equal(result.ok, false, path);
    assert.equal(result.error_kind, "invalid_generated_path", path);
    assert.equal(writes.size, 0, `no write should happen for ${path}`);
  }
});

test("write_project_file falls back to the generated root without a workspace folder", async () => {
  const { writeFile } = capturingWriter();
  const result = await writeProjectFile({ generatedRoot: "C:/tmp/mpyhw", path: "firmware/main.py", content: "x", writeFile });
  assert.equal(result.ok, true);
  assert.equal(result.path, "C:/tmp/mpyhw/firmware/main.py");
});

test("allowProjectTree extends the allowlist without changing the base set", () => {
  // Base allowlist (post-loop batch writer) stays narrow: the firmware/ tree is
  // only writable through write_project_file (allowProjectTree).
  assert.equal(normalizeGeneratedArtifactPath("firmware/main.py"), null);
  assert.equal(normalizeGeneratedArtifactPath("project-manifest.json"), null);
  assert.equal(normalizeGeneratedArtifactPath("firmware/main.py", { allowProjectTree: true }), "firmware/main.py");
  assert.equal(normalizeGeneratedArtifactPath("project-manifest.json", { allowProjectTree: true }), "project-manifest.json");
  // The base set still works under allowProjectTree (defaults stay on).
  assert.equal(normalizeGeneratedArtifactPath("main.py", { allowProjectTree: true }), "main.py");
  assert.equal(normalizeGeneratedArtifactPath("lib/aht20.py", { allowProjectTree: true }), "lib/aht20.py");
});
