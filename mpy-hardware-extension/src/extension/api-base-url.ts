// Single source of truth for the Blockless backend API base URL.
//
// Resolution priority (first non-empty wins):
//   1. explicit override — tests inject this via deps.apiBaseUrl
//   2. the `mpyhw.apiBaseUrl` VS Code setting — a user/admin pointing elsewhere
//   3. MPYHW_API_BASE env var — the dev workflow (point at a local backend)
//   4. the hosted production backend — what a published extension must default to
//
// A published extension can never default to localhost (no backend there), so the
// fallback is the hosted URL. The setting defaults to "" (see package.json) rather
// than carrying the hosted URL, so the env dev-override below is still reachable.
export const DEFAULT_API_BASE_URL = "https://blockless-api.fly.dev";

export function resolveApiBaseUrl(vscode: any, override?: string): string {
  const configured = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("apiBaseUrl");
  const setting = typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  // An empty/whitespace env var means "unset" — don't let it shadow the hosted
  // default (first NON-EMPTY wins), mirroring the setting handling above.
  const envValue = process.env.MPYHW_API_BASE;
  const env = typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
  const url = override ?? setting ?? env ?? DEFAULT_API_BASE_URL;
  return url.replace(/\/$/, "");
}
