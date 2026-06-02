import assert from "node:assert/strict";
import test from "node:test";

import { validateHostMessage, validateWebviewMessage } from "../src/webview/protocol.ts";

test("webview protocol accepts known messages and rejects malformed payloads", () => {
  assert.equal(validateWebviewMessage({ type: "start_session", intent: "temperature led", boardId: "esp32-s3-devkitc-1" }).ok, true);
  assert.equal(validateWebviewMessage({ type: "ui_prompt_response", promptId: "prompt-1", answer: "esp32-s3-devkitc-1" }).ok, true);
  assert.equal(validateWebviewMessage({ type: "start_session", boardId: "esp32-s3-devkitc-1" }).ok, false);
  assert.equal(validateWebviewMessage({ type: "unknown" }).ok, false);
});

test("host protocol accepts structured updates only", () => {
  assert.equal(validateHostMessage({ type: "code_updated", code: "print(1)" }).ok, true);
  assert.equal(validateHostMessage({ type: "ui_prompt_needed", promptId: "prompt-1", question: "Which board?" }).ok, true);
  assert.equal(validateHostMessage({ type: "serial_output", lines: ["MPYHW_READY"] }).ok, true);
  assert.equal(validateHostMessage({ type: "serial_output", lines: "MPYHW_READY" }).ok, false);
});
