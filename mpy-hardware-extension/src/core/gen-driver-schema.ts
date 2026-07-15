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

// source.type values the plugin accepts. Normalized contract (Ruili 2026-07-06,
// Jul-6 gen-driver-contract doc §2.2) includes `manual_facts` as its own source type.
export type GenDriverSourceType =
  | "current_cold_driver_item"
  | "pdf"
  | "arduino_source"
  | "github_url"
  | "chip_model"
  | "image"
  | "manual_facts";
export const GEN_DRIVER_SOURCE_TYPES: readonly GenDriverSourceType[] = [
  "current_cold_driver_item",
  "pdf",
  "arduino_source",
  "github_url",
  "chip_model",
  "image",
  "manual_facts",
];

// UI input tabs. A source tab maps to one source.type; the verification tab is
// configuration (serial port, board, verify policy), not a source. The panel
// renders from this list, so adding/renaming a tab is a one-line change here.
// A single input on a tab. The panel renders by `kind`; the schema stays the
// source of truth for what each tab collects, so field changes are one edit here.
// A select option is a bare string (value === label) or a { value, label } pair —
// the materialized current-driver picker uses the pair: value is the device_id, the
// label carries name/interface/address so the user can tell the devices apart.
export type GenDriverSelectOption = string | { value: string; label: string };
export type GenDriverField = {
  key: string;
  label: string;
  kind: "text" | "textarea" | "select" | "checkbox" | "file" | "info";
  required?: boolean;
  placeholder?: string;
  options?: GenDriverSelectOption[];
  // "info" kind only: read-only display lines (selected-context detail / empty-state note).
  lines?: string[];
  // file fields only: which extension group the host open-dialog filters to.
  accept?: "pdf" | "arduino" | "image";
};
// value carried for a picked "file" field: recorded in the source payload so the
// plugin gets the path plus integrity metadata (source-tab is source.type).
export type GenDriverFile = { name: string; path: string; size: number; sha256: string; uploaded_at?: string };
export function isPickedFile(value: unknown): value is GenDriverFile {
  return typeof value === "object" && value !== null && typeof (value as GenDriverFile).sha256 === "string";
}
export type GenDriverTab = {
  id: string;
  label: string;
  sourceType: GenDriverSourceType | null;
  fields: GenDriverField[];
  // set by materializeGenDriverTabs on the current tab when the session has no
  // cold-driver item: the panel shows the empty-state note and omits "+ Add source".
  noItems?: boolean;
};
export const GEN_DRIVER_TABS: readonly GenDriverTab[] = [
  { id: "current", label: "Current project missing driver", sourceType: "current_cold_driver_item", fields: [] },
  {
    id: "pdf", label: "PDF datasheet", sourceType: "pdf", fields: [
      { key: "pdf_file", label: "Datasheet PDF", kind: "file", required: true, accept: "pdf" },
      { key: "chip_model", label: "Chip / module", kind: "text", placeholder: "e.g. SHT30" },
      { key: "vendor", label: "Vendor", kind: "text" },
      { key: "interface", label: "Interface", kind: "text", placeholder: "e.g. i2c / spi / uart" },
      { key: "page_range", label: "Page range", kind: "text", placeholder: "e.g. 12-18" },
      { key: "i2c_address", label: "I2C address", kind: "text", placeholder: "0x44" },
      { key: "register_keywords", label: "Register keywords", kind: "text", placeholder: "e.g. CTRL, STATUS, DATA" },
    ],
  },
  {
    id: "arduino", label: "Arduino/C/C++ source", sourceType: "arduino_source", fields: [
      { key: "source_file", label: "Arduino / C / C++ file (or .zip)", kind: "file", required: true, accept: "arduino" },
      { key: "entry_class", label: "Main class", kind: "text" },
      { key: "example_path", label: "Example path", kind: "text", placeholder: "e.g. examples/basic/basic.ino" },
      { key: "library_version", label: "Library version", kind: "text" },
      { key: "license", label: "License", kind: "text", placeholder: "e.g. MIT" },
    ],
  },
  {
    id: "github", label: "GitHub repository", sourceType: "github_url", fields: [
      { key: "url", label: "Repo URL", kind: "text", required: true, placeholder: "https://github.com/owner/repo" },
      { key: "ref", label: "Branch / tag / commit", kind: "text", required: true, placeholder: "pin a ref, e.g. v1.2.0 or a commit sha" },
      { key: "subdir", label: "Subdirectory", kind: "text" },
      { key: "example_path", label: "Example path", kind: "text", placeholder: "e.g. examples/basic" },
    ],
  },
  {
    id: "chip", label: "Chip/module model", sourceType: "chip_model", fields: [
      { key: "chip_model", label: "Chip model", kind: "text", required: true, placeholder: "e.g. SHT30" },
      { key: "module_model", label: "Module model", kind: "text" },
      { key: "vendor", label: "Vendor", kind: "text" },
      { key: "interface", label: "Interface", kind: "select", options: ["i2c", "spi", "uart", "onewire", "adc", "gpio"] },
      { key: "default_address", label: "Default address", kind: "text", placeholder: "0x44" },
      { key: "datasheet_url", label: "Datasheet URL", kind: "text", placeholder: "https://…" },
      { key: "search_keywords", label: "Search keywords", kind: "text", placeholder: "e.g. temperature humidity sensor" },
    ],
  },
  {
    id: "image", label: "Image / screenshot", sourceType: "image", fields: [
      { key: "image_file", label: "Image", kind: "file", required: true, accept: "image" },
    ],
  },
  {
    id: "manual", label: "Manual facts", sourceType: "manual_facts", fields: [
      { key: "facts", label: "Manual facts", kind: "textarea", required: true, placeholder: "Registers, init sequence, read/write commands, conversions" },
    ],
  },
  {
    id: "driver", label: "Target driver", sourceType: null, fields: [
      { key: "driver_id", label: "Driver id", kind: "text", placeholder: "e.g. bmp390" },
      { key: "chip_model", label: "Chip model", kind: "text", placeholder: "e.g. BMP390" },
      { key: "module_model", label: "Module model", kind: "text" },
      { key: "vendor", label: "Vendor", kind: "text" },
      { key: "interface", label: "Interface", kind: "select", options: ["i2c", "spi", "uart", "onewire", "adc", "gpio"] },
      { key: "i2c_addresses", label: "I2C addresses", kind: "text", placeholder: "0x76, 0x77" },
      { key: "board_id", label: "Target board id", kind: "text" },
      { key: "mcu", label: "MCU", kind: "text" },
    ],
  },
  {
    id: "verification", label: "Verification settings", sourceType: null, fields: [
      { key: "port", label: "Serial port", kind: "text" },
      { key: "board", label: "Target board", kind: "text" },
      { key: "test_scenario", label: "Test scenario", kind: "text", placeholder: "e.g. TEMP_HUMIDITY_READ_OK" },
      { key: "marker", label: "Expected marker", kind: "text", placeholder: "SELF_TEST_PASS:<CHIP>:<SCENARIO>" },
      { key: "max_rounds", label: "Max verification rounds", kind: "text", placeholder: "3" },
      { key: "wiring_confirmed", label: "Wiring confirmed on hardware", kind: "checkbox" },
      { key: "skip_verification", label: "Skip hardware verification (not recommended)", kind: "checkbox" },
    ],
  },
];

