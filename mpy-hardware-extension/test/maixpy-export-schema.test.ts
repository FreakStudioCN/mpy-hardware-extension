import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildMaixpyExportDispatch,
  normalizeVisionTaskType,
  MAIXPY_ARTIFACT_PATHS,
  MAIXPY_DEFAULT_VISION_TASK,
  MAIXPY_EXPORT_PHASE,
  MAIXPY_OUTPUT_ROOT,
} from "../src/core/maixpy-export-schema.ts";

// Source of truth: the submodule at the REPO ROOT (two up from test/), which keeps the sample/
// fixtures. The vendored copy prepare-vsce produces excludes sample/, so it must not be used here.
const SKILLS_ROOT = resolve(import.meta.dirname, "..", "..", "third_party", "MicroPython_Skills");
const SAMPLE = JSON.parse(readFileSync(resolve(SKILLS_ROOT, "upy-maixpy-export-plugin/sample/start_phase.maixcam_pro_uart_vision.json"), "utf-8"));

const ids = { sessionId: "s1", msgId: "m1", timestamp: "2026-07-27T00:00:00Z" };
const build = (over: Partial<Parameters<typeof buildMaixpyExportDispatch>[0]> = {}) =>
  buildMaixpyExportDispatch({ ...ids, visionTaskType: MAIXPY_DEFAULT_VISION_TASK, ...over });

test("the export envelope carries exactly the sample's key set (message and payload)", () => {
  // Shape lock against the plugin's OWN sample rather than the brief prose: the brief's capability
  // list omits protocol_versions/approval_request, so a hand-typed payload would ship a payload the
  // plugin does not recognize. Mutation: drop local_test (or any payload key) and this fails.
  const env = build();
  assert.deepEqual(Object.keys(env).sort(), Object.keys(SAMPLE).sort());
  assert.deepEqual(Object.keys(env.payload as object).sort(), Object.keys(SAMPLE.payload).sort());
  for (const section of ["vision_task", "uart", "runtime_context", "capabilities"]) {
    assert.deepEqual(
      Object.keys((env.payload as any)[section]).sort(),
      Object.keys(SAMPLE.payload[section]).sort(),
      `${section} key set matches the sample`,
    );
  }
});

test("the fixed sections (uart, capabilities, target) are byte-identical to the sample", () => {
  const p = build().payload as any;
  // Stage A pins the UART wiring and forbids editing the baudrate — the whole block is constant,
  // so it must equal the sample's exactly. Mutation: change any pin/baudrate and this fails.
  assert.deepEqual(p.uart, SAMPLE.payload.uart);
  // Capabilities are the host's honest claim AND happen to match the sample: no checkpoint/resume,
  // no permission prompt, and (the hard product boundary) no device_command and no network.
  assert.deepEqual(p.capabilities, SAMPLE.payload.capabilities);
  assert.equal(p.capabilities.device_command, false, "this tool never drives a device");
  assert.equal(p.capabilities.network, false, "this tool never fetches");
  assert.equal(p.mode, SAMPLE.payload.mode);
  assert.equal(p.invocation_mode, SAMPLE.payload.invocation_mode);
  assert.equal(p.local_test, false);
  assert.equal(p.target_runtime, "maixpy");
  assert.equal(p.target_device, "maixcam_pro");
  assert.equal(p.output_root, MAIXPY_OUTPUT_ROOT);
});

test("jsonl_fields is a fresh array per dispatch (one run cannot mutate the next)", () => {
  const first = build().payload as any;
  const second = build().payload as any;
  first.uart.jsonl_fields.push("injected");
  assert.deepEqual(second.uart.jsonl_fields, SAMPLE.payload.uart.jsonl_fields);
});

test("message identity: phase, session-scoped idempotency key, and cwd-relative runtime context", () => {
  const env = build({ sessionId: "abc-123" });
  assert.equal(env.phase, MAIXPY_EXPORT_PHASE);
  assert.equal(env.protocol_version, SAMPLE.protocol_version);
  assert.equal(env.type, "start_phase");
  assert.equal(env.session_id, "abc-123");
  // The key shape the plugin dedupes on; a per-run random suffix would break its idempotency.
  assert.equal(env.idempotency_key, "upy-maixpy-export-plugin:abc-123:start:v1");
  const rc = (env.payload as any).runtime_context;
  assert.equal(rc.session_root, "sessions/abc-123");
  assert.equal(rc.project_root, ".");
  assert.equal(rc.file_operation_root, ".");
  assert.equal(rc.resource_root, MAIXPY_EXPORT_PHASE, "resources resolve from the plugin dir, not the project");
});

test("vision_task carries the allowlisted type, the caller's model path, and UART output", () => {
  const withModel = build({ modelPath: "/root/models/yolo11n.mud" }).payload as any;
  assert.deepEqual(withModel.vision_task, { type: "yolo_detection", model_path: "/root/models/yolo11n.mud", uart_output: true });
  // No model picked yet is null (the sample's shape with an unknown model), never the sample's
  // placeholder path, which would send a file the user does not have.
  assert.equal((build().payload as any).vision_task.model_path, null);
  assert.equal((build({ modelPath: "" }).payload as any).vision_task.model_path, null, "a blank field is not a path");
});

test("normalizeVisionTaskType admits only the pinned stage-A token", () => {
  // The webview string is untrusted: anything but the one pinned token must be refused so an
  // invented family name can never reach payload.vision_task.type. Mutation: return the raw value
  // for unknown tokens and the qr_code/ocr cases below fail.
  assert.equal(normalizeVisionTaskType("yolo_detection"), "yolo_detection");
  assert.equal(normalizeVisionTaskType("  yolo_detection  "), "yolo_detection", "surrounding whitespace is trimmed");
  for (const bad of ["qr_code", "ocr", "face_recognition", "color_blob", "camera_preview", "YOLO_DETECTION", "yolo_detection ; rm -rf", "", "  ", undefined, null, 7, {}, ["yolo_detection"]]) {
    assert.equal(normalizeVisionTaskType(bad as unknown), null, `${JSON.stringify(bad)} is refused`);
  }
});

test("the artifact paths are the two files the writer allowlist permits", () => {
  assert.deepEqual([...MAIXPY_ARTIFACT_PATHS], ["sipeed_vision/main.py", "sipeed_vision/README.md"]);
});
