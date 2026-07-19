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
  genDriverRuntimeContext,
  buildGenDriverDispatch,
  detectDriverReadyBlock,
  deviceDriverGateCode,
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
    // A fully-evidenced ready driver (path + a marker matching its driver_id) is NOT blocked, so it stays
    // out of the picker. The gate requires this evidence; a bare status:"ready" would now block (path missing).
    { device_id: "led", name: "LED", driver: { status: "ready", driver_id: "led", path: "firmware/drivers/led/led.py", hardware_marker: "SELF_TEST_PASS:led:BLINK_OK" } },
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

test("detectDriverReadyBlock matches both the next_phase and the legacy code/next_action shapes", () => {
  // (a) the explicit next_phase shape (gate contract)
  const explicit = { result: "partial", structured_errors: [{ code: "DRIVER_NOT_READY", device: "SHT30", driver_id: "sht30", next_phase: "upy-gen-driver-plugin", output_path: "firmware/drivers/sht30_driver/" }] };
  assert.equal(detectDriverReadyBlock(explicit).length, 1);
  assert.equal(detectDriverReadyBlock(explicit)[0].driver_id, "sht30");
  // (b) the SHIPPED sample shape: a code + next_action prefix, NO entry-level next_phase.
  // Mutation: match only entry.next_phase -> this legacy sample is missed.
  const legacy = { result: "partial", structured_errors: [{ code: "COLD_DRIVER_REQUIRED", device: "SHT30", next_action: "run_upy_gen_driver_plugin_or_simulate_only" }] };
  assert.equal(detectDriverReadyBlock(legacy).length, 1);
  // negatives: a successful generate, and a partial whose errors are unrelated
  assert.equal(detectDriverReadyBlock({ result: "success", structured_errors: [{ code: "COLD_DRIVER_REQUIRED" }] }).length, 0, "only a partial carries a real block");
  assert.equal(detectDriverReadyBlock({ result: "partial", structured_errors: [{ code: "FLAKE8_FAILED" }] }).length, 0, "unrelated errors are not a driver block");
  assert.equal(detectDriverReadyBlock({ result: "partial" }).length, 0, "no structured_errors -> no block");
});

test("detectDriverReadyBlock catches the REAL 2026-07-16 shape: errors[] + COLD_DRIVER_GATE + device status", () => {
  // The live generate put the gate in `errors` (not structured_errors) with code COLD_DRIVER_GATE, and the
  // manifest device carried driver.status=cold_driver_required. The old code (structured_errors + a code set
  // without COLD_DRIVER_GATE) missed it, so the #53 offer never fired. Detect off the device status first
  // (names the device), and read `errors` as an error-shape fallback.
  const real = {
    result: "partial", next_phase: null,
    errors: [{ code: "COLD_DRIVER_GATE", severity: "error", phase_step: "driver_status_gate", message: "MAX30102 driver status is 'cold_driver_required'. Run upy-gen-driver-plugin first." }],
    manifest_content: { devices: [
      { name: "MAX30102", type: "heart_rate_sensor", driver: { source: "github", status: "cold_driver_required", package_name: "max30102" } },
      { name: "I2C Bus", type: "bus", driver: { source: "builtin_runtime", module: "machine.I2C" } },
    ] },
  };
  const blocks = detectDriverReadyBlock(real);
  // Mutation: revert to structured_errors-only / drop the device-status path -> 0 and this fails.
  assert.equal(blocks.length, 1, "the cold MAX30102 device is the block; the builtin I2C bus is not");
  assert.equal(blocks[0].device, "MAX30102", "names the device off manifest_content.devices");
  assert.equal(blocks[0].driver_status, "cold_driver_required");
  // and the error-shape fallback: gate only in errors[] with COLD_DRIVER_GATE, no cold device status
  const errOnly = { result: "partial", errors: [{ code: "COLD_DRIVER_GATE", device: "MAX30102" }] };
  assert.equal(detectDriverReadyBlock(errOnly).length, 1, "reads the gate from errors[] with COLD_DRIVER_GATE too");
});

