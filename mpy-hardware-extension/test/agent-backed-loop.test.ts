import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBackedLoop, estimateCredits } from "../src/core/agent-backed-loop.ts";

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

test("a continued session reuses the board profile and driver contexts without re-querying", async () => {
  // Turn 1 builds successfully (board queried, driver context fetched). Turn 2 goes
  // STRAIGHT to generate_code -> audit_code without calling query_board_profile. It
  // must still succeed and stay grounded: board + driver contexts persist on state,
  // so audit_code finds the board and the codegen prompt still carries both.
  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async () => {},
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2 LED=ON"] }),
  };

  let phase = 1;
  const turnIndex: Record<number, number> = { 1: 0, 2: 0 };
  const TURNS2 = [
    { name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } },
    { name: "audit_code", input: { content: AUDIT_CODE } },
    { name: "read_serial_until", input: { markers: ["MPYHW_READY", "TEMP_C="], port: "COM3" } },
  ];
  let boardFetchedInPhase2 = false;
  let codegenBodyPhase2: string | null = null;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        if (phase === 2) codegenBodyPhase2 = String(body.messages[0].content);
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "import time\nprint('MPYHW_READY')\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turns = phase === 1 ? TURNS : TURNS2;
      const turn = turns[turnIndex[phase]++];
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
      if (phase === 2) boardFetchedInPhase2 = true;
      return jsonResponse(BOARD);
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  const first = await loop({ intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1", confirmTool: async () => true });
  assert.equal(first.terminal, "success");

  phase = 2;
  const second = await loop({ intent: "make it blink faster", boardId: "esp32-s3-devkitc-1", state: first.state, confirmTool: async () => true });

  assert.equal(second.terminal, "success");
  assert.equal(boardFetchedInPhase2, false, "turn 2 must not re-query the board profile");
  assert.ok(codegenBodyPhase2, "expected a turn-2 codegen sub-call");
  // Board profile + driver context survived onto state and into the turn-2 codegen prompt.
  assert.match(codegenBodyPhase2!, /available_modules/);
  assert.match(codegenBodyPhase2!, /aht20/);
});

test("a serial read that never sees its markers drives repair exhaustion, not max_turns", async () => {
  // shim.serialReadUntil reports {ok:false} (device timeout / wrong output). The
  // executor must surface error_kind:"runtime_error" so repairRound increments
  // and the loop ends as repair_exhausted instead of spinning to max_turns.
  let turnIndex = 0;
  const turns = Array.from({ length: 5 }, () => ({ name: "read_serial_until", input: { markers: ["MPYHW_READY", "TEMP_C="], port: "COM3" } }));
  const shim = {
    installPackage: async () => {},
    writeMainPy: async () => {},
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: false, error: "timeout", lines: [] }),
  };
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1", confirmTool: async () => true });

  assert.equal(result.terminal, "repair_exhausted");
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

test("generate_code emits manifest_updated so the wiring view renders even without a prior propose_manifest", async () => {
  // Reproduces the wiring-never-appears bug: when the agent goes straight to
  // generate_code (propose_manifest never validated), the wiring panel listens
  // for manifest_updated, which only propose_manifest used to emit. The manifest
  // that produced the code must also reach the UI so wiring can render.
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
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')\nwhile True:\n    pass\n" } }),
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

  const manifestEvent = events.find((e) => e.type === "manifest_updated");
  assert.ok(manifestEvent, "expected manifest_updated from generate_code so wiring can render");
  assert.deepEqual(manifestEvent.manifest, manifest);
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

test("agent-backed loop appends a new user message when continuing prior state", async () => {
  let firstBody: any = null;
  const priorState = {
    traceId: "session",
    intent: "blink an led",
    boardId: "esp32-s3-devkitc-1",
    turnSeq: 1,
    repairRound: 0,
    loadedSkills: [],
    messages: [
      { role: "user", content: "blink an led" },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      if (firstBody === null) firstBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ type: "message_stop" })}` } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const result = await loop({ intent: "now make it blink faster", boardId: "esp32-s3-devkitc-1", state: priorState });

  assert.equal(firstBody.messages.length, 3);
  assert.deepEqual(firstBody.messages[0], priorState.messages[0]);
  assert.deepEqual(firstBody.messages[1], priorState.messages[1]);
  assert.deepEqual(firstBody.messages[2], { role: "user", content: "now make it blink faster" });
  assert.equal(result.state, priorState);
});

test("metered loop sends the auth token and forwards the credits balance to the UI", async () => {
  const authHeaders: Array<string | undefined> = [];
  const events: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      authHeaders.push((init?.headers as any)?.authorization);
      const sse = [
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "What should it do?" } }),
        JSON.stringify({ type: "credits", remaining: 47, daily_grant: 50, resets_at: "2026-06-02T00:00:00+00:00" }),
        JSON.stringify({ type: "message_stop" }),
      ].map((d) => `data: ${d}`).join("\n\n");
      return { ok: true, status: 200, text: async () => sse } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, getAuthToken: async () => "jwt-123" });
  await loop({ intent: "blink an led", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  assert.equal(authHeaders[0], "Bearer jwt-123");
  const credits = events.find((e) => e.kind === "credits");
  assert.ok(credits, "expected a credits event forwarded to the UI");
  assert.equal(credits.balance, 47);
  assert.equal(credits.dailyGrant, 50);
});

test("missing LLM key surfaces the upstream error instead of hanging", async () => {
  const fetchImpl = (async () => jsonResponse({ detail: { error: "llm_upstream_not_configured" } }, false)) as unknown as typeof fetch;
  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await assert.rejects(() => loop({ intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" }), /llm_upstream_not_configured/);
});

test("a stalled LLM request times out instead of hanging the session forever", { timeout: 2000 }, async () => {
  // The API process is alive but black-holes the request (never responds, never
  // errors). Without a request timeout the loop awaits forever and the UI spins
  // with no way to recover. A bounded timeout must reject so the session ends.
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      return new Promise(() => {}) as unknown as Response; // never settles
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, requestTimeoutMs: 25 });
  await assert.rejects(() => loop({ intent: "blink an led", boardId: "esp32-s3-devkitc-1" }), /request_timeout/);
});
