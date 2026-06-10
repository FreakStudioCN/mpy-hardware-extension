import json

import pytest
from fastapi.testclient import TestClient

from app import credit_store
from app.auth import get_current_user
from app.main import app


client = TestClient(app)


@pytest.fixture(autouse=True)
def _bypass_auth():
    # These tests exercise the LLM translation/whitelist logic, not auth. Override
    # the auth dependency with a fixed user so the credit pre-flight has a balance.
    app.dependency_overrides[get_current_user] = lambda: {"id": "test-user", "login": "tester", "email": None}
    yield
    app.dependency_overrides.pop(get_current_user, None)


class _PassthroughProvider:
    """A non-deepseek provider whose paid path reaches the credit reserve."""

    name = "fake"

    def ensure_configured(self):
        return None

    def open_stream(self, body):
        return ["raw"]

    def translate_stream(self, upstream, meter=None):
        yield 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fake-provider"}}\n\n'
        if meter is not None:
            yield 'data: {"type":"credits","remaining":49,"daily_grant":50,"resets_at":"2026-06-03T00:00:00+00:00"}\n\n'
        yield 'data: {"type":"message_stop"}\n\n'


def test_llm_messages_503_when_global_daily_budget_exhausted(monkeypatch):
    # Once today's free-tier global spend reaches MPYHW_DAILY_GLOBAL_BUDGET, new paid
    # turns are refused with 503 BEFORE reserving — so abuse can't push the free tier
    # into DeepSeek's hard console cap and DoS everyone. The session slot is released.
    from app import llm_sessions

    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("MPYHW_DAILY_GLOBAL_BUDGET", "5")
    monkeypatch.setattr("app.routes_llm.get_llm_provider", lambda: _PassthroughProvider())

    spender = {"id": "spender", "login": "spender", "email": None}
    credit_store.ensure_daily_grant(spender, 50)
    credit_store.debit(spender, 5)
    assert credit_store.global_spend_today() == 5

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an LED"}], "tools": []},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "daily_free_budget_exhausted"
    assert response.json()["detail"]["resets_at"]
    assert llm_sessions.counts()["global"] == 0


def test_llm_messages_not_gated_when_global_budget_unset(monkeypatch):
    # Default (env unset / <=0) means unlimited: the breaker must not change behavior.
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.delenv("MPYHW_DAILY_GLOBAL_BUDGET", raising=False)
    monkeypatch.setattr("app.routes_llm.get_llm_provider", lambda: _PassthroughProvider())

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an LED"}], "tools": []},
    )

    assert response.status_code == 200
    assert "fake-provider" in response.text


def test_stub_path_not_gated_by_global_budget(monkeypatch):
    # Stub mode makes no paid upstream call (0 cost), so the breaker must not block it
    # even with the budget exhausted — CI and local dev depend on the stub path.
    monkeypatch.setenv("MPYHW_LLM_STUB", "1")
    monkeypatch.setenv("MPYHW_DAILY_GLOBAL_BUDGET", "1")

    spender = {"id": "spender2", "login": "spender2", "email": None}
    credit_store.ensure_daily_grant(spender, 50)
    credit_store.debit(spender, 5)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an LED"}], "tools": []},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")


def test_deepseek_payload_caps_output_tokens(monkeypatch):
    # An unbounded turn could spend arbitrarily many tokens (and the metering floor
    # absorbs the overage). The payload must carry a max_tokens ceiling.
    from app import routes_llm

    monkeypatch.delenv("MPYHW_LLM_MAX_TOKENS", raising=False)
    payload = routes_llm._deepseek_payload({"messages": [{"role": "user", "content": "hi"}], "tools": []})
    assert payload["max_tokens"] == 8192

    monkeypatch.setenv("MPYHW_LLM_MAX_TOKENS", "2048")
    payload = routes_llm._deepseek_payload({"messages": [{"role": "user", "content": "hi"}], "tools": []})
    assert payload["max_tokens"] == 2048


def test_deepseek_payload_honors_client_max_tokens_within_ceiling(monkeypatch):
    # An output-heavy call (codegen must emit a whole file AFTER reasoning_content has
    # already consumed part of the budget) may request more than the default turn cap,
    # but the anti-abuse ceiling still bounds it. Below the ceiling is honored verbatim;
    # above is clamped; absent/non-positive falls back to the default.
    from app import routes_llm

    monkeypatch.delenv("MPYHW_LLM_MAX_TOKENS", raising=False)
    monkeypatch.delenv("MPYHW_LLM_MAX_TOKENS_CEILING", raising=False)
    base = {"messages": [{"role": "user", "content": "hi"}], "tools": []}

    assert routes_llm._deepseek_payload({**base, "max_tokens": 8192})["max_tokens"] == 8192
    assert routes_llm._deepseek_payload({**base, "max_tokens": 99999})["max_tokens"] == 32768
    assert routes_llm._deepseek_payload(base)["max_tokens"] == 8192
    assert routes_llm._deepseek_payload({**base, "max_tokens": 0})["max_tokens"] == 8192


