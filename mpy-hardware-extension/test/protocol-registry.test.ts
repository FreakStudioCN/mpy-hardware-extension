import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_TOOLS, PROTOCOL_TOOL_KINDS, PROTOCOL_TOOL_NAMES, routeForTool } from "../src/core/protocol-registry.ts";

const V0_TOOLS = [
  "approval_request",
  "device_command",
  "file_operation",
  "script_run",
  "status_update",
  "phase_complete",
] as const;

test("protocol registry exposes exactly the six V0 LLM tools", () => {
  const names = PROTOCOL_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [...V0_TOOLS]);
  assert.deepEqual([...PROTOCOL_TOOL_NAMES], [...V0_TOOLS]);
  for (const retired of ["query_board_profile", "get_phase_profile", "scan_device"]) {
    assert.equal(PROTOCOL_TOOL_NAMES.has(retired), false, retired);
  }
});

test("protocol registry routes each V0 tool to the correct executor lane", () => {
  assert.equal(routeForTool("approval_request"), "ui");
  assert.equal(routeForTool("device_command"), "device");
  assert.equal(routeForTool("file_operation"), "fs");
  assert.equal(routeForTool("script_run"), "host");
  assert.equal(routeForTool("status_update"), "notify");
  assert.equal(routeForTool("phase_complete"), "notify");
  assert.equal(PROTOCOL_TOOL_KINDS.status_update, "notify");
  assert.equal(PROTOCOL_TOOL_KINDS.phase_complete, "notify");
});
