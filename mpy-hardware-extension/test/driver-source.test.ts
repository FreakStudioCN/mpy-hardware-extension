import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDriverSource, type DriverSource } from "../src/core/driver-source.ts";

const SANCTIONED: DriverSource[] = [
  "builtin_runtime",
  "micropython_lib",
  "upypi",
  "awesome-micropython",
  "github",
  "cold-driver",
  "none",
];

test("graftsense never leaks into a manifest driver.source", () => {
  // The one hard invariant of the package browser: a browsed catalog record tagged
  // source:"graftsense" must never become driver.source:"graftsense".
  assert.equal(normalizeDriverSource("graftsense", "https://github.com/x/y"), "github");
  assert.equal(normalizeDriverSource("graftsense"), "upypi");
  assert.notEqual(normalizeDriverSource("graftsense"), "graftsense");
  assert.notEqual(normalizeDriverSource("graftsense", "https://github.com/x/y"), "graftsense");
});

test("case-folded graftsense is still guarded", () => {
  assert.notEqual(normalizeDriverSource("GraftSense"), "graftsense");
  assert.notEqual(normalizeDriverSource("GRAFTSENSE", "https://github.com/x/y"), "graftsense");
});

test("sanctioned sources pass through unchanged", () => {
  for (const source of SANCTIONED) {
    assert.equal(normalizeDriverSource(source), source);
  }
});

test("curated and unknown sources default to a sanctioned installable source", () => {
  assert.equal(normalizeDriverSource("curated"), "upypi");
  assert.equal(normalizeDriverSource("something-new"), "upypi");
  assert.equal(normalizeDriverSource(undefined), "upypi");
  assert.equal(normalizeDriverSource(""), "upypi");
});

test("every possible output is a sanctioned value (never graftsense)", () => {
  const inputs = ["graftsense", "GraftSense", "curated", "upypi", "github", "none", "", undefined, "weird"];
  for (const input of inputs) {
    for (const repo of [undefined, "https://github.com/x/y"]) {
      const result = normalizeDriverSource(input, repo);
      assert.ok(SANCTIONED.includes(result), `${String(input)} -> ${result} must be sanctioned`);
      assert.notEqual(result, "graftsense");
    }
  }
});
