import assert from "node:assert/strict";
import test from "node:test";

import { auditCode } from "../src/core/audit-code.ts";

test("audit allows board modules and driver context imports", () => {
  const result = auditCode("import machine\nimport aht20\nfrom time import sleep\n", {
    board: { available_modules: ["machine", "time"] },
    driverContexts: [{ import_names: ["aht20"] }],
  });

  assert.equal(result.ok, true);
});

test("audit rejects imports outside board modules and driver context", () => {
  const result = auditCode("import socket\n", {
    board: { available_modules: ["machine"] },
    driverContexts: [{ import_names: ["aht20"] }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.disallowed_imports, ["socket"]);
});

test("audit allows network modules when declared by the board profile", () => {
  const result = auditCode("import network\nimport socket\nimport ssl\n", {
    board: { available_modules: ["machine", "network", "socket", "ssl"] },
    driverContexts: [],
  });

  assert.equal(result.ok, true);
});

test("audit flags dynamic import / exec / eval that bypass static import checks", () => {
  for (const code of ["os = __import__('os')", "exec('import socket')", "eval('open(\"/etc\")')"]) {
    const result = auditCode(code, { board: { available_modules: ["machine", "time"] }, driverContexts: [] });
    assert.equal(result.ok, false, `should reject: ${code}`);
  }
});

test("audit detects a disallowed import hidden after a semicolon", () => {
  const result = auditCode("x = 1; import socket\n", {
    board: { available_modules: ["machine"] },
    driverContexts: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.disallowed_imports, ["socket"]);
});
