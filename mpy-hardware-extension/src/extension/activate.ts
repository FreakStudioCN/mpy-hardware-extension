import { registerCommands } from "./commands.ts";
import { resolveApiBaseUrl } from "./api-base-url.ts";
import { createGithubAuth } from "./github-auth.ts";
import { installHostErrorHandlers, sweepAbandonedSessions, type HostTelemetryDeps } from "./host-telemetry.ts";
import { createViewProvider } from "../webview/panel.ts";

// Set by the active webview's controller (via registerTelemetryFlush) so deactivate() can
// drain the telemetry outbox on shutdown. Last-wired webview wins (one active controller).
let telemetryFlush: (() => Promise<void>) | undefined;

export function activate(context: any, vscode: any = undefined) {
  // VS Code injects its API via require("vscode") in the CommonJS host. Tests
  // pass it explicitly; the require fallback only runs in the bundled entry.
  const api = vscode ?? require("vscode");
  const output = api.window.createOutputChannel?.("Blockless");
  let activeWebview: any;
  let pendingRecipeImport: any;
  const deliverRecipeImport = (payload: any) => {
    pendingRecipeImport = payload;
    // Same Thenable-rejection hazard as revealPanelIfEnabled: guard it the same way
    // so a failed focus never surfaces as an unhandled rejection.
    void Promise.resolve(api.commands?.executeCommand?.("mpyhw.panel.focus")).catch(() => {});
    if (activeWebview) {
      activeWebview.postMessage({ type: "recipe_imported", payload });
      pendingRecipeImport = undefined;
    }
  };
  // Dock the UI as a side-bar view (see contributes.views in package.json).
  const provider = createViewProvider(api, context.extensionUri, {
    log: (message: string) => output?.appendLine(message),
    // Guaranteed-writable per-extension dir; the fallback project root when no
    // workspace folder is open, so generation never writes to process.cwd().
    globalStoragePath: context.globalStorageUri?.fsPath,
    // Real runtime version for telemetry attribution — read from the manifest, NOT the
    // hand-kept EXTENSION_VERSION constant (which has drifted before). Absent in tests.
    extensionVersion: context.extension?.packageJSON?.version,
    registerTelemetryFlush: (flush: () => Promise<void>) => { telemetryFlush = flush; },
    onWebviewReady: (webview: any) => {
      activeWebview = webview;
      if (pendingRecipeImport) {
        activeWebview.postMessage({ type: "recipe_imported", payload: pendingRecipeImport });
        pendingRecipeImport = undefined;
      }
    },
  });
  // retainContextWhenHidden keeps the webview's DOM + script state alive when the
  // view is hidden (user switches sidebar views / collapses it). Without it VS Code
  // tears the webview down and reloads empty HTML, losing generated code + trace.
  context.subscriptions.push(
    api.window.registerWebviewViewProvider("mpyhw.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  // The command just reveals the view; VS Code auto-provides "<viewId>.focus".
  registerCommands(context, api, {
    openPanel: () => api.commands.executeCommand("mpyhw.panel.focus"),
  });
  if (api.window.registerUriHandler) {
    context.subscriptions.push(api.window.registerUriHandler({
      handleUri(uri: any) {
        if (String(uri.path ?? "").replace(/^\/+/, "") !== "importRecipe") return;
        deliverRecipeImport(parseRecipeImportUri(uri));
      },
    }));
  }
  if (output) context.subscriptions.push(output);
  revealPanelIfEnabled(api);
  installHostTelemetry(context, api, (message: string) => output?.appendLine(message));
}

// Open straight into the Blockless panel when the profile opted in via the `mpyhw.autoOpenPanel`
// setting. The one-click installer writes this into its dedicated Blockless profile, so that
// profile lands on the tool instead of a dormant Activity Bar icon. Stateless by design — no
// first-run flag, so it re-reveals on EVERY startup (the installer's VS Code is a kiosk-like,
// single-purpose environment). `onStartupFinished` activates the extension on every VS Code
// launch for every user regardless of this setting — that activation cost (incl.
// installHostTelemetry's backend sweepAbandonedSessions call below) is unavoidable and not
// gated by the flag. Off by default only means the VISIBLE panel reveal does nothing, so
// Marketplace users in their own profiles see no on-screen effect.
function revealPanelIfEnabled(api: any) {
  try {
    if (api.workspace?.getConfiguration?.("mpyhw")?.get?.("autoOpenPanel") !== true) return;
    // executeCommand returns a Thenable; a rejection would escape this synchronous
    // try/catch and surface as an unhandled rejection (observed by the host error
    // handlers installed just after activate()). Attach a catch so a failed reveal
    // stays best-effort and never reports as a fault.
    void Promise.resolve(api.commands?.executeCommand?.("mpyhw.panel.focus")).catch(() => {});
  } catch {
    // Best-effort UX only — a failed reveal must never break activation.
  }
}

// Wire host-level telemetry (uncaught-fault observer + abandoned-session sweep). Fully
// guarded: a headless/test host or an unreachable backend must never break activation.
function installHostTelemetry(context: any, api: any, log?: (message: string) => void) {
  try {
    const apiBaseUrl = resolveApiBaseUrl(api);
    const workspaceFolder = api.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
    const auth = api.authentication ? createGithubAuth({ vscode: api, apiBaseUrl, fetchImpl: fetch, log }) : undefined;
    const hostDeps: HostTelemetryDeps = {
      apiBaseUrl,
      fetchImpl: fetch,
      getAuthToken: auth ? () => auth.getToken(false) : undefined,
      log,
      clientMeta: { extension_version: context.extension?.packageJSON?.version, vscode_version: api.version, platform: `${process.platform} ${process.arch}` },
      sessionRoot: workspaceFolder ?? context.globalStorageUri?.fsPath,
      extensionPath: context.extension?.extensionPath ?? context.extensionUri?.fsPath,
      // Read live on every cloud event, so revoking consent stops the next post — no
      // recorder is rebuilt and no cached flag can go stale.
      isTelemetryEnabled: () => api.env?.isTelemetryEnabled !== false,
    };
    // The setting change itself is worth a log line: without it a user who opts out sees
    // the extension go quiet with no confirmation that it was the setting that did it.
    if (api.env?.onDidChangeTelemetryEnabled) {
      context.subscriptions.push(api.env.onDidChangeTelemetryEnabled((enabled: boolean) =>
        log?.(`[telemetry] cloud telemetry ${enabled ? "enabled" : "disabled"} by the user's VS Code telemetry setting`)));
    }
    context.subscriptions.push({ dispose: installHostErrorHandlers(hostDeps) });
    // Fire-and-forget best-effort. Guard the rejection: with the host error handlers already
    // installed above, an unhandled rejection here would be re-observed and reported as a fault.
    void sweepAbandonedSessions(hostDeps).catch((error) => log?.(`[telemetry] abandoned-session sweep: ${String(error)}`));
  } catch (error) {
    log?.(`[telemetry] host telemetry setup skipped: ${String(error)}`);
  }
}

export async function deactivate() {
  // Best-effort: VS Code awaits this on shutdown (with a timeout). Anything not delivered
  // stays durably in the telemetry outbox and drains on the next activation.
  try {
    await telemetryFlush?.();
  } catch {
    /* never block shutdown on a telemetry flush */
  }
}

export function parseRecipeImportUri(uri: any) {
  const params = new URLSearchParams(String(uri.query ?? ""));
  const rawPayload = params.get("payload");
  let payload: any = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  return {
    recipe_id: params.get("recipe_id") || payload.recipe_id || "",
    prompt: payload.prompt || payload.starter_prompt || params.get("prompt") || "",
    source: payload.source || params.get("source") || "website",
  };
}
