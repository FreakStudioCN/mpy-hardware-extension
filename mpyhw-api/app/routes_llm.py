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
    _BOARDS_DIR, _CONTEXT_BOARD_ID_RE, _V0_PHASE_NOTES_DIR, SLIM_V0_ADAPTER,
    _candidate_board_ids, _clip_context_value, _context_injection,
    _deepseek_messages, _first_user_text, _host_capabilities_note,
    _language_directive, _load_board_profile, _official_only_board_profile,
    _pair_tool_messages, _phase, _phase_data_injection,
    _raw_board_id_candidates, _resolve_board, _resolve_driver_contexts,
    _safe_context_token, _safe_micropython_download_url,
    _sanitized_preselected_board, _system_prompt, _tool_result_content,
    _translate_blocks, _v0_phase_note,
)
from app.sse_translate import (  # noqa: F401
    DeepSeekProvider, UpstreamError, _PAYLOAD_VALIDATORS, _call_deepseek_plain,
    _deepseek_payload, _deepseek_tools, _noncanonical_tools,
    _open_deepseek_stream, _payload_violation, _sse, _stub_sse,
    _translate_deepseek_stream, get_llm_provider,
)


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]
logger = logging.getLogger("mpyhw.llm")


class _CircuitBreaker:
    """Minimal in-process breaker for the DeepSeek upstream.

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
                logger.info("deepseek circuit breaker probing (single probe admitted)")
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            if self._state != "closed":
                logger.info("deepseek circuit breaker closed (recovered)")
            self._failures = 0
            self._state = "closed"

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._state != "open" and self._failures >= self._threshold:
                logger.warning("deepseek circuit breaker opened", extra={"failures": self._failures})
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
                _stub_sse(lambda _tokens: {"remaining": state["balance"], "daily_grant": state["daily_grant"], "resets_at": state["resets_at"]}),
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

        is_deepseek = getattr(provider, "name", "") == "deepseek"
        # Fail fast during an upstream outage: short-circuit BEFORE reserving a
        # credit (and release the slot), so a provider incident doesn't churn
        # reserve/refund or leak session slots across every request.
        if is_deepseek and _deepseek_breaker.is_open():
            llm_sessions.release(session_id, "upstream_unavailable")
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_unavailable"})

        # Free-tier global daily budget breaker: once today's cumulative free-tier
        # spend hits the cap, refuse new turns BEFORE reserving so abusive free traffic
        # can't drive DeepSeek to its hard console cap and DoS every user. Checked after
        # the breaker (don't churn) and only on the paid path (stub costs nothing).
        budget = _daily_global_budget()
        if budget and credit_store.global_spend_today() >= budget:
            llm_sessions.release(session_id, "daily_free_budget_exhausted")
            raise HTTPException(
                status_code=503,
                detail={"error": "daily_free_budget_exhausted", "resets_at": state["resets_at"]},
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
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
                started_at=started_at,
                total_tokens=total_tokens,
                credits_charged=charge,
                status="success",
            )
            return {"remaining": remaining, "daily_grant": state["daily_grant"], "resets_at": state["resets_at"]}

        try:
            upstream = await to_thread(provider.open_stream, body)
        except UpstreamError as error:
            # Only a transient outage (timeout/5xx/429) trips the breaker; a 4xx
            # (bad key/request) is a config error that retrying won't fix.
            if is_deepseek and _is_outage_status(error.status):
                _deepseek_breaker.record_failure()
            logger.warning("llm upstream error", extra={"status": error.status})
            credit_store.refund(user, 1)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
                started_at=started_at,
                total_tokens=None,
                credits_charged=0,
                status="error",
                error_kind="upstream_error",
            )
            llm_sessions.release(session_id, "upstream_error")
            raise HTTPException(status_code=502, detail={"error": "llm_upstream_error", "status": error.status})
        if is_deepseek:
            _deepseek_breaker.record_success()
        # V0-pure: the model writes file content inline; the backend no longer
        # intercepts file_operation writes to synthesize code from an `intent`.
        return StreamingResponse(_release_after(provider.translate_stream(upstream, meter), session_id), media_type="text/event-stream")
    except Exception:
        llm_sessions.release(session_id, "setup_error")
        raise


def _daily_global_budget() -> int:
    """Free-tier daily credit ceiling; 0 / unset / invalid means unlimited (no gate)."""
    try:
        return max(0, int(os.getenv("MPYHW_DAILY_GLOBAL_BUDGET", "0") or "0"))
    except ValueError:
        return 0


def _billable_tokens(usage: dict[str, Any]) -> int:
    """Tokens to charge credits on: what DeepSeek effectively bills, not raw prompt size.

    DeepSeek auto-caches a byte-stable request prefix and bills cache-hit tokens at a
    fraction of miss tokens, so charge `miss + completion + MPYHW_CACHE_HIT_WEIGHT*hit`
    (default weight 0.1, matching DeepSeek's ~10x cache-hit discount). Falls back to
    raw total_tokens when the cache breakdown is absent (older model / cache disabled).
    """
    total = int(usage.get("total_tokens", 0) or 0)
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is None or miss is None:
        return total
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
