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
    "render_wiring": "upy-wiring/scripts/render_wiring_local.py",
    "render_diagram": "upy-diagram/scripts/render_diagram_local.py",
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


def _subprocess_text_kwargs():
    # Force UTF-8 on BOTH ends of the pipe: the child emits UTF-8 (PYTHONIOENCODING)
    # and we decode UTF-8 with replacement. Without this, subprocess.run(text=True)
    # decodes with the OS locale codepage (e.g. Windows cp936), so non-ASCII script
    # output — Chinese requirements in a jsonschema error, an em-dash from a template
    # — could raise UnicodeDecodeError and turn a normal result into a transport error.
    return {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": {**os.environ, "PYTHONIOENCODING": "utf-8"},
    }


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

    def deploy_firmware_tree(self, port: str, firmware_dir: str):
        # Mirror the upstream `mpremote fs cp -r firmware/ :/` convention: the CONTENTS
        # of firmware/ map to the device ROOT (firmware/lib/x.py -> :lib/x.py, boot.py
        # -> :boot.py), so bare `import x` resolves from /lib and /boot.py autoruns.
        # Walking the on-disk tree (not state.files) also captures files written by
        # scaffold/download_drivers that never pass through write_device_file. main.py
        # is copied LAST so its imports already exist when the next reset autoruns it.
        if not os.path.isdir(firmware_dir):
            return {"status": "error", "error_kind": "firmware_dir_missing"}
        entries = []
        for root, _dirs, files in os.walk(firmware_dir):
            for name in files:
                if name == ".gitkeep":
                    continue
                src = os.path.join(root, name)
                rel = os.path.relpath(src, firmware_dir).replace("\\", "/")
                entries.append((src, rel))
        # Stable sort: every dependency (key False) keeps its order, main.py (key True)
        # moves to the end.
        entries.sort(key=lambda entry: entry[1] == "main.py")
        for src, rel in entries:
            parts = rel.split("/")
            cumulative = ""
            for segment in parts[:-1]:
                cumulative = f"{cumulative}/{segment}" if cumulative else segment
                self._run(["mpremote", "connect", port, "resume", "fs", "mkdir", f":{cumulative}"])
            r = self._run(["mpremote", "connect", port, "resume", "fs", "cp", src, f":{rel}"])
            if getattr(r, "returncode", 0) != 0:
                return {"status": "error", "error_kind": map_install_error(getattr(r, "stderr", "") or ""), "message": (getattr(r, "stderr", "") or "").strip()}
        return {"status": "ok"}

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

    def run_module(self, module: str, args: list[str], cwd=None, timeout: float = 300):
        # Run a venv module (flake8 / pylint / pytest) as `python -m <module>` in the
        # project dir. Injectable via self.runner for tests.
        cmd = [sys.executable, "-m", module, *args]
        self.commands.append(cmd)
        return self.runner(cmd, timeout=timeout, cwd=cwd, **_subprocess_text_kwargs())

    def _run(self, command: list[str], timeout: float = 30):
        self.commands.append(command)
        return self.runner(command, timeout=timeout, **_subprocess_text_kwargs())


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
    try:
        json_path = safe_workspace_path(project_dir, rel) if project_dir else rel
    except ValueError:
        return {"status": "error", "error_kind": "invalid_path"}
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


def _module_result(r):
    return {"exit_code": getattr(r, "returncode", 1),
            "output": ((getattr(r, "stdout", "") or "") + (getattr(r, "stderr", "") or "")).strip()}


def _run_static_check(shim, params):
    project_dir = params["project_dir"]
    target = params.get("target", "firmware")
    # flake8 is the configured gate (scaffold writes .flake8); pylint is advisory
    # (noisy on MicroPython without an rcfile). Both outputs ride back for the agent
    # to fix; `clean` keys on flake8 so it stays meaningful.
    flake = _module_result(shim.run_module("flake8", [target, "--max-line-length=120"], cwd=project_dir, timeout=120))
    pylint = _module_result(shim.run_module("pylint", [target], cwd=project_dir, timeout=180))
    return {"status": "ok", "clean": flake["exit_code"] == 0, "flake8": flake, "pylint": pylint}


def _run_simulate(shim, params):
    project_dir = params["project_dir"]
    target = params.get("target", "test/pc")
    r = _module_result(shim.run_module("pytest", [target, "-q"], cwd=project_dir, timeout=300))
    # pytest exit 0 = passed, 5 = no tests collected (treat as not-failed but empty).
    return {"status": "ok", "passed": r["exit_code"] == 0, "no_tests": r["exit_code"] == 5, **r}


def safe_workspace_path(project_dir: str, rel_path: str, default: str | None = None) -> str:
    rel = rel_path or default
    if not rel:
        raise ValueError("path required")
    rel = str(rel).replace("\\", "/")
    if os.path.isabs(rel) or rel.startswith("/") or ".." in rel.split("/"):
        raise ValueError("path must be workspace-relative")
    root = os.path.abspath(project_dir)
    path = os.path.abspath(os.path.join(root, rel))
    if os.path.commonpath([root, path]) != root:
        raise ValueError("path escapes workspace")
    return path


