import base64
import datetime
import fnmatch
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time


# macOS always exposes these built-in callout/serial ports; none is ever a MicroPython
# board. Without this filter a Mac with ANY real board lists >1 port, and the single-port
# device path (device-shim: ports.length > 1 -> device_selection_required) refuses to pick,
# blocking flash/deploy with no way to unplug the built-ins.
_MACOS_NON_BOARD = ("Bluetooth-Incoming-Port", "debug-console", "wlan-debug")

# `mpremote connect list` prints "{port} {serial} {vid:04x}:{pid:04x} {mfr} {product}".
# A device with no USB descriptor at all reports 0000:0000 for both fields (verified from
# mpremote/pyserial source: vid/pid None formats as 0000:0000). An HC-05 Bluetooth virtual
# serial port is the motivating case, but that it actually enumerates with vid/pid None is
# inferred, not host-verified -- confirm once on real Windows hardware (scope's
# Verify-on-implementation note).
_NO_USB_DESCRIPTOR = "0000:0000"
_VID_PID_RE = re.compile(r"\b(?:[0-9a-fA-F]{4}):(?:[0-9a-fA-F]{4})\b")


def parse_scan_output(output: str) -> list[str]:
    ports: list[tuple[str, str | None]] = []
    for line in output.splitlines():
        first = line.split(maxsplit=1)[0] if line.split() else ""
        # COM* (Windows), /dev/tty* (Linux ttyUSB/ttyACM + macOS tty.*),
        # /dev/cu.* (macOS callout device mpremote sometimes lists).
        if not first.startswith(("COM", "/dev/tty", "/dev/cu.")):
            continue
        if any(name in first for name in _MACOS_NON_BOARD):
            continue
        match = _VID_PID_RE.search(line)
        ports.append((first, match.group(0).lower() if match else None))

    # A descriptorless port (vid:pid 0000:0000, e.g. the HC-05 virtual serial port) is
    # dropped ONLY when at least one OTHER listed port has a real USB descriptor -- so a
    # board plugged in alongside the HC-05 no longer forces "pick one of COM5, COM48" on
    # a port the user can't actually flash. This is a choke point (scan(), device.scan,
    # ensurePort, the doctor's device_selection_required branch all read this list), so a
    # false drop doesn't just hide a candidate -- with one USB port left, callers that
    # single-port-auto-pick (ensurePort, the len(devices)==1 flash fallback) now target
    # THAT port instead of asking. That's the intended fix for the reported HC-05 case;
    # it only misfires if a genuinely descriptorless NON-Bluetooth board (e.g. a bare
    # UART bridge with no USB descriptor) sits alongside a real USB port, which auto-picks
    # the wrong device instead of prompting. ponytail: a lone descriptorless port (no real
    # USB port present at all) still shows, since dropping it would leave nothing to pick.
    has_usb_descriptor = any(vid_pid and vid_pid != _NO_USB_DESCRIPTOR for _, vid_pid in ports)
    if has_usb_descriptor:
        ports = [(port, vid_pid) for port, vid_pid in ports if vid_pid != _NO_USB_DESCRIPTOR]
    return [port for port, _ in ports]


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
        # Validates the Skill's OWN reference library, and requires the reference .md files that the
        # VSIX strips — so in a packaged install it can only ever fail. Its SKILL offers it as "use
        # bundled scripts when available" with an explicit self-check-and-warn fallback, so a clean
        # script_not_found is the better answer than a guaranteed non-zero exit.
        "validate_reference_index.py",
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
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    # Point the deploy plugin's own mpremote at the boot-settle launcher. It spawns mpremote
    # directly, so this variable is the only way to reach it; an operator who set it by hand
    # outranks us.
    mpremote_command = _mpremote_env_command()
    if mpremote_command and not env.get("UPY_MPREMOTE"):
        env["UPY_MPREMOTE"] = mpremote_command
    return {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": env,
    }

# Every shell form the V0 phases may run, as EXACT argv. `git rev-parse HEAD` is required by
# the generate contract (session_state.git_commit must record project HEAD) and `git init`
# by a project that is not a repo yet; refusing them stalled the phase, because
# update_session_state.py then failed with SESSION_STATE_ARTIFACTS_MISSING and the model had
# no way to learn what it was allowed to run.
_ALLOWED_SHELL_ARGV: tuple[tuple[str, ...], ...] = (
    ("git", "init"),
    ("git", "add", "-A"),
    ("git", "rev-parse", "HEAD"),
    ("git", "status", "--short"),
)
# Forms whose LAST token is model-supplied text rather than a fixed word.
#
# `--amend` is deliberately NOT here, in either form. It was allowed for one run, because
# models reached for it after committing and burned a turn on a command with no verb. What
# that bought was worse than the turn it saved: the generate contract records project HEAD
# inside project-manifest.json, so amending to pick up the manifest changes the very hash the
# manifest just recorded. A run chased that fixpoint through ten amends, each producing a new
# HEAD, until the phase died on max_turns. No amend, no fixpoint: the model commits once and
# the recorded hash stays true.
# `git add <path>` is here because `git add -A` was the ONLY staging verb, and that makes the
# generate contract unsatisfiable: the phase must record project HEAD, and the files that hold
# the record (phase_complete.*.json, session_state.*.json) are inside the project, so `-A`
# sweeps them into the next commit and the hash it just recorded goes stale. Measured twice:
# the phase then re-commits to chase HEAD, gets GIT_COMMIT_MISSING again, and dies on
# max_turns having made three commits. Staging by path gives it a legal way to commit code and
# leave the record alone. The path is model-supplied but is executed as argv, never through a
# shell, and it can only touch the project it already writes to with file_operation.
_ALLOWED_SHELL_PREFIX: tuple[tuple[str, ...], ...] = (
    ("git", "commit", "-m"),
    ("git", "add"),
)
# `git init && git add -A && git commit -m "..."` is the longest real chain.
_MAX_SHELL_PARTS = 3

# Returned on every refusal so the model corrects instead of guessing. Built from the tables
# above, so a command cannot be permitted without the hint naming it, nor named without being
# permitted; test_serve.py asserts every advertised form actually runs.
def _prefix_placeholder(prefix: tuple[str, ...]) -> str:
    """What the model must put after an allowed prefix. A hint that called every trailing
    argument a "<message>" would advertise `git add "<message>"`, which is how a model learns
    to pass the wrong thing."""
    return "<message>" if prefix[-1] == "-m" else "<path>"


ALLOWED_SHELL_COMMANDS_HINT = (
    "Allowed shell commands: "
    + "; ".join(" ".join(argv) for argv in _ALLOWED_SHELL_ARGV)
    + "; " + "; ".join(f'{" ".join(prefix)} "{_prefix_placeholder(prefix)}"' for prefix in _ALLOWED_SHELL_PREFIX)
    + f". Chain at most {_MAX_SHELL_PARTS} of them with '&&'; no other operator is accepted."
    " There is no shell route for Python: interpreter=python runs BUNDLED PLUGIN SCRIPTS by"
    " name, not arbitrary modules. Linting is not yours to invoke either, run_quality_gates.py"
    " already runs flake8 over firmware/, test/, device/ and tools/ and reports it back."
)