// Missing required-field labels for a tab's collected values (empty = valid).
export function validateFields(tab: GenDriverTab, values: Record<string, unknown>): string[] {
  return tab.fields
    .filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ""))
    .map((f) => f.label);
}

// Assemble a source object (sample wire shape) from a tab's collected values. Field values
// go into `metadata`; a picked file hoists its sha256 to the top and records
// name/path/size/uploaded_at under metadata; `artifact_path` stays null until dispatch stages
// the file. The verification tab is config, not a source, so it returns null. `primary` is
// assigned by the caller (the first assembled source is primary).
export function buildSourceFromFields(
  tab: GenDriverTab,
  values: Record<string, unknown>,
  primary = false,
): GenDriverSource | null {
  if (tab.sourceType === null) return null;
  const metadata: Record<string, unknown> = {};
  let sha256: string | null = null;
  for (const field of tab.fields) {
    if (field.kind === "info") continue;
    const value = values[field.key];
    if (value === undefined || value === "" || value === false) continue;
    if (field.kind === "file" && isPickedFile(value)) {
      sha256 = value.sha256;
      metadata[field.key] = { name: value.name, path: value.path, size: value.size, uploaded_at: value.uploaded_at ?? null };
    } else {
      metadata[field.key] = value;
    }
  }
  // The current tab only ever holds cold-driver items; record the status the plugin keys on.
  if (tab.sourceType === "current_cold_driver_item") metadata.driver_status = "cold_driver_required";
  return { type: tab.sourceType, artifact_path: null, sha256, primary, metadata };
}

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
  "PROTOCOL_VERSION_UNSUPPORTED",
  "PERMISSION_DENIED",
  "APPROVAL_TIMEOUT",
  "DEVICE_NOT_FOUND",
  "DEVICE_RUN_TIMEOUT",
  "HARDWARE_VERIFY_FAILED",
  "HARDWARE_VERIFY_EXHAUSTED",
  "STANDALONE_TEST_FAILED",
  "MANIFEST_UPDATE_CONFLICT",
  "ARTIFACT_STALE",
  "IDEMPOTENCY_CONFLICT",
  "CANCELLED_BY_USER",
  "PHASE_COMPLETE_INVALID",
] as const;
export type GenDriverErrorCode = (typeof GEN_DRIVER_ERROR_CODES)[number];

