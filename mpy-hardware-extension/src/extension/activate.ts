import { registerCommands } from "./commands.ts";
import { createViewProvider } from "../webview/panel.ts";

export function activate(context: any, vscode: any = undefined) {
  // VS Code injects its API via require("vscode") in the CommonJS host. Tests
  // pass it explicitly; the require fallback only runs in the bundled entry.
  const api = vscode ?? require("vscode");
  // Dock the UI as a side-bar view (see contributes.views in package.json).
  const provider = createViewProvider(api, context.extensionUri);
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
}

export function deactivate() {}
