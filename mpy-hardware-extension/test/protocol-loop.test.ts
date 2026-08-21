import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { writeProjectFile } from "../src/extension/workspace-writer.ts";

import { PROTOCOL_TOOLS } from "../src/core/protocol-registry.ts";
import { PHASE_ORDER, runProtocolBuild, executeProtocolTool, capToolOutput } from "../src/core/protocol-loop.ts";
import { micropythonLibDriver, micropythonLibManifest } from "./micropython-lib-manifest.ts";

// A scripted LLM: per phase, an array of turns; each turn is an array of SSE events.
// Each streamMessages(body) call pops the next turn for body.phase.
function scriptedLlm(script: Record<string, any[][]>) {
  const idx: Record<string, number> = {};
  return {
    streamMessages: async (body: any) => {
      const phase = body.phase;
      const turns = script[phase] ?? [];
      const i = idx[phase] ?? 0;
      idx[phase] = i + 1;
      const events = turns[i] ?? [{ type: "message_stop" }];
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });
const stop = { type: "message_stop" };
// select-hw's verdict only counts from the full phase-complete validation. The script also
// prints {"status":"ok"} from its DRAFT mode, and a draft pass must not stand in for one -- so a
// test that means "the gate passed" has to invoke it the way a real run does.
const SELECT_HW_GATE_ARGS = ["--validate-phase-complete", "--compare-manifest", "v.json", "--expected-artifact", "d.json"];

const V0_PHASE_CHAIN = [
  "analyze",
  "select-hw",
  "upy-flash-mpy-firmware-plugin",
  "upy-scaffold-plugin",
  "upy-generate-plugin",
  "upy-deploy-plugin",
] as const;

test("PHASE_ORDER matches the backend-served V0 plugin chain", () => {
  assert.deepEqual([...PHASE_ORDER], [...V0_PHASE_CHAIN]);
});

test("protocol build walks the full V0 plugin chain and sends the cloud envelope", async () => {
  const sentBodies: any[] = [];
  const script: Record<string, any[][]> = {};
  for (const [index, phase] of V0_PHASE_CHAIN.entries()) {
    const next = V0_PHASE_CHAIN[index + 1] ?? null;
    script[phase] = [[
      tu(`p${index}`, "phase_complete", {
        result: "success",
        summary: phase,
        next_phase: next,
        manifest_content: { phase, index },
      }),
      stop,
    ]];
  }
  const baseLlm = scriptedLlm(script);
  const llm = {
    streamMessages: async (body: any) => {
      sentBodies.push(body);
      return baseLlm.streamMessages(body);
    },
  };

  // A reader is required, not optional: the scaffold phase verifies that apply_scaffold really
  // rendered before it accepts phase_complete(success), and a run with no reader never wrote
  // the project at all. This chain walks straight through scaffold, so it supplies one that
  // reports the marker present.
  const result = await runProtocolBuild(
    { intent: "x", traceId: "trace-v0" },
    { llmClient: llm, readFile: async () => ({ ok: true, content: "" }) } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases.map((p) => p.phase), [...V0_PHASE_CHAIN]);
  assert.equal(sentBodies.length, V0_PHASE_CHAIN.length);
  for (const [index, body] of sentBodies.entries()) {
    assert.equal(body.phase, V0_PHASE_CHAIN[index]);
    assert.equal(body.trace_id, "trace-v0");
    assert.deepEqual(body.tools, PROTOCOL_TOOLS);
    assert.deepEqual(body.manifest, index === 0 ? {} : { phase: V0_PHASE_CHAIN[index - 1], index: index - 1 });
  }
});

test("the generate manifest's mip dependencies and API evidence reach the deploy prompt, the terminal result and the manifest event verbatim", async () => {
  // A MicroPython-lib package is a RUNTIME dependency: generate declares it under
  // generate.runtime_dependencies.mip with its API evidence (doc_evidence + the device's
  // driver.api_ref/install_cmd/repo_url) and deploy is what actually runs `mpremote mip
  // install` + the import verify. The loop never reads those fields — it carries the whole
  // manifest — so the only thing keeping them alive is that the carry stays verbatim.
  // Field-picking the phase-boundary copy would strip them silently: deploy would then have
  // no package to install and no evidence for the calls generate already wrote.
  const generateManifest = micropythonLibManifest();
  const expected = structuredClone(generateManifest);
  const sentBodies: any[] = [];
  const events: any[] = [];
  const baseLlm = scriptedLlm({
    "upy-generate-plugin": [[
      tu("g", "phase_complete", { result: "success", summary: "generated", next_phase: "upy-deploy-plugin", manifest_content: generateManifest }),
      stop,
    ]],
    // Deploy completes WITHOUT a manifest_content of its own — the real deploy phase adds no
    // manifest fields, so the evidence has to survive on the carry alone.
    "upy-deploy-plugin": [[
      tu("d", "phase_complete", { result: "success", summary: "deployed", next_phase: null }),
      stop,
    ]],
  });
  const llm = {
    // Snapshot what actually went on the wire, at send time.
    streamMessages: async (body: any) => { sentBodies.push(structuredClone(body)); return baseLlm.streamMessages(body); },
  };

  const result = await runProtocolBuild(
    { intent: "ble beacon", startPhase: "upy-generate-plugin", onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "complete");

  const deployBody = sentBodies.find((b) => b.phase === "upy-deploy-plugin");
  assert.ok(deployBody, "the deploy phase must run — nothing installs the mip packages otherwise");
  assert.deepEqual(deployBody.manifest, expected, "the deploy prompt carries the generate manifest verbatim");
  // Spell out the three evidence carriers so a regression names what was lost.
  assert.deepEqual(
    deployBody.manifest.generate.runtime_dependencies,
    expected.generate.runtime_dependencies,
    "deploy must see the mip runtime dependencies (incl. the micropython_lib entry) it is supposed to install",
  );
  assert.deepEqual(deployBody.manifest.generate.doc_evidence, expected.generate.doc_evidence, "deploy must see the API doc evidence");
  assert.deepEqual(
    deployBody.manifest.devices.find((d: any) => d.driver?.source === "micropython_lib")?.driver,
    micropythonLibDriver(),
    "the device's MicroPython-lib driver evidence (package_name/install_cmd/repo_url/api_ref) survives the carry",
  );

  assert.deepEqual(result.manifest, expected, "the terminal result still carries the evidence (a manifest-less deploy must not blank it)");

  const manifestEvents = events.filter((e) => e.type === "manifest_updated");
  assert.equal(manifestEvents.length, 1, "only generate emitted a manifest_content, so only one manifest_updated is forwarded");
  assert.deepEqual(manifestEvents[0].manifest, expected, "the host receives the same rich manifest the deploy prompt got");

  assert.deepEqual(generateManifest, expected, "the loop must not mutate the manifest object the caller handed it");
});

test("a phase that emits no manifest_content leaves the mip dependencies and evidence from the start manifest intact", async () => {
  // The optional/one-shot entry point (startManifest) plus a phase that completes without a
  // manifest_content: the carry is the only thing keeping the evidence alive here too.
  const startManifest = micropythonLibManifest();
  const expected = structuredClone(startManifest);

  const result = await runProtocolBuild(
    {
      intent: "deploy it",
      startPhase: "upy-deploy-plugin",
      startManifest,
      onEvent: () => {},
    },
    {
      llmClient: scriptedLlm({
        "upy-deploy-plugin": [[tu("d", "phase_complete", { result: "success", summary: "deployed", next_phase: null }), stop]],
      }),
    },
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.manifest, expected, "the start manifest's mip dependencies and evidence survive a manifest-less phase");
});

test("protocol build forwards streamed credit events to onEvent (production quota-bar path)", async () => {
  // The production loop (createProtocolLoop -> runProtocolBuild -> runPhase) consumes the SSE
  // stream itself. It must forward the `{ type: "credits" }` frame sse-client emits after each
  // turn to input.onEvent, or the live credit balance never reaches the webview quota bar in a
  // normal session (only the panel-load REST fetch would keep it fresh).
  const events: any[] = [];
  const credits = { type: "credits", remaining: 5, dailyGrant: 100, resetsAt: "2026-07-07T00:00:00Z" };
  const llm = scriptedLlm({
    analyze: [[
      credits,
      tu("a", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: { phase: "analyze" } }),
      stop,
    ]],
  });

  const result = await runProtocolBuild({ intent: "x", traceId: "t", onEvent: (e: any) => events.push(e) }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.ok(
    events.some((e) => e.type === "credits" && e.remaining === 5 && e.dailyGrant === 100),
    "the streamed credits frame must be forwarded to onEvent, not swallowed by the phase read loop",
  );
});

test("phase_complete next_skill wins over legacy next_phase and is normalized to the production plugin phase", async () => {
  const seen: string[] = [];
  const baseLlm = scriptedLlm({
    analyze: [[
      tu("a", "phase_complete", {
        result: "success",
        summary: "analyze done",
        next_phase: "scaffold",
        next_skill: "/upy-flash-mpy-firmware-plugin",
        manifest_content: { phase: "analyze" },
      }),
      stop,
    ]],
    "upy-flash-mpy-firmware-plugin": [[
      tu("f", "phase_complete", { result: "success", summary: "flash done", next_phase: null, manifest_content: { phase: "upy-flash-mpy-firmware-plugin" } }),
      stop,
    ]],
  });
  const llm = {
    streamMessages: async (body: any) => {
      seen.push(body.phase);
      return baseLlm.streamMessages(body);
    },
  };

  const result = await runProtocolBuild({ intent: "x" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(seen, ["analyze", "upy-flash-mpy-firmware-plugin"]);
});

test("legacy next_phase names are normalized before the next server turn", async () => {
  const seen: string[] = [];
  const baseLlm = scriptedLlm({
    "select-hw": [[
      tu("s", "phase_complete", { result: "success", summary: "selected", next_phase: "flash-mpy-firmware", manifest_content: { phase: "select-hw" } }),
      stop,
    ]],
    "upy-flash-mpy-firmware-plugin": [[
      tu("f", "phase_complete", { result: "success", summary: "flashed", next_phase: null, manifest_content: { phase: "upy-flash-mpy-firmware-plugin" } }),
      stop,
    ]],
  });
  const llm = {
    streamMessages: async (body: any) => {
      seen.push(body.phase);
      return baseLlm.streamMessages(body);
    },
  };

  const result = await runProtocolBuild({ intent: "x", startPhase: "select-hw" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(seen, ["select-hw", "upy-flash-mpy-firmware-plugin"]);
});

test("unknown next phases fail with a structured event instead of spawning a phantom phase", async () => {
  const events: any[] = [];
  const script = {
    analyze: [[
      tu("a", "phase_complete", { result: "success", summary: "bad handoff", next_phase: "does-not-exist", manifest_content: {} }),
      stop,
    ]],
  };

  const result = await runProtocolBuild({ intent: "x", onEvent: (event) => events.push(event) }, { llmClient: scriptedLlm(script) });

  assert.equal(result.terminal, "failed");
  assert.ok(events.some((event) => event.type === "phase_error" && event.error_kind === "unknown_next_phase" && event.next_phase === "does-not-exist"));
});
test("protocol build advances phases, runs codegen file write, auto-confirms approval", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const events: any[] = [];
  let approvalCard: any = null;

  const script = {
    analyze: [
      [tu("a1", "approval_request", { approval_id: "device_confirm", question: "ok?", items: [{ id: "d1", name: "SHT30" }], actions: [{ label: "纭", value: "confirm", primary: true }] }), stop],
      [tu("a2", "status_update", { level: "info", message: "鎼滅储椹卞姩..." }), stop],
      [tu("a3", "phase_complete", { result: "success", summary: "done", next_phase: "upy-generate-plugin", manifest_content: { phase: "analyze", devices: [{ name: "SHT30" }] } }), stop],
    ],
    "upy-generate-plugin": [
      [tu("g1", "file_operation", { op: "write", path: "firmware/main.py", content: "print('MPYHW_READY')\n" }), stop],
      [tu("g2", "phase_complete", { result: "success", summary: "code", next_phase: null, manifest_content: { phase: "upy-generate-plugin" } }), stop],
    ],
  };

  const result = await runProtocolBuild(
    { intent: "build a thermometer", traceId: "t", onEvent: (e) => events.push(e), confirmApproval: async (card) => { approvalCard = card; return { action: "confirm", selected_ids: ["d1"] }; } },
    {
      llmClient: scriptedLlm(script),
      writeFile: async (path, content) => { writes.push({ path, content }); return { ok: true, path }; },
    },
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "success" }, { phase: "upy-generate-plugin", result: "success" }]);
  assert.equal(result.manifest.phase, "upy-generate-plugin");
  // codegen file landed via file_operation -> writeFile
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "firmware/main.py");
  assert.match(writes[0].content, /MPYHW_READY/);
  // approval card was surfaced and a status_update + phase events emitted
  assert.equal(approvalCard.approval_id, "device_confirm");
  assert.ok(events.some((e) => e.type === "status_update"));
  assert.ok(events.some((e) => e.type === "phase_complete"));
  assert.ok(events.some((e) => e.type === "manifest_updated"));
});

test("the request body carries a context block (pre_selected_board + preferences) for server grounding", async () => {
  // The handoff requires preferences.mode/locale, pre_selected_board, existing_hardware to
  // reach the server. Previously the body was only {phase,manifest,messages,tools,trace_id}
  // 鈥?not even boardId 鈥?so the analyze phase had zero grounding on the user's real setup.
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  await runProtocolBuild(
    { intent: "x", boardId: "esp32-c3-devkitm-1", preferences: { mode: "beginner", locale: "zh", existing_hardware: "ESP32-C3 + DHT22" } },
    { llmClient: llm },
  );
  assert.ok(sentBody.context, "request must carry a context block");
  assert.equal(sentBody.context.pre_selected_board, "esp32-c3-devkitm-1");
  assert.equal(sentBody.context.mode, "beginner");
  assert.equal(sentBody.context.locale, "zh");
  assert.equal(sentBody.context.existing_hardware, "ESP32-C3 + DHT22");
});

test("an object-shaped pre-selected board reaches the server whole, not flattened to an id", async () => {
  // The server only treats an OBJECT-shaped pre_selected_board as a board-profile candidate;
  // a bare string is shown as a hint and never resolves a profile. Measured consequence of
  // getting this wrong: select-hw is handed `Board profile: {}` and the model either refuses
  // ("board definition not available in the accessible board library") or invents an id that
  // exists in no library. The id fields are what the resolver reads, so they must survive.
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  const board = { id: "ESP32_GENERIC", local_board_id: "esp32-devkit-v1", skill_board_id: "esp32-devkit-v1", mcu: "ESP32-WROOM-32" };
  await runProtocolBuild({ intent: "x", boardId: "auto", preSelectedBoard: board }, { llmClient: llm });

  assert.deepEqual(sentBody.context.pre_selected_board, board, "the whole board object must reach the server");
  assert.equal(sentBody.context.board_selection_mode, undefined, "a pre-selected board is not the recommend path");
});

test("the recommend path carries board_selection_mode in the context; a picked board omits it", async () => {
  // #43: when the user asks the system to recommend (no pre_selected_board), the server must
  // receive board_selection_mode: "recommend". When a board is picked, the flag is redundant and dropped.
  let recommendBody: any = null;
  let pickedBody: any = null;
  const mk = (sink: (b: any) => void) => ({
    streamMessages: async (body: any) => {
      sink(body);
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  });
  await runProtocolBuild(
    { intent: "pick one", boardId: "auto", boardSelectionMode: "recommend" },
    { llmClient: mk((b) => { recommendBody = b; }) },
  );
  assert.equal(recommendBody.context.board_selection_mode, "recommend", "recommend flag reaches the server context");
  assert.equal(recommendBody.context.pre_selected_board, undefined, "no board on the recommend path");

  await runProtocolBuild(
    { intent: "this one", boardId: "esp32-c3-devkitm-1", preSelectedBoard: { id: "esp32-c3-devkitm-1" }, boardSelectionMode: "recommend" },
    { llmClient: mk((b) => { pickedBody = b; }) },
  );
  assert.equal(pickedBody.context.board_selection_mode, undefined, "a picked board drops the redundant recommend flag");
  assert.deepEqual(pickedBody.context.pre_selected_board, { id: "esp32-c3-devkitm-1" });
});


test("protocol build carries a full pre_selected_board object when the UI selected one", async () => {
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  const board = {
    id: "esp32-s3-devkitc",
    official_id: "ESP32_GENERIC_S3",
    display_name: "ESP32-S3",
    vendor: "Espressif",
    port: "esp32",
    mcu: "esp32s3",
    features: ["BLE", "WiFi"],
    firmware: { url: "https://micropython.org/download/ESP32_GENERIC_S3/", board_name: "ESP32_GENERIC_S3" },
    download_slug: "ESP32_GENERIC_S3",
    source_url: "https://micropython.org/download/",
    support_status: "builtin_pin_layout",
    local_board_id: "esp32-s3-devkitc-1",
    skill_board_id: "esp32-s3-devkitc",
  };
  await runProtocolBuild(
    { intent: "x", boardId: "esp32-s3-devkitc-1", preSelectedBoard: board, preferences: { mode: "custom", locale: "zh" } } as any,
    { llmClient: llm },
  );
  assert.deepEqual(sentBody.context.pre_selected_board, board);
  assert.equal(sentBody.context.mode, "custom");
  assert.equal(sentBody.context.locale, "zh");
});

test("an 'auto' board is not sent as a pre_selected_board (only a real user choice is)", async () => {
  let sentBody: any = null;
  const llm = {
    streamMessages: async (body: any) => {
      sentBody = body;
      return (async function* () { yield tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }); yield stop; })();
    },
  };
  await runProtocolBuild({ intent: "x", boardId: "auto" }, { llmClient: llm });
  assert.equal(sentBody.context, undefined, "no real preferences/board => no context block");
});

test("device_command routes to the device shim and surfaces serial output", async () => {
  const calls: string[] = [];
  const events: any[] = [];
  const { result } = await executeProtocolTool(
    tu("d", "device_command", { action: "stream", cmd_id: "c1" }) as any,
    { intent: "x", onEvent: (e) => events.push(e) },
    { llmClient: scriptedLlm({}), device: async (action) => { calls.push(action); return { ok: true, stdout: "MPYHW_READY\nok" }; } },
  );
  assert.deepEqual(calls, ["stream"]);
  assert.equal(result.ok, true);
  assert.ok(events.some((e) => e.type === "serial_output" && e.lines.includes("MPYHW_READY")));
});

test("device_command 'ls' stdout never surfaces as serial_output (decision 2: file lists stay off the Serial page)", async () => {
  // Root cause (scope.md): the ls action's file listing rode the same serial_output
  // event as real REPL output, so a file list landed on the Serial page. Only the
  // runtime read actions (stream/read) may post serial_output.
  const events: any[] = [];
  const { result } = await executeProtocolTool(
    tu("d", "device_command", { action: "ls", cmd_id: "c1", dst: "/" }) as any,
    { intent: "x", onEvent: (e) => events.push(e) },
    { llmClient: scriptedLlm({}), device: async () => ({ ok: true, stdout: "boot.py\nmain.py" }) },
  );
  assert.equal(result.ok, true);
  assert.ok(!events.some((e) => e.type === "serial_output"), "ls output must not post as serial_output");
  // Mutation: drop the SERIAL_OUTPUT_ACTIONS.has(action) guard -> this fails.
});

test("off-protocol and invalid tools return repair results, not crashes", async () => {
  // a dead 27-tool name
  const off = await executeProtocolTool(tu("o", "scan_device", {}) as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
  assert.equal(off.result.ok, false);
  assert.equal(off.result.error_kind, "unknown_tool");
  // invalid JSON args flagged by the SSE parser
  const bad = await executeProtocolTool({ type: "tool_use_complete", id: "b", name: "file_operation", input: {}, invalidInput: "bad json" } as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
  assert.equal(bad.result.error_kind, "protocol_payload_invalid");
});

test("approval: headless auto-confirms, but a callback returning null cancels (not auto-confirm)", async () => {
  // headless (no callback) -> auto-confirm, selecting all items
  const auto = await executeProtocolTool(
    tu("u2", "approval_request", { approval_id: "x", items: [{ id: "d1" }], actions: [{ value: "go", primary: true }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(auto.result.ok, true);
  assert.equal(auto.result.action, "go");
  assert.deepEqual(auto.result.selected_ids, ["d1"]);
  // Actions carrying only `id` (e.g. the wiring network-render card) must still resolve to a real
  // action id, not the "confirm" fallback. Mutation: map `a.value` only -> values=[] and the primary's
  // value is undefined -> action "confirm" -> this fails.
  const idOnly = await executeProtocolTool(
    tu("u3", "approval_request", { approval_id: "x", items: [{ id: "d1" }], actions: [{ id: "render_all", primary: true }, { id: "cancel" }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(idOnly.result.action, "render_all");
  // callback returns null (user dismissed) -> user_cancelled, NOT silent approval
  const cancelled = await executeProtocolTool(
    tu("u", "approval_request", { approval_id: "x", actions: [{ value: "confirm" }] }) as any,
    { intent: "x", confirmApproval: async () => null }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(cancelled.result.ok, false);
  assert.equal(cancelled.result.error_kind, "user_cancelled");
});

test("approval: headless auto-confirm picks ONE id from a single-choice group, all from multi-select", async () => {
  const res = await executeProtocolTool(
    tu("sc", "approval_request", {
      approval_id: "scaffold_config",
      items: [
        { id: "mode_timer", group: "scheduler_mode", selected: false },
        { id: "mode_async", group: "scheduler_mode", selected: true },
        { id: "mode_thread", group: "scheduler_mode", selected: false },
        { id: "module_logger", group: "extra_modules", selected: true },
        { id: "module_flash", group: "extra_modules", selected: true },
      ],
      item_groups: { scheduler_mode: { multi_select: false }, extra_modules: { multi_select: true } },
      actions: [{ value: "confirm", primary: true }],
    }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  const ids = res.result.selected_ids;
  // Mutation guard: the old code selected ALL ids -> this would be all three modes.
  assert.deepEqual(ids.filter((i: string) => i.startsWith("mode_")), ["mode_async"], "one scheduler mode (the default), not all three");
  assert.ok(ids.includes("module_logger") && ids.includes("module_flash"), "all multi-select modules kept");
});

test("headless: an item in BOTH p.items and a group's inline items is counted once, not twice (PR #46 minor)", async () => {
  const res = await executeProtocolTool(
    tu("mix", "approval_request", {
      approval_id: "scaffold_config",
      items: [{ id: "m_flat", group: "extra_modules" }, { id: "m_dup", group: "extra_modules" }],
      item_groups: { extra_modules: { multi_select: true, items: [{ id: "m_inline" }, { id: "m_dup" }] } },
      actions: [{ value: "confirm", primary: true }],
    }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  // m_dup is declared in p.items AND inline in the group -> it must be counted ONCE. Without the
  // dedup, selected_ids carried m_dup twice (the webview merge+dedup would then disagree).
  assert.deepStrictEqual([...res.result.selected_ids].sort(), ["m_dup", "m_flat", "m_inline"], "each id once; the duplicate is deduped");
});

// The serial_port passthrough is live; the baud passthrough is DORMANT plumbing kept ready for
// re-enable — the webview baud picker is commented (gated on ruili consuming approval_response.baud),
// so no live decision supplies baud today. This test pins that the plumbing still carries it when
// a decision does, so restoring the picker is a webview-only change.
test("approval: a confirmApproval decision carries serial_port + baud into the result", async () => {
  const res = await executeProtocolTool(
    tu("fl", "approval_request", { approval_id: "esp32_flash_confirm", actions: [{ value: "flash_now", primary: true }] }) as any,
    { intent: "x", confirmApproval: async () => ({ action: "flash_now", serial_port: "COM3", baud: "460800" }) },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(res.result.action, "flash_now");
  assert.equal(res.result.serial_port, "COM3", "the chosen port rides into the approval_response");
  assert.equal(res.result.baud, "460800", "the chosen baud rides into the approval_response");
});

// added_items is set by the webview's approval add-row (ApprovalCardHost.js). This pins
// that a confirmApproval decision carrying it rides verbatim into the ui-route result —
// the same no-code-change-needed passthrough already proven for serial_port/baud above.
test("approval: a confirmApproval decision carries added_items into the result", async () => {
  const addedItems = [{ name: "OLED显示屏", type: "user_added", interface: "unknown", source: "user_specified" }];
  const res = await executeProtocolTool(
    tu("ad", "approval_request", { approval_id: "device_confirm", allow_add: true, actions: [{ value: "confirm", primary: true }] }) as any,
    { intent: "x", confirmApproval: async () => ({ action: "confirm", selected_ids: ["d1"], added_items: addedItems }) },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(res.result.action, "confirm");
  assert.deepStrictEqual([...res.result.added_items].map((i: any) => ({ ...i })), addedItems, "the added component rides verbatim into the approval_response");
});

test("script_run routes to the host runner, forwards stdin, maps a failed gate to success=false (not faked)", async () => {
  const calls: any[] = [];
  const { result } = await executeProtocolTool(
    tu("s1", "script_run", { script_id: "q", interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"], stdin_content: "{}" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), runScript: async (interpreter: string, script: string, args: string[], extra: any) => { calls.push({ interpreter, script, args, extra }); return { ok: true, stdout: "", stderr: "GENERATE_PLAN_FILE_PATH_MISSING", exit_code: 1 }; } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interpreter, "python");
  assert.equal(calls[0].script, "check_generate_plan.py");
  assert.deepEqual(calls[0].args, ["--require-plan"]);
  assert.equal(calls[0].extra.stdin_content, "{}");
  assert.equal(result.ok, true);        // the script RAN (transport ok)
  assert.equal(result.success, false);  // but the gate FAILED (exit 1) 鈥?not faked
  assert.equal(result.exit_code, 1);
  assert.equal(result.script_id, "q");
});

// An oversized tool result does not just cost tokens: it pushes the conversation past the
// upstream's context window and kills the run. A real scaffold report was 652,869 chars
// (43 file bodies carried twice) and added 206k tokens in one turn.
function scaffoldShapedReport(fileCount: number, bodyChars: number) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `firmware/f${i}.py`, content: "x".repeat(bodyChars), encoding: "utf-8",
  }));
  return JSON.stringify({
    phase: "scaffold",
    files,
    // The same bodies a second time, which is what made the real report enormous.
    file_operations: files.map((f, i) => ({ type: "file_operation", payload: { op_id: `o${i}`, op: "write", ...f } })),
    // The fields the phase actually needs come LAST, so a head-only cut would lose them.
    manifest_content: { schema_version: "1.0", project_name: "T" },
    phase_complete_payload: { result: "success", next_phase: "upy-generate-plugin" },
  });
}

test("a small tool output is passed through untouched", () => {
  const small = JSON.stringify({ ok: true, note: "short" });
  assert.equal(capToolOutput(small), small);
  assert.equal(capToolOutput(""), "");
  assert.equal(capToolOutput(undefined), "", "a missing stdout is still an empty string, as before");
});

test("an oversized JSON report is shrunk but keeps every key, including the trailing payload", () => {
  const raw = scaffoldShapedReport(43, 7000);
  assert.ok(raw.length > 500_000, "the fixture reproduces the real report's scale");
  const capped = capToolOutput(raw);

  assert.ok(capped.length < raw.length / 5, `capped to ${capped.length} from ${raw.length}`);
  // Still parseable: shrinking STRINGS rather than cutting text is what preserves this.
  const parsed = JSON.parse(capped);
  // The trailing keys are the ones a head-only truncation would have destroyed.
  assert.equal(parsed.phase_complete_payload.next_phase, "upy-generate-plugin");
  assert.equal(parsed.manifest_content.schema_version, "1.0");
  assert.equal(parsed.files.length, 43, "no file is dropped, only its body is shortened");
  assert.equal(parsed.file_operations.length, 43);
  // The body is gone but the path survives, which is what the model needs to reason about.
  assert.equal(parsed.files[0].path, "firmware/f0.py");
  assert.ok(parsed.files[0].content.length < 1000);
  assert.match(parsed.files[0].content, /chars removed by the host/);
  // A shrunk BODY is not merely shortened output: these are the bodies the model re-emits
  // as file_operation(write) calls. The marker has to say the value is unusable and where
  // the real content is, or the model writes the marker itself into firmware/main.py and
  // the next gate fails on a syntax error with nothing explaining it.
  assert.match(parsed.files[0].content, /must never be written to a file/, "the marker says the value is not writable content");
  assert.match(parsed.files[0].content, /Read the file itself/, "and where to get the real body");
});

test("a body carrying the host truncation marker is refused at the write, not written", async () => {
  const results: any[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  // The real path: a scaffold report body the host shrank, transcribed back by the model.
  const truncated = JSON.parse(capToolOutput(scaffoldShapedReport(43, 7000))).files[0].content;
  const llm = {
    streamMessages: async () => {
      const ev = [tu("f0", "file_operation", { op: "write", path: "firmware/main.py", content: truncated }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 1, onEvent: (e: any) => { if (e.type === "tool_result") results.push(e.observation); } },
    { llmClient: llm, writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path }; } },
  );

  assert.equal(writes.length, 0, "nothing may reach disk: the body is a transcribed, shortened value");
  assert.equal(results[0].output.error_kind, "truncated_content");
  assert.match(results[0].output.detail, /Read the file/, "the refusal tells the model how to get the real body");
});

test("an oversized file_operation(read) is capped: moving a payload into a file does not dodge the cap", async () => {
  // The scaffold bump stops the 650KB of file bodies riding in stdout by writing them to a
  // bundle instead -- which the model then READS. Uncapped, that is the same context-window
  // kill through a different door, so the read has to be capped like stdout is.
  const huge = "z".repeat(300_000);
  const { result } = await executeProtocolTool(
    tu("f0", "file_operation", { op: "read", path: "firmware/bundle.txt" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), readFile: async () => ({ ok: true, content: huge }) } as any,
  );
  assert.equal(result.ok, true);
  assert.ok(result.content.length < huge.length / 2, `capped to ${result.content.length} from ${huge.length}`);
  assert.match(result.content, /chars removed by the host/);
});

test("an oversized file_operation(list) is capped and SAYS how many entries it dropped", async () => {
  const entries = Array.from({ length: 20_000 }, (_, i) => `firmware/generated/module_${i}/driver.py`);
  const { result } = await executeProtocolTool(
    tu("f0", "file_operation", { op: "list", path: "" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), listFiles: async () => ({ ok: true, entries }) } as any,
  );
  assert.ok(result.entries.length < entries.length, "the listing is capped");
  assert.equal(result.entries_omitted, entries.length - result.entries.length);
  // Silence here reads as "that is the whole tree", so the model concludes files it just
  // wrote are missing. The count is what stops that.
  assert.match(result.detail, /omitted by the host/);
  assert.equal(result.entries[0], entries[0], "the head is kept: entries arrive shallowest-first");
});

test("append extends the existing body instead of replacing it", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const { result } = await executeProtocolTool(
    tu("f0", "file_operation", { op: "append", path: "firmware/main.py", content: "\ndef extra():\n    pass\n" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async () => ({ ok: true, content: "def main():\n    pass\n" }),
      writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path, relative_path: path }; },
    } as any,
  );
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  // The whole bug: `append` was routed to a writer that truncates, so the body it was
  // asked to EXTEND was destroyed and replaced by the fragment -- reported as ok:true.
  assert.match(writes[0].content, /^def main\(\):/, "the existing body survives");
  assert.match(writes[0].content, /def extra\(\)/, "and the fragment is appended after it");
});

test("append to a file that does not exist yet creates it", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const { result } = await executeProtocolTool(
    tu("f0", "file_operation", { op: "append", path: "firmware/new.py", content: "print(1)\n" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async () => ({ ok: false, error_kind: "file_not_found" }),
      writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path, relative_path: path }; },
    } as any,
  );
  assert.equal(result.ok, true);
  assert.equal(writes[0].content, "print(1)\n");
});

test("append refuses when the existing body cannot be read, instead of clobbering it", async () => {
  const writes: any[] = [];
  const { result } = await executeProtocolTool(
    tu("f0", "file_operation", { op: "append", path: "firmware/main.py", content: "print(1)\n" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async () => ({ ok: false, error_kind: "read_failed" }),
      writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true, path }; },
    } as any,
  );
  // Degrading to an empty base here would be the same silent truncation one level down.
  assert.equal(writes.length, 0, "nothing is written when the base cannot be established");
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "read_failed");
});

test("oversized output that is not JSON keeps its head AND its tail", () => {
  const text = "HEAD-MARKER" + "y".repeat(200_000) + "TAIL-MARKER";
  const capped = capToolOutput(text);
  assert.ok(capped.length < text.length);
  assert.match(capped, /^HEAD-MARKER/, "the head survives");
  assert.match(capped, /TAIL-MARKER$/, "the tail survives, where a report's verdict usually is");
  assert.match(capped, /chars removed by the host/);
});

test("the cap reaches the model, while structured_errors are still parsed from the FULL stdout", async () => {
  // A report big enough to exceed the budget even AFTER its strings are shrunk falls back
  // to the head+tail clamp, which leaves the model unparseable JSON. That is the case that
  // pins the ordering: parse the errors from the raw stdout, or the corrective path goes
  // blind exactly when the report is worst.
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `firmware/f${i}.py`, content: "x".repeat(2000) }));
  const stdout = JSON.stringify({
    check: "quality_gates",
    files,
    file_operations: files.map((f) => ({ type: "file_operation", payload: { op: "write", ...f } })),
    errors: [{ code: "FLAKE8_FAILED", path: "firmware/main.py", message: "E501 line too long" }],
  });
  const r = await executeProtocolTool(
    tu("s", "script_run", { interpreter: "python", script: "scripts/run_quality_gates.py", script_id: "s1" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), runScript: async () => ({ ok: true, exit_code: 1, stdout, stderr: "" }) },
  );
  assert.ok(r.result.stdout.length < stdout.length, "what the model sees is capped");
  assert.throws(() => JSON.parse(r.result.stdout), "this report is past rescue: the model gets a clamped, unparseable string");
  assert.deepEqual(
    r.result.structured_errors,
    [{ code: "FLAKE8_FAILED", path: "firmware/main.py", message: "E501 line too long" }],
    "the corrective path still sees the error, because it parses the raw stdout, not the capped one",
  );
});

// A turn where the model returns NOTHING used to be recorded as an empty assistant message.
// History is replayed on every later request, so one of those poisons the rest of the phase:
// the api renders it as {"role":"assistant","content":""} with no tool_calls, and at least one
// upstream rejects the whole conversation for it rather than just that turn.
test("a turn that returned nothing is not recorded in the conversation", async () => {
  const sent: any[] = [];
  const base = scriptedLlm({
    analyze: [
      [stop],                                                                   // nothing at all
      [tu("a", "phase_complete", { result: "success", summary: "ok", next_phase: null }), stop],
    ],
  });
  const llm = { streamMessages: async (body: any) => { sent.push(structuredClone(body)); return base.streamMessages(body); } };

  await runProtocolBuild({ intent: "blink", startPhase: "analyze" }, { llmClient: llm });

  assert.equal(sent.length, 2, "the empty turn is nudged, not fatal");
  const second = sent[1].messages;
  assert.equal(
    second.filter((m: any) => m.role === "assistant").length, 0,
    "no assistant message is recorded for a turn that produced nothing",
  );
  assert.ok(
    second.some((m: any) => JSON.stringify(m).includes("must call exactly one protocol tool")),
    "the nudge still goes, so the model is told what to do",
  );
});

test("a thinking-only or text-only turn IS still recorded", async () => {
  // The guard must key on "no blocks at all", not on "no tool call". A turn that reasoned or
  // spoke did produce something, and dropping it would lose real conversation history.
  for (const [label, ev] of [
    ["thinking", { type: "thinking_delta", text: "weighing options" }],
    ["text", { type: "text_delta", text: "let me look" }],
  ] as const) {
    const sent: any[] = [];
    const base = scriptedLlm({
      analyze: [
        [ev, stop],
        [tu("a", "phase_complete", { result: "success", summary: "ok", next_phase: null }), stop],
      ],
    });
    const llm = { streamMessages: async (body: any) => { sent.push(structuredClone(body)); return base.streamMessages(body); } };
    await runProtocolBuild({ intent: "blink", startPhase: "analyze" }, { llmClient: llm });
    const assistants = sent[1].messages.filter((m: any) => m.role === "assistant");
    assert.equal(assistants.length, 1, `${label}: the turn is kept`);
    assert.ok(assistants[0].content.length > 0, `${label}: with its block`);
  }
});

test("repeated empty turns leave no assistant messages behind before the stall", async () => {
  // The nudge loop runs MAX_TOOLLESS_TURNS times, so the old behavior appended one empty
  // assistant message per empty turn — the failure compounds rather than staying at one.
  const sent: any[] = [];
  const base = scriptedLlm({ analyze: [[stop], [stop], [stop]] });
  const llm = { streamMessages: async (body: any) => { sent.push(structuredClone(body)); return base.streamMessages(body); } };

  const result = await runProtocolBuild({ intent: "blink", startPhase: "analyze" }, { llmClient: llm });

  assert.equal(result.terminal, "stalled");
  for (const [i, body] of sent.entries()) {
    assert.equal(
      body.messages.filter((m: any) => m.role === "assistant").length, 0,
      `request ${i + 1} carries no empty assistant message`,
    );
  }
});

test("file_operation mkdir/delete run the real host deps (no faked no-op success)", async () => {
  const calls: any[] = [];
  const deps = {
    llmClient: scriptedLlm({}),
    makeDir: async (path: string) => { calls.push(["mkdir", path]); return { ok: true }; },
    deletePath: async (path: string) => { calls.push(["delete", path]); return { ok: true }; },
  };
  const mk = await executeProtocolTool(tu("m", "file_operation", { op: "mkdir", path: "firmware/lib", op_id: "o1" }) as any, { intent: "x" }, deps);
  assert.equal(mk.result.ok, true);
  assert.equal(mk.result.success, true);
  const del = await executeProtocolTool(tu("d", "file_operation", { op: "delete", path: "firmware/tools", op_id: "o2" }) as any, { intent: "x" }, deps);
  assert.equal(del.result.ok, true);
  assert.equal(del.result.success, true);
  assert.deepEqual(calls, [["mkdir", "firmware/lib"], ["delete", "firmware/tools"]]);
});

// A rejection the model cannot act on stalls the phase: it re-guesses, burns turns, and
// the run dies on max_turns or a text-only no_tool_call turn. Both malformed shapes below
// were observed against real upstreams, so each rejection has to name what is accepted.
test("a file_operation with no op is refused with the supported ops named", async () => {
  const r = await executeProtocolTool(
    tu("n", "file_operation", { path: "firmware/main.py", op_id: "o1" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error_kind, "missing_file_op");
  // The key must SURVIVE serialization: spreading a bare undefined `op` dropped it, so the
  // model received a bare error_kind and had nothing to correct from.
  assert.ok("op" in JSON.parse(JSON.stringify(r.result)), "op key survives JSON round-trip");
  assert.deepEqual(r.result.supported_ops, ["read", "write", "append", "list", "mkdir", "delete"]);
  for (const op of ["read", "write", "append", "list", "mkdir", "delete"]) {
    assert.match(r.result.detail, new RegExp(op), `detail names ${op}`);
  }
});

test("an unknown file_operation op is refused, echoed back, and told what is valid", async () => {
  const r = await executeProtocolTool(
    tu("u", "file_operation", { op: "touch", path: "firmware/main.py" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error_kind, "unsupported_file_op");
  assert.equal(r.result.op, "touch", "the rejected op is echoed so the model sees what it sent");
  assert.match(r.result.detail, /touch/);
  assert.match(r.result.detail, /append/);
});

// Coercing an ABSENT content to "" wrote an empty file and reported success, so the model
// was told it had written real code with nothing on disk.
test("write with no content is refused instead of silently writing an empty file", async () => {
  const writes: any[] = [];
  const r = await executeProtocolTool(
    tu("w", "file_operation", { op: "write", path: "firmware/main.py", op_id: "o2" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), writeFile: async (p: string, c: string) => { writes.push([p, c]); return { ok: true }; } },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error_kind, "missing_content");
  assert.equal(writes.length, 0, "nothing reached the workspace");
  assert.match(r.result.detail, /content/);
});

// Same failure, different input: String({}) writes a file containing "[object Object]" and
// reports success, so the guard has to refuse every non-string, not only an absent key.
test("write with a non-string content is refused, not coerced onto disk", async () => {
  for (const content of [{}, [], 42, true]) {
    const writes: any[] = [];
    const r = await executeProtocolTool(
      tu("w", "file_operation", { op: "write", path: "firmware/main.py", content }) as any,
      { intent: "x" },
      { llmClient: scriptedLlm({}), writeFile: async (p: string, c: string) => { writes.push([p, c]); return { ok: true }; } },
    );
    assert.equal(r.result.ok, false, String(content));
    assert.equal(r.result.error_kind, "missing_content", String(content));
    assert.equal(writes.length, 0, `a ${typeof content} reached the workspace`);
  }
});

// The writer accepts a redundant leading segment and writes to the CORRECTED target. A bare
// success left the model believing its own prefixed path existed, so it kept the prefix for
// every later list, mkdir and delete. Driven through the REAL writeProjectFile, because the
// path it reports is the whole point: a mock returning a tidy relative path would pass while
// production returned the absolute host path, which this same allowlist refuses on re-use.
test("a write reports the path it landed on, project-relative and re-writable", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-writepath-"));
  try {
    const writeFile = (path: string, content: string) =>
      writeProjectFile({
        workspaceFolder: ws,
        path,
        content,
        writeFile: async (target: string, body: string) => {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, body, "utf-8");
        },
      });

    const first = await executeProtocolTool(
      tu("w", "file_operation", { op: "write", path: "project/firmware/main.py", content: "print(1)" }) as any,
      { intent: "x" },
      { llmClient: scriptedLlm({}), writeFile },
    );
    assert.equal(first.result.ok, true);
    assert.equal(first.result.path, "firmware/main.py", "the model is told where the file landed");
    assert.equal(first.result.path.includes(ws), false, "an absolute host path leaks the user's tree");

    // The reported path has to be one the model can actually reuse. An absolute path is
    // refused by the same allowlist, which would restart the prefix loop this feature ends.
    const second = await executeProtocolTool(
      tu("w2", "file_operation", { op: "write", path: first.result.path, content: "print(2)" }) as any,
      { intent: "x" },
      { llmClient: scriptedLlm({}), writeFile },
    );
    assert.equal(second.result.ok, true, "the path the model was told is refused when it sends it back");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("write with an explicitly empty content still writes (a deliberate empty file)", async () => {
  const writes: any[] = [];
  const r = await executeProtocolTool(
    tu("e", "file_operation", { op: "write", path: "firmware/lib/__init__.py", content: "" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), writeFile: async (p: string, c: string) => { writes.push([p, c]); return { ok: true }; } },
  );
  assert.equal(r.result.ok, true);
  assert.deepEqual(writes, [["firmware/lib/__init__.py", ""]]);
});

test("file_operation mkdir/delete/list fail loud when the host dep is absent (not faked ok)", async () => {
  for (const op of ["mkdir", "delete", "list"]) {
    const r = await executeProtocolTool(tu("f", "file_operation", { op, path: "firmware/tools" }) as any, { intent: "x" }, { llmClient: scriptedLlm({}) });
    assert.equal(r.result.ok, false, op);
    assert.equal(r.result.error_kind, "workspace_unavailable", op);
  }
});

test("file_operation delete surfaces the host error_kind, never a fake success", async () => {
  const r = await executeProtocolTool(
    tu("d", "file_operation", { op: "delete", path: "../escape" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), deletePath: async () => ({ ok: false, error_kind: "path_outside_workspace" }) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "path_outside_workspace");
});

test("script_run ambiguous error forwards the candidate plugin-qualified names to the model", async () => {
  // serve.py lists the plugin-qualified candidates on an ambiguous bare name; the
  // protocol host route must forward them so the model can retry with a real qualified
  // name instead of re-sending the bare name and getting stuck again.
  const { result } = await executeProtocolTool(
    tu("s", "script_run", { interpreter: "python", script: "list_serial_ports.py", script_id: "q" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      runScript: async () => ({ ok: false, error_kind: "ambiguous_script_name", stderr: "qualify it", candidates: ["upy-deploy-plugin/list_serial_ports.py", "upy-flash-mpy-firmware-plugin/list_serial_ports.py"] }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "ambiguous_script_name");
  assert.ok(Array.isArray(result.candidates), "the model needs the candidate list to retry with a qualified name");
  assert.ok(result.candidates.includes("upy-deploy-plugin/list_serial_ports.py"), result);
});

test("script_run with no host runner fails loud (no fake success)", async () => {
  const { result } = await executeProtocolTool(
    tu("s2", "script_run", { interpreter: "python", script: "x.py" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "host_runner_absent");
});

test("script_run surfaces a script_not_found from the runner as a failure, not success", async () => {
  const { result } = await executeProtocolTool(
    tu("s3", "script_run", { interpreter: "python", script: "ghost.py" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), runScript: async () => ({ ok: false, error_kind: "script_not_found", stderr: "no such script" }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "script_not_found");
});

test("runProtocolBuild honors input.maxTurnsPerPhase (V0 phases need a high budget)", async () => {
  const mkScript = () => ({
    analyze: [
      [tu("t0", "status_update", { message: "1" }), stop],
      [tu("t1", "status_update", { message: "2" }), stop],
      [tu("t2", "phase_complete", { result: "success", summary: "ok", next_phase: null, manifest_content: {} }), stop],
    ],
  });
  // 3 turns needed; budget of 2 stalls before phase_complete.
  const stalled = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 2 }, { llmClient: scriptedLlm(mkScript()) });
  assert.equal(stalled.terminal, "stalled");
  // budget of 3 reaches phase_complete.
  const done = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 3 }, { llmClient: scriptedLlm(mkScript()) });
  assert.equal(done.terminal, "complete");
});

test("headless approval takes the no-hardware action when one is offered (not the flash primary)", async () => {
  const r = await executeProtocolTool(
    tu("f", "approval_request", { approval_id: "firmware_action_select", actions: [{ value: "download_and_flash", primary: true }, { value: "already_flashed" }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, true);
  assert.equal(r.result.action, "already_flashed");
});

test("headless approval handles object-form item_groups without crashing (selects all)", async () => {
  const r = await executeProtocolTool(
    tu("g", "approval_request", { approval_id: "x", item_groups: { sensors: { items: [{ id: "s1" }] }, actuators: { items: [{ id: "a1" }] } }, actions: [{ value: "go", primary: true }] }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, true);
  assert.deepEqual([...r.result.selected_ids].sort(), ["a1", "s1"]);
});

test("a failed phase_complete yields a failed terminal, not complete", async () => {
  const script = { analyze: [[tu("a", "phase_complete", { result: "failed", summary: "boom", next_phase: null }), stop]] };
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.equal(result.terminal, "failed");
});

test("a phase_complete missing result is rejected so the phase retries (not silently terminal)", async () => {
  // The model occasionally emits a truncated/empty phase_complete (no result). That
  // must NOT end the build as 'complete' 鈥?feed back an error so the model re-emits.
  let turns = 0;
  const llm = {
    streamMessages: async () => {
      turns++;
      const ev = turns === 1
        ? [tu("p1", "phase_complete", { summary: "oops, no result field" }), stop]
        : [tu("p2", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "success" }]);
  assert.ok(turns >= 2, "incomplete phase_complete must not end the phase");
});

test("executeProtocolTool rejects a phase_complete with no result", async () => {
  const r = await executeProtocolTool(
    tu("x", "phase_complete", { summary: "no result" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
  );
  assert.equal(r.result.ok, false);
  assert.equal(r.phaseControl, undefined);
});

test("a string 'null' next_phase is terminal, not run as a real phase", async () => {
  // The model sometimes emits next_phase as the literal string "null"; that must end
  // the build, not spawn a phantom phase named "null".
  const script = { analyze: [[tu("a", "phase_complete", { result: "partial", summary: "stop", next_phase: "null" }), stop]] };
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.deepEqual(result.phases, [{ phase: "analyze", result: "partial" }]);
});

test("an already-aborted signal cancels before any LLM call", async () => {
  let called = 0;
  const llm = { streamMessages: async () => { called++; return (async function* () { })(); } };
  const result = await runProtocolBuild({ intent: "x", signal: { aborted: true } }, { llmClient: llm });
  assert.equal(result.terminal, "cancelled");
  assert.equal(called, 0);
});

test("a phase that never emits phase_complete stalls cleanly", async () => {
  const script = { analyze: [[tu("s", "status_update", { level: "info", message: "..." }), stop]] };
  // every subsequent turn returns just message_stop (no tools) -> stall
  const result = await runProtocolBuild({ intent: "x" }, { llmClient: scriptedLlm(script) });
  assert.equal(result.terminal, "stalled");
  assert.equal(result.phases.at(-1)?.result, null);
});

test("a prose-only turn is re-prompted, not an instant stall, so the build still advances (search-drivers freeze fix)", async () => {
  // The bug: one chatty model turn (text, no protocol tool) immediately stalled the
  // phase, and the loop mapped that to awaiting_user 鈥?the UI froze on "姝ｅ湪鎼滅储椹卞姩"
  // with no error. The loop must nudge the model to emit a tool instead of giving up.
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [{ type: "text_delta", text: "Let me think about which drivers to use..." }, stop] // prose only, no tool
        : [tu("p", "phase_complete", { result: "success", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.ok(calls >= 2, "a prose-only turn must re-prompt the model, not stall on the first reply");
});

test("a persistently prose-only phase stalls AND surfaces a phase_stalled event (no silent freeze)", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () { yield { type: "text_delta", text: "thinking..." }; yield stop; })(),
  };
  const result = await runProtocolBuild(
    { intent: "x", maxTurnsPerPhase: 10, onEvent: (e) => events.push(e) },
    { llmClient: llm },
  );
  assert.equal(result.terminal, "stalled");
  assert.ok(
    events.some((e) => e.type === "phase_stalled"),
    "a real stall must surface a phase_stalled event so the UI shows a stuck/retry state, not a frozen step",
  );
});

test("generate phase rejects a turn-0 failed bail to analyze and retries", async () => {
  // Direct unit check (same pattern as "executeProtocolTool rejects a phase_complete
  // with no result" above): on turn 0 of the generate phase, a failed bail to analyze
  // is a hallucination (scaffold already ran) -> rejected with a corrective error_kind,
  // no phaseControl, so the phase loop is not ended.
  const rejected = await executeProtocolTool(
    tu("g0", "phase_complete", { result: "failed", summary: "project looks empty", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 0 },
  );
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.error_kind, "empty_project_hallucination");
  assert.equal(rejected.phaseControl, undefined);

  // Guard must NOT fire outside its exact trigger: wrong phase, later turn, or a
  // genuine (non-hallucinated) failed result all pass through to normal acceptance.
  const wrongPhase = await executeProtocolTool(
    tu("w", "phase_complete", { result: "failed", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-scaffold-plugin", turn: 0 },
  );
  assert.equal(wrongPhase.result.ok, true, "guard is generate-phase-only");
  assert.ok(wrongPhase.phaseControl, "non-generate phases accept a failed bail to analyze normally");

  const laterTurn = await executeProtocolTool(
    tu("l", "phase_complete", { result: "failed", next_phase: "upy-analyze-plugin" }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 1 },
  );
  assert.equal(laterTurn.result.ok, true, "guard is turn-0-only");
  assert.ok(laterTurn.phaseControl, "a failed bail on turn 1+ is accepted, not rejected as a hallucination");

  const genuineFailure = await executeProtocolTool(
    tu("f", "phase_complete", { result: "failed", next_phase: null }) as any,
    { intent: "x" }, { llmClient: scriptedLlm({}) },
    { phase: "upy-generate-plugin", turn: 0 },
  );
  assert.equal(genuineFailure.result.ok, true, "guard only fires when next_phase names analyze");
  assert.ok(genuineFailure.phaseControl);

  // Full phase run: turn 0 emits the hallucinated bail; turn 1 emits a normal
  // successful phase_complete. The loop must not end "failed" at turn 0 -- it retries
  // and the phase result reflects the turn-1 success (bounded naturally by maxTurns).
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [tu("g0", "phase_complete", { result: "failed", summary: "project looks empty", next_phase: "upy-analyze-plugin" }), stop]
        : [tu("g1", "phase_complete", { result: "success", summary: "generated", next_phase: null, manifest_content: { phase: "upy-generate-plugin" } }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const result = await runProtocolBuild({ intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 }, { llmClient: llm });
  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases, [{ phase: "upy-generate-plugin", result: "success" }]);
  assert.ok(calls >= 2, "turn-0 hallucinated bail must not end the phase; the model must be re-prompted");
});

test("scaffold success is rejected when apply_scaffold rendered nothing", async () => {
  // Measured on a real run: the model never called apply_scaffold, hand-wrote the tree and
  // reported success. The project had no .flake8, and the deploy-tool interface it then had
  // to reproduce by hand matched 3 of 12 required markers. apply_scaffold writes .flake8 on
  // every render, so its absence is the cheapest proof the phase rendered nothing.
  const reads: string[] = [];
  const missing = await executeProtocolTool(
    tu("s0", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async (path: string) => { reads.push(path); return { ok: false, error_kind: "file_not_found" }; },
    },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.deepEqual(reads.sort(), [".upy/schemas/project-manifest.schema.json", "scaffold_file_manifest.json"]);
  assert.equal(missing.result.ok, false);
  assert.equal(missing.result.error_kind, "scaffold_not_applied");
  assert.equal(missing.phaseControl, undefined, "rejected phase_complete must not advance the phase");
  assert.match(missing.result.message, /apply_scaffold/, "the refusal must name what would satisfy it");

  // A scaffold that DID render passes through untouched.
  const applied = await executeProtocolTool(
    tu("s1", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), readFile: async () => ({ ok: true, content: "{}" }) },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(applied.result.ok, true);
  assert.ok(applied.phaseControl, "a rendered scaffold advances normally");

  // apply_scaffold writes scaffold_file_manifest.json into --session-dir, so a real render
  // can leave the project root without it while the unconditional .upy schema is there.
  // Absence has to be UNANIMOUS or this rejects a scaffold that ran.
  const manifestElsewhere = await executeProtocolTool(
    tu("s1b", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async (path: string) => (path === "scaffold_file_manifest.json"
        ? { ok: false, error_kind: "file_not_found" }
        : { ok: true, content: "{}" }),
    },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(manifestElsewhere.result.ok, true, "one marker present is enough");
  assert.ok(manifestElsewhere.phaseControl);

  // The run this guard was rebuilt for: the model hand-wrote .flake8, .pylintrc and a fake
  // lib/ tree, so a .flake8-only marker passed while apply_scaffold had never run. Neither
  // scaffold-authored marker exists in that project.
  const handWrittenTree = await executeProtocolTool(
    tu("s1c", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" },
    {
      llmClient: scriptedLlm({}),
      readFile: async (path: string) => (path === ".flake8"
        ? { ok: true, content: "[flake8]\nmax-line-length = 120\n" }
        : { ok: false, error_kind: "file_not_found" }),
    },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(handWrittenTree.result.ok, false, "a hand-written .flake8 must not satisfy the guard");
  assert.equal(handWrittenTree.result.error_kind, "scaffold_not_applied");
  assert.equal(handWrittenTree.phaseControl, undefined);

  // A read that FAILED is not absence. Rejecting here would kill a scaffold that ran.
  const unreadable = await executeProtocolTool(
    tu("s2", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), readFile: async () => ({ ok: false, error_kind: "read_failed" }) },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(unreadable.result.ok, true, "only a positive file_not_found may reject");
  assert.ok(unreadable.phaseControl);

  // Guard is scaffold-only and success-only: other phases and other results pass through
  // even with the marker absent.
  const otherPhase = await executeProtocolTool(
    tu("s3", "phase_complete", { result: "success", next_phase: null }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), readFile: async () => ({ ok: false, error_kind: "file_not_found" }) },
    { phase: "upy-generate-plugin", turn: 3 },
  );
  assert.equal(otherPhase.result.ok, true, "guard is scaffold-phase-only");

  const scaffoldPartial = await executeProtocolTool(
    tu("s4", "phase_complete", { result: "partial", next_phase: null }) as any,
    { intent: "x" },
    { llmClient: scriptedLlm({}), readFile: async () => ({ ok: false, error_kind: "file_not_found" }) },
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(scaffoldPartial.result.ok, true, "a partial scaffold already reports its own trouble");
});

test("quality-gate GENERATE_PLAN errors inject a deterministic corrective message", async () => {
  const bodies: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async (body: any) => {
      // body.messages is the SAME array reference across turns (mutated in place by
      // later turns) -- snapshot it now (message objects themselves are never mutated
      // after being pushed, only appended-to), or a later turn's push would corrupt
      // what this turn actually saw.
      bodies.push({ ...body, messages: [...body.messages] });
      calls++;
      const ev = calls === 1
        ? [tu("q0", "script_run", { script_id: "q", interpreter: "python", script: "check_generate_plan.py", args: ["--require-plan"] }), stop]
        : [tu("q1", "phase_complete", { result: "success", summary: "fixed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const runScript = async () => ({
    ok: true,
    exit_code: 2,
    stdout: "",
    stderr: "",
    structured_errors: [{ code: "GENERATE_PLAN_FILE_PATH_MISSING", path: "firmware/app/x.py" }],
  });

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-maixpy-export-plugin" /* neutral phase: this test is about loop mechanics, not gating or scaffold rendering */, maxTurnsPerPhase: 5 },
    { llmClient: llm, runScript },
  );

  assert.equal(result.terminal, "complete");
  assert.equal(calls, 2);
  // The turn-1 request body's messages must carry a deterministic corrective as the
  // latest user entry -- not just the raw tool_result JSON the model would have to parse.
  const secondBody = bodies[1];
  const lastMessage = secondBody.messages.at(-1);
  assert.equal(lastMessage.role, "user");
  const lastText = lastMessage.content.map((c: any) => c.text ?? "").join("\n");
  assert.match(lastText, /GENERATE_PLAN_FILE_PATH_MISSING/);
  assert.match(lastText, /firmware\/app\/x\.py/);
});

// Drives one generate-phase run whose turn-0 script_run returns `gateStdout` as the
// script's stdout (the real shim shape: report JSON re-serialized onto a stdout string),
// then asserts the corrective user message that lands before turn 1. Shared by the two
// real-report-shape tests below.
async function correctiveTextForGateStdout(gateStdout: string, scriptName: string): Promise<string> {
  const bodies: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async (body: any) => {
      bodies.push({ ...body, messages: [...body.messages] });
      calls++;
      const ev = calls === 1
        ? [tu("q0", "script_run", { script_id: "q", interpreter: "python", script: scriptName, args: ["--project-dir", "."] }), stop]
        : [tu("q1", "phase_complete", { result: "success", summary: "fixed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const runScript = async () => ({ ok: true, exit_code: 2, stdout: gateStdout, stderr: "" });
  const result = await runProtocolBuild(
    // Neutral phase: what these two pin is the corrective built from a gate report, which is
    // phase-agnostic. Running them in a gated phase would additionally require the phase's own
    // validator to pass, testing gating a third time instead of the corrective shape.
    { intent: "x", startPhase: "upy-maixpy-export-plugin", maxTurnsPerPhase: 5 },
    { llmClient: llm, runScript },
  );
  assert.equal(result.terminal, "complete");
  assert.equal(calls, 2);
  const lastMessage = bodies[1].messages.at(-1);
  assert.equal(lastMessage.role, "user", "the corrective must be the latest user message before the retry turn");
  return lastMessage.content.map((c: any) => c.text ?? "").join("\n");
}

test("standalone check_generate_plan.py report (top-level errors[]) fires the corrective message", async () => {
  // REAL shape 1, derived from check_generate_plan.py check_project() (:284-324):
  // granular entries live under top-level `errors` (there is NO structured_errors key).
  // SKILL.md mandates running this standalone (--require-plan before writes,
  // --check-files after), so this shape reaches the loop directly.
  const report = {
    check: "generate_plan",
    project_dir: "/work/proj",
    plan_path: "/work/proj/generate_plan.json",
    check_files: true,
    errors: [
      { code: "GENERATE_PLAN_FILE_PATH_MISSING", section: "tasks", index: 0, message: "Final generate_plan entries must declare project-relative generated file paths" },
      { code: "GENERATE_PLAN_FILE_MISSING", section: "drivers", index: 1, path: "firmware/app/x.py", message: "generate_plan declares a generated file that does not exist in the project" },
    ],
    warnings: [],
    ok: false,
  };
  const text = await correctiveTextForGateStdout(JSON.stringify(report), "check_generate_plan.py");
  assert.match(text, /GENERATE_PLAN_FILE_PATH_MISSING/);
  assert.match(text, /GENERATE_PLAN_FILE_MISSING/);
  assert.match(text, /firmware\/app\/x\.py/);
});

test("run_quality_gates.py report (aggregate structured_errors + nested details.errors) fires the corrective with the GRANULAR entries", async () => {
  // REAL shape 2, derived from run_quality_gates.py (:304-333): one AGGREGATE entry per
  // failing check (code "<NAME>_FAILED", no path) with the check's own granular entries
  // nested at structured_errors[i].details.errors (normalize_script_result :122-136).
  // The corrective must enumerate the granular code+path pairs, not the opaque aggregate.
  const report = {
    check: "quality_gates",
    project_dir: "/work/proj",
    session_dir: "",
    checks: {},
    structured_errors: [
      {
        code: "GENERATE_PLAN_FAILED",
        severity: "error",
        phase_step: "generate_plan",
        retryable: true,
        message: "generate_plan quality gate failed",
        details: {
          returncode: 2,
          errors: [
            { code: "GENERATE_PLAN_FILE_PATH_MISSING", section: "tasks", index: 0, message: "Final generate_plan entries must declare project-relative generated file paths" },
            { code: "GENERATE_PLAN_FILE_MISSING", section: "drivers", index: 1, path: "firmware/app/x.py", message: "generate_plan declares a generated file that does not exist in the project" },
          ],
          stdout: "",
          stderr: "",
        },
      },
    ],
    warnings: [],
    ok: false,
  };
  const text = await correctiveTextForGateStdout(JSON.stringify(report), "run_quality_gates.py");
  assert.match(text, /GENERATE_PLAN_FILE_PATH_MISSING/);
  assert.match(text, /GENERATE_PLAN_FILE_MISSING/);
  assert.match(text, /firmware\/app\/x\.py/);
  // The aggregate is dropped in favor of its granular details -- an opaque
  // "GENERATE_PLAN_FAILED: generate_plan quality gate failed" line tells the model
  // nothing actionable and would dilute the exact-entries instruction.
  assert.ok(!text.includes("GENERATE_PLAN_FAILED"), text);
});

test("non-JSON or JSON-without-error-arrays stdout changes nothing (no corrective, raw result intact)", async () => {
  // Parse defensively: plain-text stdout, broken JSON, JSON with no errors/
  // structured_errors arrays, and a SUCCESS report (empty error arrays) must all leave
  // the host result exactly as today -- structured_errors stays absent.
  for (const stdout of [
    "all checks passed",
    "{not json",
    JSON.stringify({ status: "ok", detail: "no report arrays here" }),
    JSON.stringify({ check: "generate_plan", ok: true, errors: [], warnings: [] }),
    JSON.stringify({ check: "quality_gates", ok: true, structured_errors: [], warnings: [] }),
  ]) {
    const { result } = await executeProtocolTool(
      tu("s", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }) as any,
      { intent: "x" },
      { llmClient: scriptedLlm({}), runScript: async () => ({ ok: true, exit_code: 0, stdout, stderr: "" }) },
    );
    assert.equal(result.ok, true, stdout);
    assert.equal(result.stdout, stdout, "raw stdout must flow to the model unchanged");
    assert.equal(result.structured_errors, undefined, stdout);
  }
});

test("onSafePoint fires after phase_complete and absorbed text folds into the next phase context", async () => {
  // analyze -> select-hw. The host returns absorb text at the safe point after analyze;
  // it must reach select-hw's request context as user_supplements (no schema change).
  const sentBodies: any[] = [];
  const safePointPhases: string[] = [];
  const script: Record<string, any[][]> = {
    "analyze": [[tu("a", "phase_complete", { result: "success", summary: "analyze", next_phase: "select-hw" }), stop]],
    "select-hw": [[tu("s", "phase_complete", { result: "success", summary: "select-hw", next_phase: null }), stop]],
  };
  const baseLlm = scriptedLlm(script);
  const llm = {
    streamMessages: async (body: any) => { sentBodies.push(body); return baseLlm.streamMessages(body); },
  };

  const result = await runProtocolBuild(
    { intent: "x", traceId: "t", onSafePoint: (phase: string) => { safePointPhases.push(phase); return phase === "analyze" ? "also add a buzzer" : null; } },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "complete");
  assert.deepEqual(safePointPhases, ["analyze", "select-hw"], "safe point runs after each phase_complete");
  const selectHw = sentBodies.find((b) => b.phase === "select-hw");
  assert.deepEqual(selectHw.context?.user_supplements, ["also add a buzzer"], "absorbed note reaches the next phase context");
  const analyze = sentBodies.find((b) => b.phase === "analyze");
  assert.equal(analyze.context?.user_supplements, undefined, "the phase that produced the note does not see it in its own context");
});

test("onSafePoint is told whether a next phase exists (false on the terminal phase)", async () => {
  // The host needs hasNextPhase to decide whether an absorb note can actually be folded
  // forward: true after analyze (select-hw follows), false after select-hw (terminal).
  const seen: Array<{ phase: string; hasNext: boolean }> = [];
  const script: Record<string, any[][]> = {
    "analyze": [[tu("a", "phase_complete", { result: "success", summary: "analyze", next_phase: "select-hw" }), stop]],
    "select-hw": [[tu("s", "phase_complete", { result: "success", summary: "select-hw", next_phase: null }), stop]],
  };
  const llm = scriptedLlm(script);

  await runProtocolBuild(
    { intent: "x", traceId: "t", onSafePoint: (phase: string, hasNextPhase: boolean) => { seen.push({ phase, hasNext: hasNextPhase }); return null; } },
    { llmClient: llm },
  );

  assert.deepEqual(seen, [{ phase: "analyze", hasNext: true }, { phase: "select-hw", hasNext: false }]);
});

test("a MaixPy export run terminates on its own phase and never issues a second turn", async () => {
  // The Sipeed vision global tool is a single-phase excursion: the plugin always emits
  // next_phase:null, and the phase is deliberately absent from PHASE_ORDER, so the loop must stop
  // after exactly one server turn — it must not fall through into a canonical flash/deploy phase.
  // Mutation: make the loop advance on a null next_phase (or add maixpy to PHASE_ORDER and chain
  // off it) and a second body appears here.
  const sentBodies: any[] = [];
  const baseLlm = scriptedLlm({
    "upy-maixpy-export-plugin": [[
      tu("m", "phase_complete", {
        result: "success",
        summary: "Generated standalone MaixPy files for a Sipeed vision module.",
        next_phase: null,
        artifacts: [{ type: "file", path: "sipeed_vision/main.py" }, { type: "file", path: "sipeed_vision/README.md" }],
      }),
      stop,
    ]],
  });
  const llm = { streamMessages: async (body: any) => { sentBodies.push(body); return baseLlm.streamMessages(body); } };

  const result = await runProtocolBuild({ intent: "ENVELOPE", startPhase: "upy-maixpy-export-plugin" }, { llmClient: llm });

  assert.equal(result.terminal, "complete");
  assert.deepEqual(result.phases.map((p) => p.phase), ["upy-maixpy-export-plugin"]);
  assert.equal(sentBodies.length, 1, "exactly one turn: the export phase never chains");
  assert.ok(!PHASE_ORDER.includes("upy-maixpy-export-plugin" as never), "the export phase stays out of the canonical chain");
});

test("the MaixPy export short tokens resolve instead of failing as an unknown next phase", async () => {
  // The aliases are load-bearing: a next_phase carrying ruili's short token ("sipeed-vision" /
  // "maixpy-export") must normalize to the plugin dir name. Mutation: drop either alias from
  // PHASE_ALIASES and the run ends terminal:"failed" (unknown_next_phase) instead of running the
  // export phase.
  for (const token of ["sipeed-vision", "maixpy-export"]) {
    const seen: string[] = [];
    const baseLlm = scriptedLlm({
      "analyze": [[tu("a", "phase_complete", { result: "success", summary: "analyze", next_phase: token }), stop]],
      "upy-maixpy-export-plugin": [[tu("m", "phase_complete", { result: "success", summary: "export", next_phase: null }), stop]],
    });
    const llm = { streamMessages: async (body: any) => { seen.push(body.phase); return baseLlm.streamMessages(body); } };

    const result = await runProtocolBuild({ intent: "x" }, { llmClient: llm });

    assert.equal(result.terminal, "complete", `${token} resolves`);
    assert.deepEqual(seen, ["analyze", "upy-maixpy-export-plugin"], `${token} normalizes to the plugin dir name`);
  }
});

// A phase that runs its whole turn budget without a phase_complete is reported as
// phase_stalled/max_turns and nothing else. Without a tool-level trace beside it, the DB
// records that a build looped and not which tool it looped on -- which is what made a
// real upy-generate-plugin stall undiagnosable.
test("protocol loop records a tool_use and a tool_result for every tool it executes", async () => {
  const events: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [tu("s0", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py", args: ["--project-dir", "."] }), stop]
        : [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  const runScript = async () => ({
    ok: true,
    exit_code: 2,
    stdout: "",
    stderr: "",
    structured_errors: [{ code: "GENERATE_PLAN_FILE_PATH_MISSING", path: "firmware/app/x.py" }],
  });

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-maixpy-export-plugin" /* neutral phase: this test is about loop mechanics, not gating or scaffold rendering */, maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript },
  );

  assert.equal(result.terminal, "complete");
  const toolEvents = events.filter((e) => e.type === "tool_use" || e.type === "tool_result");
  assert.deepEqual(
    toolEvents.map((e) => `${e.type}:${e.name}`),
    ["tool_use:script_run", "tool_result:script_run", "tool_use:phase_complete", "tool_result:phase_complete"],
    "each tool is recorded before it runs and after it returns, in execution order",
  );
  // The result must be the REAL one, or the trace says a gate ran and not that it failed.
  // Nested under `output`: the observation is NORMALIZED before it is recorded, because
  // this event lands in session.jsonl and a raw result carries absolute host paths.
  const gateResult = toolEvents[1].observation.output;
  assert.equal(gateResult.success, false);
  assert.deepEqual(gateResult.structured_errors, [{ code: "GENERATE_PLAN_FILE_PATH_MISSING", path: "firmware/app/x.py" }]);
});

test("recorded tool input keeps the call identity and replaces a file body with its length", async () => {
  const events: any[] = [];
  const content = "x".repeat(5000);
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [tu("f0", "file_operation", { operation: "write", path: "firmware/main.py", content }), stop]
        : [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, writeFile: async (path: string) => ({ ok: true, path }) },
  );

  const dispatched = events.find((e) => e.type === "tool_use" && e.name === "file_operation");
  // Short fields survive verbatim: WHICH file was rewritten is the whole signal a
  // rewrite loop gives you.
  assert.equal(dispatched.input.path, "firmware/main.py");
  assert.equal(dispatched.input.operation, "write");
  // The body does not survive at all: telemetry reaches session.jsonl and the consented
  // cloud tool_dispatch payload unredacted, and firmware/conf.py is where this product puts
  // credentials. What IS kept is the length and a digest. The digest answers a question a
  // bare "<5000 chars>" could not: six writes of main.py that all failed the same gate, and
  // no way to tell whether the model changed anything between them.
  const recorded = dispatched.input.content as string;
  assert.match(recorded, /^<5000 chars [0-9a-f]{8}>$/, recorded.slice(0, 60));
  assert.ok(!recorded.includes("x".repeat(50)), "no part of the body text is recorded");
});

test("two different bodies get different digests, and identical ones match", async () => {
  const digestsFor = async (bodies: string[]) => {
    const events: any[] = [];
    let calls = 0;
    const llm = {
      streamMessages: async () => {
        calls++;
        const body = bodies[calls - 1];
        const ev = body !== undefined
          ? [tu(`f${calls}`, "file_operation", { operation: "write", path: "firmware/main.py", content: body }), stop]
          : [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
        return (async function* () { for (const e of ev) yield e; })();
      },
    };
    await runProtocolBuild(
      { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
      { llmClient: llm, writeFile: async (path: string) => ({ ok: true, path }) },
    );
    return events.filter((e) => e.type === "tool_use" && e.name === "file_operation")
      .map((e) => String(e.input.content).match(/^<\d+ chars ([0-9a-f]{8})>/)?.[1]);
  };

  const [a, b] = await digestsFor(["y".repeat(3000), "y".repeat(2999) + "z"]);
  assert.ok(a && b, "both writes recorded a digest");
  assert.notEqual(a, b, "a one character change must change the digest");

  const [c, d] = await digestsFor(["same".repeat(800), "same".repeat(800)]);
  assert.equal(c, d, "an unchanged rewrite must show the same digest");
});

// A NON-body string field is compacted too, and that compaction must never GROW what it
// records. A 400-char head under a 200-char budget put every string in (200, 422] into the
// payload IN FULL and 22 characters longer than it arrived -- the bound enlarging the thing
// it bounds, which is the same arithmetic elide() guards against on the history side.
test("compacting a non-body string bounds a long one and never enlarges a mid-length one", async () => {
  const recordedPathFor = async (path: string) => {
    const events: any[] = [];
    let calls = 0;
    const llm = {
      streamMessages: async () => {
        calls++;
        const ev = calls === 1
          ? [tu("f0", "file_operation", { operation: "write", path, content: "print(1)" }), stop]
          : [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
        return (async function* () { for (const e of ev) yield e; })();
      },
    };
    await runProtocolBuild(
      { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
      { llmClient: llm, writeFile: async (target: string) => ({ ok: true, path: target }) },
    );
    return String(events.find((e) => e.type === "tool_use" && e.name === "file_operation").input.path);
  };

  // 210 characters: the marker plus a head costs more than the string itself, so the string
  // stays as it is rather than being "compacted" into something longer.
  const mid = await recordedPathFor("m".repeat(210));
  assert.ok(mid.length <= 210, `a 210-char field was recorded as ${mid.length} characters`);

  // 5000: compacted, and bounded by the budget plus the marker -- not by a head four times it.
  const long = await recordedPathFor("l".repeat(5000));
  assert.match(long, /^<5000 chars [0-9a-f]{8}> l+$/, long.slice(0, 60));
  assert.ok(long.length < 250, `a 5000-char field was recorded as ${long.length} characters`);
});

test("recorded tool input compacts arrays and nested objects but keeps scalars", async () => {
  const events: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls++;
      const ev = calls === 1
        ? [tu("s0", "script_run", { script_id: "q", interpreter: "python", script: "gate.py", args: ["--a", "--b", "--c"], timeout_ms: 30000, stdin_json: { plan: { entries: [] } } }), stop]
        : [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: "", stderr: "" }) },
  );

  const dispatched = events.find((e) => e.type === "tool_use" && e.name === "script_run");
  assert.deepEqual(dispatched.input, {
    script_id: "q",
    interpreter: "python",
    script: "gate.py",
    // argv verbatim: it is flags and paths, and "<3 items>" makes "what did it actually run"
    // unanswerable. stdin_json stays "<object>" -- that one can carry a file body.
    args: ["--a", "--b", "--c"],
    timeout_ms: 30000,
    stdin_json: "<object>",
  });
});

test("a phase that exhausts its budget reports the tool calls that blocked it, not a bare max_turns", async () => {
  // The real shape of the generate stall: the phase finishes its work and then cannot persist
  // its artifact, retrying rejected writes until the turns run out. "max_turns" alone reads as
  // transient; the blocker is what makes it diagnosable.
  //
  // The path VARIES per turn on purpose. Repeating one rejected path is a cycle and is now
  // stopped as `repeating_calls`, which is the better answer for that shape -- this test is
  // about the max_turns detail, so it drives a phase that keeps trying something new.
  const events: any[] = [];
  let attempt = 0;
  const llm = {
    streamMessages: async () => {
      attempt += 1;
      const ev = [tu(`f${attempt}`, "file_operation", { op: "write", path: `sessions/x${attempt}/phase_complete.json`, content: "{}" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, writeFile: async () => ({ ok: false, error_kind: "invalid_generated_path" }) },
  );

  assert.equal(result.terminal, "stalled");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.reason, "max_turns");
  // Only the most recent few, so a long phase does not ship its whole failure history.
  assert.equal(stalled.detail.length, 3);
  assert.deepEqual(stalled.detail[2], {
    tool: "file_operation",
    error: "invalid_generated_path",
    path: `sessions/x${attempt}/phase_complete.json`,
    // The turn it happened on, which is what lets a reader tell a live failure from an old one.
    turn: 3,
  });
});

test("a stall reports what failed NEAR ITS END, not a failure the phase moved past", async () => {
  // The bug this pins: `recentFailures` was the last 3 failures of the WHOLE phase, unbounded in
  // time. A phase that failed once at the start, fixed it, and then died 40 turns later still
  // reported that first failure as its blocker -- which twice sent triage after a cause that had
  // already been resolved. Here turn 0 fails, nothing after it does, and the phase runs to the
  // cap: the stall must NOT name the turn-0 failure.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      const ev = [tu(`f${turn}`, "file_operation", { op: "write", path: `notes/${turn}.md`, content: "x" }), stop];
      turn += 1;
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 30, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      // Only the very first write fails. Every later one succeeds, so the phase burns its budget
      // going nowhere -- with no recent failure to explain it.
      writeFile: async (p: string) =>
        p.endsWith("notes/0.md") ? { ok: false, error_kind: "invalid_generated_path" } : { ok: true },
    } as any,
  );

  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.ok(stalled, "the phase must still stall");
  assert.deepEqual(
    stalled.detail,
    [],
    "a failure 30 turns stale is not the reason the phase died; reporting it is worse than reporting nothing",
  );
});

test("a stall still reports a failure that is genuinely recent", async () => {
  // The other half, so the fix above cannot be 'always report nothing'. Same shape, but the
  // failure lands on the LAST turn instead of the first.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      const ev = [tu(`f${turn}`, "file_operation", { op: "write", path: `notes/${turn}.md`, content: "x" }), stop];
      turn += 1;
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 30, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (p: string) =>
        p.endsWith("notes/29.md") ? { ok: false, error_kind: "invalid_generated_path" } : { ok: true },
    } as any,
  );

  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.detail.length, 1, "the failure that IS current must survive the recency bound");
  assert.equal(stalled.detail[0].error, "invalid_generated_path");
  assert.equal(stalled.detail[0].turn, 29);
});

test("a stall detail names a rejected gate by its code, and omits a path when the call has none", async () => {
  // A script that RAN but whose gate REJECTED returns ok:true/success:false — read only `ok` and
  // the blocker looks like a success.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("s0", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 2, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, exit_code: 2, stdout: "", stderr: "", structured_errors: [{ code: "CLOUD_OFFICIAL_LINKS_MISSING" }] }),
    },
  );

  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.detail[0].tool, "script_run");
  assert.equal(stalled.detail[0].error, "CLOUD_OFFICIAL_LINKS_MISSING");
  assert.equal(stalled.detail[0].path, "run_quality_gates.py", "a script call is identified by its script");
});

// Negative control for the stall-detail feature: the happy path must stay silent. Not
// mutation-sensitive on its own, kept because it is the only assertion anywhere that a
// successful phase emits no phase_stalled event.
test("a phase that succeeds reports no stall detail at all", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("p0", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "complete");
  assert.equal(events.some((e) => e.type === "phase_stalled"), false);
});

// A phase spent all 60 of its turns on an unused variable and an unused import because the
// corrective message only ever named GENERATE_PLAN entries: lint and test failures carry the
// same structured shape and were filtered out, so the model had to find them in the raw blob.
test("a failing lint gate is named back to the model, not just plan errors", async () => {
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("g", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    {
      llmClient: llm,
      runScript: async () => ({
        ok: true,
        stdout: JSON.stringify({
          check: "quality_gates",
          structured_errors: [{
            code: "FLAKE8_FAILED",
            details: { errors: [{ code: "FLAKE8_FAILED", message: "firmware/tasks/x.py:41:5: F841 local variable 'sensor' is assigned to but never used" }] },
          }],
        }),
      }),
    },
  );

  // Scope every assertion to the corrective message itself: the raw tool_result in the same
  // array also contains FLAKE8_FAILED and the lint line, so asserting over the whole array
  // would pass even if the corrective message were emitted empty.
  const corrective = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("Quality gate failed")) ?? "";
  assert.ok(corrective, "a failing gate must produce a corrective message");
  assert.match(corrective, /FLAKE8_FAILED/);
  assert.match(corrective, /F841 local variable/, "the model must be told the actual lint line, not just that a gate failed");
});

// apply_scaffold reports failures under the phase_complete payload it also emits, not at the
// top level like run_quality_gates. That shape produced no corrective message at all, so a
// scaffold lint failure was invisible to the model while a quality-gate one was named.
test("a scaffold-shaped report, nested under phase_complete, still names its errors", async () => {
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("s", "script_run", { script_id: "s", interpreter: "python", script: "apply_scaffold.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-scaffold-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    {
      llmClient: llm,
      runScript: async () => ({
        ok: true,
        stdout: JSON.stringify({
          status: "partial",
          phase_complete: { payload: { structured_errors: [{ code: "SCAFFOLD_LINT_FAILED", message: "firmware/board.py:71:121: E501 line too long (181 > 120 characters)" }] } },
        }),
      }),
    },
  );

  const corrective = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("Quality gate failed")) ?? "";
  assert.ok(corrective, "a nested scaffold report must produce a corrective message too");
  assert.match(corrective, /SCAFFOLD_LINT_FAILED/);
  assert.match(corrective, /E501 line too long/);
});

// path ?? message showed only the filename whenever a record carried both, which is the
// common case: BOOT_DELAY_MISSING names firmware/main.py AND explains the three second delay,
// and the model was shown the filename alone. It then rewrote main.py six times and failed the
// same gate six times.
// A mid-stream failure ended the phase and the build reported "stalled" with no phase_stalled
// event anywhere: not in the panel, not in the session log, not in the DB. Observed on a real
// run as 56 clean turns and then silence.
test("a stream error stalls the phase OUT LOUD, naming itself", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield { type: "text_delta", text: "working on it" };
      yield { type: "stream_error", message: "upstream closed the connection" };
    })(),
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "stalled");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.ok(stalled, "a stream error must emit phase_stalled like every other stall");
  assert.equal(stalled.reason, "stream_error");
  assert.match(JSON.stringify(stalled.detail), /upstream closed the connection/);
});

test("a stream that dies before producing anything is retried, not thrown away", async () => {
  // Measured: a real generate turn went silent for the whole idle budget and the phase gave up
  // with four phases of work behind it. Nothing arrived on that turn, so nothing is lost by
  // asking again -- no assistant message is appended, so the retry re-issues the same turn.
  const events: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () { yield { type: "stream_error", message: "upstream_stream_interrupted" }; })();
      }
      return (async function* () {
        yield tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} });
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "complete", "a transient stream death must not end the phase");
  assert.equal(calls, 2, "the same turn is re-issued exactly once");
  const retry = events.find((e) => e.type === "stream_retry");
  assert.ok(retry, "the retry must be visible, not silent");
  assert.equal(retry.attempt, 1);
  assert.ok(!events.some((e) => e.type === "phase_stalled"), "a recovered phase must not report a stall");
});

test("the stream-retry budget resets after a turn that produced a tool call", async () => {
  // Without the reset the budget is a phase-lifetime allowance, so a long healthy phase that
  // hits one blip early and two more much later dies on the third, having done all the work in
  // between. It is meant to absorb a burst, so a productive turn clears it.
  const script = ["error", "tool", "error", "error", "tool"];
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      const step = script[calls] ?? "tool";
      calls += 1;
      if (step === "error") {
        return (async function* () { yield { type: "stream_error", message: "upstream_stream_interrupted" }; })();
      }
      return (async function* () {
        // The first tool turn must NOT end the phase, or the later errors are never reached.
        yield calls === 2
          ? tu("s", "status_update", { message: "still working" })
          : tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} });
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 10 },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "complete", "two blips after a productive turn must not stall the phase");
  assert.equal(calls, 5, "every scripted turn ran: the budget was reset, not accumulated");
});

test("a persistently dead stream still stalls, bounded by the retry budget", async () => {
  // The other half: retrying forever would turn a dead provider into a max_turns stall that
  // hides the real reason. It gives up after the budget and still names the cause.
  const events: any[] = [];
  let calls = 0;
  const llm = {
    streamMessages: async () => {
      calls += 1;
      return (async function* () { yield { type: "stream_error", message: "upstream_stream_interrupted" }; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 20, onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  assert.equal(result.terminal, "stalled");
  assert.equal(calls, 3, "two retries then give up, not the whole turn budget");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.reason, "stream_error");
  assert.match(JSON.stringify(stalled.detail), /upstream_stream_interrupted/);
});

test("a stream that throws keeps the reason instead of ending silently", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield { type: "text_delta", text: "partial" };
      throw new Error("socket hang up");
    })(),
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    { llmClient: llm },
  );

  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.ok(stalled, "a thrown stream must not end the phase silently");
  assert.match(JSON.stringify(stalled.detail), /socket hang up/);
});

test("a corrective line carries the path AND the message, not just the path", async () => {
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("g", "script_run", { script_id: "q", interpreter: "python", script: "check_skeleton_compliance.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    {
      llmClient: llm,
      runScript: async () => ({
        ok: true,
        stdout: JSON.stringify({
          errors: [{
            code: "BOOT_DELAY_MISSING",
            path: "firmware/main.py",
            accepted: ["time.sleep(3)", "time.sleep_ms(3000)"],
            message: "main.py must keep a 3 second boot delay for deploy/mpremote reconnect",
          }],
        }),
      }),
    },
  );

  const corrective = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("Quality gate failed")) ?? "";
  assert.match(corrective, /firmware\/main\.py/, "the path must survive");
  assert.match(corrective, /3 second boot delay/, "the message is the only part carrying the hint");
  assert.match(corrective, /time\.sleep\(3\)/, "an accepted-value field must reach the model");
});

test("a corrective message is capped so a hundred lint errors cannot flood the context", async () => {
  const requests: any[] = [];
  const many = Array.from({ length: 40 }, (_, i) => ({ code: "FLAKE8_FAILED", message: `f${i}.py:1:1: E501 ${"x".repeat(900)}` }));
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("g", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    { llmClient: llm, runScript: async () => ({ ok: true, stdout: JSON.stringify({ structured_errors: many }) }) },
  );

  const texts = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .filter((t: string) => t.startsWith("Quality gate failed"));
  assert.equal(texts.length, 1, "exactly one corrective message for the failing gate");
  assert.match(texts[0], /\d+ more/, "the tail is summarised rather than dropped silently");
  assert.ok(texts[0].length < 6500, `corrective message is ${texts[0].length} chars, it must stay a nudge`);
});

test("every short gate code reaches the model, not just the first ten", async () => {
  // Measured: check_phase_complete_consistency.py returned 18 codes in one attempt. Under a
  // count cap the model saw 10, fixed those, met the remaining 8 next turn while its edits
  // broke others, and generate spent 44 turns on that trade before dying on max_turns. These
  // codes are short, so all of them fit the byte budget the lint wall is there to enforce.
  const requests: any[] = [];
  const codes = [
    "CHECKPOINT_NOT_PHASE_COMPLETED", "FILE_MANIFEST_ARTIFACT_MISSING", "FILE_MANIFEST_MISSING_SESSION_STATE",
    "GATE_SECTION_MISSING", "GIT_COMMIT_MISSING", "HARDWARE_SELECTION_CHANGED_IN_GENERATE",
    "MANIFEST_BEHAVIOR_SPEC_MISSING", "MANIFEST_CONTENT_MISSING", "MANIFEST_DEVICES_MISSING",
    "MANIFEST_GENERATE_SECTION_MISSING", "MANIFEST_GIT_COMMIT_ROLE_MISSING", "MANIFEST_PINOUT_MISSING",
    "MANIFEST_REQUIRED_FIELD_MISSING", "NEW_HARDWARE_REQUIRES_UPSTREAM_SELECTION", "PERMISSIONS_MISSING",
    "SESSION_STATE_CHECKPOINT_STATE_MISSING", "SESSION_STATE_MISSING", "DRIVER_READY_MARKER_MISSING",
  ].map((code) => ({ code, message: `${code} must be satisfied` }));
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("g", "script_run", { script_id: "q", interpreter: "python", script: "scripts/check_phase_complete_consistency.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    { llmClient: llm, runScript: async () => ({ ok: true, stdout: JSON.stringify({ structured_errors: codes }) }) },
  );

  const corrective = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("Quality gate failed")) ?? "";

  for (const { code } of codes) {
    assert.ok(corrective.includes(code), `${code} was withheld from the model`);
  }
  assert.ok(!/more; the full report/.test(corrective), "nothing should be dropped for 18 short codes");
});

test("a stall detail reads a string-shaped gate report, not just {code} objects", async () => {
  // REAL shape: select_hw_manifest.py collects `errors: list[str]`, one plain string per
  // problem. Reading only `.code` reported the blocker as a bare "failed".
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("s0", "script_run", { script_id: "q", interpreter: "python", script: "select_hw_manifest.py" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 2, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => ({
        ok: true,
        exit_code: 1,
        stdout: JSON.stringify({ errors: ["selected_board.display_name is required", "hardware_plan.mcu.model is required"] }),
        stderr: "",
      }),
    },
  );

  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.detail[0].error, "selected_board.display_name is required", "the first real problem, not 'failed'");
  assert.equal(stalled.detail[0].path, "select_hw_manifest.py");
});

test("a rejected write tells the model what IS writable, so it corrects instead of guessing", async () => {
  const results: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("f0", "file_operation", { op: "write", path: "phase_complete_draft.json", content: "{}" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 1, onEvent: (e: any) => { if (e.type === "tool_result") results.push(e.observation); } },
    { llmClient: llm, writeFile: async () => ({ ok: false, error_kind: "invalid_generated_path", allowed: "Writable: any *.json at the project root; ..." }) },
  );

  assert.equal(results[0].output.error, "invalid_generated_path");
  assert.match(results[0].output.allowed, /Writable: any \*\.json at the project root/, "the hint reaches the model's tool result");
});

test("a successful write carries no allowance hint (it is only for rejections)", async () => {
  const results: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("f0", "file_operation", { op: "write", path: "project-manifest.json", content: "{}" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 1, onEvent: (e: any) => { if (e.type === "tool_result") results.push(e.observation); } },
    { llmClient: llm, writeFile: async (path: string) => ({ ok: true, path }) },
  );

  assert.equal(results[0].ok, true);
  assert.equal("allowed" in results[0].output, false);
});

test("a recorded tool_result is redacted: no absolute host path reaches the session log", async () => {
  const results: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("s0", "script_run", { script_id: "q", interpreter: "python", script: "run_quality_gates.py" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };
  // What a real failure looks like: a Python traceback naming the user's home directory.
  const runScript = async () => ({
    ok: false,
    error_kind: "script_error",
    stderr: 'Traceback (most recent call last):\n  File "C:\\Users\\Haipeng Wu\\Desktop\\proj\\firmware\\main.py", line 5\n    SyntaxError: invalid syntax\n',
    project_dir: "C:\\Users\\Haipeng Wu\\Desktop\\proj",
  });

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 1, onEvent: (e: any) => { if (e.type === "tool_result") results.push(e.observation); } },
    { llmClient: llm, runScript },
  );

  const recorded = JSON.stringify(results[0]);
  assert.ok(!recorded.includes("Haipeng Wu"), `the username must not reach the session log: ${recorded.slice(0, 400)}`);
  assert.match(recorded, /redacted-path/, "the path is redacted rather than dropped");
  // Redaction must not cost the diagnosis: the failure kind still has to survive it.
  assert.equal(results[0].error_kind, "script_error");
  assert.match(results[0].output.stderr, /SyntaxError: invalid syntax/);
});

// The replayed conversation is re-sent on EVERY request, so an unbounded history walks into
// the model's context limit and takes a non-retryable 400 that kills the run outright
// (measured: 264,708 tokens against a 262,144 ceiling). capToolOutput bounds ONE result;
// this bounds their sum. The pairing assertion matters as much as the size one: dropping an
// assistant tool_use without its tool_result makes the upstream reject the whole
// conversation, which is the same failure class as the empty-assistant turn.
test("a long phase bounds the replayed history without breaking tool_use/tool_result pairing", async () => {
  const bodies: any[] = [];
  const huge = "x".repeat(70_000);
  const llm = {
    streamMessages: async (body: any) => {
      bodies.push(JSON.parse(JSON.stringify(body)));
      return (async function* () {
        yield tu(`call-${bodies.length}`, "script_run", { interpreter: "python", script: "check.py" });
        yield stop;
      })();
    },
  };
  let gateRun = 0;
  await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 20 },
    {
      llmClient: llm,
      // exit_code, not `success`: the loop derives success from the exit code, and a gate
      // that keeps FAILING is what makes this phase legitimately long. Repeating a
      // succeeding call instead would (rightly) be stopped as a loop.
      // The reported error must CHANGE each turn, which is what an honest long phase looks
      // like: a gate naming a new problem as each previous one is fixed. An unchanging error
      // is now stopped at the fourth repeat, so a fixed body would end this phase at 4 turns
      // and it would no longer be testing a long history at all.
      runScript: async () => {
        gateRun += 1;
        return { ok: true, exit_code: 1, stdout: `{"status":"fail","errors":["gate step ${gateRun} failed"],"pad":"${huge}"}` };
      },
    } as any,
  );

  const sizes = bodies.map((b) => JSON.stringify(b.messages).length);
  const peak = Math.max(...sizes);
  assert.ok(bodies.length >= 10, `expected a long phase, got ${bodies.length} turns`);
  assert.ok(peak < 900_000, `replayed history grew unbounded: peak ${peak} chars`);

  // Every tool_use in the final request must still have its tool_result, and vice versa.
  const last = bodies[bodies.length - 1].messages;
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of last) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") useIds.add(block.id);
      if (block.type === "tool_result") resultIds.add(block.tool_use_id);
    }
  }
  for (const id of useIds) assert.ok(resultIds.has(id), `tool_use ${id} lost its tool_result`);
  for (const id of resultIds) assert.ok(useIds.has(id), `tool_result ${id} has no tool_use`);

  // The newest result is never collapsed: the model repairs against the latest gate report.
  const newest = JSON.stringify(last[last.length - 1]);
  assert.ok(!newest.includes("<elided"), "the most recent tool result was elided");
});

// Tool inputs reach session.jsonl and the consented cloud tool_dispatch payload without
// redaction. A generated firmware/conf.py is where this product puts credentials, so the
// raw head of a body field must never be recorded — at any length, since a short conf.py
// is still a file body. The length and digest stay: they answer which file changed and
// how often, which is what a stall triage reads.
test("telemetry records a file body as length and digest only, never its text", async () => {
  const SECRET = "WIFI_PASSWORD = \"hunter2-not-a-placeholder\"";
  const events: any[] = [];
  const llm = scriptedLlm({
    analyze: [[tu("w1", "file_operation", { op: "write", path: "firmware/conf.py", content: `${SECRET}\n${"x".repeat(5000)}` }), stop]],
  });
  await runProtocolBuild(
    { intent: "x", traceId: "t", onEvent: (e: any) => events.push(e) },
    { llmClient: llm, writeFile: async () => ({ ok: true }) },
  );

  const toolUse = events.find((e) => e.type === "tool_use" && e.name === "file_operation");
  assert.ok(toolUse, "a tool_use event was recorded");
  const recorded = JSON.stringify(toolUse.input);
  assert.ok(!recorded.includes("hunter2"), `the secret reached telemetry: ${recorded.slice(0, 120)}`);
  assert.ok(!recorded.includes("WIFI_PASSWORD"), "the body text reached telemetry");
  assert.match(recorded, /<\d+ chars [0-9a-f]{8}>/, "length and digest are still recorded");
  assert.equal(toolUse.input.path, "firmware/conf.py", "the path stays readable");
});

// The same guard must hold for a SHORT body, which the length budget used to pass verbatim.
test("telemetry compacts a short file body too", async () => {
  const events: any[] = [];
  const llm = scriptedLlm({
    analyze: [[tu("w2", "file_operation", { op: "write", path: "firmware/conf.py", content: "API_KEY = \"sk-live-abc123\"" }), stop]],
  });
  await runProtocolBuild(
    { intent: "x", traceId: "t", onEvent: (e: any) => events.push(e) },
    { llmClient: llm, writeFile: async () => ({ ok: true }) },
  );
  const toolUse = events.find((e) => e.type === "tool_use" && e.name === "file_operation");
  assert.ok(!JSON.stringify(toolUse.input).includes("sk-live-abc123"), "a short body leaked verbatim");
});

// An argv array is the first thing anyone asks about a failing script_run, and recording it
// as "<16 items>" made the question unanswerable: a real request for the exact invocation of
// deploy_result.py could not be answered from the session log, the cloud tool_dispatch rows
// or the turn records, because all three carry this one compacted value.
test("telemetry records script_run arguments verbatim, not as a count", async () => {
  const events: any[] = [];
  const ARGS = ["--strategy", "clean_then_upload", "--port", "/dev/cu.usbmodem101", "--output-json", "deploy_result.json"];
  const llm = scriptedLlm({
    analyze: [[tu("s1", "script_run", { script_id: "r", interpreter: "python", script: "deploy_result.py", args: ARGS }), stop]],
  });
  await runProtocolBuild(
    { intent: "x", traceId: "t", onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, stdout: "{}", exit_code: 0 }) },
  );

  const toolUse = events.find((e) => e.type === "tool_use" && e.name === "script_run");
  assert.ok(toolUse, "a script_run tool_use event was recorded");
  assert.deepEqual(toolUse.input.args, ARGS, "the exact argv must be recoverable from telemetry");
  assert.equal(toolUse.input.script, "deploy_result.py");
});

test("a long or body-shaped array element is still clamped, and a huge array is bounded", async () => {
  const events: any[] = [];
  const HUGE = "y".repeat(5000);
  const MANY = Array.from({ length: 60 }, (_, i) => `--flag-${i}`);
  const llm = scriptedLlm({
    analyze: [[tu("s2", "script_run", { script_id: "r", interpreter: "python", script: "x.py", args: [HUGE, ...MANY] }), stop]],
  });
  await runProtocolBuild(
    { intent: "x", traceId: "t", onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, stdout: "{}", exit_code: 0 }) },
  );

  const recorded = events.find((e) => e.type === "tool_use" && e.name === "script_run").input.args;
  assert.match(recorded[0], /^<5000 chars [0-9a-f]{8}> y+/, "an over-budget element keeps its digest and head");
  assert.ok(recorded.length <= 41, `the array must stay bounded, got ${recorded.length} entries`);
  assert.match(recorded[recorded.length - 1], /^<\d+ more items>$/, "the tail says how many were dropped");
});

// The measured loop, reproduced: generate recorded project HEAD into project-manifest.json,
// amended the commit to include that manifest (which changed HEAD), read the new HEAD, and
// went round again. Ten times, every call returning ok, until the 60-turn cap killed the
// phase with four phases of work behind it.
const AMEND_COMMAND = ["git", "add", "-A", "&&", "git", "commit", "--amend", "--no-edit"].join(" ");

function commitHashChasingLlm(counter: { turns: number }) {
  return {
    streamMessages: async () => {
      counter.turns += 1;
      const step = counter.turns % 3;
      // A DIFFERENT body every turn (a new hash), which is what makes this invisible to any
      // check that keys on the payload rather than on the identity of the call.
      const event = step === 1
        ? tu(`w${counter.turns}`, "file_operation", { op: "write", path: "project-manifest.json", content: `{"commit":"hash-${counter.turns}"}` })
        : step === 2
          ? tu(`c${counter.turns}`, "script_run", { interpreter: "shell", command: AMEND_COMMAND })
          : tu(`r${counter.turns}`, "script_run", { interpreter: "shell", command: "git rev-parse HEAD" });
      return (async function* () { yield event; yield stop; })();
    },
  };
}

test("a phase that repeats the same calls forever is stopped, not left to burn its budget", async () => {
  const counter = { turns: 0 };
  const events: any[] = [];
  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 60, onEvent: (e: any) => events.push(e) },
    {
      llmClient: commitHashChasingLlm(counter),
      writeFile: async () => ({ ok: true, success: true }),
      // Every call SUCCEEDS. That is the whole point: nothing here is failing, so nothing
      // is asking the model to try again, and it does anyway.
      runScript: async () => ({ ok: true, exit_code: 0, stdout: "" }),
    } as any,
  );

  assert.equal(result.terminal, "stalled");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled.reason, "repeating_calls", "the reason must name the loop, not max_turns");
  assert.equal(stalled.cycle.length, 3, "the reported cycle is the real period: write -> commit -> rev-parse");
  assert.ok(stalled.cycle.some((s: string) => s.includes("project-manifest.json")), stalled.cycle.join(","));

  // The point of the guard: it costs a handful of turns, not the phase's whole budget.
  assert.ok(counter.turns < 20, `stopped after ${counter.turns} turns, should be far below the 60-turn cap`);

  // Nudged once before giving up, and the nudge names what is being repeated.
  const nudge = events.find((e) => e.type === "repeating_calls");
  assert.ok(nudge, "the model gets one chance to break out on its own");
  assert.ok(nudge.turn < 12, `nudged at turn ${nudge?.turn}`);
});

test("uploading file after file with the same script is not a loop", async () => {
  // Measured, and it killed a working deploy: the upload step runs ONE script with the same
  // port over and over, and only the argv says which file is going up. A signature that
  // dropped argv collapsed all four into one call and stalled the phase on the fourth file.
  const uploads = [
    ["--run", "--port", "/dev/cu.usbmodem1101", "--", "resume", "fs", "cp", "firmware/boot.py", ":boot.py"],
    ["--run", "--port", "/dev/cu.usbmodem1101", "--", "resume", "fs", "cp", "firmware/conf.py", ":conf.py"],
    ["--run", "--port", "/dev/cu.usbmodem1101", "--", "resume", "fs", "cp", "firmware/main.py", ":main.py"],
    ["--run", "--port", "/dev/cu.usbmodem1101", "--", "resume", "fs", "cp", "-r", "firmware/lib", ":"],
  ];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const step = turn++;
      const event = step >= uploads.length
        ? tu("done", "phase_complete", { result: "success", summary: "deployed", next_phase: null })
        : tu(`u${step}`, "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args: uploads[step] });
      return (async function* () { yield event; yield stop; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-maixpy-export-plugin" /* neutral phase: this test is about loop mechanics, not gating or scaffold rendering */, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: "{}" }) } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.equal(events.filter((e) => e.type === "repeating_calls").length, 0, "different files are different work");
});

test("deploy's documented handoff ends the build instead of failing it", async () => {
  // Measured: a six-phase run where every phase reported success and the board was running
  // the firmware was marked terminal:"failed", because deploy handed off to
  // project-library-upload -- which is deploy's OWN documented success next_phase, pinned by
  // its sample payload and asserted in its smoke test. We do not serve that flow, and not
  // serving it means the build is finished, not broken.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield tu("d", "phase_complete", { result: "success", summary: "deployed", next_phase: "project-library-upload" });
      yield stop;
    })(),
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-deploy-plugin", onEvent: (e: any) => events.push(e) },
    { llmClient: llm } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.equal(result.phases.at(-1)?.result, "success");
  assert.ok(events.some((e) => e.type === "phase_handoff_unserved" && e.next_phase === "project-library-upload"),
    "the handoff is still reported, so an unserved phase stays visible in the log");
});

test("an invented next phase is still a failure", async () => {
  // The other side: a model that names a phase nobody serves and nobody documents is asking
  // for work that will never happen. Completing the build there would hide it.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield tu("d", "phase_complete", { result: "success", summary: "done", next_phase: "upy-verify-plugin" });
      yield stop;
    })(),
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-deploy-plugin", onEvent: (e: any) => events.push(e) },
    { llmClient: llm } as any,
  );

  assert.equal(result.terminal, "failed");
  assert.ok(events.some((e) => e.type === "phase_error" && e.error_kind === "unknown_next_phase"));
});

