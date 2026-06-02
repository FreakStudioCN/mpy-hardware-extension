import assert from "node:assert/strict";
import test from "node:test";

import { PackageClient } from "../src/core/package-client.ts";

test("package client maps resolve success into typed selected package", async () => {
  const client = new PackageClient("http://api.test", async (url, init) => {
    assert.equal(url, "http://api.test/v1/packages/resolve");
    assert.equal(init?.method, "POST");
    return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
  });

  const result = await client.resolve({ intent: "temperature", capabilities: ["temperature_sensing"], board_id: "esp32-s3-devkitc-1" });

  assert.equal(result.selected?.name, "aht20_driver");
});

test("package client preserves driver_context_missing as structured error", async () => {
  const client = new PackageClient("http://api.test", async () => jsonResponse({ detail: { error: "driver_context_missing" } }, 404));

  await assert.rejects(() => client.getPackageContext("missing", "0.0.1"), { code: "driver_context_missing" });
});

test("package client maps network failure to upstream_unavailable", async () => {
  const client = new PackageClient("http://api.test", async () => {
    throw new Error("offline");
  });

  await assert.rejects(() => client.search({ query: "temperature" }), { code: "upstream_unavailable" });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
