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

test("standalone part role comes from the pinout pin types, not the GPIO interface", () => {
  // Regression: every direct-GPIO part was forced to gpio_out, so a button (an input)
  // and a passive buzzer (PWM) were both mislabeled as outputs. The pinout already
  // carries the true per-pin role; derive from it and ignore power/ground pins.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [
      { name: "Button", type: "button", interface: "GPIO" },
      { name: "Passive Buzzer", type: "buzzer", interface: "GPIO" },
    ],
    pinout: [
      { device: "Button", pin_name: "IN", gpio: "GPIO7", type: "gpio_in_pullup" },
      { device: "Button", pin_name: "GND", gpio: "GND", type: "gnd" },
      { device: "Passive Buzzer", pin_name: "IO", gpio: "GPIO4", type: "pwm" },
      { device: "Passive Buzzer", pin_name: "VCC", gpio: "3V3", type: "power_3v3" },
      { device: "Passive Buzzer", pin_name: "GND", gpio: "GND", type: "gnd" },
    ],
  });

  const byName = Object.fromEntries(wiring.standalone.map((s: any) => [s.name, s]));
  assert.equal(byName["Button"].type, "gpio_in_pullup", "button is an input, not gpio_out");
  assert.equal(byName["Passive Buzzer"].type, "pwm", "passive buzzer is PWM, not gpio_out");
  // A part whose first pin happens to be power must still resolve to its signal role.
  assert.equal(byName["Button"].pin, "GPIO7");
});

test("a standalone part with no pinout pin types falls back to the GPIO interface", () => {
  // Back-compat: older manifests carry no per-pin `type`; the part still maps to
  // gpio_out (or pwm/adc by interface) rather than dropping to a wrong role.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [{ name: "Relay", type: "relay", interface: "GPIO" }],
    pinout: [{ device: "Relay", pin_name: "IN", gpio: "GPIO7" }],
  });
  assert.equal(wiring.standalone[0].type, "gpio_out");
});

test("empty/partial manifest derives empty wiring without throwing", () => {
  assert.deepEqual(deriveWiring({}), { buses: [], standalone: [] });
  assert.deepEqual(deriveWiring({ devices: [] }), { buses: [], standalone: [] });
});

test("two distinct I2C buses (I2C0 + I2C1) stay separate, not merged into one card", () => {
  // Regression: keying buses by type alone collapsed two physical I2C controllers
  // into one card with conflicting duplicate SDA/SCL signals. The pin_name bus
  // token (I2C0 vs I2C1) must split them.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [
      { name: "OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "RTC", type: "clock", interface: "I2C", i2c_addr: ["0x68"] },
    ],
    pinout: [
      { device: "OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "RTC", pin_name: "I2C1 SDA", gpio: "GPIO10" },
      { device: "RTC", pin_name: "I2C1 SCL", gpio: "GPIO11" },
    ],
  });

  assert.equal(wiring.buses.length, 2, "two separate I2C buses");
  const byId = Object.fromEntries(wiring.buses.map((b: any) => [b.id, b]));
  assert.deepEqual(byId["I2C0"].signals.map((s: any) => `${s.role}:${s.gpio}`).sort(), ["SCL:GPIO9", "SDA:GPIO8"]);
  assert.deepEqual(byId["I2C1"].signals.map((s: any) => `${s.role}:${s.gpio}`).sort(), ["SCL:GPIO11", "SDA:GPIO10"]);
  assert.deepEqual(byId["I2C0"].devices.map((d: any) => d.name), ["OLED"]);
  assert.deepEqual(byId["I2C1"].devices.map((d: any) => d.name), ["RTC"]);
});

test("a standalone part whose pin_name contains a bus-role substring does not spawn a phantom bus", () => {
  // Regression: signalRoleFromPinName matched 'TX'/'CS'/'RX' substrings on EVERY
  // pinout row, so a standalone GPIO part on a pin labeled e.g. "TX_EN" fabricated
  // a ghost UART bus AND a standalone card. A known standalone device must never
  // contribute a bus signal.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [{ name: "Relay", type: "relay", interface: "GPIO" }],
    pinout: [{ device: "Relay", pin_name: "TX_EN", gpio: "GPIO7" }],
  });

  assert.equal(wiring.buses.length, 0, "no phantom bus from a standalone pin_name");
  assert.deepEqual(wiring.standalone, [{ name: "Relay", pin: "GPIO7", type: "gpio_out" }]);
});

test("a multi-pin standalone part keeps all its pins (not just the first)", () => {
  // Regression: pinout.find() captured only the first row, so multi-GPIO parts
  // (HX711 DT+SCK, stepper, RGB LED) silently dropped their other connections.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [{ name: "HX711", type: "load_cell_adc", interface: "GPIO" }],
    pinout: [
      { device: "HX711", pin_name: "DT", gpio: "GPIO4" },
      { device: "HX711", pin_name: "SCK", gpio: "GPIO5" },
    ],
  });

  assert.equal(wiring.buses.length, 0, "HX711 is standalone, not a bus");
  assert.equal(wiring.standalone.length, 1, "one card for the part");
  assert.equal(wiring.standalone[0].name, "HX711");
  assert.deepEqual(wiring.standalone[0].pins.map((p: any) => p.gpio), ["GPIO4", "GPIO5"], "both pins kept");
});

test("the only SPI/UART bus is numbered from zero (id SPI0, not SPI1)", () => {
  // Regression: bus id used the running map size across all types, so the first
  // SPI bus after an I2C bus was labeled SPI1.
  const wiring = deriveWiring({
    schema_version: "1.0",
    devices: [
      { name: "Sensor", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
      { name: "Flash", type: "storage", interface: "SPI" },
    ],
    pinout: [
      { device: "Sensor", pin_name: "SDA", gpio: "GPIO8" },
      { device: "Sensor", pin_name: "SCL", gpio: "GPIO9" },
      { device: "Flash", pin_name: "MOSI", gpio: "GPIO11" },
      { device: "Flash", pin_name: "MISO", gpio: "GPIO13" },
    ],
  });

  const spi = wiring.buses.find((b: any) => b.type === "spi");
  assert.ok(spi, "spi bus present");
  assert.equal(spi.id, "SPI0", "the sole SPI bus is SPI0, not SPI1");
});
