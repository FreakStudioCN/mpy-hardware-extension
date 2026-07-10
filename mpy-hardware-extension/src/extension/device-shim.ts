import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { ShimProcess } from "./shim-process.ts";
import { normalizeGeneratedArtifactPath } from "./workspace-writer.ts";

// Adapter the agent loop's `shim` expects (scan / installPackage / writeMainPy /
// flashAndRun / serialReadUntil), implemented over a JSON-RPC `request` to the
// Python shim. Pure and unit-testable: inject `rpc` + `ensure`. Resolves and
// caches the device port via device.scan so the loop never has to pass one.
export class DeviceShim {
  private port: string | null = null;
  private rpc: (method: string, params: any) => Promise<any>;
  private ensure: () => Promise<void>;

  constructor(
    rpc: (method: string, params: any) => Promise<any>,
    ensure: () => Promise<void> = async () => {},
  ) {
    this.rpc = rpc;
    this.ensure = ensure;
  }

  setPort(port: string | null) {
    this.port = port;
  }

  async scan(): Promise<string[]> {
    await this.ensure();
    const r = await this.rpc("device.scan", {});
    return (r?.devices ?? []).map((d: any) => d.port).filter(Boolean);
  }

  // True only if the given port answers a live MicroPython REPL. `scan` lists serial
  // ports (an unflashed board still shows up), so the doctor probes the scanned port
  // to tell "no board" apart from "board with no MicroPython". Takes an explicit port
  // (the caller already scanned) — it never re-scans or gates on a port choice.
  async probeMicroPython(port: string): Promise<boolean> {
    await this.ensure();
    const r = await this.rpc("device.probe_micropython", { port });
    return !!r?.has_micropython;
  }

  private async ensurePort(): Promise<string> {
    await this.ensure();
    if (this.port) return this.port;
    const r = await this.rpc("device.scan", {});
    const ports = (r?.devices ?? []).map((d: any) => d.port).filter(Boolean);
    if (ports.length === 0) throw new Error("device_unavailable");
    if (ports.length > 1) throw new Error("device_selection_required");
    this.port = ports[0];
    return ports[0];
  }

  async installPackage(url: string, version?: string): Promise<void> {
    const port = await this.ensurePort();
    // version is the manifest's pinned package version, used by the shim to build the
    // China-reachable upypi mirror URL for a GraftSense driver (never hardcoded).
    const r = await this.rpc("device.install_package", { url, version, port });
    if (r?.status !== "ok") {
      // Keep the raw shim message ("could not resolve host …") alongside the category,
      // so the failure reaches the repair loop / telemetry / UI as a real reason rather
      // than a bare "network" — the difference between diagnosable and a blank dead-end.
      const kind = r?.error_kind ?? "install_failed";
      throw new Error(r?.message ? `${kind}: ${r.message}` : kind);
    }
  }

  async writeMainPy(content: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.write_main_py", { code: content, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "write_failed");
  }

  // Write a generated project file to an arbitrary device path (mirroring its
  // workspace-relative path); the shim creates parent dirs. Used to deploy lib/
  // modules and the firmware/ tree (drivers/tasks) of a multi-file project
  // alongside main.py. Non-code artifacts (manifests, docs, PC tests) are rejected.
  async writeDeviceFile(path: string, content: string): Promise<void> {
    const port = await this.ensurePort();
    const safePath = normalizeGeneratedArtifactPath(path, { allowMain: false, allowManifest: false, allowLib: true, allowFirmware: true });
    if (!safePath) throw new Error("invalid_generated_path");
    const r = await this.rpc("device.write_device_file", { path: safePath, code: content, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "write_failed");
  }

  async flashAndRun(_path?: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.flash_and_run", { port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "flash_failed");
  }

  // Deploy the on-disk <projectDir>/firmware/ tree to the device ROOT (mirror
  // `mpremote fs cp -r firmware/ :/`): firmware/lib/x.py -> /lib/x.py, boot.py ->
  // /boot.py, main.py last. The python side walks the real disk tree (never a
  // model-supplied path), so no path normalization is needed here — containment was
  // enforced at write time by writeProjectFile.
  async deployFirmwareTree(projectDir: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.deploy_firmware_tree", { project_dir: projectDir, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "deploy_failed");
  }

  async serialReadUntil(markers: string[]): Promise<{ ok: boolean; lines: string[] }> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.serial_read_until", { port, markers });
    return { ok: r?.ok ?? r?.status === "ok", lines: r?.lines ?? [] };
  }

