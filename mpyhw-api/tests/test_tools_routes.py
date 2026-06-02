from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_tool_registry_serves_canonical_tools():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    body = response.json()
    names = {tool["name"] for tool in body["tools"]}
    # The agent loop depends on each of these being served; a contract that drops
    # or renames one breaks the session. Assert presence (subset), not an exact
    # count, so adding a new tool is not a spurious failure.
    required = {
        "query_board_profile", "search_packages", "resolve_package_candidates",
        "get_package_context", "propose_manifest", "generate_code", "audit_code",
        "load_skill", "ask_user", "scan_device", "install_package",
        "flash_and_run", "read_serial_until", "write_main_py", "read_workspace_file",
    }
    assert required <= names, f"missing canonical tools: {required - names}"
    assert body["version"]


def test_install_package_agent_contract_keeps_port_private():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    install_package = next(tool for tool in response.json()["tools"] if tool["name"] == "install_package")
    schema = install_package["input_schema"]
    assert schema["required"] == ["package_json_url"]
    assert "port" not in schema["properties"]
