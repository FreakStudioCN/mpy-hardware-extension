// Panel-facing factory: builds the protocol client loop with real host adapters
// (device shim, workspace fs, host script runner) and returns the controller-shaped
// `loop(input)` the SessionController invokes. Replaces createAgentBackedLoop.
import { resolve, sep, basename } from "node:path";

import { isRealContained, stripRedundantPathRoot } from "../extension/workspace-writer.ts";
import { createLlmClient } from "./llm-client.ts";
import { runProtocolBuild, type ProtocolDeps } from "./protocol-loop.ts";

// The Skill documents the project root as `sessions/<id>/project`, so the model prefixes
// `project/` onto everything. Writes and reads already drop that segment and resolve to the
// real root, but script ARGUMENTS were passed through verbatim, so a gate the model ran against
// its own path looked one level too deep. Measured: the plan was written four times while
// run_quality_gates.py answered GENERATE_PLAN_MISSING each time, and the phase died on
// max_turns. Correct the arguments the same way, so one spelling works everywhere.
//
// The literal path is deliberately NOT respected, even when it exists. The writer never puts a
// generated file under `project/`, so such a directory is always a product of this same
// confusion — in the measured run the model had passed `--project-dir project`, and the
// scaffold dutifully built the whole tree one level down. Honouring it would preserve the split.
const PATH_FLAG = /(dir|path|root|file|plan)$/i;

function correctedArg(projectDir: string, value: string, precedingFlag: string): string {
  const corrected = stripRedundantPathRoot(value);
  if (corrected === undefined) return value;
  // A BARE redundant root ("project") means the root itself, but it is also a plausible
  // non-path value, so correct it only as the value of a path-ish flag: `--project-dir project`.
  if (corrected === "") {
    return precedingFlag.startsWith("-") && PATH_FLAG.test(precedingFlag) ? "." : value;
  }
  return isRealContained(projectDir, resolve(projectDir, corrected)) ? corrected : value;
}

export function correctRedundantArgPaths(projectDir: string, args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (typeof arg !== "string" || !arg) return arg;
    // `--flag=value` carries both halves in one argv entry; correct only the value.
    const equals = arg.startsWith("-") ? arg.indexOf("=") : -1;
    if (equals > 0) {
      const flag = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      const fixed = correctedArg(projectDir, value, flag);
      return fixed === value ? arg : `${flag}=${fixed}`;
    }
    if (arg.startsWith("-")) return arg;
    return correctedArg(projectDir, arg, index > 0 ? String(args[index - 1] ?? "") : "");
  });
}

// cp_from pulls a device file to the HOST, so the model-supplied local destination must be
// contained to the project root — a leading slash is treated as project-relative, an empty
// dst falls back to the device basename, and anything escaping the root returns null.
export function containLocalPath(projectDir: string, dst: string, deviceSrc: string): string | null {
  // Strip the mpremote device marker before the slashes. `cp_from` names its source with a
  // leading ":" (":log/run_3.log" = /log/run_3.log ON THE BOARD), and a model that passes the
  // same string as the HOST destination used to create a directory literally called ":log".
  // Cosmetic on macOS, fatal on Windows, where ":" is not legal in a path.
  const rel = String(dst ?? "").replace(/^:+/, "").replace(/^[/\\]+/, "")
    || basename(String(deviceSrc ?? "").replace(/^:+/, ""));
  const abs = resolve(projectDir, rel);
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) return null;
  return abs;
}

