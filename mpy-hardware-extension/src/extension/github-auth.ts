type Deps = { vscode: any; apiBaseUrl: string; fetchImpl: typeof fetch; log?: (message: string) => void };
type TokenOptions = { forceRefresh?: boolean };

// Exchanges a VS Code GitHub session for our backend session JWT.
//
// VS Code owns the OAuth flow + token storage; we only verify the resulting
// access token server-side and mint a JWT keyed to the GitHub user. Returns
// undefined in headless/test hosts (no vscode.authentication) and when the user
// has no GitHub session / declines sign-in, so callers can decide whether to
// gate on it.
export function createGithubAuth(deps: Deps) {
  let cachedJwt: string | undefined;
  let lastError: string | undefined;

  function record(error: string | undefined, message: string) {
    lastError = error;
    deps.log?.(`[github-auth] ${message}`);
  }

  async function getToken(interactive: boolean, options: TokenOptions = {}): Promise<string | undefined> {
    if (!deps.vscode?.authentication?.getSession) {
      record("auth_provider_unavailable", "VS Code GitHub authentication provider is unavailable");
      return undefined;
    }
    if (cachedJwt && !options.forceRefresh) return cachedJwt;
    if (options.forceRefresh) cachedJwt = undefined;
    let session: any;
    try {
      const options = interactive ? { createIfNone: true } : { silent: true };
      session = await deps.vscode.authentication.getSession("github", ["read:user"], options);
    } catch (error) {
      record("github_session_failed", `GitHub session failed: ${formatError(error)}`);
      return undefined;
    }
    if (!session?.accessToken) {
      record("github_session_unavailable", "GitHub session did not return an access token");
      return undefined;
    }
    try {
      const response = await deps.fetchImpl(`${deps.apiBaseUrl}/v1/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: session.accessToken }),
      });
      if (!response.ok) {
        const body = typeof response.text === "function" ? await response.text() : "";
        record("github_token_exchange_failed", `GitHub token exchange failed: ${response.status}${body ? ` ${body}` : ""}`);
        return undefined;
      }
      const body: any = await response.json();
      if (!body?.token) {
        record("github_token_missing", "GitHub token exchange response did not include a session token");
        return undefined;
      }
      cachedJwt = body.token;
      record(undefined, `GitHub sign-in completed${body.login ? ` for ${body.login}` : ""}`);
      return cachedJwt;
    } catch (error) {
      record("github_token_exchange_unreachable", `GitHub token exchange request failed: ${formatError(error)}`);
      return undefined;
    }
  }

  return { getToken, getLastError: () => lastError };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
