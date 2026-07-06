import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  GEN_DRIVER_ENVELOPE_PHASE,
  GEN_DRIVER_DOMAIN_PHASE,
  GEN_DRIVER_PROTOCOL_VERSION,
  GEN_DRIVER_MODES,
  GEN_DRIVER_SOURCE_TYPES,
  GEN_DRIVER_TABS,
  buildStartPhase,
  deriveDriverStatus,
  inferMode,
  validateFields,
  buildSourceFromFields,
  normalizeSources,
  canStartGeneration,
} from "../src/core/gen-driver-schema.ts";

const tab = (id: string) => GEN_DRIVER_TABS.find((t) => t.id === id)!;

// Contract lock: the plugin's own sample payloads must satisfy this schema. If the
// upstream plugin (or Ruili's final schema) changes the contract, these fail and
// point at exactly what moved, so the swap is mechanical, not guesswork.
const pluginSample = (name: string): any =>
  JSON.parse(
    readFileSync(
      resolve("..", "third_party", "MicroPython_Skills", "upy-gen-driver-plugin", "sample", name),
      "utf-8",
    ),
  );

test("plugin start_phase samples satisfy the schema constants", () => {
  for (const name of [
    "start_phase.upy_gen_driver_plugin.standalone.json",
    "start_phase.upy_gen_driver_plugin.pipeline.json",
  ]) {
    const s = pluginSample(name);
    assert.equal(s.phase, GEN_DRIVER_ENVELOPE_PHASE);
    assert.equal(s.protocol_version, GEN_DRIVER_PROTOCOL_VERSION);
    assert.equal(s.payload.phase, GEN_DRIVER_DOMAIN_PHASE);
    assert.equal(s.payload.domain_phase, GEN_DRIVER_DOMAIN_PHASE);
    assert.ok(GEN_DRIVER_MODES.includes(s.payload.mode), `mode ${s.payload.mode} in schema`);
    if (s.payload.source) {
      assert.ok(GEN_DRIVER_SOURCE_TYPES.includes(s.payload.source.type), `source.type ${s.payload.source.type} in schema`);
    }
  }
});

test("buildStartPhase reproduces the standalone sample shape", () => {
  const sample = pluginSample("start_phase.upy_gen_driver_plugin.standalone.json");
  const built = buildStartPhase({
    sessionId: sample.session_id,
    msgId: sample.msg_id,
    timestamp: sample.timestamp,
    mode: "standalone",
    source: null,
    runtimeContext: sample.payload.runtime_context,
    capabilities: sample.payload.capabilities,
  });
  assert.equal(built.phase, sample.phase);
  assert.equal(built.type, "start_phase");
  assert.equal(built.idempotency_key, sample.idempotency_key);
  const payload = built.payload as any;
  assert.equal(payload.mode, "standalone");
  assert.equal(payload.phase, GEN_DRIVER_DOMAIN_PHASE);
  assert.equal(payload.domain_phase, GEN_DRIVER_DOMAIN_PHASE);
  // normalized contract: canonical input is sources[]; a null legacy source -> []
  assert.deepEqual(payload.sources, []);
  assert.equal("source" in payload, false, "new payload emits sources[], not a singular source");
});

test("buildStartPhase carries pipeline-only fields (source_phase, manifest_content)", () => {
  const sample = pluginSample("start_phase.upy_gen_driver_plugin.pipeline.json");
  const built = buildStartPhase({
    sessionId: sample.session_id,
    msgId: sample.msg_id,
    timestamp: sample.timestamp,
    mode: "pipeline",
    source: sample.payload.source,
    runtimeContext: sample.payload.runtime_context,
    capabilities: sample.payload.capabilities,
    manifestContent: sample.payload.manifest_content,
    sourcePhase: sample.payload.source_phase,
    sourcePhaseCompletePath: sample.payload.source_phase_complete_path,
  });
  const payload = built.payload as any;
  assert.equal(payload.mode, "pipeline");
  assert.equal(payload.source_phase, sample.payload.source_phase);
  assert.equal(payload.source_phase_complete_path, sample.payload.source_phase_complete_path);
  assert.deepEqual(payload.manifest_content, sample.payload.manifest_content);
});

test("standalone build omits pipeline-only fields", () => {
  const built = buildStartPhase({
    sessionId: "s",
    msgId: "m",
    timestamp: "t",
    mode: "standalone",
    source: null,
    runtimeContext: { artifact_root: ".", session_root: "s", project_root: "p", file_operation_root: "p", resource_root: "r" },
  });
  const payload = built.payload as any;
  assert.equal("source_phase" in payload, false);
  assert.equal("manifest_content" in payload, false);
});

test("deriveDriverStatus projects result + verification_mode into the UI status", () => {
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: true, verification_mode: "hardware" }), "ready");
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: false, verification_mode: "skipped" }), "unverified");
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: false, verification_mode: "mock" }), "unverified");
  assert.equal(deriveDriverStatus({ result: "partial" }), "pending_validation");
  assert.equal(deriveDriverStatus({ result: "failed" }), "failed");
  assert.equal(deriveDriverStatus({}), "failed");
});

