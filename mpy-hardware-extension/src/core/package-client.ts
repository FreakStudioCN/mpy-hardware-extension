export class ApiError extends Error {
  code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Error responses (and 204s) can carry an empty or non-JSON body; response.json()
// would throw a SyntaxError that masks the real status. Parse defensively.
export async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class PackageClient {
  baseUrl: string;
  fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  search(request: { query?: string; capabilities?: string[]; board_id?: string }) {
    return this.post("/v1/packages/search", request);
  }

  resolve(request: { intent: string; capabilities: string[]; board_id: string }) {
    return this.post("/v1/packages/resolve", request);
  }

  getPackageContext(name: string, version: string) {
    return this.get(`/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/driver-context`);
  }

  async post(path: string, body: unknown) {
    return this.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async get(path: string) {
    return this.request(path);
  }

  async request(path: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch {
      throw new ApiError("upstream_unavailable");
    }
    const body = await safeJson(response);
    if (!response.ok) {
      throw new ApiError(body?.detail?.error ?? body?.error ?? "upstream_unavailable");
    }
    return body;
  }
}
