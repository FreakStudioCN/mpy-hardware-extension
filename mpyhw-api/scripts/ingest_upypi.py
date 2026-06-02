from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_store import normalize_record


def normalize_upypi_package(raw: dict[str, Any]) -> dict[str, Any]:
    if not raw.get("name") or not raw.get("version"):
        raise ValueError("missing required package fields")
    package_json_url = raw.get("package_json_url") or f"https://upypi.net/pkgs/{raw['name']}/{raw['version']}/package.json"
    return normalize_record({
        **raw,
        "source": "upypi",
        "package_json_url": package_json_url,
        "support_level": "installable" if package_json_url else "discoverable",
        "cached": True,
    })


def ingest_fixture_dir(fixture_dir: str | Path, output_dir: str | Path) -> dict[str, Any]:
    fixture_dir = Path(fixture_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    search = json.loads((fixture_dir / "search-temperature.json").read_text(encoding="utf-8"))
    seen: set[str] = set()
    duplicates: list[str] = []
    records: list[dict[str, Any]] = read_existing_records(output_dir)
    existing_keys = {f"{record['name']}@{record['version']}" for record in records}
    written_count = 0
    for hit in search["results"]:
        key = f"{hit['name']}@{hit['version']}"
        if key in seen:
            duplicates.append(key)
            continue
        seen.add(key)
        if key in existing_keys:
            duplicates.append(key)
            continue
        package = json.loads((fixture_dir / "aht20-package.json").read_text(encoding="utf-8"))
        records.append(normalize_upypi_package({**package, "package_json_url": hit.get("package_json_url")}))
        written_count += 1
    (output_dir / "package_index.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    evidence = {"source": "upypi", "records_written": written_count, "duplicates_skipped": duplicates}
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


if __name__ == "__main__":
    main()
