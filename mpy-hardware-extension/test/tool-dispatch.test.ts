import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CANONICAL_TOOLS, routeForTool } from "../src/core/tool-registry.ts";
import { dispatchTool } from "../src/core/tool-dispatch.ts";

const contract = JSON.parse(readFileSync(new URL("../../contracts/canonical_tools.json", import.meta.url), "utf-8"));

test("every canonical tool routes to exactly one executor", async () => {
  const seen: string[] = [];
  const executors = {
    local: async (name: string) => (seen.push(`local:${name}`), { ok: true }),
    api: async (name: string) => (seen.push(`api:${name}`), { ok: true }),
    shim: async (name: string) => (seen.push(`shim:${name}`), { ok: true }),
    ui: async (name: string) => (seen.push(`ui:${name}`), { ok: true }),
  };

  for (const tool of CANONICAL_TOOLS) {
    await dispatchTool({ name: tool, input: {} }, executors);
  }

  // dispatchTool must route each tool to exactly the executor routeForTool dictates
  // — not merely fire *some* executor. This is the integration check that the
  // dispatcher honors the routing table; routeForTool's own mapping is covered below.
  const expected = CANONICAL_TOOLS.map((tool) => `${routeForTool(tool)}:${tool}`);
  assert.deepEqual(seen.sort(), expected.sort());
});

test("unknown tool returns structured observation instead of throwing", async () => {
  const result = await dispatchTool({ name: "web_search", input: {} }, {});

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "UnknownToolError");
});

test("client canonical tools match the shared contract exactly", () => {
  const contractNames = contract.map((tool: any) => tool.name);

  assert.deepEqual(CANONICAL_TOOLS, contractNames);
});

test("client implements every shared contract executor hint", () => {
  const routeByHint: Record<string, string> = {
    local: "local",
    "api-proxy": "api",
    shim: "shim",
    "ui-prompt": "ui",
  };

  for (const tool of contract) {
    assert.equal(routeForTool(tool.name), routeByHint[tool.executor_hint], tool.name);
  }
});
