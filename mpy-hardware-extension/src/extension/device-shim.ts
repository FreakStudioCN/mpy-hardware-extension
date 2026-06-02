import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { ShimProcess } from "./shim-process.ts";

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
    const first = (r?.devices ?? [])[0]?.port;
    if (!first) throw new Error("device_unavailable");
    this.port = first;
    return first;
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
    const venvPython = ensureVenv(python, opts.vscode);
    const venvBin = dirname(venvPython);
    const scriptPath = join(opts.extensionUri?.fsPath ?? process.cwd(), "python", "shim", "serve.py");
    // Put the venv's bin on PATH so serve.py's bare `mpremote` calls resolve.
    const env = { ...process.env, PATH: venvBin + delimiter + (process.env.PATH ?? "") };
    child = spawn(venvPython, [scriptPath], { stdio: ["pipe", "pipe", "pipe"], env });
    proc = new ShimProcess({ write: (line: string) => child.stdin.write(line) });

    let buffer = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) {
          try {
            proc!.handleStdoutLine(line);
          } catch {
            // ignore non-JSON noise on stdout
          }
        }
      }
    });
    child.stderr.on("data", (data: Buffer) => proc!.handleStderr(data.toString()));
    child.on("exit", (code: number) => {
      proc!.handleExit(code ?? -1);
      proc = null;
      child = null;
      starting = null;
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

function ensureVenv(python: string, vscode: any): string {
  const venvDir = join(homedir(), ".mpyhw", "venv");
  const venvPython = process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
  if (!existsSync(venvPython)) {
    spawnSync(python, ["-m", "venv", venvDir], { stdio: "ignore" });
  }
  if (!canRun(venvPython, ["-m", "mpremote", "version"])) {
    const indexUrl = vscode?.workspace?.getConfiguration?.("mpyhw")?.get?.("pipIndexUrl");
    const args = ["-m", "pip", "install", "--upgrade", "mpremote", "pyserial"];
    if (indexUrl) args.push("--index-url", indexUrl);
    spawnSync(venvPython, args, { stdio: "ignore" });
  }
  return venvPython;
}

function canRun(command: string, args: string[]): boolean {
  try {
    const r = spawnSync(command, args, { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}
