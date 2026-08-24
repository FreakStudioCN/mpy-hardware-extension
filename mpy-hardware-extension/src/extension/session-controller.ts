import type { SessionRecorder } from "./session-recorder.ts";
import type { PendingSupplement } from "./pending-supplement.ts";
import { classifySupplement } from "../core/supplement-router.ts";
import type { SupplementAttachment } from "../core/supplement-router.ts";
import { classifyArtifactKind } from "./artifact-index.ts";
import type { ArtifactSource } from "./artifact-index.ts";
import { deriveWiring } from "../core/wiring-derive.ts";
import { deriveDiagram } from "../core/diagram-derive.ts";
import { deriveDriverStatus, detectDriverReadyBlock, GEN_DRIVER_DOMAIN_PHASE, type DriverReadyBlockEntry } from "../core/gen-driver-schema.ts";
import { WIRING_PHASE, DIAGRAM_PHASE } from "../core/optional-flow-schema.ts";
import { buildCreditUsage, deriveCreditOperation, formatCreditUsage, type CreditUsageRecord } from "../core/credit-usage.ts";
import { PHASE_ALIASES } from "../core/protocol-loop.ts";

export class SessionController {
  deps: {
    postMessage: (message: any) => void;
    loop: (input: any) => Promise<any>;
    recorderFactory?: (traceId: string) => SessionRecorder;
    writeFiles?: (files: Record<string, string>) => Promise<any>;
    // Hard-interrupt an in-flight device operation on Stop (deliverables 07 §4): the
    // signal abort only stops the loop between turns/tools, so a running mpremote
    // flash/upload keeps going until it finishes. killDevice kills the shim subprocess
    // now and releases the serial lock. Idempotent — a no-op when nothing is in flight.
    killDevice?: () => void;
    // Stable per-install anonymous id (vscode.env.machineId), stamped on every credit-usage
    // record so consumption can be grouped per install without identifying the user.
    anonId?: string;
  };

  // Pending ask_user prompts: promptId -> resolve fn. The loop awaits askUser();
  // the webview answers via a ui_prompt_response message routed to resolvePrompt.
  // `extra` carries optional response data (e.g. the plan-revise feedback).
  private pendingPrompts = new Map<string, (answer: string | null, extra?: any) => void>();
  private promptSeq = 0;
  private abort: AbortController | null = null;
  // Bumped by reset() to supersede an in-flight run. start() captures the value at
  // launch and drops any outbound message once the generation has moved on, so an
  // aborted run's late unwinding (terminal session_done, trailing events) can't land
  // in the freshly-cleared conversation of the next session.
  private generation = 0;
  private state: any = undefined;
  private boardId: string | null = null;
  private preSelectedBoard: any = undefined;
  // Handoff user context (mode/locale/existing_hardware), session-level. Carried into the
  // loop request and preserved across retry().
  private preferences: { mode?: string; locale?: string; existing_hardware?: string } | undefined;
  // "recommend" when the user let the system pick the board; carried into the loop, cleared on a fresh session.
  private boardSelectionMode: string | undefined;
  // Board list from the last start(), reused by retry() so the continued loop
  // resolves "auto" the same way the original run did.
  private availableBoards: any[] | undefined;
  private traceId: string | null = null;
  private recorder: SessionRecorder | undefined;
  private recordedStart = false;
  private latestManifest: any = undefined;
  // True once an LLM/plugin-authored diagram has arrived via the diagram_updated
  // branch this build. While set, the manifest_updated chokepoint stops emitting the
  // manifest-derived diagram so the richer authored one is never overwritten. Cleared
  // in BOTH run() and reset() — reset() nulls the fields start() keys on, so a single
  // clear would leak an authored-diagram guard across builds.
  private hasAuthoredDiagram = false;
  // Generated files accumulated by path across generate_code calls. A single-file
  // project leaves this as { "main.py": ... }; a multi-file project collects each
  // target_path the agent generates. Used only by the headless post-loop fallback.
  private latestFiles: Record<string, string> = {};
  // Project files the loop persisted to disk itself (write_project_file +
  // generate_code, via the allowProjectTree channel). When non-empty, the loop
  // owns all writes: the post-loop batch is skipped (no re-write, no manifest dup)
  // and the files_written toast is built from these. Empty in headless/test runs
  // with no loop-time writer, where the post-loop batch is the fallback writer.
  private persistedPaths: string[] = [];
  // Absolute paths of every artifact file written this session, from BOTH writers: the
  // loop's own write_project_file (persistedPaths) and the headless post-loop batch.
  // Feeds the Artifact Browser index; kept separate from persistedPaths so the diagnostics
  // artifact_index and the loop-owns-writes decision above are unchanged.
  private producedPaths: string[] = [];
  // The phase each file was written in, stamped from currentPhase at file_written time,
  // so the Artifact Browser attributes the PRODUCING phase per file (not the final phase).
  private producedPhase = new Map<string, string>();
  // Artifacts each phase declares in its phase_complete ({type, path}). Host Skill scripts
  // (analyze manifest, select-hw plan) write these directly — they never emit a file_written
  // event — so this is the only way the Artifact Browser learns about pre-generate outputs,
  // with their real role (the Skill's `type`) and producing phase.
  private phaseArtifacts: Array<{ path: string; role: string; phase: string }> = [];
  // The optional follow-on flows generate offered in its phase_complete (optional_next_phases:
  // [{phase, reason}]). The webview wiring/diagram entries enable only after generate offers them.
  private optionalNextPhases: Array<{ phase?: string; reason?: string }> = [];
  // The #53 driver-ready gate result from the latest generate (detectDriverReadyBlock). Stored because a
  // gen-driver dispatch runs LATER than detection with only the manifest (no errors), so an error-code-only
  // block (e.g. DRIVER_STATUS_UNSUPPORTED) isn't re-derivable at dispatch time; the panel threads this into
  // buildGenDriverDispatch as `blocked` to force pipeline mode. Same per-run lifecycle as optionalNextPhases.
  private driverReadyBlocks: DriverReadyBlockEntry[] = [];
  // The last generate phase_complete, so a wiring/diagram run can persist it as the upstream result
  // (source_phase_complete_path) the plugin reads to reach a formal success. Cleared with the session.
  private latestGeneratePhaseComplete: unknown = undefined;
  // The last phase_complete THIS run emitted ({phase, result, errors, network_permission}). A startPhase
  // excursion (wiring/diagram) reads it to gate its post-run render: it renders a success OR partial run
  // that freshly wrote its doc (the plugin reports partial when it couldn't render in-sandbox — that's why
  // the host renders), but skips it when the user denied the mermaid.ink network render. The denial arrives
  // TWO ways and both must be retained: a structured `network_permission.decision === "deny"`, and/or a
  // *_PERMISSION_DENIED error code (DIAGRAM_/WIRING_IMAGE_RENDER_). Per-run; cleared in reset() (#9).
  private lastPhaseComplete: { phase?: string; result?: string; errors?: unknown; network_permission?: unknown } | undefined = undefined;
  // The phase the loop is currently in, tracked off phase_start. Stamps a queued
  // supplement's receivedPhase (deliverables 07 §3) and feeds the diagnostics snapshot
  // (section 08). Cleared on a fresh session (board switch) alongside the other run state.
  private currentPhase: string | null = null;
  // Diagnostics snapshot state (section 08): a short ring of recent activity summaries and
  // any error strings — surfaced by getDiagnostics() for a bug report.
  private recentActivity: string[] = [];
  private keyErrors: string[] = [];
  private static readonly RECENT_ACTIVITY_CAP = 10;
  // A bounded tail of the device's serial output for the section-08 stdout_stderr_summary
  // diagnostics field. Newest N lines only; cleared with the other run state (start + reset).
  private stdoutTail: string[] = [];
  private static readonly STDOUT_TAIL_CAP = 20;
  private static readonly STDOUT_SUMMARY_MAX = 2000;
  // User supplements queued during a running build (deliverables 07 §3), consumed FIFO at
  // the after-phase_complete safe point. A queue (not a single slot) so a second note
  // added before the next safe point is not lost (§9 acceptance).
  private pendingSupplements: PendingSupplement[] = [];
  // ---- credit-usage accumulators (card #87) ----
  // Every per-phase credit record this session, in arrival order. Read by the diagnostics
  // snapshot + session-log export; bounded so a long build can't grow it without limit.
  private creditUsage: CreditUsageRecord[] = [];
  private static readonly CREDIT_USAGE_CAP = 100;
  // How many of the oldest records the cap has discarded this session. Reported in the
  // diagnostics rollup so a truncated summary can't be read as the whole build's cost.
  private creditUsageDropped = 0;
  // The balance the previous credits event reported. The delta against the next one is the
  // best-effort per-turn consumption until the server sends its authoritative charge.
  private lastCreditBalance: number | null = null;
  // When the turn being metered started, so each record carries its own duration. Set at
  // run() launch (so the FIRST turn has one too) and re-stamped after every credits event.
  private turnStartedAt: number | null = null;
  // Transport retries seen this session (connect_retry) plus manual retry() calls.
  private retryCount = 0;
  // The optional flows this session actually ran — a project needing a wiring/architecture
  // diagram is a complexity dimension, distinct from the manifest-derived Wiring tab which
  // is always populated.
  private ranWiring = false;
  private ranDiagram = false;
  // The NEXT metered turn is a re-issue / a supplement absorption. Both outrank the phase in
  // the record's operation, and both are one-shot — cleared by the credits event they label.
  private retryTurnPending = false;
  private supplementTurnPending = false;
  // The last phase-level failure code, attached to the next record so a costly failing turn
  // is attributable. Code tokens only (error_kind / stall reason) — never a message.
  private lastErrorCode: string | undefined = undefined;
  // Save Version snapshot accumulators (#95 A). Each captures a value the live paths post
  // but never RETAIN, so a later Save Version can read it. ALL cleared in reset() — the
  // documented reset-not-start trap: reset() nulls boardId, so start()'s board-change clear
  // is short-circuited and a leftover value would leak into the next session's snapshot.
  private lastTerminal: string | null = null;   // last session_done terminal (:260/:275)
  private latestDiagram: unknown = undefined;    // last authored diagram (:601 posts, never keeps)
  private lastCredits: { balance?: number; dailyGrant?: number; resetsAt?: string; capturedAt?: string } | null = null; // last-seen credits (:709 normalizes, never keeps)

