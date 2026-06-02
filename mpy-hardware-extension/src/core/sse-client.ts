export function parseSseEvents(text: string): any[] {
  const parsed: any[] = [];
  let currentTool: any = undefined;
  let toolJson = "";
  for (const rawEvent of text.split(/\n\s*\n/)) {
    const dataLine = rawEvent.split(/\r?\n/).find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === "error") {
      parsed.push({ type: "stream_error", message: data.error?.message ?? "stream_error" });
      continue;
    }
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      currentTool = { id: data.content_block.id, name: data.content_block.name };
      toolJson = "";
      continue;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      toolJson += data.delta.partial_json;
      continue;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      parsed.push({ type: "text_delta", text: data.delta.text });
      continue;
    }
    if (data.type === "content_block_delta" && data.delta?.type === "thinking_delta") {
      parsed.push({ type: "thinking_delta", text: data.delta.thinking });
      continue;
    }
    if (data.type === "content_block_stop" && currentTool) {
      parsed.push({ type: "tool_use_complete", ...currentTool, input: toolJson ? JSON.parse(toolJson) : {} });
      currentTool = undefined;
      toolJson = "";
      continue;
    }
    if (data.type === "message_stop") {
      parsed.push({ type: "message_stop" });
    }
  }
  return parsed;
}
