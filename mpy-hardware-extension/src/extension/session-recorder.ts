import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sessionEventToTelemetry } from "../core/telemetry.ts";

export type SessionRecorder = {
  record(event: Record<string, any>): Promise<void>;
};

export class CompositeSessionRecorder implements SessionRecorder {
  private readonly recorders: SessionRecorder[];

  constructor(recorders: SessionRecorder[]) {
    this.recorders = recorders;
  }

  async record(event: Record<string, any>) {
    await Promise.all(this.recorders.map((recorder) => recorder.record(event)));
  }
}

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

export class CloudTelemetryRecorder implements SessionRecorder {
  private pending = Promise.resolve();
  private readonly traceId: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken?: () => Promise<string | undefined>;
  private readonly log?: (message: string) => void;

  constructor(input: { traceId: string; apiBaseUrl: string; fetchImpl: typeof fetch; getAuthToken?: () => Promise<string | undefined>; log?: (message: string) => void }) {
    this.traceId = input.traceId;
    this.apiBaseUrl = input.apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = input.fetchImpl;
    this.getAuthToken = input.getAuthToken;
    this.log = input.log;
  }

  record(event: Record<string, any>) {
    const telemetry = sessionEventToTelemetry(this.traceId, event);
    if (!telemetry) return Promise.resolve();
    this.pending = this.pending
      .then(() => this.post(telemetry))
      .catch((error) => {
        this.log?.(`[telemetry] ${formatError(error)}`);
      });
    return Promise.resolve();
  }

  async flush() {
    await this.pending;
  }

  private async post(event: Record<string, any>) {
    const token = this.getAuthToken ? await this.getAuthToken() : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1/telemetry`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [event] }),
    });
    if (!response.ok) throw new Error(`telemetry_post_failed:${response.status}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A read-only summary of a past session, for the "View Recent Sessions" launch entry.
export type RecentSession = {
  id: string;
  date: string; // ISO timestamp of the first event
  intent: string;
  finalPhase: string; // session_finished terminal/state, or "" if still open/crashed
  path: string; // absolute path to the session.jsonl
};

function parseLine(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null; // partial/truncated line — skip
  }
}

// Build one RecentSession from a session dir, or null if its jsonl is empty/unreadable.
async function readSessionSummary(sessionsRoot: string, id: string): Promise<RecentSession | null> {
  const path = join(sessionsRoot, id, "session.jsonl");
  let events: Array<Record<string, any>>;
  try {
    const text = await readFile(path, "utf-8");
    events = text.split("\n").map(parseLine).filter((e): e is Record<string, any> => e !== null);
  } catch {
    return null; // no jsonl in this dir
  }
  if (events.length === 0) return null;
  const started = events.find((e) => e.type === "session_started" || e.type === "user_message");
  const finished = [...events].reverse().find((e) => e.type === "session_finished");
  return {
    id,
    date: events[0].ts ?? "",
    intent: started?.intent ?? "",
    finalPhase: finished?.terminal ?? finished?.state ?? "",
    path,
  };
}

// List past sessions (newest first) written under <workspaceFolder>/.mpyhw/sessions
// by JsonlSessionRecorder. Read-only: reads each session.jsonl for a summary, never
// mutates. Returns [] when no sessions dir exists yet.
export async function listRecentSessions(workspaceFolder: string, limit: number): Promise<RecentSession[]> {
  const sessionsRoot = join(workspaceFolder, ".mpyhw", "sessions");
  let ids: string[];
  try {
    ids = await readdir(sessionsRoot);
  } catch {
    return []; // sessions dir not created yet
  }
  const summaries = await Promise.all(ids.map((id) => readSessionSummary(sessionsRoot, id)));
  const sessions = summaries.filter((s): s is RecentSession => s !== null);
  // Newest first by ISO date (lexicographic on the timestamp); the list is displayed
  // ordered, so a sort is the right tool, then cap to the requested count.
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  return sessions.slice(0, limit);
}
