from fastapi.testclient import TestClient

from app.main import app
from app.package_store import NORMALIZED_PACKAGE_FIELDS, PackageStore, normalize_record


def test_curated_upypi_and_graftsense_records_normalize_to_one_schema():
    raw_records = [
        {"name": "curated_led", "version": "builtin", "source": "curated", "description": "LED", "capabilities": ["digital_output"], "package_json_url": "builtin://machine.Pin"},
        {"name": "upypi_aht20", "version": "1.0.0", "source": "upypi", "description": "AHT20", "urls": [["package.json", "/package.json"]]},
        {"name": "graftsense_aht20", "version": "1.0.0", "source": "graftsense", "description": "AHT20", "repository_url": "https://example.test/repo"},
    ]

    normalized = [normalize_record(record) for record in raw_records]

    for record in normalized:
        assert set(NORMALIZED_PACKAGE_FIELDS).issubset(record)
        assert "source_specific" not in record


def test_package_endpoint_does_not_leak_internal_store_fields():
    response = TestClient(app).get("/v1/packages/aht20_driver/1.0.0")

    assert response.status_code == 200
    body = response.json()
    assert set(NORMALIZED_PACKAGE_FIELDS).issubset(body)
    for internal in ["score_base", "reason_rules", "driver_context_ref", "evidence_refs", "driver_context"]:
        assert internal not in body


def test_search_returns_deterministic_score_and_reason():
    store = PackageStore.default()
    first = store.search("temperature", ["temperature_sensing"])
    second = store.search("temperature", ["temperature_sensing"])

    assert first == second
    assert isinstance(first[0]["score"], float)
    assert first[0]["reason"]
    assert first[0]["name"] == "aht20_driver"