  constructor(deps: { postMessage: (message: any) => void; loop: (input: any) => Promise<any>; recorderFactory?: (traceId: string) => SessionRecorder; writeFiles?: (files: Record<string, string>) => Promise<any>; killDevice?: () => void; anonId?: string }) {
    this.deps = deps;
  }

  async start(input: { intent: string; boardId: string; availableBoards?: any[]; preSelectedBoard?: any; preferences?: { mode?: string; locale?: string; existing_hardware?: string }; boardSelectionMode?: string }) {
    // Single in-flight run per controller: a concurrent start would clobber the
    // shared abort controller, files, and conversation state of the running one
    // (and cancel() would then abort the wrong run). Reject re-entry instead.
    if (this.abort) {
      this.deps.postMessage({ type: "session_busy" });
      return { terminal: "session_busy" };
    }
    if (this.boardId !== null && this.boardId !== input.boardId) {
      this.state = undefined;
      this.traceId = null;
      this.recorder = undefined;
      this.recordedStart = false;
      this.preferences = undefined;  // fresh session: don't inherit the prior build's context
      this.preSelectedBoard = undefined;
      this.boardSelectionMode = undefined;
      this.currentPhase = null;
      this.recentActivity = [];
      this.stdoutTail = [];
      this.keyErrors = [];
      this.pendingSupplements = [];
      this.producedPaths = [];
      this.producedPhase.clear();
      this.phaseArtifacts = [];
      this.optionalNextPhases = [];
      this.driverReadyBlocks = [];
      this.latestGeneratePhaseComplete = undefined;
      this.clearCreditUsage();
      // The Save Version accumulators are cleared in reset(), but the board-change branch is ALSO a
      // fresh-session path that never routes through reset() — clear them here too, or board A's
      // authored diagram / credits leak into board B's snapshot.json and session restore replays the
      // wrong board's data. (A field cleared in reset() only still leaks into the persisted snapshot
      // via this non-reset fresh-start path.)
      this.lastTerminal = null;
      this.latestDiagram = undefined;
      this.lastCredits = null;
    }
    this.boardId = input.boardId;
    if (input.preSelectedBoard !== undefined) this.preSelectedBoard = input.preSelectedBoard;
    if (input.preferences) this.preferences = input.preferences;
    if (input.boardSelectionMode !== undefined) this.boardSelectionMode = input.boardSelectionMode;
    if (!this.traceId) {
      this.traceId = createTraceId();
    }
    if (!this.recorder && this.deps.recorderFactory) {
      this.recorder = this.deps.recorderFactory(this.traceId);
    }
    if (!this.recordedStart) {
      this.recordedStart = true;
      this.record({ type: "session_started", intent: input.intent, boardId: input.boardId, availableBoards: input.availableBoards ?? [], locale: input.preferences?.locale });
    }
    this.record({ type: "user_message", intent: input.intent, boardId: input.boardId });
    this.availableBoards = input.availableBoards;
    return this.run(input);
  }

  // Manual retry after a transport failure (llm_unreachable / interrupted stream):
  // re-enter the loop with the SAVED state and an empty intent, so the interrupted
  // turn is re-issued verbatim — no fabricated user message, no fake telemetry.
  async retry() {
    if (this.abort) {
      this.deps.postMessage({ type: "session_busy" });
      return { terminal: "session_busy" };
    }
    if (!this.state) {
      return { terminal: "nothing_to_retry" };
    }
    this.record({ type: "session_retry" });
    // The re-issued turn is its own cost line: label the next metered turn "retry" so a
    // retried phase is never counted as a first-try one.
    this.retryCount++;
    this.retryTurnPending = true;
    return this.run({ intent: "", boardId: this.boardId ?? "auto", availableBoards: this.availableBoards });
  }

  // Deliver any buffered/in-flight telemetry for this session. No-op with no recorder
  // (headless) or a recorder without a durable outbox; wired to run-end + deactivate.
  async flush() {
    await this.recorder?.flush?.();
  }

  // Dispatch an on-demand phase run (gen-driver / wiring / diagram optional flows) through the SAME
  // loop as start(), so Stop / safe-point / recorder / artifacts all work. The caller builds the
  // start_phase `envelope` (it becomes the first user message). run() is called with preserveManifest
  // so a thin optional-run manifest can't clobber latestManifest. A standalone optional run ends on its own phase and must
  // NOT leave that phase in this.state, or the next normal start() (same board) would resume it. So this
  // is a transparent excursion: snapshot the prior main-flow state, run, and restore it UNLESS the run
  // chained into a canonical phase (pipeline continuation), detected by the run ending on a DIFFERENT
  // phase than the one dispatched.
  async startPhase(input: { phase: string; envelope: string; manifest?: any; boardId?: string; label?: string; availableBoards?: any[]; locale?: string }) {
    if (this.abort) {
      this.deps.postMessage({ type: "session_busy" });
      return { terminal: "session_busy" };
    }
    const boardId = input.boardId ?? this.boardId ?? "auto";
    const label = input.label ?? input.phase;
    if (!this.traceId) this.traceId = createTraceId();
    if (!this.recorder && this.deps.recorderFactory) this.recorder = this.deps.recorderFactory(this.traceId);
    if (!this.recordedStart) {
      this.recordedStart = true;
      this.record({ type: "session_started", intent: label, boardId, availableBoards: input.availableBoards ?? [], locale: input.locale });
    }
    this.record({ type: "user_message", intent: label, boardId });
    const priorState = this.state;
    const myGen = this.generation;
    this.state = { phase: input.phase, manifest: input.manifest };
    const result = await this.run({ intent: input.envelope, boardId, availableBoards: input.availableBoards, preserveManifest: true });
    // Ended on the dispatched phase (no pipeline continuation) -> restore the main-flow state. Guard on the
    // generation like every other post-run write: if a reset()/new run superseded this one mid-flight, don't
    // clobber the new run's state with our stale priorState (matches run()'s current() checks).
    if (this.generation === myGen && this.state?.phase === input.phase) {
      this.state = priorState;
    }
    return result;
  }

