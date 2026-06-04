import assert from "node:assert/strict";
import test from "node:test";

import { deriveDiagram } from "../src/core/diagram-derive.ts";

function layerById(diagram: any, id: string) {
  return diagram.architecture.layers.find((l: any) => l.id === id);
}

test("two I2C devices + a board yield entry/driver/board layers and a full flow", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    mcu: { board: "ESP32-C3", model: "esp32c3" },
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
    ],
  });

  // Layer order is top -> bottom in the UI: entry, driver, board.
  assert.deepEqual(diagram.architecture.layers.map((l: any) => l.id), ["entry", "driver", "board"]);

  assert.deepEqual(layerById(diagram, "entry").modules, [{ name: "main.py" }]);

  const driver = layerById(diagram, "driver");
  assert.deepEqual(
    driver.modules.map((m: any) => `${m.name}/${m.role}/${m.path}`),
    ["SSD1306 OLED/I2C/display", "AHT20/I2C/temperature_sensor"],
  );

  // Board layer carries the resolved mcu name (mcu.board wins).
  assert.deepEqual(layerById(diagram, "board").modules, [{ name: "ESP32-C3", role: "MCU" }]);

  // Flow: init -> scan (I2C present) -> create -> run.
  assert.deepEqual(diagram.flow.map((s: any) => s.phase), ["init", "scan", "create", "run"]);
  assert.equal(diagram.flow.find((s: any) => s.phase === "init").detail, "I2C");
  assert.equal(diagram.flow.find((s: any) => s.phase === "scan").detail, "SSD1306 OLED, AHT20");
});

test("no devices yields an empty diagram so the tab stays empty", () => {
  assert.deepEqual(deriveDiagram({}), { architecture: { layers: [] }, flow: [] });
  assert.deepEqual(deriveDiagram({ devices: [] }), { architecture: { layers: [] }, flow: [] });
});

test("a non-I2C build (SPI + PWM) has no scan step", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    mcu: { model: "rp2040" },
    devices: [
      { name: "ILI9341", type: "display", interface: "SPI" },
      { name: "Buzzer", type: "buzzer", interface: "PWM" },
    ],
  });

  assert.equal(layerById(diagram, "board").modules[0].name, "rp2040");
  // SPI is a bus -> init present; no I2C -> no scan.
  assert.deepEqual(diagram.flow.map((s: any) => s.phase), ["init", "create", "run"]);
  assert.equal(diagram.flow.find((s: any) => s.phase === "init").detail, "SPI");
});

test("mixed shared buses use language-neutral init detail", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    devices: [
      { name: "AHT20", type: "temperature_sensor", interface: "I2C" },
      { name: "ILI9341", type: "display", interface: "SPI" },
    ],
  });

  const init = diagram.flow.find((s: any) => s.phase === "init");
  assert.equal(init.detail, "I2C · SPI");
  assert.doesNotMatch(init.detail, /[\u4e00-\u9fff]/u);
});

test("a board-less manifest (analyze phase) omits the board layer but still shows entry + driver", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    devices: [{ name: "DHT22", type: "temperature_sensor", interface: "1-WIRE" }],
  });

  assert.deepEqual(diagram.architecture.layers.map((l: any) => l.id), ["entry", "driver"]);
  // 1-WIRE is a bus (init) but not I2C (no scan).
  assert.deepEqual(diagram.flow.map((s: any) => s.phase), ["init", "create", "run"]);
});

test("a direct-GPIO standalone part (no bus) has neither an init nor a scan step", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    mcu: { model: "rp2040" },
    devices: [{ name: "Button", type: "button", interface: "GPIO" }],
  });

  // GPIO is not in BUS_INTERFACES, so there is no shared-bus init and no I2C scan.
  assert.deepEqual(diagram.flow.map((s: any) => s.phase), ["create", "run"]);
  assert.equal(diagram.flow.find((s: any) => s.phase === "create").detail, "Button");
  // The part still appears as a driver module.
  assert.equal(layerById(diagram, "driver").modules[0].name, "Button");
});

test("multiple buses keep first-seen order in init, while scan lists only the I2C device", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    mcu: { model: "esp32" },
    devices: [
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
      { name: "ILI9341", type: "display", interface: "SPI" },
    ],
  });

  assert.deepEqual(diagram.flow.map((s: any) => s.phase), ["init", "scan", "create", "run"]);
  assert.equal(diagram.flow.find((s: any) => s.phase === "init").detail, "I2C · SPI");
  // scan is I2C-only even though an SPI device is present.
  assert.equal(diagram.flow.find((s: any) => s.phase === "scan").detail, "AHT20");
  assert.equal(diagram.flow.find((s: any) => s.phase === "create").detail, "AHT20, ILI9341");
});

test("a device with no name falls back to the generic 'device' module label", () => {
  const diagram = deriveDiagram({
    schema_version: "1.0",
    devices: [{ type: "sensor", interface: "SPI" }],
  });

  assert.equal(layerById(diagram, "driver").modules[0].name, "device");
});
