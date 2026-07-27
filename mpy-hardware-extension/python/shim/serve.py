import base64
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


# macOS always exposes these built-in callout/serial ports; none is ever a MicroPython
# board. Without this filter a Mac with ANY real board lists >1 port, and the single-port
# device path (device-shim: ports.length > 1 -> device_selection_required) refuses to pick,
# blocking flash/deploy with no way to unplug the built-ins.
_MACOS_NON_BOARD = ("Bluetooth-Incoming-Port", "debug-console", "wlan-debug")


def parse_scan_output(output: str) -> list[str]:
    ports: list[str] = []
    for line in output.splitlines():
        first = line.split(maxsplit=1)[0] if line.split() else ""
        # COM* (Windows), /dev/tty* (Linux ttyUSB/ttyACM + macOS tty.*),
        # /dev/cu.* (macOS callout device mpremote sometimes lists).
        if not first.startswith(("COM", "/dev/tty", "/dev/cu.")):
            continue
        if any(name in first for name in _MACOS_NON_BOARD):
            continue
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


GRAFTSENSE_GH_PREFIX = "github:FreakStudioCN/GraftSense-Drivers-MicroPython/"


def upypi_mirror_url(install_url: str, version):
    """GraftSense's install URL points at github (raw.githubusercontent), which
    mainland-China hosts can't reach — so `mip install` fails there. The same driver
    is mirrored on upypi (China-reachable AND self-hosted: its package.json's file
    urls are relative, never redirecting back to github), keyed by the driver's
    directory name + its pinned version. `version` is the real version threaded from
    the manifest (NOT hardcoded). Returns the upypi package.json URL to try first, or
    None for a non-GraftSense URL, or when no version is known (don't fabricate one —
    just install the original URL)."""
    if not install_url.startswith(GRAFTSENSE_GH_PREFIX) or not version:
        return None
    pkg = install_url.rstrip("/").rsplit("/", 1)[-1]
    if not pkg:
        return None
    return "https://upypi.net/pkgs/{}/{}/package.json".format(pkg, version)


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
    # render_wiring/render_diagram/validate use the -plugin dirs (as bundled by prepare-vsce's
    # PLUGIN_DIRS and named in the submodule); the old non-plugin names resolved to nothing, which
    # broke rendering (script_not_found -> the run's image never renders).
    # scaffold/download_drivers deliberately use the LEGACY (non-plugin) scripts: the -plugin
    # init_scaffold.py ignores --project-dir (argparse.SUPPRESS) and only writes JSON to stdout from a
    # piped manifest, and the -plugin download_drivers.py rejects --project-dir outright. The host
    # dispatch (_run_project_script below) passes --project-dir and expects files written to disk
    # (firmware/board.py, firmware/lib/*), which only the legacy scripts do. PLUGIN_DIRS bundles both.
    "validate": "upy-project-gen-toolchain-spec/scripts/validate_json.py",
    "scaffold": "upy-scaffold/scripts/init_scaffold.py",
    "download_drivers": "upy-generate/scripts/download_drivers.py",
    "render_wiring": "upy-wiring-plugin/scripts/render_wiring_local.py",
    "render_diagram": "upy-diagram-plugin/scripts/render_diagram_local.py",
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


# ---------- V0 plugin-interface generic script runner ----------
# The V0 `-plugin` skills move the deterministic work into many vendored scripts
# (init_manifest.py, init_scaffold.py, the ~20 check_*.py gates, run_quality_gates.py,
# firmware_download.py, ...). The cloud model emits script_run(interpreter, script,
# args) with the script's BARE name; we resolve that name against the bundled plugin
# scripts and run it for real. A name we cannot resolve is an ERROR (fail fast) — the
# old behavior of silently returning success faked every V0 gate.
_V0_SCRIPT_INDEX: dict | None = None

