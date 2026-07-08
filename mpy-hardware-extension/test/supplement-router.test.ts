import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySupplement } from "../src/core/supplement-router.ts";

// One representative case per §6 row (deliverables 07). Asserts BEHAVIOR — the decision,
// target, and the reconfirm-if-code flag the caller relies on — not the wording.

test("datasheet / driver material reroutes to gen-driver", () => {
  const r = classifySupplement("Here is the BMP390 datasheet", []);
  assert.equal(r.decision, "reroute");
  assert.equal(r.target, "upy-gen-driver-plugin");
});

test("a PDF attachment reroutes to gen-driver even with neutral text", () => {
  const r = classifySupplement("please use this", [{ kind: "pdf", ref: "bmp390.pdf" }]);
  assert.equal(r.decision, "reroute");
  assert.equal(r.target, "upy-gen-driver-plugin");
});

test("GitHub reference URL reroutes to gen-driver", () => {
  const r = classifySupplement("driver is at https://github.com/foo/bar", []);
  assert.equal(r.target, "upy-gen-driver-plugin");
});

test("adding functional hardware reroutes to analyze", () => {
  const r = classifySupplement("also add an OLED display", []);
  assert.equal(r.decision, "reroute");
  assert.equal(r.target, "upy-analyze-plugin");
});

test("changing the board reroutes to select-hw", () => {
  const r = classifySupplement("use an esp32 board instead", []);
  assert.equal(r.decision, "reroute");
  assert.equal(r.target, "upy-select-hw-plugin");
});

test("pin change reroutes to select-hw and is reconfirm-if-code", () => {
  const r = classifySupplement("move the sensor to GPIO 15", []);
  assert.equal(r.decision, "reroute");
  assert.equal(r.target, "upy-select-hw-plugin");
  assert.equal(r.reconfirmIfCode, true);
});

test("output-format change absorbs and is reconfirm-if-code (before the pin rule)", () => {
  // Contains "wiring" but is a format tweak — must not be misread as a pin change.
  const r = classifySupplement("change the wiring diagram format to SVG", []);
  assert.equal(r.decision, "absorb");
  assert.equal(r.target, null);
  assert.equal(r.reconfirmIfCode, true);
});

test("logic / threshold change absorbs", () => {
  const r = classifySupplement("raise the temperature threshold to 40", []);
  assert.equal(r.decision, "absorb");
  assert.equal(r.reconfirmIfCode, false);
});

test("deploy failure feedback absorbs into the fix step", () => {
  const r = classifySupplement("the upload failed with an error", []);
  assert.equal(r.decision, "absorb");
});

test("an unrecognized note absorbs into the next phase context", () => {
  const r = classifySupplement("thanks, looks good so far", []);
  assert.equal(r.decision, "absorb");
  assert.equal(r.target, null);
});
