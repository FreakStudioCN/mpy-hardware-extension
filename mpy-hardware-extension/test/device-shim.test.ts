import assert from "node:assert/strict";
import test from "node:test";

import { DeviceShim } from "../src/extension/device-shim.ts";

test("DeviceShim resolves+caches the port from device.scan and maps loop methods to RPC", async () => {
  const calls: any[] = [];
  const responses: Record<string, any> = {
    "device.scan": { status: "ok", devices: [{ port: "COM7" }] },
    "device.install_package": { status: "ok" },
    "device.write_main_py": { status: "ok" },
    "device.flash_and_run": { status: "ok" },
    "device.serial_read_until": { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] },
  };
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    return responses[method];
  };
  const shim = new DeviceShim(rpc);

  assert.deepEqual(await shim.scan(), ["COM7"]);
  await shim.installPackage("https://upypi.net/pkgs/aht20/1.0.0/package.json");
  await shim.writeMainPy("print('hi')");
  await shim.flashAndRun("main.py");
  const serial = await shim.serialReadUntil(["MPYHW_READY", "TEMP_C="]);

  assert.deepEqual(serial, { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] });
  const install = calls.find((c) => c.method === "device.install_package");
  assert.equal(install.params.port, "COM7"); // first scanned port, cached
  assert.equal(install.params.url, "https://upypi.net/pkgs/aht20/1.0.0/package.json");
  assert.equal(calls.find((c) => c.method === "device.write_main_py").params.code, "print('hi')");
});

test("DeviceShim.probeMicroPython asks the shim and returns the has_micropython boolean", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.probe_micropython" ? { status: "ok", has_micropython: true } : {};
  });

  assert.equal(await shim.probeMicroPython("COM7"), true);
  // The caller already knows the port (from scan) — probe must NOT re-scan or gate on
  // device_selection_required; it just checks the port it was handed.
  assert.deepEqual(calls, [{ method: "device.probe_micropython", params: { port: "COM7" } }]);
});

test("DeviceShim.probeMicroPython reports false when the board has no live REPL", async () => {
  const shim = new DeviceShim(async () => ({ status: "ok", has_micropython: false }));
  assert.equal(await shim.probeMicroPython("COM7"), false);
});

test("DeviceShim requires an explicit choice when multiple ports are scanned", async () => {
  const shim = new DeviceShim(async () => ({ status: "ok", devices: [{ port: "COM7" }, { port: "COM8" }] }));

  await assert.rejects(() => shim.installPackage("u"), /device_selection_required/);

  shim.setPort("COM8");
  await assert.doesNotReject(() => shim.installPackage("u"));
});

test("DeviceShim surfaces device_unavailable when nothing is connected", async () => {
  const shim = new DeviceShim(async () => ({ status: "ok", devices: [] }));
  await assert.rejects(() => shim.installPackage("u"), /device_unavailable/);
});

test("DeviceShim throws the shim's error_kind on a failed device op", async () => {
  const shim = new DeviceShim(async (method: string) =>
    method === "device.scan" ? { devices: [{ port: "COM3" }] } : { status: "error", error_kind: "port_busy" },
  );
  await assert.rejects(() => shim.writeMainPy("x"), /port_busy/);
});

test("DeviceShim.installPackage threads the package version into the RPC (for the upypi mirror URL)", async () => {
  const calls: any[] = [];
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { devices: [{ port: "COM3" }] } : { status: "ok" };
  };
  const shim = new DeviceShim(rpc);

  await shim.installPackage("github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/dht11_driver", "1.0.0");

  const install = calls.find((c) => c.method === "device.install_package");
  assert.equal(install.params.version, "1.0.0", "the real pinned version reaches the shim, not a hardcoded one");
});

