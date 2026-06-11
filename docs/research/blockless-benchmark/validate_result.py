#!/usr/bin/env python3
"""Validate Blockless diligence JSON without external dependencies.

This intentionally implements only the JSON Schema features used by
the Blockless benchmark and market-signal schemas. It is a gate for diligence
evidence, not a general-purpose schema validator. Market cohort summaries also
get a few semantic consistency checks because structure alone cannot validate
arithmetic or claim discipline.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def type_matches(value: Any, schema_type: str) -> bool:
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return (isinstance(value, int) or isinstance(value, float)) and not isinstance(value, bool)
    return True


def resolve_ref(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError(f"Only local refs are supported: {ref}")
    current: Any = root
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        current = current[part]
    if not isinstance(current, dict):
        raise ValueError(f"Ref does not resolve to schema object: {ref}")
    return current


def validate(value: Any, schema: dict[str, Any], root: dict[str, Any], path: str, errors: list[str]) -> None:
    if "$ref" in schema:
        validate(value, resolve_ref(root, schema["$ref"]), root, path, errors)
        return

    expected_type = schema.get("type")
    if isinstance(expected_type, str) and not type_matches(value, expected_type):
        errors.append(f"{path}: expected {expected_type}, got {type(value).__name__}")
        return

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value {value!r} not in enum")

    if "minimum" in schema and isinstance(value, (int, float)) and value < schema["minimum"]:
        errors.append(f"{path}: value {value!r} below minimum {schema['minimum']}")

    if "maximum" in schema and isinstance(value, (int, float)) and value > schema["maximum"]:
        errors.append(f"{path}: value {value!r} above maximum {schema['maximum']}")

    if "pattern" in schema and isinstance(value, str) and re.match(schema["pattern"], value) is None:
        errors.append(f"{path}: value {value!r} does not match pattern {schema['pattern']!r}")

    if schema.get("format") == "date" and isinstance(value, str):
        if re.match(r"^\d{4}-\d{2}-\d{2}$", value) is None:
            errors.append(f"{path}: value {value!r} is not YYYY-MM-DD")

    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                errors.append(f"{path}: missing required key {key!r}")

        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value.keys()) - set(properties.keys()))
            for key in extra:
                errors.append(f"{path}: unexpected key {key!r}")

        for key, child_schema in properties.items():
            if key in value:
                validate(value[key], child_schema, root, f"{path}.{key}", errors)

    if isinstance(value, list):
        if schema.get("uniqueItems") is True:
            seen = set()
            for item in value:
                marker = json.dumps(item, sort_keys=True)
                if marker in seen:
                    errors.append(f"{path}: duplicate array item {item!r}")
                seen.add(marker)

        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate(item, item_schema, root, f"{path}[{index}]", errors)


def sum_values(value: dict[str, Any]) -> int:
    return sum(item for item in value.values() if isinstance(item, int) and not isinstance(item, bool))


def validate_market_cohort_semantics(result: dict[str, Any], errors: list[str]) -> None:
    participants = result.get("participants", {})
    if not isinstance(participants, dict):
        return

    total = participants.get("total")
    if isinstance(total, int) and not isinstance(total, bool):
        for key in ("segment_counts", "experience_counts", "buyer_role_counts"):
            counts = participants.get(key)
            if isinstance(counts, dict) and sum_values(counts) != total:
                errors.append(f"$.participants.{key}: counts sum to {sum_values(counts)}, expected total {total}")

    inventory = result.get("signal_inventory", {})
    if isinstance(inventory, dict):
        signal_refs = inventory.get("signal_refs")
        valid_count = inventory.get("structurally_valid_count")
        if isinstance(signal_refs, list) and isinstance(valid_count, int):
            if len(signal_refs) != valid_count:
                errors.append(
                    "$.signal_inventory: signal_refs length "
                    f"{len(signal_refs)} does not match structurally_valid_count {valid_count}"
                )
        for key in ("compliment_only_count", "user_initiated_count", "completed_behavior_count"):
            count = inventory.get(key)
            if isinstance(count, int) and isinstance(valid_count, int) and count > valid_count:
                errors.append(f"$.signal_inventory.{key}: count {count} exceeds structurally_valid_count {valid_count}")

    behavior = result.get("behavior_counts", {})
    if isinstance(behavior, dict) and isinstance(total, int):
        for key, count in behavior.items():
            if key != "notes" and isinstance(count, int) and count > total:
                errors.append(f"$.behavior_counts.{key}: count {count} exceeds participant total {total}")

    commitment = result.get("commitment_summary", {})
    if isinstance(commitment, dict) and isinstance(inventory, dict):
        events = commitment.get("commitment_events")
        valid_count = inventory.get("structurally_valid_count")
        if isinstance(events, int) and isinstance(valid_count, int) and events > valid_count:
            errors.append(
                "$.commitment_summary.commitment_events: "
                f"count {events} exceeds structurally_valid_count {valid_count}"
            )

    interpretation = result.get("interpretation", {})
    permissions = result.get("claim_permissions", {})
    if not isinstance(interpretation, dict) or not isinstance(permissions, dict):
        return

    rerun_completed = behavior.get("recipe_rerun_completed") if isinstance(behavior, dict) else None
    paid_steps = behavior.get("paid_or_procurement_step") if isinstance(behavior, dict) else None
    commitment_events = commitment.get("commitment_events") if isinstance(commitment, dict) else None

    repeat_count = 0
    if isinstance(behavior, dict):
        for key in (
            "second_project_completed",
            "third_project_started",
            "recipe_rerun_completed",
            "recipe_fork_completed",
        ):
            count = behavior.get(key)
            if isinstance(count, int):
                repeat_count += count

    if interpretation.get("repeat_use_observed") is True and repeat_count == 0:
        errors.append("$.interpretation.repeat_use_observed: true but repeat-use behavior counts are zero")

    if interpretation.get("second_user_rerun_observed") is True and rerun_completed == 0:
        errors.append("$.interpretation.second_user_rerun_observed: true but recipe_rerun_completed is zero")

    if interpretation.get("paid_behavior_observed") is True and paid_steps == 0 and commitment_events == 0:
        errors.append("$.interpretation.paid_behavior_observed: true but paid/procurement and commitment counts are zero")

    deck_language = permissions.get("deck_language")
    minimum_met = interpretation.get("minimum_cohort_met")
    if deck_language == "gate_passed" and minimum_met is not True:
        errors.append("$.claim_permissions.deck_language: gate_passed requires minimum_cohort_met=true")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Blockless diligence JSON file.")
    parser.add_argument("result", type=Path, help="Path to a JSON evidence file")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).with_name("result.schema.json"),
        help="Path to result.schema.json",
    )
    args = parser.parse_args()

    try:
        schema = load_json(args.schema)
        result = load_json(args.result)
    except Exception as exc:  # noqa: BLE001 - command-line error reporting
        print(f"error: {exc}", file=sys.stderr)
        return 2

    errors: list[str] = []
    validate(result, schema, schema, "$", errors)
    if schema.get("$id") == "https://blockless.dev/research/market_cohort.schema.json" and isinstance(result, dict):
        validate_market_cohort_semantics(result, errors)

    if errors:
        print(f"{args.result}: INVALID")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"{args.result}: valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
