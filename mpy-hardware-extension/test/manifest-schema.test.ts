import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../src/core/manifest-builder.ts";
import { validateManifest } from "../src/core/manifest-schema.ts";

const board = {
  board_id: "esp32-s3-devkitc-1",
  pin_recommendations: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_default: "GPIO2" },
  pin_capabilities: { GPIO5: ["i2c_sda"], GPIO6: ["i2c_scl"], GPIO2: ["led_anode", "gpio_out"] },
  available_modules: ["machine", "time"],
};

test("builds a valid manifest from API packages and driver contexts", () => {
  const manifest = buildManifest({
    board,
    capabilities: ["temperature_sensing", "digital_output"],
    packages: [{ name: "aht20_driver", version: "1.0.0" }, { name: "machine_pin_led", version: "builtin" }],
    driverContexts: [
      { package: { name: "aht20_driver", version: "1.0.0" }, pin_roles: ["i2c_sda", "i2c_scl"] },
      { package: { name: "machine_pin_led", version: "builtin" }, pin_roles: ["led_anode"] },
    ],
    logic: { threshold_c: 30, action: "led_on_above_threshold" },
  });

  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(manifest.pins.i2c_sda, "GPIO5");
  assert.equal(manifest.driver_context_refs.length, 2);
});

test("manifest validation rejects disallowed pin roles", () => {
  const result = validateManifest({
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["temperature_sensing"],
    packages: [],
    driver_context_refs: [],
    pins: { i2c_sda: "GPIO2" },
    logic: {},
    wiring: [],
    board,
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "pin_role_not_allowed");
});

test("pin-capability gate still runs for a board-less manifest when the board is passed separately", () => {
  // The real agent path proposes a manifest with no embedded `board`; the gate
  // must run off the out-of-band board profile, not silently pass.
  const result = validateManifest({
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["temperature_sensing"],
    packages: [],
    driver_context_refs: [],
    pins: { i2c_sda: "GPIO2" }, // GPIO2 cannot be an I2C SDA pin
    logic: {},
    wiring: [],
  }, board);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "pin_role_not_allowed");
});
