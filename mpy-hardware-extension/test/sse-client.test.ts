import assert from "node:assert/strict";
import test from "node:test";

import { parseSseEvents } from "../src/core/sse-client.ts";

test("parses text delta, tool use JSON deltas, and message stop", () => {
  const events = parseSseEvents([
    sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "checking" } }),
    sse("content_block_start", { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "search_packages" } }),
    sse("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"query\":\"temp\"" } }),
    sse("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "}" } }),
    sse("content_block_stop", { type: "content_block_stop" }),
    sse("message_stop", { type: "message_stop" }),
  ].join("\n"));

  assert.deepEqual(events[0], { type: "text_delta", text: "checking" });
  assert.deepEqual(events[1], { type: "tool_use_complete", id: "toolu_1", name: "search_packages", input: { query: "temp" } });
  assert.deepEqual(events.at(-1), { type: "message_stop" });
});

test("text is passed through verbatim (no refusal special-casing) and stream error is structured", () => {
  // The <not_hardware> refusal mechanism was removed; such text must now flow
  // through as an ordinary text_delta rather than a special terminal event.
  const events = parseSseEvents([
    sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "<not_hardware>write sql" } }),
    sse("error", { type: "error", error: { message: "interrupted" } }),
  ].join("\n"));

  assert.deepEqual(events[0], { type: "text_delta", text: "<not_hardware>write sql" });
  assert.equal(events[1].type, "stream_error");
});

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n`;
}
