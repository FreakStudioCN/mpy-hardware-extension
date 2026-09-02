"""A provider mid-rollout rejects on some nodes and accepts on others.

Measured 2026-09-02 against api.moonshot.cn: 1538 consecutive successes, then intermittent
400s carrying "missing required header Kimi-Api-Version" at roughly one call in six. A
~100-call build run cannot survive that, and the header is documented nowhere, so the open
retry has to treat this one 400 shape as transient without treating 400 generally as transient.
"""
import io
import urllib.error
import urllib.request

import pytest

from app import sse_translate
from app.llm_providers import is_partial_rollout_rejection

pytestmark = pytest.mark.no_db

KIMI_BODY = (
    '{"error":{"type":"invalid_request_error",'
    '"message":"missing required header Kimi-Api-Version",'
    '"request_id":"fdac0ebc5ee4ec60a242e0c2079b51fc"}}'
)


def _http_error(code: int, body: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://api.moonshot.cn/v1/chat/completions", code, "Bad Request", {},
        io.BytesIO(body.encode("utf-8")),
    )


def test_the_real_rejection_is_recognised():
    assert is_partial_rollout_rejection(400, KIMI_BODY) is True


def test_a_genuinely_bad_request_is_not_retried():
    # The reason this is keyed on the body and not on the status: re-sending a payload we got
    # wrong just burns a second call and delays the real error.
    body = '{"error":{"type":"invalid_request_error","message":"unsupported parameter: top_k"}}'
    assert is_partial_rollout_rejection(400, body) is False


def test_an_empty_or_missing_body_is_not_retried():
    assert is_partial_rollout_rejection(400, "") is False
    assert is_partial_rollout_rejection(400, None) is False


def test_the_shape_is_claimed_only_for_400():
    # 5xx and 429 already retry as outages; claiming them here too would double-count and
    # muddy which rule fired.
    assert is_partial_rollout_rejection(500, KIMI_BODY) is False
    assert is_partial_rollout_rejection(429, KIMI_BODY) is False


def test_open_stream_retries_the_partial_rollout_rejection_and_succeeds(monkeypatch):
    attempts = []
    sentinel = object()

    def fake_urlopen(request, timeout=None):
        attempts.append(request)
        if len(attempts) == 1:
            raise _http_error(400, KIMI_BODY)
        return sentinel

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    result = sse_translate._open_deepseek_stream({"messages": []}, "sk-test")

    assert result is sentinel
    assert len(attempts) == 2, "the identical request must be re-issued once"


def test_the_rollout_budget_beats_the_measured_rejection_rate(monkeypatch):
    # A partial rollout rejects a FRACTION of calls, so one extra attempt is not a fix: at the
    # measured ~1 in 6, two attempts still lose 1 call in 36, and a ~100-call build run dies about
    # 94% of the time. The budget has to beat the fraction, not merely try again.
    attempts = []

    def fake_urlopen(request, timeout=None):
        attempts.append(request)
        if len(attempts) <= 4:
            raise _http_error(400, KIMI_BODY)
        return "stream"

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    assert sse_translate._open_deepseek_stream({"messages": []}, "sk-test") == "stream"
    assert len(attempts) == 5, "four rejections in a row must still resolve"


def test_the_rollout_budget_is_bounded_and_the_loop_terminates(monkeypatch):
    # The sibling of the test above, and the one that matters for termination: that one succeeds
    # on the 5th call, so it would pass with a budget of 500 or with an unconditional retry. The
    # loop is `while True`, so nothing but this pins the upper bound.
    attempts = []

    def fake_urlopen(request, timeout=None):
        attempts.append(request)
        raise _http_error(400, KIMI_BODY)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    with pytest.raises(sse_translate.UpstreamError) as raised:
        sse_translate._open_deepseek_stream({"messages": []}, "sk-test")
    assert raised.value.status == 400
    assert len(attempts) == 5, "a provider that rejects every time must stop at the budget"


def test_an_outage_keeps_its_smaller_budget(monkeypatch):
    # An outage is all-or-nothing: a second attempt is either enough or hopeless, so it must NOT
    # inherit the rollout budget and sit there retrying a dead provider.
    attempts = []

    def fake_urlopen(request, timeout=None):
        attempts.append(request)
        raise _http_error(503, "upstream is down")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    with pytest.raises(sse_translate.UpstreamError):
        sse_translate._open_deepseek_stream({"messages": []}, "sk-test")
    assert len(attempts) == 2, "an outage retries once, not four times"


def test_open_stream_does_not_retry_a_genuinely_bad_request(monkeypatch):
    attempts = []
    body = '{"error":{"type":"invalid_request_error","message":"unsupported parameter: top_k"}}'

    def fake_urlopen(request, timeout=None):
        attempts.append(request)
        raise _http_error(400, body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    with pytest.raises(sse_translate.UpstreamError) as raised:
        sse_translate._open_deepseek_stream({"messages": []}, "sk-test")

    assert raised.value.status == 400
    assert len(attempts) == 1, "a malformed payload must fail on the first attempt"


def test_the_rejection_body_still_reaches_the_log(monkeypatch, caplog):
    # The body is a STREAM: whoever reads it first consumes it. When the retry test started
    # reading it, a naive log call downstream would have logged "" and destroyed the only
    # diagnostic this failure has.
    def fake_urlopen(request, timeout=None):
        raise _http_error(400, KIMI_BODY)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sse_translate.time, "sleep", lambda _s: None)

    with caplog.at_level("WARNING"):
        with pytest.raises(sse_translate.UpstreamError):
            sse_translate._open_deepseek_stream({"messages": []}, "sk-test")

    logged = [r for r in caplog.records if r.getMessage() == "llm upstream rejected request"]
    assert logged, "a rejection that exhausts its retries must still be logged"
    assert "Kimi-Api-Version" in getattr(logged[-1], "body", ""), "the log must carry the real body"
