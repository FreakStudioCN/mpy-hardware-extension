export class SessionController {
  deps: {
    postMessage: (message: any) => void;
    confirmTool: (tool: any) => Promise<boolean>;
    loop: (input: any) => Promise<any>;
  };

  // Pending ask_user prompts: promptId -> resolve fn. The loop awaits askUser();
  // the webview answers via a ui_prompt_response message routed to resolvePrompt.
  private pendingPrompts = new Map<string, (answer: string | null) => void>();
  private promptSeq = 0;
  private abort: AbortController | null = null;

  constructor(deps: { postMessage: (message: any) => void; confirmTool: (tool: any) => Promise<boolean>; loop: (input: any) => Promise<any> }) {
    this.deps = deps;
  }

  async start(input: { intent: string; boardId: string; availableBoards?: any[] }) {
    this.abort = new AbortController();
    try {
      const result = await this.deps.loop({
        intent: input.intent,
        boardId: input.boardId,
        availableBoards: input.availableBoards,
        onEvent: (event: any) => this.postEvent(event),
        confirmTool: async (tool: any) => {
          if (["install_package", "write_main_py", "flash_and_run"].includes(tool.name)) {
            return this.deps.confirmTool(tool);
          }
          return true;
        },
        askUser: (question: string) => this.askUser(question),
        signal: this.abort.signal,
      });
      this.deps.postMessage({ type: "session_done", terminal: result.terminal });
      return result;
    } catch (error: any) {
      const message = error?.message ?? "session_error";
      const result = { terminal: "session_error", error: message };
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

  // Send a question to the webview and resolve when the user answers.
  askUser(question: string): Promise<string | null> {
    const promptId = `prompt-${++this.promptSeq}`;
    return new Promise((resolve) => {
      this.pendingPrompts.set(promptId, resolve);
      this.deps.postMessage({ type: "ui_prompt_needed", promptId, question });
    });
  }

  resolvePrompt(promptId: string, answer: string | null) {
    const resolve = this.pendingPrompts.get(promptId);
    if (resolve) {
      this.pendingPrompts.delete(promptId);
      resolve(answer);
    }
  }

  // Unblock any waiting prompts (session cancelled or finished) with a null answer.
  cancelPrompts() {
    for (const resolve of this.pendingPrompts.values()) resolve(null);
    this.pendingPrompts.clear();
  }

  postEvent(event: any) {
    if (event.type === "manifest_updated") {
      this.deps.postMessage({ type: "manifest_updated", manifest: event.manifest });
      return;
    }
    if (event.type === "code_updated") {
      this.deps.postMessage({ type: "code_updated", code: event.code });
      return;
    }
    if (event.type === "serial_output") {
      this.deps.postMessage({ type: "serial_output", lines: event.lines });
      return;
    }
    if (event.kind === "quota") {
      this.deps.postMessage({ type: "session_event", event });
      return;
    }
    this.deps.postMessage({ type: "trace_event", event });
  }
}
