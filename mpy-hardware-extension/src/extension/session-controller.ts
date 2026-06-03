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
  private state: any = undefined;
  private boardId: string | null = null;
  private traceId: string | null = null;
  private recorder: SessionRecorder | undefined;
  private recordedStart = false;
  private latestManifest: any = undefined;
  // Generated files accumulated by path across generate_code calls. A single-file
  // project leaves this as { "main.py": ... }; a multi-file project collects each
  // target_path the agent generates. Written to the workspace alongside manifest.json.
  private latestFiles: Record<string, string> = {};

  constructor(deps: { postMessage: (message: any) => void; loop: (input: any) => Promise<any>; recorderFactory?: (traceId: string) => SessionRecorder; writeFiles?: (files: Record<string, string>) => Promise<any> }) {
    this.deps = deps;
  }

  async start(input: { intent: string; boardId: string; availableBoards?: any[] }) {
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
    }
    this.boardId = input.boardId;
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
    this.latestManifest = undefined;
    this.latestFiles = {};
    this.abort = new AbortController();
    try {
      const result = await this.deps.loop({
        intent: input.intent,
        boardId: input.boardId,
        traceId: this.traceId,
        availableBoards: input.availableBoards,
        state: this.state,
        onEvent: (event: any) => this.postEvent(event),
        askUser: (question: string, options?: string[]) => this.askUser(question, options),
        confirmPlan: (plan: any) => this.confirmPlan(plan),
        confirmDeploy: () => this.confirmDeploy(),
        recorder: this.recorder,
        signal: this.abort.signal,
      });
      if (result.state) this.state = result.state;
      await this.writeArtifactsIfReady();
      await this.record({ type: "session_finished", terminal: result.terminal, state: result.state });
      this.deps.postMessage({ type: "session_done", terminal: result.terminal });
      return result;
    } catch (error: any) {
      const message = error?.message ?? "session_error";
      const result = { terminal: "session_error", error: message };
      await this.record({ type: "session_error", error: message });
      await this.record({ type: "session_finished", terminal: result.terminal });
      this.deps.postMessage({ type: "session_error", error: message });
      this.deps.postMessage({ type: "session_done", terminal: result.terminal });
      return result;
    } finally {
      this.cancelPrompts();
      this.abort = null;
    }
  }

  // Stop the running session: abort the loop (between turns / in-flight request)
  // and unblock any pending question.
  cancel() {
    this.abort?.abort();
    this.cancelPrompts();
  }

  // Send a question to the webview and resolve when the user answers. Optional
  // options render as clickable choices in the conversation.
  askUser(question: string, options?: string[]): Promise<string | null> {
    const promptId = `prompt-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, resolve);
      this.record({ type: "ui_prompt", promptId, question, options });
      this.deps.postMessage({ type: "ui_prompt_needed", promptId, question, options });
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
    if (event.type === "serial_output") {
      this.record({ type: "serial_output", lines: event.lines });
      this.deps.postMessage({ type: "serial_output", lines: event.lines });
      return;
    }
    if (event.kind === "credits") {
      this.record({ type: "session_event", event });
      this.deps.postMessage({ type: "session_event", event });
      return;
    }
    if (event.type === "summary") {
      this.record({ type: "summary", text: event.text });
      this.deps.postMessage({ type: "summary", text: event.text });
      return;
    }
    this.record({ type: "trace_event", event });
    this.deps.postMessage({ type: "trace_event", event });
  }

  private record(event: Record<string, any>) {
    return this.recorder?.record(event) ?? Promise.resolve();
  }

  private async writeArtifactsIfReady() {
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
