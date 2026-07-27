import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import type { ClientMeta } from "../core/telemetry.ts";
import { sessionEventToTelemetry } from "../core/telemetry.ts";
import { TelemetryOutbox, formatError, isTransient } from "./telemetry-outbox.ts";

export type SessionRecorder = {
  record(event: Record<string, any>): Promise<void>;
  // Await any buffered/in-flight delivery. Optional: only the cloud recorder has a durable
  // outbox; the JSONL recorder implements it as "await my write chain".
  flush?(): Promise<void>;
};

export class CompositeSessionRecorder implements SessionRecorder {
  private readonly recorders: SessionRecorder[];

  constructor(recorders: SessionRecorder[]) {
    this.recorders = recorders;
  }

  async record(event: Record<string, any>) {
    await Promise.all(this.recorders.map((recorder) => recorder.record(event)));
  }

  async flush() {
    await Promise.all(this.recorders.map((recorder) => recorder.flush?.()));
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
      const seq = ++this.seq;
      // The first line this recorder writes also claims the session for this extension host.
      // The abandoned-session sweep needs to know WHICH process is recording, or a second
      // window on the same workspace reports the first window's live build as a crash. File
      // ownership, not per-event data — hence only the first line, and local-only (the
      // telemetry mapper whitelists payload fields, so pid/host are never uploaded).
      const owner = seq === 1 ? { pid: process.pid, host: hostname() } : {};
      const line = JSON.stringify({
        ...event,
        seq,
        ts: new Date().toISOString(),
        traceId: this.traceId,
        ...owner,
      });
      await appendFile(this.filePath, `${line}\n`, "utf-8");
    });
    return this.pending;
  }

  async flush() {
    await this.pending;
  }
}

export class CloudTelemetryRecorder implements SessionRecorder {
  private pending = Promise.resolve();
  private readonly traceId: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken?: () => Promise<string | undefined>;
  private readonly log?: (message: string) => void;
  private readonly clientMeta?: ClientMeta;
  private readonly outbox?: TelemetryOutbox;
  // The user's telemetry consent, read LIVE on every event (not captured once at
  // construction) so revoking consent mid-session stops the very next post. Absent means
  // "no host to ask" — headless and test callers keep today's behavior.
  private readonly isTelemetryEnabled?: () => boolean;
  // Set when an event was neither delivered nor durably buffered — it is gone. Read by the
  // abandoned-session sweep, which must not burn its one-shot local marker on a lost report.
  private undelivered = false;
  // Per-type histogram of events that mapSessionEvent dropped (returned null for). Many
  // types are local-only by design; a NEW controller type someone forgot to map shows up
  // here as an unexpected key. Emitted as one telemetry_dropped on flush.
  private readonly dropped: Record<string, number> = {};

  constructor(input: { traceId: string; apiBaseUrl: string; fetchImpl: typeof fetch; getAuthToken?: () => Promise<string | undefined>; log?: (message: string) => void; clientMeta?: ClientMeta; outboxPath?: string; isTelemetryEnabled?: () => boolean }) {
    this.traceId = input.traceId;
    this.apiBaseUrl = input.apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = input.fetchImpl;
    this.getAuthToken = input.getAuthToken;
    this.log = input.log;
    this.clientMeta = input.clientMeta;
    this.isTelemetryEnabled = input.isTelemetryEnabled;
    this.outbox = input.outboxPath ? new TelemetryOutbox({ path: input.outboxPath, log: input.log }) : undefined;
    // Replay whatever a prior session failed to deliver, oldest-first — the primary retry
    // trigger (next session start), no timer. On the pending chain so it can't interleave
    // with this session's posts. Best-effort: a drain failure must not break recording.
    this.pending = this.pending.then(() => this.drainOutbox()).catch((error) => this.log?.(`[telemetry] outbox drain: ${formatError(error)}`));
  }

  // Whether anything may leave the machine right now. Gated at the HOST — the one place
  // every cloud path (session record, host faults, the abandoned sweep, the outbox drain)
  // funnels through — rather than in the webview, which cannot enforce anything.
  private consented(): boolean {
    return this.isTelemetryEnabled ? this.isTelemetryEnabled() : true;
  }

  record(event: Record<string, any>) {
    // Consent off: nothing is posted AND nothing is buffered for a later post — an event
    // durably queued now would be delivered the moment consent flipped back on. The local
    // JSONL recorder is untouched: local diagnostics are the user's own data.
    if (!this.consented()) return Promise.resolve();
    const telemetry = sessionEventToTelemetry(this.traceId, event, this.clientMeta);
    if (!telemetry) {
      const key = String(event?.type ?? "unknown");
      this.dropped[key] = (this.dropped[key] ?? 0) + 1;
      return Promise.resolve();
    }
    this.pending = this.pending
      .then(() => this.post(telemetry))
      .catch((error) => this.onPostFailure(telemetry, error));
    return Promise.resolve();
  }

  // Snapshot of dropped-event counts, for local inspection / tests.
  getDroppedCounts(): Record<string, number> {
    return { ...this.dropped };
  }

  // True once an event was lost outright (transient failure, and the outbox could not take it).
  // A caller whose retry depends on NOT writing a local "already reported" marker checks this.
  hasUndelivered(): boolean {
    return this.undelivered;
  }

