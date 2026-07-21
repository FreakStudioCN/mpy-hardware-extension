import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { DeviceShim, killProcessTree, singleFlight } from "../src/extension/device-shim.ts";

// Stop must kill the WHOLE process group, not just the shim: the flash plugin runs esptool as
// a deep descendant, so a plain child.kill() (serve.py only) orphans an in-flight flash that
// then runs to completion (confirmed on real ESP32-C6 hardware). This checks the group-kill
// primitive the fix relies on, against a real detached parent -> grandchild `sleep` tree.
test("killProcessTree takes down the whole group (grandchild), not just the direct child", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX process-group semantics; Windows uses taskkill /T"); return; }
  const parent = spawn("bash", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  parent.on("error", () => {}); // ignore teardown races
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    parent.stdout!.once("data", (d) => resolve(parseInt(String(d).trim(), 10)));
    parent.once("error", reject);
  });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(grandchildPid > 0 && alive(grandchildPid), "grandchild sleep is running before the kill");

  killProcessTree(parent); // a plain parent.kill() would leave the grandchild orphaned

  const dead = await (async () => { for (let i = 0; i < 40; i++) { if (!alive(grandchildPid)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; })();
  assert.equal(dead, true, "killProcessTree killed the grandchild too — the whole group went down");
});

test("singleFlight retries after a failed start (a rejected start is not memoized forever)", async () => {
  // Regression: createDeviceShim's ensure() used `if (!starting) starting = start()`. A pre-spawn
  // failure (python_not_found / venv install) left `starting` a REJECTED promise — still truthy —
  // so every later device op on the long-lived shim replayed the same stale rejection, and the user
  // could not recover (short of a window reload) even after fixing Python.
  let attempts = 0;
  const run = singleFlight(async () => {
    attempts++;
    if (attempts === 1) throw new Error("python_not_found");
  });

  await assert.rejects(() => run(), /python_not_found/);
  await assert.doesNotReject(() => run(), "a later touch must retry start(), not replay the memoized rejection");
  assert.equal(attempts, 2, "start() must be re-invoked after the first failure");
});

test("singleFlight is single-flight: concurrent callers share one in-flight start", async () => {
  let attempts = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = singleFlight(async () => { attempts++; await gate; });

  const a = run();
  const b = run();
  release();
  await Promise.all([a, b]);

  assert.equal(attempts, 1, "two concurrent ensure() calls must not launch two starts");
});

test("singleFlight.reset() forces a fresh start on the next call (post-crash respawn)", async () => {
  let attempts = 0;
  const run = singleFlight(async () => { attempts++; });
  await run();
  await run();
  assert.equal(attempts, 1, "a resolved start is reused while alive");
  run.reset();            // the exit handler nulls the slot after the child crashes
  await run();
  assert.equal(attempts, 2, "after reset, the next touch respawns");
});

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

test("DeviceShim.uninstallPackage sends the package name + port and throws on a shim error", async () => {
  const calls: any[] = [];
  let response: any = { status: "ok", removed: true };
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM7" }] } : response;
  };
  const shim = new DeviceShim(rpc);

  await shim.uninstallPackage("aioble");
  const un = calls.find((c) => c.method === "device.uninstall_package");
  assert.equal(un.params.name, "aioble");
  assert.equal(un.params.port, "COM7");

  response = { status: "error", error_kind: "mpremote_error", message: "boom" };
  await assert.rejects(() => shim.uninstallPackage("aioble"), /mpremote_error: boom/);
});

test("DeviceShim.scan drops a cached port that vanished from the scan so ops re-resolve (PR #31 finding 3)", async () => {
  const calls: any[] = [];
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM4" }] } : { status: "ok" };
  };
  const shim = new DeviceShim(rpc);
  shim.setPort("COM3"); // a stale board (e.g. it re-enumerated to COM4 across a flash)

  await shim.scan(); // reconciles: COM3 is not in the scan, so the cache is dropped
  await shim.installPackage("u"); // ensurePort re-resolves to the only present port

  const install = calls.find((c) => c.method === "device.install_package");
  assert.equal(install.params.port, "COM4"); // NOT the stale COM3
});

