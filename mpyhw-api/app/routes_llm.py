from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from asyncio import to_thread
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import analytics, credit_store, llm_sessions
from app.auth import get_current_user
from app.tool_registry import LLM_TOOL_NAMES  # noqa: F401 - re-exported: tests read routes_llm.LLM_TOOL_NAMES

# Pure-move extraction (Phase B). These names are re-exported here because
# (a) tests monkeypatch routes_llm.<name> and (b) web_recommend imports
# _call_deepseek_plain from this module. routes_llm remains the namespace of
# record; the extracted modules resolve patched siblings back through it.
from app.prompt_assembly import (  # noqa: F401
    _BOARDS_DIR, _CONTEXT_BOARD_ID_RE, _SKILL_BOARDS_DIR, _V0_PHASE_NOTES_DIR,
    BoardLibraryUnreadable, SLIM_V0_ADAPTER,
    _board_candidate_profiles, _board_candidates_injection, _select_hw_shape_injection, _generate_shape_injection,
    _deploy_shape_injection,
    _candidate_board_ids, _clip_context_value, _context_injection,
    _deepseek_messages, _first_user_text, _host_capabilities_note,
    _language_directive, _load_board_profile, _official_only_board_profile,
    _pair_tool_messages, _phase, _phase_data_injection,
    _board_match_texts, _match_phrases, _raw_board_id_candidates,
    _resolve_board, _resolve_driver_contexts, _skill_board_candidate_ids,
    _skill_board_index,
    _safe_context_token, _safe_micropython_download_url,
    _sanitized_preselected_board, _system_prompt, _tool_result_content,
    _translate_blocks, _v0_phase_note,
)
from app.sse_translate import (  # noqa: F401
    DeepSeekProvider, OpenAIProvider, UpstreamError, _PAYLOAD_VALIDATORS,
    _call_deepseek_plain, _deepseek_payload, _deepseek_tools,
    _noncanonical_tools, _open_deepseek_stream, _payload_violation, _sse,
    _stub_sse, _translate_deepseek_stream, get_llm_provider,
    llm_provider_configured,
)


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]
logger = logging.getLogger("mpyhw.llm")


class _CircuitBreaker:
    """Minimal in-process breaker for the active LLM upstream (shared across
    providers; a deployment runs exactly one provider at a time).

    Per-worker (NOT distributed): local stampede protection so a provider outage
    doesn't make every request reserve-then-refund a credit and churn session slots.
    After `threshold` consecutive failures it opens for `cooldown` seconds. While
    open, is_open() admits exactly ONE probe per cooldown window — it re-arms the
    timer as it admits, so concurrent callers in the same window are still blocked
    (no stampede onto a dead upstream). The probe's outcome closes the breaker
    (recovered) or keeps it open. If a probe's outcome is never recorded (e.g. the
    request fails earlier on out-of-credits), the next probe is auto-admitted after
    another cooldown, so the breaker can never get stuck disabled.
    """

    def __init__(self, threshold: int = 5, cooldown: float = 30.0):
        self._threshold = threshold
        self._cooldown = cooldown
        self._failures = 0
        self._state = "closed"  # closed | open
        self._opened_at = 0.0
        self._lock = threading.Lock()

    def is_open(self) -> bool:
        """Whether to short-circuit this request. NOTE: not side-effect-free —
        admitting a probe re-arms the cooldown so only the single admitted caller
        sees False until the window expires again."""
        with self._lock:
            if self._state != "open":
                return False
            if time.monotonic() - self._opened_at >= self._cooldown:
                self._opened_at = time.monotonic()  # re-arm: admit exactly one probe
                logger.info("llm circuit breaker probing (single probe admitted)")
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            if self._state != "closed":
                logger.info("llm circuit breaker closed (recovered)")
            self._failures = 0
            self._state = "closed"

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._state != "open" and self._failures >= self._threshold:
                logger.warning("llm circuit breaker opened", extra={"failures": self._failures})
                self._state = "open"
                self._opened_at = time.monotonic()
            elif self._state == "open":
                self._opened_at = time.monotonic()  # a probe failed; restart the cooldown

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._state = "closed"
            self._opened_at = 0.0