def _run_triage(shim, params):
    project_dir = params["project_dir"]
    target = params.get("target", "firmware")
    try:
        safe_workspace_path(project_dir, target)
    except ValueError:
        return {"status": "error", "error_kind": "invalid_path"}
    flake = _module_result(shim.run_module("flake8", [target, "--max-line-length=120"], cwd=project_dir, timeout=120))
    pytest_target = "test/pc"
    pytest_out = _module_result(shim.run_module("pytest", [pytest_target, "-q"], cwd=project_dir, timeout=300))
    logs = [line for line in [flake["output"], pytest_out["output"]] if line]
    summary = "triage clean" if flake["exit_code"] == 0 and pytest_out["exit_code"] in (0, 5) else "triage found local issues"
    return {"status": "ok", "exit_code": 0 if summary == "triage clean" else 1, "summary": summary, "logs": logs[:5], "artifacts": []}


def _run_hardware_sanity(shim, params):
    devices = shim.scan()
    if not devices:
        return {"status": "ok", "exit_code": 1, "summary": "no MicroPython device detected", "observations": []}
    observations = [f"device:{port}" for port in devices]
    return {"status": "ok", "exit_code": 0, "summary": "MicroPython device detected", "observations": observations}


def _run_extract_pdf(_shim, params):
    project_dir = params["project_dir"]
    try:
        pdf_path = safe_workspace_path(project_dir, params.get("path"))
        output_path = safe_workspace_path(project_dir, params.get("output_path"), "docs/extracted-pdf.json")
    except ValueError:
        return {"status": "error", "error_kind": "invalid_path"}
    if not os.path.exists(pdf_path):
        return {"status": "error", "error_kind": "pdf_not_found"}
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"status": "error", "error_kind": "pdf_extractor_unavailable"}
    reader = PdfReader(pdf_path)
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append({"page": index, "text": text[:4000]})
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"pages": pages}, handle, ensure_ascii=False, indent=2)
    return {
        "status": "ok",
        "exit_code": 0,
        "pages": pages,
        "output_path": os.path.relpath(output_path, project_dir).replace("\\", "/"),
    }


def _run_flash_device(shim, params):
    project_dir = params["project_dir"]
    port = params.get("port")
    try:
        firmware_path = safe_workspace_path(project_dir, params.get("path"), "firmware/main.py")
    except ValueError:
        return {"status": "error", "error_kind": "invalid_path"}
    flash_script = os.path.join(project_dir, "tools", "flash_device.py")
    if os.path.exists(flash_script):
        args = ["--path", firmware_path]
        if port:
            args.extend(["--port", port])
        r = shim.run_script(flash_script, args, timeout=180)
        rc = getattr(r, "returncode", 1)
        if rc != 0:
            return {"status": "error", "error_kind": "flash_failed", "exit_code": rc,
                    "message": (getattr(r, "stderr", "") or getattr(r, "stdout", "") or "").strip()}
        return {"status": "ok", "exit_code": 0, "summary": "project flash script completed"}
    # No project flash script: the firmware is already on the device (write_main_py
    # deployed the firmware/ tree), so just reset to run it. Do NOT re-copy main.py.
    if not port:
        devices = shim.scan()
        if len(devices) != 1:
            return {"status": "error", "error_kind": "device_selection_required" if devices else "device_unavailable"}
        port = devices[0]
    reset = shim.reset(port)
    if getattr(reset, "returncode", 0) != 0:
        return {"status": "error", "error_kind": map_install_error(getattr(reset, "stderr", "") or "")}
    return {"status": "ok", "exit_code": 0, "summary": "board reset to run deployed firmware"}


def _run_render(shim, kind, params):
    # Render docs/<kind>.json -> Mermaid .md via the upstream renderer. Default
    # format "md" keeps it offline (the "all"/"png" formats call mermaid.ink).
    project_dir = params["project_dir"]
    docs = os.path.join(project_dir, "docs")
    r = shim.run_script(
        resolve_script(f"render_{kind}"),
        ["--input", os.path.join(docs, f"{kind}.json"), "--output", docs, "--format", params.get("format", "md")],
        timeout=120,
    )
    rc = getattr(r, "returncode", 1)
    if rc != 0:
        return {"status": "error", "error_kind": "render_failed", "exit_code": rc,
                "message": (getattr(r, "stderr", "") or getattr(r, "stdout", "") or "").strip()}
    return {"status": "ok", "exit_code": rc, "output": (getattr(r, "stdout", "") or "").strip()}


def _dispatch(shim, method, params):
    if method == "script.run_validate":
        return _run_validate(shim, params)
    if method == "script.run_scaffold":
        return _run_project_script(shim, "scaffold", ["--project-dir", params["project_dir"], "--mode", params.get("mode", "timer")])
    if method == "script.run_download_drivers":
        return _run_project_script(shim, "download_drivers", ["--project-dir", params["project_dir"]])
    if method == "script.run_static_check":
        return _run_static_check(shim, params)
    if method == "script.run_simulate":
        return _run_simulate(shim, params)
    if method == "script.run_triage":
        return _run_triage(shim, params)
    if method == "script.run_hardware_sanity":
        return _run_hardware_sanity(shim, params)
    if method == "script.run_extract_pdf":
        return _run_extract_pdf(shim, params)
    if method == "script.run_flash_device":
        return _run_flash_device(shim, params)
    if method == "script.render_wiring":
        return _run_render(shim, "wiring", params)
    if method == "script.render_diagram":
        return _run_render(shim, "diagram", params)
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
    if method == "device.deploy_firmware_tree":
        return shim.deploy_firmware_tree(params["port"], os.path.join(params["project_dir"], "firmware"))
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
