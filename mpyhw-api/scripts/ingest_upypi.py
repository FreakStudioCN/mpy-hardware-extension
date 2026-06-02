from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_store import normalize_record, safe_context_filename
from scripts.normalize_driver_context import extract_driver_context

UPYPI_BASE = "https://upypi.net"

# Capability terms swept against /api/search to discover the live catalog. upypi
# has no full-listing endpoint, so we probe by capability keyword and dedupe.
DISCOVERY_TERMS = [
    "temperature", "humidity", "pressure", "oled", "display", "led", "relay",
    "servo", "ultrasonic", "motion", "light", "adc", "rtc", "touch", "distance",
    "dht", "ssd1306", "neopixel", "ws2812", "mpu6050", "bmp280", "pir", "gas",
    "color", "ds18b20", "ds1307", "ds1302", "ads1115", "mpr121", "aht20",
]


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


def _http_get(url: str, timeout: float = 15.0) -> str:
    request = urllib.request.Request(url, headers={"user-agent": "mpyhw-ingest/0.1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def _http_get_json(url: str, timeout: float = 15.0) -> Any:
    return json.loads(_http_get(url, timeout))


def discover_packages(terms: list[str], get_json=_http_get_json) -> dict[str, str]:
    """Sweep /api/search across capability terms; return {name: version}."""
    found: dict[str, str] = {}
    for term in terms:
        try:
            data = get_json(f"{UPYPI_BASE}/api/search?q={urllib.parse.quote(term)}")
        except (urllib.error.URLError, OSError, ValueError):
            continue
        for hit in data.get("results", []):
            name = hit.get("name")
            url = (hit.get("url") or "").rstrip("/")
            version = url.rsplit("/", 1)[-1] if "/" in url else "1.0.0"
            if name and name not in found:
                found[name] = version
    return found


def fetch_source(pkg: dict[str, Any], name: str, version: str, get_text=_http_get) -> str:
    """Concatenate the package's source files (urls entries) for context extraction."""
    parts: list[str] = []
    for entry in pkg.get("urls") or []:
        if not isinstance(entry, list) or len(entry) < 2:
            continue
        try:
            parts.append(get_text(f"{UPYPI_BASE}/pkgs/{name}/{version}/{entry[1]}"))
        except (urllib.error.URLError, OSError):
            continue
    return "\n".join(parts)


def ingest_live(output_dir: str | Path, terms: list[str] | None = None, get_json=_http_get_json, get_text=_http_get) -> dict[str, Any]:
    """Pull the live upypi catalog into content/packages. Each package becomes a
    searchable record; I2C sensors that expose a constructor also get a driver
    context (generatable), others stay installable."""
    output_dir = Path(output_dir)
    (output_dir / "driver_context").mkdir(parents=True, exist_ok=True)
    records = read_existing_records(output_dir)
    existing = {(record["name"], record["version"]) for record in records}
    written = 0
    contexts: list[str] = []
    for name, version in discover_packages(terms or DISCOVERY_TERMS, get_json).items():
        try:
            pkg = get_json(f"{UPYPI_BASE}/pkgs/{name}/{version}/package.json")
        except (urllib.error.URLError, OSError, ValueError):
            continue
        version = pkg.get("version", version)
        if (name, version) in existing:
            continue
        package_json_url = f"{UPYPI_BASE}/pkgs/{name}/{version}/package.json"
        record = normalize_upypi_package({**pkg, "package_json_url": package_json_url})
        source = fetch_source(pkg, name, version, get_text)
        url_files = [entry[0] for entry in (pkg.get("urls") or []) if isinstance(entry, list) and entry]
        module_name = Path(url_files[0]).stem if url_files else name
        context = extract_driver_context({**pkg, "package_json_url": package_json_url}, pkg.get("description", ""), source, module_name=module_name)
        if context.get("constructors") and context.get("bus"):
            context_name = safe_context_filename(name, version)
            (output_dir / "driver_context" / context_name).write_text(json.dumps(context, indent=2), encoding="utf-8")
            record["driver_context_ref"] = f"driver_context/{context_name}"
            record["support_level"] = context.get("support_level", record["support_level"])
            contexts.append(context_name)
        records.append(record)
        existing.add((name, version))
        written += 1
    (output_dir / "package_index.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    evidence = {"source": "upypi-live", "records_written": written, "driver_contexts": contexts}
    (output_dir / "ingestion_evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", help="Ingest from a local fixture dir (offline/tests).")
    parser.add_argument("--live", action="store_true", help="Ingest from the live upypi.net registry.")
    parser.add_argument("--output-dir", default="content/packages")
    args = parser.parse_args()
    if args.live:
        evidence = ingest_live(args.output_dir)
        print(json.dumps(evidence, indent=2))
    elif args.fixture_dir:
        ingest_fixture_dir(args.fixture_dir, args.output_dir)
    else:
        parser.error("pass --live or --fixture-dir")


def read_existing_records(output_dir: Path) -> list[dict[str, Any]]:
    path = output_dir / "package_index.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
