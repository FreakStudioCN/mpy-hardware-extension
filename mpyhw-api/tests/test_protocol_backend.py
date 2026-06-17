"""Backend serves a phase via the 7-message protocol (analyze-first).

Verifies the core of the rewrite at the prompt/tool/validation layer (no upstream
LLM call, no DB): the system prompt is the adapter preamble + the FULL verbatim
SKILL.md for the phase, the model is offered exactly the 6 protocol tools, the
whitelist rejects dead 27-tool names, and server-side payload validation flags
malformed protocol payloads.
"""

from __future__ import annotations

from app import routes_llm, skill_catalog, tool_registry


def test_system_prompt_is_adapter_plus_full_skill_md():
    sp = routes_llm._system_prompt("analyze")
    # adapter preamble present
    assert "cloud brain" in sp
    assert "protocol tools" in sp
    assert "--- PHASE SKILL (analyze) ---" in sp
    # the FULL raw SKILL.md is embedded verbatim (not a sanitized profile) — it still
    # contains its local-agent phrasing, which the adapter tells the model to translate.
    raw = skill_catalog.skill_md_body("analyze")
    assert raw and raw in sp


def test_phase_defaults_to_analyze_and_selects_skill():
    assert routes_llm._phase({}) == "analyze"
    assert routes_llm._phase({"phase": "select-hw"}) == "select-hw"
    assert "select-hw" in routes_llm._system_prompt("select-hw")


def test_offers_exactly_the_six_protocol_tools_in_stable_order():
    tools = routes_llm._deepseek_tools([{"name": "approval_request"}])
    names = [t["function"]["name"] for t in tools]
    assert names == sorted(tool_registry.LLM_TOOL_NAMES)
    assert set(names) == {
        "approval_request", "device_command", "file_operation",
        "script_run", "status_update", "phase_complete",
    }


def test_whitelist_rejects_dead_27_tool_names():
    assert routes_llm._noncanonical_tools([{"name": "scan_device"}]) == ["scan_device"]
    assert routes_llm._noncanonical_tools([{"name": "get_phase_profile"}]) == ["get_phase_profile"]
    assert routes_llm._noncanonical_tools([{"name": "device_command"}]) == []
    assert routes_llm._noncanonical_tools([]) == []


def test_payload_validation_flags_violations():
    # valid
    assert routes_llm._payload_violation("device_command", '{"action":"scan"}') is None
    # bad enum value
    assert "is not one of" in routes_llm._payload_violation("device_command", '{"action":"bash"}')
    # missing required field (op)
    assert "required" in routes_llm._payload_violation("file_operation", '{"path":"x"}')
    # unparseable json
    assert routes_llm._payload_violation("status_update", "{not json").startswith("invalid_json")


def test_write_requires_content_or_intent():
    import json
    # write without content or intent -> would create an empty file -> rejected
    assert routes_llm._payload_violation("file_operation", json.dumps({"op": "write", "path": "firmware/main.py"}))
    # with intent (server codegen) -> ok
    assert routes_llm._payload_violation("file_operation", json.dumps({"op": "write", "path": "firmware/main.py", "intent": "x"})) is None
    # with content -> ok
    assert routes_llm._payload_violation("file_operation", json.dumps({"op": "write", "path": "x.json", "content": "x"})) is None
    # read needs neither
    assert routes_llm._payload_violation("file_operation", json.dumps({"op": "read", "path": "x"})) is None


def test_codegen_interception_restricted_to_firmware_py():
    import json
    fake = lambda path, intent: "CODE"
    # firmware/*.py with intent -> server fills content
    out = routes_llm._maybe_fill_code("file_operation", json.dumps({"op": "write", "path": "firmware/x.py", "intent": "i"}), fake)
    assert json.loads(out)["content"] == "CODE"
    # docs/*.py is NOT intercepted (no codegen budget outside firmware/)
    payload = json.dumps({"op": "write", "path": "docs/foo.py", "intent": "i"})
    assert routes_llm._maybe_fill_code("file_operation", payload, fake) == payload


def test_robustness_guards():
    # non-list tools -> controlled rejection, not a crash
    assert routes_llm._noncanonical_tools({"name": "x"}) == ["<tools-not-a-list>"]
    # unknown board id reflected only as a bounded id-shaped token
    assert routes_llm._resolve_board({"board_id": "x" * 200}, {})["board_id"] == "unknown"
