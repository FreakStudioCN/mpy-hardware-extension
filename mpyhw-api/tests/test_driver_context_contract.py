import hashlib
from pathlib import Path

from app.package_store import PackageStore


ROOT = Path(__file__).resolve().parents[1]


def test_aht20_evidence_fixture_is_unmodified_tripwire():
    # NOTE: this is a DATA-FIXTURE integrity tripwire, not behavior coverage. It
    # exercises no app code — it only catches the evidence source being edited
    # without regenerating SHA256SUMS. Behavior is covered by the tests below.
    evidence = ROOT / "content" / "packages" / "evidence" / "aht20-driver-source.py"
    sums = ROOT / "content" / "packages" / "evidence" / "SHA256SUMS"
    expected = sums.read_text(encoding="utf-8").split()[0]

    actual = hashlib.sha256(evidence.read_bytes()).hexdigest()

    assert actual == expected


def test_aht20_context_matches_evidence_api_shape():
    source = (ROOT / "content" / "packages" / "evidence" / "aht20-driver-source.py").read_text(encoding="utf-8")
    context = PackageStore.default().get_driver_context("aht20_driver", "1.0.0")

    assert "class AHT20" in source
    assert "def temperature" in source
    assert "def relative_humidity" in source
    assert context["constructors"] == ["AHT20(i2c)"]
    assert "temperature" in context["read_properties"]
    assert "relative_humidity" in context["read_properties"]


def test_verified_records_have_evidence_backed_context():
    store = PackageStore.default()

    for record in store.records:
        if record["support_level"] != "verified":
            continue

        context = store.get_driver_context(record["name"], record["version"])
        assert context["evidence_refs"], record["name"]
        assert context["constructors"], record["name"]
        assert context["import_names"], record["name"]
        if not context["install"].get("builtin"):
            assert context["install"]["url"].startswith("https://")