  private async run(input: { intent: string; boardId: string; availableBoards?: any[]; preserveManifest?: boolean }) {
    // A startPhase excursion (gen-driver/wiring/diagram) keeps the main-flow manifest AND the authored-diagram
    // guard: the excursion's thin manifest_content must not clobber the devices-bearing manifest (the
    // manifest_updated branch reads latestManifest), nor overwrite an authored diagram with the derived view
    // (that branch reads hasAuthoredDiagram). Both are per-run state this clear would otherwise blank for the
    // whole excursion — including a restored session, which enters a wiring/diagram run with an authored diagram
    // exactly like a live one. A fresh start() (preserveManifest falsy) still clears both, so a new session
    // re-derives from scratch.
    if (!input.preserveManifest) {
      this.latestManifest = undefined;
      this.hasAuthoredDiagram = false;
    }
    this.lastPhaseComplete = undefined;
    this.latestFiles = {};
    this.persistedPaths = [];
    // Start the turn clock here, not at the first credits event, or the first turn of a run
    // would be the one turn with no duration — usually the most expensive one.
    this.turnStartedAt = Date.now();
    // The error code is one-shot: it labels the turn it happened in. A run that ends with no
    // further credits event (a terminal phase_error, or a Stop) never gets to clear it, and a
    // same-board continuation start() skips the board-change clear — so without this the next
    // run's FIRST metered turn is stamped with the previous run's failure.
    // Deliberately NOT retryTurnPending: retry() sets it immediately before calling run(),
    // and clearing it here would erase the very label that call exists to apply.
    this.lastErrorCode = undefined;
    this.abort = new AbortController();
    const myGen = this.generation;
    // True only while this run is still the current one. reset() bumps the
    // generation, so a superseded run stops emitting into the new session.
    const current = () => myGen === this.generation;
    try {
      const result = await this.deps.loop({
        intent: input.intent,
        boardId: input.boardId,
        preferences: this.preferences,
        preSelectedBoard: this.preSelectedBoard,
        boardSelectionMode: this.boardSelectionMode,
        traceId: this.traceId,
        availableBoards: input.availableBoards,
        state: this.state,
        onEvent: (event: any) => { if (current()) this.postEvent(event); },
        // Safe-point hook (deliverables 07 §5, after phase_complete): drain queued
        // supplements, classify + surface each, and return absorb text for the loop to
        // fold into the next phase's context.
        onSafePoint: (phase: string, hasNextPhase: boolean) => (current() ? this.consumeSupplementsAtSafePoint(phase, hasNextPhase) : null),
        askUser: (question: string, options?: string[], optionsRequiringText?: string[], textPlaceholder?: string) => this.askUser(question, options, optionsRequiringText, textPlaceholder),
        confirmPlan: (plan: any) => this.confirmPlan(plan),
        confirmDeploy: () => this.confirmDeploy(),
        confirmComponents: (devices: any[]) => this.confirmComponents(devices),
        // Protocol path: the single rich approval gate (replaces the 4 above).
        confirmApproval: (card: any) => this.confirmApproval(card),
        recorder: this.recorder,
        signal: this.abort.signal,
      });
      if (current() && result.state) this.state = result.state;
      if (current()) {
        this.lastTerminal = result.terminal; // retained for the Save Version snapshot (#95)
        await this.writeArtifactsIfReady();
        await this.record({ type: "session_finished", terminal: result.terminal, state: result.state });
        this.deps.postMessage({ type: "session_done", terminal: result.terminal });
      }
      return result;
    } catch (error: any) {
      // undici buries the real network reason in error.cause; append it so the
      // telemetry shows "fetch failed (ECONNRESET)" instead of a dead end.
      const causeDetail = error?.cause?.code ?? error?.cause?.message;
      const base = error?.message ?? "session_error";
      const message = causeDetail && !String(base).includes(causeDetail) ? `${base} (${causeDetail})` : base;
      const result = { terminal: "session_error", error: message };
      if (current()) {
        // Guard EVERYTHING a live run accumulates/records, matching the success path (:264): a
        // reset()-SUPERSEDED run's late unwind must not push keyErrors, record session_error/
        // _finished, OR stamp lastTerminal into the NEXT session's log + snapshot. Stop (cancel())
        // keeps current() true, so the Stop-path error recording is unaffected.
        this.keyErrors.push(`session_error: ${message}`);
        await this.record({ type: "session_error", error: message });
        await this.record({ type: "session_finished", terminal: result.terminal });
        this.lastTerminal = result.terminal; // retained for the Save Version snapshot (#95)
        this.deps.postMessage({ type: "session_error", error: message });
        this.deps.postMessage({ type: "session_done", terminal: result.terminal });
      }
      return result;
    } finally {
      // A superseded run leaves prompts + abort to the run that replaced it (reset()
      // already cleared this run's prompts and reassigned abort).
      if (current()) {
        this.cancelPrompts();
        this.abort = null;
        // Deliver (or durably buffer) this session's tail — session_finished and any failed
        // posts — before the run resolves, instead of leaving them fire-and-forget. Guarded:
        // a flush failure (e.g. a JSONL write error propagating out of the recorder) must never
        // throw out of finally and mask the run's real result/error. The cloud tail is already
        // durable in the outbox and retries on next start; the cloud recorder logs its own errors.
        try {
          await this.flush();
        } catch {
          /* run-boundary telemetry flush is best-effort; never let it replace the run's outcome */
        }
      }
    }
  }

  // Stop the running session: hard-interrupt any in-flight device op (deliverables 07 §4),
  // abort the loop (between turns / in-flight request), and unblock any pending question.
  cancel() {
    this.deps.killDevice?.();
    this.abort?.abort();
    this.cancelPrompts();
  }

  // Start a fresh coding session: drop the accumulated conversation so the next
  // start() is a brand-new build, not a continuation. Without this, every message
  // continues the same conversation forever (state is only ever cleared on a board
  // switch), so an unrelated next project inherits the prior board, manifest,
  // skills, confirmed-gate flags, and the whole — ever-growing — message history.
  // Aborts any in-flight run first; an aborted run unwinds through start()'s catch,
  // which doesn't write state back, so clearing here is safe. The next start()
  // mints a new traceId + recorder, so the new build records under its own trace.
  reset() {
    // Supersede the in-flight run FIRST so its late unwinding messages are dropped,
    // then abort it and clear state. Null abort so the next start() is a fresh run
    // (not rejected as session_busy while the aborted run is still unwinding).
    this.generation++;
    // Tell the webview the reset happened and the new generation. It drains stamped
    // credits frames from the user's Restart click until this arrives; FIFO guarantees
    // this lands AFTER every old-generation frame (a superseded run can't post — the
    // onEvent current() guard) and BEFORE any new-generation frame (the next run starts
    // later), so the drain brackets exactly the in-flight stragglers.
    this.deps.postMessage({ type: "session_reset", generation: this.generation });
    this.cancel();
    this.abort = null;
    this.clearSessionState();
  }

  // Every per-session field, wiped on EVERY fresh-session entry: reset()/Restart above AND
  // seedFromSnapshot below (a restore is a fresh session — it must not inherit the run that
  // preceded it). Kept in ONE place so a newly added accumulator can't leak across sessions by
  // being cleared on only one path (the reset-not-start trap, #28): a snapshot written after a
  // restore must carry ONLY the restored session's data, never residue from the prior session.
  private clearSessionState() {
    this.state = undefined;
    this.boardId = null;
    this.traceId = null;
    this.recorder = undefined;
    this.recordedStart = false;
    this.preferences = undefined;
    this.preSelectedBoard = undefined;
    this.boardSelectionMode = undefined;
    this.latestManifest = undefined;
    this.hasAuthoredDiagram = false;
    this.latestFiles = {};
    this.persistedPaths = [];
    // Artifact accumulators (#28 F6): a fresh-session path sets boardId=null, so the next start()'s
    // board-change clear is skipped (same trap as boardSelectionMode). Clear them here or
    // a Restart/restore would surface the previous session's files with stale phase attribution.
    this.producedPaths = [];
    this.producedPhase.clear();
    this.phaseArtifacts = [];
    this.optionalNextPhases = [];
    this.driverReadyBlocks = [];
    this.latestGeneratePhaseComplete = undefined;
    this.lastPhaseComplete = undefined;
    this.currentPhase = null;
    this.recentActivity = [];
    this.stdoutTail = [];
    this.keyErrors = [];
    this.pendingSupplements = [];
    // Same trap as the artifact accumulators above: reset() nulls boardId, so the next
    // start()'s board-change clear never fires and a Restart would otherwise carry the
    // previous session's credit records — and its balance baseline — into the new one.
    this.clearCreditUsage();
    // Save Version accumulators: cleared on EVERY fresh-session path — here (covers reset/restart,
    // which also nulls boardId so start()'s board-change block is skipped, AND restore) AND in
    // that board-change block itself (covers a board switch with no reset). A leftover on either
    // path would leak the previous session's terminal/diagram/credits into the next snapshot.
    this.lastTerminal = null;
    this.latestDiagram = undefined;
    this.lastCredits = null;
  }

  // Wipe every credit-usage accumulator. Called from BOTH clear sites (board change and
  // reset) so no per-session credit state can bleed across sessions.
  private clearCreditUsage() {
    this.creditUsage = [];
    this.creditUsageDropped = 0;
    this.lastCreditBalance = null;
    this.turnStartedAt = null;
    this.retryCount = 0;
    this.ranWiring = false;
    this.ranDiagram = false;
    this.retryTurnPending = false;
    this.supplementTurnPending = false;
    this.lastErrorCode = undefined;
  }

  // The per-phase credit records this session, oldest first. Feeds the diagnostics snapshot
  // and the session-log export; read-only view of the accumulator.
  getCreditUsage(): readonly CreditUsageRecord[] {
    return this.creditUsage;
  }

  // The optional follow-on flows generate offered (empty until a generate offers them). The panel gates
  // the wiring/diagram entries on this.
  getOptionalNextPhases(): Array<{ phase?: string; reason?: string }> {
    return this.optionalNextPhases;
  }

  // The #53 driver-ready gate result from the latest generate (empty when clear). The panel threads it into
  // buildGenDriverDispatch as `blocked` and into materializeGenDriverTabs so detection/selection/dispatch agree.
  getDriverReadyBlocks(): DriverReadyBlockEntry[] {
    return this.driverReadyBlocks;
  }