# The served/bundled V0 plugin dirs — mirrors PLUGIN_DIRS in scripts/prepare-vsce.mjs.
# The optional flows (gen-driver/wiring/diagram) are now served, so their scripts must be
# indexed + packaged too. A few basenames overlap the core plugins (update_session_state.py in
# upy-generate + upy-gen-driver; run_on_device.py in upy-scaffold + upy-gen-driver; common.py
# 3-way), so those bare names become AMBIGUOUS: the resolver fails loud and the SKILLs use
# plugin-qualified names (e.g. upy-gen-driver-plugin/update_session_state.py) — this is intended,
# not a regression.
_V0_PLUGIN_DIRS = (
    "upy-analyze-plugin",
    "upy-select-hw-plugin",
    "upy-flash-mpy-firmware-plugin",
    "upy-scaffold-plugin",
    "upy-generate-plugin",
    "upy-deploy-plugin",
    "upy-gen-driver-plugin",
    "upy-wiring-plugin",
    "upy-diagram-plugin",
    # Sipeed MaixPy export (standalone global tool). Its script basenames are unique across the
    # bundled plugins, so they resolve bare.
    "upy-maixpy-export-plugin",
    "shared-plugin-scripts",
    # Toolchain-spec scripts (validate_json.py) — wiring/diagram SKILLs invoke the schema check by name.
    "upy-project-gen-toolchain-spec",
)

# Upstream MAINTENANCE scripts: they refresh a Skill's own reference library from the live web and
# write wherever their --out-dir points, with no workspace containment. They are for the Skill's
# maintainers, never for a user run — but indexing a plugin dir would otherwise make them resolvable
# by bare name from ANY phase's script_run, i.e. a network fetch and an unconfined write inside a
# run that declares network:false. Never indexed, and never bundled (scripts/plugin-dirs.mjs keeps
# the same list; plugin-dirs-contract asserts the two agree).
_V0_MAINTENANCE_SCRIPTS = frozenset(
    {
        "crawl_sipeed_maixpy_docs.py",
        "build_reference_index.py",
    }
)


def _build_v0_script_index() -> dict:
    """Map each V0 plugin-script basename to the LIST of bundled paths sharing it.

    Only the served `-plugin` script dirs and shared-plugin-scripts (_V0_PLUGIN_DIRS)
    are indexed. The OLD pre-V0 skills (upy-analyze, upy-scaffold, upy-generate, ...)
    ship the same basenames (init_manifest.py, init_scaffold.py, download_drivers.py),
    and upstream carries `-plugin` stages we don't bundle; indexing either would let a
    bare name silently resolve to a script the VSIX doesn't ship AND make dev (full
    submodule on disk) diverge from the packaged VSIX. A basename mapping to >1 path
    is AMBIGUOUS and must fail loud at resolve time — never a silent first-match pick
    (which would depend on os.walk traversal order)."""
    index: dict[str, list[str]] = {}
    root = scripts_root()
    for plugin_dir in _V0_PLUGIN_DIRS:
        for dirpath, _dirs, files in os.walk(os.path.join(root, plugin_dir)):
            norm = dirpath.replace("\\", "/")
            if "__pycache__" in norm:
                continue
            # A V0 plugin's own scripts/ dir, the shared V0 script pool, or the toolchain-spec scripts
            # (validate_json.py, invoked by name from the wiring/diagram SKILLs).
            if ("-plugin/scripts" not in norm
                    and "shared-plugin-scripts" not in norm
                    and "upy-project-gen-toolchain-spec/scripts" not in norm):
                continue
            for fname in files:
                if fname.endswith(".py") and fname not in _V0_MAINTENANCE_SCRIPTS:
                    index.setdefault(fname, []).append(os.path.join(dirpath, fname))
    return index