test("a passing consistency check tells the model to stop", async () => {
  // Measured across three runs: the checker passed and the model kept going -- committing
  // again, which moved HEAD, which staled the hash it had just recorded, which made the
  // checker fail on the next attempt. One run died at the turn cap holding a verdict it had
  // already earned. A failing gate was told what to fix; a passing one said nothing.
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("c", "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py" }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"ok":true,"errors":[]}' }) } as any,
  );

  const nudge = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("The consistency check PASSED"));

  assert.ok(nudge, "a passing consistency check must tell the model it is done");
  assert.match(nudge, /do not run git again/i, "the reason it kept going must be named");
});

test("the same call failing with the same error three times draws a nudge, four ends the phase", async () => {
  // One phase ran the same validator 10 consecutive times for the byte-identical error and died
  // at the turn cap. The cycle guard could not see it: that guard requires an all-SUCCESS window,
  // on the reasoning that a failing gate names what to fix. True only while the failure CHANGES.
  const events: any[] = [];
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      return (async function* () { for (const e of [tu(`g${requests.length}`, "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 12, onEvent: (e: any) => events.push(e) },
    // Byte-identical failure every time, which is exactly what the archived stall looked like.
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["core fields differ from compare manifest"]}' }) } as any,
  );

  const nudged = events.find((e) => e.type === "repeating_failure");
  assert.ok(nudged, "an unchanging failure must be named before the budget is spent");
  const told = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.includes("IDENTICAL error"));
  assert.ok(told, "the model must be told the error never changed, not just that it is stuck");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled?.reason, "repeating_failure", "the fourth identical failure ends the phase");
  assert.equal(result.terminal, "stalled");
  // The point of the guard: it ends in a handful of turns, not at the cap.
  assert.ok(requests.length < 12, `must not burn the budget (used ${requests.length} of 12)`);
});

test("a fix loop whose error CHANGES is never called a repeating failure", async () => {
  // The guard must not punish convergence. PC_UNITTEST_FAILED repeats with DIFFERENT failing
  // tests during an honest fix loop, which is why identity is the whole error payload and not
  // the code: keying on the code alone would call three real fixes a stall.
  const events: any[] = [];
  let n = 0;
  const llm = {
    streamMessages: async () => {
      n += 1;
      const ev = n <= 4
        ? [tu(`g${n}`, "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "ok", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  let call = 0;
  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 8, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => {
        call += 1;
        if (call <= 2) return { ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["test_blink failed"]}' };
        if (call === 3) return { ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["test_timer failed"]}' };
        return { ok: true, exit_code: 0, stdout: '{"status":"ok","errors":[]}' };
      },
    } as any,
  );

  assert.ok(!events.some((e) => e.type === "repeating_failure"), "a changing error is convergence, not a loop");
  assert.equal(result.terminal, "complete", "the phase that fixed its problem must still finish");
});

test("one error that never changes is nudged even when the call and the rest of the set do", async () => {
  // The shape of a live generate phase, replayed: MANIFEST_BEHAVIOR_SPEC_MISSING came back from
  // five consecutive gate runs, unchanged, and drew nothing -- because the model added
  // `--session-dir` to one call (a different signature) and collected an unrelated second error
  // on another (a different payload), so the identical-failure counter never reached two.
  const events: any[] = [];
  const requests: any[] = [];
  const stuck = { code: "MANIFEST_BEHAVIOR_SPEC_MISSING", message: "manifest_content.generate.behavior_spec is required" };
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      // Every call differs from the last, exactly as the archived run did.
      const args = requests.length % 2 === 1
        ? ["--phase-complete", "phase_complete.upy_generate_plugin.json", "--project-dir", "."]
        : ["--phase-complete", "phase_complete.upy_generate_plugin.json", "--project-dir", ".", "--session-dir", ".mpyhw/s"];
      return (async function* () {
        for (const e of [tu(`g${requests.length}`, "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args }), stop]) yield e;
      })();
    },
  };

  let call = 0;
  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => {
        call += 1;
        // The one entry that never moves, surrounded by errors that do.
        const others = call === 2 ? [{ code: "GIT_COMMIT_MISSING", message: "payload.generate.git.commit is required" }]
          : call === 3 ? [{ code: "SESSION_STATE_PHASE_COMPLETE_MISMATCH", message: "manifest_hash differs" }]
            : [];
        return { ok: true, exit_code: 2, stdout: JSON.stringify({ result: "failed", errors: [stuck, ...others] }) };
      },
    } as any,
  );

  const nudged = events.find((e) => e.type === "repeating_failure");
  assert.ok(nudged, "an entry that survives three runs must be named");
  assert.match(String(nudged.entry), /MANIFEST_BEHAVIOR_SPEC_MISSING/, "the nudge must name the entry that never changed");
  assert.equal(nudged.count, 3);
  const told = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.includes("come back UNCHANGED"));
  assert.ok(told, "the model must be told WHICH problem it never touched");
  assert.match(told, /behavior_spec is required/, "naming the code without the message leaves it guessing which field");
  // Nudge only. Replayed over the archived runs, entries persisting three times are common in
  // runs that then pass, so ending the phase here would refuse honest convergence.
  assert.ok(!events.some((e) => e.type === "phase_stalled" && e.reason === "repeating_failure"),
    "an unchanged entry must never end the phase by itself");
});

test("an error that comes back after being fixed is not an unchanged one", async () => {
  // The count has to mean CONSECUTIVE. A gate that stops reporting a problem and reports it
  // again later is a regression the model is already responding to, not a problem it never
  // touched -- and three of those spread over a phase must not read as a stall.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      return (async function* () {
        for (const e of [tu(`g${turn}`, "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args: ["--project-dir", "."] }), stop]) yield e;
      })();
    },
  };

  let call = 0;
  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => {
        call += 1;
        const code = call === 2 ? "GIT_COMMIT_MISSING" : "MANIFEST_BEHAVIOR_SPEC_MISSING";
        return { ok: true, exit_code: 2, stdout: JSON.stringify({ result: "failed", errors: [{ code, message: `${code} detail` }] }) };
      },
    } as any,
  );

  assert.ok(!events.some((e) => e.type === "repeating_failure"), "an interrupted error is not an unchanging one");
});

