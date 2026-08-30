import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePython, venvPython } from "./venv-python.ts";

// The defect this pins cannot be caught by the suites that suffer from it. On a machine where the
// PATH python and the project venv are the same build, the shim round-trip passes either way --
// which is why it went unnoticed here and surfaced on a Windows checkout, where PATH offered 3.9
// and the project venv held 3.12. So the resolution is asserted directly: what gets returned, not
// whether something downstream happened to work.
//
// posix-only for the same reason as the baseline runner's happy-path test: the stub interpreter is
// a shell script. The Windows branch picks .venv/Scripts/python.exe and is covered by running the
// real suite there, which is where the bug was reported from.
const posixOnly = { skip: process.platform === "win32" ? "stub interpreter is posix-only" : false };

function projectWithVenv(): string {
  const root = mkdtempSync(join(tmpdir(), "venv-python-"));
  const bin = join(root, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  const python = join(bin, "python");
  writeFileSync(python, "#!/bin/sh\necho 'Python 9.9.9 (project venv)'\nexit 0\n");
  chmodSync(python, 0o755);
  return root;
}

test("a project's own venv wins over whatever PATH offers", posixOnly, () => {
  const root = projectWithVenv();
  try {
    const picked = resolvePython(root);
    assert.equal(picked, join(root, ".venv", "bin", "python"), "must resolve inside the project's venv");
    // The point of the fix: NOT a bare command name looked up on PATH.
    assert.notEqual(picked, "python");
    assert.notEqual(picked, "python3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no venv falls back to PATH rather than failing", () => {
  const root = mkdtempSync(join(tmpdir(), "venv-python-bare-"));
  try {
    assert.equal(venvPython(root), null, "no venv means no venv interpreter");
    const picked = resolvePython(root);
    // Whatever the machine has. Null is legitimate on a minimal image with no python at all;
    // what must NOT happen is inventing a path inside a venv that does not exist.
    if (picked !== null) assert.ok(["python", "python3"].includes(picked), `expected a PATH command, got ${picked}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a venv whose interpreter does not run is not offered", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "venv-python-broken-"));
  try {
    const bin = join(root, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    // Present but non-executable: the shape a half-built or permission-broken venv has. Returning
    // it would spawn a failure at every call site instead of falling back to something that works.
    writeFileSync(join(bin, "python"), "not an interpreter\n");
    chmodSync(join(bin, "python"), 0o644);

    assert.equal(venvPython(root), null, "an interpreter that cannot answer --version is not one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
