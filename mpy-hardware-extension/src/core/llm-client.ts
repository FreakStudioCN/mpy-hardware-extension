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
    const response = await deps.fetchImpl(`${deps.apiBaseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let detail = "llm_upstream_error";
      try {
        const body = await response.json();
        detail = body?.detail?.error ?? body?.error ?? detail;
      } catch {
        // non-JSON error body; keep generic detail
      }
      throw new Error(detail);
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
