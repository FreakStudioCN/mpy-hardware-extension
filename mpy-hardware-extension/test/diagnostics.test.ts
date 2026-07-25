import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SUPPORT_DIAGNOSTICS_FIELDS, buildDiagnosticsFields } from "../src/core/support-config.ts";
import { SessionController } from "../src/extension/session-controller.ts";
import { venvMpremoteVersion } from "../src/extension/device-shim.ts";

test("buildDiagnosticsFields emits every declared field in order, fills gaps, drops strays", () => {
  const { fields, text } = buildDiagnosticsFields({
    plugin_version: "1",
    os: "darwin arm64",
    toolchain_version: "1", // stray legacy key: must NOT appear (the old key mismatch)
  });
  // all 18 keys, in canonical order
  assert.deepEqual(Object.keys(fields), [...SUPPORT_DIAGNOSTICS_FIELDS]);
  assert.equal(fields.plugin_version, "1");
  assert.equal(fields.os, "darwin arm64");
  // a supplied value survives; an unsupplied one is blank, not missing
  assert.equal(fields.session_id, "");
  // the stray key is dropped — extension_version/plugin_version are the real keys now
  assert.ok(!("toolchain_version" in fields));
  // text form: one line per field, in order
  assert.equal(text.split("\n").length, SUPPORT_DIAGNOSTICS_FIELDS.length);
  assert.ok(text.startsWith("session_id: "));
});

test("SessionController.getDiagnostics tracks phase, activity, errors and artifacts from events", () => {
  const controller = new SessionController({ postMessage: () => {}, loop: async () => ({ terminal: "session_done" }) });
  controller.postEvent({ type: "phase_start", phase: "upy-analyze-plugin" });
  controller.postEvent({ type: "status_update", payload: { message: "scaffolding" } });
  controller.postEvent({ type: "code_updated", path: "led.py", code: "x" });
  controller.postEvent({ type: "file_written", path: "main.py" });
  controller.postEvent({ type: "phase_stalled", phase: "upy-generate-plugin", reason: "no_tool" });

  const d = controller.getDiagnostics();
  assert.equal(d.current_phase, "upy-analyze-plugin");
  assert.match(d.recent_activity, /phase_start: upy-analyze-plugin/);
  assert.match(d.recent_activity, /status: scaffolding/);
  assert.match(d.key_errors, /stalled: upy-generate-plugin \(no_tool\)/);
  assert.match(d.artifact_index, /main\.py/);
  assert.match(d.artifact_index, /led\.py/);
});

test("SessionController.getDiagnostics fills session_id, selected_board and current_phase after start", async () => {
  const controller = new SessionController({
    postMessage: () => {},
    loop: async (input: any) => {
      input.onEvent({ type: "phase_start", phase: "upy-select-hw-plugin" });
      return { terminal: "session_done", state: {} };
    },
  });
  await controller.start({ intent: "blink an led", boardId: "esp32", preSelectedBoard: { id: "esp32-s3", display_name: "ESP32-S3" } });

  const d = controller.getDiagnostics();
  assert.ok(d.session_id.length > 0, "session_id is minted from the trace id");
  assert.equal(d.selected_board, "ESP32-S3");
  assert.equal(d.current_phase, "upy-select-hw-plugin");
});

test("venvMpremoteVersion resolves from a venv python, undefined when the path is absent", () => {
  // absent path: guarded, never throws
  assert.equal(venvMpremoteVersion(join("/definitely", "not", "a", "python")), undefined);
  // when the project .venv exists (dev / baseline), it reports mpremote's real version
  const venvPy = join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (existsSync(venvPy)) {
    assert.match(String(venvMpremoteVersion(venvPy)), /\d+\.\d+/);
  }
});

test("SessionController.getDiagnostics records a session error in key_errors", async () => {
  const controller = new SessionController({
    postMessage: () => {},
    loop: async () => {
      throw new Error("boom");
    },
  });
  await controller.start({ intent: "x", boardId: "pico" });
  assert.match(controller.getDiagnostics().key_errors, /session_error: boom/);
});

test("the diagnostics export carries per-phase credit usage and the remaining quota", async () => {
  // Card #87 acceptance: an exported diagnostics snapshot must show per-phase credit usage
  // and remaining-quota changes. Mutation: drop credit_usage from getDiagnostics() ->
  // the field is blank and a support report cannot answer what the build cost.
  const controller = new SessionController({ postMessage: () => {}, loop: async () => ({ terminal: "session_done" }) });
  controller.postEvent({ type: "phase_start", phase: "analyze" });
  controller.postEvent({ type: "credits", remaining: 49, dailyGrant: 50 });
  controller.postEvent({ type: "phase_start", phase: "generate" });
  controller.postEvent({ type: "credits", remaining: 46, dailyGrant: 50 });

  const d = controller.getDiagnostics();
  assert.equal(d.credit_usage, "analyze/phase remaining=49; upy-generate-plugin/generate credits=3 remaining=46");
  // And it lands in the assembled snapshot, in the declared order, like every other field.
  const { fields, text } = buildDiagnosticsFields(d);
  assert.equal(fields.credit_usage, d.credit_usage);
  assert.equal(Object.keys(fields).at(-1), "credit_usage");
  assert.ok(text.includes("credit_usage: analyze/phase"), "the copyable text carries it too");
});

test("a session with no metered turn exports a blank credit_usage, not a fake zero", async () => {
  const controller = new SessionController({ postMessage: () => {}, loop: async () => ({ terminal: "session_done" }) });
  controller.postEvent({ type: "phase_start", phase: "analyze" });

  assert.equal(controller.getDiagnostics().credit_usage, "");
});
