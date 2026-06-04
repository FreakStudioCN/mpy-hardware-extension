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

  async installPackage(url: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.install_package", { url, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "install_failed");
  }

  async writeMainPy(content: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.write_main_py", { code: content, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "write_failed");
  }

  // Write a generated project file to an arbitrary device path (mirroring its
  // workspace-relative path); the shim creates parent dirs. Used to deploy lib/
  // modules of a multi-file project alongside main.py.
  async writeDeviceFile(path: string, content: string): Promise<void> {
    const port = await this.ensurePort();
    const safePath = normalizeGeneratedArtifactPath(path, { allowMain: false, allowManifest: false, allowLib: true });
    if (!safePath) throw new Error("invalid_generated_path");
    const r = await this.rpc("device.write_device_file", { path: safePath, code: content, port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "write_failed");
  }

  async flashAndRun(_path?: string): Promise<void> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.flash_and_run", { port });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "flash_failed");
  }

  async serialReadUntil(markers: string[]): Promise<{ ok: boolean; lines: string[] }> {
    const port = await this.ensurePort();
    const r = await this.rpc("device.serial_read_until", { port, markers });
    return { ok: r?.ok ?? r?.status === "ok", lines: r?.lines ?? [] };
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

  // Download device drivers into projectDir/firmware/lib (download_drivers.py).
  async runDownloadDrivers(projectDir: string): Promise<{ output: string }> {
    await this.ensure();
    const r = await this.rpc("script.run_download_drivers", { project_dir: projectDir });
    if (r?.status !== "ok") throw new Error(r?.error_kind ?? "download_failed");
    return { output: r.output ?? "" };
  }
}

// Spawn the Python shim and wire a DeviceShim to it. Everything is lazy: Python
// discovery, venv creation, and the process spawn only happen the first time the
// loop actually touches a device.
export function createDeviceShim(opts: { vscode: any; extensionUri: any }): DeviceShim {
  let proc: ShimProcess | null = null;
  let child: any = null;
  let starting: Promise<void> | null = null;

  async function ensure(): Promise<void> {
    if (proc) return;
    if (!starting) starting = start();
    return starting;
  }

  async function start(): Promise<void> {
    const python = resolvePython(opts.vscode);
    const shimDir = join(opts.extensionUri?.fsPath ?? process.cwd(), "python", "shim");
    const venvPython = ensureVenv(python, opts.vscode, join(shimDir, "requirements.txt"));
    const venvBin = dirname(venvPython);
    const scriptPath = join(shimDir, "serve.py");
    // Put the venv's bin on PATH so serve.py's bare `mpremote` calls resolve.
    const env = { ...process.env, PATH: venvBin + delimiter + (process.env.PATH ?? "") };
    child = spawn(venvPython, [scriptPath], { stdio: ["pipe", "pipe", "pipe"], env });
    proc = new ShimProcess({ write: (line: string) => child.stdin.write(line) });

    child.stdout.on("data", (data: Buffer) => proc!.feed(data.toString()));
    child.stderr.on("data", (data: Buffer) => proc!.handleStderr(data.toString()));
    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
      child.once("error", (error: Error) => {
        proc = null;
        child = null;
        starting = null;
        reject(new Error(`shim_start_failed: ${error.message}`));
      });
      child.on("exit", (code: number) => {
        proc?.handleExit(code ?? -1);
        proc = null;
        child = null;
        starting = null;
        if (!spawned) reject(new Error(`shim exited with code ${code ?? -1}`));
      });
    });
  }

  const shim = new DeviceShim((method, params) => {
    if (!proc) throw new Error("shim_not_started");
    return proc.request(method, params);
  }, ensure);
  (shim as any).dispose = () => {
    try {
      child?.kill();
    } catch {
      // already gone
    }
  };
  return shim;
}

// ---- Python environment helpers ----

function resolvePython(vscode: any): string {
  const setting = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pythonPath");
  for (const candidate of [setting, "python3", "python"]) {
    if (candidate && canRun(candidate, ["--version"])) return candidate;
  }
  throw new Error("python_not_found");
}

// Probe that ALL shim runtime deps import, not just mpremote: the venv also needs
// jsonschema/flake8/requests for the upstream toolchain scripts (validate/scaffold/
// download). A venv from an earlier version may have mpremote but not these, so
// gate the install on the full set.
const SHIM_IMPORT_PROBE = ["-c", "import mpremote, serial, jsonschema, flake8, requests"];

function ensureVenv(python: string, vscode: any, requirementsPath: string): string {
  const venvDir = join(homedir(), ".mpyhw", "venv");
  const venvPython = process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
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

function canRun(command: string, args: string[]): boolean {
  try {
    const r = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
