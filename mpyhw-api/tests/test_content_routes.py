from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


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
