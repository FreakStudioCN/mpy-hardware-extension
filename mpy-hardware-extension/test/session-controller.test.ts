import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/extension/session-controller.ts";

test("session controller streams loop events and requires confirmation for hardware tools", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async (tool) => tool.name !== "install_package",
    loop: async ({ onEvent, confirmTool }) => {
      onEvent({ type: "trace", text: "start" });
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      const approved = await confirmTool({ name: "install_package" });
      return { terminal: approved ? "success" : "confirmation_rejected" };
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(result.terminal, "confirmation_rejected");
  assert.deepEqual(messages, [
    { type: "trace_event", event: { type: "trace", text: "start" } },
    { type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } },
    { type: "code_updated", code: "print('MPYHW_READY')" },
    { type: "serial_output", lines: ["MPYHW_READY"] },
    { type: "session_done", terminal: "confirmation_rejected" },
  ]);
});

test("session controller rejects a concurrent start while a run is in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loopStarts = 0;
  const controller = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    loop: async () => { loopStarts += 1; await gate; return { terminal: "success" }; },
  });

  const first = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  const second = controller.start({ intent: "b", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();
  const startsWhileConcurrent = loopStarts;

  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(startsWhileConcurrent, 1, "a concurrent start must not launch a second loop");
  assert.equal(secondResult.terminal, "session_busy");
  assert.equal(firstResult.terminal, "success");
});

test("session controller writes generated files after code and manifest are available", async () => {
  const written: any[] = [];
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async () => true,
    writeFiles: async (files) => {
      written.push(files);
      return { ok: true, paths: ["C:/project/main.py", "C:/project/manifest.json"] };
    },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(written, [{ "main.py": "print('MPYHW_READY')", "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1" }, null, 2) }]);
  assert.deepEqual(messages.find((message) => message.type === "files_written"), { type: "files_written", paths: ["C:/project/main.py", "C:/project/manifest.json"] });
});

test("session controller accumulates multi-file projects by path and writes them all", async () => {
  const written: any[] = [];
  const controller = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    writeFiles: async (files) => {
      written.push(files);
      return { ok: true, paths: Object.keys(files) };
    },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "from lib.aht20 import AHT20\nprint('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "code_updated", code: "class AHT20:\n    pass", path: "lib/aht20.py" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(written, [{
    "main.py": "from lib.aht20 import AHT20\nprint('MPYHW_READY')",
    "lib/aht20.py": "class AHT20:\n    pass",
    "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1" }, null, 2),
  }]);
});

test("session controller reports generated file write failures without changing terminal state", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async () => true,
    writeFiles: async () => ({ ok: false, error_kind: "overwrite_rejected" }),
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      return { terminal: "generated" };
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(result.terminal, "generated");
  assert.deepEqual(messages.find((message) => message.type === "files_write_failed"), { type: "files_write_failed", error: "overwrite_rejected" });
});

test("session controller routes ask_user to the webview and feeds the answer back", async () => {
  const messages: any[] = [];
  let captured: string | null = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async () => true,
    loop: async ({ askUser }) => {
      captured = await askUser("Which board are you using?");
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const prompt = messages.find((m) => m.type === "ui_prompt_needed");
  assert.ok(prompt, "expected a ui_prompt_needed message");
  assert.equal(prompt.question, "Which board are you using?");

  controller.resolvePrompt(prompt.promptId, "esp32-s3-devkitc-1");
  const result = await started;

  assert.equal(captured, "esp32-s3-devkitc-1");
  assert.equal(result.terminal, "generated");
});

test("session controller routes confirmPlan to the webview as plan_needed and resolves the choice", async () => {
  const messages: any[] = [];
  let confirmed: boolean | "unset" = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async () => true,
    loop: async ({ confirmPlan }) => {
      confirmed = await confirmPlan({ intent: "blink", estimate: 3, capabilities: ["digital_output"], wiring: [] });
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const plan = messages.find((m) => m.type === "plan_needed");
  assert.ok(plan, "expected a plan_needed message");
  assert.equal(plan.plan.estimate, 3);

  controller.resolvePrompt(plan.promptId, "confirm");
  await started;
  assert.equal(confirmed, true);
});

test("session controller confirmPlan resolves false on cancel and on session cancel", async () => {
  // explicit "cancel" answer
  let a: boolean | "unset" = "unset";
  const c1 = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    loop: async ({ confirmPlan }) => { a = await confirmPlan({ estimate: 2 }); return { terminal: "generated" }; },
  });
  const s1 = c1.start({ intent: "x", boardId: "b" });
  // resolve the pending plan prompt with cancel
  c1.resolvePrompt("plan-1", "cancel");
  await s1;
  assert.equal(a, false);

  // session cancel unblocks a pending plan as false
  let b: boolean | "unset" = "unset";
  const c2 = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    loop: async ({ confirmPlan, signal }) => { b = await confirmPlan({ estimate: 2 }); return { terminal: signal?.aborted ? "cancelled" : "generated" }; },
  });
  const s2 = c2.start({ intent: "x", boardId: "b" });
  c2.cancel();
  await s2;
  assert.equal(b, false);
});

