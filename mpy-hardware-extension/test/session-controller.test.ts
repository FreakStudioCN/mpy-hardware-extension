import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/extension/session-controller.ts";

// Let a loop that awaits one gate advance to the next: after resolving the first
// prompt, the loop's continuation (and the next gate's message/record) runs on a
// microtask, so drain a few before inspecting.
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("session controller streams loop events and gates deploy via confirmDeploy", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ onEvent, confirmDeploy }) => {
      onEvent({ type: "trace", text: "start" });
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      const approved = await confirmDeploy();
      return { terminal: approved ? "success" : "user_cancelled" };
    },
  });

  const started = controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });
  const deploy = messages.find((m) => m.type === "deploy_needed");
  assert.ok(deploy, "expected a deploy_needed message before any device action");
  assert.deepEqual(deploy.manifest, { board_id: "esp32-s3-devkitc-1" });
  controller.resolvePrompt(deploy.promptId, "cancel");
  const result = await started;

  assert.equal(result.terminal, "user_cancelled");
  assert.deepEqual(messages.map((m) => m.type), [
    "trace_event",
    "manifest_updated",
    "code_updated",
    "serial_output",
    "deploy_needed",
    "session_done",
  ]);
});

test("session controller rejects a concurrent start while a run is in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loopStarts = 0;
  const controller = new SessionController({
    postMessage: () => {},
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

test("session controller reports loop-persisted files without a redundant batch write", async () => {
  // When the loop persists files itself (write_project_file / generate_code emit
  // file_written), the post-loop batch is skipped: no second write, no duplicate
  // manifest.json, and files_written reports exactly the loop-persisted paths.
  let writeFilesCalled = false;
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    writeFiles: async () => { writeFilesCalled = true; return { ok: true, paths: [] }; },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "file_written", path: "C:/project/project-manifest.json" });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "firmware/main.py" });
      onEvent({ type: "file_written", path: "C:/project/firmware/main.py" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(writeFilesCalled, false, "the post-loop batch must not re-write loop-persisted files");
  assert.deepEqual(
    messages.find((message) => message.type === "files_written"),
    { type: "files_written", paths: ["C:/project/project-manifest.json", "C:/project/firmware/main.py"] },
  );
});

test("session controller reports generated file write failures without changing terminal state", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
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
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmPlan }) => {
      decision = await confirmPlan({ intent: "blink", estimate: 3, capabilities: ["digital_output"], wiring: [] });
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const plan = messages.find((m) => m.type === "plan_needed");
  assert.ok(plan, "expected a plan_needed message");
  assert.equal(plan.plan.estimate, 3);

  controller.resolvePrompt(plan.promptId, "confirm");
  await started;
  assert.equal(decision.action, "confirm");
});

test("session controller confirmPlan resolves a revise decision carrying the feedback", async () => {
  const messages: any[] = [];
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmPlan }) => { decision = await confirmPlan({ estimate: 2 }); return { terminal: "generated" }; },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const plan = messages.find((m) => m.type === "plan_needed");
  controller.resolvePrompt(plan.promptId, "revise", { feedback: "用 TFT 彩屏" });
  await started;
  assert.deepEqual(decision, { action: "revise", feedback: "用 TFT 彩屏" });
});

test("session controller routes confirmComponents to the webview as components_needed and resolves kept devices + additions", async () => {
  const messages: any[] = [];
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmComponents }) => {
      decision = await confirmComponents([{ name: "SSD1306 OLED" }, { name: "WS2812 RGB LED" }]);
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const prompt = messages.find((m) => m.type === "components_needed");
  assert.ok(prompt, "expected a components_needed message");
  assert.equal(prompt.devices.length, 2);

  controller.resolvePrompt(prompt.promptId, "confirm", { devices: ["SSD1306 OLED"], feedback: "加 DHT22" });
  await started;
  assert.deepEqual(decision, { action: "confirm", devices: ["SSD1306 OLED"], feedback: "加 DHT22" });
});

test("session controller forwards a loop summary event to the webview as a summary message", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }) => { onEvent({ type: "summary", text: "all done" }); return { terminal: "generated" }; },
  });

  await controller.start({ intent: "x", boardId: "b" });
  const summary = messages.find((m) => m.type === "summary");
  assert.ok(summary, "expected a summary message");
  assert.equal(summary.text, "all done");
});

test("session controller confirmPlan resolves cancel on cancel answer and on session cancel", async () => {
  // explicit "cancel" answer
  let a: any = "unset";
  const c1 = new SessionController({
    postMessage: () => {},
    loop: async ({ confirmPlan }) => { a = await confirmPlan({ estimate: 2 }); return { terminal: "generated" }; },
  });
  const s1 = c1.start({ intent: "x", boardId: "b" });
  // resolve the pending plan prompt with cancel
  c1.resolvePrompt("plan-1", "cancel");
  await s1;
  assert.equal(a.action, "cancel");

  // session cancel unblocks a pending plan as cancel
  let b: any = "unset";
  const c2 = new SessionController({
    postMessage: () => {},
    loop: async ({ confirmPlan, signal }) => { b = await confirmPlan({ estimate: 2 }); return { terminal: signal?.aborted ? "cancelled" : "generated" }; },
  });
  const s2 = c2.start({ intent: "x", boardId: "b" });
  c2.cancel();
  await s2;
  assert.equal(b.action, "cancel");
});

