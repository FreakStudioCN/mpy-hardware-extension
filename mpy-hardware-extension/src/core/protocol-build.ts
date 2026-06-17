// Panel-facing factory: builds the protocol client loop with real host adapters
// (device shim, workspace fs, host script runner) and returns the controller-shaped
// `loop(input)` the SessionController invokes. Replaces createAgentBackedLoop.
import { createLlmClient } from "./llm-client.ts";
import { runProtocolBuild, type ProtocolDeps } from "./protocol-loop.ts";

type BuildDeps = {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  shim?: any;
  requestTimeoutMs?: number;
  getAuthToken?: () => Promise<string | undefined>;
  readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>;
  writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; error_kind?: string }>;
  projectRoot?: string;
};

const DEFAULT_API = "http://127.0.0.1:8787";

export function createProtocolLoop(deps: BuildDeps = {}) {
  const apiBaseUrl = deps.apiBaseUrl ?? DEFAULT_API;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 90_000;
  // Mirror agent-backed-loop's black-hole guard: a server that accepts but never
  // responds rejects as request_timeout (retryable) instead of hanging forever.
  const fetchWithTimeout: typeof fetch = (url: any, init: any = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("request_timeout")), requestTimeoutMs);
    // Abort on EITHER the timeout OR the caller's signal (user cancel). Using the
    // caller's signal directly would make the timeout a no-op, so forward it.
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
  const llmClient = createLlmClient({ apiBaseUrl, fetchImpl: fetchWithTimeout, getAuthToken: deps.getAuthToken });
  const shim = deps.shim;
  const projectDir = deps.projectRoot;

  // device_command(action) -> mpremote shim. Best-effort mapping; the device path is
  // exercised against real hardware (the e2e harness mocks it).
  const device = async (action: string, payload: any) => {
    if (!shim) return { ok: false, error_kind: "device_unavailable" };
    try {
      if (action === "devs" || action === "scan") return { ok: true, stdout: (await shim.scan()).join(",") };
      if (action === "cp") { if (projectDir && shim.deployFirmwareTree) await shim.deployFirmwareTree(projectDir); return { ok: true }; }
      if (action === "soft_reset" || action === "run") { if (shim.flashAndRun) await shim.flashAndRun(payload?.code ?? "firmware/main.py"); return { ok: true }; }
      if (action === "stream" || action === "read") {
        const r = await shim.serialReadUntil(payload?.markers ?? ["MPYHW_READY"]);
        const lines = Array.isArray(r) ? r : (r.lines ?? []);
        const ok = Array.isArray(r) ? true : r.ok !== false;
        return ok ? { ok: true, stdout: lines.join("\n") } : { ok: false, error_kind: "runtime_error", stdout: lines.join("\n") };
      }
      if (action === "exec") {
        const code = String(payload?.code ?? "");
        const m = code.match(/mip\.install\(['"]([^'"]+)['"]/);
        if (m && shim.installPackage) { await shim.installPackage(m[1]); return { ok: true }; }
        return { ok: true, stdout: "" };
      }
      // cp_from / mkdir / ls / rm: the serve.py shim has no generic primitive for these
      // yet — report honestly so the model adapts instead of believing it succeeded.
      return { ok: false, error_kind: "device_action_unsupported", stderr: action };
    } catch (error: any) {
      return { ok: false, error_kind: "runtime_error", stderr: error?.message ?? "device_error" };
    }
  };

  // script_run(script) -> host toolchain scripts. The phase recipes discourage most
  // scripts, so this is a thin best-effort bridge.
  const runScript = async (_interpreter: string, script: string, args: string[]) => {
    if (!shim || !projectDir) return { ok: true, stdout: "", exit_code: 0 };
    try {
      if (/validate/.test(script)) { const r = await shim.runValidate(projectDir, args[0]); return { ok: true, stdout: r.output, exit_code: r.exitCode }; }
      if (/scaffold/.test(script)) { const r = await shim.runScaffold(projectDir); return { ok: true, stdout: r.output, exit_code: 0 }; }
      if (/wiring/.test(script) && shim.renderWiring) { const r = await shim.renderWiring(projectDir, "md"); return { ok: true, stdout: r.output, exit_code: 0 }; }
      if (/diagram/.test(script) && shim.renderDiagram) { const r = await shim.renderDiagram(projectDir, "md"); return { ok: true, stdout: r.output, exit_code: 0 }; }
      if (/flake8|pylint|static/.test(script)) { const r = await shim.runStaticCheck(projectDir); return { ok: r.clean, stdout: JSON.stringify(r.flake8 ?? r), exit_code: r.clean ? 0 : 1 }; }
      if (/pytest|simulate/.test(script)) { const r = await shim.runSimulate(projectDir); return { ok: r.passed, stdout: r.output, exit_code: r.exitCode }; }
      return { ok: true, stdout: "", exit_code: 0 };
    } catch (error: any) {
      return { ok: false, stderr: error?.message ?? "script_error", exit_code: 1 };
    }
  };

  const protocolDeps: ProtocolDeps = {
    llmClient,
    device,
    runScript,
    writeFile: deps.writeProjectFile,
    readFile: deps.readWorkspaceFile,
    listFiles: async () => ({ ok: true, entries: [] }),
  };

  // The controller-shaped loop. Maps its input to the protocol input and the
  // protocol result back to the controller's { terminal, state } contract.
  return async (input: any) => {
    // retry() re-enters with an empty intent; resume with the saved one so the phase
    // conversation isn't an empty user turn (which DeepSeek can 400 on).
    const intent = input.intent || input.state?.intent || "";
    const result = await runProtocolBuild(
      {
        intent,
        boardId: input.boardId,
        traceId: input.traceId,
        signal: input.signal,
        onEvent: input.onEvent,
        confirmApproval: input.confirmApproval,
        startPhase: input.state?.phase,
        startManifest: input.state?.manifest,
      },
      protocolDeps,
    );
    const terminal = result.terminal === "complete" ? "complete"
      : result.terminal === "cancelled" ? "cancelled"
      : result.terminal === "failed" ? "failed"
      : "awaiting_user";
    return { terminal, state: { manifest: result.manifest, phase: result.phases.at(-1)?.phase, intent } };
  };
}
