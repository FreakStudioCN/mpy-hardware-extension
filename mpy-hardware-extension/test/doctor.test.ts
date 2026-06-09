import assert from "node:assert/strict";
import test from "node:test";

import { runDoctor } from "../src/extension/doctor.ts";

// A fully-passing environment: Python present, deps installed, one board, MicroPython live.
function healthyDeps(overrides: any = {}) {
  return {
    detectPython: () => ({ ok: true, version: "Python 3.12.1" }),
    venvReady: () => true,
    scan: async () => ["COM7"],
    probeMicroPython: async () => true,
    board: "ESP32_GENERIC",
    ...overrides,
  };
}

function byId(items: any[]) {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

test("runDoctor reports all green when python, deps, one board, and MicroPython are present", async () => {
  // The MicroPython probe enters the board's REPL (interrupting any running program),
  // so it only runs when explicitly asked for — opt in here.
  const items = await runDoctor(healthyDeps(), { probe: true });

  assert.deepEqual(items.map((i) => i.id), ["python", "deps", "device", "micropython"]);
  const r = byId(items);
  assert.equal(r.python.status, "ok");
  assert.equal(r.python.detail, "Python 3.12.1");
  assert.equal(r.deps.status, "ok");
  assert.equal(r.device.status, "ok");
  assert.equal(r.device.detail, "COM7");
  assert.equal(r.micropython.status, "ok");
});

test("runDoctor flags missing Python with a download link and an error_kind", async () => {
  const items = await runDoctor(healthyDeps({ detectPython: () => ({ ok: false }) }));
  const r = byId(items);

  assert.equal(r.python.status, "error");
  assert.equal(r.python.errorKind, "python_not_found");
  assert.match(r.python.link, /python\.org/);
});

test("runDoctor does NOT touch the device when deps are not ready (no blocking install)", async () => {
  // scan()/probe trigger the shim's lazy venv bootstrap — a slow/blocking pip install.
  // The doctor must skip them until deps are confirmed ready, or opening the tab freezes.
  let scanned = false;
  let probed = false;
  const items = await runDoctor(
    healthyDeps({
      venvReady: () => false,
      scan: async () => {
        scanned = true;
        return ["COM7"];
      },
      probeMicroPython: async () => {
        probed = true;
        return true;
      },
    }),
  );
  const r = byId(items);

  assert.equal(r.deps.status, "error");
  assert.equal(r.deps.errorKind, "shim_dependency_install_failed");
  assert.equal(r.deps.action, "install_deps");
  // device + micropython are blocked, not probed.
  assert.equal(r.device.status, "warn");
  assert.equal(r.micropython.status, "warn");
  assert.equal(scanned, false, "scan must not run before deps are ready");
  assert.equal(probed, false, "probe must not run before deps are ready");
});

test("runDoctor blocks the deps check when Python itself is missing (no install offered)", async () => {
  const items = await runDoctor(healthyDeps({ detectPython: () => ({ ok: false }), venvReady: () => true }));
  const r = byId(items);

  // Without Python the install would fail, so offer no install button — fix Python first.
  assert.equal(r.deps.status, "warn");
  assert.equal(r.deps.action, undefined);
});

test("runDoctor warns when no board is connected but does not probe", async () => {
  let probed = false;
  const items = await runDoctor(
    healthyDeps({ scan: async () => [], probeMicroPython: async () => { probed = true; return true; } }),
  );
  const r = byId(items);

  assert.equal(r.device.status, "warn");
  assert.equal(r.device.errorKind, "device_unavailable");
  assert.equal(r.micropython.status, "warn");
  assert.equal(probed, false, "nothing to probe with no port");
});

test("runDoctor does NOT probe a connected board unless asked (opening the panel must not interrupt it)", async () => {
  let probed = false;
  const items = await runDoctor(healthyDeps({ probeMicroPython: async () => { probed = true; return true; } }));
  const r = byId(items);

  // The board is found, but the invasive REPL probe is skipped on the default (load) run.
  assert.equal(r.device.status, "ok");
  assert.equal(probed, false, "the MicroPython probe must not run without an explicit opt-in");
  assert.equal(r.micropython.messageKey, "doc_mpy_recheck");
});

test("runDoctor turns a device scan failure into a warning instead of leaving the UI without results", async () => {
  const items = await runDoctor(healthyDeps({ scan: async () => { throw new Error("mpremote timed out"); } }), { probe: true });
  const r = byId(items);

  // A rejected scan must still resolve with items so the panel can post them — the
  // Environment tab recovers with a device problem instead of spinning forever.
  assert.deepEqual(items.map((i) => i.id), ["python", "deps", "device", "micropython"]);
  assert.equal(r.device.status, "warn");
  assert.equal(r.device.errorKind, "device_scan_failed");
});

test("runDoctor wraps a probe failure into a warning rather than rejecting", async () => {
  const items = await runDoctor(
    healthyDeps({ probeMicroPython: async () => { throw new Error("could not enter raw repl"); } }),
    { probe: true },
  );
  const r = byId(items);

  assert.equal(r.micropython.status, "warn");
  assert.equal(r.micropython.messageKey, "doc_mpy_probe_failed");
});

test("runDoctor surfaces a firmware download link when the board has no MicroPython", async () => {
  const items = await runDoctor(healthyDeps({ probeMicroPython: async () => false }), { probe: true });
  const r = byId(items);

  assert.equal(r.micropython.status, "warn");
  assert.equal(r.micropython.errorKind, "no_micropython");
  // Links straight to the matched board's firmware so the user can flash it themselves.
  assert.match(r.micropython.link, /micropython\.org\/download\/ESP32_GENERIC/);
});

test("runDoctor lists the ports and skips the probe when several boards are connected", async () => {
  let probed = false;
  const items = await runDoctor(
    healthyDeps({ scan: async () => ["COM7", "COM8"], probeMicroPython: async () => { probed = true; return true; } }),
  );
  const r = byId(items);

  assert.equal(r.device.status, "warn");
  assert.equal(r.device.errorKind, "device_selection_required");
  assert.deepEqual(r.device.ports, ["COM7", "COM8"]);
  assert.equal(probed, false, "cannot auto-pick a port to probe");
});
