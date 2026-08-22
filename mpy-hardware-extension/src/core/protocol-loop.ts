// The plugin-interface client loop. The server (cloud) decides; this is the dumb
// executor: it sends start_phase, receives the 6 protocol tools over SSE, runs each
// on the user's machine, feeds results back, and auto-advances phases on
// phase_complete. Mirrors the proven backend e2e harness, in TypeScript.
import { PROTOCOL_TOOLS, PROTOCOL_TOOL_NAMES, routeForTool } from "./protocol-registry.ts";
import { normalizeObservation } from "./observations.ts";
import {
  boundHistory,
  digest,
  historyChars,
  TELEMETRY_BODY_FIELDS,
  TELEMETRY_INPUT_HEAD_CHARS,
  TELEMETRY_INPUT_STRING_BUDGET,
} from "./history-window.ts";

export const PHASE_ORDER = ["analyze", "select-hw", "upy-flash-mpy-firmware-plugin", "upy-scaffold-plugin", "upy-generate-plugin", "upy-deploy-plugin"] as const;

// V0 phases are script-heavy and the model emits ONE tool per turn, so a phase can
// legitimately take dozens of turns (select-hw ~40, generate ~49). The old cap of 10
// stalled every V0 phase. Callers (e.g. the e2e) override via input.maxTurnsPerPhase.
const MAX_TURNS_PER_PHASE = 60;
// Generate needs more, and this is measured rather than guessed. Its 60-turn budget goes mostly
// on the work itself: one archived stall spent 39 of 60 calls writing and reading the generated
// firmware, drivers, tests and plan, reached its second gate verdict holding 26 errors, and had
// nothing left to converge with. Every run that has ever COMPLETED generate ran with a larger
// budget and used 71 to 81 calls. So 60 is below what the phase costs, and no amount of gate
// clarity buys that back.
const MAX_TURNS_BY_PHASE: Record<string, number> = {
  // 80 -> 100. Measured across every archived generate: the phase converges but keeps running
  // out inside the closing payload ceremony rather than on the code. Four runs died within one
  // or two errors of a pass -- 2 left at the cap, 1 left, 1 left, and 2 left with the error set
  // still shrinking (17 -> 4 -> 3 -> 2) on the last of them. Successful cold runs historically
  // finished in 43 to 75, so this does not license a slower phase; it covers the tail where a
  // run has already done the work and needs a few more turns to record it.
  // Headroom, not a fix: the real cost is ~30 turns of ceremony after the code is green, and
  // that belongs to the payload contract, not to the budget.
  "upy-generate-plugin": 100,
  // Deploy, same story and the same evidence. Every deploy that COMPLETED used 39, 58, 70 or 80
  // calls; all three that stalled used exactly 60, which is the cap rather than a coincidence.
  // Headroom, not a cure: the runs that overran spent their extra calls recovering from a
  // misreported mkdir and from running the app entrypoint and waiting for a loop that never
  // ends. Both of those are fixed above this line, in the skills; this stops the phase dying
  // while we find the next one.
  "upy-deploy-plugin": 80,
};
// A turn with no tool call can't advance the protocol. Re-prompt the model to emit a
// tool rather than stalling the whole build on the first prose-only reply (which froze
// the UI on the current step); only give up after this many CONSECUTIVE prose turns.
const MAX_TOOLLESS_TURNS = 3;
// Consecutive turns a phase may lose to a stream that died before producing anything. Two,
// because the failure mode being covered is transient (a socket hang-up, an upstream that
// goes quiet past the idle budget) while a provider that is genuinely down would burn the
// whole turn budget retrying and hide the real reason behind a max_turns stall.
const MAX_STREAM_RETRIES = 2;
const MAX_PHASES = PHASE_ORDER.length;

// Phases the plugin contract hands off to when the BUILD IS DONE and we do not serve what
// comes next. `project-library-upload` is deploy's documented success next_phase (its sample
// payload and smoke test both pin it); `upy-simulate-plugin` is the simulate branch. The api
// harness has always treated both as terminal (mpyhw-api/scripts/e2e_protocol_v0.py), and the
// loop failing on them was the disagreement.
// upy-autofix-plugin belongs here for the same reason as the other two: the deploy and generate
// SKILLs both document it as where a failed deploy goes next, so a model naming it is following
// the contract, not inventing work. We do not serve it, which ends the build -- but a deploy that
// failed honestly and handed off correctly was being recorded as terminal:"failed" for the
// handoff rather than for the failure, which buries the real cause under a protocol error.
const TERMINAL_HANDOFF_PHASES = new Set(["project-library-upload", "upy-simulate-plugin", "upy-autofix-plugin"]);

// One spelling per handoff. The skills write these with hyphens (the deploy success sample and
// its smoke test both assert "project-library-upload"), but every FILENAME in the same contract
// uses underscores (phase_complete.upy_deploy_plugin.json), so a model emitting
// "project_library_upload" is generalising, not inventing. Measured: a run finished all six
// phases green with the board running the firmware and was recorded terminal:"failed" purely for
// that underscore. Matching on separator-insensitive form keeps the real rule -- an undocumented
// name is still an error -- without failing a build over punctuation.
function handoffKey(phase: string): string {
  return phase.trim().toLowerCase().replace(/_/g, "-");
}

// What a phase's own verdict makes of the BUILD. Only "failed" used to be special-cased, so a
// phase that gave up and said `partial` ended the build as "complete": one run's select-hw
// reported it could not resolve the board, set next_phase to null, and the summary called that a
// completed build. A phase that did not finish its work has not completed the build either.
function terminalForResult(result: unknown): string {
  if (result === "failed") return "failed";
  if (result === "success" || result === undefined || result === null) return "complete";
  return "partial";
}

const PHASE_COMPLETION_CHECK = "check_phase_complete_consistency.py";

// The script that decides a phase did its job. Consulted only to REFUSE a success the gate has
// already contradicted; a phase with no entry here is unaffected.
// Measured, all four on green-looking runs: select-hw's validator failed, the model hand-wrote
// the "validated" manifest it was supposed to emit, and the phase passed -- three runs in a row,
// the board never actually resolved. Generate ran its checker with `--help` after a red verdict
// and passed. The loop took every one of them, because nothing here ever asked how the gate
// went.
type PhaseGate = {
  script: string;
  // Only invocations carrying ALL of these argv flags update the verdict. select_hw_manifest.py
  // and init_manifest.py print {"status":"ok"} from their DRAFT modes too, and a draft pass must
  // not overwrite a failing --validate-phase-complete: one archived run re-ran the draft mode
  // right after five validate failures on its way to an honest pass, so a draft pass is a normal
  // step -- it just is not a phase verdict. Flags only, not values: the model still chooses what
  // --compare-manifest points at, and pinning values needs the loop to run the gate itself.
  requiredArgs?: string[];
  // When a run of this gate reads evidence the model wrote itself, discard that run's verdict
  // instead of only warning about it. Off by default and enabled per phase from replayed
  // evidence: turning it on everywhere would have refused an archived run that passed for real.
  taintedEvidenceBlocksVerdict?: boolean;
  // strict: a success with NO recognized verdict this phase is refused too, not only one the gate
  // contradicted. Verified against the archives: every full pass ran these three gates to a
  // recognized pass before phase_complete, while one resumed run emitted generate success having
  // run nothing but `git status`, with its state file still failing its last check.
  strict?: boolean;
};
const PHASE_GATES: Record<string, PhaseGate> = {
  "select-hw": {
    script: "select_hw_manifest.py",
    requiredArgs: ["--validate-phase-complete", "--compare-manifest", "--expected-artifact"],
    strict: true,
    // select_hw_validated.json is what board resolution produces, and --expected-artifact only
    // checks that the file exists. Hand-writing it skips the resolution the gate exists to prove,
    // and the file IS the verdict, so a warning alone changes nothing: three archived runs wrote
    // it themselves and select-hw passed every time. Replaying the archive against this rule
    // refuses exactly those runs and no run that passed honestly.
    taintedEvidenceBlocksVerdict: true,
  },
  "upy-generate-plugin": { script: PHASE_COMPLETION_CHECK, strict: true },
  "upy-deploy-plugin": { script: "deploy_result.py", strict: true },
  // Tracked but NOT strict: a red verdict still refuses a success, but a phase that never ran the
  // validator is left alone. Two archived full passes finished analyze in draft mode only, and NO
  // archived run has ever invoked flash's validator, so strict here would refuse honest runs --
  // the same blocks-the-honest-path mistake this guard has already made twice.
  "analyze": { script: "init_manifest.py", requiredArgs: ["--validate-phase-complete"] },
  "upy-flash-mpy-firmware-plugin": { script: "flash_mpy_firmware_manifest.py", requiredArgs: ["--validate-phase-complete"] },
};

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

// The only result tokens the phase_complete contract defines. Every gate script rejects any
// other value, but the gates run under the model's control -- so the loop must too, or a
// result:"ok" walks past the refusal guard, which compares against the literal "success".
const PHASE_RESULT_VALUES = new Set(["success", "partial", "failed"]);

type StreamEvent = { type: string; text?: string; id?: string; name?: string; input?: any; invalidInput?: string; message?: string; finishReason?: string };
type LlmClient = { streamMessages: (body: any, signal?: any) => Promise<AsyncIterable<StreamEvent>> | AsyncIterable<StreamEvent> };

export type ProtocolDeps = {
  llmClient: LlmClient;
  // Device I/O (mpremote). action -> result; the host wires this to the real shim.
  device?: (action: string, payload: any) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error_kind?: string }>;
  // Workspace file I/O (host enforces path containment).
  // `allowed` (present on a rejected path) describes what the workspace WILL accept. Forwarded
  // to the model so a wrong path is corrected next turn instead of guessed at repeatedly.
  writeFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; relative_path?: string; error_kind?: string; allowed?: string }>;
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
  runScript?: (interpreter: string, script: string, args: string[], extra?: { stdin_content?: string; stdin_json?: any; timeout_ms?: number; phase?: string }) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exit_code?: number; error_kind?: string; candidates?: string[]; structured_errors?: Array<{ code?: string; path?: string; message?: string }>; accepted_flags?: string[] }>;
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

// The string budgets, the body-field set and digest() now live in history-window.ts and are
// imported at the top of this file; only the array rule below is local to the compaction.
//
// An argv array is flags and paths, not a body, so it is recorded verbatim: "<16 items>" made
// "which arguments did the model actually pass" unanswerable, and that is the first question
// asked of any failing script_run. Each element still goes through the string rules, so a long
// element is clamped and a body-shaped one never rides in. The count is a hard cap on how much
// an array can contribute at all.
const TELEMETRY_ARRAY_ITEM_BUDGET = 40;

