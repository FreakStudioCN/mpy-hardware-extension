import assert from "node:assert/strict";
import test from "node:test";

import { parseSseEvents, streamSseEvents } from "../src/core/sse-client.ts";

// The server's _sse() emits bare `data: {json}\n\n` blocks with NO `event:` line.
// Every case frames input exactly that way so the parser is pinned against what
// actually comes over the wire (see also the golden in sse-contract.test.ts).
function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

test("parses text delta, accumulates tool-use JSON across fragments, and stops", () => {
  const wire = [
    { type: "content_block_delta", delta: { type: "text_delta", text: "checking" } },
    { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "search_packages" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"query\":\"temp\"" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "}" } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ].map(sse).join("");

  // Full-array assertion: the tool-use blocks collapse into exactly one
  // tool_use_complete with the two JSON fragments reassembled, and nothing extra.
  assert.deepEqual(parseSseEvents(wire), [
    { type: "text_delta", text: "checking" },
    { type: "tool_use_complete", id: "toolu_1", name: "search_packages", input: { query: "temp" } },
    { type: "message_stop" },
  ]);
});

test("a tool call with malformed argument JSON is surfaced as invalidInput, not thrown", () => {
  // The exact production failure: the model emitted a write_project_file whose
  // content string had an unescaped quote, so the accumulated arguments aren't
  // valid JSON. The parser must NOT throw (that killed the whole session); it must
  // hand back a tool_use_complete flagged invalidInput so the loop can recover.
  const wire = [
    { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "write_project_file" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"path\":\"main.py\",\"content\":\"print(\"oops\")\"}" } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ].map(sse).join("");

  const events = parseSseEvents(wire);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_use_complete");
  assert.equal(events[0].id, "toolu_1");
  assert.equal(events[0].name, "write_project_file");
  assert.deepEqual(events[0].input, {});
  assert.ok(typeof events[0].invalidInput === "string" && events[0].invalidInput.length > 0);
  assert.deepEqual(events[1], { type: "message_stop" });
});

test("text is passed through verbatim (no refusal special-casing) and stream error is structured", () => {
  // The <not_hardware> refusal mechanism was removed; such text must now flow
  // through as an ordinary text_delta rather than a special terminal event.
  const events = parseSseEvents([
    { type: "content_block_delta", delta: { type: "text_delta", text: "<not_hardware>write sql" } },
    { type: "error", error: { message: "interrupted" } },
  ].map(sse).join(""));

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
  controller.enqueue(encoder.encode(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "live" } })));

  assert.deepEqual(await first, { done: false, value: { type: "text_delta", text: "live" } });

  const second = iterator.next();
  controller.enqueue(encoder.encode(sse({ type: "message_stop" })));
  controller.close();

  assert.deepEqual(await second, { done: false, value: { type: "message_stop" } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});
