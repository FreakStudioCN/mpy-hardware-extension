import pytest

from app import routes_llm


@pytest.mark.no_db
def test_browser_capabilities_note_disables_script_run():
    note = routes_llm._host_capabilities_note({
        "browser": True,
        "webserial": True,
        "script_run": False,
        "local_filesystem": False,
        "firmware_flash": False,
    })

    assert "BROWSER HOST MODE" in note
    assert "cannot run arbitrary local scripts" in note
    assert "Do not call script_run" in note
    assert "avoid repeated unsupported script_run loops" in note
    assert "browser project file_operation" in note
    assert "WebSerial/raw REPL" in note
    assert "already has MicroPython" in note


@pytest.mark.no_db
def test_browser_capabilities_note_is_injected_into_system_prompt():
    system = routes_llm._deepseek_messages({
        "phase": "upy-generate-plugin",
        "messages": [{"role": "user", "content": "generate firmware"}],
        "context": {
            "host_capabilities": {
                "browser": True,
                "webserial": True,
                "script_run": False,
                "local_filesystem": False,
                "firmware_flash": False,
            }
        },
    })[0]["content"]

    assert "BROWSER HOST MODE" in system
    assert "browser project file_operation" in system
    assert "Do not call script_run" in system


@pytest.mark.no_db
def test_script_run_false_without_browser_flag_still_injects_host_note():
    system = routes_llm._deepseek_messages({
        "messages": [{"role": "user", "content": "generate firmware"}],
        "context": {"host_capabilities": {"script_run": False}},
    })[0]["content"]

    assert "BROWSER HOST MODE" in system
    assert "Do not call script_run" in system


@pytest.mark.no_db
def test_extension_capabilities_do_not_get_browser_note():
    system = routes_llm._deepseek_messages({
        "messages": [{"role": "user", "content": "generate firmware"}],
        "context": {"host_capabilities": {"browser": False, "script_run": True}},
    })[0]["content"]

    assert "BROWSER HOST MODE" not in system
    assert "Do not call script_run" not in system