  // ---- Device filesystem (#6 bridge): generic ls / rm / mkdir / cp-from-device ----
  // A non-ok RPC throws its error_kind so the protocol device() surfaces a real failure
  // (never a faked ok). The deterministic deploy still goes through deployFirmwareTree.

  async listDir(dir?: string): Promise<string[]> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.list_files", { port, path: dir });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "ls_failed");
    return r.files ?? [];
  }

  async removePath(path: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.fs_remove", { port, path });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "rm_failed");
  }

  async makeDir(path: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.fs_mkdir", { port, path });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "mkdir_failed");
  }

  async copyFromDevice(remotePath: string, localPath: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.copy_from", { port, remote_path: remotePath, local_path: localPath });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "cp_from_failed");
  }

  // ---- Upstream toolchain scripts (run on the host via the shim's venv) ----
  // No device/port needed; just ensure the shim process + venv are up.

  // Validate a project file against a vendored upstream schema (validate_json.py).
  // The host joins projectDir + relPath. A non-zero exit is a normal "invalid"
  // result, not a thrown error: returns { valid, output, exitCode } so the caller
  // can surface the schema messages.
  async runValidate(projectDir: string, relPath = "project-manifest.json", schema: "project-manifest" | "wiring" | "diagram" = "project-manifest"): Promise<{ valid: boolean; output: string; exitCode: number }> {
    await this.ensure();
    const r = await this.rpc("script.run_validate", { project_dir: projectDir, path: relPath, schema });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "validate_failed");
    return { valid: !!r.valid, output: r.output ?? "", exitCode: r.exit_code ?? 1 };
  }

  // Generate the firmware/ skeleton into projectDir (init_scaffold.py). Writes
  // host files directly; throws the script's error_kind on a non-zero exit.
  async runScaffold(projectDir: string, mode: "timer" | "async" | "thread" = "timer"): Promise<{ output: string }> {
    await this.ensure();
    const r = await this.rpc("script.run_scaffold", { project_dir: projectDir, mode });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "scaffold_failed");
    return { output: r.output ?? "" };
  }

  // V0 generic plugin-script runner. Resolves+runs a bundled `-plugin` script (or a
  // shell command, e.g. generate's git commit) on the host via the venv. Returns the
  // shim result verbatim: a non-zero gate is a real result (success:false), and a
  // script_not_found is a transport error (status:"error") — neither is ever faked.
  async runV0Script(params: { interpreter: string; script: string; args: string[]; project_dir: string; stdin_content?: string; stdin_json?: any; timeout_ms?: number }): Promise<{ status: string; success?: boolean; exit_code?: number; stdout?: string; stderr?: string; result_json?: any; error_kind?: string; message?: string }> {
    await this.ensure();
    return this.rpc("script.run_v0", params);
  }

  // Download device drivers into projectDir/firmware/lib (download_drivers.py).
  async runDownloadDrivers(projectDir: string): Promise<{ output: string }> {
    await this.ensure();
    const r = await this.rpc("script.run_download_drivers", { project_dir: projectDir });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "download_failed");
    return { output: r.output ?? "" };
  }

  // Static-check the project: flake8 (gate) + pylint (advisory). `clean` keys on
  // flake8; both outputs return so the caller can surface/fix issues.
  async runStaticCheck(projectDir: string, target = "firmware"): Promise<{ clean: boolean; flake8: any; pylint: any }> {
    await this.ensure();
    const r = await this.rpc("script.run_static_check", { project_dir: projectDir, target });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "static_check_failed");
    return { clean: !!r.clean, flake8: r.flake8, pylint: r.pylint };
  }

  // Run the PC-side unit tests (pytest test/pc) on CPython — no device needed.
  async runSimulate(projectDir: string, target = "test/pc"): Promise<{ passed: boolean; noTests: boolean; output: string; exitCode: number }> {
    await this.ensure();
    const r = await this.rpc("script.run_simulate", { project_dir: projectDir, target });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "simulate_failed");
    return { passed: !!r.passed, noTests: !!r.no_tests, output: r.output ?? "", exitCode: r.exit_code ?? 1 };
  }

  // Render docs/<kind>.json -> Mermaid .md via the upstream renderer (default "md",
  // offline). The agent authors the JSON; this produces the shareable diagram.
  async renderWiring(projectDir: string, format = "md"): Promise<{ output: string }> {
    await this.ensure();
    const r = await this.rpc("script.render_wiring", { project_dir: projectDir, format });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "render_failed");
    return { output: r.output ?? "" };
  }

  async renderDiagram(projectDir: string, format = "md"): Promise<{ output: string }> {
    await this.ensure();
    const r = await this.rpc("script.render_diagram", { project_dir: projectDir, format });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "render_failed");
    return { output: r.output ?? "" };
  }

  async runTriage(projectDir: string, target = "firmware"): Promise<{ exit_code: number; summary: string; logs: string[]; artifacts: string[] }> {
    await this.ensure();
    const r = await this.rpc("script.run_triage", { project_dir: projectDir, target });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "triage_failed");
    return { exit_code: r.exit_code ?? 1, summary: r.summary ?? "", logs: r.logs ?? [], artifacts: r.artifacts ?? [] };
  }

  async runHardwareSanity(projectDir: string): Promise<{ exit_code: number; summary: string; observations: string[] }> {
    await this.ensure();
    const r = await this.rpc("script.run_hardware_sanity", { project_dir: projectDir });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "hardware_sanity_failed");
    return { exit_code: r.exit_code ?? 1, summary: r.summary ?? "", observations: r.observations ?? [] };
  }

  async runExtractPdf(projectDir: string, path: string, outputPath?: string): Promise<{ exit_code: number; pages: any[]; output_path?: string }> {
    await this.ensure();
    const r = await this.rpc("script.run_extract_pdf", { project_dir: projectDir, path, output_path: outputPath });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "extract_pdf_failed");
    return { exit_code: r.exit_code ?? 1, pages: r.pages ?? [], output_path: r.output_path };
  }

  async runFlashDevice(projectDir: string, path = "firmware/main.py"): Promise<{ exit_code: number; summary: string }> {
    const port = await this.ensurePort();
    const r = await this.rpc("script.run_flash_device", { project_dir: projectDir, path, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "flash_failed");
    return { exit_code: r.exit_code ?? 1, summary: r.summary ?? "" };
  }
}

