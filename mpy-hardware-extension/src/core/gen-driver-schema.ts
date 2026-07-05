// Single source of truth for the upy-gen-driver-plugin protocol contract.
//
// Grounded in the checked-out plugin (third_party/MicroPython_Skills/
// upy-gen-driver-plugin: references/protocol_fields.md + SKILL.md + sample/*.json),
// NOT the typed provisional. This is the isolated swap point: if Ruili's final
// schema diverges, change it here and the contract test (gen-driver-schema.test.ts)
// flags exactly what moved. Skill-side behavior is owned upstream; this module only
// shapes what the extension sends (start_phase) and how it reads results.

export const GEN_DRIVER_ENVELOPE_PHASE = "upy-gen-driver-plugin";
export const GEN_DRIVER_DOMAIN_PHASE = "gen-driver";
export const GEN_DRIVER_PROTOCOL_VERSION = "1.0";

// Execution modes (SKILL.md). The provisional omitted `resume`.
export type GenDriverMode = "pipeline" | "standalone" | "resume" | "fix";
export const GEN_DRIVER_MODES: readonly GenDriverMode[] = ["pipeline", "standalone", "resume", "fix"];

// source.type values the plugin accepts (SKILL.md / plugin.json). The real
// contract uses `image`, not the provisional's "manual_facts".
export type GenDriverSourceType =
  | "current_cold_driver_item"
  | "pdf"
  | "arduino_source"
  | "github_url"
  | "chip_model"
  | "image";
export const GEN_DRIVER_SOURCE_TYPES: readonly GenDriverSourceType[] = [
  "current_cold_driver_item",
  "pdf",
  "arduino_source",
  "github_url",
  "chip_model",
  "image",
];

// UI input tabs. A source tab maps to one source.type; the verification tab is
// configuration (serial port, board, verify policy), not a source. The panel
// renders from this list, so adding/renaming a tab is a one-line change here.
export type GenDriverTab = {
  id: string;
  label: string;
  sourceType: GenDriverSourceType | null;
};
export const GEN_DRIVER_TABS: readonly GenDriverTab[] = [
  { id: "current", label: "Current project missing driver", sourceType: "current_cold_driver_item" },
  { id: "pdf", label: "PDF datasheet", sourceType: "pdf" },
  { id: "arduino", label: "Arduino/C/C++ source", sourceType: "arduino_source" },
  { id: "github", label: "GitHub repository", sourceType: "github_url" },
  { id: "chip", label: "Chip/module model", sourceType: "chip_model" },
  { id: "image", label: "Image / manual facts", sourceType: "image" },
  { id: "verification", label: "Verification settings", sourceType: null },
];

// approval_request ids the plugin actually emits (SKILL.md). These are NOT the
// `driver_source_confirm` / `gen_driver_hardware_verify` the v2 spec guessed.
export const GEN_DRIVER_APPROVAL_IDS = [
  "gen_driver_input",
  "gen_driver_no_device",
  "gen_driver_standalone_test",
  "gen_driver_next_step",
] as const;
export type GenDriverApprovalId = (typeof GEN_DRIVER_APPROVAL_IDS)[number];

// Stable checkpoints, in flow order (protocol_fields.md). The status panel maps
// the current checkpoint to a progress step.
export const GEN_DRIVER_CHECKPOINTS = [
  "started",
  "input_collected",
  "source_preprocessed",
  "understanding_written",
  "debug_driver_written",
  "hardware_verify_ready",
  "hardware_verify_passed",
  "production_driver_written",
  "normalized",
  "standalone_assets_written",
  "standalone_test_passed",
  "manifest_updated",
  "phase_completed",
  "cancelled",
  "verification_exhausted",
] as const;
export type GenDriverCheckpoint = (typeof GEN_DRIVER_CHECKPOINTS)[number];

// Structured error codes (protocol_fields.md), for surfacing failures in the panel.
export const GEN_DRIVER_ERROR_CODES = [
  "MISSING_INPUT_SOURCE",
  "SOURCE_PREPROCESS_FAILED",
  "SOURCE_PREPROCESS_TIMEOUT",
  "DATASHEET_PARSE_INSUFFICIENT",
  "I2C_ADDRESS_AMBIGUOUS",
  "I2C_ADDRESS_NORMALIZATION_REQUIRED",
  "HOST_CAPABILITY_MISSING",
  "PERMISSION_DENIED",
  "APPROVAL_TIMEOUT",
  "DEVICE_NOT_FOUND",
  "DEVICE_RUN_TIMEOUT",
  "HARDWARE_VERIFY_FAILED",
  "HARDWARE_VERIFY_EXHAUSTED",
  "STANDALONE_TEST_FAILED",
  "MANIFEST_UPDATE_CONFLICT",
  "ARTIFACT_STALE",
  "CANCELLED_BY_USER",
  "PHASE_COMPLETE_INVALID",
] as const;
export type GenDriverErrorCode = (typeof GEN_DRIVER_ERROR_CODES)[number];

