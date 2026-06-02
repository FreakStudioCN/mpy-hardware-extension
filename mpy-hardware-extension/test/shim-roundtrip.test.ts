import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ShimProcess } from "../src/extension/shim-process.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shimDir = join(here, "..", "python", "shim");

// Pick an available python; skip the whole suite if none (e.g. minimal CI image).
function resolvePython(): string | null {
  for (const candidate of ["python", "python3"]) {
    try {
      if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

const python = resolvePython();

// Real cross-process round-trip: Node spawns the genuine serve.py JSON-RPC loop
// (hardware faked inside the Shim via shim_fake_driver.py) and drives it through a
// real ShimProcess over actual stdin/stdout. This is the one test that proves the
// newline framing, _dispatch routing, and param-key contract (code/url/port/markers)
// actually agree across the language boundary — instead of two hand-mirrored fakes.
test("shim round-trip: real serve.py answers scan / write_main_py / serial_read_until over stdio", { skip: python ? false : "python not available" }, async () => {
  const child = spawn(python!, ["shim_fake_driver.py"], { cwd: shimDir, stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));

  const proc = new ShimProcess({ write: (line: string) => child.stdin.write(line) });
  child.stdout.on("data", (d: Buffer) => proc.feed(d.toString()));
  child.on("exit", (code: number) => proc.handleExit(code ?? -1));

  try {
    const scan = await proc.request("device.scan", {});
    assert.deepEqual(scan, { status: "ok", devices: [{ port: "COM3" }] });

    // TS sends { code }, serve.py _dispatch reads params["code"] — round-trip proves it.
    const write = await proc.request("device.write_main_py", { port: "COM3", code: "print('hi')" });
    assert.deepEqual(write, { status: "ok" });

    const serial = await proc.request("device.serial_read_until", { port: "COM3", markers: ["MPYHW_READY", "TEMP_C="] });
    assert.equal(serial.ok, true);
    assert.deepEqual(serial.lines, ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]);
  } finally {
    child.kill();
  }

  assert.ok(true, stderr.join(""));
});
