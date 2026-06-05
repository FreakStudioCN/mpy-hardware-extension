import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBackedLoop, estimateCredits } from "../src/core/agent-backed-loop.ts";

const MANIFEST = {
  schema_version: "1.0",
  phase: "select-hw",
  created_at: "2026-06-04T00:00:00Z",
  project_name: "temp-led",
  requirements: { description: "Turn on the LED when the temperature is above 30 C." },
  devices: [
    { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"], driver: { package_name: "aht20_driver", version: "1.0.0" } },
    { name: "Status LED", type: "led", interface: "GPIO", driver: { package_name: "machine_pin_led", version: "builtin" } },
  ],
  mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
  pinout: [
    { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO5" },
    { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO6" },
    { device: "Status LED", pin_name: "LED", gpio: "GPIO2" },
  ],
  board_id: "esp32-s3-devkitc-1",
  capabilities: ["temperature_sensing", "digital_output"],
  packages: [{ name: "aht20_driver", version: "1.0.0" }, { name: "machine_pin_led", version: "builtin" }],
  driver_context_refs: ["aht20_driver@1.0.0", "machine_pin_led@builtin"],
  pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_anode: "GPIO2" },
  logic: { threshold_c: 30, action: "led_on_above_threshold" },
  wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }, { role: "led_anode", pin: "GPIO2" }],
};

const THIN_MANIFEST = {
  board_id: "esp32-s3-devkitc-1",
  capabilities: ["temperature_sensing", "digital_output"],
  packages: [{ name: "aht20_driver", version: "1.0.0" }],
  driver_context_refs: ["aht20_driver@1.0.0"],
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
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "import time\nimport aht20\nprint('MPYHW_READY')\nwhile True:\n    temp_c = sensor.temperature\n    time.sleep(1)\n" } }),
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
    onEvent: (event) => events.push(event),  });

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
  const first = await loop({ intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });
  assert.equal(first.terminal, "success");

  phase = 2;
  const second = await loop({ intent: "make it blink faster", boardId: "esp32-s3-devkitc-1", state: first.state });

  assert.equal(second.terminal, "success");
  assert.equal(boardFetchedInPhase2, false, "turn 2 must not re-query the board profile");
  assert.ok(codegenBodyPhase2, "expected a turn-2 codegen sub-call");
  // Board profile + driver context survived onto state and into the turn-2 codegen prompt.
  assert.match(codegenBodyPhase2!, /available_modules/);
  assert.match(codegenBodyPhase2!, /aht20/);
});

test("load_skill persists the skill body into later agent and codegen requests", async () => {
  let turnIndex = 0;
  const agentRequestBodies: any[] = [];
  const codegenRequestBodies: any[] = [];
  const turns = [
    { name: "load_skill", input: { skill: "upy-gen-main" } },
    { name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } },
  ];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/skills")) {
      return jsonResponse({ skills: [{ name: "upy-gen-main", description: "Generate MicroPython main.py" }] });
    }
    if (url.endsWith("/v1/skills/upy-gen-main")) {
      return { ok: true, status: 200, text: async () => "# upy-gen-main\nAlways print MPYHW_READY." } as unknown as Response;
    }
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenRequestBodies.push(body);
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      agentRequestBodies.push(body);
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const state = { traceId: "session", intent: "x", boardId: "esp32-s3-devkitc-1", turnSeq: 0, repairRound: 0, textOnlyTurns: 0, loadedSkills: [], messages: [], board: BOARD, driverContexts: [AHT20_CONTEXT] };
  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const result = await loop({ intent: "use the main.py conventions", boardId: "esp32-s3-devkitc-1", state });

  assert.deepEqual(result.state.loadedSkills, ["upy-gen-main"]);
  assert.match(JSON.stringify(agentRequestBodies[0].messages), /AVAILABLE SKILLS/);
  // Append-only: the catalog lives in the durable opening (message[0]), so it is
  // present every round — but as a byte-stable prefix (a cache HIT), not re-sent as
  // a shifting front block. message[0] is therefore identical across rounds.
  assert.match(JSON.stringify(agentRequestBodies[1].messages), /AVAILABLE SKILLS/);
  assert.equal(
    JSON.stringify(agentRequestBodies[1].messages[0]),
    JSON.stringify(agentRequestBodies[0].messages[0]),
    "the catalog-bearing opening must stay byte-identical round-over-round",
  );
  // The skill body reaches later agent requests via the load_skill tool_result
  // (appended at the tail), and the codegen sub-call still grounds on it.
  assert.match(JSON.stringify(agentRequestBodies[1].messages), /Always print MPYHW_READY/);
  assert.match(JSON.stringify(codegenRequestBodies[0].messages), /Always print MPYHW_READY/);
});

