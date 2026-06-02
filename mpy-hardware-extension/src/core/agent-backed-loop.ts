import { ApiClient } from "./api-client.ts";
import { BoardClient } from "./board-client.ts";
import { auditCode } from "./audit-code.ts";
import { validateManifest } from "./manifest-schema.ts";
import { CANONICAL_TOOLS } from "./tool-registry.ts";
import { dispatchTool } from "./tool-dispatch.ts";
import { parseSseEvents } from "./sse-client.ts";
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
};

type LoopInput = {
  intent: string;
  boardId: string;
  traceId?: string;
  onEvent?: (event: any) => void;
  confirmTool?: (tool: any) => Promise<boolean>;
  askUser?: (question: string) => Promise<string | null>;
  signal?: { aborted: boolean };
  availableBoards?: Array<{ board_id: string; display_name?: string }>;
};

// Opening turn: tell the agent whether the board is already chosen (use it, don't
// ask) or unchosen (recommend one from the catalog, then confirm via ask_user).
// This is what makes the agent recommend hardware instead of blindly asking.
function buildOpening(input: LoopInput): string {
  const boardKnown = input.boardId && input.boardId !== "auto";
  if (boardKnown) {
    return `${input.intent}\n\n[Target board already selected by the user: ${input.boardId}. Use this board and pass this board_id to query_board_profile. Do NOT ask the user which board to use.]`;
  }
  if (input.availableBoards?.length) {
    const list = input.availableBoards.map((b) => `${b.board_id}${b.display_name ? ` (${b.display_name})` : ""}`).join(", ");
    return `${input.intent}\n\n[The user has NOT chosen a board. Supported boards: ${list}. Recommend the single most suitable board for this request and briefly say why, then call ask_user to confirm before continuing. Use the confirmed board_id for query_board_profile and codegen.]`;
  }
  return input.intent;
}

// LLMs often wrap code in ```python fences despite instructions; unwrap them.
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

// Real ReAct loop: the LLM (DeepSeek, via /v1/llm/messages) drives
// intent -> package intelligence -> manifest -> audited code -> device loop ->
// serial observation -> repair, calling canonical tools we execute locally.
export function createAgentBackedLoop(deps: LoopDeps = {}) {
  const apiBaseUrl = (deps.apiBaseUrl ?? process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shim = deps.shim;
  const tools = CANONICAL_TOOLS.map((name) => ({ name }));

  return async function agentBackedLoop(input: LoopInput) {
    const onEvent = input.onEvent ?? (() => {});
    const apiClient = new ApiClient(apiBaseUrl, fetchImpl);
    const boardClient = new BoardClient(apiBaseUrl, fetchImpl);

    const state = createSessionState({ traceId: input.traceId ?? "session", intent: input.intent, boardId: input.boardId });
    state.messages.push({ role: "user", content: buildOpening(input) });

    let board: any;
    const driverContexts: any[] = [];

    function contextsForCodegen(manifest: any) {
      const contexts = [...driverContexts];
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
        `Board profile:\n${JSON.stringify(board ?? { board_id: manifest?.board_id ?? input.boardId })}\n\n` +
        `Resolved driver contexts:\n${JSON.stringify(contexts)}\n\n` +
        `Hardware manifest (pins already allocated):\n${JSON.stringify(manifest)}\n\n` +
        `Original hardware request: ${input.intent}`;
      let response: any;
      try {
        response = await fetchImpl(`${apiBaseUrl}/v1/llm/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: user }], tools: [] }),
          signal: input.signal,
        });
      } catch {
        return { ok: false as const, error: "codegen_upstream_unavailable" };
      }
      if (!response.ok) return { ok: false as const, error: "codegen_upstream_error" };
      let code = "";
      for (const ev of parseSseEvents(await response.text())) {
        if (ev.type === "text_delta") code += ev.text;
      }
      code = stripCodeFences(code).trim();
      return code ? { ok: true as const, code } : { ok: false as const, error: "codegen_empty" };
    }

    const executors = {
      api: async (name: string, toolInput: any) => {
        const result = await apiClient.executePackageTool(name, toolInput);
        if (name === "get_package_context" && result.ok) {
          const { ok, ...context } = result;
          driverContexts.push(context);
        }
        return result;
      },
      local: async (name: string, toolInput: any) => {
        if (name === "query_board_profile") {
          try {
            board = await boardClient.getBoardProfile(toolInput.board_id ?? input.boardId);
            return { ok: true, ...board };
          } catch (error: any) {
            return { ok: false, error_kind: error.code ?? "board_profile_failed" };
          }
        }
        if (name === "propose_manifest") {
          const validation = validateManifest(toolInput.manifest, board);
          if (!validation.valid) {
            return { ok: false, error_kind: "manifest_invalid", errors: validation.errors };
          }
          onEvent({ type: "manifest_updated", manifest: toolInput.manifest });
          return { ok: true, manifest: toolInput.manifest };
        }
        if (name === "generate_code") {
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
          if (!board) {
            return { ok: false, error_kind: "audit_unavailable", message: "board profile not loaded" };
          }
          const audit = auditCode(toolInput.content, { board, driverContexts: contextsForCodegen({ capabilities: ["digital_output"] }) });
          return audit.ok ? { ok: true } : { ok: false, error_kind: "audit_failed", disallowed_imports: audit.disallowed_imports };
        }
        if (name === "load_skill") {
          try {
            const response = await fetchImpl(`${apiBaseUrl}/v1/skills/${encodeURIComponent(toolInput.skill)}`);
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
            const answer = await input.askUser(toolInput.question);
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
      const response = await fetchImpl(`${apiBaseUrl}/v1/llm/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: state.messages, tools }),
        signal: input.signal,
      });
      if (!response.ok) {
        let detail = "llm_upstream_error";
        try {
          const body = await response.json();
          detail = body?.detail?.error ?? body?.error ?? detail;
        } catch {
          // non-JSON error body; keep generic detail
        }
        throw new Error(detail);
      }
      return parseSseEvents(await response.text());
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
      onEvent: (event: any) => {
        if (event.type === "text_delta" && event.text.trim()) {
          onEvent({ type: "trace", text: event.text });
        } else if (event.type === "tool_use_complete") {
          onEvent({ type: "trace", text: `→ ${event.name}` });
        }
      },
    });
    onEvent({ type: "trace", text: `Agent session finished: ${result.terminal}` });
    return { terminal: result.terminal, state };
  };
}
