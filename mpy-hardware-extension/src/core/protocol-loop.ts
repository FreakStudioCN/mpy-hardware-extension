// The plugin-interface client loop. The server (cloud) decides; this is the dumb
// executor: it sends start_phase, receives the 6 protocol tools over SSE, runs each
// on the user's machine, feeds results back, and auto-advances phases on
// phase_complete. Mirrors the proven backend e2e harness, in TypeScript.
import { PROTOCOL_TOOLS, PROTOCOL_TOOL_NAMES, routeForTool } from "./protocol-registry.ts";

export const PHASE_ORDER = ["analyze", "select-hw", "scaffold", "generate", "wiring", "diagram", "deploy", "deploy-test", "autofix"] as const;

const MAX_TURNS_PER_PHASE = 10;
const MAX_PHASES = 9;

type StreamEvent = { type: string; text?: string; id?: string; name?: string; input?: any; invalidInput?: string; message?: string; finishReason?: string };
type LlmClient = { streamMessages: (body: any, signal?: any) => Promise<AsyncIterable<StreamEvent>> | AsyncIterable<StreamEvent> };

export type ProtocolDeps = {
  llmClient: LlmClient;
  // Device I/O (mpremote). action -> result; the host wires this to the real shim.
  device?: (action: string, payload: any) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error_kind?: string }>;
  // Workspace file I/O (host enforces path containment).
  writeFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>;
  readFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>;
  listFiles?: (path: string) => Promise<{ ok: boolean; entries?: string[]; error_kind?: string }>;
  // Host script runner (flake8/pytest/render_*). Best-effort; absent = reported ok-noop.
  runScript?: (interpreter: string, script: string, args: string[]) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exit_code?: number; error_kind?: string }>;
};

export type ProtocolInput = {
  intent: string;
  boardId?: string;
  traceId?: string;
  signal?: { aborted: boolean };
  onEvent?: (event: any) => void;
  // The single rich approval gate (replaces ask/components/plan/deploy). Resolves the
  // user's decision; null/undefined = headless auto-confirm (select all items).
  confirmApproval?: (card: any) => Promise<{ action: string; selected_ids?: string[]; added_items?: any[]; text_values?: any; notes?: string } | null>;
  startPhase?: string;
  startManifest?: any;
};

export type ProtocolResult = {
  phases: Array<{ phase: string; result: string | null }>;
  manifest: any;
  terminal: string; // "complete" | "stalled" | "cancelled"
};

function asyncEvents(source: AsyncIterable<StreamEvent>): AsyncIterator<StreamEvent> {
  return source[Symbol.asyncIterator]();
}

