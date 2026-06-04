from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_store import normalize_record, safe_context_filename, support_weight
from scripts.normalize_driver_context import extract_driver_context, extract_graftsense_context

CANONICAL_GH = "github:FreakStudioCN/GraftSense-Drivers-MicroPython"
REPO_URL = "https://github.com/FreakStudioCN/GraftSense-Drivers-MicroPython"


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


def _is_fake_seed(record: dict[str, Any]) -> bool:
    return record.get("name") == "graftsense_aht20" or str(record.get("package_json_url", "")).startswith("https://graftsense.example")


def _repo_path_key(record: dict[str, Any]) -> str | None:
    """The `<category>/<driver>` this record points at inside the GraftSense repo,
    drawn from either its github package_json_url or a github: url entry. Lets a
    graftsense record supersede an upypi record that points at the same driver
    even when their package names differ."""
    marker = "GraftSense-Drivers-MicroPython/"
    candidates = [str(record.get("package_json_url", ""))]
    candidates += [str(entry[1]) for entry in (record.get("urls") or []) if isinstance(entry, list) and len(entry) >= 2]
    for target in candidates:
        if marker in target:
            parts = target.split(marker, 1)[1].split("/")
            if len(parts) >= 2:
                return f"{parts[0]}/{parts[1]}"
    return None


def _conflicts(existing: dict[str, Any], record: dict[str, Any], path_key: str | None) -> bool:
    if existing["name"] == record["name"] and existing["version"] == record["version"]:
        return True
    return path_key is not None and _repo_path_key(existing) == path_key


def ingest_repo_dir(repo_root: str | Path, output_dir: str | Path) -> dict[str, Any]:
    """Walk a local GraftSense-Drivers-MicroPython checkout and emit real catalog
    records. Every `<category>/<driver>/` with a package.json + code/ becomes a
    record; drivers whose AST-parsed constructor declares a bus are promoted to
    `generatable` with a driver_context sidecar (all bus types, not just I2C),
    the rest stay `installable`."""
    repo_root = Path(repo_root)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "driver_context").mkdir(exist_ok=True)

    records = [record for record in read_existing_records(output_dir) if not _is_fake_seed(record)]
    stale = output_dir / "driver_context" / "graftsense_aht20-1.0.0.json"
    if stale.exists():
        stale.unlink()

    written = generatable = installable = 0
    superseded: list[str] = []
    driver_contexts: list[str] = []
    for package_path in sorted(repo_root.glob("*/*/package.json")):
        driver_dir = package_path.parent
        code_dir = driver_dir / "code"
        if not code_dir.is_dir():
            continue
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not package.get("name") or not package.get("version"):
            continue
        category, driver = driver_dir.parent.name, driver_dir.name
        readme_path = driver_dir / "README.md"
        readme = readme_path.read_text(encoding="utf-8") if readme_path.exists() else ""
        # Some drivers nest the real module in code/<subpackage>/ (e.g.
        # micropython_dps310/dps310.py), so walk recursively. main.py is the demo
        # app (concrete pins -> false constructors); __init__.py only re-exports.
        code_files = [
            (path.name, path.read_text(encoding="utf-8"))
            for path in sorted(code_dir.rglob("*.py"))
            if path.name not in ("main.py", "__init__.py")
        ]
        manifest = {
            **package,
            "source": "graftsense",
            "package_json_url": f"{CANONICAL_GH}/{category}/{driver}",
            "repository_url": REPO_URL,
        }
        context = extract_graftsense_context(manifest, readme, code_files)
        record = normalize_record(manifest)
        record["confidence"] = context["confidence"]
        is_generatable = bool(context["constructors"] and context["bus"])
        record["support_level"] = context["support_level"] if is_generatable else "installable"

        path_key = _repo_path_key(record)
        conflicts = [existing for existing in records if _conflicts(existing, record, path_key)]
        if conflicts and max(support_weight(existing["support_level"]) for existing in conflicts) > support_weight(record["support_level"]):
            continue  # a stronger record already covers this driver
        if conflicts:
            superseded.extend(f"{existing['name']}@{existing['version']}" for existing in conflicts)
            records = [existing for existing in records if not _conflicts(existing, record, path_key)]

        if is_generatable:
            context_name = safe_context_filename(package["name"], package["version"])
            (output_dir / "driver_context" / context_name).write_text(json.dumps(context, indent=2), encoding="utf-8")
            record["driver_context_ref"] = f"driver_context/{context_name}"
            driver_contexts.append(context_name)
            generatable += 1
        else:
            installable += 1
        records.append(record)
        written += 1

    (output_dir / "package_index.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    evidence = {
        "source": "graftsense-repo",
        "records_written": written,
        "generatable": generatable,
        "installable": installable,
        "superseded": superseded,
        "driver_contexts": driver_contexts,
    }
    (output_dir / "ingestion_evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", help="Ingest the single hand-made fixture driver (offline/tests).")
    parser.add_argument("--repo-dir", help="Walk a local GraftSense-Drivers-MicroPython checkout.")
    parser.add_argument("--output-dir", default="content/packages")
    args = parser.parse_args()
    if args.repo_dir:
        evidence = ingest_repo_dir(args.repo_dir, args.output_dir)
        print(json.dumps(evidence, indent=2))
    elif args.fixture_dir:
        ingest_fixture_dir(args.fixture_dir, args.output_dir)
    else:
        parser.error("pass --repo-dir or --fixture-dir")


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