test("deriveDriverStatus agrees with the plugin's phase_complete samples", () => {
  const success = pluginSample("phase_complete.upy_gen_driver_plugin.success.json").payload;
  const status = deriveDriverStatus(success);
  assert.ok(status === "ready" || status === "unverified", `success sample -> ${status}`);
  const noDevice = pluginSample("phase_complete.upy_gen_driver_plugin.partial.no_device.json").payload;
  assert.equal(deriveDriverStatus(noDevice), "pending_validation");
});

test("inferMode picks pipeline only for a cold-driver manifest", () => {
  assert.equal(inferMode({ devices: [{ name: "SHT30", driver: { status: "cold_driver_required" } }] }), "pipeline");
  assert.equal(inferMode({ devices: [{ name: "LED" }] }), "standalone");
  assert.equal(inferMode(null), "standalone");
  assert.equal(inferMode({}), "standalone");
});

test("every source tab maps to a known source type; verification tab is config", () => {
  for (const tab of GEN_DRIVER_TABS) {
    if (tab.sourceType === null) continue;
    assert.ok(GEN_DRIVER_SOURCE_TYPES.includes(tab.sourceType), `tab ${tab.id} -> ${tab.sourceType}`);
  }
  assert.ok(GEN_DRIVER_TABS.some((t) => t.sourceType === null), "a verification-settings tab exists");
});

test("validateFields flags missing required inputs per tab", () => {
  assert.deepEqual(validateFields(tab("github"), {}), ["Repo URL"]);
  assert.deepEqual(validateFields(tab("github"), { url: "https://github.com/x/y" }), []);
  assert.deepEqual(validateFields(tab("chip"), {}), ["Chip model"]);
  assert.deepEqual(validateFields(tab("chip"), { chip_model: "SHT30" }), []);
  assert.deepEqual(validateFields(tab("current"), {}), []);
});

test("buildSourceFromFields assembles source.type + non-empty fields, verification is null", () => {
  const src = buildSourceFromFields(tab("chip"), { chip_model: "SHT30", vendor: "", interface: "i2c" });
  assert.deepEqual(src, { type: "chip_model", chip_model: "SHT30", interface: "i2c" });
  assert.equal(buildSourceFromFields(tab("verification"), { port: "COM3" }), null);
  assert.deepEqual(buildSourceFromFields(tab("current"), {}), { type: "current_cold_driver_item" });
});

test("file-source tabs require an uploaded file and carry its integrity metadata", () => {
  assert.deepEqual(validateFields(tab("pdf"), {}), ["Datasheet PDF"]);
  const file = { name: "sht30.pdf", path: "/tmp/sht30.pdf", size: 2048, sha256: "abc123" };
  assert.deepEqual(validateFields(tab("pdf"), { pdf_file: file }), []);
  const src = buildSourceFromFields(tab("pdf"), { pdf_file: file, chip_model: "SHT30" });
  assert.deepEqual(src, { type: "pdf", pdf_file: file, chip_model: "SHT30" });
});

test("normalizeSources: legacy single source -> [source], array passes through, null -> []", () => {
  const s = { type: "chip_model" as const, chip_model: "SHT30" };
  assert.deepEqual(normalizeSources(s), [s]);
  assert.deepEqual(normalizeSources(null, [s, { type: "pdf" }]), [s, { type: "pdf" }]);
  assert.deepEqual(normalizeSources(null), []);
});

test("canStartGeneration gates on >=1 source or a driver_request", () => {
  assert.equal(canStartGeneration([]), false);
  assert.equal(canStartGeneration([{ type: "pdf" }]), true);
  assert.equal(canStartGeneration([], { chip_model: "SHT30" }), true);
  assert.equal(canStartGeneration([], { driver_id: "sht30" }), true);
  assert.equal(canStartGeneration([], {}), false);
});

test("buildStartPhase emits the normalized business payload (sources[]/driver_request/verification)", () => {
  const built = buildStartPhase({
    sessionId: "s", msgId: "m", timestamp: "t", mode: "standalone",
    runtimeContext: { artifact_root: ".", session_root: "s", project_root: "p", file_operation_root: "p", resource_root: "r" },
    sources: [{ type: "pdf", artifact_path: "gen-driver/input/BMP390.pdf", sha256: "abc", primary: true }],
    driverRequest: { driver_id: "bmp390", chip_model: "BMP390", interface: "i2c", i2c_addresses: ["0x76", "0x77"] },
    verification: { required: true, policy: "hardware_required", marker: "SELF_TEST_PASS:BMP390:PRESSURE_TEMP_READ_OK", max_rounds: 3 },
  });
  const payload = built.payload as any;
  assert.deepEqual(payload.sources, [{ type: "pdf", artifact_path: "gen-driver/input/BMP390.pdf", sha256: "abc", primary: true }]);
  assert.equal(payload.driver_request.driver_id, "bmp390");
  assert.deepEqual(payload.driver_request.i2c_addresses, ["0x76", "0x77"]);
  assert.equal(payload.verification.policy, "hardware_required");
  // envelope + runtime_context + capabilities kept from the sample shape
  assert.equal(built.phase, GEN_DRIVER_ENVELOPE_PHASE);
  assert.ok(payload.runtime_context && payload.capabilities);
});
