import assert from "node:assert/strict";
import test from "node:test";

import { runPipeline, runDeviceLoop } from "../src/core/pipeline.ts";

test("fake shim loop installs, writes, runs, and reads serial in order", async () => {
  const calls: string[] = [];
  const pipeline = await runPipeline({
    intent: "turn on the LED when temperature is over 30",
    board_id: "esp32-s3-devkitc-1",
    packageClient: {
      resolve: async () => ({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] }),
      getPackageContext: async () => ({ package: { name: "aht20_driver", version: "1.0.0" }, import_names: ["aht20"], constructors: ["AHT20(i2c)"], read_properties: ["temperature"], bus: ["i2c"], pin_roles: ["i2c_sda", "i2c_scl"], install: { url: "https://upypi.net/pkgs/aht20/1.0.0/package.json" } }),
    },
    boardClient: { getBoardProfile: async () => ({ board_id: "esp32-s3-devkitc-1", pin_recommendations: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_default: "GPIO2" }, pin_capabilities: { GPIO5: ["i2c_sda"], GPIO6: ["i2c_scl"], GPIO2: ["led_anode"] }, available_modules: ["machine", "time"] }) },
  });

  assert.equal(pipeline.ok, true);
  const observation = await runDeviceLoop(pipeline, {
    installPackage: async (url) => (calls.push(`install:${url}`), undefined),
    writeMainPy: async (content) => (calls.push(content.includes("MPYHW_READY") ? "write:ready" : "write:bad"), undefined),
    flashAndRun: async () => (calls.push("run"), undefined),
    serialReadUntil: async () => (calls.push("serial"), ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]),
  });

  assert.deepEqual(calls, ["install:https://upypi.net/pkgs/aht20/1.0.0/package.json", "write:ready", "run", "serial"]);
  assert.deepEqual(observation.lines, ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]);
});
