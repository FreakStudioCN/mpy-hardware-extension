import os
import subprocess
import sys

import pytest

from serve import (
    Shim,
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


def test_install_command_uses_mpremote_mip_package_json_url():
    shim = Shim(runner=lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))

    shim.install_package("COM3", "https://upypi.net/pkgs/aht20/1.0.0/package.json")

    assert shim.commands[-1] == ["mpremote", "connect", "COM3", "resume", "mip", "install", "https://upypi.net/pkgs/aht20/1.0.0/package.json"]


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
    assert cmd[1].replace("\\", "/").endswith("upy-diagram/scripts/render_diagram_local.py")
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
