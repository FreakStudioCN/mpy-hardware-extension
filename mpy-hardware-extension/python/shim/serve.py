import json
import os
import platform
import subprocess
import sys
import tempfile
import time


def parse_scan_output(output: str) -> list[str]:
    ports: list[str] = []
    for line in output.splitlines():
        first = line.split(maxsplit=1)[0] if line.split() else ""
        # COM* (Windows), /dev/tty* (Linux ttyUSB/ttyACM + macOS tty.*),
        # /dev/cu.* (macOS callout device mpremote sometimes lists).
        if first.startswith(("COM", "/dev/tty", "/dev/cu.")):
            ports.append(first)
    return ports


def map_install_error(stderr: str) -> str:
    text = stderr.lower()
    if "no such package" in text or "not found" in text:
        return "package_not_found"
    if "network" in text or "timed out" in text:
        return "network"
    if "busy" in text:
        return "port_busy"
    if "incompatible" in text or "chip" in text:
        return "incompatible_chip"
    return "mpremote_error"


# ---------- upstream toolchain scripts (vendored MicroPython_Skills submodule) ----------
# The scripts/schemas live in the repo-root submodule. In a packaged VSIX they are
# bundled under <ext>/third_party; in dev they sit at <repo>/third_party (one level
# above <ext>). Probe both relative to this file (<ext>/python/shim/serve.py).
SCHEMA_FILES = {
    "project-manifest": "upy-project-gen-toolchain-spec/project-manifest.schema.json",
    "wiring": "upy-project-gen-toolchain-spec/wiring.schema.json",
    "diagram": "upy-project-gen-toolchain-spec/diagram.schema.json",
}
SCRIPT_FILES = {
    "validate": "upy-project-gen-toolchain-spec/scripts/validate_json.py",
    "scaffold": "upy-scaffold/scripts/init_scaffold.py",
    "download_drivers": "upy-generate/scripts/download_drivers.py",
}


def scripts_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "..", "third_party", "MicroPython_Skills"),       # packaged: <ext>/third_party
        os.path.join(here, "..", "..", "..", "third_party", "MicroPython_Skills"),  # dev: <repo>/third_party
    ]
    for candidate in candidates:
        if os.path.isdir(candidate):
            return os.path.abspath(candidate)
    return os.path.abspath(candidates[0])


def resolve_script(name: str) -> str:
    return os.path.join(scripts_root(), SCRIPT_FILES[name])


def resolve_schema(name: str):
    rel = SCHEMA_FILES.get(name)
    return os.path.join(scripts_root(), rel) if rel else None