// Shrink a tool input down to the IDENTITY of the call (tool, path, script_id, flags)
// for telemetry. A file_operation write carries a whole generated file, and a phase can burn
// its full 60-turn budget rewriting the same files, so emitting inputs verbatim would
// bury every other event in the trace under file bodies. The size guard in telemetry.ts
// truncates such a field but does not shrink it, and the content is not what a stall
// triage reads: WHICH file was rewritten how many times is.
// ponytail: one level deep. A nested object is recorded as "<object>", not walked, so an
// input that hides its path inside a sub-object shows nothing useful -- walk it only if a
// real trace needs it.
// A body field is compacted at EVERY length, not only over the budget: a short conf.py is
// still a file body, and a credential in it would otherwise be recorded verbatim because it
// happened to be under 200 characters.
function compactTelemetryString(key: string, value: string): string {
  if (TELEMETRY_BODY_FIELDS.has(key)) return `<${value.length} chars ${digest(value)}>`;
  return value.length > TELEMETRY_INPUT_STRING_BUDGET
    ? `<${value.length} chars ${digest(value)}> ${value.slice(0, TELEMETRY_INPUT_HEAD_CHARS)}`
    : value;
}

// Elements go through the SAME rules as a top-level string under that key, so an args array
// stays readable while a body-shaped element is still clamped or digested.
function compactTelemetryArray(key: string, value: any[]): any[] {
  const kept = value.slice(0, TELEMETRY_ARRAY_ITEM_BUDGET).map((item) => {
    if (typeof item === "string") return compactTelemetryString(key, item);
    return item && typeof item === "object" ? "<object>" : item;
  });
  const dropped = value.length - kept.length;
  return dropped > 0 ? [...kept, `<${dropped} more items>`] : kept;
}

function compactToolInput(input: any): Record<string, any> {
  const compact: Record<string, any> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") {
      // A body field is compacted at EVERY length, not only over the budget: a short
      // conf.py is still a file body, and a credential in it would otherwise be recorded
      // verbatim because it happened to be under 200 characters.
      if (TELEMETRY_BODY_FIELDS.has(key)) {
        compact[key] = `<${value.length} chars ${digest(value)}>`;
        continue;
      }
      // The head is the BUDGET here, not history-window's 400. A 400-char head under a
      // 200-char budget records every string in (200, 422] IN FULL and 22 characters longer
      // than it went in -- the same arithmetic elide() already guards against, on the
      // telemetry side of it. And keep the substitution only while it actually shortens, so
      // no compaction can ever grow the payload it exists to bound.
      const compacted = `<${value.length} chars ${digest(value)}> ${value.slice(0, TELEMETRY_INPUT_STRING_BUDGET)}`;
      compact[key] = compacted.length < value.length ? compacted : value;
    }
    // An array is walked rather than replaced with "<N items>", so "which arguments did the
    // model actually pass" stays answerable from the trace. Elements go through the same
    // per-key rules. Kept deliberately separate from the string branch above: the shared
    // helper still slices to TELEMETRY_INPUT_HEAD_CHARS, which is the arithmetic that comment
    // warns about, so routing top-level strings through it would undo the guard.
    else if (Array.isArray(value)) compact[key] = compactTelemetryArray(key, value);
    else if (value && typeof value === "object") compact[key] = "<object>";
    else compact[key] = value;
  }
  return compact;
}

// The READ side of the rule compactToolInput enforces on writes. A file_operation read returns
// the file's content, and that result is recorded into session.jsonl and the consented cloud
// tool_dispatch payload. normalizeObservation redacts host paths and truncates at 1200 chars,
// but it cannot tell that a value is a file BODY -- so the head of firmware/conf.py, which is
// exactly where this product puts credentials, was recorded verbatim. Closing only the write
// side left the easier path open: the model reads a file back before it rewrites one.
// Replaces on a COPY -- the model still receives the real content in its tool result.
function compactResultBodies(result: any): any {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  let copy: any = null;
  for (const [key, value] of Object.entries(result)) {
    if (!TELEMETRY_BODY_FIELDS.has(key) || typeof value !== "string") continue;
    copy ??= { ...result };
    copy[key] = `<${value.length} chars ${digest(value)}>`;
  }
  return copy ?? result;
}

// How many recent tool failures a stalled phase reports as its detail.
const STALL_DETAIL_LIMIT = 3;
// Scripts and tools that reach the BOARD. Used to enforce that the final reset is the last
// thing a phase does to the device.
const DEVICE_TOUCHING_SCRIPTS = [
  "mpremote_runtime.py", "capture_repl.py", "run_device_tests.py", "clean_device_project.py",
  "install_mip_dependencies.py", "wait_for_device.py", "read_device_log.py", "flash_device.py",
];

function touchesDevice(tu: StreamEvent): boolean {
  if (tu.name === "device_command") return true;
  const script = String((tu.input as any)?.script ?? "");
  return tu.name === "script_run" && DEVICE_TOUCHING_SCRIPTS.some((s) => script.endsWith(s));
}

// The capture that proves the board is running the deployed app, and by contract the LAST device
// operation of the phase.
function isFinalResetCapture(tu: StreamEvent): boolean {
  const script = String((tu.input as any)?.script ?? "");
  if (!script.endsWith("capture_repl.py")) return false;
  const args = (Array.isArray((tu.input as any)?.args) ? (tu.input as any).args : []).map(String).join(" ");
  return args.includes("final_reset");
}

// An upload that writes no evidence file. deploy_result.py requires upload_summary.json, and the
// ONLY way to produce it is the upload itself, so an upload without the flag creates a debt that
// can only be paid by touching the device again. Measured: a run uploaded cleanly with no
// --output-json, ran its final reset (correctly, board booted and printed MPYHW_READY), then tried
// four times to re-run the same upload purely to emit the artifact. Every attempt was refused as a
// post-reset device call, so the model hand-wrote upload_summary.json instead and deploy_result.py
// graded the forgery PASS. Refusing HERE, while the call is still legal, is what stops that: the
// mistake and its correction are one turn apart, and no evidence debt survives the final reset.
function isUploadMissingEvidence(tu: StreamEvent): boolean {
  const script = String((tu.input as any)?.script ?? "");
  if (tu.name !== "script_run" || !script.endsWith("mpremote_runtime.py")) return false;
  const args = (Array.isArray((tu.input as any)?.args) ? (tu.input as any).args : []).map(String);
  const joined = args.join(" ");
  // Only the upload verb. mkdir/ls/rm probes write no summary and are not what deploy grades.
  if (!/\bfs\b.*\bcp\b/.test(joined)) return false;
  return !args.some((arg: string) => arg === "--output-json" || arg === "--out-json");
}

type PhaseFailure = { tool: string; error: string; path?: string; turn: number };

// --- Loop detection ---------------------------------------------------------
// A phase can burn its whole budget on calls that all SUCCEED and get nowhere. Measured:
// generate recorded project HEAD into project-manifest.json, amended the commit to include
// that manifest, read the new HEAD, recorded it, amended again -- ten times, every call
// returning ok, until max_turns. The turn cap is not a loop guard: it is the thing that
// finally stops a loop, an hour and a full model budget later.
//
// Longest cycle worth recognizing. The measured one has period 3 (write, commit, rev-parse).
const MAX_CYCLE_PERIOD = 4;
// Full repetitions before the cycle is called. Three, so a phase that legitimately runs the
// same gate twice around a fix is never touched.
const MAX_CYCLE_REPEATS = 3;
// A failing call is exempt from the cycle check because a failure names what to fix -- but only
// a failure that CHANGES is convergence. Mined from ten archived runs: no honest sequence ever
// received the byte-identical error (same call signature, same full structured_errors payload)
// more than twice in a row, while the one pathological phase received it ten times and died at
// the cap. Three is the first count no honest run reached: the 3rd identical failure draws a
// nudge, the 4th ends the phase. Identity is the whole error payload, never the code alone --
// PC_UNITTEST_FAILED repeats with different failing tests during honest convergence, and
// code-level identity would call that a stall.
const MAX_IDENTICAL_FAILURES = 3;

// The blind spot in the identity above, measured on a live run: the same gate reported
// MANIFEST_BEHAVIOR_SPEC_MISSING, unchanged, from five consecutive runs and drew no nudge,
// because no two of the five were identical BY THAT DEFINITION -- one added `--session-dir`
// (a different call signature), another collected one extra unrelated error (a different
// payload). What was actually stuck was one ENTRY inside a changing set.
// So a second, looser reading: how many consecutive failing results of the same script may
// carry the same entry before the model is told that entry is the thing it never touched.
// A NUDGE ONLY, never a stall, and that split is measured rather than cautious: replayed over
// 44 archived runs, an entry persisting 3+ times is common in runs that go on to PASS (one
// carried PERMISSIONS_MISSING nine times, another GIT_COMMIT_MISSING six). Ending a phase on
// this signal would refuse honest convergence; a message costs one turn.
const MAX_UNCHANGED_ENTRY_FAILURES = 3;

// What ONE turn may emit. The server defaults to 8192 and clamps a request at 32768
// (MPYHW_LLM_MAX_TOKENS / _CEILING); we never sent the field at all, so every turn took the
// default -- and generate's contract cannot be satisfied inside it.
//
// Measured on the run that found this: generate's phase_complete must embed each quality-gate
// result VERBATIM, and run_quality_gates.py emits 34,770 characters of them, roughly 8.7k
// tokens before the rest of the payload. So the required write was larger than the whole turn
// allowance. The model ran the producer ten times, hit exactly 8192 output tokens on three
// turns (cut off mid-write), and finally reported partial with 17 requests unspent. Its own
// stated reason names the missing gate objects, so it knew what to do and could not do it.
//
// Not the real fix -- a payload that must carry 35KB of copied JSON is the actual defect, and
// that is the plugin's contract to change (deploy already passes evidence by FILE PATH rather
// than by value). This removes our half: the ceiling we were leaving on the table.
// Overridable for exactly one question: whether the raise is what made the phase more
// expensive. Cold runs used to pass generate in 43-75 turns and now use 76-80, and a larger
// output allowance plausibly means larger rewrites to re-verify. The reference form removed the
// reason the raise existed (a 34,770-char verbatim copy), so 8192 may be sufficient again --
// but one archived PASS carried a 33,614-char payload, which 8192 cannot emit, so the default
// stays until a run says otherwise.
const MAX_OUTPUT_TOKENS = Number(process.env.MPYHW_MAX_OUTPUT_TOKENS) || 32_000;
// Enough of one reported problem to tell it from the next, short enough that a phase cannot
// accumulate megabytes of keys.
const ENTRY_IDENTITY_BUDGET = 300;
// Separates subject from entry in the key. NUL, because both halves are free text -- a subject
// carries a space ("script_run scripts/x.py") and an entry carries whatever the gate printed --
// so any printable separator could occur inside one half and split the key in the wrong place.
const ENTRY_KEY_SEPARATOR = "\u0000";

