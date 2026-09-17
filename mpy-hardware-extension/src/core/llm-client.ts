import { streamSseEvents } from "./sse-client.ts";

type LlmClientDeps = {
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  getAuthToken?: () => Promise<string | undefined>;
};

export function createLlmClient(deps: LlmClientDeps) {
  async function authHeaders(): Promise<Record<string, string>> {
    const token = deps.getAuthToken ? await deps.getAuthToken() : undefined;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function streamMessages(body: any, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await deps.fetchImpl(`${deps.apiBaseUrl}/v1/llm/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error: any) {
      // Connection never established (undici rejects with a bare "fetch failed";
      // the real reason — ECONNRESET, ETIMEDOUT, EAI_AGAIN — hides in error.cause).
      // Surface the cause in the message so telemetry stops being undebuggable, and
      // mark it retryable: the request never reached the server, so re-issuing is
      // free and safe. A user abort is not a transport failure — leave it unmarked.
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      const cause = error?.cause;
      const detail = cause?.code ?? cause?.message;
      const wrapped: any = new Error(detail ? `${error?.message ?? "fetch failed"} (${detail})` : error?.message ?? "fetch failed");
      wrapped.cause = error;
      wrapped.retryable = true;
      throw wrapped;
    }
    if (!response.ok) {
      let detail = "llm_upstream_error";
      let structured = false;
      let upstreamStatus: unknown;
      let upstreamKind: unknown;
      try {
        const body = await response.json();
        const appError = body?.detail?.error ?? body?.error;
        upstreamStatus = body?.detail?.status;
        upstreamKind = body?.detail?.kind;
        if (appError) {
          detail = appError;
          structured = true;
        }
      } catch {
        // non-JSON error body; keep generic detail
      }
      let retryable = false;
      if (detail === "llm_upstream_error" && typeof upstreamKind === "string") {
        // The server has already classified the rejection (kind), so use that instead of
        // guessing from the nested status: a quota 429 reads identically to a rate-limit 429
        // by status alone, and only the kind tells them apart. quota/auth/rejected are not
        // transient regardless of nested status; the message becomes the token the webview
        // renders friendly copy for. Only the three known transient kinds stay retryable, which is what keeps
        // a nested timeout retryable: the server maps 408 to outage precisely so it does not
        // land in `rejected` here and lose the auto-retry a kind-less response would still get
        // from the status rule below.
        if (upstreamKind === "quota" || upstreamKind === "auth" || upstreamKind === "rejected") {
          detail = `llm_upstream_${upstreamKind}`;
        } else if (upstreamKind === "outage" || upstreamKind === "rate_limited" || upstreamKind === "provider_rollout") {
          retryable = true;
        } else {
          // The backend can deploy independently of the extension. Do not turn a newly-added,
          // possibly terminal kind into an automatic retry in an older client; retain the
          // legacy nested-status behavior until this client knows the kind's semantics.
          retryable = typeof upstreamStatus === "number"
            && (upstreamStatus === 0 || upstreamStatus === 408 || upstreamStatus === 429 || upstreamStatus >= 500);
        }
      } else {
        // No kind (old server, or a non-upstream error): the pre-existing status-based rule,
        // unchanged. Transient failures are worth re-issuing: rate limits / timeouts (429, 408)
        // and infrastructure 5xx (Render restart/cold start — a proxy error page, not JSON).
        // Most structured 5xx errors deliberately report a non-transient app problem, but
        // llm_upstream_error wraps the provider status in a 502; retry only when that nested
        // status is itself transient. Application 4xx (auth, credits) keep their dedicated UX.
        const transientUpstreamError = detail === "llm_upstream_error"
          && typeof upstreamStatus === "number"
          && (upstreamStatus === 0 || upstreamStatus === 408 || upstreamStatus === 429 || upstreamStatus >= 500);
        retryable = response.status === 429 || response.status === 408 || (response.status >= 500 && !structured) || transientUpstreamError;
      }
      const error: any = new Error(detail);
      if (retryable) error.retryable = true;
      throw error;
    }
    return streamSseEvents(response);
  }

  async function collectText(body: any, signal?: AbortSignal) {
    let text = "";
    for await (const event of await streamMessages(body, signal)) {
      if (event.type === "text_delta") text += event.text;
    }
    return text;
  }

  return { streamMessages, collectText };
}
