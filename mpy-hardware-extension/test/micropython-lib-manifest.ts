// The generate-phase manifest a build produces when one of its devices is a MicroPython-lib
// package: the package is a RUNTIME mip dependency (installed by deploy, never vendored into
// firmware/lib) and its API usage is justified by evidence fields carried on the manifest.
//
// Every shape here is copied from the pinned upstream Skill, not invented:
//   - manifest_content + generate.runtime_dependencies/doc_evidence/builtin_required:
//     upy-generate-plugin/sample/phase_complete.upy_generate_plugin.success.json
//   - the micropython_lib mip entry: the exact object
//     upy-generate-plugin/scripts/download_drivers.py runtime_dependency_for_micropython_lib
//     returns for the aioble driver below (package/version/reason/required_for/target/
//     install_phase/verify_import/source)
//   - devices[].driver for source="micropython_lib": upy-analyze-plugin SKILL.md's extraction
//     contract (package_name/version/install_cmd/api_ref/repo_url) and
//     upy-project-gen-toolchain-spec/project-manifest.schema.json
//
// Fresh objects per call so no test can leak a mutation into another.

// The evidence-bearing driver an analyze phase emits for a MicroPython-lib package.
export function micropythonLibDriver(): any {
  return {
    source: "micropython_lib",
    package_name: "aioble",
    module: "aioble",
    version: "latest",
    install_cmd: "mpremote mip install aioble",
    repo_url: "https://github.com/micropython/micropython-lib",
    // Mandatory alongside source="micropython_lib" (upy-analyze-plugin SKILL.md): it proves
    // the package came from a real search, not from the model's memory.
    search_provider: "micropython_lib_classifier",
    target: "/lib",
    api_ref: {
      import: "import aioble",
      usage: "Use documented aioble async helpers; do not call low-level bluetooth.BLE directly unless cited separately",
    },
  };
}

export function micropythonLibManifest(): any {
  return {
    phase: "generate",
    domain_phase: "generate",
    schema_version: "1.0",
    project_name: "sample-project",
    requirements: { description: "Read temperature and humidity and publish status over BLE." },
    devices: [
      { name: "AHT20", driver: { source: "firmware/lib/ahtx0.py" } },
      { name: "BLE stack", type: "middleware", driver: micropythonLibDriver() },
    ],
    mcu: { model: "ESP32-C3-MINI-1" },
    pinout: [
      { device: "AHT20", pin_name: "SDA", gpio: "5" },
      { device: "AHT20", pin_name: "SCL", gpio: "6" },
    ],
    scaffold_mode: "async",
    generate: {
      mode: "full",
      deploy_plan: { firmware_root: "firmware", entrypoint: "firmware/main.py" },
      runtime_dependencies: {
        mip: [
          { package: "unittest", reason: "device/tests import unittest", required_for: ["device_tests"], target: "/lib", version: "latest", install_phase: "deploy", verify_import: "unittest" },
          { package: "aioble", version: "latest", reason: "BLE stack requires MicroPython-lib package aioble", required_for: ["BLE stack"], target: "/lib", install_phase: "deploy", verify_import: "aioble", source: "micropython_lib" },
        ],
        builtin_required: ["machine", "time", "gc", "sys"],
      },
      doc_evidence: [
        { module: "machine", url: "https://docs.micropython.org/en/latest/library/machine.html", reason: "AHT20 I2C assembly uses machine I2C/Pin APIs" },
        { module: "aioble", url: "https://github.com/micropython/micropython-lib/tree/master/micropython/bluetooth/aioble", reason: "BLE calls are written from the upstream aioble docs, not from memory" },
      ],
    },
  };
}

// What an optional flow (diagram) streams: no devices, no pinout, and none of the
// generate evidence. It must never overwrite the rich manifest above.
export function thinOptionalRunManifest(): any {
  return {
    phase: "diagram",
    domain_phase: "diagram",
    schema_version: "1.0",
    project_name: "sample-project",
  };
}