test("the drafts and logs a validator reads are never flagged as fabricated evidence", async () => {
  // Measured on a live run: EIGHT evidence warnings, every one for a file the model is supposed
  // to author -- select_hw_draft.json is the input select_hw_manifest.py normalizes, and the
  // phase logs are the model's own record. Same class as the phase_complete payload.
  const events: any[] = [];
  let turn = 0;
  const authored = ["sessions/s/select_hw_draft.json", "sessions/s/select_hw_phase_log.md", "project-manifest.json"];
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn <= authored.length
        ? [tu(`w${turn}`, "file_operation", { op: "write", path: authored[turn - 1], content: "{}" }), stop]
        : turn === authored.length + 1
          ? [tu("g", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: [...SELECT_HW_GATE_ARGS, ...authored] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 8, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (path: string) => ({ ok: true, path }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"ok","errors":[]}' }),
    } as any,
  );

  const flagged = events.filter((e) => e.type === "gate_evidence_model_written");
  assert.deepEqual(flagged, [], `writing a validator's own input is the correct action, got ${JSON.stringify(flagged)}`);
});

test("hand-written evidence is still flagged alongside the drafts a validator reads", async () => {
  // The other half: the exclusion must not blind the guard. One archived deploy hand-wrote six
  // artifacts and ran neither producing script, and that is what this exists to catch.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("w1", "file_operation", { op: "write", path: "phase_complete.upy_deploy_plugin.json", content: "{}" }), stop]
        : turn === 2
          ? [tu("w2", "file_operation", { op: "write", path: "device_tests_result.json", content: "{}" }), stop]
          : turn === 3
            ? [tu("g", "script_run", { interpreter: "python", script: "scripts/deploy_result.py", args: ["--phase-complete", "phase_complete.upy_deploy_plugin.json", "--device-tests-json", "device_tests_result.json"] }), stop]
            : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (path: string) => ({ ok: true, path }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"PASS","errors":[]}' }),
    } as any,
  );

  const flagged = events.find((e) => e.type === "gate_evidence_model_written");
  assert.ok(flagged, "a hand-written device_tests_result.json must still be caught");
  assert.deepEqual(flagged.files, ["device_tests_result.json"], "only the evidence file, not the payload beside it");
});

