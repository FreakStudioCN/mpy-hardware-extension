// The durable half of telemetry delivery: an event whose POST failed transiently is buffered
// in a JSONL file and replayed on the next session start / flush (session-recorder.ts).
//
// Cross-process safety is the whole design constraint. Two VS Code windows on one workspace are
// two extension-host PROCESSES sharing this file, so an in-process lock cannot order them. A
// drain therefore never reads-then-rewrites the shared path: an append landing between the read
// and the rewrite would be erased — silent LOSS, the one failure the outbox exists to prevent.
// Instead a drain CLAIMS the file with a single atomic rename and works on its private copy;
// concurrent appends land on a fresh shared file that nobody is about to overwrite. A claim
// abandoned by a killed host is adopted by the next drain, so a crash costs at worst a
// re-delivered event (the accepted duplicate — there is no server-side dedup key), never a lost one.
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// One POST is already bounded (15s auth + 15s fetch), so a single hung event can burn 30s. Cap
// the whole drain too: flush() is awaited in run()'s finally and in deactivate(), and a long
// backlog must hold neither open. Checked before each post, so the true worst case is this
// budget plus one in-flight event.
const DRAIN_BUDGET_MS = 30_000;

// Hard ceiling on the buffered file: a long outage must not turn optional telemetry into a disk
// problem. At the ceiling the NEW event is dropped rather than the oldest evicted — eviction
// means rewriting the shared file, which is exactly the cross-process race the claim protocol
// exists to avoid.
const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;

// A claim whose owning process is gone was abandoned mid-drain and is adopted by the next drain.
// Age is the fallback probe for the cases a pid cannot answer: a pid reused by an unrelated
// process, or a claim written by a different machine sharing the workspace.
const STALE_CLAIM_MS = 10 * 60_000;

let claimSeq = 0;

export class TelemetryOutbox {
  private readonly path: string;
  private readonly log?: (message: string) => void;
  private readonly maxBytes: number;
  private readonly drainBudgetMs: number;

  // maxBytes/drainBudgetMs are overridable so both bounds are testable without writing
  // megabytes or waiting out a 30s budget.
  constructor(input: { path: string; log?: (message: string) => void; maxBytes?: number; drainBudgetMs?: number }) {
    this.path = input.path;
    this.log = input.log;
    this.maxBytes = input.maxBytes ?? MAX_OUTBOX_BYTES;
    this.drainBudgetMs = input.drainBudgetMs ?? DRAIN_BUDGET_MS;
  }

  // Buffer one event. Returns false when the ceiling drops it — the caller must treat that as
  // "not durable" rather than as a successful hand-off.
  async append(event: Record<string, any>): Promise<boolean> {
    return withOutboxLock(this.path, async () => {
      if (await fileSize(this.path) >= this.maxBytes) {
        this.log?.(`[telemetry] outbox at its ${this.maxBytes}-byte ceiling — dropping event`);
        return false;
      }
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf-8");
      return true;
    });
  }

  // Re-POST everything buffered, oldest-first, stopping at the first still-transient failure
  // (the network is likely still down) or at the drain budget; the remainder is kept.
  async drain(post: (event: Record<string, any>) => Promise<void>): Promise<void> {
    await withOutboxLock(this.path, () => this.drainLocked(post));
  }

  private async drainLocked(post: (event: Record<string, any>) => Promise<void>) {
    const deadline = Date.now() + this.drainBudgetMs;
    for (const file of await this.claimFiles()) {
      let lines: string[];
      try {
        lines = (await readFile(file, "utf-8")).split("\n").filter((line) => line.trim() !== "");
      } catch (error) {
        // Leave the claim in place: a later drain adopts it. Removing it here would discard
        // events over a transient read error.
        this.log?.(`[telemetry] unreadable outbox claim ${basename(file)}: ${formatError(error)}`);
        continue;
      }
      let remainder = lines;
      try {
        remainder = await this.postLines(lines, post, deadline);
      } catch (error) {
        // Unexpected: keep everything rather than let a bug eat the queue.
        this.log?.(`[telemetry] outbox drain aborted: ${formatError(error)}`);
      }
      // Put back BEFORE dropping the claim: a crash in between re-delivers, the other order loses.
      // The remainder lands after anything appended since the claim, so a partially-drained queue
      // loses its ordering — harmless, every event carries its own timestamp.
      await this.putBack(remainder);
      await rm(file, { force: true });
    }
  }

