import { ApiClient } from "./api-client.ts";
import { BoardClient } from "./board-client.ts";
import { auditCode } from "./audit-code.ts";
import { validateManifest } from "./manifest-schema.ts";
import { CANONICAL_TOOLS } from "./tool-registry.ts";
import { dispatchTool } from "./tool-dispatch.ts";
import { createLlmClient } from "./llm-client.ts";
import { createSessionState } from "./session-state.ts";
import { runAgentLoop } from "./agent-loop.ts";

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

// Mutating, device-touching tools require user confirmation before running.
const CONFIRM_TOOLS = new Set(["install_package", "write_main_py", "flash_and_run"]);

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
};

type LoopInput = {
  intent: string;
  boardId: string;
  traceId?: string;
  state?: any;
  recorder?: { record(event: Record<string, any>): Promise<void> };
  onEvent?: (event: any) => void;
  confirmTool?: (tool: any) => Promise<boolean>;
  askUser?: (question: string, options?: string[]) => Promise<string | null>;
  // Build-plan gate: the host shows the requirements + credit estimate and resolves
  // true to proceed with codegen, false to cancel. Undefined (headless/test) = proceed.
  confirmPlan?: (plan: BuildPlan) => Promise<boolean>;
  signal?: AbortSignal;
  availableBoards?: Array<{ board_id: string; display_name?: string }>;
};

// Opening turn: requirement-first. Make the agent confirm WHAT to build before
// picking hardware; then handle the board (use the chosen one / auto-adopt the
// only one / recommend-and-confirm among several). Every clarification goes
// through the ask_user tool so the user gets a real, answerable prompt.
function buildOpening(input: LoopInput): string {
  const boards = input.availableBoards ?? [];
  const boardKnown = input.boardId && input.boardId !== "auto";
  const parts = [
    input.intent,
    "",
    "[First make sure you understand the request. If the goal or the core behaviour is unclear, or it could be built more than one way, call the ask_user tool to clarify what device to build and what it should do BEFORE selecting hardware or generating code. Always ask via the ask_user tool, never as plain assistant text.]",
  ];
  if (boardKnown) {
    parts.push(`[Target board already selected by the user: ${input.boardId}. Use this board and pass this board_id to query_board_profile. Do NOT ask the user which board to use.]`);
  } else if (boards.length === 1) {
    parts.push(`[Only one board is currently supported: ${boards[0].board_id}. Use it (pass this board_id to query_board_profile) and briefly tell the user which board you are targeting; do not make them choose.]`);
  } else if (boards.length > 1) {
    const list = boards.map((b) => `${b.board_id}${b.display_name ? ` (${b.display_name})` : ""}`).join(", ");
    parts.push(`[The user has NOT chosen a board. Supported boards: ${list}. Once the requirement is clear, recommend the single most suitable board and briefly say why, then call ask_user to confirm before continuing. Use the confirmed board_id for query_board_profile and codegen.]`);
  }
  return parts.join("\n");
}

// LLMs often wrap code in ```python fences despite instructions; unwrap them.
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

export type BuildPlan = {
  intent: string;
  boardId?: string;
  capabilities: string[];
  packages: string[];
  wiring: Array<{ role: string; pin: string }>;
  logic: Record<string, any>;
  estimate: number;
};

// Rough, deterministic credit estimate for the build (codegen + audit + deploy).
// The exact token count is unknown before generation, so this is a ballpark the
// user can sanity-check at the plan gate: a base for codegen+audit plus one per
// driver package. 1 credit = 10k tokens.
export function estimateCredits(manifest: any): number {
  const packages = Array.isArray(manifest?.packages) ? manifest.packages.length : 0;
  return 2 + packages;
}

// Human-readable build plan derived deterministically from the manifest + intent.
// Drives the host's plan card; no LLM call.
function buildPlan(manifest: any, intent: string): BuildPlan {
  return {
    intent,
    boardId: manifest?.board_id,
    capabilities: manifest?.capabilities ?? [],
    packages: (manifest?.packages ?? []).map((p: any) => (typeof p === "string" ? p : p?.name)).filter(Boolean),
    wiring: Array.isArray(manifest?.wiring) ? manifest.wiring : [],
    logic: manifest?.logic ?? {},
    estimate: estimateCredits(manifest),
  };
}