def _resolve_allowed_shell_argv(tokens: list[str]) -> list[str] | None:
    """One `&&` part -> the argv to execute, or None when it is not permitted."""
    if tuple(tokens) in _ALLOWED_SHELL_ARGV:
        return list(tokens)
    for prefix in _ALLOWED_SHELL_PREFIX:
        if tuple(tokens[: len(prefix)]) != prefix:
            continue
        rest = [token.strip() for token in tokens[len(prefix):]]
        if not rest or not all(rest):
            continue
        # A commit message is ONE argument; staging takes as many paths as the caller names.
        # One path was the first version, and it refused the form a real run reached for:
        # staging the manifest and the session state together in a single call. That failure
        # pushes the model back toward `-A`, which sweeps the files recording HEAD into the
        # commit and stales the hash just written -- the exact trap this prefix exists to give
        # it a way around. Several paths widen nothing: they are executed as argv, never
        # through a shell, and reach only the project the model already writes to.
        if prefix[-1] == "-m" and len(rest) > 1:
            continue
        return [*prefix, *rest]
    return None


def _parse_v0_shell_command(command: str) -> list[list[str]] | None:
    """Split an allowed `&&` chain into argv lists, or None if ANY part is not permitted.

    Each part is validated on its own and executed as argv, never handed to a shell, so a
    chain cannot smuggle a command past the allowlist by position.
    """
    cmd = str(command or "").strip()
    if not cmd or any(ch in cmd for ch in (";", "|", "<", ">", "`", "\n", "\r", "\0")):
        return None
    parts = [part.strip() for part in cmd.split("&&")]
    if not 1 <= len(parts) <= _MAX_SHELL_PARTS:
        return None
    resolved: list[list[str]] = []
    for part in parts:
        try:
            tokens = shlex.split(part, posix=True)
        except ValueError:
            return None
        argv = _resolve_allowed_shell_argv(tokens)
        if argv is None:
            return None
        resolved.append(argv)
    return resolved


# ---------- firmware/ upload exclusion (shared by device.deploy_firmware_tree and
# project.export_upload_ready) ----------
# Defined ONCE so a device deploy and the upload_ready/ export can never drift on what
# belongs on the board: driver test doubles, Python bytecode caches, and directory
# placeholders never reach it, anywhere in the tree. A flash/interpreter image
# (.uf2/.bin/.hex) is a flash-phase input, never a device-fs file -- but ONLY at
# firmware/'s TOP LEVEL, where a flash image actually lands (the source screenshot this
# rule was written from: a RPI_PICO-*.uf2 sitting directly in firmware/). A .bin/.hex
# NESTED under firmware/ (firmware/lib/, firmware/drivers/) is a legitimate device-side
# driver asset instead -- e.g. GraftSense-Drivers-MicroPython's bma423_driver ships
# bma423conf.bin next to its .py and reads it back from the device filesystem at
# runtime; excluding it anywhere in the tree silently breaks that driver post-deploy.
_FIRMWARE_EXCLUDE_DIR_NAMES = ("__pycache__",)
_FIRMWARE_EXCLUDE_EXACT_NAMES = (".gitkeep",)
_FIRMWARE_EXCLUDE_NAME_GLOBS = ("*.pyc",)
_FIRMWARE_EXCLUDE_TOP_LEVEL_GLOBS = ("*.uf2", "*.bin", "*.hex")
_FIRMWARE_EXCLUDE_PATH_GLOBS = ("drivers/*/mock.py", "drivers/*/mock.mpy")


def iter_uploadable_firmware(firmware_dir: str):
    """Walk firmware_dir yielding (src, rel) for every file that belongs on the device.
    rel is posix-normalized (relative to firmware_dir) so the SEPARATORS match both the
    mpremote ':' target path and the exclusion globs identically on Windows and POSIX.

    Case does NOT match across platforms: fnmatch folds through os.path.normcase, so a
    top-level FIRMWARE.BIN is excluded on Windows and kept on macOS/Linux. Left as-is
    deliberately -- flash images and mock files ship lowercase in every tree this filters,
    and forcing one behavior would either start excluding user files on POSIX or start
    shipping flash images on Windows. Both sinks (export and deploy) use this one iterator,
    so the two can never disagree with each other on the same machine."""
    for root, dirs, files in os.walk(firmware_dir):
        dirs[:] = [d for d in dirs if d not in _FIRMWARE_EXCLUDE_DIR_NAMES]
        for name in files:
            if name in _FIRMWARE_EXCLUDE_EXACT_NAMES:
                continue
            if any(fnmatch.fnmatch(name, pattern) for pattern in _FIRMWARE_EXCLUDE_NAME_GLOBS):
                continue
            src = os.path.join(root, name)
            rel = os.path.relpath(src, firmware_dir).replace("\\", "/")
            if "/" not in rel and any(fnmatch.fnmatch(name, pattern) for pattern in _FIRMWARE_EXCLUDE_TOP_LEVEL_GLOBS):
                continue
            if any(fnmatch.fnmatch(rel, pattern) for pattern in _FIRMWARE_EXCLUDE_PATH_GLOBS):
                continue
            yield src, rel


# Every mpremote call goes through the launcher beside this file, which adds a boot settle
# for boards that reset when the port is opened (see mpremote_launcher.py). The swap happens
# HERE, at the subprocess boundary, so the command lists the shim builds and records stay
# `["mpremote", ...]` -- what they name is the tool, not the interpreter that hosts it.
_MPREMOTE_LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mpremote_launcher.py")


def _names_mpremote(argv0: str) -> bool:
    """True when argv0 invokes mpremote, whatever spelling the caller used.

    Matching the bare string alone let an absolute path through: a deploy resolved mpremote
    with shutil.which() and ran /…/venv/bin/mpremote, which skipped the settle and failed
    every call with "could not enter raw repl" on a board that resets when the port opens.
    """
    # Split on both separators rather than os.path.basename: the host running this shim is not
    # necessarily the host that spelled the path, and a backslash path read on POSIX would come
    # back whole and match nothing.
    name = re.split(r"[\\/]", argv0)[-1].lower()
    return name[:-4] == "mpremote" if name.endswith(".exe") else name == "mpremote"


def _with_mpremote_launcher(command):
    if not command or not _names_mpremote(command[0]):
        return command
    return [sys.executable, _MPREMOTE_LAUNCHER, *command[1:]]


def _mpremote_env_command():
    """The UPY_MPREMOTE value that routes the deploy plugin's own mpremote through the launcher.

    The plugin resolves mpremote itself and spawns it directly, so it never crosses this shim's
    subprocess boundary and the swap above cannot reach it. It does read UPY_MPREMOTE first,
    which is the one hook that does reach it.

    None when the value would not survive the plugin's own splitter. It splits with
    shlex.split(posix=os.name != "nt"), and posix=False keeps the quotes it finds, so a Windows
    path containing a space cannot be expressed at all. Leaving the variable unset falls back to
    the plugin's shutil.which(), and on Windows mpremote already applies this reset workaround
    itself -- it is macOS and Linux that get nothing.
    """
    parts = [sys.executable, _MPREMOTE_LAUNCHER]
    posix = os.name != "nt"
    value = shlex.join(parts) if posix else subprocess.list2cmdline(parts)
    return value if shlex.split(value, posix=posix) == parts else None


def _run_command(command, **kwargs):
    return subprocess.run(_with_mpremote_launcher(command), **kwargs)



_FLAGS_CACHE: dict[str, list[str]] = {}