test("generate gets a larger turn budget than the other phases", async () => {
  // Not a preference, a measurement: one archived generate spent 39 of its 60 calls writing and
  // reading the code it was there to produce, reached its second gate verdict with 26 errors,
  // and had nothing left to converge with. Every run that has COMPLETED generate used 71-81
  // calls. A phase whose own work costs more than its budget cannot be rescued by clearer gates.
  const turnsPerPhase: Record<string, number> = {};
  const llm = {
    streamMessages: async (body: any) => {
      const n = (turnsPerPhase[body.phase] = (turnsPerPhase[body.phase] ?? 0) + 1);
      // A SUCCEEDING call with a different path each turn: it never finishes the phase, so the
      // phase runs to its own turn cap. Prose-only turns would stop at the much smaller
      // toolless cap instead and measure nothing about this budget; a repeated identical call
      // would be stopped by the cycle guard.
      return (async function* () { for (const e of [tu(`w${n}`, "file_operation", { op: "write", path: `notes/${n}.md`, content: "x" }), stop]) yield e; })();
    },
  };

  for (const phase of ["upy-generate-plugin", "select-hw"]) {
    await runProtocolBuild(
      { intent: "x", startPhase: phase, onEvent: () => {} } as any,
      { llmClient: llm, writeFile: async (path: string) => ({ ok: true, path }) } as any,
    );
  }

  assert.ok(
    turnsPerPhase["upy-generate-plugin"] > turnsPerPhase["select-hw"],
    `generate must get more budget than a default phase (generate=${turnsPerPhase["upy-generate-plugin"]}, select-hw=${turnsPerPhase["select-hw"]})`,
  );
});

