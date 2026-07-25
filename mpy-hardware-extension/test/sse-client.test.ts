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

test("a credits event carries the server's cost and token fields when it sends them", () => {
  // Card #87 slice C: model, the token split and the authoritative charge exist only on the
  // server. Mutation: keep the three-key mapping -> the client records that a credit was
  // spent but never what it bought.
  const [event] = parseSseEvents(
    'data: {"type":"credits","remaining":46,"daily_grant":50,"resets_at":"2026-07-26T00:00:00Z","charged":3,"model":"deepseek-v4-pro","input_tokens":1200,"output_tokens":180,"cache_hit_tokens":1024}\n\n',
  );

  assert.deepEqual(event, {
    type: "credits",
    remaining: 46,
    dailyGrant: 50,
    resetsAt: "2026-07-26T00:00:00Z",
    charged: 3,
    model: "deepseek-v4-pro",
    inputTokens: 1200,
    outputTokens: 180,
    cacheHitTokens: 1024,
  });
});

test("a pre-enrichment credits event keeps exactly the old shape", () => {
  // The server deploys first and old clients must be unaffected — but the reverse also has
  // to hold: a new client against an old backend must leave the cost fields UNSET, not 0.
  // Mutation: always attach the keys -> undefined/0 fields poison the cost aggregate.
  const [event] = parseSseEvents('data: {"type":"credits","remaining":46,"daily_grant":50,"resets_at":"2026-07-26T00:00:00Z"}\n\n');

  assert.deepEqual(event, { type: "credits", remaining: 46, dailyGrant: 50, resetsAt: "2026-07-26T00:00:00Z" });
});

test("a zero charge is recorded as zero, not treated as missing", () => {
  // The stub backend (and a refunded turn) legitimately charge 0. A truthiness check here
  // would drop it and make a free turn indistinguishable from an unreported one.
  const [event] = parseSseEvents('data: {"type":"credits","remaining":50,"daily_grant":50,"charged":0,"input_tokens":0,"model":"stub"}\n\n');

  assert.equal((event as any).charged, 0);
  assert.equal((event as any).inputTokens, 0);
  assert.equal((event as any).model, "stub");
});