def _accepted_flags(script_path: str) -> list[str]:
    """The long options a bundled script accepts, read straight from its argparse calls.

    Why: models spend turns running `<script> --help` to learn signatures -- 47 such probes
    across the archived runs, 8 in a single deploy phase. Every one measured followed a call
    that had ALREADY SUCCEEDED, so this is not error recovery: it is the model checking whether
    it missed a flag before the next invocation. Handing it the list with the result removes the
    reason to ask. Parsed statically rather than by running --help, so it costs a cached file
    read instead of a subprocess.
    """
    cached = _FLAGS_CACHE.get(script_path)
    if cached is not None:
        return cached
    flags: list[str] = []
    try:
        with open(script_path, "r", encoding="utf-8", errors="replace") as handle:
            flags = sorted(set(re.findall(r'add_argument\(\s*"(--[a-z0-9-]+)"', handle.read())))
    except OSError:
        # A script we cannot read is not worth failing the call over; the model just gets no hint.
        flags = []
    _FLAGS_CACHE[script_path] = flags
    return flags


class Shim:
    def __init__(self, runner=None, serial_factory=None):
        self.runner = runner or _run_command
        self.serial_factory = serial_factory
        self.commands: list[list[str]] = []
        # Background serial monitor session (serial.monitor_start/stop): a single open
        # port read continuously on its own thread, pushing serial.data notifications
        # instead of returning through the bounded request/response RPC. Guarded by its
        # own lock so start/stop can't race a concurrent call from another RPC turn.
        self._monitor_lock = threading.Lock()
        self._monitor_thread: threading.Thread | None = None
        self._monitor_stop: threading.Event | None = None
        self._monitor_ser = None

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
        # iter_uploadable_firmware (not a bare os.walk) so mock.py/mock.mpy driver test
        # doubles, __pycache__/*.pyc, and flash images (*.uf2/*.bin/*.hex) never reach the
        # board -- previously only .gitkeep was skipped here, shipping all of those.
        if not os.path.isdir(firmware_dir):
            return {"status": "error", "error_kind": "firmware_dir_missing"}
        entries = list(iter_uploadable_firmware(firmware_dir))
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
        # Every complete line seen during the read window, matched or not — the deploy
        # verification read is the only thing that ever reads the port, so a print()
        # between markers would otherwise be silently dropped instead of reaching the
        # Serial page. `matched`/`lines` (the marker-grading contract the agent loop
        # reads via lines.at(-1)+ok) stays exactly as before.
        all_lines: list[str] = []
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
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    all_lines.append(line)
                    if len(matched) < len(markers) and markers[len(matched)] in line:
                        matched.append(line)
            # Flush a trailing marker (or trailing print output) emitted without a
            # newline before the deadline.
            tail = buffer.strip()
            if tail:
                all_lines.append(tail)
                if len(matched) < len(markers) and markers[len(matched)] in tail:
                    matched.append(tail)
        if len(matched) < len(markers):
            return {"ok": False, "error": "timeout", "lines": matched, "all_lines": all_lines}
        return {"ok": True, "lines": matched, "all_lines": all_lines}

    def monitor_start(self, port: str, baud: int = 115200):
        # A live REPL/stdout stream between runs (the Serial page's Start/Stop monitor):
        # unlike serial_read_until, this stays open until monitor_stop, pushing every
        # line it reads as a serial.data notification. Refuse a second start rather than
        # silently replacing the running session — the host enforces one monitor at a
        # time via the port-ownership queue, so a second start here means the host state
        # and the shim's are already out of sync.
        with self._monitor_lock:
            if self._monitor_thread is not None and self._monitor_thread.is_alive():
                return {"status": "error", "error_kind": "monitor_already_running"}
            factory = self.serial_factory
            if factory is None:
                import serial

                factory = serial.Serial
            try:
                ser = factory(port, baud, timeout=0.1)
            except Exception as exc:  # noqa: BLE001 — a closed/busy/nonexistent port must error, never hang
                return {"status": "error", "error_kind": "port_open_failed", "message": str(exc)}
            stop_event = threading.Event()
            self._monitor_ser = ser
            self._monitor_stop = stop_event
            self._monitor_thread = threading.Thread(target=self._monitor_read_loop, args=(ser, stop_event), daemon=True)
            self._monitor_thread.start()
            return {"status": "ok"}

    def monitor_stop(self, join_timeout: float = 2.0):
        with self._monitor_lock:
            thread = self._monitor_thread
            stop_event = self._monitor_stop
            ser = self._monitor_ser
        if stop_event is None:
            return {"status": "ok"}  # idempotent: nothing running is not an error
        stop_event.set()
        # Force a blocked readline() to unblock: closing the port makes most serial
        # backends raise immediately, so the reader thread exits even if it would
        # otherwise sit past its own read timeout.
        if ser is not None:
            try:
                ser.close()
            except Exception:  # noqa: BLE001 — best-effort, the port may already be gone
                pass
        if thread is not None:
            thread.join(timeout=join_timeout)
            if thread.is_alive():
                # The reader thread did not exit in time. Do NOT clear the monitor
                # state here: monitor_start's is_alive() guard must keep refusing a
                # second open, or a new session would race a still-running thread for
                # the same port instead of the caller retrying the stop.
                return {"status": "error", "error_kind": "monitor_stop_timed_out"}
        with self._monitor_lock:
            self._monitor_thread = None
            self._monitor_stop = None
            self._monitor_ser = None
        return {"status": "ok"}

    # A device that emits bytes with no newline (binary spew, a stuck print(end=""))
    # must not grow this buffer without bound for the life of the monitor session.
    # Flushed as a synthetic "line" past this size — matches nothing readable coming
    # back, but bounds memory instead of accumulating forever.
    _MONITOR_BUFFER_CAP = 8192

    def _monitor_read_loop(self, ser, stop_event):
        # Buffer BYTES and decode only complete lines: decoding per read chunk (the old
        # `readline().decode(errors="ignore")`) silently dropped a multi-byte character
        # split across the 0.1s read-timeout boundary -- both halves fail the decode and
        # "ignore" eats them, which loses characters from exactly the non-ASCII print()
        # output this product's users emit. A complete line decodes as one unit, and
        # errors="replace" makes genuinely invalid bytes VISIBLE as U+FFFD instead of
        # vanishing.
        buffer = b""
        died = None

        def emit(raw):
            line = raw.decode(errors="replace").strip()
            if line:
                _notify("serial.data", {"lines": [line]})

        try:
            while not stop_event.is_set():
                try:
                    chunk = ser.readline()
                except Exception as exc:  # noqa: BLE001 — an unplugged/errored port ends the loop, not the shim
                    # monitor_stop() sets stop_event BEFORE closing the port, and
                    # closing a real pyserial port makes a readline() in progress
                    # raise -- so an intentional stop routinely hits this except
                    # branch too. Only a read failing while NOBODY asked to stop is a
                    # genuine unplugged/errored death worth telling the host about;
                    # otherwise every ordinary stop would misreport monitor_ended.
                    if not stop_event.is_set():
                        died = exc
                    break
                if not chunk:
                    # A real serial timeout (no data, no error) — not stop_event-driven,
                    # so briefly wait on it instead of a bare `continue`, which would
                    # otherwise busy-spin a full CPU core for the life of the session on
                    # a port that returns b"" without raising (its read timeout is 0.1s,
                    # but nothing guarantees every backend blocks for that long).
                    stop_event.wait(0.01)
                    continue
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    emit(raw)
                if len(buffer) > self._MONITOR_BUFFER_CAP:
                    raw, buffer = buffer, b""
                    emit(raw)
        finally:
            # Flush the trailing partial line BEFORE anything else: a board whose last
            # output is sys.stdout.write("READY") -- no newline -- otherwise never shows
            # it on the Serial page unless it happened to exceed the buffer cap.
            emit(buffer)
            try:
                ser.close()
            except Exception:  # noqa: BLE001 — best-effort close, the port may already be gone
                pass
            # A stop_event-driven exit is intentional (monitor_stop already told the
            # host); only an unplugged/errored port dying on its own needs to notify
            # the host, or the Start/Stop button is stuck showing a monitor that
            # silently ended.
            if died is not None:
                _notify("serial.monitor_ended", {"reason": str(died)})

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
        # stdin=DEVNULL when the caller supplied none. subprocess.run(input=None) does NOT give
        # the child a pipe: it INHERITS the parent's stdin, and this shim reads its own JSON-RPC
        # protocol from sys.stdin. So a script invoked with --stdin and no stdin_content would
        # sit reading the extension's RPC stream until the timeout killed it, and could swallow
        # protocol messages on the way. Measured across archived runs: 17 timeouts on --stdin
        # invocations, the single largest source of dead turns outside hardware.
        if stdin is None:
            return self.runner(cmd, timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL, **_subprocess_text_kwargs())
        return self.runner(cmd, timeout=timeout, cwd=cwd, input=stdin, **_subprocess_text_kwargs())

    def run_v0_module(self, module: str, args: list[str], cwd=None, stdin=None, timeout: float = 300):
        # `python -m <module>` for the verification modules the phase is allowed to run
        # directly. Same interpreter, same stdin discipline and same injectable runner as
        # run_v0_python: only the target differs, so a module call cannot reach anything a
        # script call could not.
        # A verification module must leave the project exactly as it found it. Measured on the
        # first run with this route open: one `py_compile` call produced 13
        # PROJECT_PYTHON_CACHE_PRESENT errors at the next quality gate and five more calls
        # deleting __pycache__, in a phase that then ran out of turns.
        #
        # -B alone does NOT fix it, which a filesystem-level test caught: -B suppresses the
        # IMPLICIT caching done on import, while py_compile writes a .pyc as its entire purpose.
        # PYTHONPYCACHEPREFIX is what redirects that write, so the bytecode lands in a temp tree
        # instead of beside the sources, and py_compile still reports syntax errors normally.
        cmd = [sys.executable, "-B", "-m", module, *args]
        self.commands.append(cmd)
        # Merged into the shared kwargs rather than passed alongside them: those already carry
        # an `env` (PYTHONIOENCODING), and a second one is a TypeError, not an override.
        kwargs = _subprocess_text_kwargs()
        # One cache tree for the process, not one per call. A fresh mkdtemp on every module run
        # leaked a directory each time and a generate phase makes dozens of them; the bytecode is
        # keyed by source path inside the tree, so sharing it is also faster on repeat compiles.
        kwargs["env"] = {**kwargs["env"], "PYTHONPYCACHEPREFIX": _module_pycache_dir()}
        if stdin is None:
            return self.runner(cmd, timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL, **kwargs)
        return self.runner(cmd, timeout=timeout, cwd=cwd, input=stdin, **kwargs)

    def run_v0_shell(self, command: str, cwd=None, stdin=None, timeout: float = 300):
        # V0 generate emits script_run(shell, 'git add -A && git commit -m "..."') and a few
        # other git forms. Do not pass that string to a host shell; execute each allowed argv
        # directly so chained shell metacharacters never run.
        commands = _parse_v0_shell_command(command)
        if commands is None:
            raise ValueError("shell_command_not_allowed")
        last = None
        for cmd in commands:
            if cmd == ["git", "init"] and self._inside_work_tree(cwd, timeout):
                # The opened folder is commonly a SUBDIRECTORY of the user's own repo
                # (repo/projects/my-blinky). `git init` there creates a nested repository,
                # and the parent silently stops tracking that whole subtree -- a mutation of
                # the user's version control that they never asked for and would not think
                # to look for. Every other destructive host operation the model can reach is
                # gated (guardOverwrite / guardDelete / confirmDeviceDelete); this one was
                # not. The contract only needs the project to BE in a work tree, and it
                # already is, so report that and move on instead of creating a second repo.
                last = subprocess.CompletedProcess(
                    cmd, 0,
                    stdout="Skipped by the host: already inside a git work tree, so no repository was created.\n",
                    stderr="",
                )
                continue
            self.commands.append(cmd)
            # Same reason as run_v0_python: never let a child inherit the shim's RPC stdin.
            last = (self.runner(cmd, timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL, **_subprocess_text_kwargs())
                    if stdin is None
                    else self.runner(cmd, timeout=timeout, cwd=cwd, input=stdin, **_subprocess_text_kwargs()))
            if getattr(last, "returncode", 1) != 0:
                return last
        return last

    def _inside_work_tree(self, cwd, timeout: float) -> bool:
        """True when cwd already sits inside a git work tree.

        Goes through self.runner like every other command, so the probe is visible to the
        injected fake in tests. A probe that cannot run (git absent, non-zero, anything
        unexpected) answers False: that is the pre-existing behaviour -- `git init` runs --
        so a broken probe can never block a legitimate init on a fresh project.
        """
        cmd = ["git", "rev-parse", "--is-inside-work-tree"]
        self.commands.append(cmd)
        probe = self.runner(cmd, timeout=timeout, cwd=cwd, **_subprocess_text_kwargs())
        return getattr(probe, "returncode", 1) == 0 and str(getattr(probe, "stdout", "")).strip() == "true"

    def _run(self, command: list[str], timeout: float = 30):
        self.commands.append(command)
        return self.runner(command, timeout=timeout, **_subprocess_text_kwargs())


