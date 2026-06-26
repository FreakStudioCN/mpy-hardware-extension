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
  // Lists the project tree so the model can introspect what scaffold already wrote
  // (e.g. resume into generate). Without a real lister the model is blind and can
  // wrongly conclude the project is empty and bail to analyze.
  listFiles?: (path: string) => Promise<{ ok: boolean; entries?: string[]; error_kind?: string }>;
  // Real mkdir / delete in the project tree (host enforces containment). Generate
  // deletes firmware/tools/ before the mpy_imports gate, so these must actually
  // mutate the fs — never a no-op that fakes success.
  makeProjectDir?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
  deleteProjectPath?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
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
      // cp / soft_reset / run need a real shim primitive. If it's absent we CANNOT do
      // the action — report it honestly instead of returning ok:true for work that
      // never happened (the model then adapts rather than trusting a phantom success).
      if (action === "cp") {
        if (!projectDir || !shim.deployFirmwareTree) return { ok: false, error_kind: "device_method_absent", stderr: "cp" };
        await shim.deployFirmwareTree(projectDir); return { ok: true };
      }
      if (action === "soft_reset" || action === "run") {
        if (!shim.flashAndRun) return { ok: false, error_kind: "device_method_absent", stderr: action };
        await shim.flashAndRun(payload?.code ?? "firmware/main.py"); return { ok: true };
      }
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
        // The shim has no generic REPL-exec primitive — never pretend arbitrary device
        // code ran. Only mip.install is wired; anything else is an honest failure.
        return { ok: false, error_kind: "device_exec_unsupported", stderr: code.slice(0, 80) };
      }
      // Generic device filesystem ops (#6 bridge) wired to the serve.py mpremote fs RPCs.
      // Protocol payload fields are src/dst (protocol_messages.json): dst is the device
      // path for ls/rm/mkdir; cp_from copies device src -> local dst.
      if (action === "ls") {
        if (!shim.listDir) return { ok: false, error_kind: "device_method_absent", stderr: "ls" };
        return { ok: true, stdout: (await shim.listDir(payload?.dst)).join("\n") };
      }
      if (action === "rm") {
        if (!shim.removePath) return { ok: false, error_kind: "device_method_absent", stderr: "rm" };
        await shim.removePath(payload?.dst ?? ""); return { ok: true };
      }
      if (action === "mkdir") {
        if (!shim.makeDir) return { ok: false, error_kind: "device_method_absent", stderr: "mkdir" };
        await shim.makeDir(payload?.dst ?? ""); return { ok: true };
      }
      if (action === "cp_from") {
        if (!shim.copyFromDevice) return { ok: false, error_kind: "device_method_absent", stderr: "cp_from" };
        await shim.copyFromDevice(payload?.src ?? payload?.dst ?? "", payload?.dst ?? "");
        return { ok: true };
      }
      // Any other action: report honestly so the model adapts instead of believing it succeeded.
      return { ok: false, error_kind: "device_action_unsupported", stderr: action };
    } catch (error: any) {
      return { ok: false, error_kind: "runtime_error", stderr: error?.message ?? "device_error" };
    }
  };

  // script_run -> the V0 generic plugin-script runner on the host. The V0 design moves
  // the deterministic work into the vendored `-plugin` scripts (init_manifest.py,
  // init_scaffold.py, the check_*.py gates, run_quality_gates.py, ...) + shell (git
  // commit), so we run the model's named script for real. A missing runner or an
  // unresolvable script is a HARD failure (ok:false) — never a faked ok:true.
  const runScript = async (interpreter: string, script: string, args: string[], extra?: { stdin_content?: string; stdin_json?: any; timeout_ms?: number }) => {
    if (!shim || !projectDir) return { ok: false, error_kind: "host_runner_absent" as string };
    try {
      const res = await shim.runV0Script({ interpreter, script, args, project_dir: projectDir, stdin_content: extra?.stdin_content, stdin_json: extra?.stdin_json, timeout_ms: extra?.timeout_ms });
      if (!res || res.status !== "ok") return { ok: false, error_kind: res?.error_kind ?? "script_error", stderr: res?.message ?? "", candidates: res?.candidates };
      // serve.py returns parsed JSON in result_json (with stdout blanked); re-serialize
      // it so the model still sees the script's output.
      const stdout = res.stdout || (res.result_json != null ? JSON.stringify(res.result_json) : "");
      return { ok: true, stdout, stderr: res.stderr ?? "", exit_code: res.exit_code ?? 0 };
    } catch (error: any) {
      return { ok: false, error_kind: "script_error", stderr: error?.message ?? "script_error" };
    }
  };

  const protocolDeps: ProtocolDeps = {
    llmClient,
    device,
    runScript,
    writeFile: deps.writeProjectFile,
    readFile: deps.readWorkspaceFile,
    // No fake empty-lister fallback: a missing lister must surface as
    // workspace_unavailable (see execFileOperation), not a fabricated empty project.
    listFiles: deps.listFiles,
    makeDir: deps.makeProjectDir,
    deletePath: deps.deleteProjectPath,
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
        maxTurnsPerPhase: input.maxTurnsPerPhase,
        preferences: input.preferences,
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