def test_deepseek_payload_is_byte_stable_for_prefix_caching():
    # DeepSeek's automatic prefix caching only hits when the leading bytes of the
    # request are identical across rounds. Lock the determinism so re-sent context
    # lands in the cache instead of being re-billed at full price: the same body
    # must serialize identically, the constant system prompt must lead, and tools
    # must keep the client's order (not be reordered by set iteration).
    from app import routes_llm

    body = {
        "messages": [
            {"role": "user", "content": "blink an ESP32 LED"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "query_board_profile", "input": {"board_id": "esp32-s3-devkitc-1"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "{\"ok\": true}"}]},
        ],
        "tools": [{"name": "query_board_profile"}, {"name": "search_packages"}, {"name": "get_phase_profile"}],
    }

    first = routes_llm._deepseek_payload(body)
    second = routes_llm._deepseek_payload(body)

    assert json.dumps(first["messages"]) == json.dumps(second["messages"])
    assert json.dumps(first.get("tools")) == json.dumps(second.get("tools"))
    assert first["messages"][0]["role"] == "system"
    assert first["messages"][0]["content"].startswith(routes_llm.SYSTEM_PROMPT)
    assert [tool["function"]["name"] for tool in first["tools"]] == ["query_board_profile", "search_packages", "get_phase_profile"]


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


def test_llm_messages_uses_selected_provider(monkeypatch):
    class FakeProvider:
        name = "fake"

        def ensure_configured(self):
            return None

        def open_stream(self, body):
            assert body["messages"][0]["content"] == "blink an ESP32 LED"
            return ["raw"]

        def translate_stream(self, upstream, meter=None):
            assert upstream == ["raw"]
            yield 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fake-provider"}}\n\n'
            if meter is not None:
                yield 'data: {"type":"credits","remaining":50,"daily_grant":50,"resets_at":"2026-06-03T00:00:00+00:00"}\n\n'
            yield 'data: {"type":"message_stop"}\n\n'

    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setattr("app.routes_llm.get_llm_provider", lambda: FakeProvider())

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": []},
    )

    assert response.status_code == 200
    assert "fake-provider" in response.text


def _sse_bytes(*chunks: dict) -> list[bytes]:
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    return lines


def _sse_events(text: str) -> list[dict]:
    """Parse a text/event-stream body into its ordered list of JSON event objects.

    Lets tests assert frame ordering and reassembled payloads instead of substring
    matches, which pass even on malformed or out-of-order frames.
    """
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            continue
        events.append(json.loads(payload))
    return events


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

    events = _sse_events(response.text)
    assert events[-1]["type"] == "message_stop", "stream terminates cleanly"
    assert all(e["type"] != "error" for e in events), "no error frame on a clean stream"
    text = "".join(
        e["delta"]["text"]
        for e in events
        if e["type"] == "content_block_delta" and e["delta"].get("type") == "text_delta"
    )
    assert text == "Use query_board_profile first.", "text deltas reassemble in order"


def test_llm_stream_surfaces_finish_reason_on_message_stop(monkeypatch):
    # finish_reason "length" means the turn was truncated at max_tokens — for a
    # reasoning model the budget can be spent on reasoning_content leaving no answer,
    # which surfaces downstream as an empty codegen. Expose it on message_stop so that
    # case is diagnosable from the session log instead of an opaque empty result.
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"content": "partial"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink an ESP32 LED"}], "tools": [{"name": "query_board_profile"}]},
    )

    assert response.status_code == 200
    assert '"finish_reason"' in response.text
    assert '"length"' in response.text
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

    events = _sse_events(response.text)
    starts = [e for e in events if e["type"] == "content_block_start"]
    assert len(starts) == 1, "the two fragments collapse into a single tool_use block"
    assert starts[0]["content_block"]["type"] == "tool_use"
    assert starts[0]["content_block"]["name"] == "query_board_profile"
    # The arguments arrive split across two upstream chunks; they must reassemble into
    # one input_json_delta that parses as valid JSON (a single-tool client can't repair
    # interleaved/partial fragments).
    partial = "".join(
        e["delta"]["partial_json"]
        for e in events
        if e["type"] == "content_block_delta" and e["delta"].get("type") == "input_json_delta"
    )
    assert json.loads(partial) == {"board_id": "esp32-s3-devkitc-1"}
    assert [e["type"] for e in events if e["type"] == "content_block_stop"], "block is closed"


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
    # Contract (routes_llm._translate_deepseek_stream docstring): an interrupted stream
    # KEEPS the one-credit reservation as the minimum paid-call cost — it does NOT refund
    # mid-stream (unlike a pre-stream UpstreamError, which does refund). Lock it so a
    # refactor can't silently flip to refunding or double-charging on an upstream drop.
    assert client.get("/v1/credits").json()["balance"] == credit_store.DAILY_GRANT - 1


