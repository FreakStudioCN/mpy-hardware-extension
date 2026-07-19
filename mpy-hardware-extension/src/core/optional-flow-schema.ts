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

// Wrap the captured generate phase_complete PAYLOAD back into the full message envelope the wiring/diagram
// plugins require at source_phase_complete_path. Their validate_upstream hard-checks data.type ==
// "phase_complete", the message-level phase == "upy-generate-plugin", and payload.result/manifest_content —
// the bare payload (which the controller stores) fails all of those. optional_next_phases is normalized to
// the object shape (validate_upstream counts only dict items). session_id/msg_id/timestamp are cosmetic
// (not validated) but match the sample shape.
export function wrapGeneratePhaseComplete(
  payload: unknown,
  optionalNextPhases: Array<{ phase?: string; reason?: string }>,
  ids: { sessionId: string; msgId: string; timestamp: string },
): Record<string, unknown> {
  const base = (payload && typeof payload === "object") ? (payload as Record<string, unknown>) : {};
  return {
    protocol_version: OPTIONAL_FLOW_PROTOCOL_VERSION,
    type: "phase_complete",
    phase: "upy-generate-plugin",
    session_id: ids.sessionId,
    msg_id: ids.msgId,
    timestamp: ids.timestamp,
    payload: { ...base, optional_next_phases: optionalNextPhases },
  };
}

// A wiring/diagram post-run render must NOT upload to mermaid.ink when the user denied the network render.
// The denial arrives two ways and either suffices: a structured `network_permission.decision === "deny"`
// (the diagram deny fixture carries it; the controller now retains it), or a *_PERMISSION_DENIED error code
// — DIAGRAM_PERMISSION_DENIED / WIRING_IMAGE_RENDER_PERMISSION_DENIED. Match those code shapes anchored on
// the DIAGRAM/WIRING prefix, NOT a bare `_PERMISSION_DENIED` substring, so a plugin-internal
// FILE_/SCRIPT_PERMISSION_DENIED (a file/script access denial, not a network one) is not misread as a
// network decline. The old code matched only `/RENDER_PERMISSION_DENIED/`, which misses DIAGRAM_PERMISSION_DENIED.
export function isNetworkRenderDenied(runInfo?: { errors?: unknown; network_permission?: unknown }): boolean {
  const decision = (runInfo?.network_permission as { decision?: unknown } | undefined)?.decision;
  if (decision === "deny") return true;
  return /(?:DIAGRAM|WIRING)(?:_IMAGE_RENDER)?_PERMISSION_DENIED/.test(JSON.stringify(runInfo?.errors ?? ""));
}

// Build the start_phase envelope for a wiring/diagram run. source_phase_complete_path points at the
// persisted upstream generate phase_complete (see wrapGeneratePhaseComplete); a missing/invalid upstream
// is UPSTREAM_PHASE_MISSING/INVALID -> partial.
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
