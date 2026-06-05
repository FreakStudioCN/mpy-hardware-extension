import glob
import json
from pathlib import Path

from app.package_store import canonical_chip_id, dedupe_by_chip
from app.schema_validate import validate_driver_context
from scripts.finalize_catalog import finalize_index

CONTENT = Path(__file__).resolve().parents[1] / "content" / "packages"


def test_every_committed_driver_context_validates_against_schema():
    failures = []
    for path in sorted(glob.glob(str(CONTENT / "driver_context" / "*.json"))):
        errors = validate_driver_context(json.loads(Path(path).read_text(encoding="utf-8")))
        if errors:
            failures.append((Path(path).name, errors[:3]))
    for record in json.loads((CONTENT / "curated-driver-contexts.json").read_text(encoding="utf-8")):
        context = record.get("driver_context")
        if context and (errors := validate_driver_context(context)):
            failures.append((record["name"], errors[:3]))
    assert not failures, f"schema-invalid committed contexts: {failures}"


def test_canonical_chip_id_collapses_real_overlaps_but_keeps_near_names_distinct():
    # The 4 real GraftSense/uPyPI overlaps collapse to one id.
    for graft, upypi in [
        ("bmp280_driver", "bmp280"),
        ("VEML7700_driver", "veml7700"),
        ("neopixel_matrix_driver", "neopixel_matrix"),
        ("bh1750_driver", "bh1750"),
    ]:
        assert canonical_chip_id(graft) == canonical_chip_id(upypi)
    # Near-names must stay distinct (no over-merging).
    assert canonical_chip_id("bmp280") != canonical_chip_id("bmp390")
    assert canonical_chip_id("ssd1306") != canonical_chip_id("ssd1327")


def test_dedupe_by_chip_keeps_strongest():
    records = [
        {"name": "bmp280", "version": "1.0.0", "source": "upypi", "support_level": "installable",
         "confidence": 0.0, "package_json_url": "https://upypi.net/pkgs/bmp280/1.0.0/package.json"},
        {"name": "bmp280_driver", "version": "1.0.0", "source": "graftsense", "support_level": "generatable",
         "confidence": 0.8, "driver_context_ref": "driver_context/bmp280_driver-1.0.0.json",
         "package_json_url": "github:FreakStudioCN/.../bmp280_driver"},
    ]
    deduped = dedupe_by_chip(records)
    assert len(deduped) == 1
    assert deduped[0]["name"] == "bmp280_driver"  # generatable graftsense wins, weaker upypi dropped


def test_dedupe_by_chip_is_order_independent():
    a = {"name": "x_driver", "version": "1.0.0", "source": "graftsense", "support_level": "generatable",
         "confidence": 0.8, "driver_context_ref": "driver_context/x_driver-1.0.0.json", "package_json_url": "g"}
    b = {"name": "x", "version": "1.0.0", "source": "upypi", "support_level": "installable",
         "confidence": 0.0, "package_json_url": "u"}
    assert dedupe_by_chip([a, b])[0]["name"] == dedupe_by_chip([b, a])[0]["name"] == "x_driver"


def test_finalize_index_is_idempotent_and_prunes_orphans(tmp_path):
    (tmp_path / "driver_context").mkdir()
    records = [
        {"name": "zeta", "version": "1.0.0", "source": "upypi", "support_level": "installable"},
        {"name": "alpha_driver", "version": "1.0.0", "source": "graftsense", "support_level": "generatable",
         "confidence": 0.8, "driver_context_ref": "driver_context/alpha_driver-1.0.0.json"},
    ]
    (tmp_path / "package_index.json").write_text(json.dumps(records), encoding="utf-8")
    (tmp_path / "driver_context" / "alpha_driver-1.0.0.json").write_text(json.dumps({"bus": ["i2c"]}), encoding="utf-8")
    orphan = tmp_path / "driver_context" / "ghost-9.9.9.json"
    orphan.write_text(json.dumps({"bus": []}), encoding="utf-8")

    result = finalize_index(tmp_path)
    first = (tmp_path / "package_index.json").read_text(encoding="utf-8")

    assert not orphan.exists()  # unreferenced context pruned
    assert "ghost-9.9.9.json" in result["pruned_contexts"]
    written = json.loads(first)
    assert [r["name"] for r in written] == ["alpha_driver", "zeta"]  # stable canonical sort

    finalize_index(tmp_path)  # second run is a byte-for-byte no-op
    assert (tmp_path / "package_index.json").read_text(encoding="utf-8") == first


def test_finalize_index_downgrades_and_reports_schema_invalid_context(tmp_path):
    (tmp_path / "driver_context").mkdir()
    records = [
        {"name": "broken_driver", "version": "1.0.0", "source": "graftsense",
         "support_level": "generatable", "confidence": 0.8,
         "driver_context_ref": "driver_context/broken_driver-1.0.0.json"},
    ]
    (tmp_path / "package_index.json").write_text(json.dumps(records), encoding="utf-8")
    # Missing required keys + confidence out of range -> schema-invalid.
    (tmp_path / "driver_context" / "broken_driver-1.0.0.json").write_text(
        json.dumps({"import_names": ["x"], "confidence": 2.0}), encoding="utf-8")

    result = finalize_index(tmp_path)
    record = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))[0]

    assert record["support_level"] == "installable"          # downgraded
    assert "driver_context_ref" not in record                # bad context dropped
    assert result["invalid_contexts"][0]["name"] == "broken_driver"
    assert not (tmp_path / "driver_context" / "broken_driver-1.0.0.json").exists()  # pruned


def test_finalize_validates_before_dedupe_keeps_valid_generatable_over_invalid_winner(tmp_path):
    # Same chip from two sources: the stronger-ranked record (higher confidence) has a
    # schema-INVALID context; the weaker one has a VALID context. Validating BEFORE
    # dedupe downgrades the invalid record first, so the valid generatable wins the
    # tiebreak instead of being discarded behind the malformed winner.
    (tmp_path / "driver_context").mkdir()
    valid = {
        "import_names": ["foo"], "constructors": ["Foo(i2c)"], "read_methods": ["read()"],
        "read_properties": [], "bus": ["i2c"], "pin_roles": ["scl", "sda"],
        "install": {"method": "mip"}, "examples": [], "known_issues": [],
        "evidence_refs": [], "confidence": 0.8,
    }
    records = [
        {"name": "foo_driver", "version": "1.0.0", "source": "graftsense", "support_level": "generatable",
         "confidence": 0.9, "driver_context_ref": "driver_context/foo_driver-1.0.0.json"},
        {"name": "foo", "version": "1.0.0", "source": "upypi", "support_level": "generatable",
         "confidence": 0.8, "driver_context_ref": "driver_context/foo-1.0.0.json"},
    ]
    (tmp_path / "package_index.json").write_text(json.dumps(records), encoding="utf-8")
    (tmp_path / "driver_context" / "foo_driver-1.0.0.json").write_text(
        json.dumps({"import_names": ["x"], "confidence": 2.0}), encoding="utf-8")  # invalid
    (tmp_path / "driver_context" / "foo-1.0.0.json").write_text(json.dumps(valid), encoding="utf-8")

    finalize_index(tmp_path)
    final = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))

    assert len(final) == 1
    winner = final[0]
    assert winner["name"] == "foo"                                  # valid record survived
    assert winner["support_level"] == "generatable"
    assert winner["driver_context_ref"] == "driver_context/foo-1.0.0.json"
    assert (tmp_path / "driver_context" / "foo-1.0.0.json").exists()             # valid context kept
    assert not (tmp_path / "driver_context" / "foo_driver-1.0.0.json").exists()  # invalid pruned
