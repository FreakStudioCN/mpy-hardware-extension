// Session-independent product telemetry for the welcome page.
//
// The welcome page renders BEFORE any Blockless workflow session exists, so its entry
// clicks cannot ride the session recorder (CloudTelemetryRecorder is trace_id-bound and
// minted per session). They post here instead: an anonymous, session-independent product
// event to /v1/web/events (the same channel the website home uses). Fire-and-forget — a
// telemetry failure must never block or delay the click, so the request is not awaited and
// its promise (including a non-2xx or a rejected fetch) is swallowed internally.
import { EXTENSION_VERSION } from "../core/toolchain-version.ts";

// Payload constants. `surface`/`source` are fixed strings, not derived from any webview
// input — the payload must stay non-sensitive (no paths, prompt text, source, or log
// content), so only these host-constants plus one boolean ever ride it.
const WELCOME_SURFACE = "welcome_page";
const EXTENSION_SOURCE = "vscode_extension";

// One welcome-page entry. The `entry` value doubles as the payload's `entry` field; the
// paired server event name lives in WELCOME_EVENT_TYPES so a call site can never mismatch
// the two. (entry string values are ruili's data-contract call; adjust here if he revises.)
export type WelcomeEntry = "import_session" | "recent_session_restore" | "open_project_folder";

const WELCOME_EVENT_TYPES: Record<WelcomeEntry, string> = {
  import_session: "welcome_import_session_clicked",
  recent_session_restore: "welcome_recent_session_restore_clicked",
  open_project_folder: "welcome_open_project_folder_clicked",
};

export type WelcomeEventInput = {
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  entry: WelcomeEntry;
  hasWorkspace: boolean;
  log?: (message: string) => void;
};

// Post one welcome-page entry-click event. Best-effort and synchronous to return: it kicks
// off the request and returns immediately, so a caller never awaits it on the click path.
export function postWelcomeEvent(input: WelcomeEventInput): void {
  const base = input.apiBaseUrl.replace(/\/$/, "");
  // No authorization header: /v1/web/events is anonymous — never ship the GitHub JWT here.
  // `source` MUST be sent: the server defaults an absent source to "website-home", which
  // would silently misattribute the extension's clicks into the website funnel.
  const body = {
    event_type: WELCOME_EVENT_TYPES[input.entry],
    payload: {
      surface: WELCOME_SURFACE,
      entry: input.entry,
      extension_version: EXTENSION_VERSION,
      has_workspace: input.hasWorkspace,
    },
    source: EXTENSION_SOURCE,
  };
  void input
    .fetchImpl(`${base}/v1/web/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .catch((error) => {
      input.log?.(`[web-telemetry] ${error instanceof Error ? error.message : String(error)}`);
    });
}
