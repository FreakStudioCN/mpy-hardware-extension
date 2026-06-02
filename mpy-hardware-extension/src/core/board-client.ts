import { ApiError, safeJson } from "./package-client.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class BoardClient {
  baseUrl: string;
  fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async getBoardProfile(boardId: string) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/boards/${encodeURIComponent(boardId)}`);
    } catch {
      throw new ApiError("upstream_unavailable");
    }
    const body = await safeJson(response);
    if (!response.ok) {
      throw new ApiError(body?.detail?.error ?? "board_not_found");
    }
    return body;
  }
}
