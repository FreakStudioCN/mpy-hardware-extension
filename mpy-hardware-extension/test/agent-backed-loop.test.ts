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

test("declining the deploy checkpoint skips device-touching tools", async () => {
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
  // Decline the deploy gate: install_package is cancelled (never touches the
  // device); read_serial_until (not a deploy tool) still runs and verifies.
  const result = await loop({ intent: "x", boardId: "esp32-s3-devkitc-1", confirmDeploy: async () => { deployPrompts += 1; return false; } });

  assert.equal(installed, false);
  assert.equal(deployPrompts, 1, "deploy gate fires before the first device tool");
  assert.equal(result.terminal, "success");
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
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["display_text"],
    pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6" },
    wiring: [{ role: "i2c_sda", pin: "GPIO5" }],
  };
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
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["temperature_sensing"],
    pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6" },
    wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }],
  };
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

test("write_main_py deploys additional generated files (multi-file project) to the device", async () => {
  let mainTurns = 0;
  let codegenCall = 0;
  let mainWritten = "";
  const deviceWrites: any[] = [];
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["temperature_sensing"],
    pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6" },
    wiring: [{ role: "i2c_sda", pin: "GPIO5" }],
  };
  const turns = [
    { name: "generate_code", input: { manifest, target_path: "main.py" } },
    { name: "generate_code", input: { manifest, target_path: "lib/aht20.py" } },
    { name: "write_main_py", input: { path: "main.py", content: "print('MPYHW_READY')" } },
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
    writeMainPy: async (content: string) => { mainWritten = content; },
    writeDeviceFile: async (path: string, code: string) => { deviceWrites.push({ path, code }); },
    flashAndRun: async () => {},
    serialReadUntil: async () => ({ ok: true, lines: [] }),
  };

  const loop = createAgentBackedLoop({ apiBaseUrl: "http://api.test", fetchImpl, shim });
  await loop({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  assert.equal(mainWritten, "print('MPYHW_READY')");
  // main.py is written via writeMainPy; only the extra lib/ module goes via writeDeviceFile.
  assert.deepEqual(deviceWrites, [{ path: "lib/aht20.py", code: "class AHT20:\n    pass" }]);
});

test("write_main_py deploys generated main.py from local state, not the model echo", async () => {
  let turnIndex = 0;
  let mainWritten = "";
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["digital_output"],
    pins: { led_anode: "GPIO2" },
    wiring: [{ role: "led_anode", pin: "GPIO2" }],
  };
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

test("audit_code audits generated local state when the model echo diverges", async () => {
  let turnIndex = 0;
  const recorded: any[] = [];
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["digital_output"],
    pins: { led_anode: "GPIO2" },
    wiring: [{ role: "led_anode", pin: "GPIO2" }],
  };
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
  await loop({ intent: "show the temperature on an OLED screen", boardId: "esp32-s3-devkitc-1", onEvent: (e) => events.push(e) });

  const manifestEvent = events.find((e) => e.type === "manifest_updated");
  assert.ok(manifestEvent, "expected manifest_updated from generate_code so wiring can render");
  assert.deepEqual(manifestEvent.manifest, manifest);
});

test("agent-backed loop keeps internal tool names out of user-facing trace events", async () => {
  let mainTurns = 0;
  const events: any[] = [];
  const manifest = {
    board_id: "esp32-s3-devkitc-1",
    capabilities: ["temperature_sensing", "humidity_sensing", "display_text"],
    packages: [{ name: "aht20_driver" }, { name: "ssd1306" }],
    wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }],
    logic: "Read AHT20 sensor temperature and humidity every 2 seconds, display on SSD1306 OLED.",
  };
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