// Files a gate READS that the model is supposed to author. The phase_complete payload is the
// thing being validated rather than evidence a script should have produced; a *_draft.json is
// the input a validator normalizes (select_hw_manifest.py --input select_hw_draft.json); the
// phase logs and project-manifest.json are the model's own record. One run drew EIGHT evidence
// warnings for writing exactly the files select_hw_manifest.py and init_manifest.py exist to
// read, and a warning that punishes the correct action is worse than no warning.
// Flags whose NEXT argv entry is a path the script writes. Verified against the producers:
// capture_repl.py, mpremote_runtime.py, run_device_tests.py, clean_device_project.py and
// install_mip_dependencies.py all take --output-json; run_quality_gates.py also accepts
// --out-json; select_hw_manifest.py and init_manifest.py write their draft with --write-path.
const OUTPUT_PATH_FLAGS = new Set(["--output-json", "--out-json", "--write-path"]);

// One spelling for one file. The taint set is keyed on whatever string the write reported and
// compared against whatever string the gate was called with, so "./upload_summary.json" and
// "upload_summary.json" were two different files and the second silently cleared nothing. Case
// is folded on the platforms whose filesystems fold it, matching how paths are compared
// elsewhere in the extension; on Linux two names differing only in case really are two files.
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";
function evidenceKey(path: string): string {
  const normalized = String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  return CASE_INSENSITIVE_PATHS ? normalized.toLowerCase() : normalized;
}

const MODEL_AUTHORED_GATE_INPUT =
  /(^|[\\/])(phase_complete\.[^\\/]*\.json|[^\\/]*_draft\.json|[^\\/]*_log\.md|project-manifest\.json)$/;

// How far back a failure may have happened and still count as the reason this phase died.
// Without a bound, "the last 3 failures" meant the last 3 of the WHOLE phase: a lint error
// from turn 4 that the model fixed at turn 5 was still reported as the detail of a turn-60
// stall, and twice that sent triage after a cause resolved 50 turns earlier. The
// repeating-call stall is the sharp case -- it fires on calls that all SUCCEED, so its detail
// array can hold nothing BUT stale entries.
// Derived, not picked: a cycle takes MAX_CYCLE_PERIOD * MAX_CYCLE_REPEATS turns to detect, so
// a shorter window would drop the failures that fed the very cycle being reported.
const STALL_DETAIL_RECENT_TURNS = MAX_CYCLE_PERIOD * MAX_CYCLE_REPEATS;

// The failures worth naming when a phase gives up: recent ones only, oldest first. Returning
// [] is a real answer -- "nothing failed near the end" is what a phase that died looping on
// successful calls should say, and it points triage at the cycle instead of at old news.
function stallDetail(failures: PhaseFailure[], turn: number): PhaseFailure[] {
  return failures.filter((f) => turn - f.turn <= STALL_DETAIL_RECENT_TURNS);
}
// Failures that repeating cannot fix: the call is refused or impossible, not rejected on its
// content. A cycle containing one of these is still a cycle, because the model learns nothing
// new by running it again -- which matters directly here, since refusing `git commit --amend`
// turns the measured loop's middle step into a failure and would otherwise hide the whole
// cycle from this check. A gate failure is the opposite: it says WHAT to fix, and the phase
// re-running it after an edit is convergence, so those keep the exemption.
const UNRETRYABLE_ERROR_KINDS = new Set([
  "shell_command_not_allowed",
  "script_not_found",
  "ambiguous_script_name",
  "host_runner_absent",
  "workspace_unavailable",
  "device_unavailable",
  "path_outside_workspace",
  "invalid_generated_path",
]);

// How much of a call's identity is kept. Long enough for the file being uploaded and the
// flags around it, short enough that one signature cannot dominate memory.
const SIGNATURE_IDENTITY_BUDGET = 400;

// The IDENTITY of a call: which tool, on what. Every scalar input EXCEPT the bodies, which
// are the fields the telemetry compaction already knows to digest rather than record.
//
// This started as a list of identity fields and that list was wrong three times in
// production, each time collapsing distinct work into one signature and stalling a phase
// that was making progress: `script_run` without `args` (four uploads, one signature),
// `status_update` with nothing but a message (a driver search's progress lines), and
// `device_command` with `src`/`dst` (four files copied to the board). Enumerating what
// counts as identity means discovering the next tool's fields the expensive way. The bodies
// are the closed set -- a file's content, a program's code -- so everything else is identity
// by default, and a tool added later is handled without another production lesson.
function callSignature(tu: StreamEvent): string {
  const input: any = tu.input ?? {};
  const parts: string[] = [];
  // Sorted for determinism: the model may emit the same call with keys in either order.
  for (const key of Object.keys(input).sort()) {
    if (TELEMETRY_BODY_FIELDS.has(key)) continue;
    const value = input[key];
    if (Array.isArray(value)) parts.push(`${key}=${value.map(String).join(" ")}`);
    else if (value !== null && typeof value === "object") continue;
    else if (value !== undefined) parts.push(`${key}=${String(value)}`);
  }
  const identity = parts.join(" ").slice(0, SIGNATURE_IDENTITY_BUDGET);
  return identity ? `${tu.name}:${identity}` : String(tu.name);
}

// WHAT a failing call ran or touched, deliberately without its flags. The unchanged-entry
// nudge needs this looser identity precisely because the flags are what the model varies while
// the problem stays put: the same checker run with and without `--session-dir` is one subject
// here and two signatures above. Never used to end a phase -- keying a stall this loosely would
// have stalled two archived runs that went on to pass their phase.
function failureSubject(tu: StreamEvent): string {
  const input: any = tu.input ?? {};
  const target = String(input.script ?? input.path ?? "");
  return target ? `${tu.name} ${target}` : String(tu.name);
}

// The identity of ONE reported problem. Code alone is not enough -- PC_UNITTEST_FAILED repeats
// with different failing tests during honest convergence -- and neither is the message alone,
// since DOC_EVIDENCE_MISSING repeats with the same sentence for seven different paths.
function failureEntryIdentity(entry: any): string {
  if (typeof entry === "string") return entry.trim().slice(0, ENTRY_IDENTITY_BUDGET);
  const parts = [entry?.code, entry?.path, entry?.field, entry?.message]
    .filter((p) => p !== undefined && p !== null && String(p) !== "")
    .map(String);
  return parts.join(" ").slice(0, ENTRY_IDENTITY_BUDGET);
}

// Fold this result into the per-subject entry streaks. A subject that SUCCEEDS, or that fails
// without naming this entry again, forgets it: the count has to mean "consecutive", or a
// problem fixed at turn 5 would still be nudged about at turn 40.
function trackUnchangedEntries(streaks: Map<string, number>, subject: string, entries: string[]): void {
  const seen = new Set(entries.map((e) => `${subject}${ENTRY_KEY_SEPARATOR}${e}`));
  for (const key of [...streaks.keys()]) {
    if (key.startsWith(`${subject}${ENTRY_KEY_SEPARATOR}`) && !seen.has(key)) streaks.delete(key);
  }
  for (const key of seen) streaks.set(key, (streaks.get(key) ?? 0) + 1);
}

// The repeating block, or null. Checked longest-period-first so a period-3 cycle is reported
// as its real shape rather than as whichever shorter slice happens to also repeat.
//
// Only cycles in which every call SUCCEEDED count. A phase repeating a FAILING call is being
// told what is wrong and is trying to fix it -- writing the same file and re-running the same
// gate three times is ordinary convergence, and cutting that off would break the phases this
// is meant to protect. A cycle of successes is the pathological one: nothing is asking the
// model to repeat, so it will repeat until the budget is gone.
function repeatingCycle(signatures: string[], failed: boolean[]): string[] | null {
  for (let period = MAX_CYCLE_PERIOD; period >= 1; period--) {
    const window = period * MAX_CYCLE_REPEATS;
    if (signatures.length < window) continue;
    if (failed.slice(-window).some(Boolean)) continue;
    const tail = signatures.slice(-window);
    if (tail.every((signature, i) => signature === tail[i % period])) return tail.slice(0, period);
  }
  return null;
}

