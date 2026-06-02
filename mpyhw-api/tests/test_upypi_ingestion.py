import json
from pathlib import Path

import pytest

from scripts.ingest_upypi import ingest_fixture_dir, normalize_upypi_package


FIXTURES = Path(__file__).parent / "fixtures" / "package_sources" / "upypi"


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
