import type { SessionRecorder } from "./session-recorder.ts";

export class SessionController {
  deps: {
    postMessage: (message: any) => void;
    loop: (input: any) => Promise<any>;
    recorderFactory?: (traceId: string) => SessionRecorder;
    writeFiles?: (files: Record<string, string>) => Promise<any>;
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
  // Board list from the last start(), reused by retry() so the continued loop
  // resolves "auto" the same way the original run did.
  private availableBoards: any[] | undefined;
  private traceId: string | null = null;
  private recorder: SessionRecorder | undefined;
  private recordedStart = false;
  private latestManifest: any = undefined;
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

  constructor(deps: { postMessage: (message: any) => void; loop: (input: any) => Promise<any>; recorderFactory?: (traceId: string) => SessionRecorder; writeFiles?: (files: Record<string, string>) => Promise<any> }) {
    this.deps = deps;
  }

  async start(input: { intent: string; boardId: string; availableBoards?: any[]; preSelectedBoard?: any; preferences?: { mode?: string; locale?: string; existing_hardware?: string } }) {
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
    }
    this.boardId = input.boardId;
    if (input.preSelectedBoard !== undefined) this.preSelectedBoard = input.preSelectedBoard;
    if (input.preferences) this.preferences = input.preferences;
    if (!this.traceId) {
      this.traceId = createTraceId();
    }
    if (!this.recorder && this.deps.recorderFactory) {
      this.recorder = this.deps.recorderFactory(this.traceId);
    }
    if (!this.recordedStart) {
      this.recordedStart = true;
      this.record({ type: "session_started", intent: input.intent, boardId: input.boardId, availableBoards: input.availableBoards ?? [] });
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
    return this.run({ intent: "", boardId: this.boardId ?? "auto", availableBoards: this.availableBoards });
  }

  private async run(input: { intent: string; boardId: string; availableBoards?: any[] }) {
    this.latestManifest = undefined;
    this.latestFiles = {};
    this.persistedPaths = [];
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
        traceId: this.traceId,
        availableBoards: input.availableBoards,
        state: this.state,
        onEvent: (event: any) => { if (current()) this.postEvent(event); },
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
      await this.record({ type: "session_error", error: message });
      await this.record({ type: "session_finished", terminal: result.terminal });
      if (current()) {
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
      }
    }
  }

  // Stop the running session: abort the loop (between turns / in-flight request)
  // and unblock any pending question.
  cancel() {
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
    this.cancel();
    this.abort = null;
    this.state = undefined;
    this.boardId = null;
    this.traceId = null;
    this.recorder = undefined;
    this.recordedStart = false;
    this.preferences = undefined;
    this.preSelectedBoard = undefined;
    this.latestManifest = undefined;
    this.latestFiles = {};
    this.persistedPaths = [];
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
          : { action: answer, selected_ids: extra?.selected_ids ?? [], added_items: extra?.added_items ?? [], text_values: extra?.text_values ?? {}, notes: extra?.notes ?? "" },
      ));
      this.record({ type: "approval_requested", promptId, card });
      this.deps.postMessage({ type: "approval_request", promptId, card });
    });
  }

  resolvePrompt(promptId: string, answer: string | null, extra?: any) {
    const resolve = this.pendingPrompts.get(promptId);
    if (resolve) {
      this.pendingPrompts.delete(promptId);
      this.record({ type: "ui_prompt_answer", promptId, answer });
      resolve(answer, extra);
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

  postEvent(event: any) {
    if (event.type === "manifest_updated") {
      this.latestManifest = event.manifest;
      this.record({ type: "artifact", kind: "manifest", manifest: event.manifest });
      this.deps.postMessage({ type: "manifest_updated", manifest: event.manifest });
      return;
    }
    if (event.type === "diagram_updated") {
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
      this.record({ type: "artifact", kind: "code", code: event.code });
      this.deps.postMessage({ type: "code_updated", code: event.code, path: event.path });
      return;
    }
    if (event.type === "file_written") {
      // The loop persisted a file to disk itself; track it so writeArtifactsIfReady
      // skips the redundant post-loop re-write and reports these paths instead.
      if (event.path && !this.persistedPaths.includes(event.path)) this.persistedPaths.push(event.path);
      return;
    }
    if (event.type === "serial_output") {
      this.record({ type: "serial_output", lines: event.lines });
      this.deps.postMessage({ type: "serial_output", lines: event.lines });
      return;
    }
    // Protocol events: a status_update timeline entry, a phase boundary, or a
    // phase_complete result (with artifacts). Forwarded to the webview renderers.
    if (event.type === "status_update") {
      this.record({ type: "status_update", payload: event.payload });
      this.deps.postMessage({ type: "status_update", payload: event.payload });
      return;
    }
    if (event.type === "phase_start") {
      this.record({ type: "phase_start", phase: event.phase });
      this.deps.postMessage({ type: "phase_start", phase: event.phase });
      return;
    }
    if (event.type === "phase_complete") {
      this.record({ type: "phase_complete", payload: event.payload });
      this.deps.postMessage({ type: "phase_complete", payload: event.payload });
      return;
    }
    if (event.kind === "credits") {
      this.record({ type: "session_event", event });
      this.deps.postMessage({ type: "session_event", event });
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
      this.deps.postMessage({ type: "connect_retry", attempt: event.attempt, maxAttempts: event.maxAttempts });
      return;
    }
    if (event.type === "phase_stalled") {
      // A phase gave up (the model never emitted a tool, or the turn budget ran out).
      // Record + post it as itself so the cloud DB shows the stall and the webview can
      // render a stuck/retry state instead of a frozen step with no error.
      this.record({ type: "phase_stalled", phase: event.phase, reason: event.reason });
      this.deps.postMessage({ type: "phase_stalled", phase: event.phase, reason: event.reason });
      return;
    }
    this.record({ type: "trace_event", event });
    this.deps.postMessage({ type: "trace_event", event });
  }

  private record(event: Record<string, any>) {
    return this.recorder?.record(event) ?? Promise.resolve();
  }

  private async writeArtifactsIfReady() {
    // The loop already persisted every file to disk (write_project_file +
    // generate_code). Report what was written; no second write, no manifest dup
    // (project-manifest.json is among the persisted paths, so there is no stray
    // manifest.json). This is the path the real extension always takes.
    if (this.persistedPaths.length > 0) {
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
      await this.record({ type: "files_write_failed", error: result.error_kind ?? "write_failed" });
      this.deps.postMessage({ type: "files_write_failed", error: result.error_kind ?? "write_failed" });
      return;
    }
    const paths = result?.paths ?? [];
    await this.record({ type: "files_written", paths });
    this.deps.postMessage({ type: "files_written", paths });
  }
}

function createTraceId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `session-${Date.now().toString(36)}-${random}`;
}
