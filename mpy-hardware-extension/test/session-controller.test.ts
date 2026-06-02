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
