import json

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_llm_messages_rejects_noncanonical_tool():
    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink ESP32 LED"}], "tools": [{"name": "web_search"}]},
    )

    assert response.status_code == 403
    body = response.json()["detail"]
    assert body["error"] == "tool_not_whitelisted"
    assert body["rejected"] == ["web_search"]


def test_llm_messages_requires_upstream_when_not_stubbed():
    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "llm_upstream_not_configured"


def test_llm_messages_stub_stream_for_local_non_hardware_tests(monkeypatch):
    monkeypatch.setenv("MPYHW_LLM_STUB", "1")

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "content_block_delta" in response.text
    assert "<not_hardware>" not in response.text


def _sse_bytes(*chunks: dict) -> list[bytes]:
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    return lines


def test_llm_messages_streams_deepseek_text(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    captured = {}

    def fake_open(body, api_key):
        captured["api_key"] = api_key
        captured["first_message"] = body["messages"][0]["content"]
        return _sse_bytes(
            {"choices": [{"delta": {"content": "Use query_board_profile "}}]},
            {"choices": [{"delta": {"content": "first."}}]},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert captured["api_key"] == "test-key"
    assert captured["first_message"] == "blink an ESP32 LED"
    assert "Use query_board_profile " in response.text
    assert "first." in response.text
    assert "message_stop" in response.text


def test_llm_messages_translates_deepseek_tool_calls(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "function": {"name": "query_board_profile", "arguments": "{\"board_id\":"}},
            ]}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "\"esp32-s3-devkitc-1\"}"}},
            ]}}]},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert "content_block_start" in response.text
    assert "query_board_profile" in response.text
    assert "esp32-s3-devkitc-1" in response.text
    assert "content_block_stop" in response.text


def test_llm_stream_emits_error_event_on_midstream_failure(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def raising_stream(_body, _api_key):
        def gen():
            yield b'data: {"choices": [{"delta": {"content": "partial"}}]}'
            raise ConnectionError("dropped")

        return gen()

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", raising_stream)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": []},
    )

    assert response.status_code == 200
    assert "partial" in response.text
    assert "upstream_stream_interrupted" in response.text
    assert "message_stop" not in response.text


def test_llm_stream_buffers_interleaved_tool_calls(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "a", "function": {"name": "scan_device"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "b", "function": {"name": "query_board_profile"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": "{\"board_id\":\"esp32-s3-devkitc-1\"}"}}]}}]},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "scan and profile"}], "tools": [{"name": "scan_device"}, {"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert "scan_device" in response.text
    assert "query_board_profile" in response.text
    assert "esp32-s3-devkitc-1" in response.text


def test_llm_stream_handles_tool_name_in_later_fragment(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"arguments": ""}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "query_board_profile", "arguments": "{\"board_id\":\"x\"}"}}]}}]},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "profile"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert "content_block_start" in response.text
    assert "query_board_profile" in response.text


def test_deepseek_messages_demotes_orphan_tool_result():
    from app import routes_llm

    body = {
        "messages": [
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "missing", "content": "{\"ok\": true}"},
            ]},
        ]
    }
    messages = routes_llm._deepseek_messages(body)

    assert all(message["role"] != "tool" for message in messages)
    assert messages[-1] == {"role": "user", "content": "{\"ok\": true}"}


def test_llm_messages_maps_deepseek_errors(monkeypatch):
    from app.routes_llm import UpstreamError

    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "app.routes_llm._open_deepseek_stream",
        lambda _body, _api_key: (_ for _ in ()).throw(UpstreamError(401)),
    )

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == {"error": "llm_upstream_error", "status": 401}


def test_deepseek_messages_translate_tool_turns():
    from app import routes_llm

    body = {
        "messages": [
            {"role": "user", "content": "blink an ESP32 LED"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "Checking the board."},
                {"type": "tool_use", "id": "call_1", "name": "query_board_profile", "input": {"board_id": "esp32-s3-devkitc-1"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "{\"ok\": true}"},
            ]},
        ]
    }
    messages = routes_llm._deepseek_messages(body)

    assert messages[0]["role"] == "system"
    assert messages[1] == {"role": "user", "content": "blink an ESP32 LED"}

    assistant = messages[2]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == "Checking the board."
    call = assistant["tool_calls"][0]
    assert call["id"] == "call_1"
    assert call["function"]["name"] == "query_board_profile"
    assert json.loads(call["function"]["arguments"]) == {"board_id": "esp32-s3-devkitc-1"}

    assert messages[3] == {"role": "tool", "tool_call_id": "call_1", "content": "{\"ok\": true}"}


def test_llm_tool_capabilities_come_from_package_store(monkeypatch):
    from app import routes_llm

    class FakeStore:
        records = [
            {"capabilities": ["temperature_sensing"]},
            {"capabilities": ["analog_input"]},
        ]

    monkeypatch.setattr(routes_llm.PackageStore, "default", classmethod(lambda _cls: FakeStore()))

    tools = routes_llm._deepseek_tools([{"name": "resolve_package_candidates"}])
    capability_enum = tools[0]["function"]["parameters"]["properties"]["capabilities"]["items"]["enum"]

    assert capability_enum == ["analog_input", "temperature_sensing"]
    assert "temperature_sensing, humidity_sensing, digital_output, display_text" not in routes_llm.SYSTEM_PROMPT


def test_llm_local_tools_expose_parameter_schemas():
    from app import routes_llm

    expected = {
        "propose_manifest": ["manifest"],
        "generate_code": ["manifest", "target_path"],
        "audit_code": ["path", "content"],
        "ask_user": ["question"],
    }
    tools = routes_llm._deepseek_tools([{"name": name} for name in expected])
    by_name = {tool["function"]["name"]: tool["function"]["parameters"] for tool in tools}

    for name, required in expected.items():
        parameters = by_name[name]
        assert parameters["required"] == required
        assert parameters["properties"], f"{name} must expose properties, not an empty fallback schema"
        assert parameters["additionalProperties"] is False


def test_llm_load_skill_schema_comes_from_skill_catalog(monkeypatch, tmp_path):
    from app import routes_llm

    skill_dir = tmp_path / "content" / "skills" / "existing"
    skill_dir.mkdir(parents=True)
    (skill_dir / "upy-analyze.md").write_text("# upy-analyze", encoding="utf-8")
    (skill_dir / "upy-generate.md").write_text("# upy-generate", encoding="utf-8")
    monkeypatch.setattr(routes_llm, "ROOT", tmp_path)

    tools = routes_llm._deepseek_tools([{"name": "load_skill"}])
    parameters = tools[0]["function"]["parameters"]

    assert parameters["required"] == ["skill"]
    assert parameters["properties"]["skill"]["enum"] == ["upy-analyze", "upy-generate"]