  // The last phase_complete this run emitted ({phase, result, errors, network_permission}), or undefined.
  // A wiring/diagram excursion gates its post-run render on it (renders success/partial with a fresh doc;
  // skips a network-render denial — structured decision "deny" and/or a *_PERMISSION_DENIED error).
  getLastPhaseComplete(): { phase?: string; result?: string; errors?: unknown; network_permission?: unknown } | undefined {
    return this.lastPhaseComplete;
  }

  // The last generate phase_complete (or undefined). A wiring/diagram dispatch persists this to disk and
  // points source_phase_complete_path at it so the run can read the upstream generate result.
  getLatestGeneratePhaseComplete(): unknown {
    return this.latestGeneratePhaseComplete;
  }

  // A session run owns the serial port from run()'s start until its finally clears
  // `abort` (and reset() nulls it). Device tools gate on this so a user command never
  // competes with an in-flight run's device ops (flash/deploy today; gen-driver's
  // hardware phase once it runs through the session) on the same port (spec §41).
  // reset() nulls abort, so an idle controller reads as not running.
  isRunning(): boolean {
    return this.abort !== null;
  }

  // The phase that currently owns the device, for the device_busy message (null when
  // not running, or running before the first phase_complete sets it).
  runningPhase(): string | null {
    return this.currentPhase;
  }

  // Log a device-tool command to the session log (spec §41 "log artifacts").
  // Best-effort: record() no-ops when no session recorder exists, so a device tool
  // used before any session started still runs, just without a log line.
  recordDeviceTool(command: string, params: any, outcome: { ok: boolean; error?: string }) {
    return this.record({ type: "device_tool", command, params, ok: outcome.ok, error: outcome.error });
  }