test("DeviceShim.installPackage carries the shim's raw message in the thrown error (not just the category)", async () => {
  // A bare error_kind ("network") buckets the failure; the raw mpremote stderr names
  // the cause. The thrown error must keep both so the loop/telemetry/UI can show why.
  const shim = new DeviceShim(async (method: string) =>
    method === "device.scan"
      ? { devices: [{ port: "COM3" }] }
      : { status: "error", error_kind: "network", message: "could not resolve host raw.githubusercontent.com" },
  );
  await assert.rejects(
    () => shim.installPackage("github:org/repo/sensors/dht11_driver"),
    /network: could not resolve host raw\.githubusercontent\.com/,
  );
});

test("DeviceShim rejects unsafe extra device file paths before RPC", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "ok" };
  });

  await assert.rejects(() => shim.writeDeviceFile("../boot.py", "x"), /invalid_generated_path/);

  assert.deepEqual(calls.map((call) => call.method), ["device.scan"]);
});

test("DeviceShim allows lib python extra device files", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "ok" };
  });

  await shim.writeDeviceFile("lib/aht20.py", "class AHT20: pass");

  const write = calls.find((call) => call.method === "device.write_device_file");
  assert.equal(write.params.path, "lib/aht20.py");
});

test("DeviceShim deploys firmware/ code but rejects manifests, docs, and PC tests", async () => {
  const shim = new DeviceShim(async (method: string, params: any) =>
    method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "ok", _path: params.path });

  // firmware/ python (drivers/tasks) is device code → deployed.
  await shim.writeDeviceFile("firmware/drivers/aht20_driver/__init__.py", "x");
  await shim.writeDeviceFile("firmware/tasks/sensor.py", "x");

  // Non-code artifacts and PC tests must NOT reach the board.
  for (const bad of ["project-manifest.json", "docs/diagram.json", "test/pc/test_sensor.py", "firmware/notes.txt"]) {
    await assert.rejects(() => shim.writeDeviceFile(bad, "x"), /invalid_generated_path/, bad);
  }
});

test("DeviceShim.deployFirmwareTree resolves the port and maps to device.deploy_firmware_tree", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM5" }] } : { status: "ok" };
  });

  await shim.deployFirmwareTree("C:/proj/app");

  const deploy = calls.find((c) => c.method === "device.deploy_firmware_tree");
  assert.deepEqual(deploy.params, { project_dir: "C:/proj/app", port: "COM5" });
});

test("DeviceShim.deployFirmwareTree throws the shim's error_kind (e.g. firmware_dir_missing)", async () => {
  const shim = new DeviceShim(async (method: string) =>
    method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "error", error_kind: "firmware_dir_missing" },
  );
  await assert.rejects(() => shim.deployFirmwareTree("C:/proj/app"), /firmware_dir_missing/);
});

test("DeviceShim runs upstream toolchain scripts via script.* RPC (no device/port)", async () => {
  const calls: any[] = [];
  const responses: Record<string, any> = {
    "script.run_validate": { status: "ok", valid: false, exit_code: 1, output: "(root): 'phase' is a required property" },
    "script.run_scaffold": { status: "ok", exit_code: 0, output: "[OK] firmware/board.py" },
    "script.run_download_drivers": { status: "ok", exit_code: 0, output: "[DONE] Driver download complete" },
  };
  const shim = new DeviceShim(async (method: string, params: any) => { calls.push({ method, params }); return responses[method]; });

  const validation = await shim.runValidate("C:/proj/app", "project-manifest.json", "project-manifest");
  assert.deepEqual(validation, { valid: false, output: "(root): 'phase' is a required property", exitCode: 1 });
  assert.deepEqual(calls.find((c) => c.method === "script.run_validate").params, { project_dir: "C:/proj/app", path: "project-manifest.json", schema: "project-manifest" });

  assert.equal((await shim.runScaffold("C:/proj/app", "timer")).output, "[OK] firmware/board.py");
  assert.equal(calls.find((c) => c.method === "script.run_scaffold").params.mode, "timer");

  assert.equal((await shim.runDownloadDrivers("C:/proj/app")).output, "[DONE] Driver download complete");
  // None of these scan for a device — they run host-side against the project dir.
  assert.ok(!calls.some((c) => c.method === "device.scan"), "toolchain scripts must not require a device");
});

