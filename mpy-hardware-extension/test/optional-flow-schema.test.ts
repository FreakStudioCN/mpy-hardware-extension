import assert from "node:assert/strict";
import test from "node:test";

import { buildOptionalFlowDispatch, WIRING_PHASE, DIAGRAM_PHASE } from "../src/core/optional-flow-schema.ts";

const ids = { sessionId: "s1", msgId: "m1", timestamp: "2026-07-15T00:00:00Z" };

test("wiring dispatch: own runtime_context (no artifact_root), pins render, honest capabilities", () => {
  const env = buildOptionalFlowDispatch("wiring", ids);
  const p = env.payload as any;
  assert.equal(env.phase, WIRING_PHASE);
  assert.equal(p.mode, "full");
  assert.equal(p.source_phase, "upy-generate-plugin");
  // runtime_context is the wiring/diagram key set, NOT gen-driver's: no artifact_root, cwd-relative.
  assert.deepEqual(Object.keys(p.runtime_context).sort(), ["file_operation_root", "project_root", "resource_root", "session_root"]);
  assert.equal(p.runtime_context.artifact_root, undefined, "wiring has no artifact_root");
  assert.equal(p.runtime_context.resource_root, WIRING_PHASE);
  assert.equal(p.runtime_context.project_root, ".");
  // render_policy: wiring includes the pin table, 30s timeout, network gated by ask.
  assert.ok(p.render_policy.formats.includes("pins"));
  assert.equal(p.render_policy.timeout_ms, 30_000);
  assert.equal(p.render_policy.network_rendering, "ask");
  // capabilities honesty: no checkpoint/resume, no permission-prompt round-trip the host can't make.
  assert.equal(p.capabilities.checkpoint_resume, false);
  assert.equal(p.capabilities.permission_prompt, false);
  assert.equal(p.capabilities.cancellation, true);
});

test("diagram dispatch: no pins, 90s timeout, complexity=null, network_access to mermaid.ink", () => {
  const env = buildOptionalFlowDispatch("diagram", ids);
  const p = env.payload as any;
  assert.equal(env.phase, DIAGRAM_PHASE);
  assert.equal(p.runtime_context.resource_root, DIAGRAM_PHASE);
  assert.ok(!p.render_policy.formats.includes("pins"), "diagram has no pin table");
  assert.equal(p.render_policy.timeout_ms, 90_000);
  assert.equal(p.complexity, null, "null complexity -> the diagram_complexity approval card");
  assert.deepEqual(p.capabilities.network_access, { allowed: true, domains: ["mermaid.ink"] });
  assert.equal(p.capabilities.checkpoint_resume, false);
});

test("source_phase_complete_path defaults to null (omit-and-degrade until Q3) and passes through when given", () => {
  assert.equal((buildOptionalFlowDispatch("wiring", ids).payload as any).source_phase_complete_path, null);
  const withPath = buildOptionalFlowDispatch("wiring", { ...ids, sourcePhaseCompletePath: "sessions/s1/phase_complete.upy_generate_plugin.json" });
  assert.equal((withPath.payload as any).source_phase_complete_path, "sessions/s1/phase_complete.upy_generate_plugin.json");
});
