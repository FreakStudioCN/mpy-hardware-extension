import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { containLocalPath, createProtocolLoop } from "../src/core/protocol-build.ts";
import { PROTOCOL_TOOLS } from "../src/core/protocol-registry.ts";

// cp_from pulls a device file to the HOST, so the model-supplied local destination must be
// contained to the project root — never allowed to write elsewhere on the host (#6 / Codex).
const ROOT = resolve("/work/proj");

test("containLocalPath keeps a normal relative dst inside the project root", () => {
  assert.equal(containLocalPath(ROOT, "logs/run.txt", "/log.txt"), resolve(ROOT, "logs/run.txt"));
});

test("containLocalPath strips a leading slash (device-absolute) into the project root", () => {
  assert.equal(containLocalPath(ROOT, "/main.py", "/main.py"), resolve(ROOT, "main.py"));
});

test("containLocalPath falls back to the device basename when dst is empty", () => {
  assert.equal(containLocalPath(ROOT, "", "/lib/driver.py"), resolve(ROOT, "driver.py"));
});

test("containLocalPath rejects a dst that escapes the project root", () => {
  assert.equal(containLocalPath(ROOT, "../../etc/passwd", "/x"), null);
});

function sseTool(id: string, name: string, input: any) {
  return [
    `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id, name } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop" })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");
}

test("createProtocolLoop sends the V0 cloud envelope through the production LLM client", async () => {
  const bodies: any[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(sseTool("done", "phase_complete", {
      result: "success",
      summary: "ok",
      next_phase: null,
      manifest_content: { done: true },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  const result = await loop({ intent: "build a thermometer", traceId: "trace-create-loop" });

  assert.equal(result.terminal, "complete");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].phase, "analyze");
  assert.deepEqual(bodies[0].manifest, {});
  assert.equal(bodies[0].trace_id, "trace-create-loop");
  assert.deepEqual(bodies[0].tools, PROTOCOL_TOOLS);
  assert.deepEqual(bodies[0].messages, [{ role: "user", content: "build a thermometer" }]);
});
