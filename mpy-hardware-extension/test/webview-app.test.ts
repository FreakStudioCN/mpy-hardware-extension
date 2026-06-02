import assert from "node:assert/strict";
import test from "node:test";

import { applyHostMessage, isStartDisabled, creditsLabel } from "../src/webview/app.ts";

test("credit helpers show remaining balance and disabled start state", () => {
  assert.equal(creditsLabel({ balance: 3 }), "3 credits left");
  assert.equal(isStartDisabled({ balance: 0 }), true);
  assert.equal(isStartDisabled({ balance: 12 }), false);
});

test("credits host message updates status and disables start when empty", () => {
  const state = { statusText: "Ready", startDisabled: false };

  applyHostMessage({ type: "session_event", event: { kind: "credits", balance: 0, dailyGrant: 50 } }, state);

  assert.equal(state.statusText, "0 credits left");
  assert.equal(state.startDisabled, true);
});