test("agent requests stay append-only across rounds (prefix-stable for DeepSeek's cache)", async () => {
  // The whole credit fix rides on this invariant: each round's request must be a pure
  // TAIL-APPEND of the previous one — never prepend, re-render, reorder, or stub an
  // earlier message. When the prefix bytes diverge, DeepSeek re-bills the whole cached
  // context at full price (the bust that drained a day's credits in one session).
  let turnIndex = 0;
  const agentRequests: any[] = [];
  const turns = [
    { name: "load_skill", input: { skill: "upy-gen-main" } },          // mid-session skill load — the worst prior offender
    { name: "query_board_profile", input: { board_id: "esp32-s3-devkitc-1" } },
    { name: "get_package_context", input: { name: "aht20_driver", version: "1.0.0" } },
    { name: "resolve_package_candidates", input: { intent: "x", capabilities: ["temperature_sensing"], board_id: "esp32-s3-devkitc-1" } },
  ];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/skills")) return jsonResponse({ skills: [{ name: "upy-gen-main", description: "Generate MicroPython main.py" }] });
    if (url.endsWith("/v1/skills/upy-gen-main")) return { ok: true, status: 200, text: async () => "# upy-gen-main\nAlways print MPYHW_READY." } as unknown as Response;
    if (url.endsWith("/v1/llm/messages")) {
      agentRequests.push(JSON.parse(String(init?.body ?? "{}")));
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    if (url.endsWith("/v1/packages/resolve")) return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
    if (url.includes("/driver-context")) return jsonResponse(AHT20_CONTEXT);
    if (url.includes("/v1/boards/")) return jsonResponse(BOARD);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  assert.ok(agentRequests.length >= 4, `expected several rounds, got ${agentRequests.length}`);
  // Per-message equality of the shared prefix: because the backend serializes each
  // message deterministically and in order, an unchanged message-prefix means the
  // request's leading BYTES are identical round-over-round (the cache-hit condition).
  for (let r = 1; r < agentRequests.length; r++) {
    const prev = agentRequests[r - 1].messages;
    const curr = agentRequests[r].messages;
    assert.ok(curr.length >= prev.length, `round ${r} shrank the history (${prev.length} -> ${curr.length})`);
    for (let i = 0; i < prev.length; i++) {
      assert.equal(JSON.stringify(curr[i]), JSON.stringify(prev[i]), `round ${r} mutated message[${i}] — prefix bust`);
    }
  }

  // The loaded skill body entered the history exactly once (the load_skill
  // tool_result), not re-rendered into a front block that shifts every round.
  const finalJson = JSON.stringify(agentRequests.at(-1).messages);
  assert.equal(finalJson.split("Always print MPYHW_READY").length - 1, 1, "skill body must appear exactly once (append-only)");
});

test("thinking-mode reasoning round-trips: a thinking_delta is stored as a thinking block on the assistant turn", async () => {
  // DeepSeek thinking mode streams reasoning_content (surfaced as thinking_delta) and
  // then 400s the next tool-calling round if that reasoning is not passed back. The
  // loop must store it as a thinking block on the assistant turn so it round-trips.
  let turnIndex = 0;
  const agentRequests: any[] = [];
  const sseThink = (reasoning: string, turn: { name: string; input: any }) => [
    JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: reasoning } }),
    JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: turn.name, name: turn.name } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } }),
    JSON.stringify({ type: "content_block_stop" }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");
  const turns = [
    { name: "query_board_profile", input: { board_id: "esp32-s3-devkitc-1" } },
    { name: "resolve_package_candidates", input: { intent: "x", capabilities: ["temperature_sensing"], board_id: "esp32-s3-devkitc-1" } },
  ];
  const reasonings = ["Check the board pins first.", "Now pick a driver package."];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      agentRequests.push(JSON.parse(String(init?.body ?? "{}")));
      const turn = turns[turnIndex];
      const reasoning = reasonings[turnIndex];
      turnIndex++;
      return { ok: true, status: 200, text: async () => (turn ? sseThink(reasoning, turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    if (url.includes("/v1/boards/")) return jsonResponse(BOARD);
    if (url.endsWith("/v1/packages/resolve")) return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  // The request for turn 1 must carry turn 0's reasoning as a thinking block on the
  // assistant message, first in the content array (so the server re-attaches it as
  // reasoning_content for DeepSeek).
  const assistantMsg = agentRequests[1].messages.find((m: any) => m.role === "assistant");
  assert.ok(assistantMsg, "expected an assistant message in the second request");
  assert.equal(assistantMsg.content[0].type, "thinking");
  assert.equal(assistantMsg.content[0].thinking, "Check the board pins first.");
  assert.ok(assistantMsg.content.some((b: any) => b.type === "tool_use"), "assistant turn keeps its tool_use");
});

test("loading an already loaded skill is a noop and does not fetch the body again", async () => {
  let skillBodyFetches = 0;
  let turnIndex = 0;
  const turns = [
    { name: "load_skill", input: { skill: "upy-gen-main" } },
    { name: "load_skill", input: { skill: "upy-gen-main" } },
  ];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/skills")) {
      return jsonResponse({ skills: [{ name: "upy-gen-main", description: "Generate MicroPython main.py" }] });
    }
    if (url.endsWith("/v1/skills/upy-gen-main")) {
      skillBodyFetches += 1;
      return { ok: true, status: 200, text: async () => "# upy-gen-main" } as unknown as Response;
    }
    if (url.endsWith("/v1/llm/messages")) {
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(result.state.loadedSkills, ["upy-gen-main"]);
  assert.equal(skillBodyFetches, 1);
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
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1" });

  assert.equal(result.terminal, "repair_exhausted");
});

test("declining the deploy checkpoint ends the build cleanly as generated", async () => {
  let turnIndex = 0;
  let installed = false;
  let deployPrompts = 0;
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
  // Decline the deploy gate: install_package is cancelled (never touches the device)
  // and the deliberate decline ends the session as "generated" rather than letting the
  // model thrash on retries (which the old neutral-cancel path ground to manifest_unresolved).
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1", confirmDeploy: async () => { deployPrompts += 1; return false; } });

  assert.equal(installed, false);
  assert.equal(deployPrompts, 1, "deploy gate fires before the first device tool");
  assert.equal(result.terminal, "generated");
});

test("the deploy checkpoint fires once before the first device tool, not per tool", async () => {
  let turnIndex = 0;
  let deployPrompts = 0;
  const shimCalls: string[] = [];
  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => void shimCalls.push("install"),
    writeMainPy: async () => void shimCalls.push("write"),
    flashAndRun: async () => void shimCalls.push("flash"),
    serialReadUntil: async () => (shimCalls.push("serial"), { ok: true, lines: ["MPYHW_READY", "TEMP_C=31.2"] }),
  };
  const turns = [
    { name: "install_package", input: { package_json_url: "u", port: "COM3" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('MPYHW_READY')" } },
    { name: "flash_and_run", input: { path: "main.py", port: "COM3" } },
    { name: "read_serial_until", input: { markers: ["MPYHW_READY", "TEMP_C="], port: "COM3" } },
  ];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1", confirmDeploy: async () => { deployPrompts += 1; return true; } });

  assert.equal(result.terminal, "success");
  assert.equal(deployPrompts, 1, "confirmed once, not re-prompted for write/flash");
  assert.deepEqual(shimCalls, ["install", "flash", "serial"]);
});

test("generate_code streams the generation as code_delta then a final code_updated", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = MANIFEST;
  const turns = [{ name: "generate_code", input: { manifest, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        // Two text chunks: the loop must surface each as a code_delta and only
        // emit the assembled, fence-stripped file once via code_updated.
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
  await loop({ intent: "show the temperature on an OLED screen", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  const deltas = events.filter((e) => e.type === "code_delta");
  assert.equal(deltas.length, 2, "each text chunk streams as a code_delta");
  assert.ok(deltas.every((d) => d.path === "main.py"), "deltas carry the target path");
  const updated = events.find((e) => e.type === "code_updated");
  assert.ok(updated, "expected a terminal code_updated");
  assert.match(updated.code, /MPYHW_READY/);
  assert.doesNotMatch(updated.code, /```/, "the finished file is fence-stripped");
  // code_updated lands after the deltas (the streaming card finalizes last).
  assert.ok(events.indexOf(updated) > events.lastIndexOf(deltas[1]));
});

test("generate_code uses grounded LLM generation (one path) and strips code fences", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = MANIFEST;
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
  await loop({ intent: "show the temperature on an OLED screen", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  const code = events.find((e) => e.type === "code_updated");
  assert.ok(code, "expected code_updated from the LLM fallback");
  assert.match(code.code, /MPYHW_READY/);
  assert.doesNotMatch(code.code, /```/);
});

test("generate_code routes a non-main target_path to module-rules codegen and tags the event path", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  let codegenPrompt = "";
  const manifest = MANIFEST;
  const turns = [{ name: "generate_code", input: { manifest, target_path: "lib/aht20.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenPrompt = body.messages?.[0]?.content ?? "";
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "class AHT20:\n    pass\n" } }),
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
  await loop({ intent: "thermometer", boardId: "esp32-s3-devkitc-1", onEvent: (e: any) => events.push(e) });

  const code = events.find((e) => e.type === "code_updated");
  assert.ok(code, "expected code_updated");
  assert.equal(code.path, "lib/aht20.py");
  assert.match(codegenPrompt, /complete contents of lib\/aht20\.py/);
  assert.match(codegenPrompt, /importable module/);
  assert.doesNotMatch(codegenPrompt, /MPYHW_READY/);
});

test("generate_code persists through the injected writeProjectFile and emits file_written", async () => {
  // The firmware tree must be written via the allowProjectTree channel DURING the
  // loop (not via the narrow post-loop batch, which rejects firmware/ paths).
  let mainTurns = 0;
  const events: any[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const turns = [{ name: "generate_code", input: { manifest: MANIFEST, target_path: "firmware/main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl,
    writeProjectFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path: `C:/project/${path}` }; },
  });
  await loop({ intent: "blink", boardId: "esp32-s3-devkitc-1", onEvent: (e: any) => events.push(e) });

  assert.deepEqual(writes.map((w) => w.path), ["firmware/main.py"], "generate_code persists its output during the loop");
  assert.match(writes[0].content, /MPYHW_READY/);
  assert.deepEqual(events.find((e) => e.type === "file_written"), { type: "file_written", path: "C:/project/firmware/main.py" });
});

test("generate_code surfaces a persist rejection as its tool error_kind (in-loop, not silent post-loop)", async () => {
  let mainTurns = 0;
  const recorded: any[] = [];
  const turns = [{ name: "generate_code", input: { manifest: MANIFEST, target_path: "boot.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('x')\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl,
    writeProjectFile: async (path: string) => ({ ok: false, error_kind: "invalid_generated_path", path }),
  });
  await loop({
    intent: "blink",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async (e: any) => { recorded.push(e); } },
  });

  const result = recorded.find((e) => e.type === "tool_result" && e.name === "generate_code");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "invalid_generated_path");
});

test("codegen retries once on a clean-but-empty stream and asks for a larger max_tokens", async () => {
  // The failure that motivated this: a reasoning model finished its codegen turn
  // cleanly (finish_reason "length") having spent the whole 4096 budget on reasoning,
  // returning zero answer text. That empty-but-clean result must be retried once (and
  // codegen asks for more output room than a normal agent turn).
  let mainTurns = 0;
  let codegenCalls = 0;
  let codegenMaxTokens: number | undefined;
  const events: any[] = [];
  const turns = [{ name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenCalls += 1;
        codegenMaxTokens = body.max_tokens;
        const chunks = codegenCalls === 1
          ? [{ type: "message_stop", finish_reason: "length" }] // clean completion, no text
          : [
              { type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')\nwhile True:\n    pass\n" } },
              { type: "message_stop", finish_reason: "stop" },
            ];
        const sse = chunks.map((d) => `data: ${JSON.stringify(d)}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "blink an LED", boardId: "esp32-s3-devkitc-1", onEvent: (e: any) => events.push(e) });

  assert.equal(codegenCalls, 2, "an empty first generation is retried exactly once");
  assert.equal(codegenMaxTokens, 8192, "codegen requests a larger output budget than a normal turn");
  const code = events.find((e: any) => e.type === "code_updated");
  assert.ok(code, "the retry produced a non-empty file");
  assert.match(code.code, /MPYHW_READY/);
});

test("a codegen stream error surfaces as an upstream failure and is not retried", async () => {
  // A mid-stream drop arrives as an `error` SSE event (mapped to stream_error), NOT a
  // thrown error. It must be distinguished from a clean-empty result: surfaced as an
  // upstream failure and NOT retried (a re-prompt won't fix a transport drop).
  let mainTurns = 0;
  let codegenCalls = 0;
  const recorded: any[] = [];
  const turns = [{ name: "generate_code", input: { manifest: MANIFEST, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenCalls += 1;
        const sse = [
          { type: "content_block_delta", delta: { type: "text_delta", text: "import time\n" } },
          { type: "error", error: { message: "upstream_stream_interrupted" } },
        ].map((d) => `data: ${JSON.stringify(d)}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "blink an LED", boardId: "esp32-s3-devkitc-1", recorder: { record: async (e: any) => { recorded.push(e); } } });

  assert.equal(codegenCalls, 1, "a stream error is a transport failure, not retried");
  const result = recorded.find((e: any) => e.type === "tool_result" && e.name === "generate_code");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "codegen_failed");
  assert.equal(result?.observation?.output?.error, "codegen_upstream_unavailable");
});

test("read_workspace_file dispatches to the injected host reader (and reports unavailable without one)", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };

  const reads: string[] = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "read_workspace_file", input: { path: "lib/aht20.py" } }]),
    readWorkspaceFile: async (path: string) => { reads.push(path); return { ok: true, content: "class AHT20: pass" }; },
  });
  await loop({ intent: "read a file", boardId: "esp32-s3-devkitc-1" });
  assert.deepEqual(reads, ["lib/aht20.py"], "reader called with the requested path");

  // No reader injected (headless): the tool reports workspace_unavailable and the loop still finishes.
  const observations: any[] = [];
  const loop2 = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "read_workspace_file", input: { path: "lib/aht20.py" } }]),
  });
  const result = await loop2({
    intent: "read a file",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async (e: any) => { observations.push(e); } },
  });
  assert.ok(result, "loop finishes without a workspace reader");
  assert.ok(
    observations.some((e) => JSON.stringify(e).includes("workspace_unavailable")),
    "missing reader surfaces workspace_unavailable",
  );
});

