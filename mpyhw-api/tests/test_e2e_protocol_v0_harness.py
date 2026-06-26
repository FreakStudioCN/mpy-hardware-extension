import importlib.util
import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.no_db


def _load_harness(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    script = Path(__file__).resolve().parents[1] / "scripts" / "e2e_protocol_v0.py"
    spec = importlib.util.spec_from_file_location("e2e_protocol_v0_harness_test", script)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _tool_input(payload):
    return {"name": "file_operation", "input": payload, "args": json.dumps(payload)}


def _stats():
    return {"by_tool": {}, "valid": 0, "invalid_payload": 0, "off_protocol": 0, "files_written": set(), "code_chars": 0}


def test_e2e_file_operation_can_read_skill_board_resources(tmp_path, monkeypatch):
    harness = _load_harness(monkeypatch)

    listed, _ = harness.execute_tool(
        _tool_input({"op": "list", "path": "upy-analyze-plugin/boards"}),
        tmp_path,
        harness.SKILLS_ROOT / "upy-select-hw-plugin",
        _stats(),
    )
    assert listed["ok"] is True
    assert "upy-analyze-plugin/boards/esp32-s3-devkitc.json" in listed["entries"]

    read, _ = harness.execute_tool(
        _tool_input({"op": "read", "path": "upy-analyze-plugin/boards/esp32-s3-devkitc.json"}),
        tmp_path,
        harness.SKILLS_ROOT / "upy-select-hw-plugin",
        _stats(),
    )
    assert read["ok"] is True
    assert json.loads(read["content"])["id"] == "esp32-s3-devkitc"


def test_e2e_file_operation_does_not_write_to_skill_resources(tmp_path, monkeypatch):
    harness = _load_harness(monkeypatch)

    result, _ = harness.execute_tool(
        _tool_input({"op": "write", "path": "upy-analyze-plugin/boards/should-not-write.json", "content": "{}"}),
        tmp_path,
        harness.SKILLS_ROOT / "upy-select-hw-plugin",
        _stats(),
    )

    assert result["ok"] is True
    assert result["success"] is True
    assert (tmp_path / "upy-analyze-plugin" / "boards" / "should-not-write.json").is_file()
    assert not (harness.SKILLS_ROOT / "upy-analyze-plugin" / "boards" / "should-not-write.json").exists()