# ---------- stdio JSON-RPC server (entry point the VS Code extension spawns) ----------
# Only newline-delimited JSON-RPC goes to stdout; diagnostics go to stderr.

def _run_mpremote(args, timeout=30):
    return _run_command(["mpremote", *args], capture_output=True, text=True, timeout=timeout)


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


# ---------- project.export_upload_ready ----------
# Regenerate <project_dir>/upload_ready/: a filter-copy of firmware/ (the same exclusion
# predicate deploy_firmware_tree uses) plus a README documenting mip installs, so a user
# who lost their board program can restore it from one folder without guessing which
# files belong on the device. Filesystem-only -- no mpremote, no port, works with no
# device connected.

def _unwrap_manifest(data):
    """A project-manifest.json read off disk is always the bare manifest, but some
    callers pass through a phase-envelope shape (manifest_content / manifest, possibly
    nested under payload). Mirrors upy-deploy-plugin/scripts/install_mip_dependencies.py's
    unwrap_manifest so this reader and the canonical mip installer agree on where the
    real manifest lives."""
    if not isinstance(data, dict):
        return {}
    payload = data.get("payload")
    if isinstance(payload, dict):
        for key in ("manifest_content", "manifest"):
            manifest = payload.get(key)
            if isinstance(manifest, dict):
                return manifest
    for key in ("manifest_content", "manifest"):
        manifest = data.get(key)
        if isinstance(manifest, dict):
            return manifest
    return data