test("DeviceShim throws the script error_kind on a failed toolchain run", async () => {
  const shim = new DeviceShim(async () => ({ status: "error", error_kind: "script_failed", message: "boom" }));
  await assert.rejects(() => shim.runScaffold("C:/proj/app"), /script_failed/);
});

test("DeviceShim maps the verify track (static check + simulate) to script.* RPC", async () => {
  const calls: any[] = [];
  const responses: Record<string, any> = {
    "script.run_static_check": { status: "ok", clean: false, flake8: { exit_code: 1, output: "E501 line too long" }, pylint: { exit_code: 0, output: "" } },
    "script.run_simulate": { status: "ok", passed: true, no_tests: false, exit_code: 0, output: "3 passed" },
  };
  const shim = new DeviceShim(async (method: string, params: any) => { calls.push({ method, params }); return responses[method]; });

  const sc = await shim.runStaticCheck("C:/proj/app", "firmware");
  assert.equal(sc.clean, false);
  assert.equal(sc.flake8.output, "E501 line too long");
  assert.deepEqual(calls.find((c) => c.method === "script.run_static_check").params, { project_dir: "C:/proj/app", target: "firmware" });

  const sim = await shim.runSimulate("C:/proj/app");
  assert.deepEqual(sim, { passed: true, noTests: false, output: "3 passed", exitCode: 0 });
  assert.equal(calls.find((c) => c.method === "script.run_simulate").params.target, "test/pc");
});

test("DeviceShim maps render_wiring / render_diagram to script.* RPC (default md, offline)", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => { calls.push({ method, params }); return { status: "ok", output: "wrote docs/diagram.md" }; });

  await shim.renderWiring("C:/proj/app");
  await shim.renderDiagram("C:/proj/app");

  assert.deepEqual(calls.find((c) => c.method === "script.render_wiring").params, { project_dir: "C:/proj/app", format: "md" });
  assert.deepEqual(calls.find((c) => c.method === "script.render_diagram").params, { project_dir: "C:/proj/app", format: "md" });
});

test("DeviceShim maps canonical triage, sanity, pdf extraction, and flash tools to script RPC", async () => {
  const calls: any[] = [];
  const responses: Record<string, any> = {
    "script.run_triage": { status: "ok", exit_code: 0, summary: "flake8 failed", logs: ["E501"], artifacts: ["reports/triage.json"] },
    "script.run_hardware_sanity": { status: "ok", exit_code: 0, summary: "device reachable", observations: ["COM3"] },
    "script.run_extract_pdf": { status: "ok", exit_code: 0, pages: [{ page: 1, text: "datasheet facts" }], output_path: "docs/datasheet.extract.json" },
    "script.run_flash_device": { status: "ok", exit_code: 0, summary: "flashed firmware/main.py" },
  };
  const shim = new DeviceShim(async (method: string, params: any) => { calls.push({ method, params }); return responses[method]; });

  assert.equal((await shim.runTriage("C:/proj/app", "firmware")).summary, "flake8 failed");
  assert.equal((await shim.runHardwareSanity("C:/proj/app")).summary, "device reachable");
  assert.equal((await shim.runExtractPdf("C:/proj/app", "docs/datasheet.pdf", "docs/datasheet.extract.json")).pages[0].text, "datasheet facts");
  shim.setPort("COM8");
  assert.equal((await shim.runFlashDevice("C:/proj/app", "firmware/main.py")).summary, "flashed firmware/main.py");

  assert.deepEqual(calls.find((c) => c.method === "script.run_triage").params, { project_dir: "C:/proj/app", target: "firmware" });
  assert.deepEqual(calls.find((c) => c.method === "script.run_hardware_sanity").params, { project_dir: "C:/proj/app" });
  assert.deepEqual(calls.find((c) => c.method === "script.run_extract_pdf").params, {
    project_dir: "C:/proj/app",
    path: "docs/datasheet.pdf",
    output_path: "docs/datasheet.extract.json",
  });
  assert.deepEqual(calls.find((c) => c.method === "script.run_flash_device").params, { project_dir: "C:/proj/app", path: "firmware/main.py", port: "COM8" });
});
