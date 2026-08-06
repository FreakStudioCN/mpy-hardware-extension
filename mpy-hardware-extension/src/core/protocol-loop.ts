// The plugin-interface client loop. The server (cloud) decides; this is the dumb
// executor: it sends start_phase, receives the 6 protocol tools over SSE, runs each
// on the user's machine, feeds results back, and auto-advances phases on
// phase_complete. Mirrors the proven backend e2e harness, in TypeScript.
import { PROTOCOL_TOOLS, PROTOCOL_TOOL_NAMES, routeForTool } from "./protocol-registry.ts";

export const PHASE_ORDER = ["analyze", "select-hw", "upy-flash-mpy-firmware-plugin", "upy-scaffold-plugin", "upy-generate-plugin", "upy-deploy-plugin"] as const;

// V0 phases are script-heavy and the model emits ONE tool per turn, so a phase can
// legitimately take dozens of turns (select-hw ~40, generate ~49). The old cap of 10
// stalled every V0 phase. Callers (e.g. the e2e) override via input.maxTurnsPerPhase.
const MAX_TURNS_PER_PHASE = 60;
// A turn with no tool call can't advance the protocol. Re-prompt the model to emit a
// tool rather than stalling the whole build on the first prose-only reply (which froze
// the UI on the current step); only give up after this many CONSECUTIVE prose turns.
const MAX_TOOLLESS_TURNS = 3;
const MAX_PHASES = PHASE_ORDER.length;

// device_command actions whose stdout is real device/REPL output, worth surfacing on
// the Serial page. Everything else the device route dispatches (ls, scan/devs, cp,
// mkdir, rm, cp_from, ...) returns host-side bookkeeping (a file listing, a port
// list) whose stdout is NOT REPL output — posting it as serial_output is what put
// file lists on the Serial page instead of the device's actual output.
const SERIAL_OUTPUT_ACTIONS = new Set(["stream", "read"]);

export const PHASE_ALIASES: Record<string, string> = {
  "analyze": "analyze",
  "upy-analyze-plugin": "analyze",
  "select-hw": "select-hw",
  "upy-select-hw": "select-hw",
  "upy-select-hw-plugin": "select-hw",
  "flash-mpy-firmware": "upy-flash-mpy-firmware-plugin",
  "upy-flash-mpy-firmware": "upy-flash-mpy-firmware-plugin",
  "upy-flash-mpy-firmware-plugin": "upy-flash-mpy-firmware-plugin",
  "scaffold": "upy-scaffold-plugin",
  "upy-scaffold": "upy-scaffold-plugin",
  "upy-scaffold-plugin": "upy-scaffold-plugin",
  "generate": "upy-generate-plugin",
  "upy-generate": "upy-generate-plugin",
  "upy-generate-plugin": "upy-generate-plugin",
  "deploy": "upy-deploy-plugin",
  "upy-deploy": "upy-deploy-plugin",
  "upy-deploy-plugin": "upy-deploy-plugin",
  // Optional flows (on-demand start_phase, NOT in PHASE_ORDER): resolve their tokens so a
  // next_phase referencing them (e.g. a pre-generate gate emitting upy-gen-driver-plugin)
  // advances instead of hitting unknown_next_phase. Lockstep with contracts/phase_aliases.json.
  "gen-driver": "upy-gen-driver-plugin",
  "upy-gen-driver": "upy-gen-driver-plugin",
  "upy-gen-driver-plugin": "upy-gen-driver-plugin",
  "wiring": "upy-wiring-plugin",
  "upy-wiring": "upy-wiring-plugin",
  "upy-wiring-plugin": "upy-wiring-plugin",
  "diagram": "upy-diagram-plugin",
  "upy-diagram": "upy-diagram-plugin",
  "upy-diagram-plugin": "upy-diagram-plugin",
  // Sipeed MaixPy export: a STANDALONE global tool, dispatched by its own start_phase and never
  // part of the canonical chain. Aliased for the same reason as the optional flows — an
  // un-aliased token would fail to resolve — while the no-chain firewall stays PHASE_ORDER
  // omission plus the plugin always emitting next_phase:null.
  "sipeed-vision": "upy-maixpy-export-plugin",
  "maixpy-export": "upy-maixpy-export-plugin",
  "upy-maixpy-export-plugin": "upy-maixpy-export-plugin",
};

