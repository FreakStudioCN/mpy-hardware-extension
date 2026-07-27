// Start_phase builder for the Sipeed MaixPy export global tool. Distinct from the optional flows:
// it consumes no upstream phase_complete (it is a standalone entry, not a post-generate flow) and
// carries the vision-task + fixed-UART payload the plugin's SKILL requires. Shape verified against
// upy-maixpy-export-plugin/sample/start_phase.maixcam_pro_uart_vision.json — never hand-typed from
// the brief prose, which omits protocol_versions/approval_request that the sample carries.

export const MAIXPY_EXPORT_PHASE = "upy-maixpy-export-plugin";
// Every generated file lives under this one directory; the writer allowlist and the panel's
// "what will be written" preview both key off it, so it has exactly one definition.
export const MAIXPY_OUTPUT_ROOT = "sipeed_vision";
export const MAIXPY_ARTIFACT_PATHS = [`${MAIXPY_OUTPUT_ROOT}/main.py`, `${MAIXPY_OUTPUT_ROOT}/README.md`] as const;

// Host allowlist for the untrusted vision_task.type. Stage A ships ONE token: yolo_detection is the
// only spelling pinned by the plugin (its start_phase sample + references/api_modules/maix_nn.md).
// SKILL.md names six more task families (camera preview, UART bridge, QR, color blob, face, OCR) but
// does NOT pin their token strings, so emitting a guessed one would put an unrecognized token on the
// wire. The picker for those waits on the upstream token list.
export const MAIXPY_VISION_TASK_TYPES = ["yolo_detection"] as const;
export type MaixpyVisionTaskType = (typeof MAIXPY_VISION_TASK_TYPES)[number];
export const MAIXPY_DEFAULT_VISION_TASK: MaixpyVisionTaskType = "yolo_detection";

// The only bundled script an export run may execute. The SKILL also offers
// validate_reference_index.py, but that one validates the Skill's own reference library (and needs
// the reference .md files, which the VSIX strips) — it is maintenance, not part of a user run, and
// SKILL.md's "use bundled scripts when available / else self-check and warn" covers its absence.
export const MAIXPY_RUNTIME_SCRIPTS = ["validate_maixpy_export.py"] as const;

const MAIXPY_PROTOCOL_VERSION = "1.0";

// Fixed UART wiring for MaixCAM Pro -> master MCU. Stage A does not let the user change the
// baudrate (baudrate_editable:false says so on the wire as well), so these are constants, not
// defaults the panel can override.
export const MAIXPY_UART_PORT = "UART1";
export const MAIXPY_UART_TX_PIN = "A19";
export const MAIXPY_UART_RX_PIN = "A18";
export const MAIXPY_UART_BAUDRATE = 115200;
const MAIXPY_JSONL_FIELDS = ["type", "label", "score", "x", "y", "w", "h"];

// Capabilities honesty (like the optional flows'): checkpoint_resume and permission_prompt are
// false because the host implements neither round-trip, and device_command/network are false
// because this tool must never flash, deploy, or fetch. Everything else is what the host provides.
function maixpyCapabilities() {
  return {
    protocol_versions: [MAIXPY_PROTOCOL_VERSION],
    approval_request: true,
    file_operation: true,
    script_run: true,
    checkpoint_resume: false,
    cancellation: true,
    retry: true,
    timeout: true,
    permission_prompt: false,
    artifact_manifest: true,
    device_command: false,
    network: false,
  };
}

// Trust boundary for the webview-supplied task token: return the allowlisted token, or null when it
// is anything else (unknown family, wrong type, empty). The caller refuses the run on null — an
// unmapped string must never reach payload.vision_task.type.
export function normalizeVisionTaskType(value: unknown): MaixpyVisionTaskType | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return (MAIXPY_VISION_TASK_TYPES as readonly string[]).includes(token) ? (token as MaixpyVisionTaskType) : null;
}

// Build the start_phase envelope for one export run. `modelPath` is a MaixCAM-side path
// (e.g. /root/models/yolo.mud) that the CALLER has already sanitized — the host panel is the trust
// boundary for it, same as for the task type; absent/blank sends null, matching the sample's shape
// with an unknown model.
export function buildMaixpyExportDispatch(input: {
  sessionId: string;
  msgId: string;
  timestamp: string;
  visionTaskType: MaixpyVisionTaskType;
  modelPath?: string | null;
}): Record<string, unknown> {
  return {
    protocol_version: MAIXPY_PROTOCOL_VERSION,
    type: "start_phase",
    phase: MAIXPY_EXPORT_PHASE,
    session_id: input.sessionId,
    msg_id: input.msgId,
    timestamp: input.timestamp,
    idempotency_key: `${MAIXPY_EXPORT_PHASE}:${input.sessionId}:start:v1`,
    payload: {
      mode: "generate",
      invocation_mode: "plugin_protocol",
      local_test: false,
      target_runtime: "maixpy",
      target_device: "maixcam_pro",
      output_root: MAIXPY_OUTPUT_ROOT,
      vision_task: {
        type: input.visionTaskType,
        model_path: input.modelPath || null,
        // Stage A generates a UART JSON Lines coprocessor, so results always go out on the wire.
        uart_output: true,
      },
      uart: {
        port: MAIXPY_UART_PORT,
        tx_pin: MAIXPY_UART_TX_PIN,
        rx_pin: MAIXPY_UART_RX_PIN,
        baudrate: MAIXPY_UART_BAUDRATE,
        baudrate_editable: false,
        protocol: "jsonl",
        jsonl_fields: [...MAIXPY_JSONL_FIELDS],
      },
      // Same cwd-relative containment as the optional flows: project/file-op roots ARE the project
      // (the host runs rooted at projectFolder), state/logs land under sessions/<id>, and
      // resource_root is the plugin dir name.
      runtime_context: {
        session_root: `sessions/${input.sessionId}`,
        project_root: ".",
        file_operation_root: ".",
        resource_root: MAIXPY_EXPORT_PHASE,
      },
      capabilities: maixpyCapabilities(),
    },
  };
}