  // Enqueue a single telemetry_dropped histogram (if any), then await the in-flight chain
  // and re-attempt anything still buffered. Called on session end and on deactivate so the
  // tail of a session actually delivers (or durably buffers).
  async flush() {
    this.emitDropped();
    await this.pending;
    // A drain failure (a filesystem error, not a post) must never reject flush(): flush is
    // awaited in run()'s finally, and a throw there would reject the whole run. Log and move on.
    try {
      await this.drainOutbox();
    } catch (error) {
      this.log?.(`[telemetry] outbox drain on flush: ${formatError(error)}`);
    }
  }

  private emitDropped() {
    const keys = Object.keys(this.dropped);
    if (keys.length === 0) return;
    const snapshot = { ...this.dropped };
    for (const key of keys) delete this.dropped[key];
    // Goes through record() → maps to a real event → posts (and buffers on failure like
    // any other). telemetry_dropped itself maps non-null, so it can't recount itself.
    this.record({ type: "telemetry_dropped", dropped: snapshot });
  }

  private async onPostFailure(event: Record<string, any>, error: unknown) {
    // Only transient failures (network / 5xx / 429 / 408) are worth retaining; a permanent
    // 4xx (unknown event_type, too-large) would loop the outbox forever, so log + drop.
    if (isTransient(error)) {
      let buffered = false;
      try {
        buffered = this.outbox ? await this.outbox.append(event) : false;
      } catch (writeError) {
        error = writeError;
      }
      if (buffered) return;
      this.undelivered = true; // retryable, yet nothing durable holds it — this event is lost
    }
    this.log?.(`[telemetry] ${formatError(error)}`);
  }

  private async post(event: Record<string, any>) {
    // The token fetch does its own un-timed network POST (github-auth getToken), so bound it
    // too — a hung token exchange would stall post() -> flush() -> run()'s finally, exactly the
    // hang the fetch timeout below prevents. A timeout rejects with no `status`, so isTransient()
    // buffers the event for a later retry rather than losing it.
    const token = this.getAuthToken ? await withTimeout(this.getAuthToken(), POST_TIMEOUT_MS) : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    // Bounded: a backend that accepts the socket but never responds must not hang the
    // pending chain forever — that would stall flush(), and via run()'s finally, the whole
    // run. A timeout rejects with no `status`, so isTransient() buffers it for later retry.
    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1/telemetry`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error: any = new Error(`telemetry_post_failed:${response.status}`);
      error.status = response.status; // read by isTransient — a 4xx must not be re-buffered
      throw error;
    }
  }

  private async drainOutbox() {
    // A backlog buffered while consent was ON must not be replayed after it is revoked.
    // The events stay on disk (they are the user's own local file) and drain if consent
    // returns; nothing is sent in the meantime.
    if (!this.consented()) return;
    await this.outbox?.drain((event) => this.post(event));
  }
}

// Cap a single telemetry POST so a hung backend can't stall the pending chain (and thus
// flush(), and via run()'s finally, the run itself).
const POST_TIMEOUT_MS = 15_000;

// Bound an await that carries no AbortSignal of its own (the auth-token exchange inside
// getAuthToken does an un-timed network POST). On timeout, reject with no `status` so
// isTransient() treats it as retryable and the event is buffered, not lost. The underlying
// promise is left to settle on its own (harmless) — we just stop waiting on it.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("telemetry_timeout")), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// A read-only summary of a past session, for the "View Recent Sessions" launch entry.
export type RecentSession = {
  id: string;
  date: string; // ISO timestamp of the first event
  intent: string;
  finalPhase: string; // session_finished terminal/state, or "" if still open/crashed
  path: string; // absolute path to the session.jsonl
  // The extension host that recorded it, stamped on the first line. Absent for a session
  // written before the stamp existed. Lets the abandoned-session sweep tell "the host died
  // mid-build" from "another window is building right now".
  owner?: { pid: number; host: string };
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
  // session_abandoned counts as terminal too: the abandoned-session sweep appends one to
  // flip finalPhase non-empty, so a crashed session is reported once and not re-swept.
  const finished = [...events].reverse().find((e) => e.type === "session_finished" || e.type === "session_abandoned");
  // The FIRST stamped line is the recording host; later lines can carry another host's stamp
  // (the sweep appends its marker through a recorder of its own).
  const stamped = events.find((e) => typeof e.pid === "number");
  return {
    id,
    date: events[0].ts ?? "",
    intent: started?.intent ?? "",
    finalPhase: finished?.terminal ?? finished?.state ?? "",
    path,
    owner: stamped ? { pid: stamped.pid, host: String(stamped.host ?? "") } : undefined,
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
// The one place the session-dir-name shape is defined. Reused by the restore path as a
// containment guard before an id from the webview is joined into a filesystem path (#11:
// a value joined into a path needs its own guard even when a sibling field already has one).
export function isSessionId(id: string): boolean {
  return /^session-[0-9a-z]+-[0-9a-z]*$/.test(id);
}

export function selectRecentSessionIds(ids: string[]): string[] {
  return ids
    .filter(isSessionId)
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
