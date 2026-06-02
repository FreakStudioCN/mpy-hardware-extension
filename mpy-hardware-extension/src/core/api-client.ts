import { safeJson } from "./package-client.ts";

export class ApiClient {
  baseUrl: string;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(baseUrl: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async executePackageTool(name: string, input: any) {
    try {
      if (name === "search_packages") {
        const body = await this.request("/v1/packages/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        return { ok: true, ...body };
      }
      if (name === "resolve_package_candidates") {
        const body = await this.request("/v1/packages/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        return { ok: true, ...body };
      }
      if (name === "get_package_context") {
        const body = await this.request(`/v1/packages/${input.name}/${input.version}/driver-context`);
        return { ok: true, ...body };
      }
      return { ok: false, error_kind: "UnknownToolError" };
    } catch (error: any) {
      return { ok: false, error_kind: error.code ?? "upstream_unavailable" };
    }
  }

  async checkToolRegistry(localTools: string[]) {
    const body = await this.request("/v1/tools");
    const remote = new Set((body.tools ?? []).map((tool: any) => tool.name));
    const mismatch = localTools.some((tool) => !remote.has(tool));
    return mismatch ? { warning: "tool_registry_mismatch" } : { ok: true };
  }

  async openSse() {
    try {
      await this.fetchImpl(`${this.baseUrl}/v1/llm/messages`, { method: "POST" });
      return { ok: true };
    } catch {
      return { ok: false, error_kind: "sse_stream_interrupted" };
    }
  }

  async request(path: string, init?: RequestInit) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const body = await safeJson(response);
    if (!response.ok) {
      const code = body?.detail?.error ?? "upstream_unavailable";
      const err = new Error(code) as Error & { code: string };
      err.code = code;
      throw err;
    }
    return body;
  }
}
