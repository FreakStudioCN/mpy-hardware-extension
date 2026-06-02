# Code review findings — 2026-06-02

## Resolution status (fixes applied + verified this session)
All fixes were test-driven (failing test first) AND re-verified against the original repros.
Final suites: **extension 124/124, typecheck clean, API 83/83.**

| # | Finding | Status | Fix |
|---|---------|--------|-----|
| 1 | Package driver-context path traversal | **Fixed** | `get_driver_context` contains the ref to `content/packages` (`is_relative_to`); `safe_context_filename` sanitizes ingestion-derived names (both ingest scripts). Repro now `raises driver_context_missing`. |
| 2 | Unbounded per-turn token cost | **Fixed** | `_deepseek_payload` adds `max_tokens` (env `MPYHW_LLM_MAX_TOKENS`, default 8192). The metering floor stays (can't go negative) but the per-turn cost is now bounded. |
| 3 | False success on a failed serial read | **Fixed** | `agent-loop.ts` only records `lastRuntimeMarker` when the read `ok` — a failed read no longer feeds the success marker. (termination.ts's `TEMP_C=` clause is left intact; it's the legitimate success path for a successful read.) |
| 4 | `auditCode` bypassable | **Fixed (part)** | Now flags `__import__`/`exec`/`eval` and imports after `;`. Part B (flash `state.files` vs `toolInput.content`) **not changed** — `audit_code` and `write_main_py` use the same `toolInput.content`, so flashed bytes are the audited bytes; an existing test deliberately encodes this. |
| 5 | SessionController concurrent-start corruption | **Fixed** | `start()` rejects re-entry while a run is in flight (`session_busy`) instead of clobbering the shared abort/state. |
| 7 | Windows non-ASCII corrupted to device | **Fixed** | `serve.py` `main()` forces UTF-8 on stdin/stdout (`_ensure_utf8_io`). |
| 8 | `checkToolRegistry` names-only/one-directional | **Fixed** | Now compares the name sets bidirectionally. |
| 9 | `confidence` leaks via search/resolve | **Fixed** | Stripped at the API boundary (`_public_hit`); ranking still uses it internally. |
| 6 | Over-permissive success (any ok read) | **Not changed** | Deliberate product choice (project-agnostic verification). Tightening needs manifest-derived expected markers — a feature, not a fix. |
| 10 | `state.files` not reset on continuation | **Not changed** | Intentional — a continuing session is the same project; accumulated `lib/` files should persist. |
| 11 | `credit_store.reset()` Windows file-lock | **Not changed** | Test-only hook, unused by the suite; incidental to my own repro. |

Original findings (as first recorded) follow below.

---

Scope: full repo (`contracts/`, `mpyhw-api/`, `mpy-hardware-extension/`).
Method: built + typechecked + ran both test suites for ground truth, then hunted for
problems the suites don't catch. **Every finding below was reproduced** (script + observed
output), not reasoned about abstractly. Findings already fixed mid-review are listed
separately so they aren't re-fixed.

## Ground truth
- `npm run typecheck` (extension): clean.
- `npm test` (extension): **116/116 pass**.
- `pytest` (API): **80/80 pass**.

So the code is green on its own tests; everything below is a gap those tests miss.

## ⚠️ The working tree changed during this review
The uncommitted working tree was being edited by another process *while I reviewed it*.
Concretely: my first read of `workspace-writer.ts` showed no path guard; minutes later the
same file rejected traversal, and `git diff` of `termination.ts`/`agent-loop.ts` appeared
mid-session (file mtimes ~1 min before I re-checked). Six files that weren't modified at
session start (`agent-loop.ts`, `termination.ts`, `shim-process.ts` + their tests,
`workspace-writer.test.ts`) became modified during the review.

**Consequence:** all findings below are verified against the **working tree as of
~2026-06-02 10:40 UTC**. For a stable review, re-run against a frozen commit
(`git stash` or review a tagged commit) — a moving tree makes "reproduce" a moving target.

