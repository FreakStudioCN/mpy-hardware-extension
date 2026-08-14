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

  const result = await runProtocolBuild({ intent: "x", traceId: "trace-v0" }, { llmClient: llm });

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
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 },
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
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5 },
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
    { intent: "x", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 5, onEvent: (e: any) => events.push(e) },
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
    args: "<3 items>",
    timeout_ms: 30000,
    stdin_json: "<object>",
  });
});

test("a phase that exhausts its budget reports the tool calls that blocked it, not a bare max_turns", async () => {
  // The real shape of the generate stall: the phase finishes its work and then cannot persist
  // its artifact, retrying a rejected write until the turns run out. "max_turns" alone reads as
  // transient; the blocker is what makes it diagnosable.
  const events: any[] = [];
  const llm = {
    streamMessages: async () => {
      const ev = [tu("f0", "file_operation", { op: "write", path: "sessions/x/phase_complete.json", content: "{}" }), stop];
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
    path: "sessions/x/phase_complete.json",
  });
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
  assert.match(texts[0], /30 more/, "the tail is summarised rather than dropped silently");
  assert.ok(texts[0].length < 6000, `corrective message is ${texts[0].length} chars, it must stay a nudge`);
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
  await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 20 },
    {
      llmClient: llm,
      runScript: async () => ({ ok: true, success: false, stdout: huge }),
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