def _v0_script_candidates(name: str, phase: str | None = None) -> list:
    global _V0_SCRIPT_INDEX
    if _V0_SCRIPT_INDEX is None:
        _V0_SCRIPT_INDEX = _build_v0_script_index()
    raw = str(name).replace("\\", "/")
    candidates = list(_V0_SCRIPT_INDEX.get(os.path.basename(raw), []))
    # A plugin-qualified name (e.g. "upy-deploy-plugin/list_serial_ports.py") narrows a duplicate
    # basename to the copy in that plugin dir, so the model can target one of several same-named
    # scripts without a silent first-match pick. Derive the qualifier from the path segments the
    # model sent, IGNORING the plugin-internal "scripts/" dir: the SKILL.md prose invokes scripts by
    # their dir-relative "scripts/<name>.py" spelling (e.g. upy-generate-plugin/SKILL.md), which is
    # NOT a plugin qualifier — and since every copy lives under .../scripts/, treating "scripts" as
    # one would match ALL copies and defeat the phase disambiguation below (an ambiguous_script_name
    # regression of the live generate flow). Only a real plugin dir the model names qualifies.
    segments = [seg for seg in raw.split("/")[:-1] if seg and seg != "scripts"]
    qualifier = segments[-1] if segments else ""
    if qualifier:
        # Match the qualifier as a whole path SEGMENT, not a bare substring — else "driver" would
        # match "gen-driver" and silently pick the wrong copy. An explicit qualifier always wins;
        # one that names no candidate stays AMBIGUOUS (fail-loud) so the model sees its mistake,
        # never a wrong-phase copy — so we never fall through to the phase branch after a qualifier.
        narrowed = [p for p in candidates if ("/" + qualifier + "/") in p.replace("\\", "/")]
        return narrowed if narrowed else candidates
    # Otherwise, for a BARE name (incl. the "scripts/<name>" SKILL spelling), the ACTIVE PHASE
    # disambiguates a duplicate basename: e.g. update_session_state.py ships in both
    # upy-generate-plugin and upy-gen-driver-plugin, so the generate phase gets the generate copy
    # (and gen-driver its own) without the model having to qualify. For the phases that collide, the
    # phase token IS the plugin dir name; short tokens (analyze/select-hw) never collide, so a
    # non-matching phase leaves the list untouched (fail-loud).
    if phase and len(candidates) > 1:
        segment = "/" + str(phase) + "/"
        narrowed = [p for p in candidates if segment in p.replace("\\", "/")]
        if narrowed:
            return narrowed
    return candidates


def _qualified_name(path: str) -> str:
    """Render a bundled script path as the plugin-qualified name the model should send to
    disambiguate a duplicate basename (e.g. 'upy-deploy-plugin/list_serial_ports.py')."""
    parts = path.replace("\\", "/").split("/")
    for seg in parts:
        if seg.endswith("-plugin") or seg == "shared-plugin-scripts":
            return f"{seg}/{parts[-1]}"
    return parts[-1]


def resolve_v0_script(name: str):
    """Resolve a bare V0 plugin-script name (e.g. 'check_generate_plan.py') to its
    absolute path, or None when not bundled OR ambiguous (shipped by >1 plugin).
    Callers that must distinguish the two use _v0_script_candidates directly."""
    candidates = _v0_script_candidates(name)
    return candidates[0] if len(candidates) == 1 else None


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

def _parse_v0_git_commit_shell(command: str) -> list[list[str]] | None:
    cmd = str(command or "").strip()
    if not cmd or any(ch in cmd for ch in (";", "|", "<", ">", "`", "\n", "\r", "\0")):
        return None
    if cmd.count("&&") != 1:
        return None
    add_part, commit_part = [part.strip() for part in cmd.split("&&", 1)]
    try:
        add_tokens = shlex.split(add_part, posix=True)
        commit_tokens = shlex.split(commit_part, posix=True)
    except ValueError:
        return None
    if add_tokens != ["git", "add", "-A"]:
        return None
    if len(commit_tokens) != 4 or commit_tokens[:3] != ["git", "commit", "-m"]:
        return None
    message = commit_tokens[3].strip()
    if not message:
        return None
    return [["git", "add", "-A"], ["git", "commit", "-m", message]]

