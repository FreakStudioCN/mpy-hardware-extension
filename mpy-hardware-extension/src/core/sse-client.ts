export function parseSseEvents(text: string): any[] {
  const parser = new SseEventParser();
  for (const rawEvent of text.split(/\n\s*\n/)) {
    parser.push(rawEvent);
  }
  return parser.events.splice(0);
}

export async function* streamSseEvents(response: Response): AsyncGenerator<any> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield* parseSseEvents(await response.text());
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseEventParser();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\s*\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      parser.push(part);
      while (parser.events.length) yield parser.events.shift();
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    parser.push(buffer);
    while (parser.events.length) yield parser.events.shift();
  }
}

class SseEventParser {
  events: any[] = [];
  private currentTool: any = undefined;
  private toolJson = "";

  push(rawEvent: string) {
    const dataLine = rawEvent.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const data = JSON.parse(dataLine.slice(5).trimStart());
    if (data.type === "error") {
      this.events.push({ type: "stream_error", message: data.error?.message ?? "stream_error" });
      return;
    }
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      this.currentTool = { id: data.content_block.id, name: data.content_block.name };
      this.toolJson = "";
      return;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      this.toolJson += data.delta.partial_json;
      return;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      this.events.push({ type: "text_delta", text: data.delta.text });
      return;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "thinking_delta") {
      this.events.push({ type: "thinking_delta", text: data.delta.thinking });
      return;
    }
    if (data.type === "content_block_stop" && this.currentTool) {
      this.events.push({ type: "tool_use_complete", ...this.currentTool, input: this.toolJson ? JSON.parse(this.toolJson) : {} });
      this.currentTool = undefined;
      this.toolJson = "";
      return;
    }
    if (data.type === "credits") {
      this.events.push({ type: "credits", remaining: data.remaining, dailyGrant: data.daily_grant, resetsAt: data.resets_at });
      return;
    }
    if (data.type === "message_stop") {
      this.events.push({ type: "message_stop" });
    }
  }
}
