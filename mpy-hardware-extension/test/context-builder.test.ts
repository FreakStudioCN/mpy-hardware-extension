import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemContext } from "../src/core/context-builder.ts";
import { createSessionState } from "../src/core/session-state.ts";

test("context includes foundational skills, loaded skills, board, packages, and tools", () => {
  const state = createSessionState({ traceId: "t1", intent: "read temp", boardId: "esp32-s3-devkitc-1" });
  state.loadedSkills.push("serial-diagnosis");
  state.lastRuntimeMarker = "x".repeat(5000);

  const blocks = buildSystemContext({
    state,
    content: {
      foundationalSkills: [{ name: "agent", body: "agent identity" }],
      taskSkills: { "serial-diagnosis": "diagnose serial" },
      boardProfile: { board_id: "esp32-s3-devkitc-1", available_modules: ["machine"] },
      packageIndex: { total_packages: 3 },
      tools: [{ name: "query_board_profile" }],
    },
  });

  const text = blocks.map((block) => block.text).join("\n");
  assert.match(text, /agent identity/);
  assert.match(text, /diagnose serial/);
  assert.match(text, /esp32-s3-devkitc-1/);
  assert.match(text, /query_board_profile/);
  assert.ok(text.length < 2500);
});
