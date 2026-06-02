import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSseEvents } from "../src/core/sse-client.ts";

// The SAME golden the server's test_sse_contract.py generates from the real
// _translate_deepseek_stream output. The client parser is verified against the
// server's actual wire bytes, not a hand-faked re-invention of them. If the
// server translation changes, REGEN the golden and this test sees the new reality.
const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "..", "..", "mpyhw-api", "tests", "fixtures", "anthropic_stream.sse");

test("client parseSseEvents consumes the server's real Anthropic SSE golden", { skip: existsSync(goldenPath) ? false : "golden missing; run REGEN=1 pytest test_sse_contract.py" }, () => {
  const events = parseSseEvents(readFileSync(goldenPath, "utf-8"));

  assert.deepEqual(events, [
    { type: "text_delta", text: "Let me check the board. " },
    { type: "text_delta", text: "Profiling now." },
    { type: "tool_use_complete", id: "call_1", name: "query_board_profile", input: { board_id: "esp32-s3-devkitc-1" } },
    { type: "message_stop" },
  ]);
});
