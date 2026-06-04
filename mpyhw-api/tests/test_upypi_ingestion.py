import json
from pathlib import Path

import pytest

from scripts.ingest_upypi import (
    discover_packages,
    ingest_fixture_dir,
    ingest_live,
    normalize_upypi_package,
    reconcile_driver_context_refs,
)


FIXTURES = Path(__file__).parent / "fixtures" / "package_sources" / "upypi"


def test_safe_context_filename_strips_path_separators():
    from app.package_store import safe_context_filename

    out = safe_context_filename("../../../evil", "1.0")
    assert "/" not in out and "\\" not in out
    assert out.endswith(".json")
    # benign names are preserved verbatim (existing curated refs must not change)
    assert safe_context_filename("aht20_driver", "1.0.0") == "aht20_driver-1.0.0.json"


def test_upypi_package_json_normalizes_required_fields():
    raw = json.loads((FIXTURES / "aht20-package.json").read_text(encoding="utf-8"))

    record = normalize_upypi_package(raw)

    assert record["name"] == "aht20_driver"
    assert record["source"] == "upypi"
    assert record["chips"] == "all"
    assert record["fw"] == "all"
    assert record["support_level"] == "installable"


def test_malformed_upypi_package_is_rejected():
    raw = json.loads((FIXTURES / "malformed-package.json").read_text(encoding="utf-8"))

    with pytest.raises(ValueError, match="missing required package fields"):
        normalize_upypi_package(raw)


def test_upypi_fixture_ingestion_writes_index_and_evidence(tmp_path):
    result = ingest_fixture_dir(FIXTURES, tmp_path)

    index = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))
    evidence = json.loads((tmp_path / "ingestion_evidence.json").read_text(encoding="utf-8"))

    assert result["records_written"] == 1
    assert index[0]["source"] == "upypi"
    assert evidence["source"] == "upypi"
    assert evidence["duplicates_skipped"] == ["aht20_driver@1.0.0"]


def test_discover_packages_keeps_highest_version_when_feed_is_unsorted():
    def get_json(url):
        assert url == "https://upypi.net/packages.json"
        return {
            "packages": [
                {"name": "sensor_driver", "version": "1.0.10"},
                {"name": "sensor_driver", "version": "1.0.2"},
                {"name": "display_driver", "version": "0.9.0"},
                {"name": "", "version": "9.9.9"},
                {"name": "bad_driver"},
            ]
        }

    assert discover_packages(get_json) == {
        "sensor_driver": "1.0.10",
        "display_driver": "0.9.0",
    }


def test_reconcile_driver_context_refs_indexes_orphan_context(tmp_path):
    (tmp_path / "driver_context").mkdir()
    (tmp_path / "package_index.json").write_text(
        json.dumps(
            [
                normalize_upypi_package(
                    {
                        "name": "ads1015_driver",
                        "version": "1.0.2",
                        "description": "Existing description",
                    }
                )
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    (tmp_path / "driver_context" / "ads1015_driver-1.0.2.json").write_text(
        json.dumps(
            {
                "install": {"url": "https://upypi.net/pkgs/ads1015_driver/1.0.2/package.json"},
                "support_level": "generatable",
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "driver_context" / "orphan_driver-2.0.0.json").write_text(
        json.dumps(
            {
                "install": {"url": "https://upypi.net/pkgs/orphan_driver/2.0.0/package.json"},
                "support_level": "generatable",
            }
        ),
        encoding="utf-8",
    )

    records = reconcile_driver_context_refs(tmp_path)

    by_name = {record["name"]: record for record in records}
    assert by_name["ads1015_driver"]["description"] == "Existing description"
    assert by_name["ads1015_driver"]["support_level"] == "generatable"
    assert by_name["ads1015_driver"]["driver_context_ref"] == "driver_context/ads1015_driver-1.0.2.json"
    assert by_name["orphan_driver"]["source"] == "upypi"
    assert by_name["orphan_driver"]["package_json_url"] == "https://upypi.net/pkgs/orphan_driver/2.0.0/package.json"
    assert by_name["orphan_driver"]["driver_context_ref"] == "driver_context/orphan_driver-2.0.0.json"

    written = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))
    assert {record["name"] for record in written} == {"ads1015_driver", "orphan_driver"}


def test_ingest_live_links_generated_driver_contexts_in_package_index(tmp_path):
    package = {
        "name": "aht20_driver",
        "version": "1.0.0",
        "description": "AHT20 temperature humidity driver",
        "urls": [["aht20.py", "aht20.py"]],
    }

    def get_json(url):
        if url == "https://upypi.net/packages.json":
            return {"packages": [{"name": "aht20_driver", "version": "1.0.0"}]}
        if url == "https://upypi.net/pkgs/aht20_driver/1.0.0/package.json":
            return package
        raise AssertionError(f"unexpected URL {url}")

    def get_text(url):
        assert url == "https://upypi.net/pkgs/aht20_driver/1.0.0/aht20.py"
        return """
class AHT20:
    def __init__(self, i2c):
        self.i2c = i2c

    def read(self):
        return 20
"""

    ingest_live(tmp_path, get_json=get_json, get_text=get_text)

    records = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))
    assert records[0]["driver_context_ref"] == "driver_context/aht20_driver-1.0.0.json"
    assert records[0]["support_level"] == "generatable"
