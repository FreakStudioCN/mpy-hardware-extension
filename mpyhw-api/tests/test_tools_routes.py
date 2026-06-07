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
        "get_phase_profile", "ask_user", "scan_device", "install_package",
        "flash_and_run", "read_serial_until", "write_main_py", "read_workspace_file",
        "run_triage", "run_hardware_sanity", "run_extract_pdf", "run_flash_device",
    }
    assert required <= names, f"missing canonical tools: {required - names}"
    assert "load_skill" not in names
    assert body["version"]


def test_install_package_agent_contract_keeps_port_private():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    install_package = next(tool for tool in response.json()["tools"] if tool["name"] == "install_package")
    schema = install_package["input_schema"]
    assert schema["required"] == ["package_json_url"]
    assert "port" not in schema["properties"]


def test_canonical_local_tool_paths_are_workspace_relative_only():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    tools = {tool["name"]: tool for tool in response.json()["tools"]}
    for name in ["run_validate", "run_triage", "run_extract_pdf", "run_flash_device"]:
        schema = tools[name]["input_schema"]
        path_props = {
            key: value for key, value in schema.get("properties", {}).items()
            if key.endswith("path") or key == "path"
        }
        assert path_props, f"{name} must expose path fields explicitly"
        for prop in path_props.values():
            assert prop.get("pattern") == r"^(?![A-Za-z]:)(?!/)(?!.*(?:^|/)\.\.(?:/|$)).+"
