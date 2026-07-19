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
export const DEFAULT_API_BASE_URL = "https://blockless.upypi.net";

// The backend receives the GitHub OAuth access token (github-auth) and the session JWT
// (llm/credits/telemetry). Only allow https, or http for explicit loopback dev — so a
// mistyped or hostile override can't leak those credentials over cleartext to a remote
// host. An invalid candidate is IGNORED (falls through to the next source / the hosted
// default), never silently used. Loopback http is the sanctioned local-dev path
// (MPYHW_API_BASE=http://127.0.0.1:8787).
function isAllowedBackend(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  }
  return false;
}

export function resolveApiBaseUrl(vscode: any, override?: string): string {
  const configured = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("apiBaseUrl");
  const settingRaw = typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  const setting = settingRaw && isAllowedBackend(settingRaw) ? settingRaw : undefined;
  // An empty/whitespace env var means "unset" — don't let it shadow the hosted
  // default (first NON-EMPTY wins), mirroring the setting handling above.
  const envValue = process.env.MPYHW_API_BASE;
  const envRaw = typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
  const env = envRaw && isAllowedBackend(envRaw) ? envRaw : undefined;
  const url = override ?? setting ?? env ?? DEFAULT_API_BASE_URL;
  return url.replace(/\/$/, "");
}