// Drive one phase to its phase_complete (or stall/cancel). Returns the control the
// notify executor captured from phase_complete.
async function runPhase(phase: string, manifest: any, input: ProtocolInput, deps: ProtocolDeps) {
  const messages: any[] = [{ role: "user", content: input.intent }];
  for (let turn = 0; turn < MAX_TURNS_PER_PHASE; turn++) {
    if (input.signal?.aborted) return { done: false, cancelled: true };
    const body = { phase, manifest, messages, tools: PROTOCOL_TOOLS, trace_id: input.traceId };
    const source = await deps.llmClient.streamMessages(body, input.signal);
    const it = asyncEvents(source as AsyncIterable<StreamEvent>);

    let text = "", thinking = "";
    const toolUses: StreamEvent[] = [];
    let streamError: string | null = null;
    while (true) {
      let next: IteratorResult<StreamEvent>;
      try { next = await it.next(); } catch { try { await it.return?.(undefined); } catch { /* ignore */ } break; }
      if (next.done) break;
      const ev = next.value;
      if (ev.type === "text_delta") text += ev.text ?? "";
      else if (ev.type === "thinking_delta") thinking += ev.text ?? "";
      else if (ev.type === "tool_use_complete") toolUses.push(ev);
      else if (ev.type === "stream_error") streamError = ev.message ?? "stream_error";
    }
    // A mid-stream abort throws out of it.next() and lands here with the signal set —
    // surface it as cancelled, not a normal (stalled) end.
    if (input.signal?.aborted) { try { await it.return?.(undefined); } catch { /* ignore */ } return { done: false, cancelled: true }; }
    if (streamError) return { done: false, stalled: true, error: streamError };

    const blocks: any[] = [];
    if (thinking) blocks.push({ type: "thinking", thinking });
    if (text) blocks.push({ type: "text", text });
    for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    messages.push({ role: "assistant", content: blocks });

    if (toolUses.length === 0) return { done: false, stalled: true };
    // A mid-stream cancel may have ended the read with a partial tool list; don't
    // execute device/file side effects after the user aborted.
    if (input.signal?.aborted) return { done: false, cancelled: true };

    const toolResults: any[] = [];
    let control: any = null;
    for (const tu of toolUses) {
      // Honor a cancel that lands between tools in the same streamed batch.
      if (input.signal?.aborted) return { done: false, cancelled: true };
      const { result, phaseControl } = await executeProtocolTool(tu, input, deps);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      if (tu.name === "phase_complete" && phaseControl) control = phaseControl;
    }
    messages.push({ role: "user", content: toolResults });
    if (control) return { done: true, control };
  }
  return { done: false, stalled: true };
}

export async function runProtocolBuild(input: ProtocolInput, deps: ProtocolDeps): Promise<ProtocolResult> {
  let phase = input.startPhase ?? "analyze";
  let manifest = input.startManifest ?? {};
  const phases: Array<{ phase: string; result: string | null }> = [];
  for (let i = 0; i < MAX_PHASES; i++) {
    if (input.signal?.aborted) return { phases, manifest, terminal: "cancelled" };
    input.onEvent?.({ type: "phase_start", phase });
    const outcome = await runPhase(phase, manifest, input, deps);
    if (outcome.cancelled) return { phases, manifest, terminal: "cancelled" };
    if (!outcome.done || !outcome.control) {
      phases.push({ phase, result: null });
      return { phases, manifest, terminal: "stalled" };
    }
    const ctrl = outcome.control;
    phases.push({ phase, result: ctrl.result ?? "success" });
    if (ctrl.manifest && typeof ctrl.manifest === "object") manifest = ctrl.manifest;
    if (!ctrl.next_phase) return { phases, manifest, terminal: ctrl.result === "failed" ? "failed" : "complete" };
    phase = String(ctrl.next_phase);
  }
  // Ran the phase cap without a null next_phase: nonterminal, not a success.
  return { phases, manifest, terminal: "incomplete" };
}

