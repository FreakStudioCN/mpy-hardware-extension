import { ApiClient } from "./api-client.ts";
import { BoardClient } from "./board-client.ts";
import { auditCode } from "./audit-code.ts";
import { validateManifest } from "./manifest-schema.ts";
import { deriveWiring } from "./wiring-derive.ts";
import { deriveDiagram } from "./diagram-derive.ts";
import { CANONICAL_TOOLS } from "./tool-registry.ts";
import { dispatchTool } from "./tool-dispatch.ts";
import { createLlmClient } from "./llm-client.ts";
import { createSessionState } from "./session-state.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { SkillCatalog } from "./skill-catalog.ts";

// Drivers the LLM never fetches as a package (the LED is a builtin), but which
// generate_code still needs as a context. Mirrors the auto-add in pipeline.ts.
const LED_BUILTIN_CONTEXT = {
  package: { name: "machine_pin_led", version: "builtin" },
  import_names: ["machine"],
  constructors: ["Pin(pin, Pin.OUT)"],
  read_properties: [],
  bus: ["gpio"],
  pin_roles: ["led_anode"],
  install: { builtin: true },
};

// Device-touching tools. Before the first one runs, the host shows a single
// deploy-readiness checkpoint (board connection + wiring) and confirms once.
const DEPLOY_TOOLS = new Set(["install_package", "write_main_py", "flash_and_run", "run_flash_device"]);

// Scheduling mode for init_scaffold.py, derived from the manifest (mirrors the
// recommendation rules in upy-scaffold/SKILL.md). A display/network/LVGL build
// gets asyncio; everything else gets the Timer-tick skeleton. Its only durable
// effect is whether lib/scheduler/ is injected, since generate_code overwrites
// the skeleton main.py — so a wrong guess is low-harm. We never auto-pick
// "thread" (not derivable from the schema); leave that to an explicit run_scaffold.
export function deriveScaffoldMode(manifest: any): "timer" | "async" | "thread" {
  const req = manifest?.requirements ?? {};
  const network = String(req.network ?? "").toLowerCase();
  if (["wifi", "mqtt", "4g"].includes(network)) return "async";
  if (Array.isArray(req.output) && req.output.some((o: any) => String(o).startsWith("display_"))) return "async";
  if (Array.isArray(manifest?.devices) && manifest.devices.some((d: any) => String(d?.type) === "display")) return "async";
  const blob = JSON.stringify(manifest ?? {}).toLowerCase();
  if (blob.includes("lvgl")) return "async";
  return "timer";
}

type LoopDeps = {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  shim?: any;
  // Backstop for a black-holed request (server alive, never responds). Default
  // 90s; set low in tests.
  requestTimeoutMs?: number;
  // Resolves the session JWT for the metered /v1/llm/messages calls. Undefined in
  // headless/test contexts; the calls then go out without an Authorization header.
  getAuthToken?: () => Promise<string | undefined>;
  skillCatalog?: SkillCatalog;
  // Reads a file from the user's workspace for the read_workspace_file tool. The
  // host enforces path containment to the workspace root. Absent in headless/test.
  readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>;
  // Writes a file into the project tree for the write_project_file tool. The host
  // enforces path containment + the allowed-path set (project-manifest.json +
  // firmware/ + test/). Absent in headless/test.
  writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>;
  // Absolute path of the project directory the upstream toolchain scripts operate
  // on (validate / scaffold / download_drivers run host-side and need a real path).
  // The host supplies the workspace root; B2 narrows it to <root>/<slug>. Absent in
  // headless/test, in which case the scripts report project_dir_unavailable.
  projectRoot?: string;
};

type LoopInput = {
  intent: string;
  boardId: string;
  traceId?: string;
  state?: any;
  recorder?: { record(event: Record<string, any>): Promise<void> };
  onEvent?: (event: any) => void;
  askUser?: (question: string, options?: string[], optionsRequiringText?: string[], textPlaceholder?: string) => Promise<string | null>;
  // Build-plan gate: the host shows the requirements + credit estimate and resolves
  // the user's choice — confirm (proceed to codegen), cancel, or revise (re-plan
  // with free-text feedback). Undefined (headless/test) = proceed.
  confirmPlan?: (plan: BuildPlan) => Promise<PlanDecision>;
  // Deploy-readiness gate: the host scans for the board and shows the wiring
  // diagram, resolving true to proceed with install/flash, false to cancel.
  // Undefined (headless/test) = proceed.
  confirmDeploy?: () => Promise<boolean>;
  // Component-confirmation gate: the host shows the proposed device list as a
  // deterministic multi-select card so the user can drop parts or note missing ones
  // before hardware selection. Resolves with the kept device names + optional
  // free-text additions. Undefined (headless/test) = proceed as-is.
  confirmComponents?: (devices: any[]) => Promise<{ action: "confirm" | "cancel"; devices?: string[]; feedback?: string }>;
  signal?: AbortSignal;
  availableBoards?: Array<{ board_id: string; display_name?: string }>;
};