# A status that signals a transient upstream OUTAGE (worth tripping the breaker),
# as opposed to a 4xx config/auth error (bad key, bad request) which should not.
def _is_outage_status(status: int) -> bool:
    return status == 0 or status == 429 or status >= 500


_deepseek_breaker = _CircuitBreaker()


@router.post("/v1/llm/messages")
async def llm_messages(request: Request, user: dict = Depends(get_current_user)):
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_json"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "json_object_required"})
    rejected = _noncanonical_tools(body.get("tools", []))
    if rejected:
        raise HTTPException(status_code=403, detail={"error": "tool_not_whitelisted", "rejected": rejected})

    session_id = str(uuid.uuid4())
    limit_error = llm_sessions.acquire(session_id, user)
    if limit_error:
        raise HTTPException(status_code=429, detail={"error": limit_error})

    # Pre-flight credit check. Stub mode has no paid upstream call, so it reports
    # the balance without reserving. Real upstream turns reserve one credit before
    # spending tokens; final metering debits any additional usage.
    state = credit_store.ensure_daily_grant(user, credit_store.grant_for(user))
    if state["balance"] <= 0:
        llm_sessions.release(session_id, "out_of_credits")
        raise HTTPException(
            status_code=402,
            detail={"error": "out_of_credits", "balance": 0, "resets_at": state["resets_at"]},
        )

    if os.getenv("MPYHW_LLM_STUB") == "1":
        return StreamingResponse(
            _release_after(
                # The stub makes no upstream call, so the turn genuinely costs nothing and
                # burns no tokens. Report that explicitly (rather than omitting the fields)
                # so a MPYHW_LLM_STUB mock run exercises the SAME client recording path a
                # live run does — that is what makes it usable as a workflow sample.
                _stub_sse(lambda _tokens: {
                    "remaining": state["balance"],
                    "daily_grant": state["daily_grant"],
                    "resets_at": state["resets_at"],
                    "charged": 0,
                    "model": "stub",
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_hit_tokens": 0,
                }),
                session_id,
            ),
            media_type="text/event-stream",
        )

    # Any failure between here and the start of streaming must release the slot, or
    # it leaks until the TTL and the user gets spurious 429s. The inner branches set
    # a precise status first; the outer guard then catches anything they don't (e.g.
    # get_llm_provider raising 503), and is a no-op once a status is already set.
    try:
        provider = get_llm_provider()
        try:
            provider.ensure_configured()
        except HTTPException:
            llm_sessions.release(session_id, "not_configured")
            raise

        breaker_enabled = getattr(provider, "uses_breaker", False)
        # Fail fast during an upstream outage: short-circuit BEFORE reserving a
        # credit (and release the slot), so a provider incident doesn't churn
        # reserve/refund or leak session slots across every request.
        if breaker_enabled and _deepseek_breaker.is_open():
            llm_sessions.release(session_id, "upstream_unavailable")
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_unavailable"})

        # Hardcoded comped accounts skip both free-tier caps below: the caps exist to
        # protect the free tier's budget, and unlimited spend is excluded from that
        # budget at the credit_store layer.
        unlimited = credit_store.is_unlimited(user)

        # Free-tier global daily budget breaker: once today's cumulative free-tier
        # spend hits the cap, refuse new turns BEFORE reserving so abusive free traffic
        # can't drive DeepSeek to its hard console cap and DoS every user. Checked after
        # the breaker (don't churn) and only on the paid path (stub costs nothing).
        budget = _daily_global_budget()
        if budget and not unlimited and credit_store.global_spend_today() >= budget:
            llm_sessions.release(session_id, "daily_free_budget_exhausted")
            raise HTTPException(
                status_code=503,
                detail={"error": "daily_free_budget_exhausted", "resets_at": state["resets_at"]},
            )

        # Per-user daily credit cap: env-tunable, off by default. Distinct from the
        # balance/grant check above — this binds even when an admin has topped up the
        # user's balance, so a comped user still can't run unlimited turns in a day.
        user_cap = _daily_user_cap()
        if user_cap and not unlimited and credit_store.user_spend_today(user) >= user_cap:
            llm_sessions.release(session_id, "daily_cap_reached")
            raise HTTPException(
                status_code=402,
                detail={"error": "daily_cap_reached", "resets_at": state["resets_at"]},
            )

        reserved_remaining = credit_store.reserve(user, 1)
        if reserved_remaining is None:
            llm_sessions.release(session_id, "out_of_credits")
            raise HTTPException(
                status_code=402,
                detail={"error": "out_of_credits", "balance": 0, "resets_at": state["resets_at"]},
            )

        started_at = datetime.now(timezone.utc)

        def meter(usage: dict[str, Any]) -> dict:
            # Charge on cache-discounted tokens, not the raw prompt: DeepSeek auto-caches
            # the stable request prefix and bills cache hits at a fraction, so re-sent
            # context must not be re-charged at full price (measured ~85-99% hit rate on
            # later rounds). record_tokens does the cumulative crossing vs the reserved 1.
            total_tokens = int(usage.get("total_tokens", 0) or 0)
            charge = credit_store.record_tokens(user, _billable_tokens(usage))
            if charge == 0:
                remaining = credit_store.refund(user, 1)
            elif charge > 1:
                remaining = credit_store.debit(user, charge - 1)
            else:
                remaining = credit_store.debit(user, 0)
            model = _provider_model(provider)
            tokens = _usage_fields(usage)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=model,
                started_at=started_at,
                total_tokens=total_tokens,
                credits_charged=charge,
                status="success",
                input_tokens=tokens.get("input_tokens"),
                output_tokens=tokens.get("output_tokens"),
            )
            # `charged` is the AUTHORITATIVE deduction for this turn. The client can only
            # infer consumption from a balance delta, which misses the first turn of a
            # session (no baseline) and any turn where a refund moves the balance the other
            # way. Additive: an old client ignores the extra keys.
            return {
                "remaining": remaining,
                "daily_grant": state["daily_grant"],
                "resets_at": state["resets_at"],
                "charged": charge,
                "model": model,
                **tokens,
            }

        try:
            upstream = await to_thread(provider.open_stream, body)
        except UpstreamError as error:
            # Only a transient outage (timeout/5xx/429) trips the breaker; a 4xx
            # (bad key/request) is a config error that retrying won't fix.
            if breaker_enabled and _is_outage_status(error.status):
                _deepseek_breaker.record_failure()
            logger.warning("llm upstream error", extra={"status": error.status})
            credit_store.refund(user, 1)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=_provider_model(provider),
                started_at=started_at,
                total_tokens=None,
                credits_charged=0,
                status="error",
                error_kind="upstream_error",
            )
            llm_sessions.release(session_id, "upstream_error")
            raise HTTPException(status_code=502, detail={"error": "llm_upstream_error", "status": error.status})
        if breaker_enabled:
            _deepseek_breaker.record_success()
        def on_interrupt(error: BaseException) -> None:
            # A stream that dies mid-turn was invisible in llm_turns: meter() writes
            # status="success" the moment the usage chunk lands, and a break before usage
            # wrote no row at all. Either way the table reported a healthy run. Recording
            # the break here is what makes "why did that phase stall" answerable from the
            # data rather than from the client's error event alone.
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=_provider_model(provider),
                started_at=started_at,
                total_tokens=None,
                credits_charged=0,
                status="error",
                error_kind="upstream_stream_interrupted",
            )

        # V0-pure: the model writes file content inline; the backend no longer
        # intercepts file_operation writes to synthesize code from an `intent`.
        return StreamingResponse(
            # Keyword, not positional: a provider that has not grown the parameter must fail
            # by name rather than bind the callback to whatever its third argument is called.
            _release_after(provider.translate_stream(upstream, meter, on_interrupt=on_interrupt), session_id),
            media_type="text/event-stream",
        )
    except Exception:
        llm_sessions.release(session_id, "setup_error")
        raise


