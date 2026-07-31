"""LLM provider registry: DeepSeek (default) and OpenAI, selected by MPYHW_LLM_PROVIDER.

Both upstreams speak the OpenAI chat-completions protocol, so OpenAIProvider
subclasses DeepSeekProvider purely to reuse the shared request/stream code in
sse_translate; the class attributes below are the entire per-provider surface.
Moved out of sse_translate.py (which re-exports these names, as does routes_llm)
to keep that module within the line budget."""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger("mpyhw.llm")


def _R():
    """routes_llm is the monkeypatch namespace of record (tests patch
    routes_llm.<name>); resolve patched siblings through it at call time."""
    from app import routes_llm
    return routes_llm


class DeepSeekProvider:
    name = "deepseek"
    api_key_env = "DEEPSEEK_API_KEY"
    base_url_env = "DEEPSEEK_BASE_URL"
    default_base_url = "https://api.deepseek.com"
    default_model = "deepseek-v4-pro"
    # Non-thinking model for the tool-free web_recommend path (see _llm_extract).
    default_plain_model = "deepseek-chat"
    # Output budget for that path, a property of default_plain_model above and NOT of the
    # deployment: whether a budget suffices is decided by whether that model reasons, so it
    # belongs beside the model it sizes. deepseek-chat does not reason, so the small budget
    # is enough; a reasoning plain model needs headroom or it spends the whole budget on
    # hidden reasoning and returns finish_reason="length" with empty content (503).
    plain_max_tokens = 256
    # gpt-5-class reasoning models reject sampling params, renamed the output cap
    # to max_completion_tokens, and 400 on DeepSeek's nonstandard reasoning_content
    # field — these switches let the shared payload builder emit what each
    # upstream actually accepts.
    # NOTE: on DeepSeekProvider itself the URL/payload attrs above and below are
    # documentation only — open_stream deliberately passes provider=None so the
    # DeepSeek request keeps the hardcoded constants byte-identical (prefix-cache
    # contract). Changing them here changes nothing; OpenAIProvider passes
    # provider=self and does read them.
    send_temperature = True
    max_tokens_param = "max_tokens"
    accepts_reasoning_content = True
    # Route-level circuit-breaker participation (fake test providers lack the
    # attribute and bypass the breaker, as before).
    uses_breaker = True

    def ensure_configured(self) -> None:
        if not os.getenv(self.api_key_env):
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_not_configured"})

    def model(self) -> str:
        return os.getenv("MPYHW_LLM_MODEL", self.default_model)

    def open_stream(self, body: dict[str, Any]):
        return _R()._open_deepseek_stream(body, os.environ[self.api_key_env])

    def translate_stream(self, upstream: Iterable[bytes], meter=None):
        return _R()._translate_deepseek_stream(upstream, meter)


class OpenAIProvider(DeepSeekProvider):
    name = "openai"
    api_key_env = "OPENAI_API_KEY"
    base_url_env = "OPENAI_BASE_URL"
    default_base_url = "https://api.openai.com/v1"
    default_model = "gpt-5.5"
    default_plain_model = "gpt-5.4-mini"
    # gpt-5.4-mini DOES reason, so it needs far more than the DeepSeek budget for the same
    # tiny JSON answer. Inherit 256 here and every web_recommend call 503s the moment the
    # provider is switched — the failure the env var could only prevent by a human
    # remembering to set it on the host.
    plain_max_tokens = 2048
    send_temperature = False
    max_tokens_param = "max_completion_tokens"
    accepts_reasoning_content = False

    def open_stream(self, body: dict[str, Any]):
        return _R()._open_deepseek_stream(body, os.environ[self.api_key_env], provider=self)


def get_llm_provider():
    provider = os.getenv("MPYHW_LLM_PROVIDER", "deepseek").lower()
    if provider == "deepseek":
        return DeepSeekProvider()
    if provider == "openai":
        return OpenAIProvider()
    raise HTTPException(status_code=503, detail={"error": "llm_provider_not_supported", "provider": provider})


def llm_provider_configured() -> bool:
    """Whether the selected provider's API key is present. For health/startup
    probes only — never a fallback: a missing key still fails the request loudly."""
    try:
        provider = _R().get_llm_provider()
    except HTTPException:
        return False
    return bool(os.getenv(provider.api_key_env))


def _log_upstream_rejection(error) -> None:
    """Bounded upstream error-body log — the only diagnostic for a rejected payload
    (e.g. an unsupported-parameter 400). Lives here, not in sse_translate, purely
    for that module's line budget."""
    try:
        detail = error.read(2048).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - diagnostics only; callers still raise UpstreamError
        detail = "<unreadable>"
    logger.warning("llm upstream rejected request", extra={"status": error.code, "body": detail})
