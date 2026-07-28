import json
import re

import pytest

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_boards_listing_skips_a_malformed_board_file(tmp_path, monkeypatch):
    from app import routes_content

    boards_dir = tmp_path / "content" / "boards"
    boards_dir.mkdir(parents=True)
    (boards_dir / "good.json").write_text(
        json.dumps({"board_id": "good-board", "display_name": "Good", "manufacturer": "Acme"}),
        encoding="utf-8",
    )
    # Missing board_id: must be skipped, not 500 the whole listing.
    (boards_dir / "bad.json").write_text(json.dumps({"display_name": "No id"}), encoding="utf-8")
    monkeypatch.setattr(routes_content, "ROOT", tmp_path)

    response = client.get("/v1/boards")

    assert response.status_code == 200
    assert [board["board_id"] for board in response.json()["builtin"]] == ["good-board"]


def test_board_profile_is_served_with_pin_safety_data():
    response = client.get("/v1/boards/esp32-s3-devkitc-1")

    assert response.status_code == 200
    body = response.json()
    assert body["board_id"] == "esp32-s3-devkitc-1"
    assert "i2c_sda" in body["pin_recommendations"]
    assert "GPIO19" in body["forbidden_pins"]
    assert "machine" in body["available_modules"]
    assert "network" in body["available_modules"]
    assert "socket" in body["available_modules"]
    assert "ssl" in body["available_modules"]


def test_board_index_contains_detail_hashes():
    response = client.get("/v1/boards")

    assert response.status_code == 200
    body = response.json()
    assert body["builtin"][0]["detail_sha256"]


def test_expanded_board_catalog_serves_six_full_profiles():
    client = TestClient(app)
    listing = client.get("/v1/boards").json()
    ids = {b["board_id"] for b in listing["builtin"]}
    assert {
        "esp32-s3-devkitc-1", "esp32-c3-devkitm-1", "rpi-pico-w",
        "esp32-devkit-v1", "raspberry-pi-pico", "esp8266-nodemcu",
    } <= ids
    for board_id in ("esp32-devkit-v1", "raspberry-pi-pico", "esp8266-nodemcu"):
        prof = client.get(f"/v1/boards/{board_id}").json()
        assert prof["pin_recommendations"]["i2c_sda"]
        assert prof["forbidden_pins"], board_id
        assert "machine" in prof["available_modules"]