def _daily_global_budget() -> int:
    """Free-tier daily credit ceiling; 0 / unset / invalid means unlimited (no gate)."""
    try:
        return max(0, int(os.getenv("MPYHW_DAILY_GLOBAL_BUDGET", "0") or "0"))
    except ValueError:
        return 0


def _daily_user_cap() -> int:
    """Per-user daily credit ceiling; 0 / unset / invalid means unlimited (no gate).
    Distinct from the global free-tier budget above: this binds a single user even
    when an admin has topped up their balance (credit_store.set_balance) — the cap
    is about turns-per-day, not remaining balance."""
    try:
        return max(0, int(os.getenv("MPYHW_DAILY_USER_CAP", "0") or "0"))
    except ValueError:
        return 0


def _usage_fields(usage: dict[str, Any]) -> dict[str, Any]:
    """The turn's token breakdown, for the credits SSE event and the llm_turns row.

    These four numbers exist only here (the client never sees the upstream usage chunk),
    so without forwarding them the extension can record that a credit was spent but not
    what it bought. A key whose value is absent or non-numeric is OMITTED rather than sent
    as 0: an older model with no cache breakdown must read as "unknown" downstream, not as
    a real zero that would skew the per-turn cost aggregate.
    """
    details = usage.get("prompt_tokens_details")
    candidates = {
        "input_tokens": usage.get("prompt_tokens"),
        "output_tokens": usage.get("completion_tokens"),
        # DeepSeek reports the flat field; OpenAI nests it as
        # prompt_tokens_details.cached_tokens. Same meaning: cached prompt tokens.
        "cache_hit_tokens": usage.get(
            "prompt_cache_hit_tokens",
            details.get("cached_tokens") if isinstance(details, dict) else None,
        ),
    }
    return {
        key: int(value)
        for key, value in candidates.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }


