import assert from "node:assert/strict";
import test from "node:test";

import { BUNDLED_TOOLCHAIN_VERSION, toolchainOutdated } from "../src/core/toolchain-version.ts";

test("toolchainOutdated warns only when the server is strictly newer", () => {
  assert.equal(toolchainOutdated("2", "1"), true);
  assert.equal(toolchainOutdated("1", "1"), false); // equal: no warn
  assert.equal(toolchainOutdated("1", "2"), false); // older server: no warn
});

test("toolchainOutdated fails open on unknown/unparseable versions", () => {
  assert.equal(toolchainOutdated(undefined), false);
  assert.equal(toolchainOutdated("abc"), false);
  assert.equal(toolchainOutdated(null), false);
  assert.equal(typeof BUNDLED_TOOLCHAIN_VERSION, "string");
});
