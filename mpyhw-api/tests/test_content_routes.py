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
    assert "mpremote-device-interaction" in names
    assert "upy-analyze" in names
    assert "upy-select-hw" in names
    assert "upy-generate" in names
    assert "upy-autofix" in names

    body = client.get("/v1/skills/mpremote-device-interaction")
    assert body.status_code == 200
    assert "mpremote" in body.text
    assert body.headers["etag"]

    live_session = client.get("/v1/skills/mpremote-live-session")
    assert live_session.status_code == 200
    assert "persistent session" in live_session.text.lower()


def test_skill_route_rejects_path_traversal():
    response = client.get("/v1/skills/..%5C..%5Cpackages%5Cpackage_index")

    assert response.status_code == 404
