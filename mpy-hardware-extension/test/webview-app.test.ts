import assert from "node:assert/strict";
import test from "node:test";

import { applyHostMessage, isStartDisabled, quotaLabel } from "../src/webview/app.ts";

test("quota helpers show remaining sessions and disabled start state", () => {
  assert.equal(quotaLabel({ used: 2, limit: 5 }), "3 sessions remaining");
  assert.equal(isStartDisabled({ used: 5, limit: 5 }), true);
});

test("quota host message updates status and disables start", () => {
  const state = { statusText: "Ready", startDisabled: false };

  applyHostMessage({ type: "session_event", event: { kind: "quota", used: 5, limit: 5 } }, state);

  assert.equal(state.statusText, "0 sessions remaining");
  assert.equal(state.startDisabled, true);
});
