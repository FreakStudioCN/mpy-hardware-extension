"""JSON-Schema validation for driver_context payloads.

Mirrors the upstream toolchain's validate_json.py (jsonschema, Draft-07) but as a
reusable in-process validator: the schema is compiled once and reused, so both the
ingest hard-gate and the serve-time soft check are cheap."""
from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

import jsonschema

_SCHEMA_PATH = Path(__file__).resolve().parent / "driver_context.schema.json"


@functools.lru_cache(maxsize=1)
def _validator() -> jsonschema.protocols.Validator:
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    return cls(schema)


def validate_driver_context(context: Any) -> list[str]:
    """Return a list of human-readable validation errors (empty == valid)."""
    errors = []
    for err in _validator().iter_errors(context):
        where = ".".join(str(p) for p in err.absolute_path) or "(root)"
        errors.append(f"{where}: {err.message}")
    return errors
