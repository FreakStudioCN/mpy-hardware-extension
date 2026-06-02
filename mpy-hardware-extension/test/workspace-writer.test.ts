import assert from "node:assert/strict";
import test from "node:test";

import { planWorkspaceWrites, writeGeneratedFiles } from "../src/extension/workspace-writer.ts";

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