  private async postLines(lines: string[], post: (event: Record<string, any>) => Promise<void>, deadline: number): Promise<string[]> {
    for (let i = 0; i < lines.length; i++) {
      if (Date.now() >= deadline) {
        this.log?.(`[telemetry] outbox drain budget spent — ${lines.length - i} event(s) kept for the next drain`);
        return lines.slice(i);
      }
      let event: Record<string, any>;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        this.log?.("[telemetry] dropping a corrupt outbox line");
        continue;
      }
      try {
        await post(event);
      } catch (error) {
        if (isTransient(error)) return lines.slice(i); // still down — keep this one and the rest
        this.log?.(`[telemetry] dropping un-postable buffered event: ${formatError(error)}`);
      }
    }
    return [];
  }

  private async putBack(lines: string[]) {
    if (lines.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${lines.join("\n")}\n`, "utf-8");
  }

  // This drain's working set: claims abandoned by earlier drains, plus the live outbox renamed
  // out from under any concurrent appender.
  private async claimFiles(): Promise<string[]> {
    const files = await this.abandonedClaims();
    const mine = `${this.path}.${process.pid}-${++claimSeq}.claim`;
    try {
      await rename(this.path, mine);
      files.push(mine);
    } catch (error: any) {
      // ENOENT: nothing buffered. Anything else (EPERM/EBUSY — Windows, another process holding
      // the file open for an append) means "not this round"; the events stay put for the next one.
      if (error?.code !== "ENOENT") this.log?.(`[telemetry] outbox claim failed: ${formatError(error)}`);
    }
    return files;
  }

  private async abandonedClaims(): Promise<string[]> {
    const dir = dirname(this.path);
    const prefix = `${basename(this.path)}.`;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return []; // no outbox dir yet — nothing was ever buffered
    }
    const claims: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".claim")) continue;
      const file = join(dir, entry);
      const owner = Number.parseInt(entry.slice(prefix.length), 10);
      // Our own leftovers are always safe to adopt: withOutboxLock guarantees no other drain in
      // THIS process is holding one. A live foreign owner is mid-drain — leave it alone, taking
      // it would duplicate its events; if it is merely wedged, the age check picks it up later.
      if (owner !== process.pid && isProcessAlive(owner) && !(await olderThan(file, STALE_CLAIM_MS))) continue;
      claims.push(file);
    }
    return claims;
  }
}

// Existence probe: signal 0 sends nothing. EPERM means the pid EXISTS but belongs to another
// user, which still answers the question. (The VS Code extension host probes its parent the
// same way.) Used here for abandoned claims, and by the abandoned-session sweep.
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function olderThan(file: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs > ms;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0; // not created yet
  }
}

// Serialize every read/append/rewrite of a given outbox file through one chain. The outbox is
// shared across recorder instances (session + host-error + abandoned-sweep), but each instance
// only serializes its own `pending`. Keyed by path, so unrelated outboxes never block each other.
// Process-local by nature — ordering ACROSS extension hosts is what the claim protocol handles.
const outboxLocks = new Map<string, Promise<unknown>>();
function withOutboxLock<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = outboxLocks.get(path) ?? Promise.resolve();
  const result = prev.then(op, op); // run op once prev settles, either way
  outboxLocks.set(path, result.then(() => undefined, () => undefined));
  return result;
}

// A failure worth retrying: a network error (no response, so no `status`) or an overload/
// server fault (5xx / 429 / 408). Any other 4xx is a permanent contract rejection.
export function isTransient(error: any): boolean {
  const status = error?.status;
  if (status === undefined || status === null) return true;
  return status >= 500 || status === 429 || status === 408;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
