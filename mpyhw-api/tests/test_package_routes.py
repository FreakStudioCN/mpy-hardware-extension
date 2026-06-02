import json

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_store_tolerates_partial_index_records(tmp_path, monkeypatch):
    # An ingested package_index row missing fields (support_level, capabilities,
    # package_json_url, source) must be normalized on load, not crash index()/
    # search() with a KeyError.
    from app import package_store

    pkg = tmp_path / "content" / "packages"
    pkg.mkdir(parents=True)
    (pkg / "curated-driver-contexts.json").write_text(
        json.dumps([
            {"name": "aht20_driver", "version": "1.0.0", "source": "curated",
             "package_json_url": "u", "capabilities": ["temperature_sensing"], "support_level": "verified"},
        ]),
        encoding="utf-8",
    )
    (pkg / "package_index.json").write_text(
        json.dumps([{"name": "partial_pkg", "version": "0.1.0"}]),
        encoding="utf-8",
    )
    monkeypatch.setattr(package_store, "ROOT", tmp_path)

    store = package_store.PackageStore.default()

    assert store.index()["total_packages"] == 2
    hits = store.search("", ["temperature_sensing"])
    assert any(hit["name"] == "aht20_driver" for hit in hits)
    partial = next(record for record in store.records if record["name"] == "partial_pkg")
    assert partial["support_level"] == "discoverable"
    assert partial["capabilities"] == []


def test_temperature_resolve_selects_aht20():
    response = client.post(
        "/v1/packages/resolve",
        json={
            "intent": "turn on the LED when temperature is over 30",
            "capabilities": ["temperature_sensing"],
            "board_id": "esp32-s3-devkitc-1",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["selected"]["name"] == "aht20_driver"
    assert body["selected"]["support_level"] == "generatable"


def test_digital_output_resolve_selects_builtin_led():
    response = client.post(
        "/v1/packages/resolve",
        json={
            "intent": "blink led",
            "capabilities": ["digital_output"],
            "board_id": "esp32-s3-devkitc-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["selected"]["name"] == "machine_pin_led"


def test_temperature_plus_led_resolve_selects_sensor_first():
    response = client.post(
        "/v1/packages/resolve",
        json={
            "intent": "超过30度亮红灯",
            "capabilities": ["temperature_sensing", "digital_output"],
            "board_id": "esp32-s3-devkitc-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["selected"]["name"] == "aht20_driver"


def test_display_resolve_selects_ssd1306():
    response = client.post(
        "/v1/packages/resolve",
        json={
            "intent": "show temperature on an oled display",
            "capabilities": ["display_text"],
            "board_id": "esp32-s3-devkitc-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["selected"]["name"] == "ssd1306"


def test_unknown_package_returns_package_not_found():
    response = client.get("/v1/packages/not_real/0.0.0")

    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "package_not_found"


def test_missing_context_returns_driver_context_missing():
    response = client.get("/v1/packages/incomplete_sensor/0.1.0/driver-context")

    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "driver_context_missing"


def test_package_endpoint_returns_support_level_and_install_url():
    response = client.get("/v1/packages/aht20_driver/1.0.0")

    assert response.status_code == 200
    body = response.json()
    assert body["support_level"] == "generatable"
    assert body["package_json_url"].startswith("https://")
