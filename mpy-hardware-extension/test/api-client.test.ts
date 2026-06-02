import assert from "node:assert/strict";
import test from "node:test";

import { ApiClient } from "../src/core/api-client.ts";

test("api client maps package search into observations", async () => {
  const client = new ApiClient("http://api.test", async () => jsonResponse({ results: [{ name: "aht20_driver" }] }));

  const observation = await client.executePackageTool("search_packages", { query: "temp" });

  assert.equal(observation.ok, true);
  assert.equal(observation.results[0].name, "aht20_driver");
});

test("api client preserves driver_context_missing", async () => {
  const client = new ApiClient("http://api.test", async () => jsonResponse({ detail: { error: "driver_context_missing" } }, 404));

  const observation = await client.executePackageTool("get_package_context", { name: "missing", version: "0.1.0" });

  assert.equal(observation.ok, false);
  assert.equal(observation.error_kind, "driver_context_missing");
});

test("tool registry mismatch produces a warning", async () => {
  const mismatch = new ApiClient("http://api.test", async () => jsonResponse({ tools: [{ name: "other_tool" }] }));

  assert.equal((await mismatch.checkToolRegistry(["query_board_profile"])).warning, "tool_registry_mismatch");
});

test("tool registry mismatch is detected when the backend exposes an extra tool", async () => {
  // The local set is a subset of the remote set: a names-only, one-directional
  // check would miss this. The backend declaring a tool the extension can't route
  // is still a contract drift.
  const drift = new ApiClient("http://api.test", async () => jsonResponse({ tools: [{ name: "query_board_profile" }, { name: "reboot_device" }] }));

  assert.equal((await drift.checkToolRegistry(["query_board_profile"])).warning, "tool_registry_mismatch");
});

test("a non-JSON error body produces a coded error instead of an uncaught SyntaxError", async () => {
  // Upstream proxy errors (502 HTML, empty 204) must not throw when we parse the
  // body before the ok-check: executePackageTool codes it, checkToolRegistry
  // rejects with the coded error rather than a JSON SyntaxError.
  const htmlError = new ApiClient("http://api.test", async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));

  const observation = await htmlError.executePackageTool("search_packages", { query: "temp" });
  assert.equal(observation.ok, false);
  assert.equal(observation.error_kind, "upstream_unavailable");

  await assert.rejects(() => htmlError.checkToolRegistry(["query_board_profile"]), /upstream_unavailable/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