test("DeviceShim.runV0Script forwards a V0 script_run to script.run_v0 and returns the result", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return { status: "ok", success: false, exit_code: 1, stdout: "", stderr: "gate failed", result_json: null };
  });
  const res = await shim.runV0Script({ interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"], project_dir: "C:/p", stdin_content: "{}" });
  assert.deepEqual(calls, [{ method: "script.run_v0", params: { interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"], project_dir: "C:/p", stdin_content: "{}" } }]);
  assert.equal(res.success, false);
  assert.equal(res.exit_code, 1);
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

test("DeviceShim.writeUserDeviceFile sends raw bytes as content_b64 (binary-safe, no lossy string)", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "ok" };
  });

  // Non-UTF-8 bytes: a string transport (TextDecoder + "w") would replace these with U+FFFD.
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x89]);
  await shim.writeUserDeviceFile("/boot.mpy", bytes);

  const write = calls.find((c) => c.method === "device.write_device_file");
  assert.equal(write.params.path, "/boot.mpy");
  assert.equal(write.params.code, undefined, "no lossy string `code` field for a user upload");
  assert.deepEqual(new Uint8Array(Buffer.from(write.params.content_b64, "base64")), bytes, "exact byte round-trip");
});

test("DeviceShim.removePath and makeDir sanitize the device path before the RPC (traversal/backslash rejected)", async () => {
  const calls: any[] = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "device.scan" ? { status: "ok", devices: [{ port: "COM3" }] } : { status: "ok" };
  });

  await assert.rejects(() => shim.removePath("/lib/../boot.py"), /invalid_device_path/);
  await assert.rejects(() => shim.makeDir("a\\b"), /invalid_device_path/);
  assert.ok(!calls.some((c) => c.method === "device.fs_remove" || c.method === "device.fs_mkdir"), "no fs op reached the port");

  // A legit absolute device path passes through sanitized.
  await shim.makeDir("/lib");
  assert.ok(calls.find((c) => c.method === "device.fs_mkdir" && c.params.path === "/lib"), "a valid path still reaches the RPC");
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

// ---- Device filesystem bridge (#6): ls / rm / mkdir / cp_from -----------------------
function fsShim(responses: Record<string, any>) {
  const calls: Array<{ method: string; params: any }> = [];
  const shim = new DeviceShim(async (method: string, params: any) => {
    calls.push({ method, params });
    return responses[method] ?? { status: "ok" };
  });
  shim.setPort("COM3");
  return { shim, calls };
}

test("DeviceShim.listDir returns the device file list via device.list_files", async () => {
  const { shim, calls } = fsShim({ "device.list_files": { status: "ok", files: ["main.py", "lib"] } });
  assert.deepEqual(await shim.listDir(), ["main.py", "lib"]);
  assert.equal(calls[0].method, "device.list_files");
  assert.equal(calls[0].params.port, "COM3");
});

test("DeviceShim.removePath calls device.fs_remove with the path", async () => {
  const { shim, calls } = fsShim({ "device.fs_remove": { status: "ok" } });
  await shim.removePath("/main.py");
  assert.equal(calls[0].method, "device.fs_remove");
  assert.equal(calls[0].params.path, "/main.py");
});

test("DeviceShim.makeDir calls device.fs_mkdir with the path", async () => {
  const { shim, calls } = fsShim({ "device.fs_mkdir": { status: "ok" } });
  await shim.makeDir("/lib");
  assert.equal(calls[0].method, "device.fs_mkdir");
  assert.equal(calls[0].params.path, "/lib");
});