test("session controller routes confirmDeploy to the webview as deploy_needed and resolves the choice", async () => {
  const messages: any[] = [];
  let confirmed: boolean | "unset" = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ onEvent, confirmDeploy }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] } });
      confirmed = await confirmDeploy();
      return { terminal: "success" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const deploy = messages.find((m) => m.type === "deploy_needed");
  assert.ok(deploy, "expected a deploy_needed message carrying the manifest for the wiring diagram");
  assert.deepEqual(deploy.manifest, { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] });

  controller.resolvePrompt(deploy.promptId, "confirm");
  await started;
  assert.equal(confirmed, true);
});

test("session controller confirmDeploy resolves false on session cancel", async () => {
  let approved: boolean | "unset" = "unset";
  const controller = new SessionController({
    postMessage: () => {},
    loop: async ({ confirmDeploy, signal }) => { approved = await confirmDeploy(); return { terminal: signal?.aborted ? "cancelled" : "generated" }; },
  });
  const started = controller.start({ intent: "x", boardId: "b" });
  controller.cancel();
  await started;
  assert.equal(approved, false);
});

test("session controller records UI prompts, the deploy gate, artifacts, and terminal state", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => {},
    recorderFactory: (traceId: string) => ({
      record: async (event: any) => void recorded.push({ traceId, ...event }),
    }),
    loop: async ({ onEvent, askUser, confirmDeploy }) => {
      const answer = await askUser("Which output should it use?");
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", answer } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      await confirmDeploy();
      return { terminal: "success" };
    },
  });

  const started = controller.start({ intent: "build companion", boardId: "esp32-s3-devkitc-1" });
  const prompt = recorded.find((event) => event.type === "ui_prompt");
  assert.ok(prompt, "expected ui_prompt event");
  controller.resolvePrompt(prompt.promptId, "OLED");
  await flushMicrotasks();
  const deploy = recorded.find((event) => event.type === "deploy_proposed");
  assert.ok(deploy, "expected deploy_proposed event after the artifacts");
  controller.resolvePrompt(deploy.promptId, "confirm");
  await started;

  assert.deepEqual(recorded.map((event) => event.type), [
    "session_started",
    "user_message",
    "ui_prompt",
    "ui_prompt_answer",
    "artifact",
    "artifact",
    "serial_output",
    "deploy_proposed",
    "ui_prompt_answer",
    "session_finished",
  ]);
  assert.equal(recorded[0].intent, "build companion");
  assert.equal(recorded[1].intent, "build companion");
  assert.equal(recorded[3].answer, "OLED");
  assert.equal(recorded[4].kind, "manifest");
  assert.equal(recorded[5].code, "print('MPYHW_READY')");
  assert.equal(recorded[7].manifest.board_id, "esp32-s3-devkitc-1");
  assert.equal(recorded[8].answer, "confirm");
  assert.equal(recorded[9].terminal, "success");
});

test("session controller carries agent state into the next user message", async () => {
  const statesSeen: any[] = [];
  const returnedStates = [
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }] },
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }] },
  ];
  const controller = new SessionController({
    postMessage: () => {},
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

test("session controller reset drops the conversation so the next start is a fresh build under a new trace", async () => {
  const statesSeen: any[] = [];
  const traceIds: string[] = [];
  const carried = { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }] };
  const controller = new SessionController({
    postMessage: () => {},
    recorderFactory: (traceId: string) => { traceIds.push(traceId); return { record: async () => {} }; },
    loop: async (input) => { statesSeen.push(input.state); return { terminal: "awaiting_user", state: carried }; },
  });

  await controller.start({ intent: "first", boardId: "esp32-s3-devkitc-1" });
  controller.reset();
  await controller.start({ intent: "unrelated next project", boardId: "esp32-s3-devkitc-1" });

  // First run starts cold; the second would have CONTINUED (seen `carried`) without
  // the reset — instead it starts cold again, and under a distinct trace id.
  assert.equal(statesSeen[0], undefined);
  assert.equal(statesSeen[1], undefined, "reset must drop the carried state so the next start is a new conversation");
  assert.equal(traceIds.length, 2, "the post-reset start must mint a fresh recorder trace");
  assert.notEqual(traceIds[0], traceIds[1]);
});

test("session controller cancel unblocks a pending ask_user with a null answer", async () => {
  let captured: string | null = "unset";
  const controller = new SessionController({
    postMessage: () => {},
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
