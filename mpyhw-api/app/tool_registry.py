"""Loader for the shared plugin-interface protocol contract.

`contracts/protocol_messages.json` is the single source of truth shared by the
backend (system-prompt tool list + payload validation + version check) and the
extension. It replaces the old 27-tool `canonical_tools.json`: the LLM now emits
6 generic protocol tools (4 blocking round-trips + 2 fire-and-forget notifies),
and every message payload validates against the schema in this contract.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "protocol_messages.json"
PROTOCOL = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

PROTOCOL_VERSION: str = PROTOCOL["protocol_version"]

# type -> payload JSON Schema, for validating both directions.
MESSAGE_SCHEMAS: dict[str, dict] = {
    name: entry["payload_schema"] for name, entry in PROTOCOL["messages"].items()
}
MESSAGE_DIRECTION: dict[str, str] = {
    name: entry["direction"] for name, entry in PROTOCOL["messages"].items()
}

# The 6 tools the LLM is allowed to emit (subset of server->plugin messages).
LLM_TOOL_NAMES: set[str] = set(PROTOCOL["llm_tools"])
LLM_TOOL_INPUT_SCHEMAS: dict[str, dict] = {
    name: MESSAGE_SCHEMAS[name] for name in PROTOCOL["llm_tools"]
}
LLM_TOOL_DESCRIPTIONS: dict[str, str] = {
    name: PROTOCOL["messages"][name].get("description", "") for name in PROTOCOL["llm_tools"]
}
# name -> "blocking" | "notify" (notify tools are auto-acked, never block the loop).
LLM_TOOL_KINDS: dict[str, str] = dict(PROTOCOL["llm_tool_kinds"])


def llm_tool_list() -> list[dict]:
    """The protocol tools as a discovery list (served at /v1/tools)."""
    return [
        {
            "name": name,
            "kind": LLM_TOOL_KINDS.get(name, "blocking"),
            "description": LLM_TOOL_DESCRIPTIONS.get(name, ""),
            "input_schema": LLM_TOOL_INPUT_SCHEMAS[name],
        }
        for name in PROTOCOL["llm_tools"]
    ]


def protocol_registry_version() -> str:
    """Stable hash of the contract; the extension compares its bundled copy to
    catch a client/server protocol skew (the successor of tool_registry_mismatch)."""
    body = json.dumps(PROTOCOL, sort_keys=True).encode("utf-8")
    return hashlib.sha256(body).hexdigest()
