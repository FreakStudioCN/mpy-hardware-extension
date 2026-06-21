from fastapi.testclient import TestClient

from app.main import app
from app.package_store import NORMALIZED_PACKAGE_FIELDS, PackageStore, infer_capabilities, normalize_record


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


def test_infer_capabilities_does_not_mistag_bmp390_as_audio():
    # Regression: the audio_output keyword "mp3" is a bare substring and matched
    # "b(mp3)90", mis-tagging the bmp390 barometer as an audio part.
    caps = infer_capabilities({"name": "bmp390_driver", "description": "A MicroPython library to control bmp390_driver"})

    assert "pressure_sensing" in caps
    assert "audio_output" not in caps
    # A genuine MP3 player module is still recognised as audio_output.
    assert "audio_output" in infer_capabilities({"name": "jq6500_driver", "description": "JQ6500 MP3 player"})


def test_audio_output_search_returns_a_real_audio_part():
    # With the mis-tag fixed (keyword + baked catalog data), the top audio hit is an
    # actual audio module, not the bmp390 barometer that used to sort first by name.
    store = PackageStore.default()
    top = store.search("play a sound", ["audio_output"], limit=1)

    assert top
    assert top[0]["name"] != "bmp390_driver"
    assert "audio_output" in top[0]["capabilities"]


def test_search_demotes_wrong_board_family_parts():
    # Same capability, two equal candidates differing only by chip family: the one that
    # matches the requested board family must win, so the website never recommends an
    # rp2040-only driver for an esp32 board (or vice versa).
    base = {"version": "1", "source": "curated", "capabilities": ["digital_output"],
            "support_level": "installable", "confidence": 0.5, "package_json_url": "x"}
    store = PackageStore([
        {**base, "name": "esp_only", "chips": "esp32"},
        {**base, "name": "pico_only", "chips": "rp2040"},
    ])

    assert store.search("", ["digital_output"], board_family="esp32")[0]["name"] == "esp_only"
    assert store.search("", ["digital_output"], board_family="rp2040")[0]["name"] == "pico_only"