class Shim:
    def __init__(self, runner=None, serial_factory=None):
        self.runner = runner or subprocess.run
        self.serial_factory = serial_factory
        self.commands: list[list[str]] = []

    def scan(self):
        result = self._run(["mpremote", "connect", "list"])
        return parse_scan_output(result.stdout)

    def install_package(self, port: str, package_json_url: str):
        self._run(["mpremote", "connect", port, "resume", "fs", "mkdir", ":/lib"])
        result = self._run(["mpremote", "connect", port, "resume", "mip", "install", package_json_url], timeout=120)
        if result.returncode != 0:
            return {"ok": False, "error": map_install_error(result.stderr)}
        return {"ok": True}

    def write_main_py(self, port: str, local_main_py: str):
        return self._run(["mpremote", "connect", port, "resume", "fs", "cp", local_main_py, ":main.py"])

    def write_device_file(self, port: str, remote_path: str, local_path: str):
        # Create parent dirs on the device (fs mkdir is not recursive and errors if
        # the dir exists; mkdir each segment best-effort and ignore those failures),
        # then copy the file to its mirror path.
        parts = remote_path.strip("/").split("/")
        cumulative = ""
        for segment in parts[:-1]:
            cumulative = f"{cumulative}/{segment}" if cumulative else segment
            self._run(["mpremote", "connect", port, "resume", "fs", "mkdir", f":{cumulative}"])
        return self._run(["mpremote", "connect", port, "resume", "fs", "cp", local_path, f":{remote_path}"])

    def flash_and_run(self, port: str, local_main_py: str):
        return self._run(["mpremote", "connect", port, "resume", "run", local_main_py])

    def reset(self, port: str):
        return self._run(["mpremote", "connect", port, "reset"])

    def serial_read_until(self, port: str, markers: list[str], timeout_s: float = 10.0):
        if self.serial_factory is None:
            import serial

            factory = serial.Serial
        else:
            factory = self.serial_factory
        deadline = time.monotonic() + timeout_s
        matched: list[str] = []
        buffer = ""
        with factory(port, 115200, timeout=0.05) as ser:
            # Drop bytes left in the OS buffer from a previous run so we do not
            # match stale marker lines.
            reset = getattr(ser, "reset_input_buffer", None)
            if callable(reset):
                reset()
            while time.monotonic() < deadline and len(matched) < len(markers):
                # readline() with a short serial timeout can return a partial line
                # (no trailing newline). Accumulate fragments and only match on
                # complete lines, so a marker split across reads is not missed.
                chunk = ser.readline().decode(errors="ignore")
                if not chunk:
                    continue
                buffer += chunk
                while "\n" in buffer and len(matched) < len(markers):
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if line and markers[len(matched)] in line:
                        matched.append(line)
            # Flush trailing markers emitted without a newline before the deadline.
            while len(matched) < len(markers):
                tail = buffer.strip()
                if tail and markers[len(matched)] in tail:
                    matched.append(tail)
                    buffer = ""
                else:
                    break
        if len(matched) < len(markers):
            return {"ok": False, "error": "timeout", "lines": matched}
        return {"ok": True, "lines": matched}

    def run_script(self, script_path: str, args: list[str], timeout: float = 300):
        # Run a vendored upstream toolchain script with the shim's own Python
        # (sys.executable = the venv interpreter), so its deps (jsonschema/flake8/
        # requests) resolve from the venv. Injectable via self.runner for tests.
        return self._run([sys.executable, script_path, *args], timeout=timeout)

    def _run(self, command: list[str], timeout: float = 30):
        self.commands.append(command)
        return self.runner(command, capture_output=True, text=True, timeout=timeout)


# ---------- stdio JSON-RPC server (entry point the VS Code extension spawns) ----------
# Only newline-delimited JSON-RPC goes to stdout; diagnostics go to stderr.

def _run_mpremote(args, timeout=30):
    return subprocess.run(["mpremote", *args], capture_output=True, text=True, timeout=timeout)


def _list_files(port):
    r = _run_mpremote(["connect", port, "resume", "fs", "ls"], timeout=15)
    if r.returncode != 0:
        return {"status": "error", "error_kind": map_install_error(r.stderr), "message": (r.stderr or "").strip()}
    files = []
    for line in r.stdout.splitlines():
        parts = line.strip().split()
        if parts and parts[-1] != "ls":
            files.append(parts[-1])
    return {"status": "ok", "files": files}


def _health_check():
    try:
        import serial
        pyserial_version = getattr(serial, "VERSION", "unknown")
    except ImportError:
        pyserial_version = None
    r = _run_mpremote(["version"], timeout=10)
    return {
        "status": "ok",
        "python_version": platform.python_version(),
        "mpremote_version": (r.stdout or r.stderr).strip() if r.returncode == 0 else None,
        "pyserial_version": pyserial_version,
        "os": sys.platform,
        "platform": platform.platform(),
    }


