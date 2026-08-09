import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WRITABLE_PATHS_HINT, WRITABLE_PATH_EXAMPLES, isRealContained, normalizeGeneratedArtifactPath, planWorkspaceWrites, suggestWritablePath, writeGeneratedFiles, writeProjectFile } from "../src/extension/workspace-writer.ts";

test("isRealContained allows the root and contained paths, refuses ../ escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "mpyhw-contain-"));
  try {
    mkdirSync(join(root, "firmware"));
    assert.equal(isRealContained(root, root), true);
    assert.equal(isRealContained(root, join(root, "firmware", "main.py")), true); // not-yet-created leaf
    assert.equal(isRealContained(root, join(root, "..", "outside.py")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isRealContained refuses a path that escapes via a symlinked directory (P1-C)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "mpyhw-symln-"));
  try {
    const root = join(base, "project");
    const secret = join(base, "secret");
    mkdirSync(root);
    mkdirSync(secret);
    writeFileSync(join(secret, "creds.txt"), "TOP SECRET");
    try {
      symlinkSync(secret, join(root, "escape"), "dir");
    } catch {
      t.skip("symlink creation requires privilege on this platform");
      return;
    }
    // Lexically join(root,"escape","creds.txt") is under root, but really resolves into secret/.
    assert.equal(isRealContained(root, join(root, "escape", "creds.txt")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isRealContained allows a not-yet-created root under a symlink-opened workspace (P1-C #3)", (t) => {
  // Regression: when the workspace is opened through a symlink/junction AND the project
  // root does not exist yet, a lexical root vs a realpathed target used to falsely report
  // "outside" and break the very first scaffold write. Both sides must resolve consistently.
  const base = mkdtempSync(join(tmpdir(), "mpyhw-symroot-"));
  try {
    const physical = join(base, "physical");
    mkdirSync(physical);
    const opened = join(base, "opened"); // symlink standing in for a symlink-opened workspace
    try {
      symlinkSync(physical, opened, "dir");
    } catch {
      t.skip("symlink creation requires privilege on this platform");
      return;
    }
    const root = join(opened, "blockless-project"); // does NOT exist yet
    assert.equal(isRealContained(root, join(root, "main.py")), true);
    assert.equal(isRealContained(root, root), true);
    // A real escape from that same symlinked root is still refused.
    assert.equal(isRealContained(root, join(root, "..", "..", "outside.py")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isRealContained refuses a pre-existing DANGLING symlink whose target is outside root (P1-C dangling)", (t) => {
  // existsSync FOLLOWS a symlink, so a dangling link (target missing) reads as "absent" and
  // would be re-appended under root as a harmless not-yet-created leaf — yet writing through
  // it lands on the link's outside-root target. realResolve must see the link itself (lstat)
  // and fail closed.
  const base = mkdtempSync(join(tmpdir(), "mpyhw-dangle-"));
  try {
    const root = join(base, "project");
    mkdirSync(root);
    const outsideTarget = join(base, "outside", "main.py"); // does NOT exist -> dangling link
    try {
      symlinkSync(outsideTarget, join(root, "main.py"), "file");
    } catch {
      t.skip("symlink creation requires privilege on this platform");
      return;
    }
    assert.equal(isRealContained(root, join(root, "main.py")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("batch writeGeneratedFiles refuses a write through a pre-existing symlinked dir (P1-C #2)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "mpyhw-batchln-"));
  try {
    const root = join(base, "project");
    const secret = join(base, "secret");
    mkdirSync(root);
    mkdirSync(secret);
    try {
      symlinkSync(secret, join(root, "lib"), "dir"); // `lib` redirects outside the project
    } catch {
      t.skip("symlink creation requires privilege on this platform");
      return;
    }
    let wrote = false;
    const result = await writeGeneratedFiles({
      workspaceFolder: root,
      files: { "lib/evil.py": "x" },
      exists: async () => false,
      writeFile: async () => { wrote = true; },
      confirmOverwrite: async () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_kind, "invalid_generated_path");
    assert.equal(wrote, false); // rejected before ever reaching the injected writer
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

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

test("write_project_file accepts the plugin's per-session bookkeeping under sessions/", async () => {
  // upy-generate-plugin SKILL.md declares session_root as sessions/<session_id>/ and makes the
  // phase_complete artifact a precondition of result=success. Rejecting these is what made a
  // finished generate phase burn its turn budget on a write it could never land.
  const written: string[] = [];
  for (const path of [
    "sessions/upy-generate-plugin/phase_complete.upy_generate_plugin.json",
    "sessions/s1/session_state.upy_generate_plugin.json",
    "sessions/s1/generate_phase_log.md",
  ]) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path,
      content: "{}",
      writeFile: async (target: string) => { written.push(target); },
    });
    assert.equal(result.ok, true, path);
  }
  assert.deepEqual(written, [
    "C:/project/sessions/upy-generate-plugin/phase_complete.upy_generate_plugin.json",
    "C:/project/sessions/s1/session_state.upy_generate_plugin.json",
    "C:/project/sessions/s1/generate_phase_log.md",
  ]);
});

test("the sessions/ allowance carries bookkeeping only — never code, never an escape", async () => {
  for (const path of [
    "sessions/s1/evil.py",            // executable code must not ride in on a bookkeeping rule
    "sessions/s1/payload.sh",
    "sessions",                       // the dir itself is not a file
    "sessions/../escape.json",        // traversal stays rejected
    "/sessions/s1/abs.json",          // absolute stays rejected
  ]) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path,
      content: "x",
      writeFile: async () => { throw new Error("must not be written"); },
    });
    assert.equal(result.ok, false, path);
    assert.equal(result.error_kind, "invalid_generated_path", path);
  }
});

test("the post-loop batch writer still rejects sessions/ (the allowance is project-tree only)", async () => {
  const result = await writeGeneratedFiles({
    workspaceFolder: "C:/project",
    files: { "sessions/s1/phase_complete.json": "{}" },
    exists: async () => false,
    writeFile: async () => undefined,
    confirmOverwrite: async () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "invalid_generated_path");
});

test("root-level JSON working files are writable (the plugin hands off through them)", async () => {
  // One run burned its whole turn budget on 12 rejected paths because only four exact root
  // names were permitted. These are the real ones it tried.
  for (const path of ["manifest_draft.json", "phase_complete_draft.json", "current_manifest.json", "phase_complete.select_hw.json"]) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path,
      content: "{}",
      writeFile: async () => undefined,
    });
    assert.equal(result.ok, true, path);
  }
});

test("the root-JSON allowance is data only — code at the root is still refused, with a hint", async () => {
  for (const path of ["_run_lint.py", "evil.sh", "setup.cfg"]) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path,
      content: "x",
      writeFile: async () => { throw new Error("must not be written"); },
    });
    assert.equal(result.ok, false, path);
    assert.equal(result.error_kind, "invalid_generated_path", path);
    // The rejection must say what WOULD work, or the model can only guess.
    assert.equal(result.allowed, WRITABLE_PATHS_HINT, path);
  }
});

// The hint alone was not enough. One measured run spent 5 turns re-sending paths under a
// redundant `project/` prefix AFTER being told what was writable, then died on max_turns.
// The Skill documents the layout as sessions/<id>/project/firmware/, while a write path here
// is relative to the project dir, so the model is following the docs and the guard is right.
test("a redundant project/ prefix is answered with the path the model meant", async () => {
  const cases: Array<[string, string]> = [
    ["project/firmware/main.py", "firmware/main.py"],
    ["project/generate_plan.json", "generate_plan.json"],
    ["project/.flake8", ".flake8"],
    ["blockless-project/firmware/main.py", "firmware/main.py"],
    ["./firmware/main.py", "firmware/main.py"],
    ["project\\firmware\\main.py", "firmware/main.py"],
  ];
  for (const [sent, meant] of cases) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path: sent,
      content: "x",
      writeFile: async () => { throw new Error("must not be written"); },
    });
    assert.equal(result.ok, false, sent);
    assert.equal(result.error_kind, "invalid_generated_path", sent);
    assert.equal(result.did_you_mean, meant, sent);
    assert.equal(result.allowed, WRITABLE_PATHS_HINT, `${sent} still carries the full hint`);
  }
});

test("no suggestion is invented when stripping the prefix would still be refused", async () => {
  // Silence is the correct answer here. A confident wrong suggestion is worse than none:
  // it would send the model down a path it never asked for and cost another turn.
  for (const path of ["project/secrets/key.pem", "docs/firmware/main.py", "evil.sh", "firmware/main.py/../../x.sh"]) {
    const result = await writeProjectFile({
      workspaceFolder: "C:/project",
      path,
      content: "x",
      writeFile: async () => { throw new Error("must not be written"); },
    });
    assert.equal(result.ok, false, path);
    assert.equal(result.did_you_mean, undefined, `${path} must not get a suggestion`);
  }
});

test("suggestWritablePath never proposes a path the writer would refuse", () => {
  // The same closed loop the hint has: a suggestion that is itself rejected would send the
  // model into a confident retry of something that cannot work.
  for (const sent of ["project/firmware/main.py", "project/generate_plan.json", "project/.flake8", "blockless-project/lib/helper.py"]) {
    const meant = suggestWritablePath(sent, { allowProjectTree: true });
    assert.ok(meant, sent);
    assert.ok(normalizeGeneratedArtifactPath(meant!, { allowProjectTree: true }), `${meant} must actually be writable`);
  }
});

test("the writable-paths hint cannot lie — every pattern it advertises is accepted", () => {
  // The hint and these examples are built from ONE table, so a claim cannot be added to the
  // hint without adding an example here, and each example is checked against the real writer.
  // A hint advertising a path the writer refuses is worse than no hint: it sends the model
  // into a confident loop.
  assert.ok(WRITABLE_PATH_EXAMPLES.length >= 10, "every advertised pattern contributes an example");
  for (const path of WRITABLE_PATH_EXAMPLES) {
    assert.equal(
      normalizeGeneratedArtifactPath(path, { allowProjectTree: true }), path,
      `hint advertises a pattern that "${path}" should satisfy, but the writer refuses it`,
    );
  }
  // And the claim the hint makes about code is true.
  assert.match(WRITABLE_PATHS_HINT, /Executable code must live under/);
  for (const rejected of ["main_loop.py", "run.sh"]) {
    assert.equal(normalizeGeneratedArtifactPath(rejected, { allowProjectTree: true }), null, rejected);
  }
});

test("the post-loop batch writer does not inherit the root-JSON allowance", async () => {
  const result = await writeGeneratedFiles({
    workspaceFolder: "C:/project",
    files: { "manifest_draft.json": "{}" },
    exists: async () => false,
    writeFile: async () => undefined,
    confirmOverwrite: async () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "invalid_generated_path");
});
