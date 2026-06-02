import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBackedLoop } from "../src/core/agent-backed-loop.ts";

const MANIFEST = {
  board_id: "esp32-s3-devkitc-1",
  capabilities: ["temperature_sensing", "digital_output"],
  packages: [{ name: "aht20_driver", version: "1.0.0" }, { name: "machine_pin_led", version: "builtin" }],
  driver_context_refs: ["aht20_driver@1.0.0", "machine_pin_led@builtin"],
  pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_anode: "GPIO2" },
  logic: { threshold_c: 30, action: "led_on_above_threshold" },
  wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }, { role: "led_anode", pin: "GPIO2" }],
};

const AHT20_CONTEXT = {
  package: { name: "aht20_driver", version: "1.0.0" },
  import_names: ["aht20"],
  constructors: ["AHT20(i2c)"],
  read_properties: ["temperature"],
  bus: ["i2c"],
  pin_roles: ["i2c_sda", "i2c_scl"],
  install: { url: "https://upypi.net/pkgs/aht20/1.0.0/package.json" },
};

const BOARD = {
  board_id: "esp32-s3-devkitc-1",
  available_modules: ["machine", "time", "math", "json"],
  pin_recommendations: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_default: "GPIO2" },
  pin_capabilities: { GPIO2: ["led_anode", "gpio_out"], GPIO5: ["i2c_sda"], GPIO6: ["i2c_scl"] },
};

const AUDIT_CODE = "from machine import Pin, I2C\nimport time\nimport aht20\n";

// One LLM turn per array entry: a single tool call followed by message_stop.
const TURNS: Array<{ name: string; input: any }> = [
  { name: "resolve_package_candidates", input: { intent: "超过30度亮红灯", capabilities: ["temperature_sensing", "digital_output"], board_id: "esp32-s3-devkitc-1" } },
  { name: "get_package_context", input: { name: "aht20_driver", version: "1.0.0" } },
  { name: "query_board_profile", input: { board_id: "esp32-s3-devkitc-1" } },
  { name: "propose_manifest", input: { manifest: MANIFEST } },
  { name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } },
  { name: "audit_code", input: { content: AUDIT_CODE } },
  { name: "install_package", input: { package_json_url: "https://upypi.net/pkgs/aht20/1.0.0/package.json", port: "COM3" } },
  { name: "write_main_py", input: { path: "main.py", content: AUDIT_CODE } },
  { name: "flash_and_run", input: { path: "main.py", port: "COM3" } },
  { name: "read_serial_until", input: { markers: ["MPYHW_READY", "TEMP_C="], port: "COM3" } },
];

function sseForTurn(turn: { name: string; input: any }): string {
  return [
    JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: turn.name, name: turn.name } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } }),
    JSON.stringify({ type: "content_block_stop" }),
    JSON.stringify({ type: "message_stop" }),
  ].map((data) => `data: ${data}`).join("\n\n");
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

test("agent-backed loop runs intent -> packages -> manifest -> code -> deploy -> serial and terminates success", async () => {
  let turnIndex = 0;
  const shimCalls: string[] = [];
  const events: any[] = [];

  const shim = {
    scan: async () => ["COM3"],
    installPackage: async (url: string) => void shimCalls.push(`install:${url}`),
    writeMainPy: async (content: string) => void shimCalls.push(content.includes("aht20") ? "write:ok" : "write:bad"),
    flashAndRun: async (path: string) => void shimCalls.push(`run:${path}`),
    serialReadUntil: async () => (shimCalls.push("serial"), { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] }),
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        // Nested codegen sub-call: the LLM streams back main.py.
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "import time\nprint('MPYHW_READY')\nwhile True:\n    temp_c = sensor.temperature\n    time.sleep(1)\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = TURNS[turnIndex++];
      const text = turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`;
      return { ok: true, status: 200, text: async () => text } as unknown as Response;
    }
    if (url.endsWith("/v1/packages/resolve")) {
      return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
    }
    if (url.includes("/driver-context")) {
      return jsonResponse(AHT20_CONTEXT);
    }
    if (url.includes("/v1/boards/")) {
      return jsonResponse(BOARD);
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  const result = await loop({
    intent: "超过30度亮红灯",
    boardId: "esp32-s3-devkitc-1",
    onEvent: (event) => events.push(event),
    confirmTool: async () => true,
  });

  assert.equal(result.terminal, "success");

  // Device tools ran in the right order against the (fake) shim.
  assert.deepEqual(shimCalls, ["install:https://upypi.net/pkgs/aht20/1.0.0/package.json", "write:ok", "run:main.py", "serial"]);

  // The loop surfaced real artifacts to the UI.
  const code = events.find((event) => event.type === "code_updated");
  assert.ok(code, "expected code_updated event");
  assert.match(code.code, /MPYHW_READY/);
  assert.match(code.code, /sensor\.temperature/);
  assert.ok(events.some((event) => event.type === "manifest_updated"), "expected manifest_updated event");
  const serial = events.find((event) => event.type === "serial_output");
  assert.ok(serial, "expected serial_output event");
  assert.deepEqual(serial.lines, ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]);
});

test("device-touching tools are skipped when the user declines confirmation", async () => {
  let turnIndex = 0;
  let installed = false;
  const shim = {
    installPackage: async () => void (installed = true),
    writeMainPy: async () => {},
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] }),
  };
  const turns = [{ name: "install_package", input: { package_json_url: "u", port: "COM3" } }, { name: "read_serial_until", input: { markers: ["MPYHW_READY", "TEMP_C="] } }];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1", confirmTool: async () => false });

  assert.equal(installed, false);
  assert.equal(result.terminal, "success");
});

test("generate_code uses grounded LLM generation (one path) and strips code fences", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["display_text"],
    pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6" },
    wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }],
  };
  const turns = [{ name: "generate_code", input: { manifest, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        // Nested, tool-free codegen sub-call: stream back fenced code.
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "```python\nprint('MPYHW_READY')\n" } }),
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "while True:\n    pass\n```" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "show the temperature on an OLED screen", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e), confirmTool: async () => true });

  const code = events.find((e) => e.type === "code_updated");
  assert.ok(code, "expected code_updated from the LLM fallback");
  assert.match(code.code, /MPYHW_READY/);
  assert.doesNotMatch(code.code, /```/);
});

test("opening turn tells the agent to recommend a board when none is chosen", async () => {
  let firstBody: any = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      if (firstBody === null) firstBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ type: "message_stop" })}` } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "make a plant waterer",
    boardId: "auto",
    availableBoards: [{ board_id: "esp32-s3-devkitc-1", display_name: "ESP32-S3" }, { board_id: "rpi-pico-w" }],
  });

  const opening = firstBody.messages[0].content;
  assert.match(opening, /Recommend/i);
  assert.match(opening, /esp32-s3-devkitc-1/);
});

test("opening turn tells the agent to use an already-selected board instead of asking", async () => {
  let firstBody: any = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      if (firstBody === null) firstBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ type: "message_stop" })}` } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "blink an led", boardId: "esp32-s3-devkitc-1" });

  const opening = firstBody.messages[0].content;
  assert.match(opening, /already selected/i);
  assert.match(opening, /esp32-s3-devkitc-1/);
  assert.doesNotMatch(opening, /Recommend/i);
});

test("missing LLM key surfaces the upstream error instead of hanging", async () => {
  const fetchImpl = (async () => jsonResponse({ detail: { error: "llm_upstream_not_configured" } }, false)) as unknown as typeof fetch;
  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await assert.rejects(() => loop({ intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" }), /llm_upstream_not_configured/);
});
