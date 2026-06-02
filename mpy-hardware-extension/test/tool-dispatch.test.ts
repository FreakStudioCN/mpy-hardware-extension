import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_TOOLS } from "../src/core/tool-registry.ts";
import { dispatchTool } from "../src/core/tool-dispatch.ts";

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

  assert.equal(seen.length, CANONICAL_TOOLS.length);
  assert.ok(seen.includes("api:search_packages"));
  assert.ok(seen.includes("shim:read_serial_until"));
  assert.ok(seen.includes("ui:ask_user"));
  assert.ok(seen.includes("local:generate_code"));
});

test("unknown tool returns structured observation instead of throwing", async () => {
  const result = await dispatchTool({ name: "web_search", input: {} }, {});

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "UnknownToolError");
});
