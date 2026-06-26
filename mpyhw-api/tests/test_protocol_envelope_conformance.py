"""Pin our V0 contract to upstream's OWN sample messages (drift guard).

test_protocol_contract.py checks the contract's shape in isolation. It does NOT
check that the messages upstream actually emits conform to it — so the contract
could silently drift away from the skills it's meant to describe. This test loads
every upstream `upy-*-plugin` sample / mock-message envelope and validates it
against contracts/protocol_messages.json. If upstream changes a payload shape, a
sample stops conforming and this fails loudly (Codex landmine #1: protocol drift).

DB-free: only reads JSON + the vendored submodule. We never edit third_party/.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.protocol_validate import message_types, validate_protocol_message

# DB-free: skip the autouse Postgres fixture in conftest.
pytestmark = pytest.mark.no_db

_REPO = Path(__file__).resolve().parents[2]
_SKILLS_ROOT = _REPO / "third_party" / "MicroPython_Skills"

# Files that carry a `type`+`payload` but are NOT wire envelopes — internal state
# snapshots the plugins persist (e.g. flash_mpy_firmware_state.*.json -> type "state").
# Allowlisted so they're skipped, but a genuinely-new WIRE type would not be and
# would trip test_no_unexpected_wire_message_types below.
_NON_WIRE_TYPES = {"state"}


def _collect_sample_messages() -> list[tuple[str, dict]]:
    """Every upstream sample/mock-message JSON that looks like a protocol envelope."""
    out: list[tuple[str, dict]] = []
    if not _SKILLS_ROOT.exists():
        return out
    for plugin in sorted(_SKILLS_ROOT.glob("upy-*-plugin")):
        for sub in ("sample", "mock-messages"):
            base = plugin / sub
            if not base.exists():
                continue
            for path in sorted(base.rglob("*.json")):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    continue
                if isinstance(data, dict) and "type" in data and "payload" in data:
                    out.append((path.relative_to(_REPO).as_posix(), data))
    return out


_SAMPLES = _collect_sample_messages()
_KNOWN = message_types()
_WIRE_SAMPLES = [(rel, msg) for rel, msg in _SAMPLES if msg.get("type") in _KNOWN]


def test_upstream_samples_were_found():
    # Guard the guard: an unchecked-out submodule would silently make the
    # parametrized test vacuous (0 cases all "passing").
    assert len(_WIRE_SAMPLES) >= 5, (
        "expected upstream V0 plugin sample messages on disk — is the submodule "
        f"checked out at the V0 commit? found {len(_WIRE_SAMPLES)}"
    )


def test_no_unexpected_wire_message_types():
    # Any sample type that is neither a known contract message nor an allowlisted
    # snapshot type means upstream introduced a new wire message we haven't modeled.
    seen = {msg.get("type") for _, msg in _SAMPLES}
    unexpected = seen - _KNOWN - _NON_WIRE_TYPES
    assert not unexpected, f"unmodeled upstream message types: {sorted(unexpected)}"


@pytest.mark.parametrize("rel,msg", _WIRE_SAMPLES, ids=[s[0] for s in _WIRE_SAMPLES])
def test_upstream_sample_conforms_to_contract(rel: str, msg: dict):
    errors = validate_protocol_message(msg)
    assert not errors, f"{rel} violates the V0 contract: {errors}"


def test_validator_rejects_phase_complete_missing_required():
    errors = validate_protocol_message(
        {"type": "phase_complete", "payload": {"summary": "no result field"}}
    )
    assert errors and any("result" in e for e in errors), errors


def test_validator_rejects_unknown_message_type():
    errors = validate_protocol_message({"type": "not_a_real_message", "payload": {}})
    assert errors and any("unknown message type" in e for e in errors), errors


def test_validator_rejects_non_object_payload():
    errors = validate_protocol_message({"type": "status_update", "payload": "nope"})
    assert errors and any("payload" in e for e in errors), errors