test("DeviceShim.copyFromDevice calls device.copy_from with remote + local paths", async () => {
  const { shim, calls } = fsShim({ "device.copy_from": { status: "ok" } });
  await shim.copyFromDevice("log.txt", "/tmp/log.txt");
  assert.equal(calls[0].method, "device.copy_from");
  assert.equal(calls[0].params.remote_path, "log.txt");
  assert.equal(calls[0].params.local_path, "/tmp/log.txt");
});

test("DeviceShim fs ops throw their error_kind (never a fake success)", async () => {
  const { shim } = fsShim({ "device.fs_remove": { status: "error", error_kind: "mpremote_error" } });
  await assert.rejects(() => shim.removePath("/x"), /mpremote_error/);
});

// ---- kill()/exit-handler race (#30 review, finding 3) ----
// Fake child: enough surface for createShimLifecycle (stdin/stdout/stderr, spawn/exit
// events, kill). pid stays undefined so killProcessTree is a no-op — these tests pin the
// STATE machine, not the process kill (the real group-kill test above covers that).
import { EventEmitter } from "node:events";
import { createShimLifecycle } from "../src/extension/device-shim.ts";

class FakeShimChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = undefined;
  name: string;
  dead = false;
  stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line);
      setImmediate(() => {
        if (this.dead) return;
        this.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { status: "ok", devices: [{ port: `COM-${this.name}` }] } }) + "\n"));
      });
      return true;
    },
  };
  constructor(name: string) {
    super();
    this.name = name;
    setImmediate(() => this.emit("spawn"));
  }
  kill() { this.dead = true; }
}

test("kill() clears the shim state SYNCHRONOUSLY: the next device touch respawns instead of using the dying process", async () => {
  const children: FakeShimChild[] = [];
  const shim = createShimLifecycle(() => {
    const c = new FakeShimChild(`c${children.length}`);
    children.push(c);
    return c;
  });

  assert.deepEqual(await shim.scan(), ["COM-c0"], "first scan runs on the first child");
  (shim as any).kill();
  // No exit event has fired yet — the OLD code only cleared proc/child in the async exit
  // handler, so this immediate next touch was routed to the dying child.
  const ports = await shim.scan();
  assert.equal(children.length, 2, "kill() + next touch must spawn a FRESH shim, not reuse the killed one");
  assert.deepEqual(ports, ["COM-c1"], "the new session's first RPC is served by the new child");
});

test("a killed child's LATE exit event does not wipe a newly respawned shim's state", async () => {
  const children: FakeShimChild[] = [];
  const shim = createShimLifecycle(() => {
    const c = new FakeShimChild(`c${children.length}`);
    children.push(c);
    return c;
  });

  await shim.scan();            // child 0 up
  (shim as any).kill();         // stop: child 0 dying, no exit event yet
  await shim.scan();            // child 1 up (new build)
  children[0].emit("exit", 1);  // child 0's exit event finally arrives
  await shim.scan();            // must still be served by child 1
  assert.equal(children.length, 2, "the stale exit handler must not clear the NEW shim (which would force a third spawn)");
});

test("kill() rejects the in-flight RPC immediately instead of leaving it hanging until the process exit event", async () => {
  const children: FakeShimChild[] = [];
  const shim = createShimLifecycle(() => {
    const c = new FakeShimChild(`c${children.length}`);
    c.stdin.write = () => true; // swallow the request: the RPC stays pending, like a blocked flash
    children.push(c);
    return c;
  });

  const inflight = shim.scan();
  await new Promise((r) => setImmediate(r)); // let the spawn settle and the request get written
  (shim as any).kill();
  await assert.rejects(inflight, /shim exited/, "Stop must fail the blocked RPC now — the loop is waiting on it");
});

test("getPort returns the port set via setPort", () => {
  const shim = new DeviceShim(async () => ({ status: "ok" }));
  assert.equal(shim.getPort(), null, "no port until one is selected");
  shim.setPort("COM8");
  assert.equal(shim.getPort(), "COM8", "reflects the selected port");
});
