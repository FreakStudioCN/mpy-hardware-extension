import assert from "node:assert/strict";
import test from "node:test";

import { createLlmClient } from "../src/core/llm-client.ts";

// Transport-level failures and transient server errors must be marked retryable so
// the agent loop can re-issue the request instead of killing the session, and the
// real cause (undici buries it in error.cause) must survive into the message so
// telemetry shows ECONNRESET instead of an undebuggable "fetch failed".

test("a connect-level fetch rejection is retryable and carries the cause", async () => {
  const cause: any = new Error("read ECONNRESET");
  cause.code = "ECONNRESET";
  const failure: any = new TypeError("fetch failed");
  failure.cause = cause;
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => { throw failure; }) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /fetch failed/);
    assert.match(error.message, /ECONNRESET/);
    return true;
  });
});

test("an infrastructure 5xx (non-JSON body, e.g. Render's proxy 502 page) is retryable", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /llm_upstream_error/);
    return true;
  });
});

test("a structured 5xx app error (llm_upstream_not_configured) is NOT retryable", async () => {
  // The server deliberately reported what's wrong; retrying can't fix a
  // misconfiguration and would bury the real detail under llm_unreachable.
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({ detail: { error: "llm_upstream_not_configured" } }) })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_not_configured");
    return true;
  });
});

test("a structured llm_upstream_error is retryable when its upstream status is transient", async () => {
  for (const upstreamStatus of [0, 408, 429, 500, 503]) {
    const client = createLlmClient({
      apiBaseUrl: "https://api.example",
      fetchImpl: (async () => ({
        ok: false,
        status: 502,
        json: async () => ({ detail: { error: "llm_upstream_error", status: upstreamStatus } }),
      })) as any,
    });

    await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
      assert.equal(error.retryable, true, `upstream status ${upstreamStatus}`);
      assert.equal(error.message, "llm_upstream_error");
      return true;
    });
  }
});

test("a structured llm_upstream_error is not retryable when its upstream status is 401", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: { error: "llm_upstream_error", status: 401 } }),
    })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_error");
    return true;
  });
});

test("a quota kind is NOT retryable even on a nested 429 (the 51-minute trap)", async () => {
  // A quota rejection reads identically to rate limiting by nested status alone
  // (both 429); only the kind the server classified it as tells them apart, and
  // retrying a dry account just burns calls that will all fail the same way.
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: { error: "llm_upstream_error", status: 429, kind: "quota" } }),
    })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_quota");
    return true;
  });
});

test("an auth kind is NOT retryable and renames the token", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: { error: "llm_upstream_error", status: 401, kind: "auth" } }),
    })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_auth");
    return true;
  });
});

test("a rejected kind is NOT retryable and renames the token", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: { error: "llm_upstream_error", status: 400, kind: "rejected" } }),
    })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_rejected");
    return true;
  });
});

for (const kind of ["outage", "rate_limited", "provider_rollout"]) {
  test(`a ${kind} kind is retryable and keeps the generic message`, async () => {
    const client = createLlmClient({
      apiBaseUrl: "https://api.example",
      fetchImpl: (async () => ({
        ok: false,
        status: 502,
        json: async () => ({ detail: { error: "llm_upstream_error", status: 429, kind } }),
      })) as any,
    });

    await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
      assert.equal(error.retryable, true);
      assert.equal(error.message, "llm_upstream_error");
      return true;
    });
  });
}

test("an unknown upstream kind falls back to nested status instead of becoming retryable by default", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: { error: "llm_upstream_error", status: 400, kind: "billing" } }),
    })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "llm_upstream_error");
    return true;
  });
});

test("a 429 from the LLM endpoint is retryable", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({ error: "rate_limited" }) })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.equal(error.retryable, true);
    return true;
  });
});

test("an application 4xx (out_of_credits) is NOT retryable and keeps its detail", async () => {
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => ({ ok: false, status: 402, json: async () => ({ detail: { error: "out_of_credits" } }) })) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    assert.equal(error.message, "out_of_credits");
    return true;
  });
});

test("an abort rejection is NOT marked retryable", async () => {
  const abort: any = new Error("This operation was aborted");
  abort.name = "AbortError";
  const client = createLlmClient({
    apiBaseUrl: "https://api.example",
    fetchImpl: (async () => { throw abort; }) as any,
  });

  await assert.rejects(client.streamMessages({ messages: [] }), (error: any) => {
    assert.notEqual(error.retryable, true);
    return true;
  });
});