test("buildGenDriverDispatch assembles a standalone envelope (body.phase != domain phase)", () => {
  const sources = [{ type: "chip_model" as const, artifact_path: null, sha256: null, primary: true, metadata: { chip_model: "SHT30" } }];
  const env = buildGenDriverDispatch({ sessionId: "s1", msgId: "m1", timestamp: "2026-07-15T00:00:00Z", sources });
  const payload = env.payload as any;
  assert.equal(env.phase, GEN_DRIVER_ENVELOPE_PHASE, "body.phase is the envelope token (what the loop dispatches at)");
  assert.equal(payload.phase, GEN_DRIVER_DOMAIN_PHASE, "payload.phase is the domain token, never body.phase");
  assert.equal(payload.mode, "standalone", "no cold-driver device -> standalone");
  assert.equal(payload.source_phase, undefined, "standalone carries no upstream source_phase");
  assert.equal(payload.manifest_content, undefined, "standalone carries no manifest_content");
  assert.deepEqual(payload.sources, sources, "the staged sources ride the payload");
  assert.ok(payload.runtime_context && payload.capabilities, "runtime_context + capabilities present");
});

test("buildGenDriverDispatch assembles a pipeline envelope from a cold-driver manifest", () => {
  const manifest = { devices: [{ name: "SHT30", driver: { status: "cold_driver_required" } }] };
  const sources = [{ type: "current_cold_driver_item" as const, artifact_path: null, sha256: null, primary: true, metadata: { driver_status: "cold_driver_required" } }];
  const env = buildGenDriverDispatch({ sessionId: "s2", msgId: "m2", timestamp: "2026-07-15T00:00:00Z", sources, manifestContent: manifest });
  const payload = env.payload as any;
  assert.equal(payload.mode, "pipeline", "a cold-driver manifest -> pipeline");
  assert.equal(payload.source_phase, "upy-generate-plugin", "pipeline defaults the #53 upstream phase");
  assert.deepEqual(payload.manifest_content, manifest, "pipeline carries the upstream manifest snapshot");
});

test("every blocked driver status (not just cold) infers pipeline and carries the manifest (#4)", () => {
  // detectDriverReadyBlock blocks FOUR statuses (COLD_DRIVER_STATUSES); coldDriverDevices/inferMode
  // must agree, or the other three dispatch as `standalone` and drop manifest_content/source_phase,
  // so the pipeline can't update the manifest + resume generate. Mutation: revert coldDriverDevices
  // to `=== "cold_driver_required"` and the three non-cold statuses fail here.
  const sources = [{ type: "current_cold_driver_item" as const, artifact_path: null, sha256: null, primary: true, metadata: { driver_status: "pending_validation" } }];
  for (const status of ["cold_driver_required", "pending_validation", "unverified", "failed"]) {
    const manifest = { devices: [{ name: "MAX30102", driver: { status } }] };
    assert.equal(inferMode(manifest), "pipeline", `${status} -> pipeline`);
    const payload = buildGenDriverDispatch({ sessionId: "s", msgId: "m", timestamp: "2026-07-15T00:00:00Z", sources, manifestContent: manifest }).payload as any;
    assert.equal(payload.mode, "pipeline", `${status} dispatch mode`);
    assert.equal(payload.source_phase, "upy-generate-plugin", `${status} carries source_phase`);
    assert.deepEqual(payload.manifest_content, manifest, `${status} carries manifest_content`);
  }
});

test("blocked driver status is read under every driver-status field spelling (#4)", () => {
  // coldDriverDevices must use the same driverStatusOf accessor as detection
  // (driver.status ?? driver.driver_status ?? device.driver_status), not just driver.status.
  assert.equal(inferMode({ devices: [{ name: "Y", driver_status: "failed" }] }), "pipeline", "top-level driver_status blocks");
  assert.equal(inferMode({ devices: [{ name: "Y", driver: { driver_status: "unverified" } }] }), "pipeline", "driver.driver_status blocks");
  // A fully-evidenced ready driver (path + matching marker) or a status-less driver is NOT blocked -> standalone.
  assert.equal(inferMode({ devices: [{ name: "Z", driver: { status: "ready", driver_id: "z", path: "p.py", hardware_marker: "SELF_TEST_PASS:z:OK" } }] }), "standalone", "fully-evidenced ready -> standalone");
  assert.equal(inferMode({ devices: [{ name: "Z", driver: { source: "github" } }] }), "standalone", "no status -> standalone");
});

