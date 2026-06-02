from __future__ import annotations

import hashlib
import json


CANONICAL_TOOLS = [
    {"name": "query_board_profile", "executor_hint": "local"},
    {"name": "search_packages", "executor_hint": "api-proxy"},
    {"name": "resolve_package_candidates", "executor_hint": "api-proxy"},
    {"name": "get_package_context", "executor_hint": "api-proxy"},
    {"name": "propose_manifest", "executor_hint": "local"},
    {"name": "generate_code", "executor_hint": "local"},
    {"name": "audit_code", "executor_hint": "local"},
    {"name": "load_skill", "executor_hint": "local"},
    {"name": "ask_user", "executor_hint": "ui-prompt"},
    {"name": "scan_device", "executor_hint": "shim"},
    {"name": "install_package", "executor_hint": "shim"},
    {"name": "flash_and_run", "executor_hint": "shim"},
    {"name": "read_serial_until", "executor_hint": "shim"},
    {"name": "write_main_py", "executor_hint": "shim"},
]

CANONICAL_TOOL_NAMES = {tool["name"] for tool in CANONICAL_TOOLS}


def tool_registry_version() -> str:
    body = json.dumps(CANONICAL_TOOLS, sort_keys=True).encode("utf-8")
    return hashlib.sha256(body).hexdigest()
