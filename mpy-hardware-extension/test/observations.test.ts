import assert from "node:assert/strict";
import test from "node:test";

import { normalizeObservation } from "../src/core/observations.ts";

test("tool observations redact absolute paths and truncate large text fields", () => {
  const observation = normalizeObservation("run_triage", {
    ok: true,
    project_dir: "C:/Users/Haipeng Wu/Desktop/cursor_for_hardware/demo",
    output: `Traceback\n  File "C:/Users/Haipeng Wu/Desktop/cursor_for_hardware/demo/firmware/main.py"\n${"x".repeat(5000)}`,
    logs: [
      "mpremote connect COM3 resume fs cp C:/Users/Haipeng Wu/Desktop/cursor_for_hardware/demo/firmware/main.py :main.py",
    ],
    artifacts: [
      "C:/Users/Haipeng Wu/Desktop/cursor_for_hardware/demo/reports/triage.json",
      "reports/summary.json",
    ],
  });
  const serialized = JSON.stringify(observation);

  assert.doesNotMatch(serialized, /C:\/Users\/Haipeng Wu/);
  // The whole path is redacted, not just the prefix up to the first space: a Windows
  // username with a space ("Haipeng Wu") must not leak its tail to the cloud.
  assert.doesNotMatch(serialized, /Wu\/Desktop/);
  assert.doesNotMatch(serialized, /Desktop\/cursor_for_hardware/);
  assert.doesNotMatch(serialized, /mpremote connect/);
  assert.match(serialized, /\[redacted-path\]/);
  assert.equal(observation.truncated, true);
  assert.ok(observation.output.output.length < 1500);
  assert.deepEqual(observation.output.artifacts, ["[redacted-path]", "reports/summary.json"]);
});

