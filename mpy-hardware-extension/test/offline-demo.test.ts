import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolve, OfflinePackageClient, OfflineBoardClient } from "../src/demo/offline-catalog.ts";
import { DeviceSimulator } from "../src/demo/device-simulator.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { extractCapabilities } from "../src/core/capabilities.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "fixtures");
const golden = JSON.parse(readFileSync(join(FIXTURES, "resolve-golden.json"), "utf-8"));

// The offline ranking is a hand-port of mpyhw-api/app/package_store.py. This proves
// the port has not drifted from the source of truth: for each demo scenario the TS
// resolve() must reproduce the Python selection AND the full candidate order+scores.
test("offline resolve() matches the Python golden (selection, order, scores)", () => {
  for (const sc of golden) {
    const got = resolve({ intent: sc.intent, capabilities: sc.capabilities, board_id: sc.board_id });
    assert.equal(got.selected?.name, sc.expected.selected?.name, `selected name for ${sc.intent}`);
    assert.equal(got.selected?.version, sc.expected.selected?.version, `selected version for ${sc.intent}`);
    const fmt = (c: any) => `${c.name}@${c.version}:${c.score.toFixed(4)}`;
    assert.deepEqual(
      got.candidates.map(fmt),
      sc.expected.candidates.map(fmt),
      `candidate order/scores for ${sc.intent}`,
    );
  }
});

test("offline pipeline generates valid MicroPython for the golden temp/LED path", async () => {
  const intent = "温度超过30度就点亮LED";
  assert.deepEqual(extractCapabilities(intent), ["temperature_sensing", "digital_output"]);
  const result = await runPipeline({
    intent,
    board_id: "esp32-s3-devkitc-1",
    packageClient: new OfflinePackageClient(),
    boardClient: new OfflineBoardClient(),
  });
  assert.equal(result.ok, true, `pipeline error: ${(result as any).error}`);
  const mainPy = result.files!["main.py"];
  assert.match(mainPy, /import aht20/);
  assert.match(mainPy, /Pin\(2, Pin\.OUT\)/); // LED pin from the board profile
  assert.match(mainPy, /threshold_c = 30/);
  assert.match(mainPy, /print\('MPYHW_READY'\)/);
  assert.equal((result.manifest as any).logic.threshold_c, 30);
});

test("device simulator toggles LED from the real manifest threshold", async () => {
  const device = new DeviceSimulator({ threshold_c: 30, action: "led_on_above_threshold" });
  const { ok, lines } = await device.serialReadUntil(["MPYHW_READY"]);
  assert.equal(ok, true);
  assert.equal(lines[0], "MPYHW_READY");
  // Below threshold stays OFF, above threshold turns ON — decided by the real threshold.
  assert.ok(lines.includes("TEMP_C=29.5 LED=OFF"));
  assert.ok(lines.includes("TEMP_C=31.2 LED=ON"));
  assert.ok(lines.includes("TEMP_C=33.8 LED=ON"));
});

test("offline board client rejects an unknown board without hitting the network", async () => {
  await assert.rejects(() => new OfflineBoardClient().getBoardProfile("no-such-board"), /board_not_found/);
});
