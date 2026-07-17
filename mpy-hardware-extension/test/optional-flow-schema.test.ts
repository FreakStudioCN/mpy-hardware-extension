import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { buildOptionalFlowDispatch, isNetworkRenderDenied, wrapGeneratePhaseComplete, WIRING_PHASE, DIAGRAM_PHASE } from "../src/core/optional-flow-schema.ts";

const ids = { sessionId: "s1", msgId: "m1", timestamp: "2026-07-15T00:00:00Z" };

// Source of truth: the submodule at the REPO ROOT (two up from test/), which keeps the sample/ fixtures.
// The vendored EXT/third_party copy (one up) excludes sample/ via prepare-vsce, so it must not be used here.
const SKILLS_ROOT = resolve(import.meta.dirname, "..", "..", "third_party", "MicroPython_Skills");
function denialFixturePayload(rel: string): any {
  return JSON.parse(readFileSync(resolve(SKILLS_ROOT, rel), "utf-8")).payload;
}

test("isNetworkRenderDenied honors the REAL bundled denial fixtures (both plugins)", () => {
  // The diagram deny fixture carries BOTH a structured network_permission.decision "deny" AND a
  // DIAGRAM_PERMISSION_DENIED code; the wiring one carries only WIRING_IMAGE_RENDER_PERMISSION_DENIED.
  // The old panel check matched only /RENDER_PERMISSION_DENIED/, which MISSES DIAGRAM_PERMISSION_DENIED, so
  // an explicit deny still uploaded to mermaid.ink. Mutation: revert isNetworkRenderDenied to
  // /RENDER_PERMISSION_DENIED/ + drop the decision check -> the diagram fixture returns false and this fails.
  const diagram = denialFixturePayload("upy-diagram-plugin/sample/phase_complete.upy_diagram_plugin.permission_denied.json");
  const wiring = denialFixturePayload("upy-wiring-plugin/sample/phase_complete.upy_wiring_plugin.permission_denied.json");
  assert.equal(isNetworkRenderDenied(diagram), true, "diagram deny fixture is a network denial");
  assert.equal(isNetworkRenderDenied(wiring), true, "wiring deny fixture is a network denial");
});

test("isNetworkRenderDenied: structured decision alone denies; non-network denials do not", () => {
  // (a) decision "deny" with NO error code still denies (kills 'drop the structured network_permission check').
  assert.equal(isNetworkRenderDenied({ errors: [], network_permission: { domain: "mermaid.ink", decision: "deny" } }), true);
  // (b) a plugin-internal FILE_/SCRIPT_ access denial is NOT a network decline (kills a bare /_PERMISSION_DENIED/).
  assert.equal(isNetworkRenderDenied({ errors: [{ code: "FILE_PERMISSION_DENIED" }] }), false);
  assert.equal(isNetworkRenderDenied({ errors: [{ code: "SCRIPT_PERMISSION_DENIED" }] }), false);
  // (c) allow/absent decision + no denial code -> render.
  assert.equal(isNetworkRenderDenied({ errors: [], network_permission: { decision: "allow" } }), false);
  assert.equal(isNetworkRenderDenied(undefined), false);
});

test("wrapGeneratePhaseComplete produces the full message shape validate_upstream requires", () => {
  // The controller stores the bare PAYLOAD; the plugins' validate_upstream hard-checks the message
  // envelope (type + message-level phase + payload.result + manifest_content). Mutation: persist the bare
  // payload (drop the wrap) -> data.type is undefined and data.phase is the domain token -> upstream invalid.
  const payload = { phase: "generate", result: "success", manifest_content: { phase: "generate", devices: [{ name: "SHT30" }] }, optional_next_phases: ["upy-wiring-plugin", "upy-diagram-plugin"] };
  const msg = wrapGeneratePhaseComplete(payload, [{ phase: "upy-wiring-plugin" }, { phase: "upy-diagram-plugin" }], { sessionId: "s1", msgId: "m1", timestamp: "2026-07-16T00:00:00Z" });
  assert.equal(msg.type, "phase_complete", "message type is phase_complete");
  assert.equal(msg.phase, "upy-generate-plugin", "message-level phase is the envelope token, not the domain 'generate'");
  const p = msg.payload as any;
  assert.equal(p.result, "success");
  assert.equal(p.manifest_content.phase, "generate", "the real payload (incl manifest_content) is preserved");
  // optional_next_phases is normalized to dict items (validate_upstream counts only dicts, not strings)
  assert.ok(p.optional_next_phases.every((o: any) => typeof o === "object" && typeof o.phase === "string"), "offers are object-shaped");
});

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
