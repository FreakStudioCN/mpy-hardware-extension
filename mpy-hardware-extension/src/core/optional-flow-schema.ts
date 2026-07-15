// Start_phase builders for the optional post-generate flows (wiring #60, diagram #61). Distinct from
// gen-driver: their runtime_context has NO artifact_root, and capabilities/render_policy differ per plugin
// (wiring renders a pin table, diagram talks to mermaid.ink). Shapes verified against
// upy-{wiring,diagram}-plugin/sample/start_phase.*.full.json.

export const WIRING_PHASE = "upy-wiring-plugin";
export const DIAGRAM_PHASE = "upy-diagram-plugin";
export const OPTIONAL_FLOW_PHASE_BY_FLOW: Record<OptionalFlow, string> = {
  wiring: WIRING_PHASE,
  diagram: DIAGRAM_PHASE,
};

export type OptionalFlow = "wiring" | "diagram";

const OPTIONAL_FLOW_PROTOCOL_VERSION = "1.0";
const WIRING_TIMEOUT_MS = 30_000;
const DIAGRAM_TIMEOUT_MS = 90_000;

// runtime_context: wiring/diagram key set (NO artifact_root). cwd-relative so it stays inside the host's
// file_operation/script_run containment (rooted at projectFolder = cwd): project/file-op roots ARE the
// project (cwd), state/logs land under a sessions/<id> subdir, resource_root is the plugin dir name.
function optionalFlowRuntimeContext(sessionId: string, resourceRoot: string) {
  return {
    session_root: `sessions/${sessionId}`,
    project_root: ".",
    file_operation_root: ".",
    resource_root: resourceRoot,
  };
}

// Capabilities honesty (like gen-driver's): the host implements no checkpoint/resume round-trip and no
// permission-prompt message (the approval-card fallback covers it), so declare BOTH false rather than
// copying the sample's true. Everything else is what the host really provides.
const WIRING_CAPABILITIES = {
  approval_request: true, file_operation: true, script_run: true,
  checkpoint_resume: false, cancellation: true, retry: true, timeout: true, permission_prompt: false,
};
const DIAGRAM_CAPABILITIES = {
  protocol_versions: [OPTIONAL_FLOW_PROTOCOL_VERSION],
  approval_request: true, file_operation: true, script_run: true,
  checkpoint_resume: false, cancellation: true, retry: true, timeout: true, permission_prompt: false,
  artifact_manifest: true,
  network_access: { allowed: true, domains: ["mermaid.ink"] },
};
// svg/png require the network (mermaid.ink); network_rendering:"ask" routes it through the approval card,
// and a deny leaves a local-only (json/md/html[/pins]) partial run — by contract, not a bug.
const WIRING_RENDER_POLICY = { formats: ["json", "md", "html", "pins", "svg", "png"], network_rendering: "ask", timeout_ms: WIRING_TIMEOUT_MS };
const DIAGRAM_RENDER_POLICY = { formats: ["json", "md", "html", "svg", "png"], network_rendering: "ask", timeout_ms: DIAGRAM_TIMEOUT_MS };

// Build the start_phase envelope for a wiring/diagram run. source_phase_complete_path is effectively
// required for a success run (a missing upstream is UPSTREAM_PHASE_MISSING -> partial); the extension
// persists no per-phase phase_complete yet, so it defaults to null (omit-and-degrade until ruili Q3).
export function buildOptionalFlowDispatch(flow: OptionalFlow, input: {
  sessionId: string;
  msgId: string;
  timestamp: string;
  sourcePhaseCompletePath?: string | null;
}): Record<string, unknown> {
  const phase = OPTIONAL_FLOW_PHASE_BY_FLOW[flow];
  const payload: Record<string, unknown> = {
    mode: "full",
    invocation_mode: "plugin_protocol",
    local_test: false,
    source_phase: "upy-generate-plugin",
    source_phase_complete_path: input.sourcePhaseCompletePath ?? null,
    runtime_context: optionalFlowRuntimeContext(input.sessionId, phase),
    capabilities: flow === "wiring" ? WIRING_CAPABILITIES : DIAGRAM_CAPABILITIES,
    render_policy: flow === "wiring" ? WIRING_RENDER_POLICY : DIAGRAM_RENDER_POLICY,
  };
  // diagram: null complexity triggers the plugin's diagram_complexity approval card.
  if (flow === "diagram") payload.complexity = null;
  return {
    protocol_version: OPTIONAL_FLOW_PROTOCOL_VERSION,
    type: "start_phase",
    phase,
    session_id: input.sessionId,
    msg_id: input.msgId,
    timestamp: input.timestamp,
    idempotency_key: `${phase}:${input.sessionId}:start:v1`,
    payload,
  };
}
