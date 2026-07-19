import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalPathKey, deleteProjectPath, snapshotExistingPaths, writeProjectFile, normalizeGeneratedArtifactPath } from "../src/extension/workspace-writer.ts";

function capturingWriter() {
  const writes = new Map<string, string>();
  return { writes, writeFile: async (path: string, content: string) => { writes.set(path, content); } };
}

function capturingRemover() {
  const removed: string[] = [];
  return { removed, removePath: async (target: string) => { removed.push(target); } };
}

test("write_project_file writes the manifest and firmware/test tree files", async () => {
  const allowed = [
    "project-manifest.json",
    "generate_plan.json",
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

test("allowProjectTree accepts the scaffold's skeleton infra files (were rejected -> scaffold went partial)", () => {
  const opt = { allowProjectTree: true } as const;
  // These are exactly the files the 2026-07-16 scaffold could not write, which stalled the pipeline
  // before generate. Mutation: revert the scaffold-infra allowlist -> each returns null and this fails.
  assert.equal(normalizeGeneratedArtifactPath(".flake8", opt), ".flake8");
  assert.equal(normalizeGeneratedArtifactPath(".gitignore", opt), ".gitignore");
  assert.equal(normalizeGeneratedArtifactPath("docs/.gitkeep", opt), "docs/.gitkeep");
  assert.equal(normalizeGeneratedArtifactPath("tools/flash_device.py", opt), "tools/flash_device.py");
  assert.equal(normalizeGeneratedArtifactPath("firmware/README.md", opt), "firmware/README.md");
  assert.equal(normalizeGeneratedArtifactPath("README.md", opt), "README.md");
  assert.equal(normalizeGeneratedArtifactPath("LICENSE", opt), "LICENSE");
  assert.equal(normalizeGeneratedArtifactPath(".upy/scripts/validate_json.py", opt), ".upy/scripts/validate_json.py");
  // Still bounded: traversal, absolute, and non-skeleton root files stay rejected.
  assert.equal(normalizeGeneratedArtifactPath("../secret", opt), null, "traversal rejected");
  assert.equal(normalizeGeneratedArtifactPath("/etc/passwd", opt), null, "absolute rejected");
  assert.equal(normalizeGeneratedArtifactPath("evil.sh", opt), null, "arbitrary root file still rejected");
  assert.equal(normalizeGeneratedArtifactPath("tools/hack.sh", opt), null, "non-.py under tools rejected");
});

// ---- Overwrite / delete confirmation gate (deliverables 07 §4) ----

test("write_project_file overwrite guard: a decline blocks the write, an allow proceeds", async () => {
  const declined = capturingWriter();
  const dResult = await writeProjectFile({
    workspaceFolder: "C:/project", path: "firmware/main.py", content: "x",
    writeFile: declined.writeFile,
    guardOverwrite: async () => false,
  });
  assert.equal(dResult.ok, false);
  assert.equal(dResult.error_kind, "overwrite_declined");
  assert.equal(declined.writes.size, 0, "a declined overwrite writes nothing");

  const allowed = capturingWriter();
  const aResult = await writeProjectFile({
    workspaceFolder: "C:/project", path: "firmware/main.py", content: "x",
    writeFile: allowed.writeFile,
    guardOverwrite: async () => true,
  });
  assert.equal(aResult.ok, true);
  assert.equal(allowed.writes.get("C:/project/firmware/main.py"), "x", "an allowed overwrite writes");
});

test("write_project_file with no overwrite guard writes through (headless/e2e back-compat)", async () => {
  const { writes, writeFile } = capturingWriter();
  const result = await writeProjectFile({ workspaceFolder: "C:/project", path: "firmware/main.py", content: "x", writeFile });
  assert.equal(result.ok, true);
  assert.equal(writes.size, 1, "no guard = prior write-through behavior");
});

test("delete_project_path containment refuses the root itself and any path outside it", async () => {
  const cases = ["", ".", "..", "../outside", "/etc/passwd"];
  for (const path of cases) {
    const { removed, removePath } = capturingRemover();
    const result = await deleteProjectPath({ workspaceFolder: "/ws/project", path, removePath });
    assert.equal(result.ok, false, path);
    assert.equal(result.error_kind, "path_outside_workspace", path);
    assert.equal(removed.length, 0, `no remove for ${path}`);
  }
});

test("delete_project_path guard: a decline blocks the remove, an allow proceeds", async () => {
  const declined = capturingRemover();
  const dResult = await deleteProjectPath({
    workspaceFolder: "/ws/project", path: "firmware/main.py",
    removePath: declined.removePath, guardDelete: async () => false,
  });
  assert.equal(dResult.ok, false);
  assert.equal(dResult.error_kind, "delete_declined");
  assert.equal(declined.removed.length, 0, "a declined delete removes nothing");

  const allowed = capturingRemover();
  const aResult = await deleteProjectPath({
    workspaceFolder: "/ws/project", path: "firmware/tools",
    removePath: allowed.removePath, guardDelete: async () => true,
  });
  assert.equal(aResult.ok, true);
  assert.equal(allowed.removed.length, 1, "an allowed delete removes the target");
});

test("delete_project_path with no guard removes (the build's own scratch cleanup, no prompt)", async () => {
  const { removed, removePath } = capturingRemover();
  const result = await deleteProjectPath({ workspaceFolder: "/ws/project", path: "firmware/tools", removePath });
  assert.equal(result.ok, true);
  assert.equal(removed.length, 1, "no guard = removes session-created scratch without prompting");
});

// ---- Start-of-run snapshot: the pre-existing set behind both guards ----

// Regression (#30 review): the snapshot recorded only leaf FILES, but
// file_operation(delete) accepts a directory and rm is recursive — so deleting a
// pre-existing user directory bypassed the confirm card and silently wiped every
// file inside it. Directories must be in the set too.
test("snapshotExistingPaths records pre-existing DIRECTORIES, not just files (dir delete must hit the gate)", () => {
  const root = mkdtempSync(join(tmpdir(), "mpyhw-snap-"));
  try {
    mkdirSync(join(root, "firmware", "drivers"), { recursive: true });
    writeFileSync(join(root, "firmware", "drivers", "custom.py"), "x");
    mkdirSync(join(root, ".git")); // skip-listed
    writeFileSync(join(root, ".git", "config"), "x");

    const snapshot = new Set<string>();
    snapshotExistingPaths(root, snapshot);

    assert.ok(snapshot.has(canonicalPathKey(join(root, "firmware", "drivers", "custom.py"))), "files are recorded");
    assert.ok(snapshot.has(canonicalPathKey(join(root, "firmware"))), "top-level dir is recorded");
    assert.ok(snapshot.has(canonicalPathKey(join(root, "firmware", "drivers"))), "nested dir is recorded — its recursive delete must prompt");
    assert.equal(snapshot.has(canonicalPathKey(join(root, ".git"))), false, ".git stays skip-listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression (#30 review): Set lookups compared resolve() output, which preserves
// letter case — but Windows and default macOS filesystems are case-insensitive, so a
// model path `firmware/main.py` overwrote a pre-existing `firmware/Main.py` with no
// confirm. Keys must fold case exactly where the filesystem does — and must NOT on
// Linux, where different case IS a different file (the #28 platform-mirror lesson).
test("canonicalPathKey folds case only on case-insensitive filesystems (win32/darwin)", () => {
  const a = canonicalPathKey("/ws/project/firmware/Main.py");
  const b = canonicalPathKey("/ws/project/firmware/main.py");
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.equal(a, b, "case-insensitive fs: Main.py and main.py are the same gate key");
  } else {
    assert.notEqual(a, b, "case-sensitive fs: different case = different file, keys must differ");
  }
});

test("snapshot lookups match through a case-mismatched model path on win32/darwin", () => {
  const root = mkdtempSync(join(tmpdir(), "mpyhw-case-"));
  try {
    mkdirSync(join(root, "firmware"));
    writeFileSync(join(root, "firmware", "Main.py"), "user code");
    const snapshot = new Set<string>();
    snapshotExistingPaths(root, snapshot);
    const modelPath = canonicalPathKey(join(root, "firmware", "main.py"));
    if (process.platform === "win32" || process.platform === "darwin") {
      assert.ok(snapshot.has(modelPath), "model's lowercased path must hit the pre-existing Main.py");
    } else {
      assert.equal(snapshot.has(modelPath), false, "on linux main.py is genuinely a different file");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