---

## Fixed during the review (verified — do NOT re-fix)
| # | Issue | Evidence it's now fixed |
|---|-------|--------------------------|
| F-a | **Workspace path traversal** — generated file names like `../../ESCAPED.py` wrote outside the workspace. | `writeGeneratedFiles` now calls `normalizeGeneratedArtifactPath` (workspace-writer.ts:31) and returns `invalid_generated_path`. My repro: traversal rejected, only `main.py` written inside. |
| F-b | **Shim request hangs forever** on a non-JSON / unmatched stdout line. | `ShimProcess.request` now takes `timeoutMs=30_000`, rejects with `shim_request_timeout`, and `handleExit` clears timers (shim-process.ts:11-24,63-71). |
| F-c | **Success was thermometer-only** (`TEMP_C=`). | `termination.ts:2` + `agent-loop.ts:57-59` add `runtimeVerified`, set on any `read_serial_until` with `ok`. (But see #3 and #6 — the fix is partial and over-broad.) |

---

## Live findings (reproduced against current code)

### 1. [HIGH] Package driver-context path traversal (read out-of-tree) via ingestion
**Where:** `mpyhw-api/app/package_store.py:114-115` (no containment on the join);
`mpyhw-api/scripts/ingest_upypi.py:135-137` (path derived from untrusted upstream).
**What:** `get_driver_context` does `ROOT/"content"/"packages"/record["driver_context_ref"]`
with no check that the result stays under `content/packages/`. `driver_context_ref` is
preserved verbatim from the record (`_with_defaults` = `{**raw, **normalized}`), and
ingestion builds it as `f"driver_context/{name}-{version}.json"` from the **upypi-supplied
name/version with no sanitization** — the same unsanitized value is also used as the
**write** target during ingestion. So a malicious upypi package (`name="../../../x"`) can
write a driver-context file outside the tree at ingest time and plant a record whose
ref escapes the tree, causing out-of-tree file reads when the route is served.
(Note: not a direct unauthenticated read — the HTTP caller can't set the ref; it requires a
poisoned ingest. `routes_content.py:12-17` already has the containment guard this route lacks.)
**Repro:** `mpyhw-api/_review_repro.py`
```
=== A: get_driver_context path traversal (current package_store.py) ===
OUT-OF-TREE SECRET LEAKED: True
=== B: ingestion driver_context_ref derivation ===
  upstream name='../../../evil' -> ref='driver_context/../../../evil-1.0.json'
    write-target resolves to ...\Temp\mpyhw-pkg-...\evil-1.0.json   (escaped content/packages)
```
**Fix:** resolve the joined path and reject if not `is_relative_to(content/packages)`
(reuse `_safe_content_path`); sanitize `name`/`version` in ingestion before building paths.

### 2. [HIGH/MEDIUM] Unbounded per-turn token cost + last-turn undercharge (anti-abuse gap)
**Where:** `mpyhw-api/app/routes_llm.py:67-75` (`meter`) + `:136-143` (no `max_tokens` in the
DeepSeek payload); `credit_store.debit` floors at 0.
**What:** A turn reserves 1 credit, then `debit(charged-1)`. `debit` floors at 0, and the
upstream payload sets **no `max_tokens`**, so a single turn can consume arbitrarily many
tokens while the user is charged at most their remaining balance. A user with 1 credit gets
one turn of effectively unlimited tokens; the platform silently absorbs the overage.
**Repro:** `mpyhw-api/_review_repro_credits.py`
```
reserved 1, balance now 0
turn used 50000 tokens = 5 credits of cost
after debit(4) on a 0 balance -> remaining=0
=> user PAID 1 credit, CONSUMED 5; platform absorbed 4 credits of tokens
per-turn token ceiling in payload: False
```
(Concurrency of `reserve()` is **safe** — 20 concurrent `reserve(1)` from 50 → 30, no overdraft.)
**Fix:** send `max_tokens` to bound a turn's cost; pre-flight reject when balance can't cover
the worst-case turn, or carry the deficit instead of flooring.

### 3. [MEDIUM] False "success": a failed serial read whose last line contains `TEMP_C=` is graded success
**Where:** `mpy-hardware-extension/src/core/termination.ts:2` — the legacy
`lastRuntimeMarker?.includes("TEMP_C=")` clause survived the `runtimeVerified` fix.
**What:** A thermometer that prints one reading then hangs → `read_serial_until` times out
(`ok:false`, `runtimeVerified` stays false, `repairRound` increments) but `lastRuntimeMarker`
is still `"TEMP_C=24.0"`, so `shouldTerminate` returns `success` — masking a runtime failure.
**Repro:** `mpy-hardware-extension/_review_repro.ts`
```
F2 repairRound=1, runtimeVerified=false -> {"done":true,"reason":"success"}  (should NOT be success)
```
**Fix:** drop the `TEMP_C=` clause now that `runtimeVerified` exists, or only honor the
marker when the observation was `ok`.

### 4. [MEDIUM] Generated code reaches the device un-audited / divergent
**Where:** `agent-backed-loop.ts:238-262` (`generate_code` never calls `auditCode`; audit only
runs if the model chooses `audit_code`), `:303` (`write_main_py` flashes `toolInput.content`,
the model's echo — **not** the generated/audited `state.files["main.py"]`; lib files at :309-312
correctly use `state.files`), and `audit-code.ts:13-22` (`parseImports` is a line-prefix regex).
**What:** Audit is advisory, the audit regex is trivially bypassed, and even the entry file
that *is* shown/audited isn't the bytes that get flashed.
**Repro:** `mpy-hardware-extension/_review_repro.ts`
```
F3 __import__        -> ok=true disallowed=[]
   exec             -> ok=true disallowed=[]
   semicolon import -> ok=true disallowed=[]
   plain disallowed -> ok=false disallowed=["socket"]   (only the naive case caught)
```
**Fix:** flash `state.files["main.py"]` for the entry file too; run `auditCode` inside
`generate_code` (gate `write_main_py` on it); detect `__import__`/`exec`/`eval` and post-`;`
imports (or AST-parse).

### 5. [MEDIUM] SessionController: concurrent `start()` corrupts shared state; `cancel()` only aborts the latest run
**Where:** `mpy-hardware-extension/src/extension/session-controller.ts:52-53,73,90,97`.
**What:** `start()` has no re-entry guard. A second `start()` while the first is still awaiting
`loop()` overwrites `this.abort`, `this.state`, `this.latestFiles`, `this.latestManifest`.
`cancel()` aborts only the current `this.abort` (run 2), so run 1 keeps running; the `finally`
then nulls `this.abort`, so a later `cancel()` is a no-op. Two in-flight builds share one
`this.state`. (Reproduced by the agent harness; confirmed by reading the current file.)
**Fix:** reject/await re-entry while a run is active, or track runs individually so `cancel()`
aborts all in-flight signals and state isn't shared.

### 6. [LOW/MEDIUM] New success criterion is over-permissive
**Where:** `termination.ts:2` + `agent-loop.ts:57-59`.
**What:** *Any* `read_serial_until` that returns `ok` sets `runtimeVerified=true` → `success`.
Since `MPYHW_READY` is a default marker printed at startup, a program that prints the banner
then crashes in its loop is graded "verified". Fixes the thermometer-only bug but trades it
for "booted = success".
**Repro:** `_review_repro.ts` → `blink, runtimeVerified=true -> {"done":true,"reason":"success"}`.
**Fix:** require an expected status token from the manifest/intent, not merely a successful read.

### 7. [MEDIUM] Windows: non-ASCII content corrupted on the way to the device
**Where:** `python/shim/serve.py:203` (`for line in sys.stdin` with no UTF-8 reconfigure) +
`src/extension/device-shim.ts:104,107` (spawn without `PYTHONIOENCODING`).
**What:** Node writes UTF-8 to the shim's stdin; Python decodes it with the Windows code page
(gbk on this box). Any non-ASCII in `code`/`path`/`url` (e.g. Chinese comments/strings) is
silently corrupted before it's written to the device, and `write_main_py` still returns
`ok`. (Responses are safe — `json.dumps` defaults to `ensure_ascii=True`.)
**Repro:** agent spawned the real `serve.py` as device-shim.ts does and observed
`stdin.encoding=gbk`; intended `温度` (U+6E29 U+5EA6) written as U+5A13 U+2541 U+5BB3. Current
code still lacks the reconfigure (grep: only the temp-file write uses `encoding="utf-8"`).
**Fix:** `sys.stdin.reconfigure(encoding="utf-8")` at the top of `main()` and/or set
`PYTHONIOENCODING=utf-8` in the spawn env.

### 8. [LOW] `checkToolRegistry` only compares tool names, one direction
**Where:** `mpy-hardware-extension/src/core/api-client.ts:32-37`.
**What:** The extension's only contract-vs-backend guard flags only `local`-not-in-`remote`
names. It ignores backend-only tools, and any drift in `input_schema`, `required`,
`requires_user_confirm`, or `executor_hint`. The contract is "canonical" but enforced only by
hand-maintained tables (`ROUTES`, `CONFIRM_TOOLS`) that match today — latent drift risk.
**Repro:** agent flipped `requires_user_confirm` and dropped a `required` field in the remote
body; `checkToolRegistry` still returned `{ok:true}`.
**Fix:** compare full canonical objects in both directions; derive `ROUTES`/`CONFIRM_TOOLS`
from the imported contract instead of re-declaring them.

### 9. [LOW] `confidence` (declared internal) leaks via `/v1/packages/search` and `/resolve`
**Where:** `mpyhw-api/app/package_store.py:27` (`INTERNAL_FIELDS` includes `confidence`) vs
`:136` (`_hit` emits `confidence`). The conformance test only checks the
`/v1/packages/{name}/{version}` endpoint, so it misses search/resolve.
**Fix:** strip `confidence` from `_hit` (or remove it from `INTERNAL_FIELDS` if it's
intentionally part of the ranking output) and extend the conformance test to search/resolve.

### 10. [LOW] Continuation doesn't reset `state.files`
**Where:** `agent-backed-loop.ts:160-169` resets the loop-control counters but not
`state.files`. A follow-up build that regenerates only some files re-deploys stale `lib/`
files from the previous build (write_main_py iterates all of `state.files`). (`planConfirmed`
not resetting is arguably intended — "plan gate once per session".)
**Fix:** clear/scope `state.files` per build.

### 11. [LOW] `credit_store.reset()` fails on Windows if a connection is open
**Where:** `mpyhw-api/app/credit_store.py:141` (`os.remove`). Incidental: hit `WinError 32`
(file in use) in my own harness when a connection was still open. Test-hook only.
**Fix:** close connections / ignore `PermissionError`, or truncate the table instead of
deleting the file.

---

## Honest negatives (checked, reproduced as NOT broken)
- `reserve()/debit()/refund()` are concurrency-safe (atomic UPDATE with `balance >=` guard); no lost updates or overdraft under 20 concurrent reservers.
- No command injection in the shim — all subprocess calls use list-argv, no `shell=True`.
- `max_turns` guard is exact (20 calls, no off-by-one).
- Credit refund-on-upstream-error path is correct; metering arithmetic (reserve+debit/refund) nets to the right charge for the in-budget case.

## Reproduction artifacts (delete when done)
- `mpy-hardware-extension/_review_repro.ts` — run: `node --no-warnings --experimental-strip-types _review_repro.ts`
- `mpyhw-api/_review_repro.py` — run: `python _review_repro.py`
- `mpyhw-api/_review_repro_credits.py` — run: `python _review_repro_credits.py`
