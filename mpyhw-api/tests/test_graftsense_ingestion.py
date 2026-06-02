import json
from pathlib import Path

import pytest

from scripts.ingest_graftsense import ingest_fixture_dir


FIXTURES = Path(__file__).parent / "fixtures" / "package_sources" / "graftsense"


def test_graftsense_fixture_ingestion_extracts_context(tmp_path):
    result = ingest_fixture_dir(FIXTURES, tmp_path)

    index = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))
    context_path = tmp_path / "driver_context" / "graftsense_aht20-1.0.0.json"
    context = json.loads(context_path.read_text(encoding="utf-8"))

    assert result["records_written"] == 1
    assert index[0]["driver_context_ref"] == "driver_context/graftsense_aht20-1.0.0.json"
    assert context["import_names"] == ["aht20"]
    assert context["constructors"] == ["AHT20(i2c)"]
    assert "temperature" in context["read_properties"]
    assert context["pin_roles"] == ["i2c_sda", "i2c_scl"]
    assert context["evidence_refs"]


def test_graftsense_missing_package_json_fails(tmp_path):
    with pytest.raises(FileNotFoundError):
        ingest_fixture_dir(FIXTURES / "missing", tmp_path)