test("write_project_file dispatches to the injected host writer and mirrors into state.files", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };

  const writes: Array<{ path: string; content: string }> = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "write_project_file", input: { path: "firmware/tasks/sensor.py", content: "def tick():\n    pass\n" } }]),
    writeProjectFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path: `C:/project/${path}` }; },
  });
  const { state } = await loop({ intent: "write a file", boardId: "esp32-s3-devkitc-1" });
  assert.deepEqual(writes, [{ path: "firmware/tasks/sensor.py", content: "def tick():\n    pass\n" }], "writer called with path + content");
  assert.equal(state.files["firmware/tasks/sensor.py"], "def tick():\n    pass\n", "written file mirrored into state.files for deploy");

  // No writer injected (headless): the tool reports workspace_unavailable and the loop still finishes.
  const observations: any[] = [];
  const loop2 = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "write_project_file", input: { path: "firmware/main.py", content: "x" } }]),
  });
  const result = await loop2({
    intent: "write a file",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async (e: any) => { observations.push(e); } },
  });
  assert.ok(result, "loop finishes without a workspace writer");
  assert.ok(
    observations.some((e) => JSON.stringify(e).includes("workspace_unavailable")),
    "missing writer surfaces workspace_unavailable",
  );
});

test("propose_manifest (rich) tracks phase, renders derived wiring, and persists the manifest", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };

  const richManifest = {
    schema_version: "1.0",
    phase: "select-hw",
    created_at: "2026-06-04T00:00:00Z",
    project_name: "temp-display",
    requirements: { description: "用 ssd1306 显示温度" },
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
    ],
    mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO9" },
    ],
  };

  const writes: Array<{ path: string; content: string }> = [];
  const events: any[] = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "propose_manifest", input: { manifest: richManifest } }]),
    writeProjectFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path }; },
  });
  const { state } = await loop({ intent: "用 ssd1306 显示温度", boardId: "esp32-s3-devkitc-1", onEvent: (e: any) => events.push(e) });

  // Phase + manifest tracked on state.
  assert.equal(state.phase, "select-hw");
  assert.equal(state.manifest.project_name, "temp-display");

  // manifest_updated carries DERIVED device-identity wiring: one I2C bus, two
  // device entries, no phantom card.
  const updated = events.find((e) => e.type === "manifest_updated");
  assert.ok(updated, "manifest_updated emitted");
  assert.equal(updated.manifest.wiring.buses.length, 1);
  assert.deepEqual(updated.manifest.wiring.buses[0].devices.map((d: any) => d.name), ["SSD1306 OLED", "AHT20"]);
  assert.equal(updated.manifest.wiring.standalone.length, 0);

  // diagram_updated is emitted alongside, feeding the Diagram tab the same moment
  // wiring renders: a driver layer with one module per device.
  const diagramEvent = events.find((e) => e.type === "diagram_updated");
  assert.ok(diagramEvent, "diagram_updated emitted");
  const driverLayer = diagramEvent.diagram.architecture.layers.find((l: any) => l.id === "driver");
  assert.deepEqual(driverLayer.modules.map((m: any) => m.name), ["SSD1306 OLED", "AHT20"]);

  // The rich manifest is persisted to the project tree.
  const persisted = writes.find((w) => w.path === "project-manifest.json");
  assert.ok(persisted, "project-manifest.json written");
  assert.equal(JSON.parse(persisted!.content).project_name, "temp-display");
});

