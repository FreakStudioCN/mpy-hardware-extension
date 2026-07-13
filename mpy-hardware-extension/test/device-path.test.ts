import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDevicePath } from "../src/extension/workspace-writer.ts";

test("sanitizeDevicePath allows any user filename/ext/dir the codegen allowlist would reject", () => {
  // These all fail normalizeGeneratedArtifactPath (only lib/** + firmware/** .py), which is
  // exactly why upload needed its own validator (N1).
  assert.equal(sanitizeDevicePath("boot.py"), "boot.py");         // root, no lib/firmware prefix
  assert.equal(sanitizeDevicePath("data.txt"), "data.txt");       // non-.py
  assert.equal(sanitizeDevicePath("main.py"), "main.py");         // main.py (allowMain:false there)
  assert.equal(sanitizeDevicePath("/lib/x.py"), "/lib/x.py");     // absolute is fine on a device
  assert.equal(sanitizeDevicePath("a/b/c.py"), "a/b/c.py");       // nested
  assert.equal(sanitizeDevicePath("//lib//x.py"), "/lib/x.py");   // collapses redundant slashes
});

test("sanitizeDevicePath rejects traversal, backslash, NUL, and empty", () => {
  for (const bad of ["", "..", "a/../b", "/lib/..", "a\\b.py", "x\0.py", "/", "./x.py"]) {
    assert.equal(sanitizeDevicePath(bad), null, bad);
  }
});
