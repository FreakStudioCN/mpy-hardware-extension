import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { BUNDLED_TOOLCHAIN_VERSION, EXTENSION_VERSION, toolchainOutdated } from "../src/core/toolchain-version.ts";

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

// The handshake is two hand-kept constants in two languages that ship down two different
// channels -- the VSIX on a v* tag, the API image on every push to main -- and NOTHING made
// them agree. The comment in each file pointing at the other is the whole enforcement, and it
// has already failed: BUNDLED_TOOLCHAIN_VERSION stayed at "1" across two skills pin moves that
// changed init_scaffold and its firmware templates, so v1 silently covered 65bef88 through
// 5ab8e9c. In the field a drift is INVISIBLE by design -- toolchainOutdated fails open on
// anything it cannot parse and stays quiet when the versions are equal -- so a half-bump warns
// nobody and shows up only as a deploy phase that stalls on a marker the bundled scaffold never
// prints. Read the Python instead of restating it, so the next half-bump fails here.
test("the API's TOOLCHAIN_VERSION and the extension's BUNDLED_TOOLCHAIN_VERSION are the same", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "..", "mpyhw-api", "app", "toolchain.py"), "utf-8");
  // Only the assignment, never a mention inside the docstring that names the other constant.
  const declared = source.match(/^TOOLCHAIN_VERSION\s*=\s*"([^"]*)"/m);
  assert.ok(declared, "no TOOLCHAIN_VERSION assignment found in mpyhw-api/app/toolchain.py");
  assert.equal(
    BUNDLED_TOOLCHAIN_VERSION,
    declared[1],
    `bundled toolchain "${BUNDLED_TOOLCHAIN_VERSION}" != API toolchain "${declared[1]}" — bump BOTH or neither`,
  );
});

// The third hand-kept constant in the same file, and this one has ALREADY shipped wrong: v0.4.1
// and v0.4.2 both released with EXTENSION_VERSION "0.4.0" against a package.json of 0.4.1/0.4.2,
// so section 08 of the support diagnostics named a version the user was not running -- on the two
// most recent releases, and on exactly the artifact support triage reads first. vsce publishes
// the package.json version, so package.json is the truth and the constant is the copy.
test("EXTENSION_VERSION is the version vsce actually publishes", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
  assert.equal(
    EXTENSION_VERSION,
    pkg.version,
    `EXTENSION_VERSION "${EXTENSION_VERSION}" != package.json "${pkg.version}" — diagnostics would name the wrong build`,
  );
});