test("propose_manifest component gate trims unticked devices and asks the agent to revise", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  const richManifest = {
    schema_version: "1.0", phase: "analyze", created_at: "2026-06-04T00:00:00Z", project_name: "pet",
    requirements: { description: "x" },
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
    ],
    mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO9" },
    ],
  };
  const seen: string[] = [];
  const recorded: any[] = [];
  const events: any[] = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "propose_manifest", input: { manifest: richManifest } }]),
    writeProjectFile: async (path: string) => ({ ok: true, path }),
  });
  await loop({
    intent: "x", boardId: "esp32-s3-devkitc-1",
    onEvent: (e: any) => events.push(e),
    recorder: { record: async (e: any) => { recorded.push(e); } },
    confirmComponents: async (devices: any[]) => { seen.push(...devices.map((d) => d.name)); return { action: "confirm", devices: ["SSD1306 OLED"], feedback: "" }; },
  });

  // The gate is shown the proposed devices, and an unticked device comes back as a
  // revision request (not a committed manifest) so the agent re-proposes devices[].
  assert.deepEqual(seen, ["SSD1306 OLED", "AHT20"]);
  const result = recorded.find((e: any) => e.type === "tool_result" && e.name === "propose_manifest");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "components_revision_requested");
  // The full tool output (incl. removed/add) is preserved under observation.output,
  // which is what the agent sees in the serialized tool_result.
  assert.deepEqual(result?.observation?.output?.removed, ["AHT20"]);
  assert.ok(!events.some((e: any) => e.type === "manifest_updated"), "a revision request does not commit the manifest");
});

