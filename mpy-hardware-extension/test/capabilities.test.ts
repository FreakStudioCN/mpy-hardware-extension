import assert from "node:assert/strict";
import test from "node:test";

import { extractCapabilities } from "../src/core/capabilities.ts";

test("extracts temperature and LED capabilities from golden phrase", () => {
  assert.deepEqual(extractCapabilities("turn on the LED when temperature is over 30"), [
    "temperature_sensing",
    "digital_output",
  ]);
});

test("extracts display text from oled phrase", () => {
  assert.deepEqual(extractCapabilities("show temperature on an oled display"), [
    "temperature_sensing",
    "display_text",
  ]);
});

test("extracts humidity from golden phrase", () => {
  assert.deepEqual(extractCapabilities("read humidity"), ["humidity_sensing"]);
});

test("extracts product demo capabilities from Chinese intent", () => {
  assert.deepEqual(extractCapabilities("超过30度亮红灯"), ["temperature_sensing", "digital_output"]);
});