test("a phase that gives up with partial does not complete the build", async () => {
  // select-hw could not resolve the board, said so honestly with result=partial and next_phase
  // null, and the build reported terminal "complete" -- because only "failed" was special-cased.
  // A phase that did not finish its work has not completed the build.
  const llm = {
    streamMessages: async () => {
      const ev = [tu("p", "phase_complete", { result: "partial", summary: "board definition not found", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 2, onEvent: () => {} },
    { llmClient: llm } as any,
  );

  assert.notEqual(result.terminal, "complete", "a partial phase must never read as a completed build");
  assert.equal(result.terminal, "partial");
});

test("a project-local script path is told why it can never resolve", async () => {
  // Twice now a model reached for a helper inside the project: tools/flash_device.py (retried
  // three times, then abandoned for a manual file-by-file upload) and an invented
  // tools/build_phase_complete.py that ate the rest of a phase. script_not_found alone reads as
  // "wrong name", so the model keeps guessing at the lookup instead of the approach.
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("s", "script_run", { interpreter: "python", script: "tools/build_phase_complete.py" }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "blocked", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-maixpy-export-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => { if (e.type === "tool_result") observations.push(e.observation); } },
    { llmClient: llm, runScript: async () => ({ ok: false, error_kind: "script_not_found" }) } as any,
  );

  const detail = observations.map((o: any) => String(o?.detail ?? o?.output?.detail ?? "")).find((d: string) => d.includes("BUNDLED PLUGIN"));
  assert.ok(detail, "the refusal must say a project path can never resolve, not just 'not found'");
  assert.match(detail, /file_operation/, "and it must name the legal route");
});

test("a bundled script that is merely misnamed keeps the plain not-found result", async () => {
  // The boundary explanation must not attach itself to an ordinary typo in a bundled name --
  // that would bury the real hint (the candidates list) under a paragraph about project paths.
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("s", "script_run", { interpreter: "python", script: "deploy_reslt.py" }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "blocked", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-maixpy-export-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => { if (e.type === "tool_result") observations.push(e.observation); } },
    { llmClient: llm, runScript: async () => ({ ok: false, error_kind: "script_not_found" }) } as any,
  );

  const detail = observations.map((o: any) => String(o?.detail ?? o?.output?.detail ?? "")).find((d: string) => d.includes("BUNDLED PLUGIN"));
  assert.equal(detail, undefined, "a bare bundled name is a typo, not a project-path mistake");
});

test("the script's accepted_flags reach the model, not just the shim", async () => {
  // The shim reads a script's own option list and attaches it so the model never needs a
  // `--help` turn. The first version of that fix was invisible: this loop rebuilds the script
  // result from a FIXED field list, so the shim attached accepted_flags and the loop dropped
  // them. A run afterwards still made 10 --help probes, and the field never once appeared in a
  // recorded result. One layer fixed, the next layer discarding it.
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("s", "script_run", { interpreter: "python", script: "scripts/deploy_result.py", args: ["--output-json", "x.json"] }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-maixpy-export-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => { if (e.type === "tool_result") observations.push(e.observation); } },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, exit_code: 0, stdout: "{}", accepted_flags: ["--output-json", "--port"] }),
    } as any,
  );

  const flags = observations.map((o: any) => o?.accepted_flags ?? o?.output?.accepted_flags).find(Boolean);
  assert.deepEqual(flags, ["--output-json", "--port"], "the flag list must survive into the model-facing result");
});