test("propose_manifest component gate re-confirms after a requested revision", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  const base = {
    schema_version: "1.0", created_at: "2026-06-04T00:00:00Z", project_name: "pet",
    requirements: { description: "x" },
    mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
  };
  const firstManifest = {
    ...base,
    phase: "analyze",
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "AHT20", type: "temperature_sensor", interface: "I2C", i2c_addr: ["0x38"] },
    ],
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "AHT20", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "AHT20", pin_name: "I2C0 SCL", gpio: "GPIO9" },
    ],
  };
  const revisedManifest = {
    ...base,
    phase: "analyze",
    devices: [
      { name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] },
      { name: "DHT22", type: "humidity_sensor", interface: "GPIO" },
    ],
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
      { device: "DHT22", pin_name: "DATA", gpio: "GPIO4" },
    ],
  };
  const seen: string[][] = [];
  const events: any[] = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([
      { name: "propose_manifest", input: { manifest: firstManifest } },
      { name: "propose_manifest", input: { manifest: revisedManifest } },
    ]),
  });
  const { state } = await loop({
    intent: "x", boardId: "esp32-s3-devkitc-1",
    onEvent: (e: any) => events.push(e),
    confirmComponents: async (devices: any[]) => {
      seen.push(devices.map((d) => d.name));
      if (seen.length === 1) return { action: "confirm", devices: ["SSD1306 OLED"], feedback: "Add DHT22" };
      return { action: "confirm", devices: ["SSD1306 OLED", "DHT22"], feedback: "" };
    },
  });

  assert.deepEqual(seen, [["SSD1306 OLED", "AHT20"], ["SSD1306 OLED", "DHT22"]]);
  assert.equal(state.componentsConfirmed, true);
  assert.ok(events.some((e: any) => e.type === "manifest_updated"), "the revised clean confirm commits the manifest");
});

test("propose_manifest component gate proceeds on a clean confirm and fires only once", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  const base = {
    schema_version: "1.0", created_at: "2026-06-04T00:00:00Z", project_name: "pet",
    requirements: { description: "x" },
    devices: [{ name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] }],
    mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
    pinout: [
      { device: "SSD1306 OLED", pin_name: "I2C0 SDA", gpio: "GPIO8" },
      { device: "SSD1306 OLED", pin_name: "I2C0 SCL", gpio: "GPIO9" },
    ],
  };
  let calls = 0;
  const writes: any[] = [];
  const events: any[] = [];
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([
      { name: "propose_manifest", input: { manifest: { ...base, phase: "analyze" } } },
      { name: "propose_manifest", input: { manifest: { ...base, phase: "select-hw" } } },
    ]),
    writeProjectFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path }; },
  });
  const { state } = await loop({
    intent: "x", boardId: "esp32-s3-devkitc-1",
    onEvent: (e: any) => events.push(e),
    confirmComponents: async () => { calls += 1; return { action: "confirm" }; },
  });

  assert.equal(calls, 1, "the gate fires once, not on every propose_manifest");
  assert.equal(state.componentsConfirmed, true);
  assert.ok(events.some((e: any) => e.type === "manifest_updated"), "a clean confirm commits the manifest");
  assert.ok(writes.some((w: any) => w.path === "project-manifest.json"), "manifest persisted after confirm");
});

test("ask_user used for component list confirmation is routed to the multi-select component gate", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  const recorded: any[] = [];
  const seen: string[] = [];
  let askUserCalled = false;
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{
      name: "ask_user",
      input: {
        question: "请确认器件清单",
        options: ["SSD1306 OLED", "WS2812 RGB LED"],
      },
    }]),
  });

  await loop({
    intent: "x",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async (e: any) => { recorded.push(e); } },
    askUser: async () => { askUserCalled = true; return "should not be used"; },
    confirmComponents: async (devices: any[]) => {
      seen.push(...devices.map((d) => d.name));
      return { action: "confirm", devices: ["SSD1306 OLED"], feedback: "加 DHT22" };
    },
  });

  assert.equal(askUserCalled, false, "component confirmation should not render as a normal single-choice ask_user prompt");
  assert.deepEqual(seen, ["SSD1306 OLED", "WS2812 RGB LED"]);
  const result = recorded.find((e: any) => e.type === "tool_result" && e.name === "ask_user");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "components_revision_requested");
  assert.deepEqual(result?.observation?.output?.removed, ["WS2812 RGB LED"]);
  assert.equal(result?.observation?.output?.add, "加 DHT22");
});

test("ask_user component confirmation fires the multi-select gate only once per session", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  let confirmCalls = 0;
  let askUserCalls = 0;
  const componentAsk = { name: "ask_user", input: { question: "请确认器件清单", options: ["SSD1306 OLED", "AHT20"] } };
  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl: mkFetch([componentAsk, componentAsk]) });

  await loop({
    intent: "x",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async () => {} },
    askUser: async () => { askUserCalls += 1; return "ok"; },
    confirmComponents: async (devices: any[]) => {
      confirmCalls += 1;
      return { action: "confirm", devices: devices.map((d) => d.name), feedback: "" }; // clean confirm
    },
  });

  assert.equal(confirmCalls, 1, "the component multi-select card is shown once, not re-fired every turn");
  assert.equal(askUserCalls, 1, "a second component-list ask_user falls through to a normal prompt");
});

test("ask_user whose question merely contains 'bomb' is NOT mis-routed to the component gate", async () => {
  const mkFetch = (turns: any[]) => {
    let i = 0;
    return (async (url: string) => {
      if (url.endsWith("/v1/llm/messages")) {
        const turn = turns[i++];
        return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  };
  let confirmCalled = false;
  let askedQuestion = "";
  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: mkFetch([{ name: "ask_user", input: { question: "Should I add a bombproof enclosure or a ventilated one?", options: ["bombproof", "ventilated"] } }]),
  });

  await loop({
    intent: "x",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async () => {} },
    askUser: async (q: string) => { askedQuestion = q; return "ventilated"; },
    confirmComponents: async () => { confirmCalled = true; return { action: "confirm", devices: [] }; },
  });

  assert.equal(confirmCalled, false, "a bare 'bomb' substring must not trigger the component multi-select gate");
  assert.match(askedQuestion, /bombproof/);
});