class Shim:
    def __init__(self, runner=None, serial_factory=None):
        self.runner = runner or subprocess.run
        self.serial_factory = serial_factory
        self.commands: list[list[str]] = []

    def scan(self):
        result = self._run(["mpremote", "connect", "list"])
        return parse_scan_output(result.stdout)

    def probe_micropython(self, port: str, timeout: float = 5):
        # `scan` only lists serial ports — a raw/unflashed board still shows up. Confirm
        # a LIVE MicroPython REPL by execing a print and checking the marker echoes back.
        # An unresponsive board makes mpremote hang, so absorb the timeout as "no REPL"
        # rather than letting it bubble up as a transport error.
        try:
            result = self._run(["mpremote", "connect", port, "exec", "print('mpy-ok')"], timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"has_micropython": False}
        out = getattr(result, "stdout", "") or ""
        return {"has_micropython": getattr(result, "returncode", 1) == 0 and "mpy-ok" in out}

    def install_package(self, port: str, package_json_url: str, version=None):
        self._run(["mpremote", "connect", port, "resume", "fs", "mkdir", ":/lib"])
        # Try the China-reachable upypi mirror first for GraftSense drivers, then fall
        # back to the original URL — so mainland-China users get the driver while
        # non-China users (and any unmirrored driver) are never regressed. `version` is
        # the manifest's pinned version, used to build the mirror URL.
        candidates = [url for url in (upypi_mirror_url(package_json_url, version), package_json_url) if url]
        result = None
        for url in candidates:
            result = self._run(["mpremote", "connect", port, "resume", "mip", "install", url], timeout=120)
            if result.returncode == 0:
                return {"ok": True}
        # Keep BOTH the classified category and the raw stderr: the category buckets
        # the failure ("network"), the raw text names the cause (which host/package).
        # Dropping stderr here is what made a failed install undiagnosable downstream.
        return {"ok": False, "error": map_install_error(result.stderr), "message": (result.stderr or "").strip()}

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

    def run_v0_python(self, script_path: str, args: list[str], cwd=None, stdin=None, timeout: float = 300):
        # Run a vendored V0 plugin script with the venv interpreter. cwd is the project
        # root; stdin feeds scripts invoked with --stdin. Injectable via self.runner.
        cmd = [sys.executable, script_path, *args]
        self.commands.append(cmd)
        return self.runner(cmd, timeout=timeout, cwd=cwd, input=stdin, **_subprocess_text_kwargs())

    def run_v0_shell(self, command: str, cwd=None, stdin=None, timeout: float = 300):
        # V0 generate emits script_run(shell, 'git add -A && git commit -m "..."').
        # Do not pass that string to a host shell; execute the two allowed git argv
        # calls directly so chained shell metacharacters never run.
        commands = _parse_v0_git_commit_shell(command)
        if commands is None:
            raise ValueError("shell_command_not_allowed")
        last = None
        for cmd in commands:
            self.commands.append(cmd)
            last = self.runner(cmd, timeout=timeout, cwd=cwd, input=stdin, **_subprocess_text_kwargs())
            if getattr(last, "returncode", 1) != 0:
                return last
        return last

    def _run(self, command: list[str], timeout: float = 30):
        self.commands.append(command)
        return self.runner(command, timeout=timeout, **_subprocess_text_kwargs())


# ---------- stdio JSON-RPC server (entry point the VS Code extension spawns) ----------
# Only newline-delimited JSON-RPC goes to stdout; diagnostics go to stderr.

def _run_mpremote(args, timeout=30):
    return subprocess.run(["mpremote", *args], capture_output=True, text=True, timeout=timeout)


def _list_files(port, path=None):
    args = ["connect", port, "resume", "fs", "ls"]
    if path:
        args.append(path)
    r = _run_mpremote(args, timeout=15)
    if r.returncode != 0:
        return {"status": "error", "error_kind": map_install_error(r.stderr), "message": (r.stderr or "").strip()}
    files = []
    for line in r.stdout.splitlines():
        # Entries are "<size> <name>" (a dir shows "0 name/"); mpremote also echoes an "ls :"
        # header line. Split on the FIRST whitespace only so a name containing spaces (e.g.
        # "my data.bin") is preserved verbatim; before, split() + parts[-1] returned "data.bin",
        # and download/delete then targeted the wrong path (PR #31 review, finding 1).
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue  # drops the "ls :" header and any blank line
        # ponytail: a filename with TRAILING whitespace is still trimmed by line.strip().
        files.append(parts[1])
    return {"status": "ok", "files": files}


def _fs_remove(port, path):
    r = _run_mpremote(["connect", port, "resume", "fs", "rm", path], timeout=15)
    if r.returncode != 0:
        return {"status": "error", "error_kind": "mpremote_error", "message": (r.stderr or "").strip()}
    return {"status": "ok"}


def _is_absent(err):
    e = (err or "").lower()
    # Anchor the errno match: "errno 2" as a bare substring also matches errno 20-29
    # (ENOTDIR/EISDIR/ENOSPC ...), so a real failure would be misread as "absent" and
    # reported as a successful no-op. Require a word boundary after the 2.
    return "no such file" in e or "enoent" in e or "does not exist" in e or re.search(r"\berrno 2\b", e) is not None