// UI-level driver status. The plugin does NOT emit this as one field; phase_complete
// carries `result` + `hardware_verified` + `verification_mode`. This projects them
// into the four states the UI shows. Keep this the single place that mapping lives.
export type DriverStatus = "ready" | "pending_validation" | "unverified" | "failed";

export function deriveDriverStatus(complete: {
  result?: string;
  hardware_verified?: boolean;
  verification_mode?: string;
}): DriverStatus {
  if (complete.result === "success") {
    // Only real hardware verification earns "ready"; skipped/mock success is
    // usable but unproven (protocol_fields.md: verification_mode).
    if (complete.hardware_verified && complete.verification_mode === "hardware") return "ready";
    return "unverified";
  }
  if (complete.result === "partial") return "pending_validation";
  return "failed";
}

// Mode inference (SKILL.md): pipeline only when the current manifest has a
// cold-driver item, otherwise standalone. `manifestContent` is untyped upstream data.
export function inferMode(manifestContent: any): GenDriverMode {
  const devices = manifestContent?.devices;
  const hasColdDriver =
    Array.isArray(devices) && devices.some((device: any) => device?.driver?.status === "cold_driver_required");
  return hasColdDriver ? "pipeline" : "standalone";
}

// The capability set the host declares in start_phase (from the sample payloads).
export type GenDriverCapabilities = {
  protocol_versions: string[];
  approval_request: boolean;
  permission_request: boolean;
  file_operation: boolean;
  script_run: boolean;
  device_command: boolean;
  serial_port_scan: boolean;
  mpremote_run: boolean;
  file_upload: boolean;
  checkpoint_resume: boolean;
  cancellation: boolean;
  idempotency_cache: boolean;
  artifact_root: boolean;
};

export const DEFAULT_GEN_DRIVER_CAPABILITIES: GenDriverCapabilities = {
  protocol_versions: [GEN_DRIVER_PROTOCOL_VERSION],
  approval_request: true,
  permission_request: true,
  file_operation: true,
  script_run: true,
  device_command: true,
  serial_port_scan: true,
  mpremote_run: true,
  file_upload: true,
  checkpoint_resume: true,
  cancellation: true,
  idempotency_cache: true,
  artifact_root: true,
};

export type GenDriverRuntimeContext = {
  artifact_root: string;
  session_root: string;
  project_root: string;
  file_operation_root: string;
  resource_root: string;
  artifact_root_mode?: string;
};

export type GenDriverSource = { type: GenDriverSourceType; [key: string]: unknown };

export type BuildStartPhaseInput = {
  sessionId: string;
  msgId: string;
  timestamp: string;
  mode: GenDriverMode;
  source: GenDriverSource | null;
  runtimeContext: GenDriverRuntimeContext;
  capabilities?: GenDriverCapabilities;
  // pipeline mode carries the upstream project context:
  manifestContent?: unknown;
  sourcePhase?: string;
  sourcePhaseCompletePath?: string;
};

// Build the start_phase envelope+payload for the plugin host to send. Shape matches
// sample/start_phase.upy_gen_driver_plugin.{pipeline,standalone}.json.
export function buildStartPhase(input: BuildStartPhaseInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: input.mode,
    phase: GEN_DRIVER_DOMAIN_PHASE,
    domain_phase: GEN_DRIVER_DOMAIN_PHASE,
    source: input.source,
    runtime_context: input.runtimeContext,
    capabilities: input.capabilities ?? DEFAULT_GEN_DRIVER_CAPABILITIES,
  };
  if (input.mode === "pipeline") {
    if (input.sourcePhase !== undefined) payload.source_phase = input.sourcePhase;
    if (input.sourcePhaseCompletePath !== undefined) payload.source_phase_complete_path = input.sourcePhaseCompletePath;
    if (input.manifestContent !== undefined) payload.manifest_content = input.manifestContent;
  }
  return {
    protocol_version: GEN_DRIVER_PROTOCOL_VERSION,
    msg_id: input.msgId,
    session_id: input.sessionId,
    phase: GEN_DRIVER_ENVELOPE_PHASE,
    timestamp: input.timestamp,
    type: "start_phase",
    idempotency_key: `${GEN_DRIVER_ENVELOPE_PHASE}:${input.sessionId}:start:v1`,
    retry_of: null,
    payload,
  };
}
