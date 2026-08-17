import importlib.util
import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.no_db


def _load_harness(monkeypatch):
    # No key needed to import any more: the harness reads DEEPSEEK_API_KEY when it opens a
    # stream, not when it is loaded.
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


def test_importing_the_harness_does_not_touch_the_environment(monkeypatch):
    # Importing this script used to read mpyhw-api/.env straight into os.environ, and
    # nothing ever undid it: every test that ran afterwards saw the developer's
    # MPYHW_WEB_RECOMMEND_MODEL / MPYHW_WEB_RECOMMEND_MAX_TOKENS, so a provider-default
    # assertion failed in the full suite while passing when its file ran alone. Loading
    # config belongs to a run, not to an import.
    before = dict(os.environ)
    _load_harness(monkeypatch)
    changed = {k: v for k, v in os.environ.items() if before.get(k) != v}
    assert not changed, f"importing the harness leaked env into the session: {sorted(changed)}"


def test_load_dotenv_defaults_fills_gaps_without_overriding(tmp_path, monkeypatch):
    # The loader still has to work for a real run, where the key and the model come from
    # .env: main() calls it. An explicit environment wins, which is how a run is pointed at
    # a different provider without editing the file.
    harness = _load_harness(monkeypatch)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment\n\nFROM_DOTENV=loaded\nALREADY_SET=from-file\n", encoding="utf-8"
    )
    monkeypatch.delenv("FROM_DOTENV", raising=False)
    monkeypatch.setenv("ALREADY_SET", "from-shell")

    harness.load_dotenv_defaults(env_file)

    assert os.environ["FROM_DOTENV"] == "loaded"
    assert os.environ["ALREADY_SET"] == "from-shell"
    monkeypatch.delenv("FROM_DOTENV")


def test_load_dotenv_defaults_ignores_a_missing_file(tmp_path, monkeypatch):
    # A checkout with no .env is normal (CI, a fresh clone): the loader returns quietly
    # rather than making the harness unimportable.
    harness = _load_harness(monkeypatch)
    harness.load_dotenv_defaults(tmp_path / "nope.env")


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
