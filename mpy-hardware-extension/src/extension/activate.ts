import { registerCommands } from "./commands.ts";
import { createViewProvider } from "../webview/panel.ts";

export function activate(context: any, vscode: any = undefined) {
  // VS Code injects its API via require("vscode") in the CommonJS host. Tests
  // pass it explicitly; the require fallback only runs in the bundled entry.
  const api = vscode ?? require("vscode");
  const output = api.window.createOutputChannel?.("Blockless");
  let activeWebview: any;
  let pendingRecipeImport: any;
  const deliverRecipeImport = (payload: any) => {
    pendingRecipeImport = payload;
    api.commands?.executeCommand?.("mpyhw.panel.focus");
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
}

export function deactivate() {}

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
    prompt: payload.prompt || params.get("prompt") || "",
    source: payload.source || params.get("source") || "website",
  };
}
