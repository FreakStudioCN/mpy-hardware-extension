import base64
import json
import os
import subprocess
import sys

import pytest

from serve import (
    SCRIPT_FILES,
    Shim,
    _dispatch,
    _list_files,
    map_install_error,
    parse_scan_output,
    resolve_schema,
    resolve_script,
    scripts_root,
    _ensure_utf8_io,
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


def test_scan_drops_descriptorless_port_when_a_real_usb_port_is_present():
    # Real 5-field `mpremote connect list` shape: "{port} {serial} {vid:04x}:{pid:04x}
    # {mfr} {product}". COM5 is an HC-05 Bluetooth virtual serial port (no USB
    # descriptor, so vid:pid reads 0000:0000) that always exists alongside the real
    # board on COM48 -- it must not be offered as a pickable device.
    ports = parse_scan_output(
        "COM5 None 0000:0000 Microsoft None\n"
        "COM48 abc123 303a:1001 Espressif Systems ESP32-S3\n"
    )

    assert ports == ["COM48"]


def test_scan_keeps_lone_descriptorless_port_with_no_real_usb_port_present():
    # Same HC-05 line, but with no other port on the scan -- dropping it would leave
    # nothing to pick, so the lone descriptorless port still shows.
    ports = parse_scan_output("COM5 None 0000:0000 Microsoft None\n")

    assert ports == ["COM5"]


def test_install_command_uses_mpremote_mip_package_json_url():
    shim = Shim(runner=lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.install_package("COM3", "https://upypi.net/pkgs/aht20/1.0.0/package.json")

    assert shim.commands[-1] == ["mpremote", "connect", "COM3", "resume", "mip", "install", "https://upypi.net/pkgs/aht20/1.0.0/package.json"]


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

    assert result == {"ok": False, "error": "timeout", "lines": []}


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
