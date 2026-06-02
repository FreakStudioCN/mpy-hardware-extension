from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


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