// UI-level driver status. The updated plugin (MicroPython_Skills cf749f9) emits an
// authoritative `driver_status` in phase_complete, so we trust it when present. The
// legacy heuristic over `result` + `hardware_verified` + `verification_mode` stays as a
// fallback for payloads that omit it — necessary because no_device / cancelled / timeout
// are indistinguishable on those three proxy signals alone. Single place this mapping lives.
export type DriverStatus = "ready" | "pending_validation" | "partial" | "unverified" | "failed";

const DRIVER_STATUSES: readonly DriverStatus[] = [
  "ready", "pending_validation", "partial", "unverified", "failed",
];

export function deriveDriverStatus(complete: {
  driver_status?: string;
  result?: string;
  hardware_verified?: boolean;
  verification_mode?: string;
}): DriverStatus {
  // Authoritative field wins when the plugin supplies a known status.
  if (DRIVER_STATUSES.includes(complete.driver_status as DriverStatus)) {
    return complete.driver_status as DriverStatus;
  }
  if (complete.result === "success") {
    // Only real hardware verification earns "ready"; skipped/mock success is
    // usable but unproven (protocol_fields.md: verification_mode).
    if (complete.hardware_verified && complete.verification_mode === "hardware") return "ready";
    return "unverified";
  }
  if (complete.result === "partial") return "pending_validation";
  return "failed";
}

// The cold-driver devices in an (untyped, upstream) manifest — the items the current tab
// picks from and the signal inferMode keys on. Single place the predicate lives.
export function coldDriverDevices(manifestContent: any): any[] {
  const devices = manifestContent?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.filter((device: any) => device?.driver?.status === "cold_driver_required");
}

// Mode inference (SKILL.md): pipeline only when the current manifest has a
// cold-driver item, otherwise standalone. `manifestContent` is untyped upstream data.
export function inferMode(manifestContent: any): GenDriverMode {
  return coldDriverDevices(manifestContent).length > 0 ? "pipeline" : "standalone";
}

// A device -> select option: value is the device_id the source records; the label carries
// name/interface/address so the user can tell the cold-driver items apart.
function coldDriverOption(device: any): { value: string; label: string } {
  const id = String(device?.device_id ?? "");
  const addrs = Array.isArray(device?.i2c_addresses) ? device.i2c_addresses.join("/") : "";
  const detail = [device?.interface, addrs].filter(Boolean).join(" ");
  const label = [device?.name ?? id, detail ? `(${detail})` : ""].filter(Boolean).join(" ");
  return { value: id, label: label || id };
}

