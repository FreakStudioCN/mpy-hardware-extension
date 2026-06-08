import assert from "node:assert/strict";
import test from "node:test";

import { createGithubAuth } from "../src/extension/github-auth.ts";

test("github auth records backend token exchange failures", async () => {
  const logs: string[] = [];
  const auth = createGithubAuth({
    apiBaseUrl: "http://api.test",
    log: (message) => logs.push(message),
    vscode: {
      authentication: {
        getSession: async () => ({ accessToken: "gho-token" }),
      },
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: { error: "github_auth_failed", status: 401 } }),
    } as Response),
  });

  const token = await auth.getToken(true);

  assert.equal(token, undefined);
  assert.equal(auth.getLastError(), "github_token_exchange_failed");
  assert.match(logs.join("\n"), /GitHub token exchange failed: 401/);
  assert.doesNotMatch(logs.join("\n"), /gho-token/);
});

test("github auth can force-refresh a cached backend session token", async () => {
  let calls = 0;
  const auth = createGithubAuth({
    apiBaseUrl: "http://api.test",
    vscode: {
      authentication: {
        getSession: async () => ({ accessToken: "gho-token" }),
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ token: `jwt-${calls}`, login: "octocat" }),
      } as Response;
    },
  });

  assert.equal(await auth.getToken(true), "jwt-1");
  assert.equal(calls, 1, "first call hits the backend");
  assert.equal(await auth.getToken(true), "jwt-1");
  assert.equal(calls, 1, "second call serves the cached token without re-fetching");
  assert.equal(await auth.getToken(true, { forceRefresh: true }), "jwt-2");
  assert.equal(calls, 2, "forceRefresh re-fetches");
});
