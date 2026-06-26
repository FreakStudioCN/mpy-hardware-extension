import json

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
