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
      // The model occasionally emits tool-call arguments that aren't valid JSON
      // (commonly an unescaped quote/newline/backslash inside a large code string).
      // A bare JSON.parse here would throw and kill the whole session — discarding
      // the manifest, generated code, and files already written. Instead, flag the
      // call's input as invalid so the loop can feed a structured error back and let
      // the model re-send ONLY this call with valid JSON.
      const event: any = { type: "tool_use_complete", ...this.currentTool, input: {} };
      if (this.toolJson) {
        try {
          event.input = JSON.parse(this.toolJson);
        } catch (error: any) {
          event.invalidInput = error?.message ?? "invalid tool-arguments JSON";
        }
      }
      this.events.push(event);
      this.currentTool = undefined;
      this.toolJson = "";
      return;
    }
    if (data.type === "credits") {
      this.events.push({ type: "credits", remaining: data.remaining, dailyGrant: data.daily_grant, resetsAt: data.resets_at });
      return;
    }
    if (data.type === "message_stop") {
      // finishReason is added only when the server reported one, so a bare message_stop
      // stays { type: "message_stop" } (the SSE golden / deepEqual contracts hold).
      const event: any = { type: "message_stop" };
      if (data.finish_reason != null) event.finishReason = data.finish_reason;
      this.events.push(event);
    }
  }
}
