import assert from "node:assert/strict";
import test from "node:test";

import { runPipeline } from "../src/core/pipeline.ts";

test("pipeline calls API clients and returns main.py plus manifest.json", async () => {
  const calls: string[] = [];
  const result = await runPipeline({
    intent: "turn on the LED when temperature is over 30",
    board_id: "esp32-s3-devkitc-1",
    packageClient: {
      resolve: async () => (calls.push("resolve"), { selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] }),
      getPackageContext: async () => (calls.push("context"), aht20Context()),
    },
    boardClient: { getBoardProfile: async () => (calls.push("board"), board()) },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["resolve", "context", "board"]);
  assert.ok(result.files["main.py"].includes("MPYHW_READY"));
  assert.ok(JSON.parse(result.files["manifest.json"]).packages[0].name);
});

test("pipeline returns structured error for missing driver context", async () => {
  const result = await runPipeline({
    intent: "read temperature",
    board_id: "esp32-s3-devkitc-1",
    packageClient: {
      resolve: async () => ({ selected: { name: "broken", version: "0.1.0" }, candidates: [], needs_user_choice: false, questions: [] }),
      getPackageContext: async () => {
        const error = new Error("missing") as Error & { code: string };
        error.code = "driver_context_missing";
        throw error;
      },
    },
    boardClient: { getBoardProfile: async () => board() },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "driver_context_missing");
});

test("pipeline returns structured error for board profile failures", async () => {
  const result = await runPipeline({
    intent: "read temperature",
    board_id: "unknown-board",
    packageClient: {
      resolve: async () => ({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] }),
      getPackageContext: async () => aht20Context(),
    },
    boardClient: {
      getBoardProfile: async () => {
        const error = new Error("missing") as Error & { code: string };
        error.code = "board_not_found";
        throw error;
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "board_not_found");
});

function aht20Context() {
  return { package: { name: "aht20_driver", version: "1.0.0" }, import_names: ["aht20"], constructors: ["AHT20(i2c)"], read_properties: ["temperature"], bus: ["i2c"], pin_roles: ["i2c_sda", "i2c_scl"], install: { url: "https://upypi.net/pkgs/aht20/1.0.0/package.json" } };
}

function board() {
  return { board_id: "esp32-s3-devkitc-1", pin_recommendations: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_default: "GPIO2" }, pin_capabilities: { GPIO5: ["i2c_sda"], GPIO6: ["i2c_scl"], GPIO2: ["led_anode", "gpio_out"] }, available_modules: ["machine", "time"] };
}