def test_successful_turn_is_persisted_to_llm_turns(monkeypatch):
    # A metered turn must leave an auditable row in llm_turns with the charge and
    # outcome — the analytics write path (routes_llm -> record_llm_turn) was otherwise
    # only ever exercised, never read back.
    from app import db

    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "app.routes_llm._open_deepseek_stream",
        lambda _body, _key: _sse_bytes(
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [], "usage": {"total_tokens": 25_000}},
        ),
    )

    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink"}], "tools": [], "trace_id": "t-persist"},
    )
    assert response.status_code == 200
    _ = response.text  # drain the stream so the meter + record_llm_turn run

    with db.connect() as conn:
        rows = db.fetchall(
            conn,
            "SELECT status, credits_charged, total_tokens FROM llm_turns WHERE trace_id=?",
            ("t-persist",),
        )
    assert len(rows) == 1
    assert rows[0]["status"] == "success"
    assert rows[0]["credits_charged"] == 2  # 25k tokens -> 2 credits
    assert rows[0]["total_tokens"] == 25_000


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


def test_translate_stream_surfaces_reasoning_as_thinking_delta():
    from app import routes_llm

    # Thinking-mode models (deepseek-v4-pro) stream reasoning_content. It must be
    # surfaced (as thinking_delta) so the client can store it and pass it back — not
    # dropped, which makes DeepSeek 400 the next tool-calling round.
    chunks = _sse_bytes(
        {"choices": [{"delta": {"reasoning_content": "Check the board pins first."}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c1", "function": {"name": "query_board_profile", "arguments": "{}"}},
        ]}}]},
    )
    out = "".join(routes_llm._translate_deepseek_stream(chunks))

    assert "thinking_delta" in out
    assert "Check the board pins first." in out


def test_deepseek_messages_round_trips_reasoning_content():
    from app import routes_llm

    # A thinking block on the assistant turn must translate back to reasoning_content
    # on the DeepSeek assistant message (verified live: without it DeepSeek 400s a
    # replayed thinking-mode tool turn; with it the call is accepted).
    body = {
        "messages": [
            {"role": "user", "content": "blink an ESP32 LED"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Check the board first."},
                {"type": "tool_use", "id": "call_1", "name": "query_board_profile", "input": {"board_id": "esp32-s3-devkitc-1"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "{\"ok\": true}"},
            ]},
        ]
    }
    assistant = routes_llm._deepseek_messages(body)[2]

    assert assistant["role"] == "assistant"
    assert assistant["reasoning_content"] == "Check the board first."
    assert assistant["tool_calls"][0]["function"]["name"] == "query_board_profile"


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


def test_system_prompt_is_delivered_to_the_provider_as_the_system_message():
    from app import routes_llm

    # The prompt only does its job if it actually reaches the model. Verify the
    # translation layer prepends it as the system turn (not merely that the
    # constant exists). This is robust to prompt wording changes — unlike pinning
    # individual phrases — while still catching a regression that drops the prompt.
    messages = routes_llm._deepseek_messages({"messages": [{"role": "user", "content": "blink an LED"}]})
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].startswith(routes_llm.SYSTEM_PROMPT)


def test_system_prompt_pins_user_language_against_skill_drift():
    from app import routes_llm

    # Regression: the served upstream skills are authored in Chinese (and prescribe
    # verbatim Chinese ask_user options), which flipped an English session to Chinese
    # the moment load_skill returned. The system turn must pin the user's language and
    # forbid copying a skill's text verbatim, so chrome (English) and prose stay aligned.
    en = routes_llm._deepseek_messages({"messages": [{"role": "user", "content": "i want an ai girlfriend"}]})[0]["content"]
    zh = routes_llm._deepseek_messages({"messages": [{"role": "user", "content": "我想做一个温湿度计"}]})[0]["content"]

    assert "The user is writing in English" in en
    assert "The user is writing in Chinese" in zh
    assert "verbatim" in en
    # A trailing tool_result (role:"user", block list) must not be mistaken for intent.
    mixed = routes_llm._deepseek_messages({"messages": [
        {"role": "user", "content": "build a thermometer"},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "你好"}]},
    ]})[0]["content"]
    assert "The user is writing in English" in mixed