# A package __init__ can be either source or compiled: `mpremote mip install` defaults to .mpy
# (mip.py sets args.mpy=True and fetches the device's mpy ABI variant), so a real package like
# aioble lands as __init__.mpy + core.mpy + ... with NO __init__.py. Both forms mark "one package".
_PACKAGE_INIT_NAMES = ("__init__.py", "__init__.mpy")


def _is_shared_namespace(files):
    """Pure: is a /lib/<name>/ dir a SHARED namespace that `rm -r` would wrongly wipe whole?

    True iff the dir has NO package __init__ (neither __init__.py nor __init__.mpy) AND more than
    one entry -- then each entry is an independently-installed module (umqtt/ = simple + robust,
    installed as umqtt.simple / umqtt.robust) and removing the dir takes siblings with it. A dir
    WITH an __init__ is one package (safe to remove whole); a 0/1-entry dir is not shared."""
    names = [f.strip().rstrip("/") for f in files]
    if any(n in _PACKAGE_INIT_NAMES for n in names):
        return False
    return len(names) > 1


def _uninstall_package(port, name):
    """Best-effort uninstall: mip has no uninstall, so remove the package's files under /lib.
    Covers a package dir (/lib/<name>/), a flat module (/lib/<name>.mpy|.py), and a dotted
    module laid down nested (umqtt.simple -> /lib/umqtt/simple.py). The name is restricted to
    an ALLOWLIST charset directly under /lib (never a blocklist): mpremote raw-interpolates the
    name into on-device Python (os.remove('%s')), so a permissive name is arbitrary code exec
    on the board. An all-absent result is success (nothing installed under that name)."""
    slug = (name or "").strip().strip("/")
    # Allowlist, plus explicit reject of "." and ".." (the charset allows dots, so a bare "."
    # -> `rm -r :/lib/.` = wipe all of /lib, and ".." would traverse). A guard REWRITE must
    # re-cover the cases the old guard did. A blocklist here cannot anticipate mpremote's quoting.
    if not slug or slug in (".", "..") or ".." in slug or not re.fullmatch(r"[A-Za-z0-9_.-]+", slug):
        return {"status": "error", "error_kind": "invalid_package_name", "message": str(name)}
    # Guard the Installed-view path: a bare name (no dot) whose /lib/<name>/ is a shared namespace
    # dir must NOT `rm -r` -- that wipes sibling modules. Refuse and point at the specific module.
    # Dotted names skip this: their candidates target the exact nested file, never the dir.
    if "." not in slug:
        listing = _list_files(port, f":/lib/{slug}")
        if listing.get("status") == "ok":
            files = [f.strip().rstrip("/") for f in (listing.get("files") or [])]
            if _is_shared_namespace(files):
                modules = ", ".join(f"{slug}.{f.rsplit('.', 1)[0]}" for f in files)
                return {"status": "error", "error_kind": "shared_namespace",
                        "message": f"'{slug}' is a shared namespace with multiple modules. "
                                   f"Uninstall a specific one instead: {modules}."}
        elif not _is_absent(listing.get("message") or ""):
            # ls failed for a reason other than "absent" (busy / comms / mid-op): we cannot verify
            # the dir isn't a shared namespace, so REFUSE the destructive rm -r rather than risk
            # wiping siblings. Fail closed -- an absent path (the common flat-module case) is the
            # only ls failure we treat as "safe to proceed".
            return {"status": "error", "error_kind": "mpremote_error",
                    "message": f"could not list /lib/{slug} before uninstall: "
                               f"{(listing.get('message') or '').strip()}"}
    candidates = [f":/lib/{slug}", f":/lib/{slug}.mpy", f":/lib/{slug}.py"]
    nested = slug.replace(".", "/")
    if nested != slug:
        # A dotted package (umqtt.simple) installs as /lib/umqtt/simple.py — probe the nested
        # file forms so a dotted name isn't a false "Removed". rm on a file is not recursive
        # over a shared namespace dir, so this can't wipe sibling umqtt.* packages.
        candidates += [f":/lib/{nested}.mpy", f":/lib/{nested}.py"]
    removed = False
    real_err = None  # message of a genuine, identifiable (non-absent) failure
    unknown_fail = False  # a non-zero exit that gave no message at all -- ambiguous
    for path in candidates:
        r = _run_mpremote(["connect", port, "resume", "fs", "rm", "-r", path], timeout=30)
        if r.returncode == 0:
            removed = True
            continue
        # mpremote writes some rm errors ("no such file", OSError) to STDOUT, not stderr -- read
        # both, else a genuine failure is misclassified as "absent" and reported as "Removed".
        err = (r.stderr or r.stdout or "").strip()
        if _is_absent(err):
            continue
        if err:
            real_err = err  # permission/busy/etc -- authoritative even if a sibling was removed
        else:
            unknown_fail = True  # non-zero with no message -- don't silently treat as absent
    # A genuine, identifiable failure on a present path is an error even if another candidate was
    # removed: reporting "Removed" while a file is still importable on the board is the bug. An
    # unexplained non-zero exit is an error only when NOTHING was removed, so a silently-absent
    # probe (an extension we tried that isn't there) alongside a real removal isn't misread.
    if real_err is not None:
        return {"status": "error", "error_kind": "mpremote_error", "message": real_err}
    if unknown_fail and not removed:
        return {"status": "error", "error_kind": "mpremote_error",
                "message": "mpremote exited non-zero with no message"}
    return {"status": "ok", "removed": removed}


