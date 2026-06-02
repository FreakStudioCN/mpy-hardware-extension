export class ShimProcess {
  nextId = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  transport: { write: (line: string) => void; onEvent?: (event: any) => void };
  private buffer = "";

  constructor(transport: { write: (line: string) => void; onEvent?: (event: any) => void }) {
    this.transport = transport;
  }

  request(method: string, params: any, timeoutMs = 30_000) {
    const id = this.nextId++;
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject } as { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("shim_request_timeout"));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
  }

  // Accumulate raw stdout chunks and dispatch each complete newline-delimited
  // line. Chunks arrive on arbitrary byte boundaries (a line can be split across
  // reads, or several lines can land in one chunk), so buffer until a newline.
  // Non-JSON noise on stdout is swallowed so it can't kill the reader.
  feed(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) {
        try {
          this.handleStdoutLine(line);
        } catch {
          // ignore non-JSON noise on stdout
        }
      }
    }
  }

  handleStdoutLine(line: string) {
    const message = JSON.parse(line);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "shim_error"));
    } else {
      pending.resolve(message.result);
    }
  }

  handleStderr(message: string) {
    this.transport.onEvent?.({ type: "stderr", message });
  }

  handleExit(code: number) {
    this.transport.onEvent?.({ type: "shim_crash", code });
    const error = new Error(`shim exited with code ${code}`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
