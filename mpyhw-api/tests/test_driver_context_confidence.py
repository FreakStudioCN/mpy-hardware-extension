from scripts.normalize_driver_context import evaluate_support_level, extract_driver_context


def test_generatable_requires_api_shape_evidence():
    context = extract_driver_context(
        package={"name": "aht20_driver", "version": "1.0.0", "package_json_url": "https://example.test/package.json"},
        readme="from aht20 import AHT20\nsensor = AHT20(i2c)\nprint(sensor.temperature)",
        source="class AHT20:\n    @property\n    def temperature(self):\n        return 1",
    )

    assert context["support_level"] == "generatable"
    assert context["confidence"] >= 0.7


def test_verified_is_downgraded_without_contract_and_smoke_evidence():
    level = evaluate_support_level(
        {"package_json_url": "https://example.test/package.json"},
        {"evidence_refs": [{"type": "source"}], "constructors": ["AHT20(i2c)"], "read_properties": ["temperature"]},
        requested_level="verified",
        contract_evidence=False,
        smoke_evidence=False,
    )

    assert level == "generatable"


def test_verified_requires_all_evidence_gates():
    level = evaluate_support_level(
        {"package_json_url": "https://example.test/package.json"},
        {"evidence_refs": [{"type": "source"}, {"type": "hardware_smoke"}], "constructors": ["AHT20(i2c)"], "read_properties": ["temperature"]},
        requested_level="verified",
        contract_evidence=True,
        smoke_evidence=True,
    )

    assert level == "verified"
