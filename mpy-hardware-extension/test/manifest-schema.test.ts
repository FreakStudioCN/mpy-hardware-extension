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

// Layer 2: the error feedback must be actionable so a wrong manifest self-corrects
// in one round instead of spinning on manifest_invalid (the desktop-pet failure).
function withPins(pins: any) {
  return { board_id: "esp32-s3-devkitc-1", capabilities: [], packages: [], driver_context_refs: [], pins, logic: {}, wiring: [] };
}

test("a pin->object pins map fails clearly and never emits [object Object]", () => {
  // The model sent pins keyed by pin with object values; the old builder rendered
  // "GPIO5 on [object Object]", which taught it nothing.
  const result = validateManifest(withPins({ GPIO5: { role: "i2c_sda" } }), board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.every((e) => !e.message.includes("[object Object]")));
  assert.equal(result.errors[0].code, "pins_shape_invalid");
});

test("a disallowed pin lists the allowed pins for that role", () => {
  const result = validateManifest(withPins({ i2c_sda: "GPIO2" }), board);
  assert.equal(result.errors[0].code, "pin_role_not_allowed");
  assert.ok(result.errors[0].message.includes("GPIO5")); // the pin that allows i2c_sda
  assert.ok(result.errors[0].message.includes("i2c_sda"));
});

test("a role no pin supports says the board cannot satisfy it", () => {
  const result = validateManifest(withPins({ analog_input: "GPIO5" }), board);
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].message.toLowerCase().includes("cannot satisfy"));
});

test("led_anode on a gpio_out pin still validates", () => {
  const result = validateManifest(withPins({ led_anode: "GPIO2" }), board);
  assert.equal(result.valid, true);
});