// Proof that apply_scaffold actually rendered. A marker has to be something the SCRIPT
// produces and the model has no reason to write by hand: .flake8 was the first choice and it
// failed, because a run that skipped apply_scaffold hand-wrote its own .flake8 (along with a
// fake lib/ and a 119-line imitation of the 466-line flash_device.py) and sailed through.
//
// scaffold_file_manifest.json is the scaffold's own record of what it wrote
// (apply_scaffold.py), but it lands in --session-dir, which is the project root only when the
// caller passes no session dir, and it is skipped entirely without --write-phase-complete.
// So it CANNOT be the only marker. The .upy schema is copied unconditionally by
// add_upy_resources (init_scaffold.py) as a required resource, at a fixed path.
//
// Absence must be unanimous: a project missing BOTH did not run the scaffold.
const SCAFFOLD_APPLIED_MARKERS = ["scaffold_file_manifest.json", ".upy/schemas/project-manifest.schema.json"];
// The "it is not there" answers the wired readers produce: both panel.ts and the e2e harness
// return file_not_found; not_found is the older spelling still used by the harness's LIST op,
// kept so a reader that answers either way is read as absence. Anything else (read_failed,
// path_outside_workspace) is an ERROR, and reading an error as absence would reject a
// scaffold that did run.
const MISSING_FILE_KINDS = new Set(["file_not_found", "not_found"]);

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
  const maxTurns = input.maxTurnsPerPhase ?? MAX_TURNS_BY_PHASE[phase] ?? MAX_TURNS_PER_PHASE;
  const context = buildContext(input, absorbedSupplements);
  let toollessTurns = 0;
  // Consecutive turns lost to a stream that died before producing anything. Reset on any turn
  // that yields a tool call, so this bounds a run of bad luck, not the phase's whole lifetime.
  let streamRetries = 0;
  // Rolling window of the most recent failing tool calls, reported if the phase gives up.
  // Each carries the turn it happened on, so a stall reports what failed NEAR ITS END rather
  // than the last three failures of the whole phase.
  const recentFailures: PhaseFailure[] = [];
  // Call identities in order, and whether each one failed, for the cycle check. Bounded by
  // the turn budget.
  const callSignatures: string[] = [];
  const callFailures: boolean[] = [];
  // The nudge is spent once: a model that keeps cycling after being told is not going to
  // stop, and 40 more turns of it is what this exists to prevent.
  let cycleNudged = false;
  // Consecutive IDENTICAL outcomes per call signature, for the identical-failure guard. Reset on
  // success, or when the same call starts failing DIFFERENTLY -- that is convergence, not a loop.
  const identicalFailures = new Map<string, { err: string; count: number }>();
  let identicalFailureNudged = false;
  // Consecutive failing results per (subject, error entry), for the looser unchanged-entry nudge.
  // SPENT ONCE PER PHASE, not once per entry. Measured on the run that first fired it: three
  // nudges landed in three consecutive turns (two entries plus the strict guard), and the model
  // took the exit three requests later with 17 of 80 unspent. A barrage that says "you are
  // stuck" three times running is itself pressure to stop, so this says it once.
  const unchangedEntries = new Map<string, number>();
  let unchangedEntryNudged = false;
  // This phase's gate and its latest verdict, so a success it contradicts can be refused.
  // Set once the phase runs its final reset capture. After that the board is running the
  // deployed app, and anything that opens the REPL stops it again with nothing left to restart
  // it -- which is how a deploy reports success over a dark board.
  let finalResetDone = false;
  const gate = PHASE_GATES[phase];
  let gateState: "pass" | "fail" | null = null;
  // Paths the MODEL wrote with file_operation this phase. A gate whose evidence args name one is
  // grading the model's own testimony rather than the board's. WARN ONLY, deliberately: two
  // archived PASSING deploys hand-wrote evidence the gate then consumed, so blocking here would
  // have refused runs that were genuinely fine. The event makes the pattern visible first.
  const modelWrittenPaths = new Set<string>();
  for (let turn = 0; turn < maxTurns; turn++) {
    if (input.signal?.aborted) return { done: false, cancelled: true };
    // Before the request, not after the push: the cap has to apply to what actually goes out,
    // including the turn that would otherwise be the one to cross the model's limit.
    // Say so when it could NOT get under the cap. The request still goes out -- refusing to
    // send is a worse outcome than a request that may be rejected -- but a silent return
    // would make the next triage of that non-retryable 400 start from "the cap was in place,
    // so size cannot be the problem", which is exactly the wrong place to start.
    if (!boundHistory(messages)) {
      input.onEvent?.({ type: "history_over_cap", phase, chars: historyChars(messages), turn });
    }
    const body = { phase, manifest, messages, tools: PROTOCOL_TOOLS, trace_id: input.traceId, max_tokens: MAX_OUTPUT_TOKENS, ...(context ? { context } : {}) };
    const source = await deps.llmClient.streamMessages(body, input.signal);
    const it = asyncEvents(source as AsyncIterable<StreamEvent>);

    let text = "", thinking = "";
    const toolUses: StreamEvent[] = [];
    let streamError: string | null = null;
    while (true) {
      let next: IteratorResult<StreamEvent>;
      try { next = await it.next(); }
      catch (err: any) {
        // Keep WHY the stream died. Breaking silently left a phase that ended with no tool
        // call and no reason, and the build then reported "stalled" with nothing to read.
        streamError = String(err?.message ?? err ?? "stream_read_failed");
        try { await it.return?.(undefined); } catch { /* ignore */ }
        break;
      }
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
    if (streamError) {
      // Every other stall path emits phase_stalled with a detail array; this one returned an
      // `error` field nobody reads, so a mid-stream failure was invisible in the panel, in the
      // session log and in the DB alike. Observed: 56 clean turns, then a silent "stalled".
      recentFailures.push({ tool: "llm_stream", error: streamError, turn });
      if (recentFailures.length > STALL_DETAIL_LIMIT) recentFailures.shift();
      // Only give up when the turn produced NOTHING to act on. `tool_use_complete` means the
      // call arrived whole, so a stream that dies after it still advanced the protocol -- and
      // nothing retries mid-stream (withConnectRetries wraps only the awaited streamMessages
      // call, never a throw out of it.next()), so ending the phase here throws away that call
      // and all 50 turns before it over one transient socket hang-up. The failure stays in
      // recentFailures either way, so a phase that goes on to stall still names it.
      if (toolUses.length === 0) {
        // Nothing arrived, so nothing was lost by asking again: no assistant message is
        // appended here, so the retry re-issues the SAME turn against unchanged history.
        // Measured: a real generate turn went silent for the full idle budget and the phase
        // gave up with four phases of work behind it. Bounded, and reset by any turn that
        // produces a tool call, so a genuinely dead upstream still stalls after
        // MAX_STREAM_RETRIES rather than burning the whole turn budget on retries.
        if (streamRetries < MAX_STREAM_RETRIES) {
          streamRetries += 1;
          input.onEvent?.({ type: "stream_retry", phase, attempt: streamRetries, of: MAX_STREAM_RETRIES, error: streamError });
          continue;
        }
        input.onEvent?.({ type: "phase_stalled", phase, reason: "stream_error", detail: stallDetail(recentFailures, turn) });
        return { done: false, stalled: true, error: streamError };
      }
    }

    const blocks: any[] = [];
    if (thinking) blocks.push({ type: "thinking", thinking });
    if (text) blocks.push({ type: "text", text });
    for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    // A turn where the model returned NOTHING (no text, no thinking, no tool call) is not
    // recorded. An empty assistant message carries no information, and it is not harmless:
    // the api translates it to {"role":"assistant","content":""} with no tool_calls, which
    // at least one upstream rejects outright ("the message at position N with role
    // 'assistant' must not be empty"). Because history is replayed on EVERY later request,
    // one such turn poisons the rest of the phase rather than costing a single turn, and the
    // nudge loop below would append one per empty turn. Skipping it changes nothing for an
    // upstream that tolerates the empty message: there was nothing in it to lose.
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });

    if (toolUses.length === 0) {
      // A prose-only turn can't advance the protocol. Stalling on the FIRST chatty reply
      // froze the UI on the current step ("姝ｅ湪鎼滅储椹卞姩") with no error 鈥?so nudge the
      // model to emit a tool, bounded, and only give up after MAX_TOOLLESS_TURNS in a row.
      if (++toollessTurns >= MAX_TOOLLESS_TURNS) {
        input.onEvent?.({ type: "phase_stalled", phase, reason: "no_tool_call", detail: stallDetail(recentFailures, turn) });
        return { done: false, stalled: true };
      }
      messages.push({ role: "user", content: [{ type: "text", text: "You must call exactly one protocol tool to proceed. Respond with a tool call, not prose." }] });
      continue;
    }
    toollessTurns = 0;
    // A turn that produced a tool call clears the stream-retry budget: the two are meant to
    // absorb a burst of bad luck, not to accumulate across a long healthy phase.
    streamRetries = 0;
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
      // Three rounds of SKILL wording did not stop this, so the loop enforces it. Measured
      // twice: the final reset matched its marker (board demonstrably running), then the model
      // issued `device_command ls` to double-check the upload -- five times in one run -- and
      // every one of those opened the raw REPL and stopped main.py. The phase then reported
      // success over an idle board. The check it wants is a file read, not a device call.
      // Refused BEFORE the final reset, while re-running the upload is still legal, so the
      // evidence debt can never outlive the reset. See isUploadMissingEvidence.
      if (!finalResetDone && isUploadMissingEvidence(tu)) {
        input.onEvent?.({ type: "upload_without_evidence", phase, tool: tu.name, turn });
        const refusal = {
          ok: false,
          error_kind: "upload_without_evidence",
          detail:
            "REFUSED: this upload writes no evidence file, and it is the only step that can produce one. " +
            "Re-issue the SAME command with --output-json upload_summary.json added. deploy_result.py " +
            "--upload-json requires that file, and after the final reset runs no device call is permitted, " +
            "so an upload without it leaves the phase owing evidence it can no longer legally obtain.",
        };
        input.onEvent?.({ type: "tool_result", name: tu.name, observation: refusal });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(refusal) });
        continue;
      }
      if (finalResetDone && touchesDevice(tu)) {
        input.onEvent?.({ type: "device_after_final_reset", phase, tool: tu.name, turn });
        const refusal = {
          ok: false,
          error_kind: "device_after_final_reset",
          detail:
            "REFUSED: the final reset has already run, and it is the last device operation of this phase. " +
            "Opening the REPL again stops the app that reset just started, and nothing restarts it, so the " +
            "board would end the phase idle with deploy reporting success. To confirm what was uploaded, read " +
            "upload_summary.json; for what the board printed, read the capture artifacts. Both are files, " +
            "and reading a file does not touch the device. If an evidence file is genuinely MISSING and only " +
            "a device call could produce it, that evidence is unobtainable in this phase: report " +
            "result=partial with a structured error naming the missing artifact. Do NOT write it yourself. " +
            "A hand-written evidence file is graded as if a script produced it, so fabricating one turns a " +
            "recoverable partial into a false success.",
        };
        input.onEvent?.({ type: "tool_result", name: tu.name, observation: refusal });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(refusal) });
        continue;
      }
      const { result, phaseControl } = await executeProtocolTool(tu, input, deps, {
        phase, turn, wasModelWritten: (path: string) => modelWrittenPaths.has(evidenceKey(path)),
      });
      if (isFinalResetCapture(tu) && result?.ok === true) finalResetDone = true;

      // Normalized, NOT raw. This event is recorded into session.jsonl, which the stall
      // copy tells the user to export to support -- and a raw result carries absolute host
      // paths (a Python traceback's C:\Users\<name>\...), raw mpremote commands, and up to
      // the full 80,000-char cap per call. normalizeObservation is the redactor the
      // agent-loop path already runs for exactly this reason; the asymmetry with tool_use
      // (compacted just below) was the bug, not a deliberate difference.
      input.onEvent?.({ type: "tool_result", name: tu.name, observation: normalizeObservation(tu.name ?? "", compactResultBodies(result)) });
      const failure = toolFailure(tu, result);
      callSignatures.push(callSignature(tu));
      // Only a failure the model can act on exempts the window from the cycle check.
      callFailures.push(Boolean(failure) && !UNRETRYABLE_ERROR_KINDS.has(failure!.error));
      // Track whether this exact call keeps failing the exact same way. Unretryable kinds are
      // deliberately NOT exempt here, unlike the cycle check: an identical script_not_found three
      // times deserves the nudge more, not less.
      const signatureNow = callSignatures[callSignatures.length - 1];
      if (failure) {
        const errIdentity = digest(JSON.stringify(result?.structured_errors ?? failure.error));
        const previous = identicalFailures.get(signatureNow);
        identicalFailures.set(
          signatureNow,
          previous?.err === errIdentity ? { err: errIdentity, count: previous.count + 1 } : { err: errIdentity, count: 1 },
        );
      } else {
        identicalFailures.delete(signatureNow);
      }
      // The same failure read one level down: which PROBLEMS this subject keeps reporting,
      // independent of the flags it was called with and of what else came back alongside them.
      trackUnchangedEntries(
        unchangedEntries,
        failureSubject(tu),
        failure ? (Array.isArray(result?.structured_errors) ? result.structured_errors : []).map(failureEntryIdentity).filter(Boolean) : [],
      );
      if (failure) {
        recentFailures.push({ ...failure, turn });
        if (recentFailures.length > STALL_DETAIL_LIMIT) recentFailures.shift();
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      if (tu.name === "file_operation" && ["write", "append"].includes(String((tu.input as any)?.op)) && result?.ok === true) {
        modelWrittenPaths.add(evidenceKey(String(result?.path ?? (tu.input as any)?.path ?? "")));
      }
      // A successful run of any NON-gate script naming the path re-establishes it as script-made:
      // producers take their output path as an argument, so `capture_repl.py --output-json x.json`
      // after a hand-write means the file on disk is the script's again. Without this, one
      // overwrite would keep the path flagged for the rest of the phase.
      if (tu.name === "script_run" && result?.ok === true && result?.success === true) {
        const args = (Array.isArray((tu.input as any)?.args) ? (tu.input as any).args : []).map(String);
        // Only a path the script was told to WRITE is re-established, never every path it
        // happened to mention. The old rule cleared any argv entry of any successful non-gate
        // script, so a read-only script naming the file laundered it -- and a model that wanted
        // the flag gone only had to pass the path to something harmless.
        if (!(gate && String((tu.input as any)?.script ?? "").endsWith(gate.script))) {
          for (let i = 0; i < args.length - 1; i++) {
            if (OUTPUT_PATH_FLAGS.has(args[i])) modelWrittenPaths.delete(evidenceKey(args[i + 1]));
          }
        }
        // The path an output flag NAMES is script-made afterwards, even when the producer is the
        // gate script itself. Without this the one file select-hw grades could never be cleaned:
        // select_hw_validated.json is written by select_hw_manifest.py --write-path, which the
        // clause above skips because it is the gate -- so a model that hand-wrote it once could
        // never make it honest again, and a guard with no way out is what drove the fabrication
        // in the first place.
        for (let i = 0; i < args.length - 1; i++) {
          if (OUTPUT_PATH_FLAGS.has(args[i])) modelWrittenPaths.delete(evidenceKey(args[i + 1]));
        }
      }
      // Remember how this phase's gate went. Only its LATEST verdict counts: a phase that fails
      // a gate, fixes the cause and passes it is exactly the loop working.
      const gateArgs = (Array.isArray((tu.input as any)?.args) ? (tu.input as any).args : []).map(String);
      const isGateRun = Boolean(gate) && tu.name === "script_run"
        && String((tu.input as any)?.script ?? "").endsWith(gate!.script);
      // The file a gate is HANDED to validate is the model's by definition, whatever it is
      // called. The name-pattern exemption covers the conventional spellings, but one run named
      // its analyze draft manifest_input.json and was flagged for doing exactly the right thing,
      // so the argv position is the more reliable signal: whatever follows --input is the
      // subject, not the evidence.
      const gateSubjects = new Set(
        gateArgs.flatMap((a: string, i: number) => (a === "--input" && i + 1 < gateArgs.length ? [evidenceKey(gateArgs[i + 1])] : [])),
      );
      const taintedEvidence = isGateRun
        ? gateArgs.filter((a: string) => modelWrittenPaths.has(evidenceKey(a))
            && !MODEL_AUTHORED_GATE_INPUT.test(a) && !gateSubjects.has(evidenceKey(a)))
        : [];
      // Whether a tainted run is merely reported or actually costs the verdict. Enabled per
      // phase, from replayed evidence rather than by principle: across the archived runs, the
      // only phase where a hand-written evidence file was BOTH still flagged by today's
      // exemptions AND the whole basis of the verdict is select-hw, where select_hw_validated.json
      // is what board resolution produces. Deploy is deliberately NOT enabled yet: one archived
      // run hand-wrote upload_summary.json and still passed for real -- its final reset showed
      // the soft reboot and MPYHW_READY, so the verdict was true and corroborated -- and blocking
      // there would have refused a genuinely good run.
      const blocksVerdict = isGateRun && taintedEvidence.length > 0 && gate?.taintedEvidenceBlocksVerdict === true;
      if (taintedEvidence.length > 0) {
        input.onEvent?.({ type: "gate_evidence_model_written", phase, gate: gate!.script, files: taintedEvidence, turn, blocking: blocksVerdict });
        correctiveMessages.push({
          role: "user",
          content: [{
            type: "text",
            text:
              `Evidence warning: ${gate!.script} read ${taintedEvidence.join(", ")}, which you wrote with file_operation ` +
              "instead of producing with the script that owns it (capture_repl.py, run_device_tests.py, " +
              "install_mip_dependencies.py, clean_device_project.py, ...). A hand-written evidence file is " +
              "fabrication even when the verdict computed from it says PASS. Re-run the producing script so " +
              `the file on disk is script-made, then re-run ${gate!.script}.` +
              (blocksVerdict
                ? ` This run of ${gate!.script} does NOT count: its verdict is discarded because the evidence` +
                  " was yours, so reporting success now will be refused. Produce the file with the script that" +
                  " owns it and run the gate again. If it genuinely cannot be produced, report result=partial" +
                  " naming what is missing rather than writing the file yourself."
                : ""),
          }],
        });
      }
      if (isGateRun && !blocksVerdict
          && (gate!.requiredArgs ?? []).every((flag) => gateArgs.includes(flag))) {
        // The gate's OWN verdict, same reader the completion corrective uses. Keying on the exit
        // code would have left this guard with the hole it was written to close: a run reached
        // for `--help` on this very script, which exits 0 and prints usage, and that would have
        // marked the gate green.
        // Keep the LAST RECOGNIZED verdict. Writing `passed ? "pass" : "fail"` here threw away
        // the whole point of the null case: every unrecognized shape became "fail", so a deploy
        // graded PASS_WITH_WARNINGS -- how a real deploy normally ends -- would have been refused.
        const verdict = gateVerdict(result?.stdout);
        if (verdict) gateState = verdict;
      }
      if (tu.name === "phase_complete" && phaseControl) {
        // A success the gate has already contradicted is not a success. Refusing it here is what
        // stops the model from writing the gate's own output file by hand and calling the phase
        // done -- which three runs did, passing select-hw with a board that never resolved.
        // A STRICT gate also refuses a success it never confirmed: one resumed run emitted
        // generate success having run nothing but `git status`, while the state file it inherited
        // was still failing its last check. The corrective names the command, so an honest
        // resume pays exactly one gate run for this.
        // Strictness needs a host that can actually run the gate. Without runScript no gate can
        // ever report, so refusing an unconfirmed success would spin the phase to its cap with no
        // move that could satisfy it -- a deadlock, not a guard. Production always supplies one
        // (the loop returns host_runner_absent otherwise), so this only relaxes contexts where
        // the gate was never reachable. A gate that RAN and failed is still refused either way.
        const canRunGate = typeof deps.runScript === "function";
        const unverified = gateState === null && gate?.strict === true && canRunGate;
        // Gate results may be REFERENCED by path instead of embedded, and the reference travels
        // inside the payload rather than on the gate's argv -- so the evidence check above cannot
        // see it, and a hand-written all-green results file validates completely. This is the one
        // forgery surface that grew this week: the contract now steers models toward the
        // referenced form, so the safer the payload gets, the more this matters.
        const referencedEvidence = ["lint", "tests", "checks"]
          .map((section) => (tu.input as any)?.[section])
          .filter((v: any) => v && typeof v === "object" && typeof v.results_path === "string")
          .map((v: any) => String(v.results_path));
        const taintedReference = [...new Set(referencedEvidence.filter((p: string) => modelWrittenPaths.has(evidenceKey(p))))];
        if (taintedReference.length > 0 && (phaseControl.result ?? "success") === "success") {
          input.onEvent?.({ type: "phase_complete_refused", phase, gate: gate?.script, turn, reason: "referenced_evidence_model_written", files: taintedReference });
          correctiveMessages.push({
            role: "user",
            content: [{
              type: "text",
              text:
                `This success references ${taintedReference.join(", ")} for its gate results, and you wrote that ` +
                "file with file_operation rather than producing it. A referenced results file is graded exactly " +
                "like an embedded one, so hand-writing it fabricates every gate inside it. Re-run " +
                "scripts/run_quality_gates.py --project-dir <project_root> --session-dir <session_root> " +
                `--output-json ${taintedReference[0]} so the file is script-made, then re-emit phase_complete. ` +
                "Do not switch to embedding the gate objects instead: a per-gate results_path is refused as " +
                "GATE_SOURCE_MISPLACED, and mixing the forms is refused as GATE_SOURCE_SPLIT.",
            }],
          });
          continue;
        }
        // Safe to compare the literal token: executeProtocolTool rejects any result outside
        // success/partial/failed before a phaseControl is ever produced, so `result: "ok"` can no
        // longer arrive here and slip past by not matching "success".
        if ((gateState === "fail" || unverified) && (phaseControl.result ?? "success") === "success") {
          input.onEvent?.({ type: "phase_complete_refused", phase, gate: gate!.script, turn, reason: unverified ? "gate_never_ran" : "gate_failed" });
          const claim = unverified
            ? `${gate!.script} has not reported a verdict this phase, so this success is unverified. ` +
              `Run ${gate!.script}${gate!.requiredArgs ? " " + gate!.requiredArgs.join(" ") : ""} against your phase_complete payload and its evidence, ` +
              "and make it pass, then re-emit phase_complete. "
            : `${gate!.script} last reported failure, so this phase is not done. ` +
              "Fix what it reported and run it again until it passes, then emit phase_complete. ";
          correctiveMessages.push({
            role: "user",
            content: [{
              type: "text",
              text:
                "phase_complete(success) was REFUSED: " + claim +
                "Do not write its output file yourself: an artifact you author is not a verdict, and the phase " +
                "cannot pass on one. If you cannot make it pass, emit phase_complete with result=partial and " +
                "say what blocked it.",
            }],
          });
        } else {
          // A failed/partial verdict is never refused -- a phase must always be able to give up
          // honestly. But when the gate never ran, that verdict is the model's prose and nothing
          // else: one deploy reported failed claiming the board was stuck in the bootloader, and
          // deploy_result.py had not run, so there was no artifact and no script verdict behind
          // it. The board turned out to be fine. Recorded, not blocked, so triage can tell a
          // measured failure from an asserted one.
          if (gate?.strict === true && gateState === null && canRunGate && (phaseControl.result ?? "success") !== "success") {
            input.onEvent?.({ type: "phase_complete_without_gate", phase, gate: gate.script, result: phaseControl.result, turn });
          }
          // Announced HERE, once the claim has survived the gate: this is the only point at
          // which a phase_complete is a fact rather than an assertion.
          input.onEvent?.({ type: "phase_complete", payload: phaseControl.payload });
          if (phaseControl.manifest) input.onEvent?.({ type: "manifest_updated", manifest: phaseControl.manifest });
          control = phaseControl;
        }
      }
      // A host script result carrying structured gate errors gets a deterministic
      // corrective message enumerating them -- don't rely on the model parsing the raw
      // JSON tool_result to find its own mistakes. Measured: naming the plan gate's
      // entries is what ended a loop that had run nine identical failures deep. Lint and
      // test failures carry the same shape (run_quality_gates.py emits FLAKE8_FAILED /
      // PC_UNITTEST_FAILED with the tool output as the message) and used to be filtered
      // out here, so one phase spent all 60 turns on an unused variable and an unused
      // import without ever being told which line either was on.
      // Read BOTH real entry shapes, the same way gateEntryReason does for the stall detail.
      // Requiring `.code` filtered out every STRING entry, and the string shape is what the
      // select-hw and analyze validators emit (update_manifest.py / init_manifest.py append
      // plain sentences to `errors`) -- so the phases that fail on a malformed manifest, the
      // ones a corrective message helps most, were the ones that got none.
      const gateErrors = (result?.structured_errors ?? []).filter((e: any) => gateEntryReason(e).trim() !== "");
      if (gateErrors.length > 0) {
        correctiveMessages.push({
          role: "user",
          content: [{
            type: "text",
            text: correctiveText(gateErrors),
          }],
        });
      } else if (isPhaseCompletionCheck(tu) && result?.ok === true && result?.success === true && phaseCheckVerdictPassed(result?.stdout)) {
        // The other half of the corrective, and the one that was missing. A gate that FAILS
        // is told what to fix; a gate that PASSES said nothing at all, and the model does not
        // stop on its own. Measured on three runs of one phase: the consistency checker
        // passed, the model committed again, that moved HEAD, the hash it had recorded went
        // stale, and the checker failed on the next attempt. One run died at the turn cap
        // holding a verdict it had already earned; another spent 19 of its 65 turns -- 29% of
        // the phase -- circling after the pass. The phase's own work was done in both.
        correctiveMessages.push({
          role: "user",
          content: [{
            type: "text",
            text:
              "The consistency check PASSED. Emit phase_complete now with what you have. Do " +
              "not run git again, and do not rewrite the manifest, session state or the " +
              "phase_complete file: any of those invalidates the commit hash you just " +
              "recorded and the check will start failing again.",
          }],
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
    for (const m of correctiveMessages) messages.push(m);
    if (control) return { done: true, control };
    // Checked AFTER phase_complete, so a phase that just finished is never called a loop.
    const cycle = repeatingCycle(callSignatures, callFailures);
    // Breaking out spends the nudge back. Without this, one nudge early in a long phase
    // means a later, unrelated repetition stalls it with no warning at all.
    if (!cycle) cycleNudged = false;
    if (cycle) {
      if (cycleNudged) {
        input.onEvent?.({ type: "phase_stalled", phase, reason: "repeating_calls", detail: stallDetail(recentFailures, turn), cycle });
        return { done: false, stalled: true, error: `repeated ${cycle.join(" -> ")} with no progress` };
      }
      cycleNudged = true;
      input.onEvent?.({ type: "repeating_calls", phase, cycle, turn });
      messages.push({
        role: "user",
        content: [{
          type: "text",
          // Name the cycle: a model that cannot see its own history repeating needs to be
          // told WHAT it is repeating, not just that it is stuck.
          text:
            `You have repeated this sequence ${MAX_CYCLE_REPEATS} times with no progress: ${cycle.join(" -> ")}. ` +
            "Repeating it again will not change the result. If a value you recorded is invalidated by " +
            "the very step that records it, stop recording it and move on. Take a DIFFERENT action now, " +
            "or emit phase_complete with what you already have.",
        }],
      });
    }
    // The failing twin of the cycle guard. That one exempts failing calls because a failure
    // names what to fix; this one fires when what it names has stopped changing. One phase ran
    // the same validator 10 times for the byte-identical error and died at the cap; no honest
    // run in ten archives ever repeated an identical error more than twice.
    const repeatedFailure = [...identicalFailures.entries()].find(([, v]) => v.count >= MAX_IDENTICAL_FAILURES);
    let nudgedThisTurn = false;
    if (!repeatedFailure) identicalFailureNudged = false;
    else if (!identicalFailureNudged) {
      identicalFailureNudged = true;
      nudgedThisTurn = true;
      input.onEvent?.({ type: "repeating_failure", phase, call: repeatedFailure[0], count: repeatedFailure[1].count, turn });
      messages.push({
        role: "user",
        content: [{
          type: "text",
          text:
            `You have run this call ${repeatedFailure[1].count} times and received the IDENTICAL error every time: ` +
            `${repeatedFailure[0]}. Whatever you changed between runs did not affect what this error checks. ` +
            "Re-read the error and change the exact thing it names before running this again. If you cannot " +
            "change the outcome, emit phase_complete with result=partial and say what blocked it.",
        }],
      });
    } else if (repeatedFailure[1].count > MAX_IDENTICAL_FAILURES) {
      input.onEvent?.({ type: "phase_stalled", phase, reason: "repeating_failure", detail: stallDetail(recentFailures, turn), call: repeatedFailure[0] });
      return { done: false, stalled: true, error: `identical failure ${repeatedFailure[1].count}x: ${repeatedFailure[0]}` };
    }
    // Same signal, read entry by entry: one problem the model has not touched while the calls
    // and the rest of the error set around it kept changing. Skipped when the stricter guard
    // already spoke this turn -- two near-identical nudges in one turn is noise, and the model
    // acts on the last thing it was told.
    const stuckEntry = unchangedEntryNudged
      ? undefined
      : [...unchangedEntries.entries()].find(([, count]) => count >= MAX_UNCHANGED_ENTRY_FAILURES);
    if (stuckEntry && !nudgedThisTurn) {
      const [key, count] = stuckEntry;
      unchangedEntryNudged = true;
      const entry = key.slice(key.indexOf(ENTRY_KEY_SEPARATOR) + 1);
      input.onEvent?.({ type: "repeating_failure", phase, call: key, entry, count, turn });
      messages.push({
        role: "user",
        content: [{
          type: "text",
          // No escape clause here, deliberately. The first version ended with "if you cannot,
          // emit phase_complete with result=partial", and the run it first fired on took that
          // exit three requests later with 17 of its 80 unspent -- while its own stated reason
          // showed it knew exactly what was required. This nudge fires MID-convergence, where
          // the phase still has budget and the right move is to act, so it names the next
          // action instead of offering the door. Giving up is still available: the strict guard
          // that precedes a stall offers it, at the point where it is actually warranted.
          text:
            `This has now come back UNCHANGED from ${count} runs in a row: ${entry}. ` +
            "The other errors around it changed, so the edits you made were about something else. " +
            "Change exactly what this one names -- the field, the file and the value it asks for -- " +
            "before running that script again. If the value is one a script produces, run that " +
            "script and use its output rather than composing the value yourself.",
        }],
      });
    }
  }
  input.onEvent?.({ type: "phase_stalled", phase, reason: "max_turns", detail: stallDetail(recentFailures, maxTurns - 1) });
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
      return { phases, manifest, terminal: terminalForResult(ctrl.result) };
    }
    if (!next) {
      // A DOCUMENTED handoff to a flow we do not serve ends the build; it does not break it.
      // deploy's own success sample hands off to `project-library-upload`
      // (upy-deploy-plugin/sample/phase_complete.upy_deploy_plugin.success.json) and the
      // plugin's smoke test asserts that exact value, so a correctly behaving deploy lands
      // here every time. Failing on it called a green six-phase build "failed" while every
      // phase reported success and the board was running the firmware; the earlier passes
      // were luck, their deploy happened to emit null instead.
      //
      // An UNDOCUMENTED name stays an error. A model that invents a phase is asking for work
      // that will never happen, and calling that a completed build would hide it.
      if (TERMINAL_HANDOFF_PHASES.has(handoffKey(requestedNext))) {
        input.onEvent?.({ type: "phase_handoff_unserved", next_phase: requestedNext, phase });
        return { phases, manifest, terminal: terminalForResult(ctrl.result) };
      }
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
// A tool result is read back by the model, so an oversized one does not merely cost
// tokens: it pushes the conversation past the upstream's context window and kills the
// run. One scaffold report measured 652,869 chars (43 file bodies carried twice, once
// under `files` and again under `file_operations`) and added 206k tokens to the context
// in a single turn; three turns later the request was rejected for exceeding the model's
// limit. Cap what reaches the model here, so no single script can do that again.
const TOOL_OUTPUT_MAX_CHARS = 80_000;
// Per embedded string, applied inside a JSON report. File bodies are the bulk, and the
// model does not need one read back to it: it just wrote it.
const EMBEDDED_STRING_MAX_CHARS = 500;

// One stable substring every host truncation carries. The write path below refuses any
// body containing it, so a shortened value can never be transcribed back onto disk.
export const HOST_TRUNCATION_MARKER = "removed by the host:";

const truncationNote = (removed: number) =>
  `…[${removed} chars ${HOST_TRUNCATION_MARKER} output too large to send. Do not re-run the script to see the rest.]`;

// A shrunk EMBEDDED string is not merely shortened output: a scaffold report's `files[]`
// and `file_operations[].payload.content` are bodies the model re-emits as writes, so the
// generic "don't re-run" note read as "this is all there is" and the model wrote the note
// itself into main.py, reported ok:true, and left the gate failing on a syntax error with
// nothing explaining it. Say what the value IS, and where the real body lives instead.
const bodyOmittedNote = (removed: number) =>
  `…[${removed} chars ${HOST_TRUNCATION_MARKER} this value is NOT the full body and must never be written to a file. Read the file itself to get its content.]`;

// Keep the head AND the tail. A report's verdict and its handoff payload sit at the END
// (a scaffold report ends with manifest_content and phase_complete_payload), so a
// head-only cut throws away exactly what the phase needs to continue.
function clampKeepingTail(text: string): string {
  const half = Math.floor(TOOL_OUTPUT_MAX_CHARS / 2);
  return text.slice(0, half) + truncationNote(text.length - TOOL_OUTPUT_MAX_CHARS) + text.slice(-half);
}

function shrinkLongStrings(value: any): any {
  if (typeof value === "string") {
    return value.length <= EMBEDDED_STRING_MAX_CHARS
      ? value
      : value.slice(0, EMBEDDED_STRING_MAX_CHARS) + bodyOmittedNote(value.length - EMBEDDED_STRING_MAX_CHARS);
  }
  if (Array.isArray(value)) return value.map(shrinkLongStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = shrinkLongStrings(inner);
    return out;
  }
  return value;
}

// Shrink the oversized STRINGS inside a JSON report rather than cutting the text, so
// every key survives and the result stays parseable. Falls back to a head+tail clamp for
// output that is not JSON, or that is still too large once the strings are shrunk.
export function capToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output : "";
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text;
  try {
    const shrunk = JSON.stringify(shrinkLongStrings(JSON.parse(text)));
    return shrunk.length <= TOOL_OUTPUT_MAX_CHARS ? shrunk : clampKeepingTail(shrunk);
  } catch {
    return clampKeepingTail(text);
  }
}

// A listing is a model-facing payload for the same reason stdout is, and a deep tree can
// carry tens of thousands of entries. Keep the HEAD here (unlike stdout): entries arrive
// shallowest-first, so the head is the part that describes the project. Report how many
// were dropped, or the model reads a partial listing as the whole tree and concludes files
// it just wrote are missing.
export function capListEntries(entries: unknown[]): { entries: unknown[]; omitted: number } {
  if (JSON.stringify(entries).length <= TOOL_OUTPUT_MAX_CHARS) return { entries, omitted: 0 };
  const kept: unknown[] = [];
  let used = 0;
  for (const entry of entries) {
    used += JSON.stringify(entry).length + 1;
    if (used > TOOL_OUTPUT_MAX_CHARS) break;
    kept.push(entry);
  }
  return { entries: kept, omitted: entries.length - kept.length };
}

// A corrective message is a nudge, not a report: the full gate output is already in the
// tool result the model just read. Cap both the entry count and each entry, so a hundred
// lint errors cannot crowd out the conversation the cap above exists to protect.
// The corrective message is bounded by BYTES, not by entry count, because the two gates that
// produce it are nothing alike: check_phase_complete_consistency.py returns 17-18 short codes
// (~2 KB in total, and the model needs all of them -- shown 10 of 18 it fixed those, the rest
// surfaced next turn, and the phase spent 44 turns trading one requirement for another before
// dying on max_turns), while flake8 can return 40 entries of 900 characters each. One budget
// serves both: every short code fits, a wall of lint does not.
const MAX_CORRECTIVE_CHARS = 6000;

// The gate whose PASS means "this phase is finished": generate's own final consistency check.
// Deliberately not broadened to every validator. deploy runs
// `deploy_manifest.py --validate-phase-complete` against the PREVIOUS phase's payload as an
// input check, and telling the model to emit phase_complete there would end deploy before it
// had done anything.

function isPhaseCompletionCheck(tu: StreamEvent): boolean {
  const script = String((tu.input as any)?.script ?? "");
  return tu.name === "script_run" && script.endsWith(PHASE_COMPLETION_CHECK);
}

function correctiveText(gateErrors: any[]): string {
  const lines: string[] = [];
  let spent = 0;
  for (const entry of gateErrors) {
    const name = gateEntryReason(entry);
    const detail = clampCorrectiveDetail(correctiveDetail(entry, name));
    const line = detail ? `- ${name}: ${detail}` : `- ${name}`;
    // Always keep the first, so a single oversized entry still says something.
    if (lines.length > 0 && spent + line.length > MAX_CORRECTIVE_CHARS) break;
    lines.push(line);
    spent += line.length;
  }
  const dropped = gateErrors.length - lines.length;
  return (
    "Quality gate failed. Fix exactly these, then re-run the gate:\n" +
    lines.join("\n") +
    (dropped > 0 ? `\n- (${dropped} more; the full report is in the tool result)` : "")
  );
}
const MAX_CORRECTIVE_DETAIL_CHARS = 400;

// Everything the gate said about ONE failure, in the order the model needs it: where, what
// would satisfy it, then why. `path ?? message` dropped the message whenever a record carried
// both, which is the common case -- BOOT_DELAY_MISSING names firmware/main.py AND explains the
// three second delay, and the model was shown only the filename. `accepted*` / `expected` are
// what the gates carry once they name their accepted values, so pass them through too.
// `named` is what the line already prints as the entry's name (gateEntryReason). An entry with
// no `code` is named by its message, and repeating that message as its own detail reads as
// "- must be a non-empty list: must be a non-empty list" -- drop the part already said.
function correctiveDetail(entry: any, named = ""): string {
  const accepted = entry?.accepted ?? entry?.accepted_url ?? entry?.accepted_urls ?? entry?.accepted_fields ?? entry?.expected;
  const parts = [
    entry?.path,
    accepted === undefined ? "" : `accepted: ${typeof accepted === "string" ? accepted : JSON.stringify(accepted)}`,
    entry?.message,
  ];
  return parts.map((p) => String(p ?? "").trim()).filter(Boolean).filter((p) => p !== named).join(" — ");
}

function clampCorrectiveDetail(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length <= MAX_CORRECTIVE_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_CORRECTIVE_DETAIL_CHARS)}… (truncated, see the tool result)`;
}

// Did the phase-completion checker actually RETURN a passing verdict? Its own JSON, never the
// exit code. `--help` exits 0 too, and one run ended exactly there: the model could not satisfy
// the gate, failed twice trying to locate the script, ran it with `--help`, and the zero exit
// was read here as a pass -- so the corrective told it to emit phase_complete, and the phase was
// accepted with its last real validation still three errors red, GIT_COMMIT_MISSING among them.
// A usage message is not a verdict.
// Truncation is safe by construction: stdout is capped upstream, and a clipped report fails to
// parse, which withholds the corrective rather than inventing a pass.
// The three gates spell their verdict three ways, and there is no shared schema:
//   select_hw_manifest.py               {"status":"ok"|"fail", "errors":[...]}
//   check_phase_complete_consistency.py {"ok":true|false, "result":"success"|"failed", "errors":[]}
//   deploy_result.py                    {"status":"success", ...}
// Unrecognized returns null, NOT "fail". Reading an unknown shape as failure would refuse a
// phase whose gate actually passed, which is a worse bug than the one this guard exists to fix:
// the first version of this keyed on `ok` alone and would have refused every select-hw pass,
// because that script has no `ok` field at all.
// `pass_with_warnings` is a PASS. deploy_result.py:517 grades FAIL / PASS_WITH_WARNINGS / PASS,
// and warnings are the normal outcome of a real deploy -- one archived full-chain pass ended on
// exactly this verdict. Omitting it would make the anti-fabrication guard refuse honest deploys.
const GATE_PASS_STATUS = new Set(["ok", "success", "pass", "passed", "pass_with_warnings"]);
const GATE_FAIL_STATUS = new Set(["fail", "failed", "error"]);

function gateVerdict(stdout: unknown): "pass" | "fail" | null {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text.startsWith("{")) return null;  // usage text from --help lands here, and stays unknown
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return "fail";
  const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
  if (parsed.ok === false || GATE_FAIL_STATUS.has(status)) return "fail";
  if (parsed.ok === true || GATE_PASS_STATUS.has(status)) return "pass";
  return null;
}

// Strict form for the completion corrective: only a RECOGNIZED pass may announce a phase done.
// `--help` prints usage, parses as nothing, and can never reach this.
function phaseCheckVerdictPassed(stdout: unknown): boolean {
  return gateVerdict(stdout) === "pass";
}

function structuredErrorsFromStdout(stdout: unknown): Array<{ code?: string; path?: string; message?: string }> | undefined {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text.startsWith("{")) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const flat: Array<{ code?: string; path?: string; message?: string }> = [];
  if (Array.isArray(parsed.errors)) flat.push(...parsed.errors);
  // apply_scaffold reports its failures one level down, under the phase_complete payload it
  // also emits, so a scaffold lint failure produced no corrective message at all while a
  // quality-gate failure did. Read both shapes: the model should not have to notice which
  // script it happened to run.
  // A FALLBACK, not a union: apply_scaffold serializes the SAME python list at both paths
  // (run_actual_project returns `structured_errors` at the top level and build_phase_complete
  // puts the identical list in payload.structured_errors), so reading both concatenated every
  // scaffold error twice -- printing it twice in the corrective message and halving the
  // MAX_CORRECTIVE_ENTRIES budget, five real errors filling ten slots.
  const source = Array.isArray(parsed.structured_errors)
    ? parsed.structured_errors
    : parsed?.phase_complete?.payload?.structured_errors;
  if (Array.isArray(source)) {
    for (const entry of source) {
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
export async function executeProtocolTool(tu: StreamEvent, input: ProtocolInput, deps: ProtocolDeps, phaseCtx: { phase?: string; turn?: number; wasModelWritten?: (path: string) => boolean } = {}): Promise<{ result: any; phaseControl?: any }> {
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
    // An unknown token is rejected, not guessed at: "ok" and "complete" read as intent to
    // succeed, and mapping them to success would put that guess INSIDE the anti-fabrication
    // guard. The model re-emits with the canonical token, which costs one turn once.
    if (!PHASE_RESULT_VALUES.has(String(p.result))) {
      return { result: { ok: false, error_kind: "phase_complete_invalid_result", detail: `phase_complete.result must be one of success, partial, failed; received "${String(p.result)}"` } };
    }
    // A scaffold `success` that rendered NOTHING. Measured on a real run: the model never
    // called apply_scaffold, hand-wrote the tree, and reported success -- the project had no
    // .flake8, no .upy/, no lib/. It then had to reproduce tools/flash_device.py by hand for
    // the deploy-tool gate, wrote it 8 times, and matched 3 of the 12 required markers that
    // the scaffold's own template satisfies outright. Reject it (no phaseControl) so the
    // phase continues and the model runs apply_scaffold, instead of carrying a project with
    // no scaffold contract into generate and deploy.
    if (phaseCtx.phase === "upy-scaffold-plugin" && p.result === "success") {
      // No reader wired is not "guard passes": makeWorkspaceReader and makeWorkspaceWriter go
      // undefined together, so a run without a reader never wrote the project either and its
      // scaffold `success` cannot be true. `&& deps.readFile` made the check silently absent
      // in exactly that case; every other missing dep in this file fails loud (device_
      // unavailable, host_runner_absent) and so does this one.
      if (typeof deps.readFile !== "function") {
        return { result: { ok: false, error_kind: "workspace_unavailable", message: "Cannot verify the scaffold rendered: no workspace reader is available, so the project was never written." } };
      }
      const reads = await Promise.all(SCAFFOLD_APPLIED_MARKERS.map((path) => deps.readFile!(path)));
      // Every marker answered "not there". A read that FAILED for any other reason is an
      // error, not absence, and leaves the phase alone -- rejecting on it would kill a
      // scaffold that did run.
      //
      // A marker the MODEL wrote counts as absent. Presence is the whole test here, so a
      // file_operation write of either path defeats it outright -- and this loop has already
      // watched a run hand-write .flake8 and a fake lib/ to satisfy the previous marker, so it
      // is a demonstrated move rather than a theoretical one. apply_scaffold is always legal,
      // so the rejection below still leaves a way through.
      const allMissing = reads.every((r, i) =>
        (!r.ok && MISSING_FILE_KINDS.has(r.error_kind ?? "")) || phaseCtx.wasModelWritten?.(SCAFFOLD_APPLIED_MARKERS[i]) === true);
      if (allMissing) {
        return {
          result: {
            ok: false,
            error_kind: "scaffold_not_applied",
            // Name what satisfies it. A gate that only says no costs a phase budget.
            message:
              `Rejected: scaffold reported success but the project has none of ${SCAFFOLD_APPLIED_MARKERS.join(", ")}, ` +
              "so apply_scaffold never rendered. Run the scaffold plugin's apply_scaffold script, then " +
              "re-emit phase_complete. Do not hand-write the scaffold tree: it ships tools/flash_device.py " +
              "and tools/read_device_log.py in the exact shape the deploy phase requires, and a hand-written " +
              "copy fails the deploy-tool gate.",
          },
        };
      }
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
    // NOT announced here. This runs before the gate check that may REFUSE the claim, and a
    // refused success was still emitted as `phase_complete`, so every consumer recorded it as
    // one: the harness printed "phase_complete: success", counted the phase as succeeded and
    // snapshotted a checkpoint; the panel and the cloud recorder saw the same. Measured on a
    // run that stalled at its turn cap while its summary read "generate (success): true", and
    // the checkpoint it wrote is a valid resume point into the NEXT phase carrying a payload
    // the gate had refused. The payload rides on phaseControl and is announced by runPhase
    // once the claim survives.
    return { result: { ok: true }, phaseControl: { result: p.result, next_phase: p.next_phase, next_skill: p.next_skill, manifest: p.manifest_content, payload: p } };
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
    if (r.ok === false) {
      // A project-local path can NEVER resolve here: script_run looks up bundled plugin scripts
      // by name, so anything under the project tree comes back script_not_found with no hint of
      // why. Two runs learned that the expensive way -- one retried tools/flash_device.py three
      // times then fell back to uploading file by file, another invented
      // tools/build_phase_complete.py and spent its remaining turns on it. Name the boundary and
      // the legal routes, so the model stops guessing at the lookup instead of the approach.
      const requested = String(p.script ?? "");
      const projectLocal = r.error_kind === "script_not_found" && /[\/]/.test(requested) && !requested.startsWith("scripts/") && !requested.startsWith(".upy/");
      const detail = projectLocal
        ? `"${requested}" looks like a path inside the project. script_run resolves BUNDLED PLUGIN scripts by name only, so a project-local file can never run this way, however it was created. Use the bundled script that does this job, or file_operation to read/write the project. A helper rendered into the project (tools/*.py) is for the user to run by hand, not a script_run target.`
        : undefined;
      return { result: { ok: false, script_id: p.script_id, success: false, error_kind: r.error_kind ?? "script_error", stderr: capToolOutput(r.stderr), candidates: r.candidates, structured_errors: r.structured_errors, ...(detail ? { detail } : {}) } };
    }
    // The script RAN: success keys on its exit code (a non-zero gate is a real, fixable result).
    const exit = r.exit_code ?? 0;
    // The real host shim doesn't populate structured_errors -- it returns the script's
    // JSON report (run_quality_gates.py etc.) as a stdout STRING. Parse that shape
    // defensively so the loop's corrective path fires in production too; anything that
    // isn't a JSON report leaves the result exactly as before.
    // Parsed from the FULL stdout, BEFORE the cap: a report's error detail can sit past
    // the cap, and the corrective path must still see it even when the model cannot.
    const structuredErrors = r.structured_errors ?? structuredErrorsFromStdout(r.stdout);
    // accepted_flags is forwarded, not dropped. The shim reads a script's own option list and
    // attaches it so the model never needs a `--help` turn; this return rebuilds the result from
    // a fixed field list, so the first version of that fix was invisible -- the shim attached it
    // and this line threw it away. A run afterwards still made 10 --help probes.
    return { result: { ok: true, script_id: p.script_id, success: exit === 0, stdout: capToolOutput(r.stdout), stderr: capToolOutput(r.stderr), exit_code: exit, structured_errors: structuredErrors, ...(r.accepted_flags ? { accepted_flags: r.accepted_flags } : {}) } };
  }

  if (route === "device") {
    if (typeof deps.device !== "function") return { result: { ok: false, error_kind: "device_unavailable" } };
    try {
      const action = String(p.action ?? "");
      const r = await deps.device(action, p);
      // The serial event carries the FULL stdout: it feeds the Serial tab, which the user
      // reads, and only the model-facing result below is capped.
      if (r.stdout && SERIAL_OUTPUT_ACTIONS.has(action)) input.onEvent?.({ type: "serial_output", lines: String(r.stdout).split("\n").filter(Boolean) });
      return { result: { ok: r.ok, cmd_id: p.cmd_id, success: r.ok, stdout: capToolOutput(r.stdout), stderr: capToolOutput(r.stderr), error_kind: r.ok ? undefined : (r.error_kind ?? "runtime_error") } };
    } catch (error: any) {
      return { result: { ok: false, cmd_id: p.cmd_id, success: false, error_kind: "runtime_error", message: error?.message ?? "device_error" } };
    }
  }

  return { result: { ok: false, error_kind: "unrouted_tool", detail: name } };
}

// Every op execFileOperation routes. Named once so the rejection below can TELL the
// model what it may send instead of leaving it to guess.
const SUPPORTED_FILE_OPS = ["read", "write", "append", "list", "mkdir", "delete"] as const;

// Paths that live in the PLUGIN's resource directory, not in the project. file_operation is
// confined to the project, so a read of one of these can never succeed however the run goes --
// and "file_not_found" reads as "that file does not exist", which teaches the model nothing.
// Measured: generate opens by reading five of these in a row, because SKILL.md sends it there
// ("解析协议 -> references/protocol_fields.md" and eight more rows of the same table). The files
// DO exist, just not anywhere this tool can see. Same boundary select-hw already settled for
// the board library.
const SKILL_RESOURCE_PATH = /(^|[\\/])(references|knowledge|boards|assets)[\\/]|^upy-[a-z-]+-plugin[\\/]/i;

function skillResourceDetail(path: string): string | null {
  if (!SKILL_RESOURCE_PATH.test(path)) return null;
  return `"${path}" is a PLUGIN RESOURCE path, not a project file. file_operation is confined to the ` +
    "project workspace, so this read can never succeed, whatever the phase does first. The reference " +
    "material a SKILL points at is already delivered to you as prompt text, and host-resolved facts " +
    "(board profile, board candidates) arrive under RESOLVED DATA. Work from those and do not retry " +
    "this path or look for it elsewhere in the project.";
}

async function execFileOperation(p: any, deps: ProtocolDeps, input: ProtocolInput) {
  const op = p.op;
  const path = String(p.path ?? "");
  if ((op === "write" || op === "append")) {
    if (typeof deps.writeFile !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    // The protocol requires content on write/append. Coercing an ABSENT content to ""
    // wrote an empty file and reported success, so the model was told it had written
    // real code and moved on with nothing on disk. Refuse instead, and say why.
    // An explicitly empty string still writes: that is a deliberate empty file, and
    // only the missing key is the malformed call.
    // Any non-string is refused for the same reason, not just an absent key: String({})
    // writes a file containing "[object Object]" and reports success, which is the same
    // silent-wrong-file-on-disk failure with a different input.
    if (typeof p.content !== "string") {
      const received = p.content === undefined || p.content === null ? "none" : `a ${typeof p.content}`;
      return {
        ok: false, op_id: p.op_id, success: false, error_kind: "missing_content",
        detail: `file_operation "${op}" requires a "content" string. Received ${received} for path "${path}". Send the full file body in "content"; use "" only for a deliberately empty file.`,
      };
    }
    // The host's own truncation marker must never reach disk. Its presence means the model
    // is transcribing a body this loop shortened, so writing it produces a file that is
    // silently corrupt (a syntax error the next gate reports with nothing explaining it).
    // Refuse loudly and point at the file, rather than accepting it and reporting ok:true.
    if (p.content.includes(HOST_TRUNCATION_MARKER)) {
      return {
        ok: false, op_id: p.op_id, success: false, error_kind: "truncated_content",
        detail: `file_operation "${op}" refused: the content for "${path}" contains a host truncation marker, so it is not the full body. Read the file with file_operation "read" to get its real content; never write a shortened value back.`,
      };
    }
    // There is no append path anywhere in the writer tree -- deps.writeFile TRUNCATES -- so
    // routing append to it destroyed the body it was asked to extend and returned ok:true.
    // Compose the real thing from the two deps already wired.
    let body = p.content;
    if (op === "append") {
      if (typeof deps.readFile !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
      const existing = await deps.readFile(path);
      // A missing file appends as a create. Any OTHER read failure must NOT degrade to an
      // empty base: that is the same silent truncation, one level down.
      if (!existing.ok && existing.error_kind !== "file_not_found") {
        return {
          ok: false, op_id: p.op_id, success: false, error_kind: existing.error_kind ?? "read_failed",
          detail: `file_operation "append" could not read the existing "${path}" to extend it, so it refused rather than replacing the file with just the new fragment.`,
        };
      }
      body = (existing.ok ? existing.content ?? "" : "") + p.content;
    }
    const r = await deps.writeFile(path, body);
    if (r.ok) input.onEvent?.({ type: "file_written", path: r.path ?? path });
    // Report the path actually written, PROJECT-RELATIVE. The writer accepts a redundant
    // leading segment and writes to the corrected target, so a bare success would leave the
    // model believing its own prefixed path exists and reusing it for every later op. Never
    // report r.path: that one is absolute, for the artifact index, and this same allowlist
    // refuses an absolute path if the model sends it back.
    return { ok: r.ok, op_id: p.op_id, success: r.ok, ...(r.ok && r.relative_path ? { path: r.relative_path } : {}), error: r.ok ? null : (r.error_kind ?? "write_failed"), ...(r.allowed ? { allowed: r.allowed } : {}) };
  }
  if (op === "read") {
    if (typeof deps.readFile !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.readFile(path);
    // Capped for the SAME reason script stdout is: a read is a model-facing payload, and it
    // is the one route that can pull an arbitrarily large file body into the conversation in
    // a single turn. Leaving it uncapped meant moving a 650KB payload out of stdout and into
    // a file bundle merely relocated the context-window kill instead of fixing it.
    // A failed read of a plugin-resource path gets the boundary named, the same way script_run
    // names it for a project-local script. Only on failure: a path that READ fine is nobody's
    // problem, whatever it looks like.
    const boundary = r.ok ? null : skillResourceDetail(path);
    return {
      ok: r.ok, op_id: p.op_id, success: r.ok, content: capToolOutput(r.content ?? ""),
      error: r.ok ? null : (r.error_kind ?? "read_failed"),
      ...(boundary ? { detail: boundary } : {}),
    };
  }
  if (op === "list") {
    // No lister wired = the workspace is unavailable. Faking ok:true with empty
    // entries told the model "the project is empty", which made generate wrongly bail
    // to analyze 鈥?so fail loud instead of fabricating an empty listing.
    if (typeof deps.listFiles !== "function") return { ok: false, op_id: p.op_id, error_kind: "workspace_unavailable" };
    const r = await deps.listFiles(path);
    const listed = capListEntries(r.entries ?? []);
    return {
      ok: r.ok, op_id: p.op_id, success: r.ok, entries: listed.entries,
      ...(listed.omitted > 0 ? { entries_omitted: listed.omitted, detail: `${listed.omitted} further entries were omitted by the host: the listing was too large to send. List a narrower path to see them.` } : {}),
      error: r.ok ? null : (r.error_kind ?? "list_failed"),
    };
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
  // A rejection the model cannot act on is a stalled phase: it re-guesses, burns turns,
  // and the run dies on max_turns or a text-only no_tool_call turn. `op` was spread in
  // bare, so a call with NO op serialized to {ok:false,error_kind:"unsupported_file_op"}
  // (JSON.stringify drops undefined) and told the model nothing at all. Separate the two
  // cases, keep the key with an explicit null, and always name what is accepted.
  const missing = op === undefined || op === null || op === "";
  return {
    ok: false, op_id: p.op_id, success: false,
    error_kind: missing ? "missing_file_op" : "unsupported_file_op",
    op: op ?? null,
    supported_ops: [...SUPPORTED_FILE_OPS],
    detail: missing
      ? `file_operation requires an "op". Send one of: ${SUPPORTED_FILE_OPS.join(", ")}.`
      : `file_operation "${String(op)}" is not a supported op. Send one of: ${SUPPORTED_FILE_OPS.join(", ")}.`,
  };
}
