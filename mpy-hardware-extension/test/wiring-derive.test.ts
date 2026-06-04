import assert from "node:assert/strict";
import test from "node:test";

import { deriveWiring } from "../src/core/wiring-derive.ts";

test("two I2C devices share one bus card each, with shared SDA/SCL signals", () => {
  // The exact regression that motivated the re-base: a single OLED must be ONE
  // card, and two I2C devices must be two device entries on ONE bus — never a
  // phantom per-pin card.
  const manifest = {
    schema_version: "1.0",
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
    ],
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO9" },
    ],
  };

  const wiring = deriveWiring(manifest);

  assert.equal(wiring.buses.length, 1, "one I2C bus");
  assert.equal(wiring.buses[0].type, "i2c");
  // Shared signals deduped to one SDA + one SCL.
  assert.deepEqual(
    wiring.buses[0].signals.map((s: any) => `${s.role}:${s.gpio}`).sort(),
    ["SCL:GPIO9", "SDA:GPIO8"],
  );
  // One device entry per physical part — no phantom.
  assert.deepEqual(
    wiring.buses[0].devices.map((d: any) => `${d.name}@${d.addr}`),
    ["SSD1306 OLED@0x3C", "AHT20@0x38"],
  );
  assert.equal(wiring.standalone.length, 0);
});

test("a GPIO part becomes a single standalone entry with its pin", () => {
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [{ name: "Status LED", type: "led", interface: "GPIO" }],
    pinout: [{ device: "Status LED", pin_name: "GP2", gpio: "GPIO2" }],
  });

  assert.equal(wiring.buses.length, 0);
  assert.deepEqual(wiring.standalone, [{ name: "Status LED", pin: "GPIO2", type: "gpio_out" }]);
});

test("mixed I2C sensor + standalone LED renders as exactly two cards (one each)", () => {
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
      { name: "Alarm LED", type: "led", interface: "GPIO" },
    ],
    pinout: [
      { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "Alarm LED", pin_name: "GP2", gpio: "GPIO2" },
    ],
  });

  assert.equal(wiring.buses.length, 1);
  assert.equal(wiring.buses[0].devices.length, 1);
  assert.equal(wiring.standalone.length, 1);
});

test("PWM/ADC interfaces map to their standalone gpio types", () => {
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [
      { name: "Servo", type: "servo", interface: "PWM" },
      { name: "Pot", type: "potentiometer", interface: "ADC" },
    ],
    pinout: [
      { device: "Servo", pin_name: "GP15", gpio: "GPIO15" },
      { device: "Pot", pin_name: "GP34", gpio: "GPIO34" },
    ],
  });

  assert.deepEqual(wiring.standalone, [
    { name: "Servo", pin: "GPIO15", type: "pwm" },
    { name: "Pot", pin: "GPIO34", type: "adc" },
  ]);
});

test("empty/partial manifest derives empty wiring without throwing", () => {
  assert.deepEqual(deriveWiring({}), { buses: [], standalone: [] });
  assert.deepEqual(deriveWiring({ devices: [] }), { buses: [], standalone: [] });
});