def _read_project_manifest(project_dir: str):
    """Read project-manifest.json. Returns (manifest_or_None, error_or_None). A missing
    manifest is a normal "nothing generated yet" state (ENOENT swallowed -> no external
    packages); any OTHER read failure (EACCES, a directory in its place, malformed JSON,
    ...) must fail the export rather than silently reporting "no deps"."""
    path = os.path.join(project_dir, "project-manifest.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return None, None
    # UnicodeDecodeError is a ValueError, NOT an OSError and NOT a JSONDecodeError, so a
    # non-UTF-8 manifest used to escape this handler entirely and surface as a generic shim
    # error instead of manifest_read_failed. Nothing destructive has run at that point, so
    # the export was safe either way -- what was lost was the error KIND the caller reports.
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return None, str(exc)
    return _unwrap_manifest(raw), None


def _runtime_dependencies(manifest):
    """Mirrors install_mip_dependencies.py's runtime_dependencies precedence: a
    top-level runtime_dependencies wins when present (the mip installer's own merge can
    promote it there); generate.runtime_dependencies is the fallback. Reading only the
    nested location -- as this export originally did -- silently reports "no external
    packages" for a manifest shaped the first way."""
    if not isinstance(manifest, dict):
        return {}
    direct = manifest.get("runtime_dependencies")
    if isinstance(direct, dict):
        return direct
    generate = manifest.get("generate")
    if isinstance(generate, dict) and isinstance(generate.get("runtime_dependencies"), dict):
        return generate["runtime_dependencies"]
    return {}


def _normalize_mip_entry(item):
    """A raw mip[] entry is a bare package-name string OR an object (both are contract-
    legal -- see install_mip_dependencies.py's normalize_mip_entry). Never raises: an
    unrecognized shape (not a str, not a dict, or a dict with no usable package) returns
    None and is dropped, so a malformed manifest degrades the README rather than crashing
    the export after upload_ready/ has already been wiped. verify_import is always
    coerced to a string (defaulting from package, exactly like the canonical) -- left
    raw, a non-scalar value (a list/dict) is unhashable and crashes the dedup below, and
    the string-vs-object form of the same package would fail to dedup against each other.
    """
    if isinstance(item, str):
        package = item.strip()
        if not package:
            return None
        return {"package": package, "target": "/lib", "version": "latest", "verify_import": package.replace("-", "_")}
    if not isinstance(item, dict):
        return None
    package = str(item.get("package") or "").strip()
    if not package:
        return None
    entry = dict(item)
    entry["package"] = package
    entry["target"] = str(item.get("target") or "/lib").strip() or "/lib"
    # Stripped like every sibling field above and below. version was the ONE field left
    # unstripped, and that asymmetry was the whole reachability of the trailing-newline
    # case: "1.3.4\n" is a fully recoverable intent, so recover it rather than failing the
    # charset and demoting the package to an "install manually" bullet. The charset stays
    # as the gate for genuinely hostile input, which is what it is for.
    entry["version"] = str(item.get("version") or "latest").strip() or "latest"
    entry["verify_import"] = str(item.get("verify_import") or package.replace("-", "_")).strip()
    return entry


def _mip_entries(manifest):
    raw = _runtime_dependencies(manifest).get("mip")
    if not isinstance(raw, list):
        return []
    entries = []
    seen = set()
    for item in raw:
        entry = _normalize_mip_entry(item)
        if entry is None:
            continue
        # Matches install_mip_dependencies.py's dedup key: two mip[] entries for the same
        # package are the same install regardless of a differing (often absent) version.
        # verify_import is now always populated by _normalize_mip_entry, so the string
        # and object forms of the same package dedup against each other correctly.
        key = (entry["package"], entry.get("verify_import") or "", entry.get("target"))
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)
    return entries


# A mip package spec (or version) as it will be pasted into a terminal: a bare name, a
# github:org/repo/pkg spec, a full URL, or a dotted/semver version. Anything outside this
# charset (a newline, a shell metacharacter, a markdown fence) is refused rather than
# embedded verbatim in the README's copy-paste command block -- the manifest is
# model-written, and the README is a document a user is instructed to run as-is.
#
# \Z, not $: `$` also matches immediately BEFORE a single trailing newline, so "aioble\n"
# satisfied the charset and carried a stray blank line into the fenced block. That could
# never form a fence or a second command (nothing may follow the newline), so this is the
# claim above being made true rather than a hole being closed.
_MIP_SPEC_SAFE_RE = re.compile(r"\A[A-Za-z0-9_.:/@-]+\Z")


def _mip_install_line(entry):
    package = entry.get("package") or ""
    if not _MIP_SPEC_SAFE_RE.match(package):
        return None
    version = entry.get("version")
    # A URL-shaped package spec is used verbatim -- mip resolves its version from the
    # URL itself, so appending "@version" to it would not be a valid mip argument.
    if "://" not in package and version and version != "latest":
        version = str(version)
        if not _MIP_SPEC_SAFE_RE.match(version):
            return None  # an unsafe version must not taint an otherwise-safe package
        package = f"{package}@{version}"
    return f"mpremote connect <port> mip install {package}"


def _readme_inline_text(value):
    """Any manifest-derived string rendered as README prose (mcu.model, a rejected mip
    package spec, target/verify_import/asset_files) -- as opposed to a string validated
    against _MIP_SPEC_SAFE_RE and placed inside a fenced command block. Strips every
    character that could restructure the document around it: newlines/carriage returns
    (a fresh markdown line, including a fresh ``` fence), backticks (open/close a fence
    mid-line), and '<'/'>' (raw HTML/script that CommonMark passes through live in a
    plain bullet -- an <img onerror=...> renders as a real tag, not text; removing both
    characters entirely also means "-->" can no longer form at all, so it can't close
    the header's own HTML comment early either -- no separate case for that)."""
    text = str(value).replace("\r", " ").replace("\n", " ").replace("`", "'")
    return text.replace("<", "").replace(">", "").strip()


def _remove_export_scratch(path: str, *, best_effort: bool = False) -> None:
    """Drop a staging/backup sibling of upload_ready/, if one is there.

    Only ever called on the two scratch paths the export owns, and only after the caller
    has refused a symlink or a non-directory at them, so this cannot delete through a link
    or remove a user file. A leftover from an interrupted earlier run is expected, not an
    error: the caller clears staging before building and backup after a successful swap.

    best_effort is for cleanup on an ALREADY-failing path, where an rmtree error would
    replace the real diagnosis with a confusing one about a scratch directory. It is never
    used on the success path: there, a failure to remove the backup is a real problem and
    must surface.
    """
    if os.path.islink(path) or not os.path.isdir(path):
        return
    try:
        shutil.rmtree(path)
    except OSError:
        if not best_effort:
            raise


