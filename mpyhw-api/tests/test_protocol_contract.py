"""Contract test for contracts/protocol_messages.json.

The 7-message plugin-interface protocol replaces the 27 canonical tools. Both the
backend (system-prompt tool list + payload validation) and the extension import
this single artifact, so its shape is load-bearing. This test is DB-free; it only
reads the JSON and validates structure + that every payload schema is itself a
valid JSON Schema.
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "protocol_messages.json"

EXPECTED_MESSAGES = {
    # server -> plugin
    "approval_request": "server->plugin",
    "status_update": "server->plugin",
    "device_command": "server->plugin",
    "file_operation": "server->plugin",
    "script_run": "server->plugin",
    "phase_complete": "server->plugin",
    "stream": "server->plugin",
    # plugin -> server
    "start_phase": "plugin->server",
    "approval_response": "plugin->server",
    "device_result": "plugin->server",
    "script_result": "plugin->server",
    "file_result": "plugin->server",
    "user_intervention": "plugin->server",
    "error_lib_update": "plugin->server",
    "stream_ack": "plugin->server",
}

EXPECTED_ENUMS = {
    ("device_command", "action"): {
        "devs", "scan", "exec", "cp", "cp_from", "mkdir", "ls", "rm", "soft_reset", "stream", "run"
    },
    ("file_operation", "op"): {"write", "read", "list", "delete", "mkdir", "append"},
    ("script_run", "interpreter"): {"python", "node", "shell"},
    ("phase_complete", "result"): {"success", "failed", "partial"},
    ("status_update", "level"): {"info", "warn", "error", "success"},
    ("stream", "stream_type"): {"device_output", "script_stdout", "script_stderr"},
    ("user_intervention", "action"): {"pause", "skip", "abort", "resume"},
    ("error_lib_update", "action"): {"add", "update", "delete", "query"},
    ("stream_ack", "action"): {"continue", "stop"},
}


def _contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_top_level_shape():
    c = _contract()
    assert isinstance(c.get("protocol_version"), str) and c["protocol_version"]
    assert "envelope" in c and c["envelope"]["type"] == "object"
    assert "type" in c["envelope"]["properties"] and "payload" in c["envelope"]["properties"]
    assert isinstance(c.get("messages"), dict)
    assert isinstance(c.get("llm_tools"), list)


def test_all_message_types_present_with_direction():
    messages = _contract()["messages"]
    assert set(messages) == set(EXPECTED_MESSAGES), (
        f"message set drift: {set(messages) ^ set(EXPECTED_MESSAGES)}"
    )
    for name, direction in EXPECTED_MESSAGES.items():
        entry = messages[name]
        assert entry["direction"] == direction, f"{name} direction"
        assert entry.get("description"), f"{name} needs a description"
        schema = entry.get("payload_schema")
        assert isinstance(schema, dict) and schema.get("type") == "object", f"{name} payload_schema"


def test_every_payload_schema_is_valid_jsonschema():
    messages = _contract()["messages"]
    for name, entry in messages.items():
        # Raises SchemaError if the schema itself is malformed.
        jsonschema.Draft7Validator.check_schema(entry["payload_schema"])


def test_expected_enums_present():
    messages = _contract()["messages"]
    for (msg, field), values in EXPECTED_ENUMS.items():
        prop = messages[msg]["payload_schema"]["properties"][field]
        assert set(prop["enum"]) == values, f"{msg}.{field} enum drift"


def test_llm_tools_are_server_to_plugin_messages():
    c = _contract()
    messages = c["messages"]
    expected_tools = {
        "approval_request", "device_command", "file_operation",
        "script_run", "status_update", "phase_complete",
    }
    assert set(c["llm_tools"]) == expected_tools
    for name in c["llm_tools"]:
        assert name in messages, f"llm tool {name} missing from messages"
        assert messages[name]["direction"] == "server->plugin", f"llm tool {name} must be server->plugin"
    # kinds cover exactly the llm tools, and the 4 blocking + 2 notify split holds
    kinds = c["llm_tool_kinds"]
    assert set(kinds) == expected_tools
    assert {n for n, k in kinds.items() if k == "notify"} == {"status_update", "phase_complete"}
    assert {n for n, k in kinds.items() if k == "blocking"} == {
        "approval_request", "device_command", "file_operation", "script_run"
    }