// Take down a detached child AND everything it spawned. The flash plugin runs esptool as a
// deep descendant (serve.py -> plugin script -> esptool in its own venv); a plain child.kill()
// signals only serve.py, orphaning an in-flight flash that then runs to completion. Because
// the shim is spawned detached (its own group), a NEGATIVE pid signals the whole group;
// Windows has no such groups, so taskkill /T walks the tree. Falls back to child.kill().
// Exported so the group-kill behavior is testable against a real process tree.
export function killProcessTree(child: { pid?: number; kill: (signal?: any) => void } | null | undefined) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]); }
    catch { try { child.kill(); } catch { /* already gone */ } }
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

// Lifecycle around a spawned shim child: lazy single-flight start, RPC routing, and the
// kill/respawn state machine. Extracted from createDeviceShim (which supplies the real
// python/venv spawner) so the kill-vs-exit-handler races are unit-testable with fake
// children. Two invariants the tests lock:
//   1. kill() clears proc/child/starting SYNCHRONOUSLY (and rejects pending RPCs itself) —
//      waiting for the child's async "exit" event would let a reset-then-restart hand the
//      new session the dying process, whose first RPC then spuriously fails.
//   2. Every child handler is guarded by instance (thisChild/thisProc): after kill(), a NEW
//      shim may already be running when the OLD child's late "exit" event finally fires —
//      an unguarded handler would wipe the new shim's state and orphan it.
export function createShimLifecycle(spawnShim: () => any): DeviceShim {
  let proc: ShimProcess | null = null;
  let child: any = null;
  // Lazy single-flight start. runStart() runs start() at most once concurrently AND clears
  // its slot when start() rejects, so a pre-spawn failure (python_not_found, venv/dependency
  // install) is retried on the next touch instead of poisoning this long-lived shim with a
  // memoized rejection until the window reloads. reset() lets the exit handler force a fresh
  // start after the child crashes post-spawn (where start() already resolved).
  const runStart = singleFlight(start);

  async function ensure(): Promise<void> {
    if (proc) return;
    return runStart();
  }

  async function start(): Promise<void> {
    const thisChild = spawnShim();
    const thisProc = new ShimProcess({ write: (line: string) => thisChild.stdin.write(line) });
    child = thisChild;
    proc = thisProc;
    // Feed handlers bind to THIS child's proc, never the module-level slot: after a kill,
    // a late chunk from the dying child must not reach a newly spawned shim's parser.
    thisChild.stdout.on("data", (data: Buffer) => thisProc.feed(data.toString()));
    thisChild.stderr.on("data", (data: Buffer) => thisProc.handleStderr(data.toString()));
    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      thisChild.once("spawn", () => {
        spawned = true;
        resolve();
      });
      thisChild.once("error", (error: Error) => {
        if (child === thisChild) {
          proc = null;
          child = null;
          runStart.reset();
        }
        reject(new Error(`shim_start_failed: ${error.message}`));
      });
      thisChild.on("exit", (code: number) => {
        // Reject THIS child's pending RPCs (no-op if kill() already did); only clear the
        // live slots if they still belong to this child — a respawn may have replaced them.
        thisProc.handleExit(code ?? -1);
        if (child === thisChild) {
          proc = null;
          child = null;
          runStart.reset();
        }
        if (!spawned) reject(new Error(`shim exited with code ${code ?? -1}`));
      });
    });
  }

  const shim = new DeviceShim((method, params) => {
    if (!proc) throw new Error("shim_not_started");
    return proc.request(method, params);
  }, ensure);
  // Hard-interrupt an in-flight operation (user pressed Stop / reset): kill the shim's whole
  // process group so a blocked flash/upload (esptool / mpremote) dies now instead of running
  // to completion. State is cleared HERE, synchronously — see invariant 1 above — so the
  // next device touch lazily respawns a clean shim with no race against the exit event.
  // Pending RPCs are rejected immediately for the same reason (the exit handler's
  // handleExit becomes a no-op). Same mechanism as dispose, but kept distinct: dispose is
  // teardown, kill is a recoverable mid-session stop.
  const killTree = () => {
    const dyingChild = child;
    const dyingProc = proc;
    proc = null;
    child = null;
    runStart.reset();
    killProcessTree(dyingChild);
    dyingProc?.handleExit(-1);
  };
  (shim as any).dispose = killTree;
  (shim as any).kill = killTree;
  return shim;
}