def _build_upload_ready_readme(manifest, timestamp, device_entries):
    mcu_field = manifest.get("mcu") if isinstance(manifest, dict) else None
    mcu_model = mcu_field.get("model") if isinstance(mcu_field, dict) else None
    mcu = _readme_inline_text(mcu_model) if mcu_model else ""
    mcu = mcu or "unknown"
    lines = [
        "<!-- Generated by Blockless. Do not edit -- regenerate from the extension instead. -->",
        f"<!-- Generated: {timestamp} -->",
        f"<!-- Board / MCU: {mcu} -->",
        "",
        "# upload_ready",
        "",
    ]
    if device_entries:
        # Name the device files explicitly instead of `./*`: the glob would also upload
        # THIS instructions file onto the constrained device filesystem, and PowerShell/
        # cmd never expanded it for mpremote anyway -- explicit names work in every shell.
        command_entries = " ".join(
            f'"{name}"' if any(ch.isspace() for ch in name) else name for name in device_entries
        )
        lines += [
            "Upload the device files to the device root (run from inside this folder):",
            "",
            "```",
            f"mpremote connect <port> fs cp -r {command_entries} :",
            "```",
            "",
            "(Only the device files are named, so this instructions file stays on the PC.)",
        ]
    else:
        lines += ["The firmware folder contained no uploadable device files."]
    entries = _mip_entries(manifest)
    if manifest is None:
        # A missing manifest is a normal pre-manifest project, but "No external packages
        # required." would be a claim the tool cannot make -- say what is actually known.
        lines += [
            "",
            "No project-manifest.json was found, so the external-package list could not",
            "be derived. If the code imports packages that are not on the board (e.g.",
            "aioble), install them with `mpremote mip install <package>` first.",
        ]
    elif not entries:
        lines += ["", "No external packages required."]
    else:
        lines += ["", "External packages (install after the copy above):"]
        for entry in entries:
            install_line = _mip_install_line(entry)
            if install_line is None:
                safe_spec = _readme_inline_text(entry["package"])
                lines += ["", f"- {safe_spec}: unrecognized package spec -- install manually via mip."]
                continue
            lines += ["", "```", install_line, "```"]
            details = []
            target = entry.get("target")
            if isinstance(target, str) and target:
                details.append(f"target: {_readme_inline_text(target)}")
            verify = entry.get("verify_import")
            if isinstance(verify, str) and verify:
                details.append(f"verify: import {_readme_inline_text(verify)}")
            assets = entry.get("asset_files")
            if isinstance(assets, list) and assets:
                details.append("assets: " + ", ".join(_readme_inline_text(a) for a in assets))
            if details:
                lines.append("- " + "; ".join(details))
    return "\n".join(lines).rstrip() + "\n"


