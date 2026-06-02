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