// Spawn the Python shim and wire a DeviceShim to it. Everything is lazy: Python
// discovery, venv creation, and the process spawn only happen the first time the
// loop actually touches a device.
export function createDeviceShim(opts: { vscode: any; extensionUri: any }): DeviceShim {
  return createShimLifecycle(() => {
    const python = resolvePython(opts.vscode);
    const shimDir = join(opts.extensionUri?.fsPath ?? process.cwd(), "python", "shim");
    const venvPython = ensureVenv(python, opts.vscode, join(shimDir, "requirements.txt"));
    const venvBin = dirname(venvPython);
    const scriptPath = join(shimDir, "serve.py");
    // Put the venv's bin on PATH so serve.py's bare `mpremote` calls resolve.
    const env = { ...process.env, PATH: venvBin + delimiter + (process.env.PATH ?? "") };
    // detached: the shim leads its OWN process group, so Stop can signal the whole group
    // (serve.py + every descendant it spawns — the flash plugin's esptool, mpremote) instead
    // of just serve.py, which would orphan an in-flight flash. stdio stays piped and we keep
    // the reference (no unref), so communication + lifecycle are unchanged.
    return spawn(venvPython, [scriptPath], { stdio: ["pipe", "pipe", "pipe"], env, detached: true });
  });
}

// Single-flight lazy runner with retry-on-failure. A naive `if (!p) p = start()` memoizes
// the promise forever — but a REJECTED promise is still truthy, so a failed start would pin
// every later call to the same stale rejection. Clearing the slot when start() rejects lets
// the next call retry; reset() lets a process-exit handler force a fresh start after a crash.
export function singleFlight(start: () => Promise<void>): { (): Promise<void>; reset: () => void } {
  let pending: Promise<void> | null = null;
  const run = () => {
    if (!pending) pending = start().catch((error) => { pending = null; throw error; });
    return pending;
  };
  run.reset = () => { pending = null; };
  return run;
}

// ---- Python environment helpers ----

function resolvePython(vscode: any): string {
  const setting = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pythonPath");
  for (const candidate of [setting, "python3", "python"]) {
    if (candidate && canRun(candidate, ["--version"])) return candidate;
  }
  throw new Error("python_not_found");
}

// Non-throwing counterpart of resolvePython for the doctor: reports whether a usable
// Python is on PATH (or configured), its version banner, and the resolved command —
// instead of throwing python_not_found.
export function detectPython(vscode: any): { ok: boolean; version?: string; command?: string } {
  const setting = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pythonPath");
  for (const candidate of [setting, "python3", "python"]) {
    if (!candidate) continue;
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (r.status === 0) {
      // Older CPython prints "--version" to stderr; newer to stdout. Read both.
      const version = ((r.stdout || "") + (r.stderr || "")).trim() || undefined;
      return { ok: true, version, command: candidate };
    }
  }
  return { ok: false };
}