def _write_code_to_device(code, run):
    # Shared by device.write_main_py / device.write_device_file: stage the code in
    # a temp file, hand it to `run(tmp_path)`, map the mpremote result to a status.
    fd, tmp = tempfile.mkstemp(suffix=".py")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(code or "")
        r = run(tmp)
        if getattr(r, "returncode", 0) != 0:
            return {"status": "error", "error_kind": map_install_error(getattr(r, "stderr", "") or ""), "message": (getattr(r, "stderr", "") or "").strip()}
        return {"status": "ok"}
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _run_validate(shim, params):
    schema_path = resolve_schema(params.get("schema", "project-manifest"))
    if schema_path is None:
        return {"status": "error", "error_kind": "unknown_schema"}
    project_dir = params.get("project_dir")
    rel = params.get("path", "project-manifest.json")
    json_path = os.path.join(project_dir, rel) if project_dir else rel
    r = shim.run_script(resolve_script("validate"), ["--schema", schema_path, "--json", json_path], timeout=60)
    rc = getattr(r, "returncode", 1)
    # validate_json.py: exit 0 = valid, 1 = validation errors, 2 = parse/not-found.
    # A non-zero exit is a normal "invalid" result, not a transport failure, so the
    # call status is always ok and the validity rides in `valid` + the output text.
    return {"status": "ok", "valid": rc == 0, "exit_code": rc, "output": (getattr(r, "stdout", "") or "").strip()}


def _run_project_script(shim, name, args):
    r = shim.run_script(resolve_script(name), args)
    rc = getattr(r, "returncode", 1)
    if rc != 0:
        return {"status": "error", "error_kind": "script_failed", "exit_code": rc,
                "message": (getattr(r, "stderr", "") or getattr(r, "stdout", "") or "").strip()}
    return {"status": "ok", "exit_code": rc, "output": (getattr(r, "stdout", "") or "").strip()}


def _dispatch(shim, method, params):
    if method == "script.run_validate":
        return _run_validate(shim, params)
    if method == "script.run_scaffold":
        return _run_project_script(shim, "scaffold", ["--project-dir", params["project_dir"], "--mode", params.get("mode", "timer")])
    if method == "script.run_download_drivers":
        return _run_project_script(shim, "download_drivers", ["--project-dir", params["project_dir"]])
    if method == "device.scan":
        return {"status": "ok", "devices": [{"port": p} for p in shim.scan()]}
    if method == "device.health_check":
        return _health_check()
    if method == "device.list_files":
        return _list_files(params["port"])
    if method == "device.write_main_py":
        return _write_code_to_device(params.get("code", ""), lambda tmp: shim.write_main_py(params["port"], tmp))
    if method == "device.write_device_file":
        return _write_code_to_device(params.get("code", ""), lambda tmp: shim.write_device_file(params["port"], params["path"], tmp))
    if method == "device.flash_and_run":
        # Soft reset so the freshly-written main.py autoruns (non-blocking for
        # infinite loops); device.serial_read_until captures the output.
        r = shim.reset(params["port"])
        if getattr(r, "returncode", 0) != 0:
            return {"status": "error", "error_kind": "mpremote_error", "message": (getattr(r, "stderr", "") or "").strip()}
        return {"status": "ok"}
    if method == "device.install_package":
        res = shim.install_package(params["port"], params["url"])
        return {"status": "ok"} if res.get("ok") else {"status": "error", "error_kind": res.get("error")}
    if method == "device.serial_read_until":
        markers = params.get("markers") or ([params["pattern"]] if params.get("pattern") else [])
        return shim.serial_read_until(params["port"], markers, float(params.get("timeout_sec", 10)))
    return None  # unknown method


def _respond(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def _ensure_utf8_io(stream):
    """Force a text stream to UTF-8. The extension writes JSON-RPC as UTF-8 over
    the pipe; on Windows the shim would otherwise decode stdin with the locale
    codepage (e.g. gbk) and silently corrupt any non-ASCII code/path/url."""
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


def main(shim=None):
    shim = shim or Shim()
    _ensure_utf8_io(sys.stdin)
    _ensure_utf8_io(sys.stdout)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
        try:
            result = _dispatch(shim, method, params)
            if result is None:
                _respond({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"method not found: {method}"}})
            else:
                _respond({"jsonrpc": "2.0", "id": rid, "result": result})
        except subprocess.TimeoutExpired:
            _respond({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "device operation timed out"}})
        except Exception as exc:  # noqa: BLE001 — one bad call must not kill the loop
            sys.stderr.write(f"shim error in {method}: {exc}\n")
            sys.stderr.flush()
            _respond({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(exc)}})


if __name__ == "__main__":
    main()
