// Host-scoped telemetry: things observed OUTSIDE a build session — uncaught extension-host
// faults and sessions a previous host crashed mid-run. Reuses the same cloud+outbox delivery
// as the session path (session-recorder.ts); the sender is built once in activate().
import { hostname } from "node:os";
import { join } from "node:path";

import type { ClientMeta } from "../core/telemetry.ts";
import { CloudTelemetryRecorder, JsonlSessionRecorder, listRecentSessions, type RecentSession, type SessionRecorder } from "./session-recorder.ts";
import { isProcessAlive } from "./telemetry-outbox.ts";

export type HostTelemetryDeps = {
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  getAuthToken?: () => Promise<string | undefined>;
  log?: (message: string) => void;
  clientMeta?: ClientMeta;
  sessionRoot?: string; // enables the durable outbox + the abandoned-session scan
  extensionPath?: string; // to tell OUR uncaught errors from another extension's
  isTelemetryEnabled?: () => boolean; // live consent probe; absent means "no host to ask"
};

function outboxFor(sessionRoot?: string): string | undefined {
  return sessionRoot ? join(sessionRoot, ".mpyhw", "telemetry-outbox.jsonl") : undefined;
}

function cloudRecorder(deps: HostTelemetryDeps, traceId: string): CloudTelemetryRecorder {
  return new CloudTelemetryRecorder({
    traceId,
    apiBaseUrl: deps.apiBaseUrl,
    fetchImpl: deps.fetchImpl,
    getAuthToken: deps.getAuthToken,
    log: deps.log,
    clientMeta: deps.clientMeta,
    outboxPath: outboxFor(deps.sessionRoot),
    isTelemetryEnabled: deps.isTelemetryEnabled,
  });
}

// Whether an uncaught error's stack points at THIS extension. Only then do we claim it as our
// own fault (extension_error); otherwise it's a process-wide fault we merely observed.
export function isOwnError(stack: string | undefined, extensionPath: string | undefined): boolean {
  return !!(extensionPath && stack && stack.includes(extensionPath));
}

// Build the telemetry event for an uncaught fault. Message and stack are attached ONLY when the
// fault is OURS: the extension host is a shared Node process, so uncaughtException/rejection also
// fires for OTHER extensions, whose error text/stack can carry their tokens, source, or user
// paths — never upload that to our service. A foreign fault yields a content-free
// extension_host_error_observed so host instability around our sessions is still countable.
export function buildFaultEvent(error: unknown, origin: string, extensionPath: string | undefined): Record<string, any> {
  const stack = error instanceof Error ? error.stack : undefined;
  if (isOwnError(stack, extensionPath)) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "extension_error", message, stack, origin };
  }
  return { type: "extension_host_error_observed", origin };
}

// An unfinished session is only ABANDONED if nothing is still writing it. Two windows on one
// workspace are two extension hosts sharing one sessions dir, so without this check the second
// window reports the first window's in-progress build as a crash. The first JSONL line stamps
// the recording host; a live owner on THIS machine means the session is alive. An owner on
// another machine (a synced workspace) can't be probed — leave it alone rather than mislabel a
// live build. No stamp at all is a session written before the stamp existed: sweep it, as before.
export function isAbandonedSession(session: RecentSession): boolean {
  if (!session.owner) return true;
  if (session.owner.host !== hostname()) return false;
  return !isProcessAlive(session.owner.pid);
}

// Report sessions with a session_started but no session_finished — a crashed/killed host.
// Appending session_abandoned to that session's JSONL flips its finalPhase non-empty
// (readSessionSummary treats it as terminal), so the NEXT activation won't re-report it —
// a marker-via-own-log with no extra bookkeeping file. Returns the swept trace ids.
export async function sweepAbandonedSessions(deps: HostTelemetryDeps, limit = 20): Promise<string[]> {
  if (!deps.sessionRoot) return [];
  // Consent off: skip the sweep entirely rather than run it and find nothing delivered. The
  // local marker is ONE-SHOT — writing it now would make these crashes invisible to every
  // later sweep, including one run after the user opts back in.
  if (deps.isTelemetryEnabled && !deps.isTelemetryEnabled()) return [];
  let recent: Awaited<ReturnType<typeof listRecentSessions>>;
  try {
    recent = await listRecentSessions(deps.sessionRoot, limit);
  } catch (error) {
    deps.log?.(`[telemetry] abandoned-session sweep failed: ${String(error)}`);
    return [];
  }
  const swept: string[] = [];
  for (const session of recent) {
    if (session.finalPhase !== "") continue; // finished/terminal — not abandoned
    if (!isAbandonedSession(session)) continue; // a live host is still recording it
    try {
      // Cloud FIRST, local marker second. The marker is one-shot — it makes this session
      // invisible to every later sweep — so it must not be spent on a report that was neither
      // delivered nor buffered; that would lose the crash silently. A permanent rejection is a
      // deliberate drop (the server refused it) and does not hold the marker back.
      const cloud = cloudRecorder(deps, session.id);
      // `terminal` on the raw event is what readSessionSummary reads for the marker; the cloud
      // mapper (mapSessionEvent) re-derives "abandoned" for the DB independently.
      const event = { type: "session_abandoned", terminal: "abandoned" };
      await cloud.record(event);
      await cloud.flush();
      if (cloud.hasUndelivered()) {
        deps.log?.(`[telemetry] abandoned-session ${session.id} not delivered — leaving it for the next sweep`);
        continue;
      }
      const local: SessionRecorder = new JsonlSessionRecorder({ workspaceFolder: deps.sessionRoot, traceId: session.id });
      await local.record(event);
      await local.flush?.();
      swept.push(session.id);
    } catch (error) {
      // One unwritable/undeliverable session must neither abort the sweep of the others nor
      // reject this promise: the caller runs it fire-and-forget, so a rejection would surface
      // as an unhandledRejection that the host error handler then re-observes as a fault.
      deps.log?.(`[telemetry] abandoned-session ${session.id} sweep failed: ${String(error)}`);
    }
  }
  return swept;
}

// Observe process-wide faults WITHOUT changing the host's crash behavior. uncaughtExceptionMonitor
// (not uncaughtException) fires but never suppresses the default crash. unhandledRejection has no
// monitor variant, and on Node >= 15 the default IS fatal — a listener suppresses it. That is safe
// here and only here: the VS Code extension host installs its own uncaughtException and
// unhandledRejection listeners during startup, before any extension activates, so the default is
// already replaced by the time we add ours; we are an additional observer, not the one deciding
// the process's fate. We never exit, swallow, or throw from here. Returns a disposer.
export function installHostErrorHandlers(deps: HostTelemetryDeps): () => void {
  let seq = 0;
  const emit = (error: unknown, origin: string) => {
    try {
      const event = buildFaultEvent(error, origin, deps.extensionPath);
      const recorder = cloudRecorder(deps, `host-${event.type}-${++seq}`);
      // Fire-and-forget, but an unhandled rejection from either would be re-observed by our
      // own unhandledRejection handler → emit() again → an infinite loop. Swallow both.
      void recorder.record(event).catch(() => {});
      void recorder.flush().catch(() => {});
    } catch {
      /* a telemetry failure must never worsen a crash we are only observing */
    }
  };
  const onException = (error: unknown) => emit(error, "uncaughtException");
  const onRejection = (reason: unknown) => emit(reason, "unhandledRejection");
  process.on("uncaughtExceptionMonitor", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtExceptionMonitor", onException);
    process.off("unhandledRejection", onRejection);
  };
}