test("session controller records UI prompts, confirmations, artifacts, and terminal state", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    recorderFactory: (traceId: string) => ({
      record: async (event: any) => void recorded.push({ traceId, ...event }),
    }),
    loop: async ({ onEvent, askUser, confirmTool }) => {
      const answer = await askUser("Which output should it use?");
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", answer } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      await confirmTool({ name: "write_main_py", input: { path: "main.py" } });
      return { terminal: "success" };
    },
  });

  const started = controller.start({ intent: "build companion", boardId: "esp32-s3-devkitc-1" });
  const prompt = recorded.find((event) => event.type === "ui_prompt");
  assert.ok(prompt, "expected ui_prompt event");
  controller.resolvePrompt(prompt.promptId, "OLED");
  await started;

  assert.deepEqual(recorded.map((event) => event.type), [
    "session_started",
    "user_message",
    "ui_prompt",
    "ui_prompt_answer",
    "artifact",
    "artifact",
    "serial_output",
    "confirmation",
    "session_finished",
  ]);
  assert.equal(recorded[0].intent, "build companion");
  assert.equal(recorded[1].intent, "build companion");
  assert.equal(recorded[3].answer, "OLED");
  assert.equal(recorded[4].kind, "manifest");
  assert.equal(recorded[5].code, "print('MPYHW_READY')");
  assert.deepEqual(recorded[7].tool, { name: "write_main_py", input: { path: "main.py" } });
  assert.equal(recorded[8].terminal, "success");
});

test("session controller carries agent state into the next user message", async () => {
  const statesSeen: any[] = [];
  const returnedStates = [
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }] },
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }] },
  ];
  const controller = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    loop: async (input) => {
      statesSeen.push(input.state);
      return { terminal: "awaiting_user", state: returnedStates[statesSeen.length - 1] };
    },
  });

  await controller.start({ intent: "first", boardId: "esp32-s3-devkitc-1" });
  await controller.start({ intent: "second", boardId: "esp32-s3-devkitc-1" });

  assert.equal(statesSeen[0], undefined);
  assert.deepEqual(statesSeen[1], returnedStates[0]);
});

test("session controller cancel unblocks a pending ask_user with a null answer", async () => {
  let captured: string | null = "unset";
  const controller = new SessionController({
    postMessage: () => {},
    confirmTool: async () => true,
    loop: async ({ askUser, signal }) => {
      captured = await askUser("?");
      return { terminal: signal?.aborted ? "cancelled" : "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  controller.cancel();
  const result = await started;

  assert.equal(captured, null);
  assert.equal(result.terminal, "cancelled");
});

test("session controller reports loop crashes to the webview", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    confirmTool: async () => true,
    loop: async () => {
      throw new Error("api down");
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(result, { terminal: "session_error", error: "api down" });
  assert.deepEqual(messages, [
    { type: "session_error", error: "api down" },
    { type: "session_done", terminal: "session_error" },
  ]);
});
