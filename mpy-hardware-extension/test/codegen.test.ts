import assert from "node:assert/strict";
import test from "node:test";

import { generateMainPy } from "../src/core/codegen.ts";

const manifest = {
  pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_anode: "GPIO2" },
  logic: { threshold_c: 30 },
};

test("generates MicroPython code from driver context with serial markers", () => {
  const result = generateMainPy({
    manifest,
    driverContexts: [aht20Context("custom_aht20"), ledContext()],
  });

  assert.equal(result.ok, true);
  assert.match(result.code, /import custom_aht20/);
  assert.match(result.code, /MPYHW_READY/);
  assert.match(result.code, /TEMP_C=/);
});

test("unsupported display context fails before hardware execution", () => {
  const result = generateMainPy({
    manifest,
    driverContexts: [{ package: { name: "ssd1306" }, import_names: ["ssd1306"], constructors: ["SSD1306_I2C(width, height, i2c)"], read_properties: [], bus: ["i2c"] }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "driver_context_not_generatable");
});

test("a pin the board could not allocate fails instead of emitting Pin() ", () => {
  // led_anode absent (board had no led_default recommendation) must not produce
  // `led = Pin(, Pin.OUT)`; it must fail loudly.
  const result = generateMainPy({
    manifest: { pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6" }, logic: { threshold_c: 30 } },
    driverContexts: [aht20Context("custom_aht20"), ledContext()],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "manifest_pin_missing");
});

function aht20Context(importName: string) {
  return { package: { name: "aht20_driver" }, import_names: [importName], constructors: ["AHT20(i2c)"], read_properties: ["temperature"], bus: ["i2c"] };
}

function ledContext() {
  return { package: { name: "machine_pin_led" }, import_names: ["machine"], constructors: ["Pin(pin, Pin.OUT)"], read_properties: [], bus: ["gpio"] };
}