  // Send a question to the webview and resolve when the user answers. Optional
  // options render as clickable choices; optionsRequiringText marks the ones that
  // need a typed value (a URL/number/path), so the webview holds that choice and
  // waits for the value instead of ending the turn on the click.
  askUser(question: string, options?: string[], optionsRequiringText?: string[], textPlaceholder?: string): Promise<string | null> {
    const promptId = `prompt-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, resolve);
      this.record({ type: "ui_prompt", promptId, question, options, optionsRequiringText, textPlaceholder });
      this.deps.postMessage({ type: "ui_prompt_needed", promptId, question, options, optionsRequiringText, textPlaceholder });
    });
  }

  // Build-plan gate: show the requirements + credit estimate and resolve the user's
  // choice. Reuses the pendingPrompts round-trip (webview replies via the same
  // ui_prompt_response with answer "confirm"/"cancel"/"revise"; revise carries
  // free-text feedback). A cancelled/finished session resolves to cancel.
  confirmPlan(plan: any): Promise<{ action: "confirm" | "cancel" | "revise"; feedback?: string }> {
    const promptId = `plan-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, (answer, extra) => resolve({
        action: answer === "confirm" ? "confirm" : answer === "revise" ? "revise" : "cancel",
        feedback: extra?.feedback,
      }));
      this.record({ type: "plan_proposed", promptId, plan });
      this.deps.postMessage({ type: "plan_needed", promptId, plan });
    });
  }

  // Deploy-readiness gate: show the wiring diagram (from the latest manifest) and
  // a board-connection check, then resolve true once the user confirms. Reuses the
  // pendingPrompts round-trip (webview replies via ui_prompt_response with
  // "confirm"/"cancel"); a cancelled/finished session resolves it false.
  confirmDeploy(): Promise<boolean> {
    const promptId = `deploy-${++this.promptSeq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingPrompts.set(promptId, (answer) => resolve(answer === "confirm"));
      this.record({ type: "deploy_proposed", promptId, manifest: this.latestManifest });
      this.deps.postMessage({ type: "deploy_needed", promptId, manifest: this.latestManifest });
    });
  }

  // Component-confirmation gate: show the proposed device list as a deterministic
  // multi-select card (host-owned, not an LLM-authored ask_user) and resolve the
  // user's kept device names + any free-text additions. Reuses the pendingPrompts
  // round-trip; the webview replies via ui_prompt_response with answer
  // "confirm"/"cancel" plus extra { devices, feedback }.
  confirmComponents(devices: any[]): Promise<{ action: "confirm" | "cancel"; devices?: string[]; feedback?: string }> {
    const promptId = `components-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, (answer, extra) => resolve({
        action: answer === "confirm" ? "confirm" : "cancel",
        devices: extra?.devices,
        feedback: extra?.feedback,
      }));
      this.record({ type: "components_proposed", promptId, devices });
      this.deps.postMessage({ type: "components_needed", promptId, devices });
    });
  }

  // Protocol approval gate: the single rich card (replaces ask/components/plan/
  // deploy). The webview renders approval_request.card and replies via the same
  // ui_prompt_response round-trip with answer=action + extra={selected_ids, ...}.
  // Resolves null when the session is cancelled/finished (cancelPrompts).
  confirmApproval(card: any): Promise<any> {
    const promptId = `approval-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, (answer, extra) => resolve(
        answer == null
          ? null
          : { action: answer, selected_ids: extra?.selected_ids ?? [], added_items: extra?.added_items ?? [], text_values: extra?.text_values ?? {}, notes: extra?.notes ?? "", serial_port: extra?.serial_port, baud: extra?.baud },
      ));
      this.record({ type: "approval_requested", promptId, card });
      this.deps.postMessage({ type: "approval_request", promptId, card });
    });
  }

  // Destructive-file gate (deliverables 07 §4): a HOST-initiated confirmation (not an LLM
  // ask), shown as an in-panel card with the file path + Overwrite/Delete vs Ignore. Reuses
  // the pendingPrompts round-trip, so the request (file_op_proposed) and the answer
  // (ui_prompt_answer) are both recorded in the session log — durable proof without catching
  // a toast. Resolves false (keep the file) on cancel/finish via cancelPrompts — the safe
  // default for a destructive action. Answer "proceed" = do it; anything else = keep the file.
  confirmFileOp(op: "overwrite" | "delete" | "device_delete", path: string): Promise<boolean> {
    const promptId = `file-${op}-${++this.promptSeq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingPrompts.set(promptId, (answer) => resolve(answer === "proceed"));
      this.record({ type: "file_op_proposed", promptId, op, path });
      this.deps.postMessage({ type: "file_op_confirm_needed", promptId, op, path });
    });
  }

  resolvePrompt(promptId: string, answer: string | null, extra?: any) {
    const resolve = this.pendingPrompts.get(promptId);
    if (resolve) {
      this.pendingPrompts.delete(promptId);
      // The approval card's edit payload (selected_ids/added_items/text_values) is the only
      // durable proof an in-product edit reached the backend — without it, no session log
      // can show whether an "add OLED" actually rode on the answer. `notes` is recorded too
      // (confirmApproval has unpacked extra.notes since before this change) though no live
      // webview control sets it today — it rides only if a future caller passes one. Each
      // field is added only when present so a plain ask_user/deploy answer keeps its existing
      // shape (no undefined-key noise for the telemetry mapper or the restore-path reader).
      const event: Record<string, any> = { type: "ui_prompt_answer", promptId, answer };
      if (extra?.selected_ids !== undefined) event.selected_ids = extra.selected_ids;
      if (extra?.added_items !== undefined) event.added_items = extra.added_items;
      if (extra?.text_values !== undefined) event.text_values = extra.text_values;
      if (extra?.notes !== undefined) event.notes = extra.notes;
      this.record(event);
      resolve(answer, extra);
    } else {
      // pendingPrompts is keyed by promptId and deleted on first resolve, so this
      // branch means a ui_prompt_response arrived for a prompt that's already been
      // resolved (or never existed) — a race the webview's own guards should
      // prevent, but a silent no-op here would hide it. Record it through the
      // session telemetry pipeline (JSONL + cloud, like every other event) so a
      // live session leaves a queryable trace, and warn locally for dev hosts.
      this.record({ type: "ui_prompt_answer_duplicate", promptId, answer });
      console.warn(`[mpyhw] resolvePrompt: promptId "${promptId}" already resolved (or unknown) — ignoring duplicate answer=${JSON.stringify(answer)}`);
    }
  }

  // Unblock any waiting prompts (session cancelled or finished) with a null answer.
  cancelPrompts() {
    for (const [promptId, resolve] of this.pendingPrompts.entries()) {
      this.record({ type: "ui_prompt_answer", promptId, answer: null });
      resolve(null);
    }
    this.pendingPrompts.clear();
  }

  // Intake (webview -> host): queue a user supplement raised during a running build. It
  // does NOT interrupt the current turn (deliverables 07 §2); it is consumed at the next
  // safe point. Emits the Activity `user_supplement_received` (§8).
  submitSupplement(text: string, attachments?: SupplementAttachment[]) {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return;
    const supplement: PendingSupplement = {
      text: trimmed,
      attachments: attachments ?? [],
      receivedPhase: this.currentPhase ?? "",
      receivedAt: new Date().toISOString(),
      status: "queued",
    };
    this.pendingSupplements.push(supplement);
    const event = { type: "user_supplement_received", phase: supplement.receivedPhase, status: "queued", summary: summarizeSupplement(trimmed), received_at: supplement.receivedAt };
    this.record(event);
    this.deps.postMessage(event);
  }

  // Safe-point consume (deliverables 07 §5, after phase_complete): classify every queued
  // supplement, surface each in Activity, and return the concatenated absorb text for the
  // loop to fold into the next phase's context. reroute/reconfirm are flag-and-surface for
  // P0 (status reroute_required, no auto-jump); absorb marks applied. When hasNextPhase is
  // false (the build is terminating) an absorb note has nowhere to fold, so it is surfaced
  // as deferred rather than falsely reported applied. Null when empty.
  private consumeSupplementsAtSafePoint(completedPhase: string, hasNextPhase: boolean = true): string | null {
    const queued = this.pendingSupplements.filter((s) => s.status === "queued");
    if (queued.length === 0) return null;
    const codeExists = Object.keys(this.latestFiles).length > 0 || this.persistedPaths.length > 0;
    const absorbed: string[] = [];
    for (const supplement of queued) {
      const route = classifySupplement(supplement.text, supplement.attachments);
      let decision: string = route.reconfirmIfCode && codeExists ? "reconfirm" : route.decision;
      let reason = route.reason;
      if (decision === "absorb" && hasNextPhase) {
        supplement.status = "applied";
        absorbed.push(supplement.text);
      } else if (decision === "absorb") {
        // No phase left to fold this note into — surface it honestly instead of reporting
        // it applied to a phase that never runs. Cleared on Restart; start a new build to use it.
        supplement.status = "discarded";
        decision = "deferred";
        reason = "The build finished before this note could be applied — start a new build to include it.";
      } else {
        supplement.status = "reroute_required";
      }
      this.emitSupplementApplied(route.target ?? this.currentPhase ?? completedPhase, decision, reason);
    }
    // An absorbed note is folded into the NEXT phase's context, so the turn that pays for it
    // is the next metered one — label that turn "supplement" rather than the phase it runs in.
    if (absorbed.length > 0) this.supplementTurnPending = true;
    return absorbed.length > 0 ? absorbed.join("\n") : null;
  }

  // Activity `user_supplement_applied` (deliverables 07 §8): record + forward to the feed.
  private emitSupplementApplied(phase: string, decision: string, reason: string) {
    const event = { type: "user_supplement_applied", phase, decision, reason };
    this.record(event);
    this.deps.postMessage(event);
  }

  postEvent(event: any) {
    if (event.type === "manifest_updated") {
      // Fill the Wiring tab deterministically from the devices[] the analyze/select-hw
      // phases already produce. Only when the manifest carries NO renderable wiring: a
      // shallow copy with derived { buses, standalone } (never mutate event.manifest —
      // protocol-loop holds the same reference for the next phase's prompt). Authored
      // wiring the webview can render (flat [{role,pin}] or { buses/standalone }) is
      // passed through verbatim; a non-renderable shape (e.g. a future plugin's
      // format->path map { json: "docs/wiring.json", ... }) is treated as absent so the
      // tab does not regress to empty. latestManifest carries the enriched copy so the
      // deploy checkpoint card shows the same wiring.
      const enriched = hasRenderableWiring(event.manifest?.wiring)
        ? event.manifest
        : { ...event.manifest, wiring: deriveWiring(event.manifest) };
      // A diagram run streams a thin manifest_content (no devices/pinout) that would blank the Wiring tab
      // and empty the gen-driver cold-driver picker. Don't regress a devices-bearing manifest to a
      // device-less one — keep the richer one (a wiring run's manifest carries devices, so it is unaffected).
      const incomingHasDevices = Array.isArray(event.manifest?.devices) && event.manifest.devices.length > 0;
      const currentHasDevices = Array.isArray((this.latestManifest as any)?.devices) && (this.latestManifest as any).devices.length > 0;
      const manifest = (!incomingHasDevices && currentHasDevices) ? this.latestManifest : enriched;
      this.latestManifest = manifest;
      this.record({ type: "artifact", kind: "manifest", manifest });
      this.deps.postMessage({ type: "manifest_updated", manifest });
      // Populate the Diagram tab from the same manifest, connecting the otherwise dead
      // diagram_updated wire (it has no other emitter). Emitted as a PLAIN postMessage,
      // not via this postEvent branch: the derived diagram is a UI-only view, so it must
      // not record() a kind:"diagram" artifact every phase boundary or trip the authored
      // guard. An authored diagram, once seen, always wins.
      if (!this.hasAuthoredDiagram) {
        this.deps.postMessage({ type: "diagram_updated", diagram: deriveDiagram(manifest) });
      }
      return;
    }
    if (event.type === "diagram_updated") {
      // The only place an authored (LLM/plugin) diagram arrives. Latch the guard so the
      // manifest chokepoint stops overwriting it with the derived view for this build.
      this.hasAuthoredDiagram = true;
      this.latestDiagram = event.diagram; // retained for the Save Version snapshot (#95)
      this.record({ type: "artifact", kind: "diagram", diagram: event.diagram });
      this.deps.postMessage({ type: "diagram_updated", diagram: event.diagram });
      return;
    }
    if (event.type === "code_delta") {
      // Live codegen tokens — forwarded straight to the activity feed's streaming
      // code card. Not recorded; the finished code is captured by code_updated.
      this.deps.postMessage({ type: "code_delta", text: event.text, path: event.path });
      return;
    }
    if (event.type === "code_updated") {
      this.latestFiles[event.path ?? "main.py"] = event.code;
      // path travels with the record too, not just the live post below — a view-only (no-snapshot)
      // restore replays this record verbatim (panel.ts's replaySessionTabs) and has no other way to
      // learn which file the code belongs to; without it every replayed card falls back to "main.py"
      // regardless of the real path.
      this.record({ type: "artifact", kind: "code", code: event.code, path: event.path });
      this.deps.postMessage({ type: "code_updated", code: event.code, path: event.path });
      return;
    }
    if (event.type === "file_written") {
      // The loop persisted a file to disk itself; track it so writeArtifactsIfReady
      // skips the redundant post-loop re-write and reports these paths instead.
      if (event.path && !this.persistedPaths.includes(event.path)) this.persistedPaths.push(event.path);
      // Stamp the producing phase now (currentPhase is the phase in flight), so the
      // Artifact Browser shows where each file came from, not the phase that ran last.
      if (event.path) this.producedPhase.set(event.path, this.currentPhase ?? "");
      return;
    }
    if (event.type === "serial_output") {
      this.record({ type: "serial_output", lines: event.lines });
      this.deps.postMessage({ type: "serial_output", lines: event.lines });
      this.pushStdout(event.lines);
      return;
    }
    // Protocol events: a status_update timeline entry, a phase boundary, or a
    // phase_complete result (with artifacts). Forwarded to the webview renderers.
    if (event.type === "status_update") {
      this.pushActivity(`status: ${event.payload?.message ?? event.payload?.status ?? "update"}`);
      this.record({ type: "status_update", payload: event.payload });
      this.deps.postMessage({ type: "status_update", payload: event.payload });
      return;
    }
    if (event.type === "phase_start") {
      this.currentPhase = event.phase;
      // Latch the optional flows this project actually needed (a complexity dimension).
      // Resolved through the alias table so "wiring" and "upy-wiring-plugin" both latch.
      const canonical = PHASE_ALIASES[String(event.phase ?? "").trim()] ?? event.phase;
      if (canonical === WIRING_PHASE) this.ranWiring = true;
      if (canonical === DIAGRAM_PHASE) this.ranDiagram = true;
      this.pushActivity(`phase_start: ${event.phase}`);
      this.record({ type: "phase_start", phase: event.phase });
      this.deps.postMessage({ type: "phase_start", phase: event.phase });
      return;
    }
    if (event.type === "phase_complete") {
      this.pushActivity(`phase_complete: ${event.payload?.phase ?? this.currentPhase ?? ""}`);
      this.capturePhaseArtifacts(event.payload);
      this.record({ type: "phase_complete", payload: event.payload });
      this.deps.postMessage({ type: "phase_complete", payload: event.payload });
      // The domain phase is at payload.phase per the sample contract, but the generate model can
      // drop the top-level phase and only set manifest_content.phase/domain_phase. Resolve from
      // either so the generate-keyed logic below fires on that degraded (but successful) shape too.
      const domainPhase = event.payload?.phase ?? event.payload?.manifest_content?.phase ?? event.payload?.manifest_content?.domain_phase;
      // Remember this run's terminal outcome so a startPhase excursion can gate its post-run render
      // on a real success (not a partial/denied run that still emitted a phase_complete).
      this.lastPhaseComplete = { phase: domainPhase, result: event.payload?.result, errors: event.payload?.errors ?? event.payload?.structured_errors, network_permission: event.payload?.network_permission };
      // A gen-driver run's phase_complete carries the UI driver status (payload.phase is the DOMAIN
      // token "gen-driver"). Surface it to the GenDriverPanel; deriveDriverStatus trusts the
      // authoritative driver_status when present and falls back to the result/verification heuristic.
      if (event.payload?.phase === GEN_DRIVER_DOMAIN_PHASE) {
        this.deps.postMessage({ type: "gen_driver_status", status: deriveDriverStatus(event.payload ?? {}), detail: event.payload?.summary });
        // A successful driver build resolves the gate; drop the stored block so a later unrelated standalone
        // gen-driver run isn't forced to pipeline by a stale result.
        if (event.payload?.result === "success") this.driverReadyBlocks = [];
      }
      // #53: a generate partial can carry a driver-ready block asking the user to build the driver
      // first. Surface the affected devices so the panel can OFFER the gen-driver run (never auto-start).
      // Store the block so the LATER gen-driver dispatch can force pipeline (an error-code-only block is not
      // re-derivable from the manifest alone). A clean generate completion clears it (register #9/#19).
      const driverBlocks = detectDriverReadyBlock(event.payload);
      if (driverBlocks.length > 0) {
        this.driverReadyBlocks = driverBlocks;
        this.deps.postMessage({ type: "gen_driver_required", blocks: driverBlocks });
      } else if (domainPhase === "generate") {
        this.driverReadyBlocks = [];
      }
      // A generate completion is the ONLY thing that sets the optional-flow offers and the stored generate
      // payload, and BOTH must gate on result === "success". Otherwise a later partial generate leaves an
      // earlier success's offers installed AND clobbers latestGeneratePhaseComplete with the partial, so the
      // host would permit wiring/diagram against an upstream the plugin must reject. So: clear offers on EVERY
      // generate completion, and only persist the payload + install offers on success (register #19/#9).
      if (domainPhase === "generate") {
        this.optionalNextPhases = [];
        if (event.payload?.result === "success") {
          // A formal wiring/diagram success reads the upstream generate result (source_phase_complete_path);
          // only a successful generate is a valid upstream. Keep the prior success on a partial (don't clobber).
          this.latestGeneratePhaseComplete = event.payload;
          // Upstream sanctions BOTH offer shapes: objects [{phase, reason}] and plain strings
          // ["upy-wiring-plugin"]. The generate SKILL requires emitting offers on success, but the model
          // sometimes drops them (which left the flows unreachable), so default to offering both. Normalize
          // to the object shape so the host gate + webview entries key on `.phase` either way (deliverables 04).
          const offered = event.payload?.optional_next_phases;
          this.optionalNextPhases = Array.isArray(offered) && offered.length
            ? offered.map((p: any) => (typeof p === "string" ? { phase: p } : p))
            : [{ phase: WIRING_PHASE }, { phase: DIAGRAM_PHASE }];
        }
        this.deps.postMessage({ type: "optional_flows", phases: this.optionalNextPhases });
      }
      return;
    }
    if (event.type === "credits") {
      // Live credit balance streamed by the backend after each turn. sse-client maps the
      // SSE `{ remaining, daily_grant, resets_at }` to `{ type: "credits", remaining,
      // dailyGrant, resetsAt }`; normalize it to the shape the quota bar and telemetry
      // both read — `{ kind: "credits", balance, ... }` — so the balance updates live
      // (and low/exhausted trip mid-build) instead of falling through to trace_event.
      // This event is the ONE place per-turn consumption arrives, so the record is stamped
      // HERE (at arrival, with the phase/manifest state that produced the turn) rather than
      // rebuilt later from a flushed session — by then currentPhase has already moved on.
      // Retain the last-seen balance for the Save Version snapshot (#95). Advisory only —
      // session restore re-fetches /v1/credits live because quota can't be restored as truth.
      this.lastCredits = { balance: event.remaining, dailyGrant: event.dailyGrant, resetsAt: event.resetsAt, capturedAt: new Date().toISOString() };
      const usage = this.accumulateCreditUsage(event);
      const normalized = { kind: "credits", balance: event.remaining, dailyGrant: event.dailyGrant, resetsAt: event.resetsAt, usage };
      // Its own JSONL line: the per-phase record the diagnostics export and the card's
      // "one end-to-end session log" evidence read. Local-only by design — the same numbers
      // reach the cloud on the enriched credits_charged event below, not as a second post.
      this.record({ type: "credit_usage", usage });
      this.record({ type: "session_event", event: normalized });
      // Stamp the run generation so the webview can drop a credits frame that was
      // already in flight when the user hit Restart. postEvent runs only under
      // current() (the onEvent guard), so this.generation is THIS run's generation.
      this.deps.postMessage({ type: "session_event", event: normalized, generation: this.generation });
      return;
    }
    if (event.type === "summary_delta") {
      // Live tokens of the model's reply — forwarded to the streaming summary card.
      // Not recorded; the finished reply is captured by the "summary" event below.
      this.deps.postMessage({ type: "summary_delta", text: event.text });
      return;
    }
    if (event.type === "summary_discard") {
      // The streamed prose belonged to a tool-calling turn (mid-process narration);
      // tell the webview to drop the in-progress summary card.
      this.deps.postMessage({ type: "summary_discard" });
      return;
    }
    if (event.type === "summary_seal") {
      // ask_user's lead-in prose: finalize the streamed card so it stays above the
      // question, instead of discarding it like other tool-turn narration. The text
      // already reached the webview via summary_delta; the durable transcript keeps
      // it on the assistant message in the history, so nothing to record here.
      this.deps.postMessage({ type: "summary_seal" });
      return;
    }
    if (event.type === "summary") {
      this.record({ type: "summary", text: event.text });
      this.deps.postMessage({ type: "summary", text: event.text });
      return;
    }
    if (event.type === "connect_retry") {
      // Forward only: the agent loop already recorded this via its own recorder,
      // so recording here again would double it in the telemetry.
      this.retryCount++;
      this.deps.postMessage({ type: "connect_retry", attempt: event.attempt, maxAttempts: event.maxAttempts });
      return;
    }
    if (event.type === "phase_stalled") {
      // A phase gave up (the model never emitted a tool, or the turn budget ran out).
      // Record + post it as itself so the cloud DB shows the stall and the webview can
      // render a stuck/retry state instead of a frozen step with no error.
      // `detail` is the loop's last few failing tool calls: tool names, script filenames and
      // error kinds. That is diagnosis material, so it goes to the support export (via
      // keyErrors -> getDiagnostics) and to the cloud record, and NOT to the webview — the
      // end user has no use for `script_run: invalid_generated_path (phase_complete_draft.json)`.
      const blockers = (event.detail ?? [])
        .map((f: any) => (f?.path ? `${f.tool}: ${f.error} (${f.path})` : `${f?.tool}: ${f?.error}`))
        .join(", ");
      this.keyErrors.push(`stalled: ${event.phase} (${event.reason})${blockers ? ` [${blockers}]` : ""}`);
      this.lastErrorCode = event.reason;
      this.record({ type: "phase_stalled", phase: event.phase, reason: event.reason, detail: event.detail });
      // Phase + reason only over the wire to the UI. The blockers stay out of the feed.
      this.deps.postMessage({ type: "phase_stalled", phase: event.phase, reason: event.reason });
      return;
    }
    if (event.type === "history_over_cap") {
      // The replayed conversation could not be brought under its cap; the request still went
      // out. Record-only: this is triage material for the non-retryable 400 it may cause a few
      // turns later, and the end user has nothing to do with "487,320 chars on turn 41". It
      // needs its own branch because the catch-all below wraps it as a trace_event, whose
      // mapper returns null for it -- the alarm would be counted as telemetry_dropped.
      this.record({ type: "history_over_cap", phase: event.phase, chars: event.chars, turn: event.turn });
      return;
    }
    if (event.type === "phase_error") {
      // The protocol hit an unrecoverable phase fault (today: the model asked to advance to a
      // phase outside PHASE_ALIASES) and ends the run "failed". Same treatment as phase_stalled:
      // without its own branch this falls to the generic trace_event below, which the webview
      // only renders when the event carries isError+text — phase_error carries neither, so the
      // reason vanished and the user saw a bare "Session ended: failed" with no cause.
      const detail = event.next_phase ? `${event.error_kind}: ${event.next_phase}` : String(event.error_kind);
      this.keyErrors.push(detail);
      this.lastErrorCode = event.error_kind;
      this.record({ type: "phase_error", error_kind: event.error_kind, next_phase: event.next_phase });
      this.deps.postMessage({ type: "phase_error", error_kind: event.error_kind, next_phase: event.next_phase });
      return;
    }
    if (event.type === "tool_use" || event.type === "tool_result") {
      // The protocol loop's per-tool spine, recorded as itself so sessionEventToTelemetry
      // maps it through its tool_use/tool_result cases (-> tool_dispatch / a compacted
      // result carrying any gate error codes). It needs its OWN branch for the same reason
      // phase_error above does: the catch-all wraps anything unhandled as a trace_event,
      // which is shaped by a DIFFERENT mapper reading `tool` instead of `name` and treating
      // the wrapper as the observation -- so tool_use was dropped outright and every
      // tool_result reached the DB as a bare { ok: true }.
      // Record-only: the webview arms its working spinner off trace_event, and the feed
      // already narrates progress through status_update + phase_start.
      this.record(event);
      return;
    }
    this.record({ type: "trace_event", event });
    this.deps.postMessage({ type: "trace_event", event });
  }

  private record(event: Record<string, any>) {
    return this.recorder?.record(event) ?? Promise.resolve();
  }

  // Build this turn's credit-usage record from the state that produced the turn, append it to
  // the session accumulator, and advance the per-turn baselines. Every value handed to
  // buildCreditUsage is a count, a boolean or a bare token — no prompt, file or path has a
  // field to travel in (see credit-usage.ts).
  private accumulateCreditUsage(event: any): CreditUsageRecord {
    const now = Date.now();
    const balance = typeof event.remaining === "number" ? event.remaining : undefined;
    // Best-effort consumption until the server sends its authoritative charge, valid ONLY when
    // the balance did not go UP: a daily refill or admin top-up (balance jumps e.g. 2 -> 50)
    // inverts the delta, and clamping that to 0 would misread a paid turn across the refill as
    // free. When the balance rose, this turn's cost is unknowable from the delta, so leave it
    // undefined — the rollup treats unknown as "no known cost", not as 0. A same-or-lower
    // balance is a real non-negative consumption (0 for a genuinely free turn).
    const consumed =
      this.lastCreditBalance !== null && balance !== undefined && balance <= this.lastCreditBalance
        ? this.lastCreditBalance - balance
        : undefined;
    const manifest: any = this.latestManifest;
    // Canonicalize the phase for the same reason the operation is canonicalized: "generate",
    // "upy-generate" and "upy-generate-plugin" are one phase, and an aggregate split three
    // ways by which token the model emitted answers no quota question.
    const rawPhase = (this.currentPhase ?? "").trim();
    const usage = buildCreditUsage({
      session_id: this.traceId ?? undefined,
      anon_id: this.deps.anonId,
      phase: rawPhase ? (PHASE_ALIASES[rawPhase] ?? rawPhase) : undefined,
      operation: deriveCreditOperation(this.currentPhase, PHASE_ALIASES, {
        retry: this.retryTurnPending,
        supplement: this.supplementTurnPending,
      }),
      device_count: Array.isArray(manifest?.devices) ? manifest.devices.length : undefined,
      // Phase-2 manifest field: undefined until the Skill writes manifest.bom.
      bom_count: Array.isArray(manifest?.bom) ? manifest.bom.length : undefined,
      generated_file_count: this.artifactIndex().length,
      code_line_count: this.codeLineCount(),
      wiring: this.ranWiring,
      diagram: this.ranDiagram,
      cold_driver: this.driverReadyBlocks.length > 0,
      retry_count: this.retryCount,
      duration_ms: this.turnStartedAt === null ? undefined : now - this.turnStartedAt,
      error_code: this.lastErrorCode,
      // The SAME balance the quota bar renders, off the SAME event — one source of truth, so
      // the recorded remaining quota can never disagree with what the user is looking at.
      remaining_quota: balance,
      credits_consumed: consumed,
      // Server-only fields, absent until the backend deploys the enriched credits event.
      // `charged` is authoritative where credits_consumed is a balance-delta estimate;
      // both are kept so a pre-enrichment session is still readable.
      charged: event.charged,
      model: event.model,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_hit_tokens: event.cacheHitTokens,
    });
    this.creditUsage.push(usage);
    if (this.creditUsage.length > SessionController.CREDIT_USAGE_CAP) {
      this.creditUsage.shift();
      this.creditUsageDropped++;
    }
    // Advance the baselines AFTER building, and only on a usable balance: a malformed event
    // must not reset the delta baseline, or the next turn's consumption would be wrong too.
    if (balance !== undefined) this.lastCreditBalance = balance;
    this.turnStartedAt = now;
    this.retryTurnPending = false;
    this.supplementTurnPending = false;
    this.lastErrorCode = undefined;
    return usage;
  }

  // Total lines across the code generated this run — a size dimension, never the code itself.
  private codeLineCount(): number {
    let lines = 0;
    for (const code of Object.values(this.latestFiles)) {
      if (typeof code === "string" && code.length > 0) lines += code.split("\n").length;
    }
    return lines;
  }

  // Append a short summary to the recent-activity ring, keeping only the newest N.
  private pushActivity(summary: string) {
    this.recentActivity.push(summary);
    if (this.recentActivity.length > SessionController.RECENT_ACTIVITY_CAP) {
      this.recentActivity.shift();
    }
  }

  // Append the device's serial-output lines to the bounded stdout tail (newest N kept).
  private pushStdout(lines: unknown) {
    for (const line of Array.isArray(lines) ? lines : [lines]) {
      this.stdoutTail.push(String(line));
    }
    while (this.stdoutTail.length > SessionController.STDOUT_TAIL_CAP) this.stdoutTail.shift();
  }

  // Support/diagnostics actions must be traceable (section 08 §6.3; §8.1 events
  // support_feedback_opened / support_diagnostics_exported). Record the event to the session log,
  // surface it in the recent-activity ring (shown in the diagnostics snapshot), and emit it. The
  // webview does NOT render these in the build feed (navigation, not build progress) — recording +
  // recent_activity is the §6.3 "recorded in Activity OR plugin logs" trace. Before a session
  // starts the recorder is undefined so the JSONL write is a no-op; recent_activity still captures it.
  recordSupportAction(event: { type: "support_feedback_opened" | "support_diagnostics_exported" } & Record<string, any>) {
    const detail = event.entry ?? event.scope ?? "";
    this.pushActivity(detail ? `${event.type}: ${detail}` : event.type);
    this.record(event);
    this.deps.postMessage(event);
  }

  // Artifact paths produced this session: the loop's own writes plus any accumulated
  // generated files, deduped. Empty before the first generate.
  private artifactIndex(): string[] {
    return [...new Set([...this.persistedPaths, ...Object.keys(this.latestFiles)])];
  }

  // Structured artifact descriptors for the Artifact Browser (spec §8.3): the paths the
  // loop persisted this session, typed by kind. The panel adds metadata (size/sha256/
  // created_at) + relative display paths via buildArtifactIndex, and owns opening. The
  // session log + diagnostics are appended by the panel, which knows their locations.
  artifactSources(): ArtifactSource[] {
    // Union of loop-persisted files (live, available mid-run) and the post-loop batch's
    // produced paths (headless fallback), deduped. Each carries the phase it was written
    // in (producedPhase), not the session's final phase.
    const out: ArtifactSource[] = [];
    const seen = new Set<string>();
    for (const absolute_path of [...this.persistedPaths, ...this.producedPaths]) {
      if (seen.has(absolute_path)) continue;
      seen.add(absolute_path);
      out.push({
        absolute_path,
        kind: classifyArtifactKind(absolute_path),
        phase: this.producedPhase.get(absolute_path) ?? "",
        origin: "session",
      });
    }
    return out;
  }

  // Fold a phase_complete's declared artifacts ({type, path}) into the browser source list.
  // First occurrence of a path wins, so a file keeps the phase that first produced it.
  private capturePhaseArtifacts(payload: any) {
    const artifacts = payload?.artifacts;
    if (!Array.isArray(artifacts)) return;
    const phase = payload?.phase ?? this.currentPhase ?? "";
    for (const a of artifacts) {
      if (!a || typeof a !== "object") continue;
      // Flat {type, path} entry (wiring/diagram and most phases).
      if (typeof a.path === "string" && a.path) {
        this.pushPhaseArtifact(a.path, a.type, phase);
        continue;
      }
      // gen-driver leads with a file_list whose paths nest at files[].path — fold those in.
      if (Array.isArray(a.files)) {
        for (const f of a.files) {
          if (f && typeof f.path === "string" && f.path) this.pushPhaseArtifact(f.path, f.type ?? a.type, phase);
        }
        continue;
      }
      // A path-less, file_list-less entry (e.g. diagram's type:"table") has nothing to open — skip it.
    }
  }

  private pushPhaseArtifact(path: string, type: unknown, phase: string) {
    if (this.phaseArtifacts.some((p) => p.path === path)) return;
    this.phaseArtifacts.push({ path, role: typeof type === "string" ? type : "", phase });
  }

  // Raw phase-declared artifact records ({relative path, role, phase}); the panel resolves
  // each path to an absolute file it can stat + index. Read-only view of the accumulator.
  phaseArtifactRecords(): ReadonlyArray<{ path: string; role: string; phase: string }> {
    return this.phaseArtifacts;
  }

  // The latest phase manifest this session (analyze/select-hw/scaffold), or undefined. The
  // gen-driver panel materializes its current-missing-driver picker from this; cleared in
  // reset() so a Restart never shows a prior session's cold-driver items.
  getLatestManifest(): unknown {
    return this.latestManifest;
  }

  // The bundle the Save Version snapshot builder needs from the controller (#95 A). Groups
  // the otherwise-private state/board/preferences/phase fields + the three new accumulators
  // into one read-only view, so the panel builds a snapshot without reaching into internals.
  getSnapshotState(): {
    state: { manifest?: unknown; phase?: string; intent?: string } | undefined;
    boardId: string | null;
    preSelectedBoard: unknown;
    boardSelectionMode: string | undefined;
    preferences: { mode?: string; locale?: string; existing_hardware?: string } | undefined;
    currentPhase: string | null;
    traceId: string | null;
    terminal: string | null;
    diagram: unknown;
    optionalNextPhases: Array<{ phase?: string; reason?: string }>;
    generatePhaseComplete: unknown;
    credits: { balance?: number; dailyGrant?: number; resetsAt?: string; capturedAt?: string } | null;
  } {
    return {
      state: this.state,
      boardId: this.boardId,
      preSelectedBoard: this.preSelectedBoard,
      boardSelectionMode: this.boardSelectionMode,
      preferences: this.preferences,
      currentPhase: this.currentPhase,
      traceId: this.traceId,
      terminal: this.lastTerminal,
      diagram: this.latestDiagram,
      optionalNextPhases: this.optionalNextPhases,
      generatePhaseComplete: this.latestGeneratePhaseComplete,
      credits: this.lastCredits,
    };
  }

  // Restore session state from a saved snapshot WITHOUT running — so an imported/recent session has the
  // board, preferences, resume state (manifest/phase/intent) and current phase the saved session had, and
  // a later retry() or save() operates on it. Refuses while a run is active (a live run owns this state).
  // The webview tabs (wiring/diagram/code/artifacts) are rehydrated separately by the panel; this is the
  // controller-side half. Wipes ALL prior-session state first (a restore is a fresh session — it must not
  // inherit the session that ran before it, or a later Save Version would write a chimera snapshot into the
  // WRONG session's dir).
  //
  // A resumable (snapshot-having) restore passes traceId = the RESTORED session's id, so a post-restore
  // Save Version targets that session's own dir and a subsequent start()/startPhase() records into its own
  // transcript (they mint the appending recorder; retry() reuses whatever recorder exists). A READ-ONLY
  // (no-snapshot) restore must do the OPPOSITE — omit traceId entirely, leaving it null — or the next
  // start() (which only mints a fresh id `if (!this.traceId)`) would silently append that NEXT build's
  // events into the VIEWED session's transcript instead of starting its own. traceId is the one field this
  // function's two callers deliberately disagree on; every other field behaves the same for both.
  seedFromSnapshot(seed: {
    traceId?: string | null;
    state?: { manifest?: unknown; phase?: string; intent?: string };
    boardId?: string | null;
    preSelectedBoard?: unknown;
    boardSelectionMode?: string;
    preferences?: { mode?: string; locale?: string; existing_hardware?: string };
    currentPhase?: string | null;
    terminal?: string | null;
    manifest?: unknown;
    diagram?: unknown;
    optionalNextPhases?: Array<{ phase?: string; reason?: string }>;
    generatePhaseComplete?: unknown;
  }): boolean {
    if (this.abort) return false; // a run owns the state — never clobber a live session
    this.clearSessionState(); // start from a clean session — no residue from a prior run/restore (#28)
    this.state = seed.state;
    this.boardId = seed.boardId ?? null;
    this.traceId = seed.traceId || null;
    this.preSelectedBoard = seed.preSelectedBoard;
    this.boardSelectionMode = seed.boardSelectionMode;
    this.preferences = seed.preferences;
    this.currentPhase = seed.currentPhase ?? null;
    this.lastTerminal = seed.terminal ?? null; // so a re-save carries the restored terminal, not null
    if (seed.manifest !== undefined) this.latestManifest = seed.manifest;
    if (seed.diagram !== undefined) {
      this.latestDiagram = seed.diagram;
      // Re-latch the authored-diagram guard: a restored authored diagram wins, same as live. Without this a
      // post-restore wiring/diagram run streams a manifest_updated that would clobber it with the derived view.
      this.hasAuthoredDiagram = true;
    }
    // Restore the optional-flow offers + the upstream generate result they run against, so a restored
    // session can re-run wiring/diagram (the host gate reads getOptionalNextPhases + the wrapped upstream).
    if (Array.isArray(seed.optionalNextPhases)) this.optionalNextPhases = seed.optionalNextPhases;
    if (seed.generatePhaseComplete !== undefined) this.latestGeneratePhaseComplete = seed.generatePhaseComplete;
    return true;
  }

  // Whether this session has any restorable state to snapshot (drives the sv_nothing branch).
  hasSnapshotState(): boolean {
    return this.state !== undefined || this.latestManifest !== undefined || this.boardId !== null;
  }

  // The session-scoped half of the section-08 diagnostics snapshot. The panel merges
  // this with the always-available host fields (versions, os/node/npm, python) and
  // fills every declared key so a bug report carries an actionable, complete picture.
  getDiagnostics(): Record<string, string> {
    const board = this.preSelectedBoard;
    const selectedBoard = board?.display_name ?? board?.id ?? (this.boardId && this.boardId !== "auto" ? this.boardId : "");
    return {
      session_id: this.traceId ?? "",
      current_phase: this.currentPhase ?? "",
      recent_activity: this.recentActivity.join("; "),
      key_errors: this.keyErrors.join("; "),
      artifact_index: this.artifactIndex().join(", "),
      selected_board: selectedBoard,
      last_command: this.recentActivity.at(-1) ?? "",
      // serial_port is filled by the panel's host bag (shim.getPort) — see collectDiagnostics.
      // Keep the NEWEST STDOUT_SUMMARY_MAX chars (slice(-n)), not the oldest: for a crash
      // diagnostic the traceback/error is at the end, and slice(0, n) would drop exactly that.
      stdout_stderr_summary: this.stdoutTail.join(" | ").slice(-SessionController.STDOUT_SUMMARY_MAX),
      // Per-phase cost and the balance left after each phase, from the SAME records the
      // JSONL log and the Activity line carry — one source of truth for every surface.
      credit_usage: formatCreditUsage(this.creditUsage, this.creditUsageDropped),
    };
  }

  private async writeArtifactsIfReady() {
    // The loop already persisted every file to disk (write_project_file +
    // generate_code). Report what was written; no second write, no manifest dup
    // (project-manifest.json is among the persisted paths, so there is no stray
    // manifest.json). This is the path the real extension always takes.
    if (this.persistedPaths.length > 0) {
      this.producedPaths = [...this.persistedPaths];
      await this.record({ type: "files_written", paths: this.persistedPaths });
      this.deps.postMessage({ type: "files_written", paths: this.persistedPaths });
      return;
    }
    // Headless fallback (no loop-time writer, e.g. tests): the post-loop batch is
    // the only writer, so write the accumulated code files + the manifest.
    if (!this.deps.writeFiles || Object.keys(this.latestFiles).length === 0 || !this.latestManifest) return;
    const result = await this.deps.writeFiles({
      ...this.latestFiles,
      "manifest.json": JSON.stringify(this.latestManifest, null, 2),
    });
    if (result?.ok === false) {
      this.keyErrors.push(`write_failed: ${result.error_kind ?? "write_failed"}`);
      await this.record({ type: "files_write_failed", error: result.error_kind ?? "write_failed" });
      this.deps.postMessage({ type: "files_write_failed", error: result.error_kind ?? "write_failed" });
      return;
    }
    const paths = result?.paths ?? [];
    this.producedPaths = paths;
    await this.record({ type: "files_written", paths });
    this.deps.postMessage({ type: "files_written", paths });
  }
}

