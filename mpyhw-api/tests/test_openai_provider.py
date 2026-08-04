"""OpenAI provider selection (MPYHW_LLM_PROVIDER=openai): dispatch, fail-fast,
reasoning-model payload shape, usage/billing shape, URL/auth, startup guard.

The DeepSeek path's behavior is pinned by the existing suites (byte-stable
payload, SSE contract, credits); these tests cover only what the openai
provider changes — plus one guard that provider=None stays byte-identical."""

import urllib.request

import pytest
from fastapi import HTTPException

from app import main, routes_llm, web_recommend

pytestmark = pytest.mark.no_db

BODY = {"messages": [{"role": "user", "content": "hi"}], "tools": []}


def test_provider_dispatch(monkeypatch):
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "openai")
    assert routes_llm.get_llm_provider().name == "openai"
    monkeypatch.delenv("MPYHW_LLM_PROVIDER", raising=False)
    assert routes_llm.get_llm_provider().name == "deepseek"
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "bogus")
    with pytest.raises(HTTPException) as excinfo:
        routes_llm.get_llm_provider()
    assert excinfo.value.detail["error"] == "llm_provider_not_supported"


def test_openai_missing_key_fails_fast_never_falls_back(monkeypatch):
    # A configured DeepSeek key must NOT rescue an unconfigured openai selection:
    # selecting openai without OPENAI_API_KEY is a loud 503, never a silent
    # fallback to the other provider.
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "openai")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek-present")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(HTTPException) as excinfo:
        routes_llm.get_llm_provider().ensure_configured()
    assert excinfo.value.status_code == 503
    assert excinfo.value.detail["error"] == "llm_upstream_not_configured"


def test_openai_payload_reasoning_model_params(monkeypatch):
    # gpt-5-class models reject sampling params and renamed the output cap.
    monkeypatch.delenv("MPYHW_LLM_MODEL", raising=False)
    monkeypatch.delenv("MPYHW_LLM_MAX_TOKENS", raising=False)
    provider = routes_llm.OpenAIProvider()

    payload = routes_llm._deepseek_payload(BODY, provider=provider)

    assert payload["model"] == routes_llm.OpenAIProvider.default_model
    assert "temperature" not in payload
    assert "max_tokens" not in payload
    assert payload["max_completion_tokens"] == 8192
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}
    assert [tool["function"]["name"] for tool in payload["tools"]] == sorted(routes_llm.LLM_TOOL_NAMES)

    # Override example is deliberately NOT gpt-5.5-pro: the pro tier rejects
    # streaming, which this path unconditionally enables (stream=True).
    monkeypatch.setenv("MPYHW_LLM_MODEL", "gpt-5.4-mini")
    assert routes_llm._deepseek_payload(BODY, provider=provider)["model"] == "gpt-5.4-mini"


def test_openai_default_model_is_the_full_luna_id():
    # The test above compares the payload against the class attribute, so it passes for ANY
    # default. Pin the literal here: the bare "gpt-5.6" alias routes to Sol, a different and
    # pricier tier, so a short spelling would silently run (and bill) as another model with
    # no error anywhere. Mutation: set default_model to "gpt-5.6" and this fails.
    assert routes_llm.OpenAIProvider.default_model == "gpt-5.6-luna"
    assert routes_llm.OpenAIProvider.default_model != "gpt-5.6", "the bare alias resolves to Sol"
    # The plain path is deliberately NOT changed with it: it is a separate lane whose model
    # is chosen for being cheap and non-thinking, and its budget is sized for that model.
    assert routes_llm.OpenAIProvider.default_plain_model == "gpt-5.4-mini"


def test_deepseek_payload_shape_unchanged_without_provider(monkeypatch):
    # provider=None must keep the exact pre-provider key order (prefix-cache
    # byte-stability contract) and DeepSeek parameter names.
    monkeypatch.delenv("MPYHW_LLM_MODEL", raising=False)
    monkeypatch.delenv("MPYHW_LLM_MAX_TOKENS", raising=False)
    payload = routes_llm._deepseek_payload(BODY)
    assert list(payload.keys()) == ["model", "messages", "temperature", "stream", "stream_options", "max_tokens", "tools", "tool_choice"]
    assert payload["temperature"] == 0.2


def test_openai_payload_strips_reasoning_content(monkeypatch):
    # A stored thinking turn replays as assistant.reasoning_content (DeepSeek's
    # nonstandard field); OpenAI 400s unknown fields, so the openai payload must
    # strip it while the DeepSeek path keeps round-tripping it.
    body = {
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "ok"}]},
            {"role": "user", "content": "next"},
        ],
        "tools": [],
    }
    openai_messages = routes_llm._deepseek_payload(body, provider=routes_llm.OpenAIProvider())["messages"]
    assert all("reasoning_content" not in message for message in openai_messages)
    deepseek_messages = routes_llm._deepseek_payload(body)["messages"]
    assert any("reasoning_content" in message for message in deepseek_messages)


def test_translate_stream_surfaces_openai_refusal():
    # OpenAI streams safety refusals as delta.refusal (no content). It must be
    # surfaced as text — dropping it would bill the turn and hand the client a
    # charged, silently empty "success".
    chunks = [
        b'data: {"choices":[{"delta":{"refusal":"I cannot help with that."},"finish_reason":"stop"}]}\n',
        b"data: [DONE]\n",
    ]
    out = "".join(routes_llm._translate_deepseek_stream(chunks))
    assert "text_delta" in out
    assert "I cannot help with that." in out