// Opening turn: carries the raw user intent plus the dynamic board-selection
// context the server can't reconstruct (use the chosen one / auto-adopt the only
// one / recommend among several). The static behaviour contract — requirement-first
// clarification, the phase flow, code structure, support_level, language — lives in
// the server SYSTEM_PROMPT (re-sent every round), so it is not repeated here.
function buildOpening(input: LoopInput): string {
  const boards = input.availableBoards ?? [];
  const boardKnown = input.boardId && input.boardId !== "auto";
  const parts = [
    input.intent,
    "",
  ];
  if (boardKnown) {
    parts.push(`[Target board already selected by the user: ${input.boardId}. Use this board and pass this board_id to query_board_profile. Do NOT ask the user which board to use.]`);
  } else if (boards.length === 1) {
    parts.push(`[Only one board is currently supported: ${boards[0].board_id}. Use it (pass this board_id to query_board_profile) and briefly tell the user which board you are targeting; do not make them choose.]`);
  } else if (boards.length > 1) {
    const list = boards.map((b) => `${b.board_id}${b.display_name ? ` (${b.display_name})` : ""}`).join(", ");
    parts.push(`[The user has NOT chosen a board. Supported boards: ${list}. Once the requirement is clear, recommend the single most suitable board and briefly say why. The board is a TECHNICAL choice: in 小白/beginner mode, just adopt your recommendation and tell the user which board you picked — do NOT ask them to choose. Only in 自定义/custom mode, call ask_user to confirm the board before continuing. Use that board_id for query_board_profile and codegen.]`);
  }
  return parts.join("\n");
}

// Codegen is the one output-heavy call: it must emit a whole file AFTER a reasoning
// model has already spent part of its budget on reasoning_content. The default 8192
// turn cap is too small here (an exhausted budget finishes cleanly with empty code),
// so codegen asks for more — the backend still clamps to its anti-abuse ceiling.
const CODEGEN_MAX_TOKENS = 16384;

// LLMs often wrap code in ```python fences despite instructions; unwrap them.
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

export type BuildPlan = {
  intent: string;
  boardId?: string;
  // Optional model-written narrative: what the device does and why these choices
  // were made. Shown above the structured rows on the plan card. Absent if the
  // model didn't supply a manifest.summary.
  summary?: string;
  capabilities: string[];
  packages: string[];
  wiring: Array<{ role: string; pin: string }>;
  estimate: number;
};

// The user's choice at the build-plan gate. "revise" carries free-text feedback
// the model uses to re-plan before the gate is shown again.
export type PlanDecision = { action: "confirm" | "cancel" | "revise"; feedback?: string };

// Rough, deterministic credit estimate for the build (codegen + audit + deploy).
// The exact token count is unknown before generation, so this is a ballpark the
// user can sanity-check at the plan gate: a base for codegen+audit plus one per
// driver package. 1 credit = 10k tokens.
export function estimateCredits(manifest: any): number {
  const packages = Array.isArray(manifest?.packages) ? manifest.packages.length : 0;
  // Rich upstream manifests carry devices[] instead of packages[]; cost scales with
  // whichever is present (codegen + audit base plus one per driver/device).
  const devices = Array.isArray(manifest?.devices) ? manifest.devices.length : 0;
  return 2 + Math.max(packages, devices);
}

// Human-readable build plan derived deterministically from the manifest + intent.
// Drives the host's plan card; no LLM call.
// The plan-gate card summarizes wiring as a flat role -> pin list. The manifest
// `wiring` is now the device-identity object { buses[], standalone[] }, so derive
// the summary from `pins` (still role -> pin); a legacy flat array passes through.
function planWiringRows(manifest: any): Array<{ role: string; pin: string }> {
  if (Array.isArray(manifest?.wiring)) return manifest.wiring;
  // Rich upstream manifest: summarise the pinout[] (device pin_name -> gpio) as
  // role -> pin rows for the plan card.
  if (Array.isArray(manifest?.pinout)) {
    return manifest.pinout
      .filter((p: any) => p?.gpio)
      .map((p: any) => ({ role: String(p.pin_name ?? p.device ?? "pin"), pin: String(p.gpio) }));
  }
  const pins = manifest?.pins;
  if (pins && typeof pins === "object" && !Array.isArray(pins)) {
    return Object.entries(pins)
      .filter(([, pin]) => typeof pin === "string")
      .map(([role, pin]) => ({ role, pin: pin as string }));
  }
  return [];
}

function buildPlan(manifest: any, intent: string): BuildPlan {
  const isRich = manifest && typeof manifest === "object" && manifest.schema_version !== undefined;
  return {
    intent,
    boardId: isRich ? (manifest?.mcu?.board ?? manifest?.mcu?.model ?? manifest?.board_id) : manifest?.board_id,
    summary: isRich
      ? (typeof manifest?.summary === "string" ? manifest.summary : manifest?.requirements?.description)
      : (typeof manifest?.summary === "string" ? manifest.summary : undefined),
    capabilities: isRich
      ? (Array.isArray(manifest?.devices) ? manifest.devices.map((d: any) => d?.type).filter(Boolean) : [])
      : (Array.isArray(manifest?.capabilities) ? manifest.capabilities : []),
    // Guard with Array.isArray, not `?? []`: the model sometimes emits `packages`
    // as a non-array (e.g. {} or 0 for a no-package project), and `?? []` only
    // catches null/undefined, so `.map` would throw and crash the whole loop.
    packages: isRich
      ? (Array.isArray(manifest?.devices) ? manifest.devices.map((d: any) => d?.driver?.package_name).filter(Boolean) : [])
      : (Array.isArray(manifest?.packages) ? manifest.packages : []).map((p: any) => (typeof p === "string" ? p : p?.name)).filter(Boolean),
    wiring: planWiringRows(manifest),
    estimate: estimateCredits(manifest),
  };
}

function requireRichManifest(manifest: any) {
  if (!manifest || typeof manifest !== "object") {
    return {
      ok: false,
      error_kind: "manifest_contract_error",
      errors: [{ code: "manifest_shape_invalid", message: "manifest must be an upstream project-manifest object with schema_version \"1.0\"." }],
    };
  }
  if (manifest.schema_version === undefined) {
    return {
      ok: false,
      error_kind: "manifest_contract_error",
      errors: [{ code: "missing_field", message: "manifest.schema_version is required; use the upstream project-manifest.json schema, not the legacy thin manifest." }],
    };
  }
  if (manifest.schema_version !== "1.0") {
    return {
      ok: false,
      error_kind: "manifest_contract_error",
      errors: [{ code: "schema_version_invalid", message: "manifest.schema_version must be \"1.0\"." }],
    };
  }
  return null;
}