test("a device call after the final reset is refused, and told to read the file instead", async () => {
  // Measured twice on hardware: the final reset matched its marker, so the board was provably
  // running the deployed app -- and then the model issued `device_command ls` to double-check the
  // upload, five times in one run. Every one opened the raw REPL and stopped main.py, with
  // nothing left to restart it, so deploy reported success over a dark board. Three rounds of
  // SKILL wording did not stop it; this does.
  const events: any[] = [];
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("f", "script_run", { interpreter: "python", script: "scripts/capture_repl.py", args: ["--reset-first", "--output-json", "final_reset_capture.json"] }), stop]
        : turn === 2
          ? [tu("l", "device_command", { action: "ls", path: "/" }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  let deviceCalls = 0;
  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => { events.push(e); if (e.type === "tool_result") observations.push(e.observation); } },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"success","matched_stop":"MPYHW_READY"}' }),
      device: async () => { deviceCalls += 1; return { ok: true, entries: [] }; },
    } as any,
  );

  assert.equal(deviceCalls, 0, "the device must not be touched after the final reset");
  assert.ok(events.some((e) => e.type === "device_after_final_reset"), "the refusal must be visible in the event stream");
  const told = observations.map((o: any) => String(o?.detail ?? "")).find((d: string) => d.includes("upload_summary.json"));
  assert.ok(told, "the refusal must name the file that answers the question it was asking");
});