// Execute one protocol tool the way a thin plugin would. Returns the result block
// fed back to the model, plus (for phase_complete) the phase-advance control.
export async function executeProtocolTool(tu: StreamEvent, input: ProtocolInput, deps: ProtocolDeps): Promise<{ result: any; phaseControl?: any }> {
  const name = tu.name ?? "";
  const p = tu.input ?? {};

  if (tu.invalidInput) {
    return { result: { ok: false, error_kind: "protocol_payload_invalid", detail: tu.invalidInput } };
  }
  if (!PROTOCOL_TOOL_NAMES.has(name)) {
    // Off-protocol (e.g. a dead 27-tool name): tell the model so it corrects.
    return { result: { ok: false, error_kind: "unknown_tool", detail: name } };
  }
  const route = routeForTool(name);

  if (route === "notify") {
    if (name === "status_update") {
      input.onEvent?.({ type: "status_update", payload: p });
      return { result: { ok: true } };
    }
    // phase_complete: surface artifacts + carry the manifest forward (auto-acked).
    input.onEvent?.({ type: "phase_complete", payload: p });
    if (p.manifest_content) input.onEvent?.({ type: "manifest_updated", manifest: p.manifest_content });
    return { result: { ok: true }, phaseControl: { result: p.result, next_phase: p.next_phase, manifest: p.manifest_content } };
  }

  if (route === "ui") {
    // The single rich approval gate. With NO callback (headless/test) we auto-confirm
    // and select all items. With a callback, null means the user dismissed/cancelled
    // (NOT auto-confirm), so it must abort — conflating the two would silently approve.
    if (typeof input.confirmApproval !== "function") {
      const ids = [
        ...((p.items ?? []).map((i: any) => i?.id)),
        ...((p.item_groups ?? []).flatMap((g: any) => (g?.items ?? []).map((i: any) => i?.id))),
      ].filter(Boolean);
      const action = (p.actions?.find((a: any) => a.primary)?.value) ?? "confirm";
      return { result: { ok: true, approval_id: p.approval_id, action, selected_ids: ids, added_items: [], text_values: {}, notes: "" } };
    }
    const decision = await input.confirmApproval(p);
    if (decision == null || decision.action === "cancel") return { result: { ok: false, error_kind: "user_cancelled" } };
    return { result: { ok: true, approval_id: p.approval_id, action: decision.action, selected_ids: decision.selected_ids ?? [], added_items: decision.added_items ?? [], text_values: decision.text_values ?? {}, notes: decision.notes ?? "" } };
  }

  if (route === "fs") {
    return { result: await execFileOperation(p, deps, input) };
  }

  if (route === "host") {
    if (typeof deps.runScript !== "function") return { result: { ok: true, success: true, stdout: "", exit_code: 0, note: "host_runner_absent" } };
    const r = await deps.runScript(String(p.interpreter ?? "python"), String(p.script ?? ""), Array.isArray(p.args) ? p.args.map(String) : []);
    return { result: { ok: true, script_id: p.script_id, success: r.ok, stdout: r.stdout ?? "", stderr: r.stderr ?? "", exit_code: r.exit_code ?? (r.ok ? 0 : 1) } };
  }

  if (route === "device") {
    if (typeof deps.device !== "function") return { result: { ok: false, error_kind: "device_unavailable" } };
    try {
      const r = await deps.device(String(p.action ?? ""), p);
      if (r.stdout) input.onEvent?.({ type: "serial_output", lines: String(r.stdout).split("\n").filter(Boolean) });
      return { result: { ok: r.ok, cmd_id: p.cmd_id, success: r.ok, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error_kind: r.ok ? undefined : (r.error_kind ?? "runtime_error") } };
    } catch (error: any) {
      return { result: { ok: false, cmd_id: p.cmd_id, success: false, error_kind: "runtime_error", message: error?.message ?? "device_error" } };
    }
  }

  return { result: { ok: false, error_kind: "unrouted_tool", detail: name } };
}

async function execFileOperation(p: any, deps: ProtocolDeps, input: ProtocolInput) {
  const op = p.op;
  const path = String(p.path ?? "");
  if ((op === "write" || op === "append")) {
    if (typeof deps.writeFile !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.writeFile(path, String(p.content ?? ""));
    if (r.ok) input.onEvent?.({ type: "file_written", path: r.path ?? path });
    return { ok: r.ok, op_id: p.op_id, success: r.ok, error: r.ok ? null : (r.error_kind ?? "write_failed") };
  }
  if (op === "read") {
    if (typeof deps.readFile !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.readFile(path);
    return { ok: r.ok, op_id: p.op_id, success: r.ok, content: r.content ?? "", error: r.ok ? null : (r.error_kind ?? "read_failed") };
  }
  if (op === "list") {
    if (typeof deps.listFiles !== "function") return { ok: true, op_id: p.op_id, success: true, entries: [] };
    const r = await deps.listFiles(path);
    return { ok: r.ok, op_id: p.op_id, success: r.ok, entries: r.entries ?? [], error: r.ok ? null : (r.error_kind ?? "list_failed") };
  }
  // mkdir / delete: best-effort no-op success (host applies real semantics).
  return { ok: true, op_id: p.op_id, success: true };
}
