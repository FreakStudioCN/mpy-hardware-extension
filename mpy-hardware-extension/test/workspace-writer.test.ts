import assert from "node:assert/strict";
import test from "node:test";

import { planWorkspaceWrites, writeGeneratedFiles, writeProjectFile } from "../src/extension/workspace-writer.ts";

test("workspace writer plans main.py and manifest.json in selected workspace", () => {
  const plan = planWorkspaceWrites({ workspaceFolder: "C:/project", files: { "main.py": "print(1)", "manifest.json": "{}" } });

  assert.deepEqual(plan.map((item) => item.path), ["C:/project/main.py", "C:/project/manifest.json"]);
});

test("workspace writer refuses overwrite without confirmation", async () => {
  const result = await writeGeneratedFiles({
    workspaceFolder: "C:/project",
    files: { "main.py": "print(1)" },
    exists: async () => true,
    writeFile: async () => undefined,
    confirmOverwrite: async () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "overwrite_rejected");
});

test("workspace writer uses predictable generated path without workspace", () => {
  const plan = planWorkspaceWrites({ generatedRoot: "C:/tmp/mpyhw", files: { "main.py": "print(1)" } });

  assert.equal(plan[0].path, "C:/tmp/mpyhw/main.py");
});

test("workspace writer rejects generated paths outside the safe artifact set", async () => {
  const rejected = ["../outside.py", "C:/outside.py", "/outside.py", "lib/../outside.py", "lib\\sensor.py", "notes.txt", "lib/readme.txt"];

  for (const name of rejected) {
    const result = await writeGeneratedFiles({
      workspaceFolder: "C:/project",
      files: { [name]: "x" },
      exists: async () => false,
      writeFile: async () => undefined,
      confirmOverwrite: async () => true,
    });

    assert.equal(result.ok, false, name);
    assert.equal(result.error_kind, "invalid_generated_path", name);
    assert.equal(result.path, name);
  }
});

test("workspace writer allows main, manifest, and lib python artifacts", () => {
  const plan = planWorkspaceWrites({
    workspaceFolder: "C:/project",
    files: { "main.py": "print(1)", "manifest.json": "{}", "lib/aht20.py": "class AHT20: pass" },
  });

  assert.deepEqual(plan.map((item) => item.path), ["C:/project/main.py", "C:/project/manifest.json", "C:/project/lib/aht20.py"]);
});

test("batch writer turns a filesystem write error into file_write_failed (not an uncaught throw)", async () => {
  // A protected/full disk (e.g. EPERM when cwd is System32) must surface as a
  // readable error result, never an exception the caller has to catch.
  const result = await writeGeneratedFiles({
    workspaceFolder: "C:/project",
    files: { "main.py": "print(1)" },
    exists: async () => false,
    writeFile: async () => { throw new Error("EPERM: operation not permitted"); },
    confirmOverwrite: async () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "file_write_failed");
  assert.equal(result.path, "C:/project/main.py");
});

test("write_project_file turns a filesystem write error into file_write_failed", async () => {
  const result = await writeProjectFile({
    workspaceFolder: "C:/project",
    path: "firmware/main.py",
    content: "print(1)",
    writeFile: async () => { throw new Error("EACCES"); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "file_write_failed");
  assert.equal(result.path, "C:/project/firmware/main.py");
});

test("post-loop batch writer keeps its narrow allowlist (no firmware/ tree leak)", async () => {
  // The firmware/ + project-manifest.json tree is writable only through
  // write_project_file (allowProjectTree). The post-loop batch writer must still
  // reject those paths so the broader allowance can't reach it implicitly.
  for (const name of ["firmware/main.py", "firmware/drivers/aht20_driver/__init__.py", "project-manifest.json", "test/pc/test_sensor.py"]) {
    const result = await writeGeneratedFiles({
      workspaceFolder: "C:/project",
      files: { [name]: "x" },
      exists: async () => false,
      writeFile: async () => undefined,
      confirmOverwrite: async () => true,
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.error_kind, "invalid_generated_path", name);
  }
});