test("an upload that writes no evidence file is refused while re-running it is still legal", async () => {
  // Measured on hardware: the upload ran clean WITHOUT --output-json, so no upload_summary.json
  // existed. The final reset then ran correctly (board booted, printed MPYHW_READY). From that
  // point the only step that could produce the missing artifact was the upload itself, and the
  // post-reset guard refused it four times, so the model hand-wrote upload_summary.json and
  // deploy_result.py graded the forgery PASS. Refusing at upload time is what prevents the debt.
  const uploads: string[] = [];
  const events: any[] = [];
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("u", "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args: ["--run", "--port", "P", "--", "resume", "fs", "cp", "-r", "firmware/main.py", ":"] }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "x", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 4, onEvent: (e: any) => { events.push(e); if (e.type === "tool_result") observations.push(e.observation); } },
    {
      llmClient: llm,
      runScript: async (req: any) => { uploads.push(String(req?.script ?? "")); return { ok: true, exit_code: 0, stdout: "{}" }; },
    } as any,
  );

  assert.equal(uploads.length, 0, "the evidence-less upload must not execute");
  assert.ok(events.some((e) => e.type === "upload_without_evidence"), "the refusal must be visible in the event stream");
  const told = observations.map((o: any) => String(o?.detail ?? "")).find((d: string) => d.includes("--output-json upload_summary.json"));
  assert.ok(told, "the refusal must name the exact flag to add");
});

test("an upload that already writes its evidence file runs untouched", async () => {
  // The guard must fire on the missing flag only. Refusing a correct upload would block deploy.
  const uploads: string[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("u", "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args: ["--run", "--port", "P", "--output-json", "upload_summary.json", "--", "resume", "fs", "cp", "-r", "firmware/main.py", ":"] }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "x", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 4 },
    {
      llmClient: llm,
      runScript: async (req: any) => { uploads.push(String(req?.script ?? "")); return { ok: true, exit_code: 0, stdout: "{}" }; },
    } as any,
  );

  assert.equal(uploads.length, 1, "a correct upload must still execute");
});

test("a non-upload mpremote call without --output-json is not refused", async () => {
  // Only `fs cp` produces the upload summary deploy grades. mkdir/ls/rm probes write no summary,
  // and refusing them would break the directory setup the upload itself depends on.
  const calls: string[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("m", "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args: ["--run", "--port", "P", "--", "resume", "fs", "mkdir", ":lib"] }), stop]
        : [tu("p", "phase_complete", { result: "partial", summary: "x", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 4 },
    {
      llmClient: llm,
      runScript: async (req: any) => { calls.push(String(req?.script ?? "")); return { ok: true, exit_code: 0, stdout: "{}" }; },
    } as any,
  );

  assert.equal(calls.length, 1, "mkdir must not be caught by the upload-evidence guard");
});

test("the post-reset refusal forbids fabricating the artifact and names partial instead", async () => {
  // The dead end this closes: with the artifact unobtainable, the model's remaining options are
  // an honest partial or a hand-written evidence file. It chose the forgery, and deploy_result.py
  // cannot tell the difference, so the refusal has to name the honest exit explicitly.
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("f", "script_run", { interpreter: "python", script: "scripts/capture_repl.py", args: ["--reset-first", "--output-json", "final_reset_capture.json"] }), stop]
        : turn === 2
          ? [tu("l", "device_command", { action: "ls", path: "/" }), stop]
          : [tu("p", "phase_complete", { result: "partial", summary: "x", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => { if (e.type === "tool_result") observations.push(e.observation); } },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"success","matched_stop":"MPYHW_READY"}' }),
      device: async () => ({ ok: true, entries: [] }),
    } as any,
  );

  const detail = observations.map((o: any) => String(o?.detail ?? "")).find((d: string) => d.includes("REFUSED: the final reset"));
  assert.ok(detail, "the post-reset refusal must still fire");
  assert.match(detail!, /result=partial/, "it must name the honest exit");
  assert.match(detail!, /Do NOT write it yourself/, "it must forbid fabricating the evidence file");
});

test("device calls BEFORE the final reset are untouched", async () => {
  // The guard must not break deploy's actual work: uploads, cleans and captures all touch the
  // board, and all of them happen before the reset that ends the phase.
  let deviceCalls = 0;
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("l", "device_command", { action: "ls", path: "/" }), stop]
        : turn === 2
          ? [tu("f", "script_run", { interpreter: "python", script: "scripts/capture_repl.py", args: ["--reset-first", "--output-json", "final_reset_capture.json"] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 5, onEvent: () => {} },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"success"}' }),
      device: async () => { deviceCalls += 1; return { ok: true, entries: [] }; },
    } as any,
  );

  assert.equal(deviceCalls, 1, "a device call before the final reset is ordinary deploy work");
});

test("a gate reading evidence the model wrote is flagged, not silently graded", async () => {
  // One run hand-wrote all five deploy evidence files and the gate happily graded them. WARN
  // only: two archived PASSING deploys also hand-wrote evidence the gate consumed, so refusing
  // here would have blocked runs that were genuinely fine.
  const events: any[] = [];
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("w", "file_operation", { op: "write", path: "device_tests_result.json", content: "{}" }), stop]
        : requests.length === 2
          ? [tu("g", "script_run", { interpreter: "python", script: "scripts/deploy_result.py", args: ["--device-tests-json", "device_tests_result.json"] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (path: string) => ({ ok: true, path }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"PASS","errors":[]}' }),
    } as any,
  );

  const flagged = events.find((e) => e.type === "gate_evidence_model_written");
  assert.ok(flagged, "a gate grading the model's own file must be visible");
  assert.deepEqual(flagged.files, ["device_tests_result.json"]);
  const told = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.includes("Re-run the producing script"));
  assert.ok(told, "the model must be told to produce the file with the script that owns it");
});

test("the phase_complete payload itself is never flagged as fabricated evidence", async () => {
  // Measured on a live run: the check fired twice on phase_complete.upy_generate_plugin.json,
  // which the model authors by definition -- it is the payload being validated, not evidence a
  // script should have produced. A warning that punishes the correct action is worse than none.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("w", "file_operation", { op: "write", path: "phase_complete.upy_generate_plugin.json", content: "{}" }), stop]
        : turn === 2
          ? [tu("g", "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args: ["--phase-complete", "phase_complete.upy_generate_plugin.json"] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (path: string) => ({ ok: true, path }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"ok":true,"errors":[]}' }),
    } as any,
  );

  assert.ok(!events.some((e) => e.type === "gate_evidence_model_written"), "the validated payload is not fabricated evidence");
});

test("evidence rewritten by its producing script is not flagged", async () => {
  // The untaint rule. Producers take their output path as an argument, so a successful
  // capture_repl.py --output-json x.json after a hand-write means the file on disk is the
  // script's again. Without this, one overwrite would raise a false alarm for the whole phase.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("w", "file_operation", { op: "write", path: "serial_capture.json", content: "{}" }), stop]
        : turn === 2
          ? [tu("c", "script_run", { interpreter: "python", script: "scripts/capture_repl.py", args: ["--output-json", "serial_capture.json"] }), stop]
          : turn === 3
            ? [tu("g", "script_run", { interpreter: "python", script: "scripts/deploy_result.py", args: ["--serial-json", "serial_capture.json"] }), stop]
            : [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async (path: string) => ({ ok: true, path }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"PASS","errors":[]}' }),
    } as any,
  );

  assert.ok(!events.some((e) => e.type === "gate_evidence_model_written"), "a script-produced file must not be flagged as fabricated");
});

test("a success with no gate verdict this phase is refused until the gate passes", async () => {
  // The hole this closes: one resumed run emitted generate success having run nothing but
  // `git status`, inheriting a project whose state file was still failing its last check. The
  // earlier guard only refused a success the gate CONTRADICTED, so silence read as consent.
  const events: any[] = [];
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      if (requests.length === 2) {
        return (async function* () { for (const e of [tu("g", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]) yield e; })();
      }
      return (async function* () { for (const e of [tu(`p${requests.length}`, "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop]) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"ok","errors":[]}' }) } as any,
  );

  const refused = events.find((e) => e.type === "phase_complete_refused");
  assert.equal(refused?.reason, "gate_never_ran", "an unverified success must be refused, not accepted by default");
  const told = (requests[1]?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.includes("has not reported a verdict"));
  assert.ok(told, "the corrective must name the command that would satisfy it");
  assert.equal(result.terminal, "complete", "and the phase must finish once the gate actually passes");
});

test("a phase with a non-strict gate is not refused for never running it", async () => {
  // The guard against re-shipping the blocks-the-honest-path mistake. Two archived full passes
  // finished analyze in draft mode only, and no archived run has ever invoked flash's validator,
  // so strictness there would refuse runs that were correct.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      for (const e of [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop]) yield e;
    })(),
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "analyze", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"status":"ok"}' }) } as any,
  );

  assert.ok(!events.some((e) => e.type === "phase_complete_refused"), "a non-strict gate must not refuse a phase that never ran it");
  assert.equal(result.terminal, "complete");
});

test("a draft-mode pass cannot stand in for a failing phase-complete validation", async () => {
  // select_hw_manifest.py prints {"status":"ok"} from its DRAFT mode too, and one archived run
  // re-ran the draft right after five validate failures on its way to an honest pass. So a draft
  // pass is a normal step that must not be mistaken for the phase's verdict.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("v", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]
        : turn === 2
          // The DRAFT invocation: same script, none of the validate flags.
          ? [tu("d", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: ["--input", "d.json", "--write-path", "v.json"] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  let call = 0;
  await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => {
        call += 1;
        return call === 1
          ? { ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["board definition not found"]}' }
          : { ok: true, exit_code: 0, stdout: '{"status":"ok","errors":[]}' };
      },
    } as any,
  );

  const refused = events.find((e) => e.type === "phase_complete_refused");
  assert.equal(refused?.reason, "gate_failed", "the draft pass must not overwrite the failing validation");
});

test("an unknown phase_complete result token is rejected, not advanced", async () => {
  // `result: "ok"` reads as intent to succeed but is not a contract token. The refusal compares
  // against the literal "success", so an unknown token would walk straight past a red gate.
  const observations: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("g", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]
        : turn === 2
          ? [tu("p1", "phase_complete", { result: "ok", summary: "done", next_phase: null, manifest_content: {} }), stop]
          : [tu("p2", "phase_complete", { result: "partial", summary: "blocked", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 6, onEvent: (e: any) => { if (e.type === "tool_result") observations.push(e.observation); } },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["x"]}' }) } as any,
  );

  // The recorder normalizes the result, so the kind may sit at the top level or under `output`.
  const kindOf = (o: any) => o?.error_kind ?? o?.output?.error_kind;
  const rejected = observations.find((o: any) => kindOf(o) === "phase_complete_invalid_result");
  assert.ok(rejected, `an unknown result token must be rejected at the executor; saw ${JSON.stringify(observations.map(kindOf))}`);
  const detail = String(rejected.detail ?? rejected.output?.detail);
  assert.match(detail, /success, partial, failed/, "and the accepted tokens must be named");
  // The honest path stays open: partial is accepted even though the gate is red.
  assert.equal(result.terminal, "partial", "a partial must still be allowed through");
});

test("a success the gate already failed is refused", async () => {
  // Three runs passed select-hw like this: the validator returned failure, the model wrote the
  // validated manifest itself, and phase_complete was accepted. The board never resolved.
  const events: any[] = [];
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("g", "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: ["--input", "d.json"] }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["board definition not found"]}' }) } as any,
  );

  assert.notEqual(result.terminal, "complete", "the gate said no; the build must not report complete");
  assert.ok(events.some((e) => e.type === "phase_complete_refused"), "the refusal must be visible, not silent");
  const told = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.includes("was REFUSED"));
  assert.match(told, /do not write its output file yourself/i, "the model must be told why, and what not to do");
});

test("each gate's own verdict spelling is read, not just one of them", async () => {
  // The three gates spell a pass three ways and share no schema. Keying on `ok` alone would have
  // refused every select-hw pass, because select_hw_manifest.py has no `ok` field -- a guard
  // against fabrication that blocks the honest path is worse than no guard.
  const shapes = [
    { name: "select_hw_manifest.py", phase: "select-hw", args: SELECT_HW_GATE_ARGS, stdout: '{"status":"ok","errors":[],"warnings":[]}' },
    { name: "check_phase_complete_consistency.py", phase: "upy-generate-plugin", stdout: '{"check":"phase_complete_consistency","result":"success","ok":true,"errors":[]}' },
    { name: "deploy_result.py", phase: "upy-deploy-plugin", stdout: '{"status":"success","tools":{}}' },
  ];

  for (const shape of shapes) {
    const requests: any[] = [];
    const llm = {
      streamMessages: async (body: any) => {
        requests.push(body);
        const ev = requests.length === 1
          ? [tu("g", "script_run", { interpreter: "python", script: `scripts/${shape.name}`, args: shape.args ?? [] }), stop]
          : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
        return (async function* () { for (const e of ev) yield e; })();
      },
    };

    const result = await runProtocolBuild(
      { intent: "x", startPhase: shape.phase, maxTurnsPerPhase: 4, onEvent: () => {} },
      { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: shape.stdout }) } as any,
    );

    assert.equal(result.terminal, "complete", `${shape.name}: a real pass in this gate's own dialect must be accepted`);
  }
});

test("a deploy that ends on PASS_WITH_WARNINGS is not refused", async () => {
  // deploy_result.py grades FAIL / PASS_WITH_WARNINGS / PASS, and warnings are how a real deploy
  // normally ends -- one archived full-chain pass graded exactly this. The ordering here is the
  // one that bites: the gate fails first, then passes WITH WARNINGS. If that final verdict is not
  // recognized as a pass, the earlier "fail" stands and the guard refuses a genuine success.
  const requests: any[] = [];
  const events: any[] = [];
  let runs = 0;
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      if (requests.length <= 2) {
        return (async function* () { for (const e of [tu(`d${requests.length}`, "script_run", { interpreter: "python", script: "scripts/deploy_result.py" }), stop]) yield e; })();
      }
      return (async function* () { for (const e of [tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: {} }), stop]) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      runScript: async () => {
        runs += 1;
        return runs === 1
          ? { ok: true, exit_code: 1, stdout: '{"status":"FAIL","errors":["final reset capture missing"]}' }
          : { ok: true, exit_code: 0, stdout: '{"status":"PASS_WITH_WARNINGS","errors":[],"warnings":["serial capture was cut short"]}' };
      },
    } as any,
  );

  assert.ok(!events.some((e) => e.type === "phase_complete_refused"), "a deploy graded PASS_WITH_WARNINGS earned its success");
  assert.equal(result.terminal, "complete");
});