function userVisibleToolPhase(toolName: string): string | null {
  const phases: Record<string, string> = {
    query_board_profile: "Reading board profile",
    search_packages: "Finding drivers",
    get_package_context: "Reading driver docs",
    propose_manifest: "Planning wiring",
    generate_code: "Generating code",
    audit_code: "Checking code",
    install_package: "Installing packages",
    write_main_py: "Writing to device",
    flash_and_run: "Running on device",
    read_serial_until: "Reading serial output",
    read_workspace_file: "Reading workspace file",
    write_project_file: "Writing project file",
    run_validate: "Validating against schema",
    run_scaffold: "Generating project skeleton",
    run_download_drivers: "Downloading drivers",
    run_static_check: "Checking code (lint)",
    run_simulate: "Running PC simulation",
    render_wiring: "Rendering wiring diagram",
    render_diagram: "Rendering architecture diagram",
    get_phase_profile: "Reading phase profile",
    run_triage: "Running local triage",
    run_hardware_sanity: "Checking hardware",
    run_extract_pdf: "Extracting PDF",
    run_flash_device: "Flashing device",
    scan_device: "Scanning devices",
  };
  return phases[toolName] ?? null;
}

// Dev/headless default backend when no apiBaseUrl/MPYHW_API_BASE is provided. The
// extension panel always passes a resolved URL (see extension/api-base-url.ts); this
// is the single localhost fallback shared by direct core/CLI callers.
export const DEV_API_BASE_URL = "http://127.0.0.1:8787";

