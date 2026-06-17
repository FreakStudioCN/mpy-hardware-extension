from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_tool_registry_serves_the_six_protocol_tools():
    response = client.get("/v1/tools")

    assert response.status_code == 200
    body = response.json()
    names = {tool["name"] for tool in body["tools"]}
    # The protocol replaces the 27 tools with 6 generic messages the model emits.
    assert names == {
        "approval_request", "device_command", "file_operation",
        "script_run", "status_update", "phase_complete",
    }
    # No dead 27-tool names linger in the served list.
    assert "get_phase_profile" not in names
    assert "scan_device" not in names
    assert body["version"]
    assert body["protocol_version"]


def test_protocol_tool_action_enums_are_served():
    response = client.get("/v1/tools")
    tools = {tool["name"]: tool for tool in response.json()["tools"]}

    device = tools["device_command"]["input_schema"]
    assert set(device["properties"]["action"]["enum"]) == {
        "devs", "scan", "exec", "cp", "cp_from", "mkdir", "ls", "rm", "soft_reset", "stream", "run",
    }
    file_op = tools["file_operation"]["input_schema"]
    assert set(file_op["properties"]["op"]["enum"]) == {"write", "read", "list", "delete", "mkdir", "append"}
    assert tools["phase_complete"]["kind"] == "notify"
    assert tools["device_command"]["kind"] == "blocking"
