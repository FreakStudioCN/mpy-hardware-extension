import assert from "node:assert/strict";
import test from "node:test";

import { validateHostMessage, validateWebviewMessage } from "../src/webview/protocol.ts";

test("webview protocol accepts known messages and rejects malformed payloads", () => {
  assert.equal(validateWebviewMessage({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" }).ok, true);
  assert.equal(validateWebviewMessage({ type: "start_session", boardId: "esp32-s3-devkitc-1" }).ok, false);
  assert.equal(validateWebviewMessage({ type: "unknown" }).ok, false);
});

test("host protocol accepts structured updates only", () => {
  assert.equal(validateHostMessage({ type: "code_updated", code: "print(1)" }).ok, true);
  assert.equal(validateHostMessage({ type: "serial_output", lines: ["MPYHW_READY"] }).ok, true);
  assert.equal(validateHostMessage({ type: "serial_output", lines: "MPYHW_READY" }).ok, false);
});