function phaseToken(value: any): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || ["null", "none"].includes(raw.toLowerCase())) return null;
  return raw.replace(/^\/+/, "");
}

function normalizePhase(value: any): string | null {
  const token = phaseToken(value);
  if (!token) return null;
  return PHASE_ALIASES[token] ?? null;
}

// Headless/no-board contexts pick the "already handled on hardware" action so a flash
// approval doesn't try to drive a device that isn't there. The panel passes a real
// confirmApproval callback and never hits this.
const NO_HARDWARE_ACTIONS = ["already_flashed", "use_local_firmware", "confirm_flashed", "copied_uf2", "copied", "confirmed"];

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
  // mkdir / delete (host enforces containment). The generate phase deletes
  // firmware/tools/ before the mpy_imports gate, so these must do REAL fs work 鈥?  // a no-op that returns success would silently leave the gate-failing files behind.
  makeDir?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
  deletePath?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
  // Host script runner: runs a bundled V0 plugin script (or shell command) on the
  // user's machine. `extra` carries the model's stdin/timeout. ABSENT or a missing
  // script is a hard failure (ok:false), never a faked success. `structured_errors`
  // (when the host has parsed the script's JSON, e.g. run_quality_gates' generate_plan
  // gate) lets the loop react deterministically instead of the model parsing raw JSON.
  // `extra.phase` is the active phase token: the host resolver uses it to disambiguate a
  // script basename shipped by >1 served plugin (e.g. update_session_state.py in generate +
  // gen-driver) to the running phase's own copy, so the model never has to qualify.
  runScript?: (interpreter: string, script: string, args: string[], extra?: { stdin_content?: string; stdin_json?: any; timeout_ms?: number; phase?: string }) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exit_code?: number; error_kind?: string; candidates?: string[]; structured_errors?: Array<{ code?: string; path?: string; message?: string }> }>;
};

export type ProtocolInput = {
  intent: string;
  boardId?: string;
  traceId?: string;
  signal?: { aborted: boolean };
  onEvent?: (event: any) => void;
  // Safe-point hook (deliverables 07 §5): called after each phase_complete, before the
  // next phase starts. The host consumes queued user supplements and returns absorb text
  // to fold into the NEXT phase's context (null = nothing to absorb). reroute/reconfirm
  // are surfaced by the host; for P0 they do not change the loop's phase advance.
  // hasNextPhase tells the host whether a phase actually follows: on the terminal phase
  // there is nowhere to fold absorbed text, so the host surfaces such a note as deferred
  // instead of falsely reporting it applied.
  onSafePoint?: (phase: string, hasNextPhase: boolean) => string | null;
  // The single rich approval gate (replaces ask/components/plan/deploy). Resolves the
  // user's decision; null/undefined = headless auto-confirm (select all items).
  confirmApproval?: (card: any) => Promise<{ action: string; selected_ids?: string[]; added_items?: any[]; text_values?: any; notes?: string; serial_port?: string; baud?: string | number } | null>;
  startPhase?: string;
  startManifest?: any;
  // Per-phase turn cap (default MAX_TURNS_PER_PHASE). V0 phases need a high budget.
  maxTurnsPerPhase?: number;
  // Handoff-required user context carried to the server: interaction mode, UI locale,
  // any hardware the user already owns, and an optional full official board fact object.
  preferences?: { mode?: string; locale?: string; existing_hardware?: string };
  preSelectedBoard?: any;
  // "recommend" when the user asked the system to pick the board (no pre_selected_board).
  boardSelectionMode?: string;
};

export type ProtocolResult = {
  phases: Array<{ phase: string; result: string | null }>;
  manifest: any;
  terminal: string; // "complete" | "stalled" | "cancelled"
};

function asyncEvents(source: AsyncIterable<StreamEvent>): AsyncIterator<StreamEvent> {
  return source[Symbol.asyncIterator]();
}

