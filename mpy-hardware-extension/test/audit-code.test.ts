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
