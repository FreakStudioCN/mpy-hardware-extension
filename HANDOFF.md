# HANDOFF — Blockless credit/cost-structure fix

## Goal
A single hardware project was burning the **entire 50-credit daily grant and dying with
`out_of_credits` before codegen finished** (real evidence: `.mpyhw/sessions/session-mpxv67yn-d9lrtl3b/session.jsonl`,
balance trace `50→…→0` then `session_error:"out_of_credits"`). Root cause is the cost
structure, not an accounting bug: every ReAct round re-sent the full growing context
(system prompt + ~25-skill catalog + 15 tool defs + all history) at full price, with
per-call `ceil` rounding. Plan of record: `~/.claude/plans/blockless-credits-34-activity-parsed-crown.md`
(items A1,A2,A3 = cut re-send / cache; B1,B2 = cache-discount metering; C = cumulative
metering; D = honest estimate; E = raise grant).

## Current Progress (what's DONE and verified)

**Client (extension) — `mpy-hardware-extension/` — full test suite GREEN (exit 0):**
- **A1** `compactMessagesForRequest` in `src/core/agent-backed-loop.ts`: stubs stale, bulky
  tool_result blocks (`query_board_profile`/`get_package_context`/`propose_manifest`/
  `generate_code`/`read_serial_until`, >800 chars), keeps the last 2 tool-result turns
  verbatim, never mutates `state.messages`. Tests in `test/agent-backed-loop.test.ts`.
- **A2** catalog sent only on `state.turnSeq === 0` (same file, `requestMessages`).
- **D** honest plan-gate cost in `src/webview/index.html`: `本步预计 ~N｜本次会话已用 X｜剩余 Y`
  (added module-scoped `lastDailyGrant`, set in `setCredits`).

**Backend — `mpyhw-api/`:**
- **A3** byte-stable prefix contract comment in `app/routes_llm.py` `_deepseek_payload` +
  regression test `test_deepseek_payload_is_byte_stable_for_prefix_caching` (already
  deterministic; this locks it).
- **B1 (verified with REAL DeepSeek calls)**: model `deepseek-v4-pro` is real; usage returns
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (+ `prompt_tokens_details.cached_tokens`).
  Automatic prefix caching gives **~99% hit on an identical re-sent prefix**.
- **B2** cache-discounted metering in `app/routes_llm.py`: `_translate_deepseek_stream` now
  captures the full `usage` dict; new `_billable_tokens()` = `miss + completion + MPYHW_CACHE_HIT_WEIGHT*hit`
  (default 0.1); `meter()` charges billable (not raw total), analytics still records raw
  `total_tokens`. Test `test_llm_messages_charges_cache_discounted_tokens` in `tests/test_credits.py`.
- **C** cumulative metering: `meter` calls `credit_store.record_tokens()`. **NOTE: the user
  re-implemented `record_tokens` themselves onto a new `token_tallies` table** (see collision note).
  `tests/test_credit_store.py` has cumulative tests; `tests/test_credits.py` 25k→2 expectation updated.

### Real measurement (replaying the actual 18-round session through DeepSeek)
| scenario | credits |
|---|---|
| real session (old: ceil-per-call, no cache discount) | **50 → died** |
| replay baseline, raw-token metering | 38 |
| **+ cache-discounted (B2)** | **9** |
| A1+A2 optimized + cache-discounted (B2) | **7** |
**Key insight: cache-discounted metering (B2) is the dominant lever (38→9). A1/A2 help the
miss/uncached cost but matter less once caching is priced in — and aggressive trimming can
*bust* the cache (observed round 6). Strategy = stable prefix + discount hits, NOT aggressive trimming.**

## ⚠️ CRITICAL: active collaboration / do not clobber
The user has been **rewriting the backend in parallel** during this session. They built:
- `app/db.py` — a Postgres-capable (`DATABASE_URL`) + SQLite layer with tables `users`,
  `credit_balances`, `credit_ledger`, `token_tallies`, `active_llm_sessions`, `telemetry_events`,
  `llm_turns`, `sessions`.
- `app/credit_store.py` — ledger (`_ledger`, `get_user`, `ledger_for_user`) + `record_tokens`
  reconciled onto **`token_tallies`** (NOT the `credit_balances.tokens_used_today` column an
  earlier edit added — see dead code below).
