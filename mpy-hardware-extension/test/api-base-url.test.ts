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
  assert.equal(DEFAULT_API_BASE_URL, "https://blockless.upypi.net");
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

// Security (audit P1-D): the backend receives the GitHub token + session JWT, so a
// non-loopback cleartext (http) override must be refused, not silently used.
test("a non-loopback http setting is rejected and falls through to the hosted default", () => {
  withEnv(undefined, () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("http://evil.example.com"), undefined), DEFAULT_API_BASE_URL);
  });
});

test("a non-loopback http MPYHW_API_BASE is rejected and falls through to the hosted default", () => {
  withEnv("http://192.168.1.50:8787", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), DEFAULT_API_BASE_URL);
  });
});

test("loopback http is allowed for local dev (setting and env)", () => {
  withEnv(undefined, () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("http://localhost:8787"), undefined), "http://localhost:8787");
  });
  withEnv("http://127.0.0.1:8787", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), "http://127.0.0.1:8787");
  });
});

test("IPv6 loopback http ([::1]) is allowed for local dev", () => {
  // WHATWG URL yields hostname "[::1]" (bracketed) for http://[::1]:8787 — the allowlist
  // must accept that form, or the documented IPv6 loopback dev URL silently hits cloud.
  withEnv("http://[::1]:8787", () => {
    assert.equal(resolveApiBaseUrl(vscodeWith(undefined), undefined), "http://[::1]:8787");
  });
  withEnv(undefined, () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("http://[::1]:8787"), undefined), "http://[::1]:8787");
  });
});

test("an https override to a self-hosted backend is allowed", () => {
  withEnv(undefined, () => {
    assert.equal(resolveApiBaseUrl(vscodeWith("https://my-backend.example.com/"), undefined), "https://my-backend.example.com");
  });
});
