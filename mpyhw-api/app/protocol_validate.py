"""Validate a V0 plugin-interface message against contracts/protocol_messages.json.

Companion to schema_validate.py (which validates driver_context payloads). The
contract is the single source of truth for the protocol — it is derived from the
upstream spec (plugin-interface/02-protocol.md) — so this is how the backend and
the e2e harness assert that an emitted/consumed envelope is well-formed: look up
messages[type].payload_schema and validate the message's payload against it.

Pure / DB-free: only needs the contract JSON + jsonschema.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

import jsonschema

_CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "protocol_messages.json"


@functools.lru_cache(maxsize=1)
def _contract() -> dict:
    return json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=1)
def _payload_validators() -> dict[str, Any]:
    validators: dict[str, Any] = {}
    for name, entry in _contract()["messages"].items():
        schema = entry["payload_schema"]
        cls = jsonschema.validators.validator_for(schema)
        cls.check_schema(schema)
        validators[name] = cls(schema)
    return validators


def message_types() -> set[str]:
    """Every protocol message type the contract knows."""
    return set(_contract()["messages"])


def validate_protocol_message(message: Any) -> list[str]:
    """Return human-readable errors (empty == valid) for one protocol message.

    Validates the minimal envelope (an object with a known ``type`` and an object
    ``payload``) then the payload against the contract's ``payload_schema``.
    """
    if not isinstance(message, dict):
        return ["(root): message must be an object"]
    mtype = message.get("type")
    if not mtype:
        return ["(root): missing 'type'"]
    validators = _payload_validators()
    if mtype not in validators:
        return [f"type: unknown message type '{mtype}'"]
    payload = message.get("payload")
    if not isinstance(payload, dict):
        return [f"{mtype}.payload: must be an object"]
    errors: list[str] = []
    for err in sorted(validators[mtype].iter_errors(payload), key=lambda e: list(e.absolute_path)):
        where = ".".join(str(p) for p in err.absolute_path) or "(payload root)"
        errors.append(f"{mtype}.{where}: {err.message}")
    return errors