test("propose_manifest rejects legacy thin manifests on the agent path", async () => {
  const recorded: any[] = [];
  const events: any[] = [];
  let turn = 0;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const tool = turn++ === 0 ? { name: "propose_manifest", input: { manifest: THIN_MANIFEST } } : null;
      return { ok: true, status: 200, text: async () => (tool ? sseForTurn(tool) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const { state } = await loop({
    intent: "thermometer",
    boardId: "esp32-s3-devkitc-1",
    onEvent: (event) => events.push(event),
    recorder: { record: async (event: any) => { recorded.push(event); } },
  });

  assert.equal(state.manifest, undefined);
  assert.ok(!events.some((event) => event.type === "manifest_updated"), "thin manifest must not update the UI");
  const result = recorded.find((event) => event.type === "tool_result" && event.name === "propose_manifest");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "manifest_contract_error");
  assert.match(JSON.stringify(result?.observation), /schema_version/);
});

test("generate_code rejects legacy thin manifests before plan gate or codegen", async () => {
  const recorded: any[] = [];
  const events: any[] = [];
  let turn = 0;
  let codegenCalls = 0;
  let planCalls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenCalls += 1;
        return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ type: "message_stop" })}` } as unknown as Response;
      }
      const tool = turn++ === 0 ? { name: "generate_code", input: { manifest: THIN_MANIFEST, target_path: "main.py" } } : null;
      return { ok: true, status: 200, text: async () => (tool ? sseForTurn(tool) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "thermometer",
    boardId: "esp32-s3-devkitc-1",
    onEvent: (event) => events.push(event),
    recorder: { record: async (event: any) => { recorded.push(event); } },
    confirmPlan: async () => { planCalls += 1; return { action: "confirm" }; },
  });

  assert.equal(planCalls, 0, "thin manifest must be rejected before the plan gate");
  assert.equal(codegenCalls, 0, "thin manifest must not reach nested LLM codegen");
  assert.ok(!events.some((event) => event.type === "manifest_updated"), "thin manifest must not update the UI");
  assert.ok(!events.some((event) => event.type === "code_updated"), "thin manifest must not produce code");
  const result = recorded.find((event) => event.type === "tool_result" && event.name === "generate_code");
  assert.equal(result?.observation?.ok, false);
  assert.equal(result?.observation?.error_kind, "manifest_contract_error");
  assert.match(JSON.stringify(result?.observation), /schema_version/);
});

test("write_main_py deploys the on-disk firmware/ tree to the device root (rich multi-file flow)", async () => {
  // The rich flow assembles a firmware/ tree on disk; write_main_py deploys that WHOLE
  // tree to the device root via deployFirmwareTree (mirror `mpremote fs cp -r firmware/ :/`),
  // NOT per-file from state.files. writeMainPy / writeDeviceFile must not be called.
  let mainTurns = 0;
  let codegenCall = 0;
  let deployedDir: string | undefined;
  let writeMainCalled = false;
  let deviceFileCalled = false;
  const manifest = MANIFEST;
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "firmware/main.py" } },
    { name: "generate_code", input: { manifest, target_path: "firmware/lib/aht20.py" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('STALE_ECHO')" } },
  ];
  const codegenBodies = ["print('MPYHW_READY')", "class AHT20:\n    pass"];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const text = codegenBodies[codegenCall++] ?? "";
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async () => { writeMainCalled = true; },
    writeDeviceFile: async () => { deviceFileCalled = true; },
    deployFirmwareTree: async (dir: string) => { deployedDir = dir; },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim, writeProjectFile: async (path: string) => ({ ok: true, path }), projectRoot: "C:/project" });
  await loop({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  assert.equal(deployedDir, "C:/project", "the whole on-disk firmware tree is deployed once");
  assert.equal(writeMainCalled, false, "rich deploy does not also call writeMainPy");
  assert.equal(deviceFileCalled, false, "rich deploy does not push files individually");
});

test("write_main_py falls back to single-file deploy when no firmware tree is on disk", async () => {
  // If deployFirmwareTree reports firmware_dir_missing (e.g. a headless/stub host with
  // no persisted tree), the loop falls back to writing the generated main.py — resolved
  // from the firmware/main.py key, not the model's stale echo — directly as /main.py.
  let mainTurns = 0;
  let codegenCall = 0;
  let mainWritten = "";
  const manifest = MANIFEST;
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "firmware/main.py" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('STALE_ECHO')" } },
  ];
  const codegenBodies = ["print('MPYHW_READY')"];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const text = codegenBodies[codegenCall++] ?? "";
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async (content: string) => { mainWritten = content; },
    deployFirmwareTree: async () => { throw new Error("firmware_dir_missing"); },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim, writeProjectFile: async (path: string) => ({ ok: true, path }), projectRoot: "C:/project" });
  await loop({ intent: "desktop pet", boardId: "esp32-s3-devkitc-1" });

  assert.equal(mainWritten, "print('MPYHW_READY')", "falls back to the generated firmware/main.py, not the model echo");
});

test("write_main_py deploys generated main.py from local state, not the model echo (legacy single-file)", async () => {
  // Legacy single-file flow: no firmware/ tree and no projectRoot, so the rich tree
  // deploy is skipped and the generated main.py is written directly via writeMainPy.
  let turnIndex = 0;
  let mainWritten = "";
  const manifest = MANIFEST;
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "main.py" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('STALE_ECHO')" } },
  ];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('GENERATED_MAIN')" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async (content: string) => { mainWritten = content; },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  await loop({ intent: "blink", boardId: "esp32-s3-devkitc-1" });

  assert.equal(mainWritten, "print('GENERATED_MAIN')");
});

test("write_main_py deploys the firmware tree in one call; non-firmware artifacts never go through the loop", async () => {
  // With tree deploy the loop makes ONE deployFirmwareTree call and never pushes files
  // individually, so manifests/docs/PC-tests can't abort the deploy. (The "only firmware/
  // is shipped" guarantee now lives in the python shim's tree walk, tested there.)
  let turnIndex = 0;
  const recorded: any[] = [];
  let deployedDir: string | undefined;
  let deviceFileCalled = false;
  const manifest = MANIFEST;
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "firmware/main.py" } },
    { name: "write_project_file", input: { path: "firmware/tasks/sensor.py", content: "def tick():\n    pass\n" } },
    { name: "write_project_file", input: { path: "project-manifest.json", content: "{}" } },
    { name: "write_project_file", input: { path: "test/pc/test_sensor.py", content: "def test_x():\n    pass\n" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('echo')" } },
  ];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async () => {},
    writeDeviceFile: async () => { deviceFileCalled = true; },
    deployFirmwareTree: async (dir: string) => { deployedDir = dir; },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl,
    shim,
    writeProjectFile: async (path: string) => ({ ok: true, path }),
    projectRoot: "C:/project",
  });
  await loop({ intent: "blink", boardId: "esp32-s3-devkitc-1", recorder: { record: async (e: any) => { recorded.push(e); } } });

  assert.equal(deployedDir, "C:/project", "the firmware tree is deployed in one call");
  assert.equal(deviceFileCalled, false, "no per-file device writes from the loop");
  const deployResult = recorded.find((e: any) => e.type === "tool_result" && e.name === "write_main_py");
  assert.equal(deployResult?.observation?.ok, true, "deploy succeeds");
});

test("generate_code grounds a rich-manifest GPIO part with the builtin LED context (capabilities derived from devices[])", async () => {
  // Regression: contextsForCodegen read manifest.capabilities, which a pure rich
  // upstream manifest never carries (it has devices[]), so the machine_pin_led
  // builtin context was dropped and the LED codegen ran ungrounded.
  let codegenPrompt = "";
  let turnIndex = 0;
  const richManifest = {
    schema_version: "1.0",
    phase: "generate",
    created_at: "2026-06-04T00:00:00Z",
    project_name: "blink",
    requirements: { description: "Blink an LED." },
    devices: [{ name: "Status LED", type: "led", interface: "GPIO" }],
    mcu: { model: "ESP32-C3", board: "esp32-c3-devkitm-1" },
    pinout: [{ device: "Status LED", pin_name: "LED", gpio: "GPIO2" }],
  };
  const turns = [{ name: "generate_code", input: { manifest: richManifest, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        codegenPrompt = String(body.messages?.[0]?.content ?? "");
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "blink", boardId: "esp32-c3-devkitm-1" });

  assert.match(codegenPrompt, /machine_pin_led/, "builtin LED driver context grounds the GPIO part");
});

test("audit_code audits generated local state when the model echo diverges", async () => {
  let turnIndex = 0;
  const recorded: any[] = [];
  const manifest = MANIFEST;
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "main.py" } },
    { name: "audit_code", input: { path: "main.py", content: "import machine\n" } },
  ];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "import socket\n" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((d) => `data: ${d}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[turnIndex++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  const state = { traceId: "session", intent: "x", boardId: "esp32-s3-devkitc-1", turnSeq: 0, repairRound: 0, textOnlyTurns: 0, loadedSkills: [], messages: [], board: BOARD, driverContexts: [] };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({
    intent: "blink",
    boardId: "esp32-s3-devkitc-1",
    state,
    recorder: { record: async (event: any) => { recorded.push(event); } },
  });

  assert.ok(recorded.some((event) => JSON.stringify(event).includes("audit_failed")));
  assert.ok(recorded.some((event) => JSON.stringify(event).includes("socket")));
});

