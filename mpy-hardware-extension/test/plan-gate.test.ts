import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBackedLoop, estimateCredits } from "../src/core/agent-backed-loop.ts";

const MANIFEST = {
  board_id: "esp32-c3-devkitm-1",
  capabilities: ["temperature_sensing", "digital_output"],
  packages: [{ name: "aht20_driver", version: "1.0.0" }],
  driver_context_refs: [],
  pins: { i2c_sda: "GPIO5", led_anode: "GPIO2" },
  logic: { threshold_c: 30, action: "led_on_above_threshold" },
  wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "led_anode", pin: "GPIO2" }],
};

function sseTurn(name: string, input: any): string {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id: name, name } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ].map((d) => `data: ${JSON.stringify(d)}`).join("\n\n");
}

const STOP = `data: ${JSON.stringify({ type: "message_stop" })}`;
const CODEGEN_SSE = [
  JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')\nwhile True:\n    pass\n" } }),
  JSON.stringify({ type: "message_stop" }),
].map((d) => `data: ${d}`).join("\n\n");

// Drives the loop with a scripted sequence of generate_code turns. Counts the
// nested (tools:[]) codegen sub-calls so a test can assert codegen did/didn't run.
function makeFetch(turns: Array<{ name: string; input: any }>) {
  let turnIndex = 0;
  const counts = { codegen: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        counts.codegen += 1;
        return { ok: true, status: 200, text: async () => CODEGEN_SSE } as unknown as Response;
      }
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseTurn(turn.name, turn.input) : STOP) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, counts };
}

test("estimateCredits = base 2 + one per driver package", () => {
  assert.equal(estimateCredits(MANIFEST), 3);
  assert.equal(estimateCredits({ packages: [] }), 2);
  assert.equal(estimateCredits({}), 2);
});

test("plan gate: declining the plan cancels codegen (no code, no spend)", async () => {
  const events: any[] = [];
  const plans: any[] = [];
  const { fetchImpl, counts } = makeFetch([{ name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } }]);

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "超过30度亮红灯",
    boardId: "esp32-c3-devkitm-1",
    onEvent: (e) => events.push(e),
    confirmPlan: async (plan) => { plans.push(plan); return false; },
  });

  assert.equal(plans.length, 1, "plan gate should fire exactly once");
  assert.equal(plans[0].estimate, 3);
  assert.deepEqual(plans[0].capabilities, ["temperature_sensing", "digital_output"]);
  assert.equal(counts.codegen, 0, "declined plan must not run the codegen sub-call");
  assert.ok(!events.some((e) => e.type === "code_updated"), "no code should be produced");
});

test("plan gate: confirming proceeds to codegen and emits code + wiring", async () => {
  const events: any[] = [];
  const { fetchImpl, counts } = makeFetch([{ name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } }]);

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "超过30度亮红灯",
    boardId: "esp32-c3-devkitm-1",
    onEvent: (e) => events.push(e),
    confirmPlan: async () => true,
  });

  assert.equal(counts.codegen, 1);
  assert.ok(events.some((e) => e.type === "code_updated"), "expected code_updated");
  assert.ok(events.some((e) => e.type === "manifest_updated"), "expected manifest_updated (wiring auto-renders)");
});

test("plan gate fires once per session: a repeated generate_code does not re-prompt", async () => {
  const { fetchImpl, counts } = makeFetch([
    { name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } },
    { name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } },
  ]);
  let planCalls = 0;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "超过30度亮红灯",
    boardId: "esp32-c3-devkitm-1",
    confirmPlan: async () => { planCalls += 1; return true; },
  });

  assert.equal(planCalls, 1, "plan confirmation must be asked only once per session");
  assert.equal(counts.codegen, 2, "both generate_code calls should run codegen");
});

test("headless (no confirmPlan) proceeds without gating", async () => {
  const events: any[] = [];
  const { fetchImpl, counts } = makeFetch([{ name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } }]);

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "x", boardId: "esp32-c3-devkitm-1", onEvent: (e) => events.push(e) });

  assert.equal(counts.codegen, 1);
  assert.ok(events.some((e) => e.type === "code_updated"));
});