// The handoff-required user context: preferences + pre_selected_board. The new UI
// passes the full official board fact object; legacy callers that only know boardId
// still get the old string shape for compatibility.
function buildContext(input: ProtocolInput, absorbedSupplements: string[]): Record<string, any> | null {
  const ctx: Record<string, any> = { ...(input.preferences ?? {}) };
  if (input.preSelectedBoard) ctx.pre_selected_board = input.preSelectedBoard;
  else if (input.boardId && input.boardId !== "auto") ctx.pre_selected_board = input.boardId;
  // Carry the explicit recommend signal only when no board was pre-selected.
  if (input.boardSelectionMode && !ctx.pre_selected_board) ctx.board_selection_mode = input.boardSelectionMode;
  // Absorbed user supplements (deliverables 07 §6): extra guidance folded into the phase
  // context so the model sees the note without a schema change.
  if (absorbedSupplements.length) ctx.user_supplements = absorbedSupplements;
  return Object.keys(ctx).length ? ctx : null;
}

// Longest string field kept verbatim in the tool_use telemetry payload.
const TELEMETRY_INPUT_STRING_BUDGET = 200;

// Shrink a tool input down to the IDENTITY of the call (tool, path, script_id, flags)
// for telemetry. A file_operation write carries a whole generated file, and a phase can burn
// its full 60-turn budget rewriting the same files, so emitting inputs verbatim would
// bury every other event in the trace under file bodies. The size guard in telemetry.ts
// truncates such a field but does not shrink it, and the content is not what a stall
// triage reads: WHICH file was rewritten how many times is.
// ponytail: one level deep. A nested object is recorded as "<object>", not walked, so an
// input that hides its path inside a sub-object shows nothing useful -- walk it only if a
// real trace needs it.
function compactToolInput(input: any): Record<string, any> {
  const compact: Record<string, any> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") compact[key] = value.length > TELEMETRY_INPUT_STRING_BUDGET ? `<${value.length} chars>` : value;
    else if (Array.isArray(value)) compact[key] = `<${value.length} items>`;
    else if (value && typeof value === "object") compact[key] = "<object>";
    else compact[key] = value;
  }
  return compact;
}

// How many recent tool failures a stalled phase reports as its detail.
const STALL_DETAIL_LIMIT = 3;

// One gate-report entry, read in BOTH real shapes. run_quality_gates.py emits objects
// ({code, path}); the select-hw / analyze validators emit a plain string per problem
// ("selected_board.display_name is required"). Reading only `.code` turned every
// string-shaped report into an empty object, so a stalled phase reported "failed" and the
// DB stored `errors: [{}, {}, {}]` -- the report was there and unreadable.
function gateEntryReason(entry: any): string {
  if (typeof entry === "string") return entry;
  return String(entry?.code ?? entry?.message ?? "");
}

// The one-line "what actually blocked this call" for a failing tool result, or null when it
// succeeded. A stalled phase carries the last few of these so the stall names its blocker
// instead of a bare "max_turns" the user reads as transient.
// Three result shapes have to be read, because three routes produce them: fs ops report
// `error`, host/protocol failures report `error_kind`, and a script that RAN but whose gate
// REJECTED reports ok:true/success:false with structured_errors.
// Error kinds and paths only. Never content.
function toolFailure(tu: StreamEvent, result: any): { tool: string; error: string; path?: string } | null {
  const failed = result?.ok === false || (result?.ok === true && result?.success === false);
  if (!failed) return null;
  const reasons = (result?.structured_errors ?? []).map(gateEntryReason).filter(Boolean);
  const error = result?.error_kind ?? result?.error ?? reasons[0] ?? "failed";
  const target = (tu.input as any)?.path ?? (tu.input as any)?.script;
  return { tool: tu.name ?? "", error: String(error), ...(target ? { path: String(target) } : {}) };
}