def test_system_prompt_omits_removed_not_hardware_refusal():
    from app import routes_llm

    # The <not_hardware> refusal was deliberately removed (ambiguous intents are
    # clarified via ask_user, not refused). Guard against it being reintroduced.
    assert "<not_hardware>" not in routes_llm.SYSTEM_PROMPT


def test_system_prompt_owns_the_static_behaviour_rules():
    from app import routes_llm

    # These rules used to be duplicated in the client's buildOpening and drifted.
    # They now live ONLY here (the system prompt is the single home, re-sent every
    # round), so pin that the consolidation didn't drop them — that drift is exactly
    # what the refactor closed.
    prompt = routes_llm.SYSTEM_PROMPT
    assert "support_level" in prompt  # package support-level guidance (was client-only)
    assert "single main.py" in prompt  # multi-file code-structure guidance (was client-only)
    assert "one continuous run" in prompt  # don't-stall-between-phases rule (was client-only)


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


def test_propose_manifest_schema_documents_the_rich_upstream_manifest():
    from app import routes_llm

    # The model only proposes a well-formed manifest if the tool schema actually
    # describes its shape. The contract is now the upstream phased project-manifest
    # (analyze->select-hw->...), so the nested schema must list its required fields
    # and describe devices[] (wiring is DERIVED from devices+pinout, never emitted).
    tools = routes_llm._deepseek_tools([{"name": "propose_manifest"}])
    manifest = tools[0]["function"]["parameters"]["properties"]["manifest"]

    assert set(manifest["required"]) >= {
        "schema_version", "phase", "created_at", "project_name", "requirements", "devices",
    }
    assert manifest["properties"]["devices"]["type"] == "array"
    assert "phase" in manifest["properties"]
    assert "analyze" in manifest["properties"]["phase"]["enum"]


def test_generate_code_schema_requires_the_rich_upstream_manifest():
    from app import routes_llm

    tools = routes_llm._deepseek_tools([{"name": "generate_code"}])
    tool = tools[0]["function"]
    manifest = tool["parameters"]["properties"]["manifest"]

    assert "rich upstream project-manifest" in tool["description"]
    assert set(manifest["required"]) >= {
        "schema_version", "phase", "created_at", "project_name", "requirements", "devices",
    }
    assert manifest["properties"]["schema_version"]["enum"] == ["1.0"]
    assert "legacy thin manifests" in tool["description"]


def test_propose_manifest_schema_is_byte_stable():
    from app import routes_llm

    # The tools array is part of DeepSeek's cached request prefix; the manifest
    # schema is static JSON, so the converted tool must serialize identically across
    # calls (no nondeterministic enrichment crept onto this path).
    first = routes_llm._deepseek_tools([{"name": "propose_manifest"}])
    second = routes_llm._deepseek_tools([{"name": "propose_manifest"}])
    assert json.dumps(first) == json.dumps(second)


def test_llm_phase_profile_schema_comes_from_skill_catalog():
    from app import routes_llm, skill_catalog

    tools = routes_llm._deepseek_tools([{"name": "get_phase_profile"}])
    parameters = tools[0]["function"]["parameters"]

    assert parameters["required"] == ["phase"]
    assert parameters["properties"]["phase"]["enum"] == skill_catalog.served_phase_names()
    assert "diagram" in parameters["properties"]["phase"]["enum"]
    assert "upy-diagram" not in parameters["properties"]["phase"]["enum"]


def test_cloud_prompt_and_tools_do_not_expose_raw_skill_or_local_execution_details():
    from app import routes_llm

    payload = routes_llm._deepseek_payload({
        "messages": [{"role": "user", "content": "blink an LED"}],
        "tools": [{"name": "get_phase_profile"}, {"name": "run_flash_device"}, {"name": "run_extract_pdf"}],
    })
    serialized = json.dumps(payload, ensure_ascii=False)

    forbidden = [
        "AVAILABLE SKILLS",
        "SKILL.md",
        "load_skill",
        "mpremote",
        "python ",
        "/scripts",
        "C:/Users/",
        "G:/MicroPython_Skills",
        "third_party/MicroPython_Skills",
    ]
    for needle in forbidden:
        assert needle not in serialized