// Read-only context lines for the current tab: where the cold-driver items came from.
function manifestContextLines(manifestContent: any, count: number): string[] {
  const lines: string[] = [];
  if (manifestContent?.board_id) lines.push(`Board: ${manifestContent.board_id}`);
  if (manifestContent?.mcu) lines.push(`MCU: ${manifestContent.mcu}`);
  if (manifestContent?.phase) lines.push(`Upstream phase: ${manifestContent.phase}`);
  lines.push(`${count} cold-driver item(s) in the current session.`);
  return lines;
}

// Fill the "current project missing driver" tab from the session manifest: a required device
// picker over the cold-driver items + a read-only context line. Pure — returns a new tabs
// array, other tabs unchanged. Absent/empty manifest -> the tab's no-items empty state.
export function materializeGenDriverTabs(tabs: readonly GenDriverTab[], manifestContent: unknown): GenDriverTab[] {
  const devices = coldDriverDevices(manifestContent);
  return tabs.map((tab) => {
    if (tab.sourceType !== "current_cold_driver_item") return tab;
    if (devices.length === 0) {
      return {
        ...tab, noItems: true,
        fields: [{ key: "no_items", label: "", kind: "info", lines: ["No missing driver in the current session.", "Run analyze / select-hw first, or use another source tab."] }],
      };
    }
    return {
      ...tab, noItems: false,
      fields: [
        { key: "device_id", label: "Missing driver", kind: "select", required: true, options: devices.map(coldDriverOption) },
        { key: "current_context", label: "", kind: "info", lines: manifestContextLines(manifestContent, devices.length) },
      ],
    };
  });
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
  // The 6-tool protocol has no permission_request message, so we cannot honor it. Declare false
  // and rely on the approval-card fallback the SKILL sanctions (references/protocol_fields.md:46).
  // Declaring true would invite the plugin to depend on a round-trip the host can never make.
  permission_request: false,
  file_operation: true,
  script_run: true,
  device_command: true,
  serial_port_scan: true,
  mpremote_run: true,
  file_upload: true,
  // The host implements neither a checkpoint/resume round-trip nor an idempotency cache. Declaring
  // these true would invite the plugin to "save a checkpoint and resume later" or dedupe on a cache
  // the host can never honor (protocol_fields.md:47-49). cancellation stays true — Stop IS supported.
  checkpoint_resume: false,
  cancellation: true,
  idempotency_cache: false,
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

// A source entry, wire shape per sample/*.json: `type` + `artifact_path` (null until the
// picked file is staged into artifact_root at dispatch) + `sha256` (the file's, null for
// non-file sources) + `primary` + `metadata` (the per-tab field values). Normalized
// contract: sources is an ARRAY of these.
export type GenDriverSource = {
  type: GenDriverSourceType;
  artifact_path?: string | null;
  sha256?: string | null;
  primary?: boolean;
  metadata?: Record<string, unknown>;
};

// Canonical target-driver description (Jul-6 doc §2.1). Pipeline prefills from the
// cold_driver_required item + manifest; standalone from user input; fix from artifact.
export type GenDriverDriverRequest = {
  driver_id?: string;
  chip_model?: string;
  module_model?: string;
  vendor?: string;
  interface?: string;
  i2c_addresses?: string[];
  target_board?: { board_id?: string; mcu?: string };
  expected_output?: { driver_dir?: string; module_file?: string; test_file?: string; example_file?: string };
};

// Hardware-verification settings (Jul-6 doc §2.1). P0 default: required + hardware_required.
export type GenDriverVerificationPolicy = "hardware_required" | "skipped";
export type GenDriverVerification = {
  required: boolean;
  policy: GenDriverVerificationPolicy;
  port?: string | null;
  board?: string;
  marker?: string;
  max_rounds?: number;
};

// Compat rule (Ruili): a legacy single `source` normalizes to `sources: [source]`.
// New code emits `sources[]`; this keeps the old shorthand working.
export function normalizeSources(source: GenDriverSource | null, sources?: GenDriverSource[]): GenDriverSource[] {
  if (sources && sources.length > 0) return sources;
  return source ? [source] : [];
}

// Generation gate (Ruili): do not start until there is >=1 valid source OR a
// driver_request carrying at least a driver_id/chip_model. Standalone may sit at [].
export function canStartGeneration(sources: GenDriverSource[], driverRequest?: GenDriverDriverRequest): boolean {
  if (sources.some((s) => s && typeof s.type === "string")) return true;
  return Boolean(driverRequest && (driverRequest.driver_id || driverRequest.chip_model));
}

export type BuildStartPhaseInput = {
  sessionId: string;
  msgId: string;
  timestamp: string;
  mode: GenDriverMode;
  runtimeContext: GenDriverRuntimeContext;
  // Normalized business payload (Jul-6 doc). `source` is the legacy singular shorthand,
  // normalized into `sources[]`; prefer passing `sources`.
  sources?: GenDriverSource[];
  source?: GenDriverSource | null;
  driverRequest?: GenDriverDriverRequest;
  verification?: GenDriverVerification;
  capabilities?: GenDriverCapabilities;
  // pipeline mode carries the upstream project context:
  manifestContent?: unknown;
  sourcePhase?: string;
  sourcePhaseCompletePath?: string;
};

// The runtime_context roots for a real gen-driver dispatch. The host runs plugin script_run with
// cwd = the project dir (= projectFolder) and contains file_operation to projectFolder, so every root
// is cwd-RELATIVE and stays inside that containment boundary: artifact_root/project_root/
// file_operation_root are the project (cwd) itself, and session_root (where the SKILL writes state/logs
// + the final phase_complete) is a sessions/<id> subdir UNDER it. An absolute or "../" root would be
// refused by containment (protocol_fields.md:35). resource_root is the plugin dir name (sample shape).
// (Live-run verification point: confirm the plugin resolves these against its cwd as expected.)
export function genDriverRuntimeContext(sessionId: string): GenDriverRuntimeContext {
  return {
    artifact_root: ".",
    artifact_root_mode: "cwd",
    session_root: `sessions/${sessionId}`,
    project_root: ".",
    file_operation_root: ".",
    resource_root: GEN_DRIVER_ENVELOPE_PHASE,
  };
}

// Build the start_phase envelope+payload for the plugin host to send. Normalized
// contract (Ruili 2026-07-06): sample envelope + runtime_context + capabilities, with
// the Jul-6 doc business payload (sources[] + driver_request + verification).
export function buildStartPhase(input: BuildStartPhaseInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: input.mode,
    phase: GEN_DRIVER_DOMAIN_PHASE,
    domain_phase: GEN_DRIVER_DOMAIN_PHASE,
    sources: normalizeSources(input.source ?? null, input.sources),
    runtime_context: input.runtimeContext,
    capabilities: input.capabilities ?? DEFAULT_GEN_DRIVER_CAPABILITIES,
  };
  if (input.driverRequest !== undefined) payload.driver_request = input.driverRequest;
  if (input.verification !== undefined) payload.verification = input.verification;
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

// Assemble a ready-to-dispatch gen-driver start_phase from the staged sources + the manifest snapshot.
// Infers the mode from the manifest (pipeline iff a cold-driver device is present), attaches the
// cwd-relative runtime_context, and — in pipeline mode only — carries the upstream manifest_content +
// source_phase (default upy-generate-plugin, the #53 path). The returned envelope's `phase` is the
// ENVELOPE token (body.phase) while payload.phase is the DOMAIN token; the caller serializes it as the
// first user message and dispatches via controller.startPhase at the envelope token.
export function buildGenDriverDispatch(input: {
  sessionId: string;
  msgId: string;
  timestamp: string;
  sources: GenDriverSource[];
  manifestContent?: unknown;
  sourcePhase?: string;
  driverRequest?: GenDriverDriverRequest;
  verification?: GenDriverVerification;
}): Record<string, unknown> {
  const mode = inferMode(input.manifestContent);
  const base: BuildStartPhaseInput = {
    sessionId: input.sessionId,
    msgId: input.msgId,
    timestamp: input.timestamp,
    mode,
    runtimeContext: genDriverRuntimeContext(input.sessionId),
    sources: input.sources,
    driverRequest: input.driverRequest,
    verification: input.verification,
  };
  if (mode === "pipeline") {
    base.manifestContent = input.manifestContent;
    base.sourcePhase = input.sourcePhase ?? "upy-generate-plugin";
  }
  return buildStartPhase(base);
}