// Drive one phase to its phase_complete (or stall/cancel). Returns the control the
// notify executor captured from phase_complete.
async function runPhase(phase: string, manifest: any, input: ProtocolInput, deps: ProtocolDeps, absorbedSupplements: string[]) {
  const messages: any[] = [{ role: "user", content: input.intent }];
  const maxTurns = input.maxTurnsPerPhase ?? MAX_TURNS_PER_PHASE;
  const context = buildContext(input, absorbedSupplements);
  let toollessTurns = 0;
  // Rolling window of the most recent failing tool calls, reported if the phase gives up.
  const recentFailures: Array<{ tool: string; error: string; path?: string }> = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    if (input.signal?.aborted) return { done: false, cancelled: true };
    const body = { phase, manifest, messages, tools: PROTOCOL_TOOLS, trace_id: input.traceId, ...(context ? { context } : {}) };
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
      // Live credit balance streamed after each turn. Forward it so the controller can
      // update the quota bar; without this the production protocol path swallows it and
      // the balance never moves mid-build (only the panel-load REST fetch keeps it fresh).
      else if (ev.type === "credits") input.onEvent?.(ev);
    }
    // A mid-stream abort throws out of it.next() and lands here with the signal set 鈥?    // surface it as cancelled, not a normal (stalled) end.
    if (input.signal?.aborted) { try { await it.return?.(undefined); } catch { /* ignore */ } return { done: false, cancelled: true }; }
    if (streamError) return { done: false, stalled: true, error: streamError };

    const blocks: any[] = [];
    if (thinking) blocks.push({ type: "thinking", thinking });
    if (text) blocks.push({ type: "text", text });
    for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    messages.push({ role: "assistant", content: blocks });

    if (toolUses.length === 0) {
      // A prose-only turn can't advance the protocol. Stalling on the FIRST chatty reply
      // froze the UI on the current step ("姝ｅ湪鎼滅储椹卞姩") with no error 鈥?so nudge the
      // model to emit a tool, bounded, and only give up after MAX_TOOLLESS_TURNS in a row.
      if (++toollessTurns >= MAX_TOOLLESS_TURNS) {
        input.onEvent?.({ type: "phase_stalled", phase, reason: "no_tool_call", detail: [...recentFailures] });
        return { done: false, stalled: true };
      }
      messages.push({ role: "user", content: [{ type: "text", text: "You must call exactly one protocol tool to proceed. Respond with a tool call, not prose." }] });
      continue;
    }
    toollessTurns = 0;
    // A mid-stream cancel may have ended the read with a partial tool list; don't
    // execute device/file side effects after the user aborted.
    if (input.signal?.aborted) return { done: false, cancelled: true };

    const toolResults: any[] = [];
    const correctiveMessages: any[] = [];
    let control: any = null;
    for (const tu of toolUses) {
      // Honor a cancel that lands between tools in the same streamed batch.
      if (input.signal?.aborted) return { done: false, cancelled: true };
      // The failure spine. Without these two the cloud recorder knew a phase ran its turn
      // cap and nothing about WHICH tool ran or why its result was rejected, so a
      // phase_stalled/max_turns was undiagnosable from the DB. The recorder already maps
      // both shapes and the server already allowlists both event types.
      input.onEvent?.({ type: "tool_use", name: tu.name, input: compactToolInput(tu.input) });
      const { result, phaseControl } = await executeProtocolTool(tu, input, deps, { phase, turn });
      input.onEvent?.({ type: "tool_result", name: tu.name, observation: result });
      const failure = toolFailure(tu, result);
      if (failure) {
        recentFailures.push(failure);
        if (recentFailures.length > STALL_DETAIL_LIMIT) recentFailures.shift();
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      if (tu.name === "phase_complete" && phaseControl) control = phaseControl;
      // A host script result carrying GENERATE_PLAN_* structured errors gets a
      // deterministic corrective message enumerating code+path -- don't rely on the
      // model parsing the raw JSON tool_result to find its own mistakes.
      const planErrors = (result?.structured_errors ?? []).filter((e: any) => String(e?.code ?? "").startsWith("GENERATE_PLAN"));
      if (planErrors.length > 0) {
        correctiveMessages.push({
          role: "user",
          content: [{
            type: "text",
            text:
              "Quality gate failed on generate_plan.json. Fix exactly these entries, then re-run the gate:\n" +
              planErrors.map((e: any) => `- ${e.code}: ${e.path ?? e.message ?? ""}`).join("\n"),
          }],
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
    for (const m of correctiveMessages) messages.push(m);
    if (control) return { done: true, control };
  }
  input.onEvent?.({ type: "phase_stalled", phase, reason: "max_turns", detail: [...recentFailures] });
  return { done: false, stalled: true };
}

export async function runProtocolBuild(input: ProtocolInput, deps: ProtocolDeps): Promise<ProtocolResult> {
  let phase = input.startPhase ?? "analyze";
  let manifest = input.startManifest ?? {};
  const phases: Array<{ phase: string; result: string | null }> = [];
  // User supplements absorbed at safe points, carried into subsequent phases' context.
  const absorbedSupplements: string[] = [];
  for (let i = 0; i < MAX_PHASES; i++) {
    if (input.signal?.aborted) return { phases, manifest, terminal: "cancelled" };
    input.onEvent?.({ type: "phase_start", phase });
    const outcome = await runPhase(phase, manifest, input, deps, absorbedSupplements);
    if (outcome.cancelled) return { phases, manifest, terminal: "cancelled" };
    if (!outcome.done || !outcome.control) {
      phases.push({ phase, result: null });
      return { phases, manifest, terminal: "stalled" };
    }
    const ctrl = outcome.control;
    phases.push({ phase, result: ctrl.result ?? "success" });
    if (ctrl.manifest && typeof ctrl.manifest === "object") manifest = ctrl.manifest;
    // Resolve the next phase FIRST so the safe point knows whether absorbed text has
    // anywhere to go. The model sometimes emits the literal string "null"/"none"/""
    // instead of JSON null — treat those as terminal too, otherwise the loop spawns a
    // phantom phase named "null".
    const requestedNext = phaseToken(ctrl.next_skill) ?? phaseToken(ctrl.next_phase);
    const next = requestedNext ? normalizePhase(requestedNext) : null;
    // Safe point (deliverables 07 §5): consume queued supplements before auto-advancing.
    // Absorbed text is folded into the next phase's context; reroute/reconfirm are
    // surfaced by the host and, for P0, do not change the phase the model chose next.
    const absorb = input.onSafePoint?.(phase, !!next);
    if (absorb) absorbedSupplements.push(absorb);
    // Terminal when there's no next phase.
    if (!requestedNext) {
      return { phases, manifest, terminal: ctrl.result === "failed" ? "failed" : "complete" };
    }
    if (!next) {
      input.onEvent?.({ type: "phase_error", error_kind: "unknown_next_phase", next_phase: requestedNext });
      return { phases, manifest, terminal: "failed" };
    }
    phase = next;
  }
  // Ran the phase cap without a null next_phase: nonterminal, not a success.
  return { phases, manifest, terminal: "incomplete" };
}

// A V0 gate script reports as a JSON object on stdout, in one of two REAL shapes
// (derived from the vendored upy-generate-plugin scripts -- adapt this parser to the
// scripts, never the scripts to the parser):
//   1. A standalone check (check_generate_plan.py check_project()): granular entries
//      under a top-level `errors` array; no structured_errors key at all.
//   2. run_quality_gates.py: a top-level `structured_errors` array with one AGGREGATE
//      entry per failing check (code "<NAME>_FAILED", no path) whose granular entries
//      are nested at structured_errors[i].details.errors (normalize_script_result).
// Normalize both into one flat {code, path?, message?} list. Aggregates that carry
// granular details are REPLACED by them (the corrective message must enumerate the
// actionable code+path pairs, not an opaque "<NAME>_FAILED"); an aggregate without
// details stands for itself. Any other stdout (plain text, broken JSON, JSON without
// error arrays, or a success report with empty arrays) returns undefined and changes
// nothing about existing behavior. A parse failure here is NOT an error condition: it
// just means "not a JSON report".
function structuredErrorsFromStdout(stdout: unknown): Array<{ code?: string; path?: string; message?: string }> | undefined {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text.startsWith("{")) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const flat: Array<{ code?: string; path?: string; message?: string }> = [];
  if (Array.isArray(parsed.errors)) flat.push(...parsed.errors);
  if (Array.isArray(parsed.structured_errors)) {
    for (const entry of parsed.structured_errors) {
      const nested = entry?.details?.errors;
      if (Array.isArray(nested) && nested.length > 0) flat.push(...nested);
      else flat.push(entry);
    }
  }
  return flat.length > 0 ? flat : undefined;
}

// Execute one protocol tool the way a thin plugin would. Returns the result block
// fed back to the model, plus (for phase_complete) the phase-advance control.
// `phaseCtx` (phase + turn index within it) is only needed for the turn-0 generate
// empty-project guard below; callers that don't care (most direct tests) omit it.
export async function executeProtocolTool(tu: StreamEvent, input: ProtocolInput, deps: ProtocolDeps, phaseCtx: { phase?: string; turn?: number } = {}): Promise<{ result: any; phaseControl?: any }> {
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
    // A phase_complete with no `result` is malformed/truncated 鈥?reject it (no
    // phaseControl) so the phase keeps going and the model re-emits a complete one,
    // instead of silently ending the build with an undefined result.
    if (!p.result) {
      return { result: { ok: false, error_kind: "phase_complete_incomplete", detail: "phase_complete requires a result (success/partial/failed) and, on success, a next_phase" } };
    }
    // Turn 0 of the generate phase: upy-scaffold-plugin already ran, so the project is
    // never empty at this point. A failed bail back to analyze here is a hallucination,
    // not a real failure -- reject it (no phaseControl) so the phase keeps going and the
    // model retries, instead of destroying completed work by restarting from analyze.
    const requestedNext = phaseToken(p.next_skill) ?? phaseToken(p.next_phase);
    if (
      phaseCtx.phase === "upy-generate-plugin" &&
      phaseCtx.turn === 0 &&
      p.result === "failed" &&
      requestedNext?.toLowerCase().includes("analyze")
    ) {
      return {
        result: {
          ok: false,
          error_kind: "empty_project_hallucination",
          message:
            "Rejected: scaffold already ran; the project is not empty. Use file_operation " +
            "(op=\"list\") on firmware/ to see the real tree, then continue generate. Do not bail to analyze.",
        },
      };
    }
    input.onEvent?.({ type: "phase_complete", payload: p });
    if (p.manifest_content) input.onEvent?.({ type: "manifest_updated", manifest: p.manifest_content });
    return { result: { ok: true }, phaseControl: { result: p.result, next_phase: p.next_phase, next_skill: p.next_skill, manifest: p.manifest_content } };
  }

  if (route === "ui") {
    // The single rich approval gate. With NO callback (headless/test) we auto-confirm
    // and select all items. With a callback, null means the user dismissed/cancelled
    // (NOT auto-confirm), so it must abort 鈥?conflating the two would silently approve.
    if (typeof input.confirmApproval !== "function") {
      // item_groups is contract-valid as an array OR an object map; normalize to a list
      // that keeps each group's id + multi_select (the object form is keyed by id).
      // Array form uses group_id (spec 02-protocol.md); object form is keyed by group id.
      const groupList = Array.isArray(p.item_groups)
        ? p.item_groups.map((g: any) => ({ id: g?.group_id ?? g?.id, multi_select: g?.multi_select, items: g?.items }))
        : Object.entries(p.item_groups ?? {}).map(([id, meta]: [string, any]) => ({ id, multi_select: meta?.multi_select, items: meta?.items }));
      // A single-choice group (multi_select:false — scheduler mode) must contribute ONE
      // id, not all: auto-selecting every id would post timer+asyncio+_thread at once.
      const singleChoice = new Set(groupList.filter((g: any) => g?.multi_select === false).map((g: any) => String(g?.id)));
      const perGroup = new Map<string, any[]>();
      const takeAll: any[] = [];
      // Dedup by id: an item can appear BOTH in p.items (with .group === gid) and inline in a
      // group's items. Counting it twice pushed a duplicate id into selected_ids; bucket it once,
      // matching the webview's merge+dedup in renderApprovalGroup.
      const seen = new Set<string>();
      const bucket = (it: any, gid: string) => {
        const key = it?.id != null ? String(it.id) : null;
        if (key != null) { if (seen.has(key)) return; seen.add(key); }
        if (singleChoice.has(gid)) { const arr = perGroup.get(gid) ?? []; arr.push(it); perGroup.set(gid, arr); }
        else if (it?.id != null) takeAll.push(it.id);
      };
      for (const it of (p.items ?? [])) bucket(it, it?.group == null ? "" : String(it.group));
      for (const g of groupList) for (const it of (Array.isArray(g?.items) ? g.items : [])) bucket(it, String(g?.id));
      const oneEach = [...perGroup.values()].map((list) => (list.find((i: any) => i?.selected === true) ?? list[0])?.id);
      const ids = [...takeAll, ...oneEach].filter(Boolean);
      // Action key is `value`, but some cards (e.g. wiring network-render) carry only `id`.
      const actionKey = (a: any) => a?.value ?? a?.id;
      const values = (p.actions ?? []).map(actionKey).filter(Boolean);
      const action = NO_HARDWARE_ACTIONS.find((a) => values.includes(a))
        ?? actionKey(p.actions?.find((a: any) => a.primary)) ?? values[0] ?? "confirm";
      return { result: { ok: true, approval_id: p.approval_id, action, selected_ids: ids, added_items: [], text_values: {}, notes: "" } };
    }
    const decision = await input.confirmApproval(p);
    if (decision == null || decision.action === "cancel") return { result: { ok: false, error_kind: "user_cancelled" } };
    return { result: { ok: true, approval_id: p.approval_id, action: decision.action, selected_ids: decision.selected_ids ?? [], added_items: decision.added_items ?? [], text_values: decision.text_values ?? {}, notes: decision.notes ?? "", serial_port: decision.serial_port, baud: decision.baud } };
  }

  if (route === "fs") {
    return { result: await execFileOperation(p, deps, input) };
  }

  if (route === "host") {
    // Fail loud if there is no host runner 鈥?a faked ok:true here is what let every
    // V0 gate (check_*.py) silently "pass" without running.
    if (typeof deps.runScript !== "function") return { result: { ok: false, success: false, error_kind: "host_runner_absent" } };
    const r = await deps.runScript(
      String(p.interpreter ?? "python"),
      String(p.script ?? ""),
      Array.isArray(p.args) ? p.args.map(String) : [],
      { stdin_content: p.stdin_content, stdin_json: p.stdin_json, timeout_ms: p.timeout_ms, phase: phaseCtx.phase },
    );
    // ok:false = the call itself failed (host_runner_absent / script_not_found /
    // ambiguous_script_name) 鈥?surface it, forwarding any candidate qualified names so the
    // model can retry an ambiguous bare script name instead of re-sending it.
    if (r.ok === false) return { result: { ok: false, script_id: p.script_id, success: false, error_kind: r.error_kind ?? "script_error", stderr: r.stderr ?? "", candidates: r.candidates, structured_errors: r.structured_errors } };
    // The script RAN: success keys on its exit code (a non-zero gate is a real, fixable result).
    const exit = r.exit_code ?? 0;
    // The real host shim doesn't populate structured_errors -- it returns the script's
    // JSON report (run_quality_gates.py etc.) as a stdout STRING. Parse that shape
    // defensively so the loop's corrective path fires in production too; anything that
    // isn't a JSON report leaves the result exactly as before.
    const structuredErrors = r.structured_errors ?? structuredErrorsFromStdout(r.stdout);
    return { result: { ok: true, script_id: p.script_id, success: exit === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", exit_code: exit, structured_errors: structuredErrors } };
  }

  if (route === "device") {
    if (typeof deps.device !== "function") return { result: { ok: false, error_kind: "device_unavailable" } };
    try {
      const action = String(p.action ?? "");
      const r = await deps.device(action, p);
      if (r.stdout && SERIAL_OUTPUT_ACTIONS.has(action)) input.onEvent?.({ type: "serial_output", lines: String(r.stdout).split("\n").filter(Boolean) });
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
    // No lister wired = the workspace is unavailable. Faking ok:true with empty
    // entries told the model "the project is empty", which made generate wrongly bail
    // to analyze 鈥?so fail loud instead of fabricating an empty listing.
    if (typeof deps.listFiles !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.listFiles(path);
    return { ok: r.ok, op_id: p.op_id, success: r.ok, entries: r.entries ?? [], error: r.ok ? null : (r.error_kind ?? "list_failed") };
  }
  if (op === "mkdir") {
    if (typeof deps.makeDir !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.makeDir(path);
    return { ok: r.ok, op_id: p.op_id, success: r.ok, error: r.ok ? null : (r.error_kind ?? "mkdir_failed") };
  }
  if (op === "delete") {
    if (typeof deps.deletePath !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.deletePath(path);
    return { ok: r.ok, op_id: p.op_id, success: r.ok, error: r.ok ? null : (r.error_kind ?? "delete_failed") };
  }
  return { ok: false, op_id: p.op_id, error_kind: "unsupported_file_op", op };
}