const GATE_SOURCES = [{ type: "current_cold_driver_item" as const, artifact_path: null, sha256: null, primary: true, metadata: { driver_status: "cold_driver_required" } }];
function gateDispatchPayload(manifestContent: any): any {
  return buildGenDriverDispatch({ sessionId: "s", msgId: "m", timestamp: "2026-07-17T00:00:00Z", sources: GATE_SOURCES, manifestContent }).payload;
}

test("an unsupported driver status blocks and dispatches pipeline with the manifest (#4 gate)", () => {
  // driver_ready_gate.py: a status outside the known set is DRIVER_STATUS_UNSUPPORTED and blocks. The device
  // path alone (no error entries) must drive pipeline + carry the manifest. Mutation: revert the predicate to
  // the 4-status set -> "installed" is unmatched -> detection 0 / standalone / no manifest_content, all fail.
  const M = { devices: [{ name: "SHT30", driver: { status: "installed", driver_id: "sht30" } }] };
  assert.equal(detectDriverReadyBlock({ result: "partial", manifest_content: M }).length, 1, "unsupported status detected");
  assert.equal(inferMode(M), "pipeline", "unsupported -> pipeline");
  const payload = gateDispatchPayload(M);
  assert.equal(payload.mode, "pipeline");
  assert.equal(payload.source_phase, "upy-generate-plugin");
  assert.deepEqual(payload.manifest_content, M);
});

test("a ready driver missing self-test evidence blocks; a fully-evidenced one does not (#4 gate)", () => {
  // Gate: status:"ready" still blocks without a path, without a marker, with an invalid marker, or with a
  // marker whose driver_id doesn't match. Mutation: treat "ready" as always-clear -> the broken cases go
  // standalone and these fail; drop the id-match check -> the mismatch case asserts pipeline and fails.
  const noPath = { devices: [{ name: "SHT30", driver: { status: "ready", driver_id: "sht30", hardware_marker: "SELF_TEST_PASS:sht30:TH_READ_OK" } }] };
  const noMarker = { devices: [{ name: "SHT30", driver: { status: "ready", driver_id: "sht30", path: "firmware/drivers/sht30_driver/sht30.py" } }] };
  for (const M of [noPath, noMarker]) {
    assert.equal(detectDriverReadyBlock({ result: "partial", manifest_content: M }).length, 1, "ready-but-broken blocks");
    assert.equal(inferMode(M), "pipeline");
    const payload = gateDispatchPayload(M);
    assert.equal(payload.mode, "pipeline");
    assert.deepEqual(payload.manifest_content, M);
  }
  const ready = { devices: [{ name: "SHT30", driver: { status: "ready", driver_id: "sht30", path: "p.py", hardware_marker: "SELF_TEST_PASS:sht30:OK" } }] };
  assert.equal(inferMode(ready), "standalone", "fully-evidenced ready is clear");
  const mismatch = { devices: [{ name: "SHT30", driver: { status: "ready", driver_id: "sht30", path: "p.py", hardware_marker: "SELF_TEST_PASS:other:OK" } }] };
  assert.equal(inferMode(mismatch), "pipeline", "marker driver_id mismatch blocks");
});

test("deviceDriverGateCode returns the gate's exact code for each branch (#4)", () => {
  // Pins the code per branch so a code swap (COLD_DRIVER_REQUIRED<->DRIVER_NOT_READY) or a dropped
  // MARKER_INVALID branch is caught — mirrors driver_ready_gate.py:134-201.
  const g = (driver: any) => deviceDriverGateCode({ name: "D", device_id: "d", driver });
  assert.equal(g({ source: "github" }), null, "status-less -> clear");
  assert.equal(g({ status: "cold_driver_required" }), "COLD_DRIVER_REQUIRED");
  assert.equal(g({ status: "failed" }), "DRIVER_NOT_READY", "known blocking (not cold) -> DRIVER_NOT_READY");
  assert.equal(g({ status: "installed" }), "DRIVER_STATUS_UNSUPPORTED", "unknown status -> unsupported");
  assert.equal(g({ status: "ready", driver_id: "d" }), "DRIVER_READY_PATH_MISSING");
  assert.equal(g({ status: "ready", driver_id: "d", path: "p.py" }), "DRIVER_READY_MARKER_MISSING");
  assert.equal(g({ status: "ready", driver_id: "d", path: "p.py", hardware_marker: "NOT_A_MARKER" }), "DRIVER_READY_MARKER_INVALID", "regex-invalid marker");
  assert.equal(g({ status: "ready", driver_id: "d", path: "p.py", hardware_marker: "SELF_TEST_PASS:other:s" }), "DRIVER_READY_MARKER_DRIVER_ID_MISMATCH");
  assert.equal(g({ status: "ready", driver_id: "d", path: "p.py", hardware_marker: "SELF_TEST_PASS:d:s" }), null, "fully-evidenced -> clear");
});

