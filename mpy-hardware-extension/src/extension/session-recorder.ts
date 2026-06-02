import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SessionRecorder = {
  record(event: Record<string, any>): Promise<void>;
};

export class JsonlSessionRecorder implements SessionRecorder {
  private seq = 0;
  private pending = Promise.resolve();
  private readonly filePath: string;
  private readonly traceId: string;

  constructor(input: { workspaceFolder: string; traceId: string }) {
    this.traceId = input.traceId;
    const safeTraceId = input.traceId.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    this.filePath = join(input.workspaceFolder, ".mpyhw", "sessions", safeTraceId, "session.jsonl");
  }

  async record(event: Record<string, any>) {
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({
        ...event,
        seq: ++this.seq,
        ts: new Date().toISOString(),
        traceId: this.traceId,
      });
      await appendFile(this.filePath, `${line}\n`, "utf-8");
    });
    return this.pending;
  }
}
