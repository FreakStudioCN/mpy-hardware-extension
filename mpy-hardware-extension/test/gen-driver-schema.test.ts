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
  GEN_DRIVER_ERROR_CODES,
  GEN_DRIVER_TABS,
  buildStartPhase,
  deriveDriverStatus,
  inferMode,
  validateFields,
  buildSourceFromFields,
  materializeGenDriverTabs,
  normalizeSources,
  canStartGeneration,
  DEFAULT_GEN_DRIVER_CAPABILITIES,
} from "../src/core/gen-driver-schema.ts";
import type { DriverStatus } from "../src/core/gen-driver-schema.ts";

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

// Fallback path: payloads WITHOUT an authoritative driver_status fall back to the
// result + hardware_verified + verification_mode heuristic.
test("deriveDriverStatus (fallback) projects result + verification_mode when driver_status is absent", () => {
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: true, verification_mode: "hardware" }), "ready");
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: false, verification_mode: "skipped" }), "unverified");
  assert.equal(deriveDriverStatus({ result: "success", hardware_verified: false, verification_mode: "mock" }), "unverified");
  assert.equal(deriveDriverStatus({ result: "partial" }), "pending_validation");
  assert.equal(deriveDriverStatus({ result: "failed" }), "failed");
  assert.equal(deriveDriverStatus({}), "failed");
});

// Contract lock: the 42e9314 samples carry driver_status directly. no_device / cancelled /
// timeout are indistinguishable on result+hardware_verified+verification_mode, so the field
// IS the contract — lock each sample to its own declared status.
test("deriveDriverStatus trusts the authoritative driver_status in every phase_complete sample", () => {
  const cases: Array<[string, DriverStatus]> = [
    ["phase_complete.upy_gen_driver_plugin.success.json", "ready"],
    ["phase_complete.upy_gen_driver_plugin.success.retry.json", "ready"],
    ["phase_complete.upy_gen_driver_plugin.partial.no_device.json", "pending_validation"],
    ["phase_complete.upy_gen_driver_plugin.partial.cancelled.json", "partial"],
    ["phase_complete.upy_gen_driver_plugin.partial.timeout.json", "failed"],
  ];
  for (const [name, expected] of cases) {
    const payload = pluginSample(name).payload;
    assert.equal(payload.driver_status, expected, `${name} sample declares driver_status ${expected}`);
    assert.equal(deriveDriverStatus(payload), expected, `${name} -> ${expected}`);
  }
});

// "ready" is only real with a hardware marker: the success samples must carry a
// SELF_TEST_PASS hardware_marker and an observed marker matching the required one.
test("ready phase_complete samples carry a real SELF_TEST_PASS marker", () => {
  for (const name of [
    "phase_complete.upy_gen_driver_plugin.success.json",
    "phase_complete.upy_gen_driver_plugin.success.retry.json",
  ]) {
    const payload = pluginSample(name).payload;
    assert.match(payload.hardware_marker ?? "", /^SELF_TEST_PASS:/, `${name} hardware_marker`);
    assert.equal(payload.verification.observed_marker, payload.verification.marker, `${name} observed == required marker`);
  }
});

test("the standardized protocol error codes are recognized (PROTOCOL_VERSION_UNSUPPORTED, IDEMPOTENCY_CONFLICT)", () => {
  // Agreed with the skill side: a plugin emitting these must surface as a first-class code,
  // not a generic failure. If either is missing from the set, the extension drops it.
  assert.ok(GEN_DRIVER_ERROR_CODES.includes("PROTOCOL_VERSION_UNSUPPORTED"), "protocol-version negotiation error is standardized");
  assert.ok(GEN_DRIVER_ERROR_CODES.includes("IDEMPOTENCY_CONFLICT"), "idempotency-key conflict error is standardized");
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
  assert.deepEqual(validateFields(tab("github"), {}), ["Repo URL", "Branch / tag / commit"]);
  assert.deepEqual(validateFields(tab("github"), { url: "https://github.com/x/y", ref: "v1" }), []);
  assert.deepEqual(validateFields(tab("chip"), {}), ["Chip model"]);
  assert.deepEqual(validateFields(tab("chip"), { chip_model: "SHT30" }), []);
  assert.deepEqual(validateFields(tab("current"), {}), []);
});

test("buildSourceFromFields assembles the sample source shape (metadata + primary), verification is null", () => {
  const src = buildSourceFromFields(tab("chip"), { chip_model: "SHT30", vendor: "", interface: "i2c" }, true);
  assert.deepEqual(src, {
    type: "chip_model", artifact_path: null, sha256: null, primary: true,
    metadata: { chip_model: "SHT30", interface: "i2c" },
  });
  assert.equal(buildSourceFromFields(tab("verification"), { port: "COM3" }), null);
  // the current tab always records the cold-driver status the plugin keys on
  assert.deepEqual(buildSourceFromFields(tab("current"), {}), {
    type: "current_cold_driver_item", artifact_path: null, sha256: null, primary: false,
    metadata: { driver_status: "cold_driver_required" },
  });
});

