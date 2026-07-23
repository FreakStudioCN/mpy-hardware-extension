import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
    this.filePath = join(sessionsDir(input.workspaceFolder), safeTraceId, "session.jsonl");
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
  restorable: boolean; // true when a checkpoints/snapshot.json exists — a pre-Save-Version session is view-only
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
  } catch (err: any) {
    // A dir without session.jsonl is a crashed/partial session — skip it (backfilled by the
    // caller). Any other read error (EACCES, ...) must surface, or the export would silently
    // fall back to an OLDER session while claiming the newest.
    if (err?.code === "ENOENT") return null;
    throw err;
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
    restorable: existsSync(join(sessionsRoot, id, "checkpoints", "snapshot.json")),
  };
}

// Rank real session dir names newest-first without opening any of them. The trace id
// JsonlSessionRecorder writes is `session-<base36 creation ms>-<rand>` (createTraceId) —
// a base36-ms segment then a random segment — so an end-anchored shape match drops
// foreign entries (.DS_Store, a legacy "trace-*" id that would otherwise sort ahead of
// "session-*"), and a descending string compare (not localeCompare, so it's a
// deterministic code-point sort) is recency order. The second segment is [0-9a-z]* (may
// be empty) because Math.random().toString(36).slice(2,10) is empty when random()===0, so
// a real id can be `session-<ts>-`. (base36 timestamps are equal-width — and thus
// lexicographically ordered — until the 9-digit rollover in 2059.)
export function selectRecentSessionIds(ids: string[]): string[] {
  return ids
    .filter((id) => /^session-[0-9a-z]+-[0-9a-z]*$/.test(id))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// List past sessions (newest first) written under <workspaceFolder>/.mpyhw/sessions
// by JsonlSessionRecorder. Read-only: reads each session.jsonl for a summary, never
// mutates. Returns [] when no sessions dir exists yet.
//
// Opens only as many sessions as it takes to collect `limit` valid summaries, reading
// newest-first in batches of `limit`: the common case (dirs are valid) reads exactly one
// batch, and a rare crashed/empty dir (dir created, session.jsonl never written) is
// skipped and backfilled from the next batch rather than shrinking the list. Bounded by
// the number of session dirs, so cost is not proportional to the whole history.
//
// Recency by dir name is a proxy for recency by first-event ts: createTraceId mints the
// name and the first event is recorded within ~ms in the same start(), so the two orders
// agree except sub-millisecond — which cannot cross the `limit` batch boundary. Reading
// every session's ts to guarantee a globally exact top-`limit` would defeat the bound;
// the read summaries are still re-sorted by real ts for display.
// The directory JsonlSessionRecorder writes session.jsonl trees under. Single source of
// truth for the path so the recorder, the recent-sessions list, and the log-export /
// reveal actions all agree.
export function sessionsDir(workspaceFolder: string): string {
  return join(workspaceFolder, ".mpyhw", "sessions");
}

export async function listRecentSessions(workspaceFolder: string, limit: number): Promise<RecentSession[]> {
  if (limit <= 0) return [];
  const sessionsRoot = sessionsDir(workspaceFolder);
  let ids: string[];
  try {
    ids = await readdir(sessionsRoot);
  } catch (err: any) {
    if (err?.code === "ENOENT") return []; // sessions dir not created yet — legitimately empty
    throw err; // a real error (EACCES, etc.) must surface, not masquerade as "no sessions"
  }
  const ranked = selectRecentSessionIds(ids);
  const sessions: RecentSession[] = [];
  for (let i = 0; i < ranked.length && sessions.length < limit; i += limit) {
    const batch = ranked.slice(i, i + limit);
    const summaries = await Promise.all(batch.map((id) => readSessionSummary(sessionsRoot, id)));
    for (const s of summaries) if (s !== null) sessions.push(s);
  }
  // Order by real first-event ts (the dir-name sort is only a recency proxy for capping;
  // the actual event ts is authoritative for display order), then cap to the limit.
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  return sessions.slice(0, limit);
}