test("write_main_py fails without a generated main.py and does not touch the device", async () => {
  let writes = 0;
  const recorded: any[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const turn = { name: "write_main_py", input: { path: "main.py", content: "print('UNGENERATED')" } };
      return { ok: true, status: 200, text: async () => sseForTurn(turn) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  const shim = {
    scan: async () => ["COM3"],
    installPackage: async () => {},
    writeMainPy: async () => { writes += 1; },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  await loop({
    intent: "blink",
    boardId: "esp32-s3-devkitc-1",
    recorder: { record: async (event: any) => { recorded.push(event); } },
  });

  assert.equal(writes, 0);
  assert.ok(recorded.some((event) => JSON.stringify(event).includes("generated_main_missing")));
});

test("generate_code emits manifest_updated so the wiring view renders even without a prior propose_manifest", async () => {
  // Reproduces the wiring-never-appears bug: when the agent goes straight to
  // generate_code (propose_manifest never validated), the wiring panel listens
  // for manifest_updated, which only propose_manifest used to emit. The manifest
  // that produced the code must also reach the UI so wiring can render. Agent
  // live paths require the rich upstream manifest shape.
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = MANIFEST;
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
  await loop({ intent: "show the temperature on an OLED screen", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  const manifestEvent = events.find((e) => e.type === "manifest_updated");
  assert.ok(manifestEvent, "expected manifest_updated from generate_code so wiring can render");
  assert.equal(manifestEvent.manifest.schema_version, "1.0");
  assert.equal(manifestEvent.manifest.wiring.buses.length, 1);
  assert.equal(manifestEvent.manifest.wiring.standalone.length, 1);

  // The Diagram tab is fed too, even on the straight-to-generate_code path.
  const diagramEvent = events.find((e) => e.type === "diagram_updated");
  assert.ok(diagramEvent, "expected diagram_updated from generate_code so the Diagram tab renders");
  assert.ok(diagramEvent.diagram.architecture.layers.length > 0, "derived diagram has layers");
});

test("agent-backed loop keeps internal tool names out of user-facing trace events", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = MANIFEST;
  const turns = [{ name: "generate_code", input: { manifest, target_path: "main.py" } }];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        const sse = [
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "print('MPYHW_READY')" } }),
          JSON.stringify({ type: "message_stop" }),
        ].map((data) => `data: ${data}`).join("\n\n");
        return { ok: true, status: 200, text: async () => sse } as unknown as Response;
      }
      const turn = turns[mainTurns++];
      return { ok: true, status: 200, text: async () => (turn ? sseForTurn(turn) : `data: ${JSON.stringify({ type: "message_stop" })}`) } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "thermometer with OLED", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e), confirmPlan: async () => ({ action: "confirm" }) });

  const traceText = events.filter((event) => event.type === "trace").map((event) => event.text).join("\n");
  assert.doesNotMatch(traceText, /Agent session/);
  assert.doesNotMatch(traceText, /generate_code/);
});

