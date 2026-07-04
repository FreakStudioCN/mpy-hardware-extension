# Web recommend: fail fast, stop discarding good LLM answers

Date: 2026-06-21
Scope: `cursor_for_hardware/mpyhw-api/app/web_recommend.py` (+ one additive change in
`routes_llm.py`, + tests). Other silent-fallback sites in the codebase are out of scope
for this plan and tracked separately for a follow-up sweep.

**File references below are relative to `cursor_for_hardware/mpyhw-api/`** (i.e.
`app/web_recommend.py`, `app/routes_llm.py`, `tests/test_web_recommend_*.py`).

## Problem (verified live)

`/v1/web/recommend` has two retrieval paths: an LLM path (DeepSeek extracts hardware
capabilities) and a deterministic keyword path. Live, the key is present and DeepSeek is
actually called (~4.5s/request), but ~3/4 of its answers are **discarded** and the code
silently degrades to the keyword path. Two causes:

1. **Brittle parse** — `web_recommend.py:210` does `json.loads(_strip_code_fences(text))`.
   `_strip_code_fences` only removes ``` fences, not prose. When DeepSeek prepends a
   word ("Sure, here:") `json.loads` throws → caught by `except Exception` at
   `web_recommend.py:227` → silent degrade.
2. **Over-strict token filter** — `web_recommend.py:211` keeps only exact taxonomy tokens.
   `servo` (vs `servo_control`) → filtered to empty → `if capabilities:` (line 225) false
   → silent degrade.

The payload in `routes_llm.py:925` (`_call_deepseek_plain`) does not request JSON mode.

The keyword path masks these failures, so the site looks fine while the LLM the user pays
for and waits on does ~nothing.

## Decision

**Fail fast.** The LLM is *the* path. Make it reliable; when it genuinely can't produce a
usable result, return an **explicit error** — never silently substitute a keyword guess.
(User confirmed: live visitors hitting a 503 during a real DeepSeek outage is acceptable.)

## Part A — Make the AI path reliable

These are correctness fixes (use the AI's answer), not new fallbacks.

1. **JSON mode.** Add optional `response_format: dict | None = None` param to
   `_call_deepseek_plain` (`def` at `routes_llm.py:915`); when set, include it in
   `payload`. Default `None` so existing codegen callers (`routes_llm.py:984`) are byte-
   for-byte unchanged. `web_recommend` passes `{"type": "json_object"}`. DeepSeek JSON
   mode requires the literal word "json" in the prompt; `_build_prompt` already says
   "Return ONLY a JSON object". **Verify** json_object is honored with `stream: True`
   (the helper is SSE by construction, `routes_llm.py:929`/`947-969`); the tolerant
   parser below is the safety net if a chunk carries stray text.
2. **Tolerant parse + shape validation.** New helper `_parse_capability_json(text)`:
   - try `json.loads(text)`;
   - on failure, extract outermost `{ … }` substring and `json.loads` that;
   - on failure, **raise** (loud) — do not degrade;
   - then **validate shape**: `capabilities` must be a `list`; coerce non-list/missing to
     a parse failure (raise). `board_family_hint` must be a string or null; anything else
     → treat as null. Don't assume `data.get(...)` is well-typed.
3. **Synonym normalization** before the taxonomy filter. Curated map of *unambiguous*
   short forms only:
   `servo→servo_control, motor→motor_control, temperature/temp→temperature_sensing,
   humidity→humidity_sensing, pressure→pressure_sensing, display/screen→display_text,
   motion→motion_sensing, distance→distance_sensing, sound→sound_sensing,
   audio→audio_output, touch→touch_sensing, magnet/magnetic→magnetic_sensing,
   color/colour→color_sensing, gas→gas_sensing, uv→uv_sensing, weight→weight_sensing,
   current→current_sensing, heartrate/heart_rate→heart_rate_sensing,
   clock/time→timekeeping`.
   **Not** mapped (ambiguous): `light` (digital_output vs light_sensing), `analog`
   (analog_input vs analog_output), `digital`. These require the full token.
   Normalize each returned token: in taxonomy → keep; in synonym map → map; else → drop
   **with a WARNING log** (taxonomy drift stays visible). Dedupe after mapping.

## Part B — Remove the three silent masks

1. `extract_capabilities` `except Exception → fallback` (`web_recommend.py:227`):
   LLM call/parse failure now **raises** `HTTPException(503, {"error": "llm_failed"})`,
   logged at ERROR with `exc_info`.
2. LLM not configured / daily cap reached → previously keyword fallback. Now:
   - not configured / stubbed → `503 {"error": "llm_unconfigured"}` (ERROR log; should
     never happen in prod).
   - daily cap reached (`_reserve_llm_call()` false) → `503 {"error": "llm_capacity"}`
     (WARNING log).
3. Master `try/except → breadboard, source:"error"` in `recommend`
   (`web_recommend.py:328`): **deleted**. LLM problems already surfaced as 503; any other
   unexpected failure (e.g. corrupt catalog) **propagates as 500** — loud, not masked.

`extract_capabilities` collapses to: check configured (or 503) → reserve slot (or 503) →
call LLM → tolerant parse (or 503) → normalize. Two distinct empty outcomes (per Codex —
do **not** conflate them):
- LLM returned a **raw empty** `capabilities: []` → `422 {"error":"no_capabilities"}`
  (the idea is genuinely vague/off-topic).
- LLM returned a **non-empty** list but **every token was unknown/off-taxonomy** after
  normalization → `503 {"error":"llm_failed"}` (the model violated the schema; that's an
  LLM failure, not "nothing matched"). Log the dropped tokens.
Otherwise return `{capabilities, board_family_hint, source:"llm"}`.

**Daily-cap slot is consumed even when the call then fails** (`_reserve_llm_call` reserves
before the upstream attempt). This is intentional: a real upstream call costs tokens/money
whether or not it parses, so a failing LLM legitimately draws down the cost ceiling. A
broken-LLM incident will burn the day's cap on 503s — that's acceptable fail-fast (loud,
bounded) and surfaces the outage rather than hiding it.

`recommend` always returns `source:"llm"` on success (no more "fallback"/"error").
We raise `HTTPException` directly from `web_recommend`, matching the existing pattern
(`enforce_rate_limit` already raises `HTTPException(429)`).

## Part C — Delete dead keyword machinery

Killing the fallback path makes this code dead; remove it (recoverable via git):
`_FALLBACK_KEYWORDS`, `_fallback_capabilities`, `_matches_keyword`,
`_BOARD_FAMILY_KEYWORDS`, `_fallback_board_family`. The LLM supplies `board_family_hint`,
so idea-named boards (e.g. "pico" → rp2040) still work via the LLM.

`_breadboard_fallback_row` / `assemble_parts`' "no parts → breadboard" stays as a
*complement*, but when capabilities are non-empty yet zero parts match, log a WARNING
(surfaces a catalog-coverage gap instead of hiding it).

## Error contract

| Status | error | When |
|---|---|---|
| 503 | `llm_unconfigured` | no key / stub mode |
| 503 | `llm_capacity` | daily LLM cap reached |
| 503 | `llm_failed` | upstream / call / parse failure, **or** non-empty result whose every token was off-taxonomy (schema violation) |
| 422 | `no_capabilities` | LLM OK, returned a raw empty `capabilities: []` (vague/off-topic idea) |
| 500 | — | unexpected (corrupt catalog, bug); uncaught, loud |

**Fail-fast boundary = the whole route, not just `recommend()`.** The route also loads
catalog data *after* `recommend()` (`routes_web.py:48,64-68`: `load_purchase_links`,
`board_purchase_links`). Those are no longer masked either; a failure there surfaces as an
uncaught 500. The boundary is "the request renders correctly or errors," end to end.

## Tests

**Biggest impact (per Codex): most route tests today get a 200 *only because the keyword
fallback exists* — they never configure the LLM.** Removing the fallback makes them 503
unless they stub DeepSeek. So:

- Add an **autouse fixture in `tests/test_web_recommend_routes.py`** that sets
  `DEEPSEEK_API_KEY` and monkeypatches `routes_llm._call_deepseek_plain` to return
  deterministic valid JSON (capabilities derived from the idea, or a fixed safe set), so
  every existing contract test (`test_web_recommend_returns_website_contract_shape`,
  `..._parts_come_from_real_catalog...`, `..._uses_generated_board_catalog`,
  `..._board_buy_link_prefers_curated...`, `test_default_board_buy_link_*`,
  `test_idea_naming_pico_*`) now exercises the **LLM path** and still asserts the same
  website contract. Tests that specifically want a failure opt out of the stub.
- Update the **fake signatures** everywhere: existing fakes are
  `def fake(messages, max_tokens, timeout=120)` — they will `TypeError` once
  `_llm_extract` passes `response_format=`. Change to
  `def fake(messages, max_tokens, timeout=120, response_format=None)` (or `**kwargs`).

Flip (encode the old philosophy):
- `test_llm_failure_degrades_to_fallback` → **raises 503 `llm_failed`**.
- `test_daily_cap_skips_llm_and_uses_fallback` → **raises 503 `llm_capacity`**, LLM not called.
- `test_web_recommend_never_500s_when_catalog_load_fails` → now asserts the error surfaces
  (uncaught 500), not a breadboard 200. (Patches `PackageStore.default`; note that
  route-level catalog loads are a *separate* failure surface also now unmasked.)
- `test_web_recommend_exposes_recommendation_source` (no key) → **503 `llm_unconfigured`**.

Delete (test the removed keyword path): `test_fallback_extraction_reads_idea_phrasing*`,
`test_fallback_extracts_board_family_from_idea`, `test_fallback_collision_guards`,
`test_fallback_uses_word_boundaries*`.

Preserve the useful taxonomy coverage, re-homed: `test_fallback_covers_full_taxonomy`'s
valuable half is "every capability has a real catalog part." Keep that as a pure
**`assemble_parts`-level** parametrize (feed each of the 24 capability tokens directly to
`assemble_parts`, assert the top part is not the breadboard) — no LLM, no keyword map.

Keep: rate-limit tests, `assemble_parts` catalog/dedup tests, `_build_prompt` injection
test.

Fix: the daily-cap **concurrency/atomicity** test currently monkeypatches
`web_recommend._llm_available`, but `extract_capabilities` calls `_llm_configured()` (a
separate binding), so the slow-window delay never runs and the race isn't exercised. Patch
the symbol actually on the hot path (or insert the delay at the real check point) so the
test proves what it claims. The atomic guarantee itself still lives in `_reserve_llm_call`.

Add: JSON mode requested in the payload; prose-wrapped JSON parses via the tolerant path;
malformed-but-valid JSON (e.g. `capabilities` not a list) → 503; `servo`→`servo_control`
normalization; one unknown token dropped+logged but valid ones kept; **all-unknown** tokens
→ 503 `llm_failed`; raw `[]` → 422 `no_capabilities`; each failure mode returns its
status/error; happy path returns `source:"llm"`.

## Open decisions (resolved after Codex review)

1. **Empty result — now split (Codex):** raw `[]` → 422 `no_capabilities`; non-empty but
   all-off-taxonomy → 503 `llm_failed`. This removes the conflation Codex flagged. (If you
   prefer 200-with-empty-parts for the raw-`[]` case so the site still renders a board,
   say so — it's the one place the strict-422 choice is debatable.)
2. **Catalog/data failure → 500.** Uncaught/loud; boundary now declared as the whole route
   (not just `recommend()`). No catch-all that could hide real bugs. **Resolved: 500.**
3. **Delete keyword tables.** Delete from the endpoint path (git-recoverable). The useful
   *taxonomy coverage* is preserved as an `assemble_parts`-level test fixture (Codex's
   middle path), not as live fallback code. **Resolved: delete.**

## Out of scope (follow-up)

Codebase-wide fail-fast sweep of other silent `except: degrade/fallback` sites. Grep list
to be produced separately.
