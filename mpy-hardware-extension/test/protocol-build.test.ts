import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { containLocalPath } from "../src/core/protocol-build.ts";

// cp_from pulls a device file to the HOST, so the model-supplied local destination must be
// contained to the project root — never allowed to write elsewhere on the host (#6 / Codex).
const ROOT = resolve("/work/proj");

test("containLocalPath keeps a normal relative dst inside the project root", () => {
  assert.equal(containLocalPath(ROOT, "logs/run.txt", "/log.txt"), resolve(ROOT, "logs/run.txt"));
});

test("containLocalPath strips a leading slash (device-absolute) into the project root", () => {
  assert.equal(containLocalPath(ROOT, "/main.py", "/main.py"), resolve(ROOT, "main.py"));
});

test("containLocalPath falls back to the device basename when dst is empty", () => {
  assert.equal(containLocalPath(ROOT, "", "/lib/driver.py"), resolve(ROOT, "driver.py"));
});

test("containLocalPath rejects a dst that escapes the project root", () => {
  assert.equal(containLocalPath(ROOT, "../../etc/passwd", "/x"), null);
});
