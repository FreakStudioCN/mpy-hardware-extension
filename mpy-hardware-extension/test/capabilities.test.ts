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

test("returns no capabilities for empty or non-hardware intents", () => {
  assert.deepEqual(extractCapabilities(""), []);
  assert.deepEqual(extractCapabilities("write me a poem about the sea"), []);
});

test("word boundaries stop substrings from false-matching (ledger is not an LED)", () => {
  // matchesKeyword wraps ascii keywords in (^|[^a-z0-9])kw($|[^a-z0-9]); the "led" inside
  // "ledger" must NOT register a digital_output capability.
  assert.deepEqual(extractCapabilities("update the ledger entry"), []);
});
