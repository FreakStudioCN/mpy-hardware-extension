from __future__ import annotations

import hashlib
import json
from pathlib import Path


CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "canonical_tools.json"
CANONICAL_TOOLS = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

CANONICAL_TOOL_NAMES = {tool["name"] for tool in CANONICAL_TOOLS}
CANONICAL_TOOL_INPUT_SCHEMAS = {tool["name"]: tool["input_schema"] for tool in CANONICAL_TOOLS}


def tool_registry_version() -> str:
    body = json.dumps(CANONICAL_TOOLS, sort_keys=True).encode("utf-8")
    return hashlib.sha256(body).hexdigest()
