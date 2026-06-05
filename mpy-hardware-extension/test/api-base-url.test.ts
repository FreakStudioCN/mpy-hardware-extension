import test from "node:test";
import assert from "node:assert/strict";

import { resolveApiBaseUrl, DEFAULT_API_BASE_URL } from "../src/extension/api-base-url.ts";

function vscodeWith(setting?: string) {
  return { workspace: { getConfiguration: () => ({ get: () => setting }) } };
}

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.MPYHW_API_BASE;
  if (value === undefined) delete process.env.MPYHW_API_BASE;
  else process.env.MPYHW_API_BASE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MPYHW_API_BASE;
    else process.env.MPYHW_API_BASE = prev;
  }
}

test("explicit override wins over setting, env, and default", () => {
  withEnv("http://env", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("https://setting"), "https://override/"), "https://override");
  });
});

test("the mpyhw.apiBaseUrl setting wins over env and default", () => {
  withEnv("http://env", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("https://setting"), undefined), "https://setting");
  });
});

test("a blank setting falls through to the MPYHW_API_BASE dev override", () => {
  withEnv("http://127.0.0.1:8787", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("   "), undefined), "http://127.0.0.1:8787");
  });
});

test("defaults to the hosted backend (never localhost) when nothing is set", () => {
  withEnv(undefined, () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), DEFAULT_API_BASE_URL);
  });
  assert.ok(!DEFAULT_API_BASE_URL.includes("127.0.0.1"));
  assert.ok(DEFAULT_API_BASE_URL.startsWith("https://"));
});

test("an empty/whitespace MPYHW_API_BASE falls through to the hosted default (not an empty URL)", () => {
  withEnv("", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), DEFAULT_API_BASE_URL);
  });
  withEnv("   ", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), DEFAULT_API_BASE_URL);
  });
});
