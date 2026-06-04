import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The shim runs these vendored upstream scripts host-side and the packager bundles
// them into the VSIX. If the submodule isn't checked out they silently go missing
// (the shim would then fail at runtime, and the VSIX would ship without them), so
// guard their presence here. Source of truth: third_party at the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const upstream = join(here, "..", "..", "third_party", "MicroPython_Skills");

test("vendored upstream toolchain the shim runs + packages is present (submodule checked out)", () => {
  const required = [
    "upy-project-gen-toolchain-spec/scripts/validate_json.py",
    "upy-project-gen-toolchain-spec/project-manifest.schema.json",
    "upy-project-gen-toolchain-spec/wiring.schema.json",
    "upy-project-gen-toolchain-spec/diagram.schema.json",
    "upy-scaffold/scripts/init_scaffold.py",
    "upy-scaffold/templates/tasks/maintenance.py",
    "upy-scaffold/templates/lib/logger/__init__.py",
    "upy-generate/scripts/download_drivers.py",
  ];
  for (const rel of required) {
    assert.ok(existsSync(join(upstream, rel)), `missing vendored upstream file: ${rel}`);
  }
});