// Probe that ALL shim runtime deps import, not just mpremote: the venv also needs
// jsonschema/flake8/requests for the upstream toolchain scripts (validate/scaffold/
// download). A venv from an earlier version may have mpremote but not these, so
// gate the install on the full set.
const SHIM_IMPORT_PROBE = ["-c", "import mpremote, serial, jsonschema, flake8, pylint, requests, pypdf"];

function venvPaths(): { dir: string; python: string } {
  const dir = join(homedir(), ".mpyhw", "venv");
  const python = process.platform === "win32"
    ? join(dir, "Scripts", "python.exe")
    : join(dir, "bin", "python");
  return { dir, python };
}

// Non-throwing probe of the managed venv: true once it exists AND every shim runtime
// dep imports. The doctor calls this to decide whether to offer "Install dependencies".
export function venvReady(): boolean {
  const { python } = venvPaths();
  return existsSync(python) && canRun(python, SHIM_IMPORT_PROBE);
}

// Best-effort mpremote version from the managed venv (where the shim installs it) — the
// diagnostics snapshot needs it, and mpremote is rarely on the global PATH. Runs
// `<venvPython> -m mpremote --version`; undefined if the venv/mpremote is absent or fails.
// The pythonPath arg is for tests; production uses the managed venv path.
export function venvMpremoteVersion(pythonPath: string = venvPaths().python): string | undefined {
  if (!existsSync(pythonPath)) return undefined;
  try {
    const r = spawnSync(pythonPath, ["-m", "mpremote", "--version"], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0) return undefined;
    return ((r.stdout || "") + (r.stderr || "")).trim().split("\n")[0] || undefined;
  } catch {
    return undefined; // spawn failed (no python / headless)
  }
}

function ensureVenv(python: string, vscode: any, requirementsPath: string): string {
  const { dir: venvDir, python: venvPython } = venvPaths();
  if (!existsSync(venvPython)) {
    const result = spawnSync(python, ["-m", "venv", venvDir], { stdio: "ignore", timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error("python_venv_failed");
  }
  if (!canRun(venvPython, SHIM_IMPORT_PROBE)) {
    const indexUrl = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pipIndexUrl");
    const args = ["-m", "pip", "install", "--upgrade", "-r", requirementsPath];
    if (indexUrl) args.push("--index-url", indexUrl);
    const result = spawnSync(venvPython, args, { stdio: "ignore", timeout: 300_000 });
    if (result.error || result.status !== 0 || !canRun(venvPython, SHIM_IMPORT_PROBE)) {
      throw new Error("shim_dependency_install_failed");
    }
  }
  return venvPython;
}

// Async (non-blocking) installer behind the doctor's "Install dependencies" button.
// Mirrors ensureVenv but spawns instead of spawnSync — a pip install can take minutes
// and spawnSync would freeze the extension host — and returns a status error_kind
// instead of throwing. The lazy createDeviceShim path keeps its synchronous ensureVenv.
export async function installVenvAsync(opts: { vscode: any; extensionUri: any }): Promise<{ ok: boolean; errorKind?: string }> {
  const py = detectPython(opts.vscode);
  if (!py.ok || !py.command) return { ok: false, errorKind: "python_not_found" };
  const { dir: venvDir, python: venvPython } = venvPaths();
  const requirementsPath = join(opts.extensionUri?.fsPath ?? process.cwd(), "python", "shim", "requirements.txt");
  if (!existsSync(venvPython)) {
    if ((await runAsync(py.command, ["-m", "venv", venvDir], 30_000)) !== 0) {
      return { ok: false, errorKind: "python_venv_failed" };
    }
  }
  const indexUrl = opts.vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pipIndexUrl");
  const args = ["-m", "pip", "install", "--upgrade", "-r", requirementsPath];
  if (indexUrl) args.push("--index-url", indexUrl);
  if ((await runAsync(venvPython, args, 300_000)) !== 0 || !canRun(venvPython, SHIM_IMPORT_PROBE)) {
    return { ok: false, errorKind: "shim_dependency_install_failed" };
  }
  return { ok: true };
}

function runAsync(command: string, args: string[], timeout: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(-1);
    }, timeout);
    child.on("error", () => { clearTimeout(timer); resolve(-1); });
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
}

function canRun(command: string, args: string[]): boolean {
  try {
    const r = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