// Real ReAct loop: the LLM (DeepSeek, via /v1/llm/messages) drives
// intent -> package intelligence -> manifest -> audited code -> device loop ->
// serial observation -> repair, calling canonical tools we execute locally.
export function createAgentBackedLoop(deps: LoopDeps = {}) {
  const apiBaseUrl = (deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
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

  return async function agentBackedLoop(input: LoopInput) {
    const onEvent = input.onEvent ?? (() => {});
    const apiClient = new ApiClient(apiBaseUrl, fetchWithTimeout);
    const boardClient = new BoardClient(apiBaseUrl, fetchWithTimeout);

    const state = input.state ?? createSessionState({ traceId: input.traceId ?? "session", intent: input.intent, boardId: input.boardId });
    state.messages.push({ role: "user", content: input.state ? input.intent : buildOpening(input) });
    if (input.state) {
      // Continuing a prior conversation: keep the history and derived hardware
      // context (board, driverContexts), but reset the per-message loop-control
      // signals. Otherwise the stale success marker / turn & repair counters from
      // the previous request would immediately terminate (or starve) this one.
      state.lastRuntimeMarker = undefined;
      state.turnSeq = 0;
      state.repairRound = 0;
      state.textOnlyTurns = 0;
    }

    function contextsForCodegen(manifest: any) {
      const contexts = [...state.driverContexts];
      const capabilities = manifest?.capabilities ?? [];
      if (capabilities.includes("digital_output") && !contexts.some((context) => context.package?.name === "machine_pin_led")) {
        contexts.push(LED_BUILTIN_CONTEXT);
      }
      return contexts;
    }

    // LLM-driven codegen for any board/part combo the deterministic template
    // can't handle. A nested, tool-free /v1/llm/messages call grounded on the
    // board profile + resolved driver contexts so it isn't hardcoded to one part.
    async function generateCodeViaLlm(manifest: any, contexts: any[]) {
      const user =
        "You are a MicroPython hardware codegen assistant. Output ONLY a complete main.py — no markdown fences, no prose.\n" +
        "Rules: import only modules on the board profile or the provided driver import_names; use the given constructors; " +
        "print 'MPYHW_READY' once at startup, then run a main loop that prints structured status lines; wrap the loop body in try/except.\n\n" +
        `Board profile:\n${JSON.stringify(state.board ?? { board_id: manifest?.board_id ?? input.boardId })}\n\n` +
        `Resolved driver contexts:\n${JSON.stringify(contexts)}\n\n` +
        `Hardware manifest (pins already allocated):\n${JSON.stringify(manifest)}\n\n` +
        `Original hardware request: ${input.intent}`;
      const messages = [{ role: "user", content: user }];
      await input.recorder?.record({ type: "llm_request", kind: "codegen", messages, tools: [] });
      try {
        const code = stripCodeFences((await llmClient.collectText({ messages, tools: [] }, input.signal)).trim());
        await input.recorder?.record({ type: "llm_response", kind: "codegen", text: code });
        return code ? { ok: true as const, code } : { ok: false as const, error: "codegen_empty" };
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
          const validation = validateManifest(toolInput.manifest, state.board);
          if (!validation.valid) {
            return { ok: false, error_kind: "manifest_invalid", errors: validation.errors };
          }
          onEvent({ type: "manifest_updated", manifest: toolInput.manifest });
          return { ok: true, manifest: toolInput.manifest };
        }
        if (name === "generate_code") {
          // Surface the manifest first so the wiring view renders as part of the
          // plan the user reviews — before any (paid) codegen runs. Also covers the
          // case where the agent skipped (or never validated) a propose_manifest call.
          onEvent({ type: "manifest_updated", manifest: toolInput.manifest });
          // Plan gate (deterministic, once per session): show requirements + a rough
          // credit estimate and wait for confirmation before spending on codegen.
          // Repair-loop regenerations keep planConfirmed=true and skip the prompt.
          if (!state.planConfirmed) {
            const plan = buildPlan(toolInput.manifest, input.intent);
            const approved = typeof input.confirmPlan === "function" ? await input.confirmPlan(plan) : true;
            if (!approved) return { ok: false, error_kind: "user_cancelled" };
            state.planConfirmed = true;
          }
          // One path: grounded LLM generation for every part. No per-sensor
          // special-casing. (The deterministic template lives only in the
          // offline MPYHW_LOOP=template pipeline.)
          const contexts = contextsForCodegen(toolInput.manifest);
          const generated = await generateCodeViaLlm(toolInput.manifest, contexts);
          if (!generated.ok) return { ok: false, error_kind: "codegen_failed", error: generated.error };
          onEvent({ type: "code_updated", code: generated.code });
          return { ok: true, path: toolInput.target_path ?? "main.py", code: generated.code };
        }
        if (name === "audit_code") {
          if (!state.board) {
            return { ok: false, error_kind: "audit_unavailable", message: "board profile not loaded" };
          }
          const audit = auditCode(toolInput.content, { board: state.board, driverContexts: contextsForCodegen({ capabilities: ["digital_output"] }) });
          return audit.ok ? { ok: true } : { ok: false, error_kind: "audit_failed", disallowed_imports: audit.disallowed_imports };
        }
        if (name === "load_skill") {
          try {
            const response = await fetchWithTimeout(`${apiBaseUrl}/v1/skills/${encodeURIComponent(toolInput.skill)}`);
            if (!response.ok) {
              return { ok: false, error_kind: "skill_not_found" };
            }
            return { ok: true, skill: toolInput.skill, body: await response.text() };
          } catch {
            return { ok: false, error_kind: "upstream_unavailable" };
          }
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
            await shim.writeMainPy(toolInput.content);
            return { ok: true };
          }
          if (name === "flash_and_run") {
            await shim.flashAndRun(toolInput.path ?? "main.py");
            return { ok: true };
          }
          if (name === "read_serial_until") {
            const markers = toolInput.markers ?? ["MPYHW_READY", "TEMP_C="];
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
          return { ok: false, error_kind: "UnknownToolError" };
        } catch (error: any) {
          return { ok: false, error_kind: "runtime_error", message: error?.message ?? "shim_error" };
        }
      },
      ui: async (name: string, toolInput: any) => {
        if (name === "ask_user") {
          onEvent({ type: "trace", text: `ask_user: ${toolInput.question}` });
          // Wired to the webview when an askUser callback is provided; the loop
          // pauses here until the user answers. Falls back to a null answer for
          // headless contexts (tests / no UI).
          if (typeof input.askUser === "function") {
            const answer = await input.askUser(toolInput.question, toolInput.options);
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
      const body = { messages: state.messages, tools };
      await input.recorder?.record({ type: "llm_request", kind: "agent", messages: cloneJson(state.messages), tools: cloneJson(tools) });
      return llmClient.streamMessages(body, input.signal);
    };

    const dispatch = async (tool: any) => {
      if (CONFIRM_TOOLS.has(tool.name) && input.confirmTool) {
        const allowed = await input.confirmTool(tool);
        if (!allowed) {
          return { ok: false, error_kind: "user_cancelled" };
        }
      }
      return dispatchTool(tool, executors);
    };

    onEvent({ type: "trace", text: `Agent session started: ${input.intent}` });
    const result = await runAgentLoop({
      state,
      sseClient,
      signal: input.signal,
      dispatchTool: dispatch,
      recorder: input.recorder,
      onEvent: (event: any) => {
        if (event.type === "text_delta" && event.text.trim()) {
          onEvent({ type: "trace", text: event.text });
        } else if (event.type === "tool_use_complete") {
          onEvent({ type: "trace", text: `→ ${event.name}` });
        } else if (event.type === "credits") {
          onEvent({ kind: "credits", balance: event.remaining, dailyGrant: event.dailyGrant, resetsAt: event.resetsAt });
        }
      },
    });
    onEvent({ type: "trace", text: `Agent session finished: ${result.terminal}` });
    return { terminal: result.terminal, state };
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
