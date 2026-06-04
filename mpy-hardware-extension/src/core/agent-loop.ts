import { normalizeObservation, toToolResultBlock } from "./observations.ts";
import { shouldTerminate } from "./termination.ts";

// Failures the model can't fix by re-proposing the manifest: the environment can't
// do the step (no device / no workspace) or the user declined it. They are neither
// runtime errors (repairRound) nor model no-progress, so they must NOT feed the
// noProgressStreak — counting them mislabels a declined deploy / missing board as
// "manifest_unresolved". A declined deploy ends cleanly via state.deployDeclined.
const NON_PROGRESS_NEUTRAL = new Set(["device_unavailable", "workspace_unavailable", "user_cancelled"]);

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
    let reasoningText = "";
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
      if (event.type === "thinking_delta") {
        // Thinking-mode reasoning. Accumulate it so it can be stored on the assistant
        // turn and passed back next round (DeepSeek requires reasoning_content for a
        // replayed tool-calling thinking turn, else it 400s).
        reasoningText += event.text;
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
        // The SSE parser couldn't decode this call's arguments as JSON. Don't
        // dispatch a half-formed call: feed a structured error back so the model
        // re-sends ONLY this call with valid JSON, instead of the whole session
        // crashing and losing all prior progress (manifest, generated code, writes).
        // A non-runtime failure, so it accrues the no-progress streak and the loop
        // still terminates if the model keeps emitting invalid JSON.
        const raw = event.invalidInput
          ? { ok: false, error_kind: "invalid_tool_input", message: `Your arguments for ${event.name} were not valid JSON (${event.invalidInput}). A string value (most likely file content) probably contains an unescaped quote, backslash, or newline. Re-send ONLY this tool call with its arguments as valid JSON, escaping every special character inside string values.` }
          : await input.dispatchTool({ name: event.name, input: event.input });
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
        // No-progress backstop: a successful tool clears the streak; a non-runtime
        // failure (e.g. manifest_invalid) extends it. Runtime errors are owned by
        // repairRound above and neither extend nor reset this streak. Environment/user
        // incapability (NON_PROGRESS_NEUTRAL) is the model making a reasonable call the
        // host can't satisfy — it neither extends nor resets the streak.
        if (observation.ok) {
          state.noProgressStreak = 0;
        } else if (observation.error_kind !== "runtime_error" && !NON_PROGRESS_NEUTRAL.has(observation.error_kind)) {
          state.noProgressStreak = (state.noProgressStreak ?? 0) + 1;
        }
        // Only a SUCCESSFUL read establishes a runtime marker. A failed read
        // (timeout) can still carry buffered lines whose tail happens to contain
        // the success marker; recording it would falsely grade the failure as
        // success in shouldTerminate.
        if (observation.ok && Array.isArray(observation.output?.lines)) {
          state.lastRuntimeMarker = observation.output.lines.at(-1);
        }
        if (event.name === "read_serial_until" && observation.ok) {
          state.runtimeVerified = true;
        }
      }
      if (event.type === "message_stop") {
        if (assistantText || toolUses.length || reasoningText) {
          const content: any[] = [];
          // Thinking block first, so it round-trips as reasoning_content (the server
          // re-attaches it to the DeepSeek assistant message). Required for thinking-
          // mode tool turns; kept in the durable history so the prefix stays cacheable.
          if (reasoningText) content.push({ type: "thinking", thinking: reasoningText });
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