@pytest.mark.no_db
def test_micropython_board_catalog_serves_official_cached_boards(tmp_path, monkeypatch):
    from app import routes_content

    rec_dir = tmp_path / "content" / "recommendation"
    rec_dir.mkdir(parents=True)
    (rec_dir / "micropython_boards.json").write_text(
        json.dumps(
            {
                "source": "https://micropython.org/download/",
                "fetched_at": "2026-06-20T00:07:34+00:00",
                "boards": [
                    {
                        "slug": "ESP32_GENERIC_S3",
                        "name": "ESP32-S3",
                        "vendor": "Espressif",
                        "features": ["BLE", "WiFi"],
                        "detail_url": "https://micropython.org/download/ESP32_GENERIC_S3/",
                        "firmware": {"latest_release": {"url": "https://micropython.org/resources/firmware/ESP32_GENERIC_S3.bin"}},
                        "source_url": "https://github.com/micropython/micropython/tree/master/ports/esp32/boards/ESP32_GENERIC_S3",
                    },
                    {
                        "slug": "PYBD_SF2",
                        "name": "Pyboard D-series SF2",
                        "vendor": "George Robotics",
                        "features": [],
                        "detail_url": "https://micropython.org/download/PYBD_SF2/",
                    },
                    {
                        "slug": "WEACTSTUDIO_MINI_STM32H723",
                        "name": "WeAct Studio Mini STM32H723",
                        "vendor": "WeAct Studio",
                        "features": [],
                        "detail_url": "https://micropython.org/download/WEACTSTUDIO_MINI_STM32H723/",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    boards_dir = tmp_path / "content" / "boards"
    boards_dir.mkdir(parents=True)
    (boards_dir / "esp32-s3-devkitc-1.json").write_text(
        json.dumps({"board_id": "esp32-s3-devkitc-1", "display_name": "ESP32-S3 DevKitC-1"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(routes_content, "ROOT", tmp_path)
    monkeypatch.setattr(routes_content, "_skill_board_ids", lambda: {"esp32-s3-devkitc", "pybd-sf2", "weactstudio-mini-stm32h723"})

    response = client.get("/v1/micropython/boards")

    assert response.status_code == 200
    body = response.json()
    assert body["source_url"] == "https://micropython.org/download/"
    assert body["fetched_at"] == "2026-06-20T00:07:34+00:00"
    assert body["board_count"] == 3
    assert body["filters"]["vendor"] == ["Espressif", "George Robotics", "WeAct Studio"]
    assert body["filters"]["port"] == ["esp32", "stm32"]
    first = body["boards"][0]
    assert first["id"] == "esp32-s3-devkitc"
    assert first["official_id"] == "ESP32_GENERIC_S3"
    assert first["download_slug"] == "ESP32_GENERIC_S3"
    assert first["firmware"]["board_name"] == "ESP32_GENERIC_S3"
    assert first["firmware"]["url"] == "https://micropython.org/download/ESP32_GENERIC_S3/"
    assert first["port"] == "esp32"
    assert first["mcu"] == "esp32s3"
    assert first["chip_family"] == "esp32s3"
    assert first["support_status"] == "builtin_pin_layout"
    assert first["local_board_id"] == "esp32-s3-devkitc-1"
    assert first["skill_board_id"] == "esp32-s3-devkitc"
    assert first["skill_profile_available"] is True
    assert body["boards"][1]["support_status"] == "official_firmware_only"
    # A non-builtin board now serves the kebab Skill board id (Option 1) so a selected board resolves to
    # the Skill's boards/<id>.json, while official_id/download_slug keep the raw slug. Under the old
    # `skill_board_id or slug` the id was the uppercase slug (PYBD_SF2), which never matched pybd-sf2.json.
    pybd = body["boards"][1]
    assert pybd["id"] == "pybd-sf2", "non-builtin id is the kebab Skill board id, not the uppercase slug"
    assert pybd["skill_board_id"] == "pybd-sf2"
    assert pybd["skill_profile_available"] is True
    assert pybd["official_id"] == "PYBD_SF2"
    assert pybd["download_slug"] == "PYBD_SF2"
    weact = body["boards"][2]
    assert weact["id"] == "weactstudio-mini-stm32h723"
    assert weact["skill_board_id"] == "weactstudio-mini-stm32h723"
    assert weact["skill_profile_available"] is True
    # Every served id is a valid kebab (lowercase, digits, hyphens) so it can name a Skill board file.
    assert all(re.fullmatch(r"[a-z0-9-]+", b["id"]) for b in body["boards"]), "all served ids are kebab-case"


@pytest.mark.no_db
def test_real_catalog_has_no_missing_skill_profiles():
    body = client.get("/v1/micropython/boards").json()
    missing = [(board["official_id"], board["id"]) for board in body["boards"] if not board["skill_profile_available"]]

    # After the Skill added weactstudio-mini-stm32h723.json (submodule 065925f), every official board in the
    # cache resolves to a Skill profile. Reads the real submodule, so this goes green only once it is synced;
    # names any offenders if a new gap appears.
    assert missing == [], f"official boards with no Skill profile: {missing}"


VENDOR_BOARD_IDS = [
    "lilygo-t-deck-plus",
    "lilygo-t-display-s3",
    "lilygo-t-embed",
    "lilygo-t-watch-s3",
    "waveshare-esp32-s3-touch-lcd-1-54",
    "waveshare-esp32-s3-touch-lcd-2",
    "waveshare-esp32-s3-touch-lcd-2-8",
    "waveshare-esp32-s3-touch-lcd-3-5",
]


def _skill_profile(board_id: str) -> dict:
    from app import routes_content

    return json.loads((routes_content._skill_boards_dir() / f"{board_id}.json").read_text(encoding="utf-8"))


def _served_vendor_boards() -> dict[str, dict]:
    body = client.get("/v1/micropython/boards").json()
    return {b["id"]: b for b in body["boards"] if b["support_status"] == "skill_vendor_profile"}


@pytest.mark.no_db
def test_curated_vendor_boards_are_appended_to_the_official_board_list():
    body = client.get("/v1/micropython/boards").json()
    vendor = {b["id"]: b for b in body["boards"] if b["support_status"] == "skill_vendor_profile"}

    assert sorted(vendor) == VENDOR_BOARD_IDS
    for board_id, entry in vendor.items():
        source = _skill_profile(board_id)
        assert entry["skill_board_id"] == board_id
        assert entry["skill_profile_available"] is True
        assert entry["display_name"] == source["display_name"]
        assert entry["vendor"] == source["vendor"]
        assert entry["mcu"] == source["mcu"]
        assert entry["features"] == source["features"]
        # Port is derived from the firmware block: vendor profiles carry no top-level port.
        assert entry["port"] == source["firmware"]["port"] == "esp32"
        # Exact equality, not a subset: a future field drop in the emit must fail here.
        assert entry["firmware"] == source["firmware"], board_id
        assert entry["firmware"]["variant"] == "spiram-oct"
        assert entry["firmware"]["flash_method"] == "esptool"
        # No official download slug of their own; they share the ESP32_GENERIC_S3 firmware page.
        assert entry["official_id"] is None
        assert entry["download_slug"] is None
        assert entry["local_board_id"] is None
        assert entry["detail_url"] == source["firmware"]["url"]

    # The filters the picker builds its dropdowns from must include the vendor families.
    assert "LILYGO" in body["filters"]["vendor"]
    assert "Waveshare" in body["filters"]["vendor"]
    assert body["board_count"] == len(body["boards"])

    # Board ids must stay globally unique across the official + vendor append. On a collision the
    # picker's find-by-id keeps the first match, so the second board renders but is unselectable.
    # This fails at the next index or submodule bump that reuses an id, no runtime guard needed.
    ids = [b["id"] for b in body["boards"]]
    assert len(set(ids)) == len(ids)


@pytest.mark.no_db
def test_official_board_entries_are_unchanged_by_the_vendor_append():
    body = client.get("/v1/micropython/boards").json()
    official = [b for b in body["boards"] if b["support_status"] != "skill_vendor_profile"]
    cached = json.loads(_official_boards_cache().read_text(encoding="utf-8"))

    # The official index still is exactly the official download page: one entry per cached slug,
    # none of them re-labelled or given vendor-profile firmware fields.
    assert [b["official_id"] for b in official] == [b["slug"] for b in cached["boards"] if b.get("slug")]
    assert all(b["support_status"] in {"builtin_pin_layout", "official_firmware_only"} for b in official)
    assert all("variant" not in b["firmware"] for b in official)
    generic_s3 = next(b for b in official if b["official_id"] == "ESP32_GENERIC_S3")
    assert generic_s3["download_slug"] == "ESP32_GENERIC_S3"
    assert generic_s3["firmware"]["board_name"] == "ESP32_GENERIC_S3"


def _official_boards_cache():
    from app import routes_content

    return routes_content._official_boards_path()


@pytest.mark.no_db
def test_vendor_families_without_ui_opt_in_stay_out_of_the_board_list():
    from app import routes_content

    # These profiles ship in the pinned Skill submodule with firmware workflows the flash phase
    # does not implement yet (github_release_zip / vendor_direct) and no ui_visible opt-in, so the
    # curated emit must not surface them. Guards the opt-in filter, not just the current board set.
    not_opted_in = ["w5100s-evb-pico2", "w5500-evb-pico2", "w6300-evb-pico2", "w55mh32l-evb"]
    for board_id in not_opted_in:
        profile = _skill_profile(board_id)
        assert profile.get("ui_visible") is not True, board_id
        assert profile.get("support_status") != "skill_vendor_profile", board_id
        assert (routes_content._skill_boards_dir() / f"{board_id}.json").exists(), board_id

    served = _served_vendor_boards()
    assert [board_id for board_id in not_opted_in if board_id in served] == []


@pytest.mark.no_db
def test_served_vendor_board_carries_the_onboard_driver_package_metadata_verbatim():
    served = _served_vendor_boards()

    # An I/O expander whose driver package must be installed before the EXIO-controlled LCD reset,
    # touch INT and SD CS lines work: the package fields have to reach the phases unfiltered.
    expander_source = next(
        p for p in _skill_profile("waveshare-esp32-s3-touch-lcd-3-5")["onboard_peripherals"]
        if p["type"] == "io_expander"
    )
    expander = next(
        p for p in served["waveshare-esp32-s3-touch-lcd-3-5"]["onboard_peripherals"]
        if p["type"] == "io_expander"
    )
    assert expander == expander_source
    assert expander["driver"] == expander_source["driver"]
    assert expander["driver"]["package_name"] == "tca9554_driver"
    assert expander["driver"]["install_cmd"] == expander_source["driver"]["install_cmd"]
    assert expander["expanded_pins"] == expander_source["expanded_pins"]

    # A revision-dependent touch controller: the aliases and the partial-mapping note are the whole
    # point of the entry (one revision has a uPyPi package, the other does not), so they must survive.
    touch_source = next(
        p for p in _skill_profile("waveshare-esp32-s3-touch-lcd-2-8")["onboard_peripherals"]
        if p["type"] == "touch_controller"
    )
    touch = next(
        p for p in served["waveshare-esp32-s3-touch-lcd-2-8"]["onboard_peripherals"]
        if p["type"] == "touch_controller"
    )
    assert touch == touch_source
    assert touch["aliases"] == touch_source["aliases"] == ["CST3530"]
    assert touch["driver"] == touch_source["driver"]
    assert touch["driver"]["mapping_status"] == "revision_dependent_partial_upypi_mapping"
    assert touch["driver"]["unmapped_models"] == ["CST3530"]
    # Not promoted to a ready driver just because one revision has a package.
    assert touch["driver"].get("status") is None

    # A driver that needs a binary config blob flashed alongside the module: without asset_files
    # the deploy phase installs the package and the IMU never initialises. The only profile in
    # the pinned Skill set carrying the field, so it is the one case that catches an emit which
    # projects `driver` down to the install fields.
    imu_source = next(
        p for p in _skill_profile("lilygo-t-watch-s3")["onboard_peripherals"]
        if p["type"] == "imu"
    )
    imu = next(
        p for p in served["lilygo-t-watch-s3"]["onboard_peripherals"]
        if p["type"] == "imu"
    )
    assert imu == imu_source
    assert imu["driver"] == imu_source["driver"]
    assert imu["driver"]["asset_files"] == imu_source["driver"]["asset_files"] == ["bma423conf.bin"]


@pytest.mark.no_db
def test_a_malformed_vendor_profile_is_skipped_without_dropping_the_others(tmp_path, monkeypatch):
    from app import routes_content

    boards_dir = tmp_path / "boards"
    boards_dir.mkdir(parents=True)
    real_dir = routes_content._skill_boards_dir()
    for board_id in ("lilygo-t-watch-s3", "waveshare-esp32-s3-touch-lcd-2"):
        (boards_dir / f"{board_id}.json").write_bytes((real_dir / f"{board_id}.json").read_bytes())
    (boards_dir / "broken-vendor-board.json").write_text("{not json", encoding="utf-8")
    # Valid JSON in the wrong encoding: unreadable content, not an OS error, so it is skipped
    # like the unparseable one instead of raising out of the listing. Written as raw latin-1
    # bytes (a real 0xE9), and otherwise a complete emittable profile, so the decode error is
    # the only thing that can keep it out of the listing.
    (boards_dir / "latin1-vendor-board.json").write_bytes(
        '{"ui_visible": true, "support_status": "skill_vendor_profile", "id": "café-board",'
        ' "firmware": {"port": "esp32", "board_name": "ESP32_GENERIC_S3"}}'.encode("latin-1")
    )
    # A top-level array where a board object is expected.
    (boards_dir / "array-vendor-board.json").write_text(json.dumps([{"id": "not-a-board"}]), encoding="utf-8")
    # Opted in for the UI but with no id/firmware to emit: skipped like the unparseable one.
    (boards_dir / "idless-vendor-board.json").write_text(
        json.dumps({"ui_visible": True, "support_status": "skill_vendor_profile", "display_name": "No id"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(routes_content, "_skill_boards_dir", lambda: boards_dir)

    served = _served_vendor_boards()

    assert sorted(served) == ["lilygo-t-watch-s3", "waveshare-esp32-s3-touch-lcd-2"]
    assert served["waveshare-esp32-s3-touch-lcd-2"]["firmware"]["variant"] == "spiram-oct"


@pytest.mark.no_db
def test_a_non_scalar_vendor_or_feature_value_cannot_500_the_whole_listing(tmp_path, monkeypatch):
    from app import routes_content

    boards_dir = tmp_path / "boards"
    boards_dir.mkdir(parents=True)
    real_dir = routes_content._skill_boards_dir()
    (boards_dir / "lilygo-t-watch-s3.json").write_bytes((real_dir / "lilygo-t-watch-s3.json").read_bytes())
    # `id` and `firmware` are well-formed, so this profile passes _vendor_board_entry and reaches
    # the `filters` set-comprehensions. Before the str()/isinstance guards a list `vendor` raised
    # TypeError: unhashable type there -- after every board was already collected, so this one
    # hand-edited field took down the entire picker rather than skipping its own board.
    (boards_dir / "sloppy-vendor-board.json").write_text(
        json.dumps(
            {
                "ui_visible": True,
                "support_status": "skill_vendor_profile",
                "id": "sloppy-vendor-board",
                "vendor": ["LILYGO"],
                "display_name": {"en": "Sloppy"},
                "features": ["wifi", {"nested": "object"}, 42],
                "firmware": {"port": "esp32", "board_name": "ESP32_GENERIC_S3"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(routes_content, "_skill_boards_dir", lambda: boards_dir)

    response = client.get("/v1/micropython/boards")

    assert response.status_code == 200
    served = _served_vendor_boards()
    # The good board is still listed: one sloppy profile must not cost the others.
    assert sorted(served) == ["lilygo-t-watch-s3", "sloppy-vendor-board"]
    sloppy = served["sloppy-vendor-board"]
    assert isinstance(sloppy["vendor"], str)
    assert isinstance(sloppy["display_name"], str)
    # Non-str feature entries are dropped, not coerced into selectable filter values.
    assert sloppy["features"] == ["wifi"]
    body = response.json()
    assert all(isinstance(v, str) for v in body["filters"]["vendor"])
    assert all(isinstance(v, str) for v in body["filters"]["feature"])


@pytest.mark.no_db
def test_no_vendor_boards_are_served_without_a_skill_submodule_checkout(tmp_path, monkeypatch):
    from app import routes_content

    # A fresh clone has an empty submodule directory: the official index must still be served.
    monkeypatch.setattr(routes_content, "_skill_boards_dir", lambda: tmp_path / "missing")

    body = client.get("/v1/micropython/boards").json()

    assert body["boards"], "official boards still served without the Skill submodule"
    assert [b for b in body["boards"] if b["support_status"] == "skill_vendor_profile"] == []


def test_board_route_rejects_encoded_backslash_path_traversal():
    response = client.get("/v1/boards/..%5Cpackages%5Cpackage_index")

    assert response.status_code == 404
    assert "aht20_driver" not in response.text


def test_skill_catalog_and_body_are_served():
    catalog = client.get("/v1/skills")

    assert catalog.status_code == 200
    names = [skill["name"] for skill in catalog.json()["skills"]]
    # V0: only the 6 protocol-native `-plugin` skills are surfaced to the build agent.
    assert "upy-analyze-plugin" in names
    assert "upy-select-hw-plugin" in names
    assert "upy-flash-mpy-firmware-plugin" in names
    assert "upy-scaffold-plugin" in names
    assert "upy-generate-plugin" in names
    assert "upy-deploy-plugin" in names
    # The pre-V0 non-plugin skill names are no longer served.
    assert "upy-analyze" not in names
    assert "upy-wiring" not in names
    # Driver-authoring / low-level mpremote skills ship in the submodule but
    # are NOT served on the consumer surface.
    assert "upy-norm-driver" not in names
    assert "mpremote-device-interaction" not in names

    # Catalog descriptions come from the SKILL.md frontmatter, not "---".
    generate = next(s for s in catalog.json()["skills"] if s["name"] == "upy-generate-plugin")
    assert generate["description"] and not generate["description"].startswith("-")

    body = client.get("/v1/skills/upy-generate-plugin")
    assert body.status_code == 200
    assert "generate" in body.text.lower()
    assert body.headers["etag"]

    # A real upstream skill that is deliberately not served → 404.
    assert client.get("/v1/skills/upy-norm-driver").status_code == 404


def test_skill_route_rejects_path_traversal():
    response = client.get("/v1/skills/..%5C..%5Cpackages%5Cpackage_index")

    assert response.status_code == 404


def test_skills_listing_carries_protocol_version():
    # The sanitized /v1/phase-profiles surface is gone (the model now reads the full
    # SKILL.md). /v1/skills instead carries protocol_version for the client skew check.
    listing = client.get("/v1/skills")
    assert listing.status_code == 200
    body = listing.json()
    assert body["protocol_version"]
    assert body["skills"]


def test_phase_profiles_route_is_removed():
    # The sanitized phase-profile endpoint was deleted in the protocol rewrite.
    assert client.get("/v1/phase-profiles").status_code == 404
    assert client.get("/v1/phase-profiles/analyze").status_code == 404