test("a gate that fails and then passes still completes the phase", async () => {
  // The guard must not punish the normal loop: fail, fix, pass. Only the LATEST verdict counts.
  const requests: any[] = [];
  let gateRuns = 0;
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      if (requests.length <= 2) {
        return (async function* () { for (const e of [tu(`g${requests.length}`, "script_run", { interpreter: "python", script: "scripts/select_hw_manifest.py", args: SELECT_HW_GATE_ARGS }), stop]) yield e; })();
      }
      return (async function* () { for (const e of [tu("p", "phase_complete", { result: "success", summary: "ok", next_phase: null, manifest_content: {} }), stop]) yield e; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", startPhase: "select-hw", maxTurnsPerPhase: 5, onEvent: () => {} },
    {
      llmClient: llm,
      runScript: async () => {
        gateRuns += 1;
        return gateRuns === 1
          ? { ok: true, exit_code: 1, stdout: '{"status":"fail","errors":["board definition not found"]}' }
          : { ok: true, exit_code: 0, stdout: '{"status":"ok","errors":[]}' };
      },
    } as any,
  );

  assert.equal(result.terminal, "complete", "a phase that fixed its problem and passed the gate must complete");
});

test("running the checker with --help is not a passing verdict", async () => {
  // What actually happened: the model could not satisfy the gate, failed twice trying to locate
  // the script, ran it with `--help`, and that exited 0. The corrective read the zero exit as a
  // pass and told it to emit phase_complete -- which it did, with its last real validation still
  // three errors red. The phase was accepted and the build moved on to deploy.
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("h", "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args: ["--help"] }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    // Exactly what argparse prints for --help, and it exits 0.
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: "usage: check_phase_complete_consistency.py [-h] --phase-complete PH" }) } as any,
  );

  const nudge = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("The consistency check PASSED"));

  assert.equal(nudge, undefined, "a usage message is not a verdict; announcing a pass here fakes the gate");
});

test("a checker that RAN but reported errors is not a passing verdict", async () => {
  // The other way to exit 0 without passing: some reports carry their verdict in the body. If
  // the corrective keyed on the exit code alone, a red report would end the phase too.
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("c", "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args: ["--phase-complete", "pc.json"] }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"ok":false,"errors":[{"code":"GIT_COMMIT_MISSING"}]}' }) } as any,
  );

  const nudge = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""))
    .find((t: string) => t.startsWith("The consistency check PASSED"));

  assert.equal(nudge, undefined, "a report listing errors must never be announced as a pass");
});

test("a passing INPUT validation does not tell the model to finish", async () => {
  // deploy validates the PREVIOUS phase's payload with deploy_manifest.py as an input check.
  // A success there means "the handoff is good", not "your phase is done" -- announcing
  // completion would end deploy before it uploaded anything.
  const requests: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      const ev = requests.length === 1
        ? [tu("v", "script_run", { interpreter: "python", script: "scripts/deploy_manifest.py", args: ["--validate-phase-complete"] }), stop]
        : [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 3, onEvent: () => {} },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: '{"ok":true,"errors":[]}' }) } as any,
  );

  const texts = (requests.at(-1)?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""));

  assert.ok(!texts.some((t: string) => t.startsWith("The consistency check PASSED")), "an input check must not end the phase");
});

test("a batch of progress updates is not a loop", async () => {
  // Measured in a real run: a driver search narrates three status lines in one turn, and
  // status_update carries no path or script, so all three collapsed to the bare tool name
  // and the phase was nudged to "emit phase_complete with what you already have" while it
  // was still working. A multi-device project emits a batch per device, so the turn after
  // would have stalled analyze outright.
  const lines = [
    "Confirmed: onboard LED on GPIO25",
    "Searching driver... (1/1)",
    "OK Onboard LED -> builtin_runtime (machine.Pin)",
  ];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const done = turn++ > 0;
      return (async function* () {
        if (done) {
          yield tu("done", "phase_complete", { result: "success", summary: "analyzed", next_phase: null });
        } else {
          for (const [i, message] of lines.entries()) {
            yield tu(`s${i}`, "status_update", { level: "info", message, step_id: `step_${i}` });
          }
        }
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "analyze", onEvent: (e: any) => events.push(e) },
    { llmClient: llm } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.equal(events.filter((e) => e.type === "repeating_calls").length, 0, "distinct progress lines are not a cycle");
});

test("the SAME script call repeated with identical arguments is still a loop", async () => {
  // The other side of the same rule: argv is what makes an upload distinct, so an identical
  // argv repeated is a genuine repeat and must stay caught.
  const args = ["--run", "--port", "/dev/cu.usbmodem1101", "--", "resume", "fs", "ls"];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      turn += 1;
      return (async function* () {
        yield tu(`s${turn}`, "script_run", { interpreter: "python", script: "scripts/mpremote_runtime.py", args });
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-deploy-plugin", maxTurnsPerPhase: 60, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 0, stdout: "{}" }) } as any,
  );

  assert.equal(result.terminal, "stalled");
  assert.equal(events.find((e) => e.type === "phase_stalled").reason, "repeating_calls");
  assert.ok(turn < 12, `stopped after ${turn} turns`);
});

test("copying file after file to the board is not a loop", async () => {
  // Measured, and it killed a working deploy: after the project's own helper script turned
  // out to be unrunnable, the model fell back to device_command cp and was uploading the
  // firmware file by file. src/dst carry the identity there -- neither was in the signature,
  // so four different files read as one repeated call and the phase was stalled on the
  // fourth. Third tool to teach this the expensive way, hence the signature now keeps every
  // non-body field rather than a hand-listed few.
  const copies = [
    { action: "mkdir", dst: ":lib" },
    { action: "cp", src: "firmware/conf.py", dst: ":conf.py" },
    { action: "cp", src: "firmware/boot.py", dst: ":boot.py" },
    { action: "cp", src: "firmware/main.py", dst: ":main.py" },
    { action: "cp", src: "firmware/lib", dst: ":lib" },
  ];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const step = turn++;
      const event = step >= copies.length
        ? tu("done", "phase_complete", { result: "success", summary: "deployed", next_phase: null })
        : tu(`d${step}`, "device_command", copies[step]);
      return (async function* () { yield event; yield stop; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-deploy-plugin", onEvent: (e: any) => events.push(e) },
    { llmClient: llm, device: async () => ({ ok: true, stdout: "" }) } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.equal(events.filter((e) => e.type === "repeating_calls").length, 0, "different files are different work");
});

test("a body field never enters a signature, so a rewrite loop stays visible", async () => {
  // The other side of the rule. The measured livelock rewrote project-manifest.json with a
  // DIFFERENT commit hash every pass; if content counted as identity each write would look
  // unique and the loop would be invisible.
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      turn += 1;
      return (async function* () {
        yield tu(`w${turn}`, "file_operation", { op: "write", path: "project-manifest.json", content: `{"commit":"hash-${turn}"}` });
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 60, onEvent: (e: any) => events.push(e) },
    { llmClient: llm, writeFile: async () => ({ ok: true, success: true }) } as any,
  );

  assert.equal(result.terminal, "stalled");
  assert.equal(events.find((e) => e.type === "phase_stalled").reason, "repeating_calls");
  assert.ok(turn < 12, `stopped after ${turn} turns`);
});

test("a cycle whose middle step is a REFUSED call is still a cycle", async () => {
  // The shape the amend removal creates: the model keeps reaching for a command the
  // allowlist will never accept. A refusal is a failure, and failures exempt a window from
  // the cycle check so that fix-and-rerun convergence is protected -- but a refusal teaches
  // the model nothing it did not already know, so this cycle has to stay visible.
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const step = turn++ % 3;
      const event = step === 0
        ? tu(`w${turn}`, "file_operation", { op: "write", path: "project-manifest.json", content: `{"n":${turn}}` })
        : step === 1
          ? tu(`c${turn}`, "script_run", { interpreter: "shell", command: AMEND_COMMAND })
          : tu(`r${turn}`, "script_run", { interpreter: "shell", command: "git rev-parse HEAD" });
      return (async function* () { yield event; yield stop; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 60, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async () => ({ ok: true, success: true }),
      // The shim's answer to a command with no verb in the allowlist.
      runScript: async (_i: string, _s: string, _a: string[], _x: any) =>
        ({ ok: false, error_kind: "shell_command_not_allowed", stderr: "Allowed shell commands: ..." }),
    } as any,
  );

  assert.equal(result.terminal, "stalled");
  assert.equal(events.find((e) => e.type === "phase_stalled").reason, "repeating_calls");
  assert.ok(turn < 20, `stopped after ${turn} turns`);
});

test("breaking out of a cycle earns the nudge back", async () => {
  // A phase is long. One nudge early must not mean that a second, unrelated repetition
  // later is stalled with no warning: the nudge is spent per cycle, not per phase.
  const scripted = [
    // Cycle one: three identical successful gate runs, then a nudge.
    "gate", "gate", "gate",
    // Broken by real work.
    "write-a", "write-b", "write-c",
    // Cycle two: it must be NUDGED again rather than stalled outright.
    "gate", "gate", "gate",
    "done",
  ];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const step = scripted[Math.min(turn, scripted.length - 1)];
      turn += 1;
      const event = step === "done"
        ? tu("d", "phase_complete", { result: "success", summary: "ok", next_phase: null })
        : step === "gate"
          ? tu(`g${turn}`, "script_run", { interpreter: "python", script: "run_quality_gates.py" })
          : tu(`w${turn}`, "file_operation", { op: "write", path: `firmware/${step}.py`, content: "x" });
      return (async function* () { yield event; yield stop; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-maixpy-export-plugin" /* neutral phase: this test is about loop mechanics, not gating or scaffold rendering */, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async () => ({ ok: true, success: true }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: "{}" }),
    } as any,
  );

  assert.equal(result.terminal, "complete", "the second cycle must be nudged, not stalled");
  assert.equal(events.filter((e) => e.type === "repeating_calls").length, 2, "one nudge per cycle");
});

test("a phase that keeps making progress is never called a loop", async () => {
  // The shape that must NOT trip it: fix a file, re-run the same gate, fix the next file.
  // The gate call is identical every time; only the paths differ, and that is what tells a
  // convergent phase apart from a stuck one.
  const files = ["firmware/main.py", "firmware/conf.py", "firmware/tasks/blink.py", "firmware/drivers/led.py"];
  let turn = 0;
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const step = turn++;
      const event = step >= files.length * 2
        ? tu("done", "phase_complete", { result: "success", summary: "generated", next_phase: null })
        : step % 2 === 0
          ? tu(`w${step}`, "file_operation", { op: "write", path: files[step / 2], content: "x" })
          : tu(`g${step}`, "script_run", { interpreter: "python", script: "run_quality_gates.py" });
      return (async function* () { yield event; yield stop; })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "blink", startPhase: "upy-maixpy-export-plugin" /* neutral phase: this test is about loop mechanics, not gating or scaffold rendering */, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      writeFile: async () => ({ ok: true, success: true }),
      runScript: async () => ({ ok: true, exit_code: 0, stdout: "{}" }),
    } as any,
  );

  assert.equal(result.terminal, "complete");
  assert.equal(events.filter((e) => e.type === "repeating_calls").length, 0, "distinct paths are progress");
});

test("a failed read of a plugin resource path names the boundary", async () => {
  // Measured live: generate opens by reading five references/*.md in a row, because its SKILL
  // table sends it there. The files exist -- inside the plugin resource directory, which
  // file_operation cannot reach -- and the answer was a bare "file_not_found", which reads as
  // "that file does not exist" and teaches the model nothing. script_run already names this
  // boundary for a project-local script; the read path did not.
  const { result } = await executeProtocolTool(
    tu("r", "file_operation", { op: "read", path: "references/validation_gates.md" }),
    { intent: "x" } as any,
    { readFile: async () => ({ ok: false, error_kind: "file_not_found" }) } as any,
    { phase: "upy-generate-plugin", turn: 1 },
  );

  assert.equal(result.ok, false);
  assert.match(String(result.detail), /plugin resource/i, "the model must be told what kind of path this is");
  assert.match(String(result.detail), /can never succeed/i, "and that retrying cannot help");
  assert.match(String(result.detail), /prompt text|RESOLVED DATA/i, "and where the content actually is");
});

test("an ordinary missing project file is not explained away as a boundary", async () => {
  // The guard must not fire on a real absence: "firmware/main.py is not there yet" is exactly
  // the answer a phase needs, and burying it under a lecture about plugin resources would make
  // the common case worse to serve the rare one.
  const { result } = await executeProtocolTool(
    tu("r", "file_operation", { op: "read", path: "firmware/main.py" }),
    { intent: "x" } as any,
    { readFile: async () => ({ ok: false, error_kind: "file_not_found" }) } as any,
    { phase: "upy-generate-plugin", turn: 1 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.detail, undefined, "a missing project file needs no boundary explanation");
});

test("a plugin resource path that READS fine is left alone", async () => {
  // Only a FAILED read gets the message. A host that can serve one of these (a test harness, a
  // future resource route) must not have its success annotated as a boundary violation.
  const { result } = await executeProtocolTool(
    tu("r", "file_operation", { op: "read", path: "knowledge/driver_api_usage.pitfall.json" }),
    { intent: "x" } as any,
    { readFile: async () => ({ ok: true, content: "{}" }) } as any,
    { phase: "upy-generate-plugin", turn: 1 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.detail, undefined);
});

test("every turn asks for the output budget the server allows", async () => {
  // The extension never sent max_tokens, so every turn took the server's 8192 default while
  // the ceiling was 32768. Measured consequence: generate's phase_complete must embed 34,770
  // characters of quality-gate results verbatim -- about 8.7k tokens, more than the whole turn
  // allowance -- so the model hit exactly 8192 output tokens on three turns, could not finish
  // the write, and reported partial with 17 of 80 requests unspent.
  const bodies: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      bodies.push(body);
      return (async function* () {
        for (const e of [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} }), stop]) yield e;
      })();
    },
  };

  await runProtocolBuild({ intent: "x", startPhase: "upy-deploy-plugin", onEvent: () => {} }, { llmClient: llm } as any);

  assert.ok(bodies.length > 0, "the loop must have made a request");
  for (const body of bodies) {
    assert.equal(typeof body.max_tokens, "number", "every request must state its output budget");
    assert.ok(body.max_tokens > 8192, `must ask for more than the server default, got ${body.max_tokens}`);
    assert.ok(body.max_tokens <= 32768, `must stay inside the server ceiling, got ${body.max_tokens}`);
  }
});

test("the unchanged-entry nudge speaks once per phase and never offers the exit", async () => {
  // Both halves are from one measured run. Three nudges landed in three consecutive turns, and
  // the model emitted phase_complete(partial) three requests later with 17 of 80 unspent -- its
  // stated reason naming the exact objects it had been told to produce. The nudge fires while a
  // phase is still converging, so it must not read as permission to stop, and it must not
  // arrive as a barrage.
  const requests: any[] = [];
  const events: any[] = [];
  const llm = {
    streamMessages: async (body: any) => {
      requests.push(body);
      return (async function* () {
        for (const e of [tu(`g${requests.length}`, "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py", args: ["--n", String(requests.length)] }), stop]) yield e;
      })();
    },
  };

  let call = 0;
  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 10, onEvent: (e: any) => events.push(e) },
    {
      llmClient: llm,
      // Two entries that never change, surrounded by errors that do: without the once-per-phase
      // rule this produces a nudge for each, on consecutive turns.
      runScript: async () => {
        call += 1;
        return {
          ok: true, exit_code: 2,
          stdout: JSON.stringify({ result: "failed", errors: [
            { code: "GATE_RESULT_MISSING", message: "the dead_config gate result object is missing" },
            { code: "GATE_RESULT_MISSING", message: "the conf_contract gate result object is missing" },
            { code: "CHANGING", message: `attempt ${call}` },
          ] }),
        };
      },
    } as any,
  );

  const nudges = events.filter((e) => e.type === "repeating_failure" && e.entry);
  assert.equal(nudges.length, 1, `the entry nudge is spent once per phase, got ${nudges.length}`);
  const texts = requests.flatMap((r) => (r.messages ?? []))
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => String(c?.text ?? ""));
  const nudge = texts.find((t: string) => t.includes("come back UNCHANGED"));
  assert.ok(nudge, "the nudge must still be delivered");
  assert.doesNotMatch(nudge, /result=partial/i, "a mid-convergence nudge must not offer the give-up exit");
  assert.match(nudge, /run that script and use its output/i, "it must name the next action instead");
});

test("a refused phase_complete is never announced as one", async () => {
  // It was emitted inside executeProtocolTool, BEFORE the gate check that refuses it, so every
  // consumer recorded a refused claim as a real completion: the harness printed
  // "phase_complete: success", counted the phase as succeeded, and snapshotted a checkpoint --
  // which is itself a valid resume point into the NEXT phase carrying a payload the gate had
  // rejected. Measured on a run whose summary read "generate (success): true" while it stalled
  // at its turn cap.
  const events: any[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      const ev = turn === 1
        ? [tu("p", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: { phase: "generate" } }), stop]
        : [tu("g", "script_run", { interpreter: "python", script: "scripts/check_phase_complete_consistency.py" }), stop];
      return (async function* () { for (const e of ev) yield e; })();
    },
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 3, onEvent: (e: any) => events.push(e) },
    // A strict gate that never reports a pass: the success claim must be refused.
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 2, stdout: '{"ok":false,"errors":[{"code":"STILL_BROKEN","message":"not yet"}]}' }) } as any,
  );

  assert.ok(events.some((e) => e.type === "phase_complete_refused"), "the refusal must be recorded");
  assert.ok(!events.some((e) => e.type === "phase_complete"), "a refused claim must not be announced as a completion");
  assert.ok(!events.some((e) => e.type === "manifest_updated"), "nor may its manifest be published");
});

test("an accepted phase_complete is still announced with its payload", async () => {
  // The other half: moving the emission must not lose it. A consumer needs the payload and the
  // manifest at the moment the phase really finishes.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield tu("p", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: { phase: "deploy" } });
      yield stop;
    })(),
  };

  await runProtocolBuild(
    { intent: "x", startPhase: "upy-deploy-plugin", onEvent: (e: any) => events.push(e) },
    { llmClient: llm } as any,
  );

  const announced = events.find((e) => e.type === "phase_complete");
  assert.ok(announced, "an accepted completion must still be announced");
  assert.equal(announced.payload?.summary, "deployed", "with its payload intact");
  assert.ok(events.some((e) => e.type === "manifest_updated"), "and its manifest published");
});