def test_billable_tokens_openai_usage_shape(monkeypatch):
    monkeypatch.delenv("MPYHW_CACHE_HIT_WEIGHT", raising=False)
    usage = {
        "total_tokens": 100_000,
        "prompt_tokens": 95_000,
        "completion_tokens": 5_000,
        "prompt_tokens_details": {"cached_tokens": 80_000},
    }
    # miss (95k-80k) + completion 5k + 0.1 * hit 80k
    assert routes_llm._billable_tokens(usage) == 28_000
    # No cache breakdown in either shape -> full-price total (existing fallback).
    assert routes_llm._billable_tokens({"total_tokens": 42, "prompt_tokens": 30, "completion_tokens": 12}) == 42
    # cached_tokens=0 (first round) is a real zero, not "unknown": miss = prompt.
    zero_cache = {"total_tokens": 40, "prompt_tokens": 30, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 0}}
    assert routes_llm._billable_tokens(zero_cache) == 40
    # A malformed breakdown must neither raise inside meter() nor undercharge:
    # non-numeric / negative / cached>prompt shapes all bill the plain total.
    for bad_details in ({"cached_tokens": "x"}, {"cached_tokens": -1}, {"cached_tokens": 99}, "not-a-dict"):
        bad = {"total_tokens": 40, "prompt_tokens": 30, "completion_tokens": 10, "prompt_tokens_details": bad_details}
        assert routes_llm._billable_tokens(bad) == 40


def test_usage_fields_reads_openai_cache_shape():
    fields = routes_llm._usage_fields({"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 7}})
    assert fields == {"input_tokens": 10, "output_tokens": 2, "cache_hit_tokens": 7}


def test_open_stream_openai_url_and_auth(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["auth"] = request.get_header("Authorization")
        return "upstream"

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(routes_llm, "_deepseek_payload", lambda body, provider=None: {"model": "m"})
    provider = routes_llm.OpenAIProvider()

    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert routes_llm._open_deepseek_stream(BODY, "sk-o", provider=provider) == "upstream"
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured["auth"] == "Bearer sk-o"

    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example/v1/")
    routes_llm._open_deepseek_stream(BODY, "sk-o", provider=provider)
    assert captured["url"] == "https://proxy.example/v1/chat/completions"


def test_web_recommend_follows_provider(monkeypatch):
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    seen = {}

    def fake(messages, max_tokens, timeout=120, response_format=None, model=None, provider=None):
        seen["provider"] = provider.name
        seen["model"] = model
        seen["max_tokens"] = max_tokens
        return '{"capabilities": ["servo_control"]}', {}

    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", fake)
    web_recommend.extract_capabilities("a robot arm")
    # The BUDGET has to follow the provider too, not just the model name. gpt-5.4-mini reasons,
    # so inheriting DeepSeek's 256 spends the whole budget on hidden reasoning and returns empty
    # content -> every web_recommend call 503s the moment the provider is switched. Mutation:
    # make plain_max_tokens a plain inherited 256 (or read the env default) and this fails.
    assert seen == {
        "provider": "openai",
        "model": routes_llm.OpenAIProvider.default_plain_model,
        "max_tokens": routes_llm.OpenAIProvider.plain_max_tokens,
    }
    assert seen["max_tokens"] > routes_llm.DeepSeekProvider.plain_max_tokens


def test_plain_budget_needs_no_env_var_to_be_correct(monkeypatch):
    # The whole point of the fix: a correct budget must not depend on a human remembering to
    # set MPYHW_WEB_RECOMMEND_MAX_TOKENS on the deploy host. With NO env var set, each provider
    # still gets its own matching budget. Mutation: move the value back to an env-var default
    # and the openai case collapses to DeepSeek's 256.
    monkeypatch.delenv("MPYHW_WEB_RECOMMEND_MAX_TOKENS", raising=False)
    # BOTH keys: the autouse fixture in conftest clears them, and this test drives each
    # provider in turn — with only one set, the other's turn dies on llm_unconfigured
    # before it ever reaches the budget under test.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-d")
    seen = []

    def fake(messages, max_tokens, timeout=120, response_format=None, model=None, provider=None):
        seen.append(max_tokens)
        return '{"capabilities": ["servo_control"]}', {}

    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", fake)
    for provider_name, expected in (("deepseek", 256), ("openai", 2048)):
        monkeypatch.setenv("MPYHW_LLM_PROVIDER", provider_name)
        web_recommend.extract_capabilities("a robot arm")
        assert seen[-1] == expected, f"{provider_name} budget"

    # The env var still overrides — it is an escape hatch, not the source of correctness.
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_MAX_TOKENS", "77")
    web_recommend.extract_capabilities("a robot arm")
    assert seen[-1] == 77


def test_validate_config_openai_key_requirement(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1/x")
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.setenv("MPYHW_JWT_SECRET", "a-real-secret")
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "admin-x")
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "openai")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="prod secrets"):
        main.validate_config()
    # The openai key alone satisfies prod; DEEPSEEK_API_KEY is no longer required.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    main.validate_config()


def test_validate_config_rejects_unknown_provider_in_prod(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1/x")
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.setenv("MPYHW_JWT_SECRET", "a-real-secret")
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "admin-x")
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "bogus")
    with pytest.raises(RuntimeError, match="not supported"):
        main.validate_config()
