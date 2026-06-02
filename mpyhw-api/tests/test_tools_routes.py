from fastapi.testclient import TestClient
import json
from pathlib import Path

from app.main import app


client = TestClient(app)
ROOT = Path(__file__).resolve().parents[2]


def test_tool_registry_serves_canonical_tools():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    body = response.json()
    names = [tool["name"] for tool in body["tools"]]
    assert len(names) == 14
    assert "query_board_profile" in names
    assert "install_package" in names
    assert body["version"]


def test_tool_registry_is_served_from_canonical_contract():
    contract = json.loads((ROOT / "contracts" / "canonical_tools.json").read_text(encoding="utf-8"))

    response = client.get("/v1/tools")

    assert response.status_code == 200
    assert response.json()["tools"] == contract


def test_install_package_agent_contract_keeps_port_private():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    install_package = next(tool for tool in response.json()["tools"] if tool["name"] == "install_package")
    schema = install_package["input_schema"]
    assert schema["required"] == ["package_json_url"]
    assert "port" not in schema["properties"]
