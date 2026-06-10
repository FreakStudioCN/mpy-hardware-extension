import { normalizeObservation, toToolResultBlock } from "./observations.ts";
import { shouldTerminate } from "./termination.ts";

// Failures the model can't fix by re-proposing the manifest: the environment can't
// do the step (no device / no workspace) or the user declined it. They are neither
// runtime errors (repairRound) nor model no-progress, so they must NOT feed the
// noProgressStreak — counting them mislabels a declined deploy / missing board as
// "manifest_unresolved". A declined deploy ends cleanly via state.deployDeclined.
const NON_PROGRESS_NEUTRAL = new Set(["device_unavailable", "workspace_unavailable", "user_cancelled"]);

// After the manifest + component-confirmation card resolve inline, the model
// sometimes narrates the plan and hands back with no tool call — stranding the
// build at "analyze" before any code is generated (the desk-companion dead-end).
// This message nudges it to continue. Bounded by state.stallNudges, and gated on
// "manifest exists but no files yet" so a finished build (code already generated,
// just not flashable headless) is never re-nudged — that blanket nudge was
// removed earlier because it re-asked "what do you want to do next?" when done.
const STALL_NUDGE =
  "The component list is confirmed and recorded in the manifest — propose_manifest already returned it to you. Continue the build by calling the next tool in the phase flow (hardware selection, then code generation, then deploy); the build-plan/credit gate and the deploy gate prompt the user automatically when needed. The one exception: if you are missing information you genuinely need to build correctly (a value the user said they would provide, or a real ambiguity only the user can resolve), call ask_user to get it instead of guessing — that is not stalling.";
const MAX_STALL_NUDGES = 2;

type Recorder = { record(event: Record<string, any>): Promise<void> };

type EventSource = any[] | AsyncIterable<any>;

export async function runAgentLoop(input: { state: any; sseClient: () => Promise<EventSource>; dispatchTool: (tool: any) => Promise<any>; onEvent?: (event: any) => void; signal?: { aborted: boolean }; recorder?: Recorder }) {
  const state = input.state;
  // Bounded retry for a turn whose SSE stream drops or truncates mid-flight. Reset after
  // any turn that completes (reaches message_stop).
  let streamRetries = 0;
  const MAX_STREAM_RETRIES = 2;
  while (true) {
    if (input.signal?.aborted) {
      return { terminal: "cancelled", state };
    }
    const terminal = shouldTerminate(state);
    if (terminal.done) {
      return { terminal: terminal.reason, state };
    }
    const events = asAsyncEvents(await input.sseClient());
    const iterator = events[Symbol.asyncIterator]();
    let assistantText = "";
    let reasoningText = "";
    let sawStop = false;
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    // Manual iteration so a mid-stream rejection (e.g. undici "terminated" when the
    // connection drops) is caught here instead of escaping runAgentLoop as a fatal
    // session_error. A dropped read leaves sawStop false → the retry path below re-issues
    // the turn. A user Cancel aborts the same read, so distinguish it.
    while (true) {
      let next: IteratorResult<any>;
      try {
        next = await iterator.next();
      } catch {
        if (input.signal?.aborted) return { terminal: "cancelled", state };
        break;
      }
      if (next.done) break;
      const event = next.value;
      input.onEvent?.(event);
      if (event.type === "stream_error") {
        await iterator.return?.(undefined);
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
      // The turn never reached message_stop: the stream dropped mid-read or ended
      // truncated. Both are transient — retry the same request a bounded number of times
      // (no durable state was committed, so re-issuing is safe) before giving up. The
      // graceful terminal flows through session-controller's success branch, so state is
      // saved and the user can resume by sending another message.
      if (streamRetries < MAX_STREAM_RETRIES) {
        streamRetries += 1;
        input.onEvent?.({ type: "stream_retry", attempt: streamRetries });
        continue;
      }
      return { terminal: "sse_stream_interrupted", state };
    }
    streamRetries = 0;
    if (toolUses.length === 0) {
      // No tool call = the model handed the turn back to the user (final summary,
      // answer, or decline). End here; the user can continue with a new message.
      // (A real ask_user is a tool call, so it never lands here.)
      //
      // EXCEPT the post-manifest stall: if a manifest exists but no code has been
      // generated yet and the build isn't complete, the model stalled before doing
      // the work (it narrated the plan after the inline component card instead of
      // continuing to codegen/deploy). Nudge it onward, bounded, rather than dead-
      // ending the user at the "analyze" phase. The "no files yet" gate keeps a
      // finished build from being re-nudged, which is why the old blanket nudge was
      // removed.
      const stalledBeforeCodegen =
        state.manifest != null && state.phase !== "complete" && Object.keys(state.files ?? {}).length === 0;
      if (stalledBeforeCodegen && (state.stallNudges ?? 0) < MAX_STALL_NUDGES) {
        state.stallNudges = (state.stallNudges ?? 0) + 1;
        state.messages.push({ role: "user", content: STALL_NUDGE });
        await input.recorder?.record({ type: "stall_nudge", turnSeq: state.turnSeq, attempt: state.stallNudges });
        continue;
      }
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
