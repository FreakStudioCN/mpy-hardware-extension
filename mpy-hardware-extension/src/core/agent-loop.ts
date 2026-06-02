import { normalizeObservation, toToolResultBlock } from "./observations.ts";
import { shouldTerminate } from "./termination.ts";

export async function runAgentLoop(input: { state: any; sseClient: () => Promise<any[]>; dispatchTool: (tool: any) => Promise<any>; onEvent?: (event: any) => void; signal?: { aborted: boolean } }) {
  const state = input.state;
  while (true) {
    if (input.signal?.aborted) {
      return { terminal: "cancelled", state };
    }
    const terminal = shouldTerminate(state);
    if (terminal.done) {
      return { terminal: terminal.reason, state };
    }
    const events = await input.sseClient();
    let assistantText = "";
    let sawStop = false;
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    for (const event of events) {
      input.onEvent?.(event);
      if (event.type === "stream_error") {
        return { terminal: "sse_stream_interrupted", state };
      }
      if (event.type === "text_delta") {
        assistantText += event.text;
      }
      if (event.type === "tool_use_complete") {
        toolUses.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        const raw = await input.dispatchTool({ name: event.name, input: event.input });
        const observation = normalizeObservation(event.name, raw);
        toolResults.push(toToolResultBlock(event.id, observation));
        if (observation.error_kind === "runtime_error") {
          state.repairRound += 1;
        }
        if (Array.isArray(observation.output?.lines)) {
          state.lastRuntimeMarker = observation.output.lines.at(-1);
        }
      }
      if (event.type === "message_stop") {
        if (assistantText || toolUses.length) {
          const content: any[] = [];
          if (assistantText) content.push({ type: "text", text: assistantText });
          content.push(...toolUses);
          state.messages.push({ role: "assistant", content });
        }
        if (toolResults.length) {
          state.messages.push({ role: "user", content: toolResults });
        }
        state.turnSeq += 1;
        sawStop = true;
      }
    }
    if (!sawStop) {
      // A turn that never reached message_stop (truncated/interrupted stream)
      // makes no progress; terminate instead of looping forever.
      return { terminal: "sse_stream_interrupted", state };
    }
  }
}
