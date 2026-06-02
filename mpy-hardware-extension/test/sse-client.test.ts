import assert from "node:assert/strict";
import test from "node:test";

import { parseSseEvents, streamSseEvents } from "../src/core/sse-client.ts";

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

test("streams events before the response body finishes", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const iterator = streamSseEvents({ body } as Response)[Symbol.asyncIterator]();

  const first = iterator.next();
  controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "live" } }) + "\n"));

  assert.deepEqual(await first, { done: false, value: { type: "text_delta", text: "live" } });

  const second = iterator.next();
  controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" }) + "\n"));
  controller.close();

  assert.deepEqual(await second, { done: false, value: { type: "message_stop" } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("parses the server's real framing: bare `data: {...}` blocks, no `event:` line", () => {
  // The server's _sse() emits `data: {json}\n\n` with NO `event:` line. The other
  // cases here use `event: X\ndata: Y` framing the server never produces; this pins
  // the parser against what actually comes over the wire.
  const wire = [
    { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "scan_device" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join("");

  assert.deepEqual(parseSseEvents(wire), [
    { type: "text_delta", text: "hello" },
    { type: "tool_use_complete", id: "t1", name: "scan_device", input: {} },
    { type: "message_stop" },
  ]);
});

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n`;
}
