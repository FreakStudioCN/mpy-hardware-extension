from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_store import normalize_record, safe_context_filename
from scripts.normalize_driver_context import extract_driver_context


def ingest_fixture_dir(fixture_dir: str | Path, output_dir: str | Path) -> dict[str, Any]:
    fixture_dir = Path(fixture_dir)
    output_dir = Path(output_dir)
    package_path = fixture_dir / "aht20-package.json"
    if not package_path.exists():
        raise FileNotFoundError(package_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "driver_context").mkdir(exist_ok=True)
    package = json.loads(package_path.read_text(encoding="utf-8"))
    readme = (fixture_dir / "aht20-readme.md").read_text(encoding="utf-8")
    source = (fixture_dir / "aht20-source.py").read_text(encoding="utf-8")
    context = extract_driver_context(package, readme, source)
    context.pop("support_level", None)
    context_name = safe_context_filename(package["name"], package["version"])
    (output_dir / "driver_context" / context_name).write_text(json.dumps(context, indent=2), encoding="utf-8")
    record = normalize_record({
        **package,
        "source": "graftsense",
        "capabilities": ["temperature_sensing", "humidity_sensing"],
        "support_level": "generatable",
        "driver_context_ref": f"driver_context/{context_name}",
        "cached": True,
    })
    record["driver_context_ref"] = f"driver_context/{context_name}"
    records = merge_record(read_existing_records(output_dir), record)
    (output_dir / "package_index.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    evidence = {"source": "graftsense", "records_written": 1, "driver_contexts": [context_name]}
    (output_dir / "ingestion_evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", required=True)
    parser.add_argument("--output-dir", default="content/packages")
    args = parser.parse_args()
    ingest_fixture_dir(args.fixture_dir, args.output_dir)


def read_existing_records(output_dir: Path) -> list[dict[str, Any]]:
    path = output_dir / "package_index.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def merge_record(records: list[dict[str, Any]], record: dict[str, Any]) -> list[dict[str, Any]]:
    key = (record["name"], record["version"])
    without_existing = [item for item in records if (item["name"], item["version"]) != key]
    return [*without_existing, record]


if __name__ == "__main__":
    main()
