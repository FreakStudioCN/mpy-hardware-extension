export function registerCommands(context: any, vscode: any, deps: { openPanel: () => void }) {
  context.subscriptions.push(vscode.commands.registerCommand("mpyhw.openPanel", deps.openPanel));
}