def _export_upload_ready(project_dir: str):
    firmware_dir = os.path.join(project_dir, "firmware")
    export_dir = os.path.join(project_dir, "upload_ready")
    if not os.path.isdir(firmware_dir):
        return {"status": "error", "error_kind": "firmware_dir_missing"}
    # A pre-planted symlink AT the export path is refused outright: rmtree-ing through
    # it would delete whatever it points at, not a stale export -- the target must stay
    # untouched, not just "not followed". A regular FILE where upload_ready/ should be a
    # directory is refused the same way -- shutil.rmtree cannot remove it, and silently
    # deleting an unrelated file the tool never created is not this tool's call to make.
    if os.path.islink(export_dir):
        return {"status": "error", "error_kind": "export_dir_is_symlink"}
    if os.path.exists(export_dir) and not os.path.isdir(export_dir):
        return {"status": "error", "error_kind": "export_dir_not_a_directory"}
    # The staging/backup siblings get the SAME refusal: this routine rmtree-s them, and a
    # pre-planted symlink at either path would delete whatever it points at.
    for scratch in (export_dir + ".staging", export_dir + ".previous"):
        if os.path.islink(scratch):
            return {"status": "error", "error_kind": "export_dir_is_symlink"}
        if os.path.exists(scratch) and not os.path.isdir(scratch):
            return {"status": "error", "error_kind": "export_dir_not_a_directory"}
    # Real-path containment (mirrors isRealContained on the TS side): firmware_dir and
    # export_dir must both resolve under project_dir even through symlinks, checked
    # BEFORE anything destructive touches export_dir.
    # Staging and backup siblings of the export. The new tree is built in staging and only
    # swapped in once it is COMPLETE, so a failure mid-copy leaves the previous export intact
    # instead of a partial folder that looks whole. That matters more here than for most
    # tools: this folder's whole purpose is restoring a board, and uploading a silently
    # partial one produces a broken device. Siblings, so the renames stay on one filesystem.
    staging_dir = export_dir + ".staging"
    backup_dir = export_dir + ".previous"
    project_real = os.path.realpath(project_dir)
    for candidate in (firmware_dir, export_dir, staging_dir, backup_dir):
        candidate_real = os.path.realpath(candidate)
        if candidate_real != project_real and not candidate_real.startswith(project_real + os.sep):
            return {"status": "error", "error_kind": "path_outside_project"}
    # Resolve the manifest (and fail on a real read error) before touching the old
    # export, so a broken manifest never leaves a half-destroyed upload_ready/ behind.
    manifest, manifest_error = _read_project_manifest(project_dir)
    if manifest_error is not None:
        return {"status": "error", "error_kind": "manifest_read_failed", "message": manifest_error}
    mip_entries = _mip_entries(manifest)
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    # Build the whole tree in staging first. Everything below this point that can raise
    # (a full disk, EACCES, a source file removed mid-walk) now costs only the staging
    # copy: the previous export is not touched until the swap at the end.
    _remove_export_scratch(staging_dir)
    file_count = 0
    try:
        os.makedirs(staging_dir, exist_ok=True)
        for src, rel in iter_uploadable_firmware(firmware_dir):
            dest = os.path.join(staging_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(src, dest)
            file_count += 1
        # The staging top level at this moment is exactly the device files (the
        # instructions file is only written below), so the README's upload command lists
        # them explicitly and never itself. Building the body here is as safe as building
        # it up front: every manifest field it reads is isinstance-guarded (never raises),
        # and on any failure in this try the previous export is still untouched.
        readme_body = _build_upload_ready_readme(manifest, timestamp, sorted(os.listdir(staging_dir)))
    # firmware/README.md is a legitimate device file (never excluded -- it is what
    # deploy_firmware_tree uploads); the generated instructions must not clobber it, or
    # the export stops being "folder == device image". Checked via os.path.exists (not a
    # single rel == "README.md" comparison from the copy loop above) so this also covers
    # a case-INsensitive filesystem (Readme.md), a firmware/ that already ships its own
    # UPLOAD_INSTRUCTIONS.md, and a firmware/README.md/ that is itself a directory (the
    # copy loop above would have created export_dir/README.md as a directory via a
    # nested file inside it -- opening "w" over that raises IsADirectoryError).
        readme_name = "README.md"
        if os.path.exists(os.path.join(staging_dir, readme_name)):
            readme_name = "UPLOAD_INSTRUCTIONS.md"
            suffix = 2
            while os.path.exists(os.path.join(staging_dir, readme_name)):
                readme_name = f"UPLOAD_INSTRUCTIONS ({suffix}).md"
                suffix += 1
        with open(os.path.join(staging_dir, readme_name), "w", encoding="utf-8") as handle:
            handle.write(readme_body)
    except OSError as exc:
        # The previous export was never touched, so the user still has a working folder.
        # Cleanup is best-effort HERE only: letting an rmtree error escape would replace the
        # real diagnosis with a confusing one about a scratch directory.
        _remove_export_scratch(staging_dir, best_effort=True)
        return {"status": "error", "error_kind": "export_write_failed", "message": str(exc)}
    # Swap. The old tree moves aside rather than being deleted first, so a failed rename
    # can put it back: at no point is the user left with neither a complete old export nor
    # a complete new one.
    had_previous = os.path.isdir(export_dir)
    try:
        if had_previous:
            _remove_export_scratch(backup_dir)
            os.rename(export_dir, backup_dir)
        os.rename(staging_dir, export_dir)
    except OSError as exc:
        # The rollback can itself fail (a race recreating export_dir, a permission change).
        # Letting THAT escape would strand the user's only complete export under a name they
        # have never heard of and hand them a generic RPC error, so it gets its own handler
        # and its own error_kind that says where the folder is.
        stranded_at = None
        if had_previous and not os.path.exists(export_dir) and os.path.isdir(backup_dir):
            try:
                os.rename(backup_dir, export_dir)
            except OSError:
                stranded_at = backup_dir
        _remove_export_scratch(staging_dir, best_effort=True)
        if stranded_at is not None:
            return {
                "status": "error", "error_kind": "export_rollback_failed", "path": stranded_at,
                "message": f"Could not restore the previous export. It is intact at {stranded_at}; rename it back to upload_ready. Original failure: {exc}",
            }
        return {"status": "error", "error_kind": "export_swap_failed", "message": str(exc)}
    # The export IS installed by this point: both renames succeeded and upload_ready/ is
    # complete. Dropping the backup is housekeeping, so a failure here must not turn a
    # successful export into export_failed and send the user to retry something that already
    # worked. Reported instead of swallowed: the leftover is a real directory they may want
    # to remove, it is just not a failure of what they asked for.
    leftover = None
    try:
        _remove_export_scratch(backup_dir)
    except OSError:
        leftover = backup_dir
    result = {"status": "ok", "path": export_dir, "file_count": file_count, "mip_count": len(mip_entries)}
    if leftover is not None:
        result["leftover"] = leftover
    return result


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


# Scripts that fall back to <session_dir>/project when no project root is given, so they read
# or write the WRONG tree unless we name ours: apply_scaffold.py (it WRITES the tree there),
# check_session_state.py and session_chain_validate.py (they read it).
# session_chain_validate.py is why this must not be maintained from memory -- it was missing
# from this tuple, and its forbidden_project_artifacts() returns [] for a directory that does
# not exist, so the chain validator reported a clean green about a tree it never looked at.
# test_serve.py derives the same set from the bundled scripts and fails when this drifts.
_PROJECT_ROOT_SCRIPTS = ("apply_scaffold.py", "check_session_state.py", "session_chain_validate.py")


def _assert_project_root(base: str, args: list, cwd: str | None) -> list:
    # The scaffold SKILL keeps project_root=<session_root>/project "unless the caller
    # explicitly provides another project root". We are that caller and we never said so,
    # so the model sent --session-dir . and the scaffold built a SECOND tree one level
    # down, while its own file_operation writes landed at our root. Deploy and the
    # upload_ready export read our root, so everything scaffold-only (boot.py, lib/,
    # drivers/) was silently missing from the device.
    #
    # Say it explicitly, and only when the model did not: argparse takes the last value,
    # so appending over a model-supplied root would override a deliberate choice.
    if not cwd or not base.endswith(_PROJECT_ROOT_SCRIPTS):
        return args
    if any(a == "--project-dir" or str(a).startswith("--project-dir=") for a in args):
        return args
    return [*args, "--project-dir", cwd]


# Modules the phase may run directly with `python -m`. Verification tools only: they read the
# project and report, and every one of them is already part of run_quality_gates.py, so this
# widens what the model can CHECK without widening what it can change.
#
# Measured: models reach for these between gate runs to check their own work, in three
# spellings (`script="-m flake8"`, `script="-m unittest"` with args, and the shell form), and
# every one was refused as script_not_found. One run spent three consecutive turns finding a
# spelling the shim would take, and never did. Refusing costs turns and teaches nothing.
#
# Deliberately NOT here: pip, ensurepip, venv, http.server -- anything that installs, serves or
# mutates. The refusal message names the allowed set and points at run_quality_gates.py.
#
# PYLINT IS NOT HERE EITHER, and it is the one worth explaining, because it looks like the most
# natural member of a lint allowlist and was on this list until a review asked the right question.
# Pylint runs `init-hook`, arbitrary Python, before it analyses anything. It takes it from
# --init-hook, from --load-plugins, from --rcfile, and -- this is the part no argument guard can
# reach -- from a .pylintrc in the working directory. cwd is the project root, the model writes
# there, and the project is SUPPOSED to contain a pylintrc: ensure_pylintrc.py puts one there.
# Verified: a .pylintrc whose init-hook writes a file gets it written, with no flags at all.
#
# So allowing pylint here grants arbitrary code execution through a file rather than through a
# call, which is why blocking the flags was not enough and why this is a removal rather than a
# denylist. Lint still runs, through run_quality_gates.py, which is the path the contract wants
# and which the refusal message already names. Do not add it back without answering the .pylintrc
# question, since that is the door, not the flags.
_ALLOWED_PYTHON_MODULES = frozenset({"py_compile", "compileall", "unittest", "flake8", "json.tool"})

# "Verification only" is a property of the MODULE list above, not of the arguments. Three of the
# six write to a path the caller names: `json.tool in.json OUT.json`, `flake8 --output-file=PATH`
# and `pylint --output=PATH`. So an allowlisted, read-only-looking call can still overwrite any
# file the shim account can write, which is the one route through this dispatcher that escapes the
# containment `write_project_file` and `delete_project_path` enforce everywhere else.
#
# Guarding json.tool's output positional alone would leave the two flag spellings open, so the
# rule is on the ARGUMENTS and applies to every module: nothing that can name a path outside the
# project. Relative arguments cannot escape, because cwd is forced to project_dir a few lines
# below and any model-supplied cwd is discarded. That leaves absolute paths and `..` segments.
def _escaping_module_arg(arg: str, project_dir: str | None) -> str | None:
    """The path in `arg` that could leave the project, or None when it cannot.

    Checks the value after `=` as well as the bare token, so `--output-file=/etc/passwd` is caught
    and not just a trailing positional. Separators are normalised first: on Windows the model may
    write either, and a check that only understands `/` would pass `..\\..\\x` straight through.

    Lexical checks alone are not enough. A project-relative path that traverses an in-project
    symlink is lexically innocent and still lands outside, so each token is also resolved against
    the project root. BOTH sides are resolved, because the root itself is often a symlink (macOS
    /tmp is /private/tmp) and comparing a resolved path against an unresolved root would refuse
    every ordinary call.
    """
    root = os.path.realpath(project_dir) if project_dir else None
    # Value first, so `--output-file=../x` reports `../x` rather than the whole flag. Normalising
    # the flag as a whole still trips the `..` check, and naming the flag as the offending PATH
    # reads as though the flag name were the problem.
    for token in (arg.split("=", 1)[1] if "=" in arg else "", arg):
        if not token:
            continue
        normalised = token.replace("\\", "/")
        drive_letter = len(normalised) > 1 and normalised[1] == ":" and normalised[0].isalpha()
        if normalised.startswith("/") or drive_letter or os.path.isabs(token):
            return token
        if ".." in normalised.split("/"):
            return token
        if root is None:
            continue
        # An argument that is not a path at all resolves harmlessly inside the root, so this needs
        # no guess about which arguments are paths. commonpath raises across Windows drives, which
        # is itself a token that cannot be contained.
        resolved = os.path.realpath(os.path.join(root, normalised))
        try:
            contained = os.path.commonpath([root, resolved]) == root
        except ValueError:
            contained = False
        if not contained:
            return token
    return None


# compileall's -b writes legacy .pyc beside each source, which PYTHONPYCACHEPREFIX does not cover.
# The token has to be read the way argparse folds short options, or the check is wrong in both
# directions. Its grammar: a run of store_true letters, then at most one value-taking flag whose
# value is the rest of the token. compileall's store_true shorts are -l -f -q -b (and -h, which
# exits); -r -d -s -p -x -i -j -o -e all take a value, and there is no long spelling of -b.
#
# So `b` is the legacy flag exactly when every letter before it is store_true. Anything after it
# is irrelevant, because the -b already fired. Two spellings proved this matters, both verified
# against the real interpreter: `-qb` bypassed a check for the exact token "-b", and `-bj2`
# (legacy plus two workers) bypassed a letters-only pattern because of the digit. In the other
# direction `-xbuild` is `-x build`, an ordinary skip regex that happens to contain a b, and a
# letters-only pattern refused it while telling the model to "drop -b" when there was no -b.
_COMPILEALL_LEGACY_FLAG = re.compile(r"-[lfqb]*b.*")

_MODULE_PYCACHE_DIR: str | None = None


def _module_pycache_dir() -> str:
    """One bytecode cache tree per process, created on first use.

    Made lazily rather than at import so a shim that never runs a module makes no temp dir at all.
    """
    global _MODULE_PYCACHE_DIR
    if _MODULE_PYCACHE_DIR is None:
        _MODULE_PYCACHE_DIR = tempfile.mkdtemp(prefix="mpyhw-pycache-")
    return _MODULE_PYCACHE_DIR


def _module_run_call(script):
    """`(module, args_carried_in_script)` for a `-m <module>` call, else None.

    Returns BOTH halves because the module and its arguments have to come from the same parse.
    An earlier version returned only the module while the caller re-split the tokens itself and
    assumed the `python -m X` shape, which broke the other two forms it claimed to accept:
    `-m unittest discover` read "discover" as the module and refused it, and `-m flake8` raised
    IndexError that reached the model as an opaque JSON-RPC -32000. Both are the kind of refusal
    that teaches nothing and costs a turn, which is what the module route exists to remove.
    """
    tokens = str(script).strip().split()
    if len(tokens) >= 2 and tokens[0] == "-m":
        return tokens[1], tokens[2:]
    # The shell spelling arrives as a whole command: `python -m unittest discover -s test/pc`.
    if len(tokens) >= 3 and os.path.basename(tokens[0]).startswith("python") and tokens[1] == "-m":
        return tokens[2], tokens[3:]
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
    module_call = _module_run_call(script)
    if interpreter == "shell" and module_call is not None:
        # Same call, shell spelling. Route it to the module path rather than refusing it for
        # not being one of the allowed git forms. Only the interpreter changes: the module and
        # its arguments come from the parse above, so every spelling it accepts is routed the
        # same way rather than re-split here on an assumed shape.
        interpreter = "python"
    if interpreter == "shell":
        cmd = script if not args else script + " " + " ".join(args)
        if _parse_v0_shell_command(cmd) is None:
            # `message` reaches the model as the tool result's stderr (protocol-build maps it),
            # so naming the permitted forms here is what stops it guessing for a whole phase.
            return {"status": "error", "error_kind": "shell_command_not_allowed",
                    "message": ALLOWED_SHELL_COMMANDS_HINT}
        return _v0_result(shim.run_v0_shell(cmd, cwd=cwd, stdin=stdin_content, timeout=timeout))
    if interpreter == "node":
        # Fail fast: no node toolchain is assumed in the host shim. Don't fake success.
        return {"status": "error", "error_kind": "node_interpreter_unavailable",
                "message": "node script_run is not supported by the host shim"}
    if module_call is not None:
        # Arguments written into the script string are kept rather than dropped. A model that
        # sends `script="-m unittest discover -s test/pc"` with an empty args list used to run a
        # bare `python -m unittest`: status ok, no error, and a command that did something other
        # than what it was asked to do. They lead, because they sit left of args in the call.
        module, embedded_args = module_call
        args = [*embedded_args, *args]
        if module not in _ALLOWED_PYTHON_MODULES:
            return {"status": "error", "error_kind": "python_module_not_allowed",
                    "message": (
                        f"python -m {module} is not permitted. Allowed modules: "
                        f"{', '.join(sorted(_ALLOWED_PYTHON_MODULES))}. The full lint and test "
                        "sweep is scripts/run_quality_gates.py, which runs all of them and emits "
                        "the gate results the phase_complete payload needs."
                    )}
        if module == "compileall" and any(_COMPILEALL_LEGACY_FLAG.fullmatch(a) for a in args):
            # PYTHONPYCACHEPREFIX does not cover legacy locations, so `-b` writes .pyc beside
            # every source it touches and the "leaves nothing in the project" guarantee stops
            # holding. Measured on the default form: one py_compile run without the prefix cost
            # 13 PROJECT_PYTHON_CACHE_PRESENT errors and five cleanup calls.
            return {"status": "error", "error_kind": "python_module_arg_not_allowed",
                    "message": (
                        "python -m compileall -b is not permitted: -b writes legacy .pyc files "
                        "beside each source, inside the project, where the gate reports them as "
                        "stray cache. Drop -b; the default form writes its bytecode outside the "
                        "project already."
                    )}
        for arg in args:
            escaping = _escaping_module_arg(arg, cwd)
            if escaping is not None:
                # Name the offending token and the fix. This message is the tool result the model
                # reads, so a bare refusal costs a turn and teaches it nothing.
                return {"status": "error", "error_kind": "path_outside_project",
                        "message": (
                            f"python -m {module} was refused: the argument {arg!r} names {escaping!r}, "
                            "which can point outside the project. Pass a project-relative path "
                            "instead, with no leading slash, drive letter or '..' segment. Paths "
                            "resolve from the project root."
                        )}
        return _v0_result(shim.run_v0_module(module, args, cwd=cwd, stdin=stdin_content, timeout=timeout))
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
    args = _assert_project_root(base, args, cwd)
    result = _v0_result(shim.run_v0_python(candidates[0], args, cwd=cwd, stdin=stdin_content, timeout=timeout))
    # Hand back the script's own option list so the model never needs a `--help` turn to learn
    # it. Measured: 47 --help probes across archived runs, every examined one following a call
    # that had already SUCCEEDED -- the model checking for flags it might have missed.
    flags = _accepted_flags(candidates[0])
    if flags and isinstance(result, dict):
        result["accepted_flags"] = flags
    return result


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
    if method == "project.export_upload_ready":
        return _export_upload_ready(params["project_dir"])
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
    if method == "serial.monitor_start":
        return shim.monitor_start(params["port"], int(params.get("baud", 115200)))
    if method == "serial.monitor_stop":
        return shim.monitor_stop()
    return None  # unknown method


# Every stdout write — an RPC response OR a serial.data notification pushed by the
# monitor's background thread — goes through this one lock. Without it, a response
# write racing a notification write can interleave their bytes on the pipe and
# corrupt the newline-delimited JSON framing the extension's reader depends on.
_stdout_lock = threading.Lock()


def _write_line(message):
    with _stdout_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def _notify(method, params):
    # A JSON-RPC notification: method + params, no "id" — the extension's ShimProcess
    # tells it apart from a request response by the absence of a matching pending id.
    _write_line({"jsonrpc": "2.0", "method": method, "params": params})


def _respond(message):
    _write_line(message)


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