test("materializeGenDriverTabs dedups a device-path block against its cold device, but synthesizes error-code-only blocks", () => {
  // A device-path block names the SAME cold device by NAME while the device option is keyed on device_id, so
  // dedup must cover BOTH keys. Mutation: dedup on device_id only -> the name isn't covered -> the device
  // double-lists ("SHT30" + "sht30_th") and this length-1 assert fails.
  const manifest = { devices: [{ device_id: "sht30_th", name: "SHT30", driver: { status: "cold_driver_required" } }] };
  const deduped = materializeGenDriverTabs(GEN_DRIVER_TABS, manifest, [{ device: "SHT30", driver_status: "cold_driver_required", code: "COLD_DRIVER_REQUIRED" }]);
  const dedupTab = deduped.find((t) => t.sourceType === "current_cold_driver_item")!;
  assert.deepEqual((dedupTab.fields.find((f) => f.key === "device_id")!.options as { value: string }[]).map((o) => o.value), ["sht30_th"], "one row, keyed on device_id");

  // An error-code-only block (the device is NOT a cold device in the manifest) is synthesized as a pickable
  // option instead of the dead "No missing driver" empty state. Mutation: drop blockOptions -> noItems true.
  const errOnly = materializeGenDriverTabs(GEN_DRIVER_TABS, { devices: [] }, [{ device: "MAX30102", driver_status: "installed", code: "DRIVER_STATUS_UNSUPPORTED" }]);
  const errTab = errOnly.find((t) => t.sourceType === "current_cold_driver_item")!;
  assert.equal(errTab.noItems, false, "an error-code-only block is not the empty state");
  assert.deepEqual((errTab.fields.find((f) => f.key === "device_id")!.options as { value: string }[]).map((o) => o.value), ["MAX30102"], "synthesized from the block");
});

test("materializeGenDriverTabs gives name-only live devices a non-empty selectable id", () => {
  // Real 2026-07-16 manifests identify a cold device by name + driver package, without device_id.
  // The required select must still submit a stable non-empty value; otherwise Add source is blocked.
  const manifest = {
    devices: [{
      name: "MAX30102",
      type: "heart_rate_sensor",
      driver: { source: "github", status: "cold_driver_required", package_name: "max30102" },
    }],
  };
  const blocks = detectDriverReadyBlock({ result: "partial", manifest_content: manifest });

  const tabs = materializeGenDriverTabs(GEN_DRIVER_TABS, manifest, blocks);
  const current = tabs.find((tab) => tab.sourceType === "current_cold_driver_item");
  const select = current?.fields.find((field) => field.key === "device_id");

  assert.deepEqual(select?.options, [{ value: "MAX30102", label: "MAX30102" }]);
});

test("genDriverRuntimeContext roots are cwd-relative and containment-valid", () => {
  const rc = genDriverRuntimeContext("sess-1");
  // Every root must be reachable by the host's file_operation/script_run containment (rooted at
  // projectFolder = cwd): no absolute path, no "../" escape. Mutation: point session_root at an
  // absolute or "../" path and this fails.
  for (const [key, value] of Object.entries(rc)) {
    assert.equal(typeof value, "string", `${key} is a string`);
    assert.ok(!(value as string).startsWith("/") && !/^[A-Za-z]:/.test(value as string), `${key} is not absolute: ${value}`);
    assert.ok(!(value as string).split("/").includes(".."), `${key} does not escape with ..: ${value}`);
  }
  assert.equal(rc.project_root, ".", "the project is the run cwd");
  assert.equal(rc.file_operation_root, ".", "file ops are contained to the project (cwd)");
  assert.equal(rc.session_root, "sessions/sess-1", "state/logs land under a sessions/<id> subdir of the project");
  assert.equal(rc.resource_root, GEN_DRIVER_ENVELOPE_PHASE);
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
