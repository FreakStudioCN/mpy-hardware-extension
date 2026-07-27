"""The credits SSE event must carry the cost and token fields only the server knows.

Non-DB coverage (card #87 slice C): the token/cache extraction is a pure function, and the
stream translator must forward WHATEVER the meter returns into the credits frame. The
end-to-end route test — real meter, real credit_store, real llm_turns row — needs Postgres
and lives in test_llm_messages.py / test_credits.py; this file deliberately does not fake
that.
"""
import json

import pytest

from app import routes_llm

pytestmark = pytest.mark.no_db


def _credits_frames(chunks: list[dict], meter) -> list[dict]:
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    out = []
    for frame in routes_llm._translate_deepseek_stream(lines, meter):
        for line in frame.splitlines():
            if not line.startswith("data:"):
                continue
            event = json.loads(line[5:])
            if event.get("type") == "credits":
                out.append(event)
    return out


def test_usage_fields_extracts_the_input_output_and_cache_split():
    fields = routes_llm._usage_fields(
        {"prompt_tokens": 1200, "completion_tokens": 180, "prompt_cache_hit_tokens": 1024, "total_tokens": 1380}
    )

    assert fields == {"input_tokens": 1200, "output_tokens": 180, "cache_hit_tokens": 1024}


def test_usage_fields_omits_what_the_upstream_did_not_report():
    # An older model / cache-disabled turn has no breakdown. The key must be ABSENT so the
    # client records "unknown", not a real 0 that would skew the per-turn cost aggregate.
    assert routes_llm._usage_fields({"total_tokens": 400}) == {}
    assert routes_llm._usage_fields({"prompt_tokens": 400}) == {"input_tokens": 400}
    # Non-numeric junk is not a token count either.
    assert routes_llm._usage_fields({"prompt_tokens": "400", "completion_tokens": None, "prompt_cache_hit_tokens": True}) == {}


def test_credits_event_forwards_every_field_the_meter_returns():
    # The translator spreads the meter's return into the credits frame; picking a fixed set
    # of keys instead would silently drop the new cost fields on the way to the client.
    metered = {
        "remaining": 46,
        "daily_grant": 50,
        "resets_at": "2026-07-26T00:00:00Z",
        "charged": 3,
        "model": "deepseek-v4-pro",
        "input_tokens": 1200,
        "output_tokens": 180,
        "cache_hit_tokens": 1024,
    }
    seen: list[dict] = []

    def meter(usage):
        seen.append(usage)
        return metered

    frames = _credits_frames(
        [
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [{"delta": {}}], "usage": {"prompt_tokens": 1200, "completion_tokens": 180, "total_tokens": 1380}},
        ],
        meter,
    )

    assert len(frames) == 1
    assert frames[0] == {"type": "credits", **metered}
    # The meter is handed the raw upstream usage chunk it derives those numbers from.
    assert seen == [{"prompt_tokens": 1200, "completion_tokens": 180, "total_tokens": 1380}]


def test_credits_event_without_a_breakdown_is_still_the_old_shape_plus_the_charge():
    # Additive contract: an upstream with no token breakdown yields today's three keys plus
    # the cost fields, so an old client that ignores extras is unaffected.
    metered = {"remaining": 46, "daily_grant": 50, "resets_at": "2026-07-26T00:00:00Z", "charged": 1, "model": "deepseek-v4-pro"}
    frames = _credits_frames([{"choices": [{"delta": {"content": "ok"}}]}], lambda _usage: metered)

    assert frames[0] == {"type": "credits", **metered}
    assert "input_tokens" not in frames[0]
