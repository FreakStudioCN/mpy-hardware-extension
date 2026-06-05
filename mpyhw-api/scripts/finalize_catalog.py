"""Deterministic finalize step shared by every ingest (and runnable standalone in
CI via `python -m scripts.finalize_catalog`).

Takes whatever each per-source ingest appended to package_index.json and produces a
canonical, idempotent catalog: cross-source chip dedup, a stable total-order sort,
canonical JSON serialization, and pruning of orphan driver_context files. Running
it twice over unchanged input yields byte-identical output."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_store import canonical_chip_id, dedupe_by_chip, version_key
from app.schema_validate import validate_driver_context
from scripts.normalize_driver_context import GENERATOR_VERSION


def canonical_json(data: Any) -> str:
    """One serialization for every file the pipeline writes, so re-runs diff as
    no-ops: 2-space indent, sorted keys, real UTF-8, trailing newline."""
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_canonical(path: Path, data: Any) -> None:
    """Write canonical JSON with LF newlines on every OS, so the same content
    regenerated on Windows (dev) and Linux (CI) is byte-identical."""
    path.write_text(canonical_json(data), encoding="utf-8", newline="\n")


def write_evidence(output_dir: str | Path, source_key: str, block: dict[str, Any]) -> None:
    """Update the per-source provenance ledger. Each ingest writes only its own
    block, so graftsense (submodule commit) and upypi (registry snapshot hash)
    provenance coexist instead of overwriting one another."""
    path = Path(output_dir) / "ingestion_evidence.json"
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
        sources = existing["sources"] if isinstance(existing.get("sources"), dict) else {}
    except (OSError, ValueError, KeyError):
        sources = {}
    sources[source_key] = block
    write_canonical(path, {"generator_version": GENERATOR_VERSION, "sources": sources})


def _index_sort_key(record: dict[str, Any]) -> tuple:
    return (
        canonical_chip_id(record["name"]),
        record["name"],
        version_key(record.get("version", "")),
        record.get("source", ""),
    )


def _validate_contexts(output_dir: Path, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Hard gate: schema-validate every referenced driver_context. A bad context
    is dropped (its record downgraded to `installable` so the package still lists)
    and reported; the now-orphaned file is pruned below. Keeps a malformed context
    from ever reaching codegen."""
    context_dir = output_dir / "driver_context"
    invalid: list[dict[str, Any]] = []
    for record in records:
        ref = record.get("driver_context_ref")
        if not ref:
            continue
        path = context_dir / Path(ref).name
        try:
            errors = validate_driver_context(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError) as exc:
            errors = [f"unreadable: {exc}"]
        if errors:
            invalid.append({"name": record["name"], "version": record["version"], "errors": errors[:5]})
            record.pop("driver_context_ref", None)
            record["support_level"] = "installable"
    return invalid


def finalize_index(output_dir: str | Path) -> dict[str, Any]:
    output_dir = Path(output_dir)
    index_path = output_dir / "package_index.json"
    records = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []

    # Validate BEFORE dedupe: a record whose driver_context is schema-invalid is
    # downgraded to installable (its ref dropped) first, so a sibling record with a
    # VALID context wins the chip tiebreak instead of being discarded behind a
    # malformed-but-stronger winner (which would then lose codegen entirely).
    invalid_contexts = _validate_contexts(output_dir, records)
    records = dedupe_by_chip(records)
    records.sort(key=_index_sort_key)
    write_canonical(index_path, records)

    # Canonicalize every referenced driver_context and delete the orphans (context
    # files no record points at — e.g. a driver that lost its dedup race).
    referenced = {Path(record["driver_context_ref"]).name for record in records if record.get("driver_context_ref")}
    context_dir = output_dir / "driver_context"
    pruned: list[str] = []
    if context_dir.is_dir():
        for path in sorted(context_dir.glob("*.json")):
            if path.name not in referenced:
                path.unlink()
                pruned.append(path.name)
                continue
            write_canonical(path, json.loads(path.read_text(encoding="utf-8")))

    return {"records": len(records), "pruned_contexts": pruned, "invalid_contexts": invalid_contexts}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="content/packages")
    args = parser.parse_args()
    print(json.dumps(finalize_index(args.output_dir), indent=2))


if __name__ == "__main__":
    main()
