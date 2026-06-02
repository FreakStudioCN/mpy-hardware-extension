type Deps = { vscode: any; apiBaseUrl: string; fetchImpl: typeof fetch };

// Exchanges a VS Code GitHub session for our backend session JWT.
//
// VS Code owns the OAuth flow + token storage; we only verify the resulting
// access token server-side and mint a JWT keyed to the GitHub user. Returns
// undefined in headless/test hosts (no vscode.authentication) and when the user
// has no GitHub session / declines sign-in, so callers can decide whether to
// gate on it.
export function createGithubAuth(deps: Deps) {
  let cachedJwt: string | undefined;

  async function getToken(interactive: boolean): Promise<string | undefined> {
    if (!deps.vscode?.authentication?.getSession) return undefined;
    if (cachedJwt) return cachedJwt;
    let session: any;
    try {
      const options = interactive ? { createIfNone: true } : { silent: true };
      session = await deps.vscode.authentication.getSession("github", ["read:user"], options);
    } catch {
      return undefined;
    }
    if (!session?.accessToken) return undefined;
    try {
      const response = await deps.fetchImpl(`${deps.apiBaseUrl}/v1/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: session.accessToken }),
      });
      if (!response.ok) return undefined;
      const body: any = await response.json();
      cachedJwt = body.token;
      return cachedJwt;
    } catch {
      return undefined;
    }
  }

  return { getToken };
}
