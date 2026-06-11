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
      try {
        const body = await response.json();
        const appError = body?.detail?.error ?? body?.error;
        if (appError) {
          detail = appError;
          structured = true;
        }
      } catch {
        // non-JSON error body; keep generic detail
      }
      const error: any = new Error(detail);
      // Transient failures are worth re-issuing: rate limits / timeouts (429, 408)
      // and infrastructure 5xx (Render restart/cold start — a proxy error page, not
      // JSON). A STRUCTURED 5xx is the app deliberately reporting what's wrong
      // (llm_upstream_not_configured); retrying can't fix it and would bury the
      // detail. Application 4xx (auth, credits) keep their dedicated UX.
      if (response.status === 429 || response.status === 408 || (response.status >= 500 && !structured)) {
        error.retryable = true;
      }
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