- `app/analytics.py` (`record_llm_turn`), `app/llm_sessions.py` (per-user/global concurrency),
  `tests/test_llm_concurrency.py`.

**Coordinate before editing `app/db.py`, `app/credit_store.py`, `app/routes_llm.py`, `app/analytics.py`,
`app/llm_sessions.py` — the user is hands-on there.**

## What Worked
- Replaying the real recorded session through DeepSeek = objective, decisive evidence
  (temp scripts in `%TEMP%`: `probe_deepseek.py`, `replay_measure.py`).
- Keeping A1 trimming gentle (last-2 verbatim, >800-char threshold) so it doesn't bust caching.
- Idempotent, additive backend changes that the user could merge into their architecture.

## What Didn't Work / gotchas
- **Background Bash with pipes loses stdout** here; the harness also auto-backgrounds pytest.
  Use `> file 2>&1` (no pipe) and Read the file, or rely on the completion **exit code**.
- **Bash cwd does NOT persist across calls** on this Windows setup — use absolute paths or a
  single `cd … && cmd`.
- Two `test_llm_concurrency.py` tests fail (`502 != 429`) — that's the **user's in-flight
  concurrency feature** (handler doesn't return 429 yet), NOT caused by these changes.

## Next Steps
1. **Backend tests now REQUIRE Postgres.** The user switched `tests/conftest.py` from the old
   SQLite tmp-DB fixture (`_credit_env`) to `_api_env`, which `pytest.fail`s unless
   `DATABASE_URL` or `MPYHW_TEST_DATABASE_URL` is set. My backend tests (B2 + cumulative + A3 +
   ledger) were **verified green under the prior SQLite harness** (multiple exit-0 runs); they now
   need a Postgres test DB to re-run. The B2 change is pure-Python / DB-agnostic (uses the user's
   `app.db`-abstracted `record_tokens`), so it should pass on Postgres — set
   `MPYHW_TEST_DATABASE_URL=postgres://…` and run `cd mpyhw-api && python -m pytest tests/ -q`
   to confirm (expect the 2 known `test_llm_concurrency` WIP reds).
2. **Dead code to resolve (from these edits, now superseded by the user's design):**
   - `app/db.py` `credit_balances.tokens_used_today` column — unused (record_tokens uses `token_tallies`). Drop it.
   - `app/credit_store.py` `credits_for_tokens` (ceil) — no longer called by the meter; keep only if used elsewhere.
3. **E — raise `DAILY_GRANT`**: deferred (gated). With B2, a project costs ~7–9 credits, so 50/day
   ≈ 5–7 projects. Recommend bumping `MPYHW_DAILY_GRANT` (e.g. 100) **only after B2 is deployed/verified live** — raising it before B2 multiplies real DeepSeek spend.
4. **End-to-end live validation**: re-run the same "AI 对话机器人" intent against the real API
   (`scripts/serve.ps1`, key in `mpyhw-api/.env`) and confirm the new `session.jsonl` finishes
   codegen with credits to spare (not `out_of_credits`), and that `llm_turns`/credits reflect cache discount.
5. **Cleanup**: remove temp probe scripts in `%TEMP%` and any stray `mpyhw-api/_ptest.txt`.
6. **Progressive disclosure (optional, lower priority)**: data shows limited additional value
   once caching is priced in; only worth it to shrink first-time *miss* (e.g. board profile / tool
   schema first send) and only if it doesn't break prefix stability.

## Files changed this session
- `mpy-hardware-extension/src/core/agent-backed-loop.ts` (A1, A2)
- `mpy-hardware-extension/test/agent-backed-loop.test.ts` (A1 tests, A2 assertion)
- `mpy-hardware-extension/src/webview/index.html` (D)
- `mpyhw-api/app/routes_llm.py` (A3 comment, B2)
- `mpyhw-api/tests/test_llm_messages.py` (A3 test; user also lowered max_tokens default)
- `mpyhw-api/tests/test_credits.py` (B2 test, cumulative expectation)
- `mpyhw-api/tests/test_credit_store.py` (cumulative tests; user added ledger tests)
- `mpyhw-api/app/db.py`, `app/credit_store.py` — **shared with the user's parallel rewrite; see collision note**
