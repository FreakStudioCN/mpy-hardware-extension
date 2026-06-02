import { normalizeObservation, toToolResultBlock } from "./observations.ts";
import { shouldTerminate } from "./termination.ts";

type Recorder = { record(event: Record<string, any>): Promise<void> };

type EventSource = any[] | AsyncIterable<any>;

export async function runAgentLoop(input: { state: any; sseClient: () => Promise<EventSource>; dispatchTool: (tool: any) => Promise<any>; onEvent?: (event: any) => void; signal?: { aborted: boolean }; recorder?: Recorder }) {
  const state = input.state;
  while (true) {
    if (input.signal?.aborted) {
      return { terminal: "cancelled", state };
    }
    const terminal = shouldTerminate(state);
    if (terminal.done) {
      return { terminal: terminal.reason, state };
    }
    const events = asAsyncEvents(await input.sseClient());
    let assistantText = "";
    let sawStop = false;
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    for await (const event of events) {
      input.onEvent?.(event);
      if (event.type === "stream_error") {
        return { terminal: "sse_stream_interrupted", state };
      }
      if (event.type === "text_delta") {
        assistantText += event.text;
        await input.recorder?.record({ type: "assistant_text", turnSeq: state.turnSeq + 1, text: event.text });
      }
      if (event.type === "tool_use_complete") {
        await input.recorder?.record({
          type: "tool_use",
          turnSeq: state.turnSeq + 1,
          id: event.id,
          name: event.name,
          input: event.input,
        });
        toolUses.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        const raw = await input.dispatchTool({ name: event.name, input: event.input });
        const observation = normalizeObservation(event.name, raw);
        await input.recorder?.record({
          type: "tool_result",
          turnSeq: state.turnSeq + 1,
          id: event.id,
          name: event.name,
          observation,
        });
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
    if (toolUses.length === 0) {
      // No tool call = the model handed the turn back to the user (final summary,
      // answer, or decline). End here; the user can continue with a new message.
      // (A real ask_user is a tool call, so it never lands here.)
      return { terminal: "awaiting_user", state };
    }
  }
}

async function* asAsyncEvents(events: EventSource): AsyncGenerator<any> {
  if (Symbol.asyncIterator in events) {
    yield* events;
    return;
  }
  yield* events;
}
