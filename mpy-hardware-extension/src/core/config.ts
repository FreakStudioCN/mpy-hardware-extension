// Default local dev API base (mpyhw-api via scripts/dev-up.ps1). The runtime
// value always comes from resolveApiBaseUrl (the mpyhw.apiBaseUrl setting);
// this constant is only the last-resort fallback for dev/test wiring.
export const DEV_API_BASE_URL = "http://127.0.0.1:8787";