// Whether a manifest.wiring is a shape the webview buildComponents can render into
// cards. Whitelist (NOT mere presence) so a future plugin's non-renderable wiring —
// e.g. a format->path map { json: "docs/wiring.json", md: ... } — is treated as absent
// and the derived { buses, standalone } fills the tab instead of leaving it empty.
// buildComponents renders THREE shapes: a legacy flat [{ role, pin }] array, the
// { buses[], standalone[] } device-identity object, and the legacy bus-keyed
// { i2c: { sda, scl, devices } } object. The latter two are objects carrying a nested
// value; the path map has only string values, so it stays non-renderable and is derived
// over. Missing a shape here regresses the tab to empty the moment such a manifest lands.
function hasRenderableWiring(wiring: any): boolean {
  if (Array.isArray(wiring)) return wiring.length > 0;
  if (!wiring || typeof wiring !== "object") return false;
  return Object.values(wiring).some((v) => v != null && typeof v === "object");
}

function createTraceId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `session-${Date.now().toString(36)}-${random}`;
}

// A short, single-line summary of a supplement for the Activity `received` event (§8).
const SUPPLEMENT_SUMMARY_MAX = 80;
function summarizeSupplement(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUPPLEMENT_SUMMARY_MAX ? `${oneLine.slice(0, SUPPLEMENT_SUMMARY_MAX - 1)}…` : oneLine;
}