type BuildDeps = {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  shim?: any;
  requestTimeoutMs?: number;
  connectRetryDelaysMs?: number[];
  getAuthToken?: () => Promise<string | undefined>;
  readWorkspaceFile?: (path: string) => Promise<{ ok: boolean; content?: string; error_kind?: string }>;
  writeProjectFile?: (path: string, content: string) => Promise<{ ok: boolean; path?: string; relative_path?: string; error_kind?: string }>;
  // Lists the project tree so the model can introspect what scaffold already wrote
  // (e.g. resume into generate). Without a real lister the model is blind and can
  // wrongly conclude the project is empty and bail to analyze.
  listFiles?: (path: string) => Promise<{ ok: boolean; entries?: string[]; error_kind?: string }>;
  // Real mkdir / delete in the project tree (host enforces containment). Generate
  // deletes firmware/tools/ before the mpy_imports gate, so these must actually
  // mutate the fs — never a no-op that fakes success.
  makeProjectDir?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
  deleteProjectPath?: (path: string) => Promise<{ ok: boolean; error_kind?: string }>;
  // Host-enforced confirms for model-issued destructive device ops (spec 07 safe-point).
  // Absent = legacy behavior (headless/e2e run without prompts), mirroring guardOverwrite/
  // guardDelete. confirmDeviceDelete gates every device rm; confirmDeviceCopyOverwrite gates a
  // cp_from only when its host destination pre-exists (the wiring supplies that check).
  confirmDeviceDelete?: (devicePath: string) => Promise<boolean>;
  confirmDeviceCopyOverwrite?: (hostPath: string) => Promise<boolean>;
  // True while a run that declared capabilities.device_command:false is in flight (the Sipeed
  // MaixPy export tool). Read per call, not per loop: the host installs it for that run only.
  // Without it the declaration is a wire claim the host does not enforce, so one hallucinated
  // device_command would still drive mpremote from a tool whose whole premise is "no device".
  denyDeviceCommands?: () => boolean;
  // The script BASENAMES such a run may execute, or null for the normal "any bundled script" rule.
  // The shim's resolver is global across bundled plugins, so without this the same run could reach
  // esp32_flash.py / firmware_download.py / the deploy scripts through script_run — the device and
  // network denial has to cover this lane too, not just the device_command one.
  allowedScripts?: () => readonly string[] | null;
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
  const baseLlmClient = createLlmClient({ apiBaseUrl, fetchImpl: fetchWithTimeout, getAuthToken: deps.getAuthToken });
  const connectRetryDelaysMs = deps.connectRetryDelaysMs ?? [500, 1000, 2000];
  const shim = deps.shim;
  const projectDir = deps.projectRoot;
  const confirmDeviceDelete = deps.confirmDeviceDelete;
  const confirmDeviceCopyOverwrite = deps.confirmDeviceCopyOverwrite;

  // device_command(action) -> mpremote shim. Best-effort mapping; the device path is
  // exercised against real hardware (the e2e harness mocks it).
  const firmwareActions = new Set(["flash_firmware", "download_firmware", "download_and_flash", "use_local_firmware", "firmware_flash"]);
  const device = async (action: string, payload: any) => {
    if (deps.denyDeviceCommands?.()) return { ok: false, error_kind: "device_command_not_permitted", stderr: action };
    if (firmwareActions.has(action)) return { ok: false, error_kind: "firmware_action_requires_script_run", stderr: action };
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
        // Surface the FULL read window (allLines), not just the matched markers — a
        // print() between markers must reach the Serial page. Array-shaped r (an old
        // test double) has no allLines; fall back to the array itself.
        const lines = Array.isArray(r) ? r : (r.lines ?? []);
        const allLines = Array.isArray(r) ? r : (r.allLines ?? lines);
        const ok = Array.isArray(r) ? true : r.ok !== false;
        return ok ? { ok: true, stdout: allLines.join("\n") } : { ok: false, error_kind: "runtime_error", stdout: allLines.join("\n") };
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
        // A device delete is always destructive: confirm before the shim call (spec 07 safe-point).
        // Confirms the whole rm target; mpremote fs rm is not recursive (serve.py), so if a future
        // -r lands, revisit for a subtree guard (recurring #5).
        if (confirmDeviceDelete && !(await confirmDeviceDelete(String(payload?.dst ?? "")))) {
          return { ok: false, error_kind: "delete_declined", stderr: String(payload?.dst ?? "") };
        }
        await shim.removePath(payload?.dst ?? ""); return { ok: true };
      }
      if (action === "mkdir") {
        if (!shim.makeDir) return { ok: false, error_kind: "device_method_absent", stderr: "mkdir" };
        await shim.makeDir(payload?.dst ?? ""); return { ok: true };
      }
      if (action === "cp_from") {
        if (!shim.copyFromDevice) return { ok: false, error_kind: "device_method_absent", stderr: "cp_from" };
        if (!projectDir) return { ok: false, error_kind: "workspace_unavailable", stderr: "cp_from" };
        const deviceSrc = String(payload?.src ?? payload?.dst ?? "");
        const localAbs = containLocalPath(projectDir, payload?.dst ?? "", deviceSrc);
        if (!localAbs) return { ok: false, error_kind: "path_outside_workspace", stderr: String(payload?.dst ?? "") };
        // cp_from writes to a HOST path: confirm an overwrite when the destination pre-exists,
        // the same guard write_project_file uses (the wiring supplies isPreExisting + exists, so
        // build output / new files are not prompted).
        if (confirmDeviceCopyOverwrite && !(await confirmDeviceCopyOverwrite(localAbs))) {
          return { ok: false, error_kind: "overwrite_declined", stderr: localAbs };
        }
        await shim.copyFromDevice(deviceSrc, localAbs);
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
  const runScript = async (interpreter: string, script: string, args: string[], extra?: { stdin_content?: string; stdin_json?: any; timeout_ms?: number; phase?: string }) => {
    const allowedScripts = deps.allowedScripts?.();
    // Compare on the basename: the model may send a bare, "scripts/"-relative, or plugin-qualified
    // name, and the shim resolves all three by basename.
    if (allowedScripts && !allowedScripts.includes(String(script).replace(/\\/g, "/").split("/").pop() ?? "")) {
      return { ok: false as const, error_kind: "script_not_permitted", stderr: script };
    }
    if (!shim || !projectDir) return { ok: false, error_kind: "host_runner_absent" as string };
    try {
      // Scripts run with cwd = the project root (serve.py ignores any model-supplied cwd), so a
      // corrected argument resolves the same way the writer resolved the file it names.
      const correctedArgs = correctRedundantArgPaths(projectDir, args);
      const res = await shim.runV0Script({ interpreter, script, args: correctedArgs, project_dir: projectDir, stdin_content: extra?.stdin_content, stdin_json: extra?.stdin_json, timeout_ms: extra?.timeout_ms, phase: extra?.phase });
      if (!res || res.status !== "ok") return { ok: false, error_kind: res?.error_kind ?? "script_error", stderr: res?.message ?? "", candidates: res?.candidates };
      // serve.py returns parsed JSON in result_json (with stdout blanked); re-serialize
      // it so the model still sees the script's output.
      const stdout = res.stdout || (res.result_json != null ? JSON.stringify(res.result_json) : "");
      // accepted_flags rides along: serve.py reads each script's own option list so the model
      // never needs a `--help` turn. This return is a FIXED field list, and that is where the
      // first two attempts at this fix died -- the shim attached the flags, and this line and
      // its twin in protocol-loop.ts each threw them away. Three layers, one value, checked one
      // boundary at a time.
      return { ok: true, stdout, stderr: res.stderr ?? "", exit_code: res.exit_code ?? 0, ...((res as any).accepted_flags ? { accepted_flags: (res as any).accepted_flags } : {}) };
    } catch (error: any) {
      return { ok: false, error_kind: "script_error", stderr: error?.message ?? "script_error" };
    }
  };

  const protocolDeps: ProtocolDeps = {
    llmClient: baseLlmClient,
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
    const llmClient = withConnectRetries(baseLlmClient, connectRetryDelaysMs, input.onEvent);
    const runDeps = { ...protocolDeps, llmClient };
    let result;
    try {
      result = await runProtocolBuild(
      {
        intent,
        boardId: input.boardId,
        traceId: input.traceId,
        signal: input.signal,
        onEvent: input.onEvent,
        onSafePoint: input.onSafePoint,
        confirmApproval: input.confirmApproval,
        startPhase: input.state?.phase,
        startManifest: input.state?.manifest,
        maxTurnsPerPhase: input.maxTurnsPerPhase,
        preferences: input.preferences,
        preSelectedBoard: input.preSelectedBoard,
      },
      runDeps,
    );
    } catch (error: any) {
      if (!isRetryableTransport(error) || input.signal?.aborted) throw error;
      return { terminal: "llm_unreachable", state: { manifest: input.state?.manifest ?? {}, phase: input.state?.phase, intent } };
    }
    const terminal = result.terminal === "complete" ? "complete"
      : result.terminal === "cancelled" ? "cancelled"
      : result.terminal === "failed" ? "failed"
      : result.terminal === "stalled" ? "stalled"
      : "awaiting_user";
    return { terminal, state: { manifest: result.manifest, phase: result.phases.at(-1)?.phase, intent } };
  };
}

function withConnectRetries(llmClient: any, delays: number[], onEvent?: (event: any) => void) {
  return {
    ...llmClient,
    streamMessages: async (body: any, signal?: any) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await llmClient.streamMessages(body, signal);
        } catch (error: any) {
          if (signal?.aborted || !isRetryableTransport(error) || attempt >= delays.length) throw error;
          onEvent?.({ type: "connect_retry", attempt: attempt + 1, maxAttempts: delays.length, detail: transportDetail(error) });
          await sleep(delays[attempt]);
        }
      }
    },
  };
}

function isRetryableTransport(error: any): boolean {
  return !!error?.retryable || String(error?.message ?? "").includes("request_timeout");
}

function transportDetail(error: any): string {
  return String(error?.message ?? error?.cause?.code ?? error?.cause?.message ?? "network_error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