test("agent-backed loop hides streamed reasoning and surfaces only the final reply as a summary", async () => {
  const events: any[] = [];
  // One turn: the model streams free-text reasoning, then hands back with no tool call.
  const fetchImpl = (async (url: string) => {
    if (!url.endsWith("/v1/llm/messages")) throw new Error(`unexpected url ${url}`);
    const sse = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "让我想想…这其实很简单。" } }),
      JSON.stringify({ type: "message_stop" }),
    ].map((d) => `data: ${d}`).join("\n\n");
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "你好", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  // Mid-stream reasoning is internal — never forwarded as a trace event...
  assert.ok(!events.some((e) => e.type === "trace"), "streamed reasoning must not surface as trace");
  // ...but the model's final plain-text reply is surfaced once, as a summary.
  const summaries = events.filter((e) => e.type === "summary");
  assert.equal(summaries.length, 1, "exactly one summary event");
  assert.equal(summaries[0].text, "让我想想…这其实很简单。");
});

test("the final reply streams as summary_delta tokens, then finalizes as one summary", async () => {
  const events: any[] = [];
  // One tool-free turn: the model streams its reply in two chunks, then hands back.
  const fetchImpl = (async (url: string) => {
    if (!url.endsWith("/v1/llm/messages")) throw new Error(`unexpected url ${url}`);
    const sse = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "用 " } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ssd1306 显示温度。" } }),
      JSON.stringify({ type: "message_stop" }),
    ].map((d) => `data: ${d}`).join("\n\n");
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "你好", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  // Each token surfaces live as a summary_delta (the reply streams in)...
  assert.deepEqual(
    events.filter((e) => e.type === "summary_delta").map((e) => e.text),
    ["用 ", "ssd1306 显示温度。"],
  );
  // ...then the assembled reply is finalized exactly once as a summary.
  const summaries = events.filter((e) => e.type === "summary");
  assert.equal(summaries.length, 1, "exactly one summary event");
  assert.equal(summaries[0].text, "用 ssd1306 显示温度。");
  // No tool ran, so nothing was discarded.
  assert.ok(!events.some((e) => e.type === "summary_discard"), "no discard on a tool-free turn");
});

test("narration before a tool call is discarded — only the final, tool-free reply becomes the summary", async () => {
  const events: any[] = [];
  let mainTurn = 0;
  // Turn 1: the model narrates, then calls a tool (so the narration is mid-process).
  const turn1 = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "让我先看看板子。" } }),
    JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: "query_board_profile", name: "query_board_profile" } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ board_id: "esp32-s3-devkitc-1" }) } }),
    JSON.stringify({ type: "content_block_stop" }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");
  // Turn 2: text only, no tool -> this is the real, final reply.
  const turn2 = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "好了，这是结果。" } }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");

  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const sse = mainTurn++ === 0 ? turn1 : turn2;
      return { ok: true, status: 200, text: async () => sse } as unknown as Response;
    }
    if (url.includes("/v1/boards/")) {
      return { ok: true, status: 200, json: async () => BOARD } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const result = await loop({ intent: "你好", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  assert.equal(result.terminal, "awaiting_user");
  // The narration streamed live, then was discarded the moment the tool fired.
  assert.equal(events.filter((e) => e.type === "summary_discard").length, 1, "one discard for the tool turn");
  assert.deepEqual(
    events.filter((e) => e.type === "summary_delta").map((e) => e.text),
    ["让我先看看板子。", "好了，这是结果。"],
  );
  // Only the final, tool-free turn's text survives as the summary.
  const summaries = events.filter((e) => e.type === "summary");
  assert.equal(summaries.length, 1, "exactly one summary event");
  assert.equal(summaries[0].text, "好了，这是结果。");
});

test("ask_user's lead-in prose is sealed (kept above the question), not discarded", async () => {
  const events: any[] = [];
  let mainTurn = 0;
  // Turn 1: the model writes a user-facing lead-in, then calls ask_user.
  const turn1 = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "我可以帮你做温度显示。" } }),
    JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: "ask_user", name: "ask_user" } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ question: "你想用哪块板子？" }) } }),
    JSON.stringify({ type: "content_block_stop" }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");
  // Turn 2: text only, no tool -> the final reply after the answer comes back.
  const turn2 = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "好的，开始。" } }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");

  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/llm/messages")) {
      const sse = mainTurn++ === 0 ? turn1 : turn2;
      return { ok: true, status: 200, text: async () => sse } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  const result = await loop({
    intent: "你好",
    boardId: "esp32-s3-devkitc-1",
    onEvent: (e) => events.push(e),
    askUser: async () => "esp32-s3-devkitc-1",
  });

  assert.equal(result.terminal, "awaiting_user");
  // The lead-in streamed live, same as any other prose...
  assert.deepEqual(
    events.filter((e) => e.type === "summary_delta").map((e) => e.text),
    ["我可以帮你做温度显示。", "好的，开始。"],
  );
  // ...but when ask_user fired it was SEALED (kept above the question), not discarded.
  assert.equal(events.filter((e) => e.type === "summary_seal").length, 1, "one seal for the ask_user turn");
  assert.ok(!events.some((e) => e.type === "summary_discard"), "ask_user lead-in is never discarded");
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
  assert.equal(firstBody.messages[2].role, "user");
  assert.match(firstBody.messages[2].content, /now make it blink faster/);
  assert.equal(result.state, priorState);
});

test("agent-backed loop tells the model to keep all user-visible prose in the current user language", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/llm/messages")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, status: 200, text: async () => `data: ${JSON.stringify({ type: "message_stop" })}` } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl });
  await loop({ intent: "做一个温度计", boardId: "auto" });

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
  await loop({ intent: "现在改成蜂鸣器报警", boardId: "esp32-s3-devkitc-1", state: priorState });

  const freshOpening = bodies[0].messages[0].content;
  assert.match(freshOpening, /Use Simplified Chinese for all user-visible prose/);
  assert.match(freshOpening, /ask_user questions, final summaries, manifest requirements\.description, and manifest summary/);

  const continuedTurn = bodies[1].messages[2].content;
  assert.match(continuedTurn, /现在改成蜂鸣器报警/);
  assert.match(continuedTurn, /Use Simplified Chinese for all user-visible prose/);
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