def _fs_mkdir(port, path):
    r = _run_mpremote(["connect", port, "resume", "fs", "mkdir", path], timeout=15)
    if r.returncode != 0:
        msg = (r.stderr or "").strip()
        # mpremote mkdir errors if the dir already exists — that's idempotent success, not
        # a failure (callers mkdir defensively before writing).
        if "EEXIST" in msg or "exist" in msg.lower():
            return {"status": "ok"}
        return {"status": "error", "error_kind": "mpremote_error", "message": msg}
    return {"status": "ok"}


def _fs_copy_from(port, remote_path, local_path):
    # mpremote addresses the device side with a leading ':'; normalize so a caller can pass
    # "log.txt" or ":log.txt" interchangeably.
    remote = ":" + str(remote_path).lstrip(":")
    # Create the local parent dirs first — mpremote cp fails if the destination directory
    # doesn't exist (the host path was already contained to the project root by device()).
    parent = os.path.dirname(local_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    r = _run_mpremote(["connect", port, "resume", "fs", "cp", remote, local_path], timeout=30)
    if r.returncode != 0:
        return {"status": "error", "error_kind": "mpremote_error", "message": (r.stderr or "").strip()}
    return {"status": "ok"}


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
    # Shared by device.write_main_py / device.write_device_file: stage the content in
    # a temp file, hand it to `run(tmp_path)`, map the mpremote result to a status. bytes
    # (Device Tools upload) stage in binary mode so a .mpy/image round-trips intact; str
    # (codegen) stays UTF-8 text.
    fd, tmp = tempfile.mkstemp(suffix=".py")
    try:
        if isinstance(code, (bytes, bytearray)):
            with os.fdopen(fd, "wb") as f:
                f.write(code)
        else:
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


def _v0_result(r):
    out = getattr(r, "stdout", "") or ""
    err = getattr(r, "stderr", "") or ""
    rc = getattr(r, "returncode", 1)
    result_json = None
    if out.strip():
        try:
            result_json = json.loads(out)
        except (ValueError, TypeError):
            result_json = None
    # status "ok" = the script RAN (the call succeeded); `success`/`exit_code` carry
    # whether the script PASSED. A non-zero gate is a real result the model must fix —
    # NOT a transport error. (script_not_found below is the transport error.)
    return {"status": "ok", "exit_code": rc, "success": rc == 0,
            "stdout": "" if result_json is not None else out[:8000],
            "stderr": err[:4000], "result_json": result_json}


def prepare_quality_gate_project(project_dir: str) -> None:
    """Scaffold drops host-only helpers under firmware/tools/ (e.g. flash_device.py,
    which imports subprocess). The mpy_imports gate hard-fails on them. Remove the
    directory deterministically instead of asking the model to (A3a)."""
    tools_dir = os.path.join(project_dir, "firmware", "tools")
    if os.path.isdir(tools_dir):
        shutil.rmtree(tools_dir)


def _project_dir_from_args(args: list) -> str | None:
    # Fallback for a caller that passes project_dir as a "--project-dir <value>" CLI
    # arg instead of the params["project_dir"] the real V0 caller uses.
    if "--project-dir" in args:
        idx = args.index("--project-dir")
        if idx + 1 < len(args):
            return args[idx + 1]
    return None


def _run_v0_script(shim, params):
    interpreter = params.get("interpreter", "python")
    script = params.get("script", "") or ""
    args = [str(a) for a in (params.get("args") or [])]
    # Always run at the project root; ignore any model-supplied cwd (scripts take
    # their paths via flags, and an arbitrary cwd could escape the workspace).
    cwd = params.get("project_dir") or None
    stdin_content = params.get("stdin_content")
    if params.get("stdin_json") is not None:
        stdin_content = json.dumps(params["stdin_json"], ensure_ascii=False)
    timeout = float(params.get("timeout_ms", 300000)) / 1000.0
    if interpreter == "shell":
        cmd = script if not args else script + " " + " ".join(args)
        if _parse_v0_git_commit_shell(cmd) is None:
            return {"status": "error", "error_kind": "shell_command_not_allowed",
                    "message": "only the generate-phase git add/commit command is permitted"}
        return _v0_result(shim.run_v0_shell(cmd, cwd=cwd, stdin=stdin_content, timeout=timeout))
    if interpreter == "node":
        # Fail fast: no node toolchain is assumed in the host shim. Don't fake success.
        return {"status": "error", "error_kind": "node_interpreter_unavailable",
                "message": "node script_run is not supported by the host shim"}
    base = os.path.basename(str(script))
    # The active phase disambiguates a basename shared by >1 served plugin (e.g.
    # update_session_state.py in generate + gen-driver) without the model qualifying.
    candidates = _v0_script_candidates(script, params.get("phase"))
    if len(candidates) > 1:
        # Same basename in >1 plugin: never silently pick one (see _build_v0_script_index).
        # List the plugin-qualified names so the model can retry with one of them instead
        # of getting stuck re-sending the bare name.
        qualified = sorted({_qualified_name(p) for p in candidates})
        return {"status": "error", "error_kind": "ambiguous_script_name",
                "message": f"{base!r} is shipped by multiple plugins; qualify the script name (e.g. {qualified[0]!r})",
                "candidates": qualified}
    if not candidates:
        return {"status": "error", "error_kind": "script_not_found",
                "message": f"no bundled V0 plugin script named {base!r}"}
    if base.endswith("run_quality_gates.py"):
        # A3a: deterministically strip firmware/tools/ (host-only helpers the
        # mpy_imports gate would hard-fail on) before the gates run, instead of
        # relying on the model to remember to delete it first.
        project_dir = cwd or _project_dir_from_args(args)
        if project_dir:
            prepare_quality_gate_project(project_dir)
    return _v0_result(shim.run_v0_python(candidates[0], args, cwd=cwd, stdin=stdin_content, timeout=timeout))


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
    if method == "script.run_v0":
        return _run_v0_script(shim, params)
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
    if method == "device.probe_micropython":
        return {"status": "ok", **shim.probe_micropython(params["port"], float(params.get("timeout_sec", 5)))}
    if method == "device.health_check":
        return _health_check()
    if method == "device.list_files":
        return _list_files(params["port"], params.get("path"))
    if method == "device.fs_remove":
        return _fs_remove(params["port"], params["path"])
    if method == "device.fs_mkdir":
        return _fs_mkdir(params["port"], params["path"])
    if method == "device.copy_from":
        return _fs_copy_from(params["port"], params["remote_path"], params["local_path"])
    if method == "device.write_main_py":
        return _write_code_to_device(params.get("code", ""), lambda tmp: shim.write_main_py(params["port"], tmp))
    if method == "device.write_device_file":
        # Device Tools upload sends content_b64 (raw bytes, staged binary); codegen sends
        # `code` (str). Keep the str path byte-for-byte unchanged when content_b64 is absent.
        raw_b64 = params.get("content_b64")
        payload = base64.b64decode(raw_b64) if raw_b64 is not None else params.get("code", "")
        return _write_code_to_device(payload, lambda tmp: shim.write_device_file(params["port"], params["path"], tmp))
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
        res = shim.install_package(params["port"], params["url"], params.get("version"))
        return {"status": "ok"} if res.get("ok") else {"status": "error", "error_kind": res.get("error"), "message": res.get("message")}
    if method == "device.uninstall_package":
        return _uninstall_package(params["port"], params["name"])
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
