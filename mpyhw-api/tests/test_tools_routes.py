from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_tool_registry_serves_canonical_tools():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    body = response.json()
    names = [tool["name"] for tool in body["tools"]]
    assert len(names) == 14
    assert "query_board_profile" in names
    assert "install_package" in names
    assert body["version"]