test("file-source tabs require an uploaded file; the source hoists sha256 and records file metadata", () => {
  assert.deepEqual(validateFields(tab("pdf"), {}), ["Datasheet PDF"]);
  const file = { name: "sht30.pdf", path: "/tmp/sht30.pdf", size: 2048, sha256: "abc123", uploaded_at: "2026-07-13T00:00:00Z" };
  assert.deepEqual(validateFields(tab("pdf"), { pdf_file: file }), []);
  const src = buildSourceFromFields(tab("pdf"), { pdf_file: file, chip_model: "SHT30" }, true);
  assert.deepEqual(src, {
    type: "pdf", artifact_path: null, sha256: "abc123", primary: true,
    metadata: { pdf_file: { name: "sht30.pdf", path: "/tmp/sht30.pdf", size: 2048, uploaded_at: "2026-07-13T00:00:00Z" }, chip_model: "SHT30" },
  });
});

test("each tab collects its full field set (locks the per-tab spec keys)", () => {
  const keys = (id: string) => tab(id).fields.map((f) => f.key);
  assert.deepEqual(keys("pdf"), ["pdf_file", "chip_model", "vendor", "interface", "page_range", "i2c_address", "register_keywords"]);
  assert.deepEqual(keys("arduino"), ["source_file", "entry_class", "example_path", "library_version", "license"]);
  assert.deepEqual(keys("github"), ["url", "ref", "subdir", "example_path"]);
  assert.deepEqual(keys("chip"), ["chip_model", "module_model", "vendor", "interface", "default_address", "datasheet_url", "search_keywords"]);
  assert.deepEqual(keys("verification"), ["port", "board", "test_scenario", "marker", "max_rounds", "wiring_confirmed", "skip_verification"]);
});

test("github ref is required now (a pinned ref is mandatory)", () => {
  assert.deepEqual(validateFields(tab("github"), { url: "https://github.com/x/y" }), ["Branch / tag / commit"]);
  assert.deepEqual(validateFields(tab("github"), { url: "https://github.com/x/y", ref: "v1.0" }), []);
});

test("materializeGenDriverTabs builds a device picker over cold-driver items, else an empty state", () => {
  const manifest = { board_id: "esp32", mcu: "ESP32", devices: [
    { device_id: "sht30_th", name: "SHT30", interface: "i2c", i2c_addresses: ["0x44"], driver: { status: "cold_driver_required" } },
    { device_id: "bmp390_p", name: "BMP390", interface: "i2c", driver: { status: "cold_driver_required" } },
    { device_id: "led", name: "LED", driver: { status: "ready" } },
  ] };
  const filled = materializeGenDriverTabs(GEN_DRIVER_TABS, manifest);
  const current = filled.find((t) => t.sourceType === "current_cold_driver_item")!;
  assert.equal(current.noItems, false);
  const pick = current.fields.find((f) => f.key === "device_id")!;
  assert.equal(pick.kind, "select");
  assert.equal(pick.required, true);
  assert.deepEqual((pick.options as { value: string }[]).map((o) => o.value), ["sht30_th", "bmp390_p"], "cold-driver devices only; the ready device is excluded");
  assert.match((pick.options as { label: string }[])[0].label, /SHT30/);
  assert.deepEqual(validateFields(current, {}), ["Missing driver"], "the materialized device_id is required");
  assert.deepEqual(validateFields(current, { device_id: "sht30_th" }), []);
  assert.equal(filled.find((t) => t.id === "pdf"), GEN_DRIVER_TABS.find((t) => t.id === "pdf"), "other tabs pass through unchanged (pure)");
});

test("materializeGenDriverTabs yields a no-items empty state for an empty/absent manifest", () => {
  for (const m of [{ devices: [] }, {}, null]) {
    const current = materializeGenDriverTabs(GEN_DRIVER_TABS, m).find((t) => t.sourceType === "current_cold_driver_item")!;
    assert.equal(current.noItems, true);
    assert.equal(current.fields.find((f) => f.key === "device_id"), undefined, "no picker when there are no items");
    assert.ok(current.fields.some((f) => f.kind === "info"), "shows an info empty-state line");
  }
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

test("capabilities are honest: only what the host actually implements is declared true", () => {
  // Declaring a capability true invites the plugin to depend on a round-trip the host can't make.
  // permission_request (no protocol message), checkpoint_resume (no resume flow), and
  // idempotency_cache (no cache) are all unimplemented -> must be false. Mutation: flip any to true
  // and this fails. cancellation stays true (Stop is real).
  assert.equal(DEFAULT_GEN_DRIVER_CAPABILITIES.permission_request, false);
  assert.equal(DEFAULT_GEN_DRIVER_CAPABILITIES.checkpoint_resume, false);
  assert.equal(DEFAULT_GEN_DRIVER_CAPABILITIES.idempotency_cache, false);
  assert.equal(DEFAULT_GEN_DRIVER_CAPABILITIES.cancellation, true);
});
