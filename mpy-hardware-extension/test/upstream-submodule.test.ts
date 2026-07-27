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
    "upy-autofix/scripts/triage.py",
    "upy-autofix/scripts/hardware_sanity.py",
    "upy-wiring/scripts/render_wiring_local.py",
    "upy-diagram/scripts/render_diagram_local.py",
  ];
  for (const rel of required) {
    assert.ok(existsSync(join(upstream, rel)), `missing vendored upstream file: ${rel}`);
  }
});

test("V0 plugin scripts the run_v0 host runner resolves + the packager bundles are present", () => {
  // These are run by serve.py's generic run_v0 on the V0 build path and bundled by
  // vendor-plugin-subset.mjs (PLUGIN_DIRS). If any go missing, the full-stack build breaks.
  const required = [
    "upy-analyze-plugin/scripts/init_manifest.py",
    "upy-select-hw-plugin/scripts/select_hw_manifest.py",
    "upy-flash-mpy-firmware-plugin/scripts/firmware_download.py",
    "upy-scaffold-plugin/scripts/init_scaffold.py",
    "upy-generate-plugin/scripts/check_generate_plan.py",
    "upy-generate-plugin/scripts/run_quality_gates.py",
    "upy-generate-plugin/scripts/common.py",
    "upy-deploy-plugin/scripts/deploy_manifest.py",
  ];
  for (const rel of required) {
    assert.ok(existsSync(join(upstream, rel)), `missing V0 plugin script: ${rel}`);
  }
});