// Real ReAct loop: the LLM (DeepSeek, via /v1/llm/messages) drives
// intent -> package intelligence -> manifest -> audited code -> device loop ->
// serial observation -> repair, calling canonical tools we execute locally.
export function createAgentBackedLoop(deps: LoopDeps = {}) {
  const apiBaseUrl = (deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? DEV_API_BASE_URL).replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shim = deps.shim;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 90_000;
  const tools = CANONICAL_TOOLS.map((name) => ({ name }));

  // Wrap a fetch so a black-holed request (server alive, never responds) can't
  // hang the loop forever. The init still carries input.signal for real
  // cancellation; this only guarantees the promise settles.
  const fetchWithTimeout = ((url: any, init?: any) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("request_timeout")), requestTimeoutMs);
      fetchImpl(url, init).then(
        (response) => { clearTimeout(timer); resolve(response); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    })
  ) as typeof fetch;
  const llmClient = createLlmClient({ apiBaseUrl, fetchImpl: fetchWithTimeout, getAuthToken: deps.getAuthToken });
  const skillCatalog = deps.skillCatalog ?? new SkillCatalog(apiBaseUrl, fetchWithTimeout);

  return async function agentBackedLoop(input: LoopInput) {
    const onEvent = input.onEvent ?? (() => {});
    // Stop must interrupt an in-flight device/host operation immediately. Deploy,
    // flash, lint, sim, etc. run as a blocking subprocess inside the Python shim
    // (e.g. mpremote sitting on the serial port); neither the loop's between-turn
    // abort check nor the RPC timeout can cut that short, so a Stop during a deploy
    // would otherwise wait for the subprocess to finish (or time out) before taking
    // effect. On abort, kill the shim: its exit handler rejects the pending RPC at
    // once — surfacing as a runtime_error observation the loop ends as "cancelled"
    // at the top of its next iteration — and resets it for a lazy restart.
    if (input.signal && typeof (input.signal as any).addEventListener === "function" && shim && typeof shim.kill === "function") {
      (input.signal as any).addEventListener("abort", () => {
        try { shim.kill(); } catch { /* already gone */ }
      }, { once: true });
    }
    const apiClient = new ApiClient(apiBaseUrl, fetchWithTimeout);
    const boardClient = new BoardClient(apiBaseUrl, fetchWithTimeout);

    const state = input.state ?? createSessionState({ traceId: input.traceId ?? "session", intent: input.intent, boardId: input.boardId });
    state.loadedSkills ??= [];
    state.phaseProfiles ??= {};
    state.driverContexts ??= [];
    // Generated project files by path (main.py + any lib/ modules), so the device
    // deploy can push the whole set without the model re-sending file contents.
    state.files ??= {};
    state.messages.push({ role: "user", content: input.state ? input.intent : buildOpening(input) });
    if (input.state) {
      // Continuing a prior conversation: keep the history and derived hardware
      // context (board, driverContexts), but reset the per-message loop-control
      // signals. Otherwise the stale success marker / turn & repair counters from
      // the previous request would immediately terminate (or starve) this one.
      state.lastRuntimeMarker = undefined;
      state.runtimeVerified = false;
      state.turnSeq = 0;
      state.repairRound = 0;
      state.noProgressStreak = 0;
      state.textOnlyTurns = 0;
      // Re-gate deploy each new request: the board may have been unplugged
      // between turns, so a continued session must re-confirm before flashing.
      state.deployConfirmed = false;
      // A prior decline must not terminate the continued request before it starts.
      state.deployDeclined = false;
    }

    function contextsForCodegen(manifest: any) {
      const contexts = [...state.driverContexts];
      // Legacy thin manifests carry capabilities[]; rich upstream manifests carry
      // devices[] instead, so derive the digital_output signal from a GPIO/PWM
      // device — otherwise the builtin LED context is dropped on the rich path.
      const capabilities = Array.isArray(manifest?.capabilities)
        ? manifest.capabilities
        : (Array.isArray(manifest?.devices)
          ? manifest.devices.filter((d: any) => ["GPIO", "PWM"].includes(String(d?.interface ?? "").toUpperCase())).map(() => "digital_output")
          : []);
      if (capabilities.includes("digital_output") && !contexts.some((context) => context.package?.name === "machine_pin_led")) {
        contexts.push(LED_BUILTIN_CONTEXT);
      }
      return contexts;
    }

    // Forced scaffold: before the first generate_code, deterministically lay down
    // the full upstream firmware/ skeleton (init_scaffold.py via the shim) so every
    // build produces the complete project tree, not a lone main.py. Runs at most
    // once per session (state.scaffolded) — init_scaffold overwrites firmware/main.py
    // unconditionally, so re-running it would clobber already-generated code. In
    // headless/offline (no projectDir or no shim) it silently skips, so the unit
    // tests and the MPYHW_LOOP=template path are unaffected.
    async function ensureScaffold(manifest: any): Promise<{ ok: true } | { ok: false; error_kind: string; error?: string }> {
      if (state.scaffolded) return { ok: true };
      const projectDir = state.projectDir ?? deps.projectRoot;
      if (!projectDir || !shim || typeof shim.runScaffold !== "function") return { ok: true };
      // Re-write the manifest we're about to generate from, so init_scaffold reads
      // exactly this validated manifest (also covers a model that called generate_code
      // without a prior propose_manifest, which is what persists it normally).
      if (typeof deps.writeProjectFile === "function") {
        const persisted = await deps.writeProjectFile("project-manifest.json", JSON.stringify(manifest, null, 2));
        if (!persisted.ok) return { ok: false, error_kind: "scaffold_failed", error: persisted.error_kind };
      }
      try {
        await shim.runScaffold(projectDir, deriveScaffoldMode(manifest));
      } catch (error: any) {
        return { ok: false, error_kind: "scaffold_failed", error: error?.message ?? "scaffold_failed" };
      }
      state.scaffolded = true;
      const phase = userVisibleToolPhase("run_scaffold");
      if (phase) onEvent({ type: "trace", text: phase, toolName: "run_scaffold" });
      return { ok: true };
    }

    // LLM-driven codegen for any board/part combo the deterministic template
    // can't handle. A nested, tool-free /v1/llm/messages call grounded on the
    // board profile + resolved driver contexts so it isn't hardcoded to one part.
    async function generateCodeViaLlm(manifest: any, contexts: any[], targetPath = "main.py") {
      const phaseProfileText = renderPhaseProfiles(state);
      // Target-aware so multi-file projects work: main.py is the runnable entry
      // (the deploy loop watches for MPYHW_READY); any other path is an importable
      // module. The entry now lands under the scaffolded tree (firmware/main.py),
      // so both spellings carry the entry rules; other paths are modules.
      const isEntry = targetPath === "main.py" || targetPath === "firmware/main.py";
      const fileRules = isEntry
        ? "print 'MPYHW_READY' once at startup, then run a main loop that prints structured status lines; wrap the loop body in try/except."
        : "produce a focused, importable module consistent with the manifest and the entry main.py; define classes/functions only, with no top-level side effects.";
      const user =
        `You are a MicroPython hardware codegen assistant. Output ONLY the complete contents of ${targetPath} — no markdown fences, no prose.\n` +
        `Rules: import only modules on the board profile or the provided driver import_names; use the given constructors; never use __import__, exec, or eval to bypass audit; if a needed module is not available, report that constraint or ask_user instead of bypassing it; ${fileRules}\n\n` +
        (phaseProfileText ? `Sanitized phase profiles:\n${phaseProfileText}\n\n` : "") +
        `Board profile:\n${JSON.stringify(state.board ?? { board_id: manifest?.board_id ?? input.boardId })}\n\n` +
        `Resolved driver contexts:\n${JSON.stringify(contexts)}\n\n` +
        `Hardware manifest (pins already allocated):\n${JSON.stringify(manifest)}\n\n` +
        `Original hardware request: ${input.intent}`;
      const messages = [{ role: "user", content: user }];
      await input.recorder?.record({ type: "llm_request", kind: "codegen", messages, tools: [] });

      // One streamed generation. The code appears live in the activity feed (code_delta)
      // instead of landing as one finished block. A mid-stream upstream drop arrives as a
      // stream_error EVENT (not a thrown error), so it is captured explicitly — otherwise a
      // truncated stream is misread as "the model chose to emit nothing". finish_reason is
      // recorded so a "length" truncation (reasoning model exhausting its budget before any
      // answer) is diagnosable from the session log rather than an opaque empty result.
      const attempt = async () => {
        let raw = "";
        let finishReason: string | null = null;
        let streamError: string | null = null;
        for await (const event of await llmClient.streamMessages({ messages, tools: [], max_tokens: CODEGEN_MAX_TOKENS, trace_id: input.traceId }, input.signal)) {
          if (event.type === "text_delta") {
            raw += event.text;
            onEvent({ type: "code_delta", text: event.text, path: targetPath });
          } else if (event.type === "stream_error") {
            streamError = event.message ?? "stream_error";
          } else if (event.type === "message_stop") {
            finishReason = event.finishReason ?? null;
          }
        }
        return { code: stripCodeFences(raw.trim()), finishReason, streamError };
      };

      try {
        let result = await attempt();
        // Retry once only on a clean-but-empty generation. A stream_error is a transport
        // failure (its own error_kind), not something a re-prompt fixes — so don't retry it.
        if (!result.code && !result.streamError) {
          result = await attempt();
        }
        await input.recorder?.record({
          type: "llm_response", kind: "codegen", text: result.code,
          finishReason: result.finishReason, streamError: result.streamError,
        });
        // A stream error wins over any partial text: a mid-stream drop leaves a truncated,
        // unrunnable file, so it must not be persisted as a successful generation.
        if (result.streamError) return { ok: false as const, error: "codegen_upstream_unavailable" };
        if (result.code) return { ok: true as const, code: result.code };
        return { ok: false as const, error: "codegen_empty" };
      } catch {
        await input.recorder?.record({ type: "llm_error", kind: "codegen", error: "codegen_upstream_unavailable" });
        return { ok: false as const, error: "codegen_upstream_unavailable" };
      }
    }

    const executors = {
      api: async (name: string, toolInput: any) => {
        const result = await apiClient.executePackageTool(name, toolInput);
        if (name === "get_package_context" && result.ok) {
          const { ok, ...context } = result;
          state.driverContexts.push(context);
        }
        return result;
      },
      local: async (name: string, toolInput: any) => {
        if (name === "query_board_profile") {
          try {
            state.board = await boardClient.getBoardProfile(toolInput.board_id ?? input.boardId);
            return { ok: true, ...state.board };
          } catch (error: any) {
            return { ok: false, error_kind: error.code ?? "board_profile_failed" };
          }
        }
        if (name === "propose_manifest") {
          const manifest = toolInput.manifest;
          const contractError = requireRichManifest(manifest);
          if (contractError) return contractError;
          const validation = validateManifest(manifest, state.board);
          if (!validation.valid) {
            return { ok: false, error_kind: "manifest_invalid", errors: validation.errors };
          }
          // Rich upstream manifest (requireRichManifest already guaranteed
          // schema_version "1.0"): track the build phase, persist the manifest to the
          // project tree, and render wiring from the device-identity object DERIVED
          // from devices[]/pinout[] (one device = one card, no phantom).
          state.manifest = manifest;
          if (typeof manifest.phase === "string") state.phase = manifest.phase;
          // Component-confirmation gate (deterministic, once per session): when the
          // proposed manifest first carries devices[], show them as a multi-select
          // card so the user can drop parts or note missing ones before hardware
          // selection. Unchecked devices come back as a trimmed list; free-text
          // additions ride back as feedback for the agent to fold into devices[].
          const proposedDevices = Array.isArray(manifest.devices) ? manifest.devices : [];
          if (!state.componentsConfirmed && proposedDevices.length && typeof input.confirmComponents === "function") {
            const decision = await input.confirmComponents(proposedDevices);
            if (decision.action === "cancel") return { ok: false, error_kind: "user_cancelled" };
            const keptNames = Array.isArray(decision.devices) ? new Set(decision.devices.map(String)) : null;
            const removed = keptNames ? proposedDevices.filter((d: any) => !keptNames.has(String(d?.name ?? ""))) : [];
            const add = typeof decision.feedback === "string" ? decision.feedback.trim() : "";
            if (removed.length || add) {
              return { ok: false, error_kind: "components_revision_requested", removed: removed.map((d: any) => d?.name), add };
            }
            state.componentsConfirmed = true;
          }
          const wiring = deriveWiring(manifest);
          onEvent({ type: "manifest_updated", manifest: { ...manifest, wiring } });
          onEvent({ type: "diagram_updated", diagram: deriveDiagram(manifest) });
          if (typeof deps.writeProjectFile === "function") {
            const persisted = await deps.writeProjectFile("project-manifest.json", JSON.stringify(manifest, null, 2));
            if (persisted.ok) onEvent({ type: "file_written", path: persisted.path ?? "project-manifest.json" });
          }
          return { ok: true, phase: state.phase };
        }
        if (name === "generate_code") {
          const manifest = toolInput.manifest;
          const contractError = requireRichManifest(manifest);
          if (contractError) return contractError;
          const validation = validateManifest(manifest, state.board);
          if (!validation.valid) {
            return { ok: false, error_kind: "manifest_invalid", errors: validation.errors };
          }
          // Surface the manifest first so the wiring view renders as part of the
          // plan the user reviews — before any (paid) codegen runs. Also covers the
          // case where the agent skipped (or never validated) a propose_manifest call.
          onEvent({ type: "manifest_updated", manifest: { ...manifest, wiring: deriveWiring(manifest) } });
          onEvent({ type: "diagram_updated", diagram: deriveDiagram(manifest) });
          // Plan gate (deterministic, once per session): show requirements + a rough
          // credit estimate and wait for confirmation before spending on codegen.
          // Repair-loop regenerations keep planConfirmed=true and skip the prompt.
          if (!state.planConfirmed) {
            const plan = buildPlan(manifest, input.intent);
            const decision = typeof input.confirmPlan === "function"
              ? await input.confirmPlan(plan)
              : { action: "confirm" as const };
            if (decision.action === "cancel") return { ok: false, error_kind: "user_cancelled" };
            // Revise: hand the user's feedback back to the model and keep the gate
            // closed (planConfirmed stays false), so it re-plans and the host shows
            // the plan again. Not a runtime_error, so it doesn't count as a repair.
            if (decision.action === "revise") {
              return { ok: false, error_kind: "plan_revision_requested", feedback: decision.feedback };
            }
            state.planConfirmed = true;
          }
          // Lay down the full firmware/ skeleton before the first codegen so every
          // build produces the complete upstream project tree. Once per session; a
          // failure blocks codegen so it surfaces instead of silently degrading to a
          // lone main.py. Headless/offline skips inside ensureScaffold.
          const scaffold = await ensureScaffold(manifest);
          if (!scaffold.ok) return scaffold;
          // One path: grounded LLM generation for every part. No per-sensor
          // special-casing. (The deterministic template lives only in the
          // offline MPYHW_LOOP=template pipeline.)
          // Default into the scaffolded tree so the code fills firmware/main.py
          // (and deploy ships the whole tree); an explicit target_path still wins.
          const targetPath = toolInput.target_path ?? "firmware/main.py";
          const contexts = contextsForCodegen(manifest);
          const generated = await generateCodeViaLlm(manifest, contexts, targetPath);
          if (!generated.ok) return { ok: false, error_kind: "codegen_failed", error: generated.error };
          state.files[targetPath] = generated.code;
          onEvent({ type: "code_updated", code: generated.code, path: targetPath });
          // Persist through the same allowProjectTree channel as write_project_file
          // so the firmware tree lands on disk DURING the loop (not via the narrow
          // post-loop batch, which rejects firmware/ paths). A rejected target_path
          // surfaces immediately so the agent corrects it in-loop.
          if (typeof deps.writeProjectFile === "function") {
            const persisted = await deps.writeProjectFile(targetPath, generated.code);
            if (!persisted.ok) return { ok: false, error_kind: persisted.error_kind ?? "write_failed", path: targetPath };
            onEvent({ type: "file_written", path: persisted.path ?? targetPath });
          }
          return { ok: true, path: targetPath, code: generated.code };
        }
        if (name === "audit_code") {
          if (!state.board) {
            return { ok: false, error_kind: "audit_unavailable", message: "board profile not loaded" };
          }
          const auditPath = toolInput.path ?? "firmware/main.py";
          const auditContent = typeof state.files?.[auditPath] === "string" ? state.files[auditPath] : toolInput.content;
          const audit = auditCode(auditContent, { board: state.board, driverContexts: contextsForCodegen({ capabilities: ["digital_output"] }) });
          return audit.ok ? { ok: true } : { ok: false, error_kind: "audit_failed", disallowed_imports: audit.disallowed_imports };
        }
        if (name === "get_phase_profile") {
          const phase = String(toolInput.phase ?? "");
          if (state.phaseProfiles[phase]) {
            return { ok: true, phase, loaded: true, noop: true, profile: state.phaseProfiles[phase] };
          }
          const profile = await skillCatalog.fetchPhaseProfile(phase);
          if (profile == null) return { ok: false, error_kind: "phase_profile_not_found" };
          state.phaseProfiles[phase] = profile;
          return { ok: true, phase, loaded: true, profile };
        }
        if (name === "read_workspace_file") {
          // The host (extension) owns the read + path containment to the workspace
          // root; the loop just forwards the requested path. Absent in headless/test.
          if (typeof deps.readWorkspaceFile !== "function") {
            return { ok: false, error_kind: "workspace_unavailable" };
          }
          return await deps.readWorkspaceFile(String(toolInput.path ?? ""));
        }
        if (name === "write_project_file") {
          // The host owns the write + path containment / allowed-path set; the loop
          // forwards the path + content. Absent in headless/test. On success also
          // mirror the file into state.files so the device-deploy step can push it
          // (parity with generate_code's accumulation).
          if (typeof deps.writeProjectFile !== "function") {
            return { ok: false, error_kind: "workspace_unavailable" };
          }
          const filePath = String(toolInput.path ?? "");
          const content = String(toolInput.content ?? "");
          const result = await deps.writeProjectFile(filePath, content);
          if (result.ok) {
            state.files[filePath] = content;
            onEvent({ type: "file_written", path: result.path ?? filePath });
            // Writing the architecture diagram feeds the webview Diagram tab. Parse
            // best-effort; a malformed JSON just doesn't update the tab.
            if (filePath.endsWith("diagram.json")) {
              try { onEvent({ type: "diagram_updated", diagram: JSON.parse(content) }); } catch { /* ignore */ }
            }
          }
          return result;
        }
        return { ok: false, error_kind: "UnknownToolError" };
      },
      shim: async (name: string, toolInput: any) => {
        if (!shim) {
          return { ok: false, error_kind: "device_unavailable", message: "no device connected" };
        }
        try {
          if (name === "scan_device") {
            return { ok: true, ports: await shim.scan() };
          }
          if (name === "install_package") {
            await shim.installPackage(toolInput.package_json_url);
            return { ok: true };
          }
          if (name === "write_main_py") {
            // Rich multi-file flow: a firmware/ project tree was assembled on disk
            // (by scaffold/download_drivers + generate_code/write_project_file). Deploy
            // the WHOLE tree to the device root (mirror `mpremote fs cp -r firmware/ :/`)
            // so boot.py/board.py/conf.py + downloaded drivers — which never enter
            // state.files — ship too, and firmware/lib/x.py lands at /lib/x.py (so a
            // bare `import x` resolves). The on-disk tree, not state.files, is the truth.
            const projectDir = state.projectDir ?? deps.projectRoot;
            const hasFirmwareTree = Object.keys(state.files ?? {}).some((key) => key.startsWith("firmware/"));
            if (projectDir && hasFirmwareTree && typeof shim.deployFirmwareTree === "function") {
              try {
                await shim.deployFirmwareTree(projectDir);
                return { ok: true };
              } catch (error: any) {
                // No tree on disk after all (e.g. a stub shim in a headless run): fall
                // through to the legacy single-file path. Any other failure is real.
                if (error?.message !== "firmware_dir_missing") {
                  return { ok: false, error_kind: error?.message ?? "deploy_failed" };
                }
              }
            }
            // Legacy single-file flow: no firmware tree, just write the generated
            // main.py to the device as /main.py.
            const mainContent = state.files?.["main.py"] ?? state.files?.["firmware/main.py"];
            if (typeof mainContent !== "string") {
              return { ok: false, error_kind: "generated_main_missing" };
            }
            await shim.writeMainPy(mainContent);
            return { ok: true };
          }
          if (name === "flash_and_run") {
            await shim.flashAndRun(toolInput.path ?? "main.py");
            return { ok: true };
          }
          if (name === "read_serial_until") {
            // Fallback only when the model omits markers (the schema requires them).
            // MPYHW_READY is the one boot line every generated main.py prints, so it
            // is board/sensor-agnostic; the old "TEMP_C=" default timed out (and thus
            // failed) any working non-temperature build that fell back to it.
            const markers = toolInput.markers ?? ["MPYHW_READY"];
            const result = await shim.serialReadUntil(markers);
            const lines = Array.isArray(result) ? result : result.lines ?? [];
            onEvent({ type: "serial_output", lines });
            // A read that completes but never sees the markers (device timeout /
            // wrong output) is a runtime failure, not a success. Surface it as a
            // runtime_error so the repair loop counts it and can exhaust.
            if (Array.isArray(result) ? false : result.ok === false) {
              return { ok: false, error_kind: "runtime_error", error: result.error ?? "serial_read_timeout", lines };
            }
            return { ok: true, lines };
          }
          // Upstream toolchain scripts (host-side, no device): validate the
          // manifest/wiring/diagram against the canonical schema, generate the
          // firmware skeleton, download drivers. All operate on the project dir.
          if (name === "render_wiring") {
            const projectDir = state.projectDir ?? deps.projectRoot;
            if (!projectDir) return { ok: false, error_kind: "project_dir_unavailable" };
            return { ok: true, output: (await shim.renderWiring(projectDir, toolInput.format ?? "md")).output };
          }
          if (name === "render_diagram") {
            const projectDir = state.projectDir ?? deps.projectRoot;
            if (!projectDir) return { ok: false, error_kind: "project_dir_unavailable" };
            return { ok: true, output: (await shim.renderDiagram(projectDir, toolInput.format ?? "md")).output };
          }
          if (name === "run_validate" || name === "run_scaffold" || name === "run_download_drivers" || name === "run_static_check" || name === "run_simulate" || name === "run_triage" || name === "run_hardware_sanity" || name === "run_extract_pdf" || name === "run_flash_device") {
            const projectDir = state.projectDir ?? deps.projectRoot;
            if (!projectDir) return { ok: false, error_kind: "project_dir_unavailable" };
            if (name === "run_validate") {
              // A failed validation is a normal result the agent acts on, not an
              // error: return ok with the validity flag + schema messages.
              const r = await shim.runValidate(projectDir, toolInput.path ?? "project-manifest.json", toolInput.schema ?? "project-manifest");
              return { ok: true, valid: r.valid, exit_code: r.exitCode, output: r.output };
            }
            if (name === "run_scaffold") {
              const output = (await shim.runScaffold(projectDir, toolInput.mode ?? "timer")).output;
              // The model scaffolded explicitly — mark it so the forced ensureScaffold
              // before generate_code doesn't run init_scaffold a second time.
              state.scaffolded = true;
              return { ok: true, output };
            }
            if (name === "run_download_drivers") {
              return { ok: true, output: (await shim.runDownloadDrivers(projectDir)).output };
            }
            if (name === "run_static_check") {
              // Lint result is informational (the agent fixes and re-runs), not a
              // transport error: ok with the clean flag + flake8/pylint output.
              const r = await shim.runStaticCheck(projectDir, toolInput.target ?? "firmware");
              return { ok: true, clean: r.clean, flake8: r.flake8, pylint: r.pylint };
            }
            if (name === "run_simulate") {
              const sim = await shim.runSimulate(projectDir, toolInput.target ?? "test/pc");
              return { ok: true, passed: sim.passed, no_tests: sim.noTests, exit_code: sim.exitCode, output: sim.output };
            }
            if (name === "run_triage") {
              return { ok: true, ...(await shim.runTriage(projectDir, toolInput.path ?? toolInput.target ?? "firmware")) };
            }
            if (name === "run_hardware_sanity") {
              return { ok: true, ...(await shim.runHardwareSanity(projectDir)) };
            }
            if (name === "run_extract_pdf") {
              return { ok: true, ...(await shim.runExtractPdf(projectDir, toolInput.path, toolInput.output_path)) };
            }
            const generatedEntryPath =
              typeof state.files?.["main.py"] === "string" ? "main.py"
                : typeof state.files?.["firmware/main.py"] === "string" ? "firmware/main.py"
                  : "firmware/main.py";
            return { ok: true, ...(await shim.runFlashDevice(projectDir, toolInput.path ?? generatedEntryPath)) };
          }
          return { ok: false, error_kind: "UnknownToolError" };
        } catch (error: any) {
          return { ok: false, error_kind: "runtime_error", message: error?.message ?? "shim_error" };
        }
      },
      ui: async (name: string, toolInput: any) => {
        if (name === "ask_user") {
          if (isComponentListAsk(toolInput) && typeof input.confirmComponents === "function" && !state.componentsConfirmed) {
            const options = Array.isArray(toolInput.options) ? toolInput.options : [];
            const proposedDevices = options.map((option: any) => ({ name: String(option) }));
            const decision = await input.confirmComponents(proposedDevices);
            if (decision.action === "cancel") return { ok: false, error_kind: "user_cancelled" };
            const keptNames = Array.isArray(decision.devices) ? new Set(decision.devices.map(String)) : null;
            const removed = keptNames ? proposedDevices.filter((d: any) => !keptNames.has(String(d.name))) : [];
            const add = typeof decision.feedback === "string" ? decision.feedback.trim() : "";
            if (removed.length || add) {
              return { ok: false, error_kind: "components_revision_requested", removed: removed.map((d: any) => d.name), add };
            }
            // Once-per-session, mirroring the propose_manifest gate, so a model that
            // keeps asking doesn't re-render the multi-select card every turn.
            state.componentsConfirmed = true;
            return { ok: true, answer: `Component list confirmed: ${proposedDevices.map((d: any) => d.name).join(", ")}` };
          }
          // Wired to the webview when an askUser callback is provided; the loop
          // pauses here until the user answers. Falls back to a null answer for
          // headless contexts (tests / no UI).
          if (typeof input.askUser === "function") {
            const answer = await input.askUser(toolInput.question, toolInput.options, toolInput.options_requiring_text, toolInput.text_placeholder);
            return answer == null
              ? { ok: true, answer: null, note: "ask_user_unanswered" }
              : { ok: true, answer };
          }
          return { ok: true, answer: null, note: "ask_user_not_interactive" };
        }
        return { ok: false, error_kind: "UnknownToolError" };
      },
    };

    const sseClient = async () => {
      // Append-only: the durable history IS the request. Nothing is prepended,
      // re-rendered, reordered, or stubbed on re-send, so the leading bytes stay
      // byte-identical across rounds and DeepSeek's prefix cache keeps hitting.
      const messages = state.messages;
      // trace_id stays top-level (NOT inside messages): the server consumes it for
      // llm_turns attribution before provider dispatch, so DeepSeek's prefix cache —
      // which keys on the leading message bytes — is unaffected.
      const body = { messages, tools, trace_id: input.traceId };
      await input.recorder?.record({ type: "llm_request", kind: "agent", messages: cloneJson(messages), tools: cloneJson(tools) });
      return llmClient.streamMessages(body, input.signal);
    };

    const dispatch = async (tool: any) => {
      // One-shot deploy-readiness checkpoint before the first device-touching
      // tool: the host scans for the board and shows the wiring diagram for
      // confirmation. Once confirmed, the rest of the deploy sequence
      // (install -> write -> flash -> read) runs without further prompts.
      if (DEPLOY_TOOLS.has(tool.name) && !state.deployConfirmed) {
        const approved = typeof input.confirmDeploy === "function" ? await input.confirmDeploy() : true;
        if (!approved) {
          // A deliberate decline (or no board): the build is done bar flashing. Mark
          // it so the loop ends cleanly as "generated" next iteration instead of the
          // model thrashing on retries (user_cancelled is neutral, so the old path
          // ground to manifest_unresolved). Still return the observation so the
          // tool_result is recorded.
          state.deployDeclined = true;
          return { ok: false, error_kind: "user_cancelled" };
        }
        state.deployConfirmed = true;
      }
      return dispatchTool(tool, executors);
    };

    // Stream the model's prose live, but only the FINAL reply is meant to survive.
    // A turn that ends in a tool call was mid-process narration (chain-of-thought):
    // its streamed text is discarded the moment the tool fires, leaving only the
    // neutral "Working…" ping. A turn that hands back with no tool keeps its
    // streamed card, finalized as the summary below.
    let streamedThisTurn = false;
    const result = await runAgentLoop({
      state,
      sseClient,
      signal: input.signal,
      dispatchTool: dispatch,
      recorder: input.recorder,
      onEvent: (event: any) => {
        if (event.type === "text_delta") {
          streamedThisTurn = true;
          onEvent({ type: "summary_delta", text: event.text });
        } else if (event.type === "tool_use_complete") {
          // This turn isn't the final reply, but prose streamed before the tool
          // call is treated differently by tool: ask_user's lead-in is the
          // user-facing preamble to a question, so SEAL it (it survives above the
          // prompt card); every other tool's prose was mid-process narration, so
          // discard it. Then surface the compact progress ping with the tool name
          // so the host can show a curated, localized phase label (e.g.
          // "Generating code…") — never the model's raw reasoning (that streams as
          // thinking_delta and never reaches the summary card at all).
          if (streamedThisTurn) {
            onEvent({ type: event.name === "ask_user" ? "summary_seal" : "summary_discard" });
            streamedThisTurn = false;
          }
          const phase = userVisibleToolPhase(event.name);
          if (phase) onEvent({ type: "trace", text: phase, toolName: event.name });
        } else if (event.type === "message_stop") {
          streamedThisTurn = false;
        } else if (event.type === "credits") {
          onEvent({ kind: "credits", balance: event.remaining, dailyGrant: event.dailyGrant, resetsAt: event.resetsAt });
        }
      },
    });
    // When the model hands the turn back with no tool call, its final plain-text
    // reply is the one assistant prose worth showing. It already streamed in live
    // above; this summary finalizes that card (plain text -> rendered markdown).
    if (result.terminal === "awaiting_user") {
      const summary = lastAssistantText(state.messages);
      if (summary) onEvent({ type: "summary", text: summary });
    }
    return { terminal: result.terminal, state };
  };
}

function isComponentListAsk(toolInput: any): boolean {
  const question = String(toolInput?.question ?? "").toLowerCase();
  const options = Array.isArray(toolInput?.options) ? toolInput.options : [];
  if (options.length < 2) return false;
  return /器件清单|元件清单|部件清单|物料清单|零件清单|\bbom\b|bill of materials|component list|parts list|device list/.test(question);
}

function renderPhaseProfiles(state: any): string {
  return Object.values(state.phaseProfiles ?? {})
    .map((profile: any) => JSON.stringify(profile))
    .join("\n");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// Text of the final assistant turn (the handoff reply). Used only when the loop
// ends with awaiting_user, where the last message is that assistant turn.
function lastAssistantText(messages: any[]): string {
  const last = messages?.[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return "";
  return last.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
}
