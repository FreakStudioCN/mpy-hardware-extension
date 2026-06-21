import types

import pytest
from fastapi import HTTPException

from app import routes_llm, web_recommend


pytestmark = pytest.mark.no_db


@pytest.fixture(autouse=True)
def _reset_limiter():
    web_recommend.reset()
    yield
    web_recommend.reset()


def _request(ip="1.2.3.4"):
    return types.SimpleNamespace(client=types.SimpleNamespace(host=ip))


# --- extract_capabilities -------------------------------------------------


def test_fallback_extraction_reads_idea_phrasing_when_no_llm():
    # No DEEPSEEK_API_KEY (conftest deletes it) -> deterministic fallback path.
    result = web_recommend.extract_capabilities("a desk light that turns on when I sit down")

    assert result["source"] == "fallback"
    assert "digital_output" in result["capabilities"]
    assert "motion_sensing" in result["capabilities"]


def test_fallback_uses_word_boundaries_so_oled_is_not_an_led():
    # "OLED" contains the substring "led"; word-boundary matching must not infer a
    # digital_output LED the user never asked for.
    result = web_recommend.extract_capabilities("an OLED status display")

    assert result["source"] == "fallback"
    assert "display_text" in result["capabilities"]
    assert "digital_output" not in result["capabilities"]


def test_llm_extraction_drives_capabilities_and_drops_off_taxonomy_tokens(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")

    def fake(messages, max_tokens, timeout=120):
        return '{"capabilities": ["motion_sensing", "digital_output", "not_a_real_cap"], "board_family_hint": "esp32"}', {}

    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", fake)

    result = web_recommend.extract_capabilities("something motion driven")

    assert result["source"] == "llm"
    assert result["capabilities"] == ["motion_sensing", "digital_output"]
    assert result["board_family_hint"] == "esp32"


def test_llm_failure_degrades_to_fallback(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")

    def boom(messages, max_tokens, timeout=120):
        raise routes_llm.UpstreamError(500)

    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", boom)

    result = web_recommend.extract_capabilities("measure the temperature")

    assert result["source"] == "fallback"
    assert "temperature_sensing" in result["capabilities"]


def test_daily_cap_skips_llm_and_uses_fallback(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_DAILY_LLM_CAP", "0")
    called = {"n": 0}

    def fake(messages, max_tokens, timeout=120):
        called["n"] += 1
        return '{"capabilities": ["motion_sensing"]}', {}

    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", fake)

    result = web_recommend.extract_capabilities("a desk light")

    assert called["n"] == 0
    assert result["source"] == "fallback"


# --- assemble_parts -------------------------------------------------------


def test_assemble_returns_real_catalog_modules_with_buy_links():
    parts = web_recommend.assemble_parts(
        "temperature alarm with an oled display",
        ["temperature_sensing", "humidity_sensing", "display_text"],
    )

    assert parts
    # Deduped by canonical chip id: a package matching two caps appears once.
    keys = [part["package_name"] for part in parts]
    assert len(keys) == len(set(web_recommend_canonical(k) for k in keys))
    covered = {cap for part in parts for cap in part["capabilities"]}
    assert "display_text" in covered
    assert "temperature_sensing" in covered
    for part in parts:
        assert part["name"]
        assert part["reason"]
        assert part["buy_url"].startswith("https://")


def test_assemble_caps_part_count():
    parts = web_recommend.assemble_parts(
        "temperature humidity light display motion distance",
        ["temperature_sensing", "humidity_sensing", "digital_output", "display_text", "motion_sensing", "distance_sensing"],
        max_parts=2,
    )

    assert len(parts) <= 2


def test_assemble_with_no_capabilities_returns_breadboard_fallback():
    parts = web_recommend.assemble_parts("something completely unmatched zzz", [])

    assert len(parts) == 1
    assert parts[0]["name"] == "Breadboard jumper wire kit"
    assert parts[0]["buy_url"].startswith("https://")


# --- rate limiting --------------------------------------------------------


def test_rate_limit_blocks_after_threshold(monkeypatch):
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_RATE", "2")

    web_recommend.enforce_rate_limit(_request())
    web_recommend.enforce_rate_limit(_request())
    with pytest.raises(HTTPException) as excinfo:
        web_recommend.enforce_rate_limit(_request())

    assert excinfo.value.status_code == 429


def test_rate_limit_is_per_ip(monkeypatch):
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_RATE", "1")

    web_recommend.enforce_rate_limit(_request("10.0.0.1"))
    # A different IP is unaffected by the first IP's budget.
    web_recommend.enforce_rate_limit(_request("10.0.0.2"))


# A tiny local mirror of canonical_chip_id so the test asserts dedupe intent
# without importing internals into the assertion line above.
def web_recommend_canonical(name):
    from app.package_store import canonical_chip_id

    return canonical_chip_id(name)
