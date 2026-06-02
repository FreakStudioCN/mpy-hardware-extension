import assert from "node:assert/strict";
import test from "node:test";

import { classifyError } from "../src/core/error-classification.ts";

test("classifies known hardware and package failures", () => {
  assert.equal(classifyError("ImportError: no module named aht20").category, "package_import_error");
  assert.equal(classifyError("OSError: [Errno 19] ENODEV").category, "i2c_device_not_found");
  assert.equal(classifyError("permission denied opening COM3").category, "port_busy");
  assert.equal(classifyError("no serial ports found").category, "device_not_found");
  assert.equal(classifyError("network failure during mip install").category, "package_install_network");
  assert.equal(classifyError("manifest validation failed").category, "manifest_invalid");
});