def _provider_model(provider) -> str:
    """Model name recorded in analytics; getattr because fake test providers
    predate the provider.model() accessor."""
    fn = getattr(provider, "model", None)
    return fn() if callable(fn) else os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro")


def _billable_tokens(usage: dict[str, Any]) -> int:
    """Tokens to charge credits on: cache-discounted usage, not raw prompt size.

    Both upstreams auto-cache a byte-stable request prefix and bill cache-hit
    tokens at a fraction of miss tokens, so charge
    `miss + completion + MPYHW_CACHE_HIT_WEIGHT*hit` (default weight 0.1 — both
    DeepSeek and gpt-5.5 price cached input at ~1/10). DeepSeek reports
    hit/miss flat; OpenAI reports only the hit side (prompt_tokens_details.
    cached_tokens), so miss is the uncached remainder of the prompt. OpenAI's
    completion_tokens already includes reasoning tokens — do not add
    completion_tokens_details.reasoning_tokens on top (double count). Falls back
    to raw total_tokens when no cache breakdown is present. This is the credit
    abstraction, not exact upstream dollar accounting.
    """
    total = int(usage.get("total_tokens", 0) or 0)
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is None or miss is None:
        details = usage.get("prompt_tokens_details")
        prompt = usage.get("prompt_tokens")
        cached = details.get("cached_tokens") if isinstance(details, dict) else None
        # A malformed breakdown must not raise inside the streaming meter() (the
        # turn is already paid for) nor produce a negative/invalid charge: any
        # non-numeric, negative, or cached>prompt shape bills the plain total.
        ok = all(isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 for v in (prompt, cached))
        if not ok or cached > prompt:
            if cached is not None:
                logger.warning("invalid openai cache breakdown; billing full total_tokens")
            return total
        hit = int(cached)
        miss = int(prompt) - hit
    completion = int(usage.get("completion_tokens", 0) or 0)
    # Clamp to [0, 1] and fall back to the default on a bad value: a misconfigured
    # env var must not raise inside the streaming meter() generator (it would abort
    # the turn) or let cache hits be billed above full price.
    try:
        weight = float(os.getenv("MPYHW_CACHE_HIT_WEIGHT", "0.1"))
    except ValueError:
        weight = 0.1
    weight = min(1.0, max(0.0, weight))
    return int(int(miss) + completion + weight * int(hit))


def _release_after(events: Iterable[str], session_id: str):
    try:
        yield from events
    finally:
        llm_sessions.release(session_id)
