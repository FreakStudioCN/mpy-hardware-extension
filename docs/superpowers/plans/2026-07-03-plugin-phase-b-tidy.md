# Plugin Phase B (Tidy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean the plugin monorepo (working tree, dead code, dual truth sources, god-module, monolith webview, deployment hygiene) with **zero behavior change**, so Phase A (ship) starts from a trustworthy foundation.

**Architecture:** All tasks are tidy operations: quarantine-by-branch, delete-with-gates, contract-consistency tests, pure-move module extraction (routes_llm.py stays the monkeypatch namespace of record; moved code reaches patched siblings via one lazy indirection), byte-preserving webview file split. Spec: `docs/superpowers/specs/2026-07-03-plugin-production-ready-design.md`.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`, `node --test`), FastAPI + pytest (Postgres required by conftest), esbuild, vsce.

## Global Constraints

- Repo root: `c:\Users\Haipeng Wu\Desktop\blockless\cursor_for_hardware` (single git repo containing `mpy-hardware-extension/` and `mpyhw-api/`). Commit here. Do NOT push.
- `third_party/MicroPython_Skills` is upstream — never edit.
- Zero behavior change in every task. If a step forces a behavior choice, stop and report instead of choosing.
- Extension gates (cwd `mpy-hardware-extension`): `npm test`, `npm run typecheck`. Backend gates (cwd `mpyhw-api`): `python -m pytest tests -q` — conftest REQUIRES Postgres: ensure Docker container `mpyhw-pg` is running (`docker start mpyhw-pg`, or `scripts/dev-up.ps1` per `.claude/skills/dev-up`) and `$env:MPYHW_TEST_DATABASE_URL` is set to the `DATABASE_URL` value in `mpyhw-api/.env` (read it from the file; NEVER print the value).
- Backend tests must pass **unmodified** in Tasks 4+ (strongest pure-move evidence).
- The two website repos (`blockless-api`, `website-blockless`) are untouched.
- Line numbers below refer to the CLEAN tree (after Task 1). Verify each anchor with a grep before editing; if an anchor moved, locate by symbol name.

---

### Task 1: Quarantine the uncommitted diff + triage the working tree

**Files:**
- Branch (quarantine): `mpyhw-api/app/main.py`, `mpyhw-api/app/routes_llm.py`, `mpyhw-api/tests/test_browser_host_capabilities.py`, `mpyhw-api/tests/test_browser_oauth_routes.py`
- Commit to main (untracked project material): `.agents/skills/`, `.claude/skills/diagnose-cloud-session/`, `.claude/skills/security-review/`, `HANDOFF-ISSUE3-FIXES.md`, `HANDOFF-V0-MIGRATION.md`, `MISSION.md`, `NOTES.md`, `RESOURCES.md`, `apply.md`, `docs/pitch/deck/`, `docs/plugin-architecture-and-skill-acceptance.md`, `docs/research/`, `docs/specs/2026-06-21-web-recommend-fail-fast.md`, `lessons/`, `mpyhw-api/.pylintrc`
- Modify: `.gitignore` (repo root)
- Delete: `mpyhw-api/bash.exe.stackdump`

**Interfaces:**
- Consumes: the current dirty working tree (4 modified tracked files + ~20 untracked paths).
- Produces: clean `git status` on main; branch `experiment/browser-host-capabilities` holding the fail-fast-weakening diff. Every later task assumes this clean state.

- [ ] **Step 1: Quarantine the modified tracked files on a branch**

```bash
cd "c:/Users/Haipeng Wu/Desktop/blockless/cursor_for_hardware"
git checkout -b experiment/browser-host-capabilities
git add mpyhw-api/app/main.py mpyhw-api/app/routes_llm.py mpyhw-api/tests/test_browser_host_capabilities.py mpyhw-api/tests/test_browser_oauth_routes.py
git commit -m "experiment(quarantined): browser-host script_run:false success exemption + CORS 8098

Quarantined, NOT for main: instructs the model to report phase_complete
result=success when quality gates cannot run (script_run:false), which
violates the fail-fast product rule; targets a browser host, not the
plugin; never reviewed. Kept for reference only.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git checkout main
```

- [ ] **Step 2: Verify main is clean of the diff**

Run: `git status --short -- mpyhw-api/app mpyhw-api/tests`
Expected: no `M` entries (only untracked `??` lines remain overall).

- [ ] **Step 3: Delete junk and extend .gitignore**

Delete `mpyhw-api/bash.exe.stackdump`. Append to the repo-root `.gitignore` (create the file if it does not exist):

```gitignore
# Personal / bulk material kept out of the repo (Phase B triage 2026-07-03)
Uber.pdf
uber_pages/
blockless-plugin-course.zip
reference/
*.stackdump
```

- [ ] **Step 4: Commit the project material**

```bash
git add .gitignore .agents/skills .claude/skills/diagnose-cloud-session .claude/skills/security-review HANDOFF-ISSUE3-FIXES.md HANDOFF-V0-MIGRATION.md MISSION.md NOTES.md RESOURCES.md apply.md docs/pitch/deck docs/plugin-architecture-and-skill-acceptance.md docs/research docs/specs/2026-06-21-web-recommend-fail-fast.md lessons mpyhw-api/.pylintrc
git commit -m "chore: land handoffs, project skills, docs, pitch material; ignore personal/bulk files

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Verify clean tree and green backend**

Run: `git status --short` → expected: empty.
Run (cwd `mpyhw-api`, Postgres up, env set per Global Constraints): `python -m pytest tests -q`
Expected: all pass (the two browser-host test files are back at their committed state).

---

### Task 2: Delete dead code (legacy agent loop, skill catalog client, broken dev CLIs)

**Files:**
- Create: `mpy-hardware-extension/src/core/config.ts`
- Delete: `mpy-hardware-extension/src/core/agent-backed-loop.ts`, `mpy-hardware-extension/src/core/skill-catalog.ts`, `mpy-hardware-extension/src/cli/run-live-gen.ts`, `mpy-hardware-extension/src/cli/run-golden-path.ts`
- Modify: `mpy-hardware-extension/src/webview/panel.ts:12` (import), `mpy-hardware-extension/package.json` (drop `golden`, `live-gen` scripts)
- Possibly delete: tests that exist ONLY for the deleted modules (see Step 3)

**Interfaces:**
- Consumes: `panel.ts` imports `DEV_API_BASE_URL` from `agent-backed-loop.ts:293`.
- Produces: `src/core/config.ts` exporting `export const DEV_API_BASE_URL = "http://127.0.0.1:8787";` — the only surviving symbol. `pipeline.ts` is **kept** (deviation from the spec's conditional delete: `webview-panel.test.ts` uses `loopMode:"template"` as its offline double, so the template loop has a real consumer).

- [ ] **Step 1: Create the config module**

```ts
// mpy-hardware-extension/src/core/config.ts
// Default local dev API base (mpyhw-api via scripts/dev-up.ps1). The runtime
// value always comes from resolveApiBaseUrl (the mpyhw.apiBaseUrl setting);
// this constant is only the last-resort fallback for dev/test wiring.
export const DEV_API_BASE_URL = "http://127.0.0.1:8787";
```

- [ ] **Step 2: Repoint the import in panel.ts**

Change line 12:
```ts
import { DEV_API_BASE_URL } from "../core/agent-backed-loop.ts";
```
to:
```ts
import { DEV_API_BASE_URL } from "../core/config.ts";
```

- [ ] **Step 3: Find every other reference before deleting**

Run: `grep -rn "agent-backed-loop\|skill-catalog\|run-live-gen\|run-golden-path\|createAgentBackedLoop\|SkillCatalog" src/ test/ scripts/ package.json` (cwd `mpy-hardware-extension`)

For each hit: references inside the four files being deleted are fine; references in `test/*.test.ts` mean that test file exists only to cover deleted code — delete that test file too (list each deletion in the commit message); a reference anywhere else (a live module) means STOP — report it instead of deleting.

- [ ] **Step 4: Delete the four files + the two package.json scripts**

Remove `"golden"` and `"live-gen"` entries from `scripts` in `package.json`. Delete the four source files (and only-covering test files found in Step 3).

- [ ] **Step 5: Verify gates**

Run (cwd `mpy-hardware-extension`): `npm run typecheck` then `npm test`
Expected: both green. Then `npm run build` and confirm the esbuild output no longer contains the string `createAgentBackedLoop`:
`grep -c "createAgentBackedLoop" dist/extension/activate.cjs` → expected `0` (grep exits 1).

- [ ] **Step 6: Commit**

```bash
git add -A mpy-hardware-extension
git commit -m "chore(extension): delete legacy agent loop, dead skill-catalog client, broken dev CLIs

agent-backed-loop.ts (932 lines, superseded by protocol-loop) was bundled
into the VSIX solely for a constant; skill-catalog.ts calls the removed
/v1/phase-profiles endpoint (404 in prod); run-live-gen/run-golden-path
only drove the deleted loop. pipeline.ts is KEPT: webview-panel tests use
loopMode:'template' as their offline double.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Phase-alias single source of truth (shared fixture + consistency tests both sides)

**Files:**
- Create: `contracts/phase_aliases.json`
- Modify: `mpy-hardware-extension/src/core/protocol-loop.ts` (export the alias table — one line)
- Test: `mpy-hardware-extension/test/phase-aliases-contract.test.ts` (new), `mpyhw-api/tests/test_phase_aliases_contract.py` (new)

**Interfaces:**
- Consumes: TS `PHASE_ALIASES` (`protocol-loop.ts:20-38`, currently module-private) and `PHASE_ORDER` (`protocol-loop.ts:7`, exported); Python `PHASE_BY_SKILL` + `SERVED_SKILLS` (`mpyhw-api/app/skill_catalog.py:24-40`).
- Produces: `contracts/phase_aliases.json` with shape `{"canonical_phases": string[], "aliases": {alias: canonical}}` — both tests compare against it entry-by-entry. No runtime code reads it (tests only), so behavior is unchanged.

- [ ] **Step 1: Write the shared fixture** (copied verbatim from `protocol-loop.ts:20-38` — this IS the current truth)

```json
{
  "$comment": "Single source of truth for phase tokens. protocol-loop.ts PHASE_ALIASES and skill_catalog.py PHASE_BY_SKILL are each contract-tested against this file. Upstream is inconsistent on purpose: analyze/select-hw use short names, the rest full -plugin dir names.",
  "canonical_phases": ["analyze", "select-hw", "upy-flash-mpy-firmware-plugin", "upy-scaffold-plugin", "upy-generate-plugin", "upy-deploy-plugin"],
  "aliases": {
    "analyze": "analyze",
    "upy-analyze-plugin": "analyze",
    "select-hw": "select-hw",
    "upy-select-hw": "select-hw",
    "upy-select-hw-plugin": "select-hw",
    "flash-mpy-firmware": "upy-flash-mpy-firmware-plugin",
    "upy-flash-mpy-firmware": "upy-flash-mpy-firmware-plugin",
    "upy-flash-mpy-firmware-plugin": "upy-flash-mpy-firmware-plugin",
    "scaffold": "upy-scaffold-plugin",
    "upy-scaffold": "upy-scaffold-plugin",
    "upy-scaffold-plugin": "upy-scaffold-plugin",
    "generate": "upy-generate-plugin",
    "upy-generate": "upy-generate-plugin",
    "upy-generate-plugin": "upy-generate-plugin",
    "deploy": "upy-deploy-plugin",
    "upy-deploy": "upy-deploy-plugin",
    "upy-deploy-plugin": "upy-deploy-plugin"
  }
}
```

- [ ] **Step 2: Export the TS table.** In `protocol-loop.ts:20`, change `const PHASE_ALIASES` to `export const PHASE_ALIASES` (no other change).

- [ ] **Step 3: Write the TS consistency test**

```ts
// mpy-hardware-extension/test/phase-aliases-contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PHASE_ALIASES, PHASE_ORDER } from "../src/core/protocol-loop.ts";

const contract = JSON.parse(readFileSync(new URL("../../contracts/phase_aliases.json", import.meta.url), "utf-8"));

test("PHASE_ALIASES matches contracts/phase_aliases.json exactly", () => {
  assert.deepEqual({ ...PHASE_ALIASES }, contract.aliases);
});

test("PHASE_ORDER matches the contract's canonical phases exactly", () => {
  assert.deepEqual([...PHASE_ORDER], contract.canonical_phases);
});
```

- [ ] **Step 4: Run the TS test to verify it passes** (this is a consistency test — it must pass immediately because the fixture was copied from the code)

Run (cwd `mpy-hardware-extension`): `node --no-warnings --experimental-strip-types --test test/phase-aliases-contract.test.ts`
Expected: 2 pass. Sanity-check the trap: temporarily change one alias value in the JSON, rerun, expect FAIL; revert.

- [ ] **Step 5: Write the Python consistency test**

```python
# mpyhw-api/tests/test_phase_aliases_contract.py
"""skill_catalog's phase mapping must agree with contracts/phase_aliases.json.

The contract file is the single source of truth shared with the extension
(test/phase-aliases-contract.test.ts). The Python side serves each canonical
phase from exactly one skill; every canonical phase must be an alias key that
maps to itself, and PHASE_BY_SKILL's values must be exactly the canonical set.
"""
import json
from pathlib import Path

from app import skill_catalog

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "phase_aliases.json").read_text(encoding="utf-8")
)


def test_phase_by_skill_values_are_exactly_the_canonical_phases():
    assert sorted(skill_catalog.PHASE_BY_SKILL.values()) == sorted(CONTRACT["canonical_phases"])


def test_every_served_skill_dir_is_a_known_alias_of_its_phase():
    for skill, phase in skill_catalog.PHASE_BY_SKILL.items():
        assert CONTRACT["aliases"].get(skill) == phase, f"{skill} missing/mismatched in contract aliases"


def test_canonical_phases_map_to_themselves_in_aliases():
    for phase in CONTRACT["canonical_phases"]:
        assert CONTRACT["aliases"].get(phase) == phase
```

- [ ] **Step 6: Run the Python test** (cwd `mpyhw-api`, Postgres up): `python -m pytest tests/test_phase_aliases_contract.py -q`
Expected: 3 pass. Same trap check as Step 4 (mutate JSON → both suites fail → revert).

- [ ] **Step 7: Commit**

```bash
git add contracts/phase_aliases.json mpy-hardware-extension/src/core/protocol-loop.ts mpy-hardware-extension/test/phase-aliases-contract.test.ts mpyhw-api/tests/test_phase_aliases_contract.py
git commit -m "test: contract-lock phase aliases to a single shared fixture (TS + Python)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Coarse split of routes_llm.py (pure move, tests unmodified)

**Files:**
- Create: `mpyhw-api/app/prompt_assembly.py`, `mpyhw-api/app/sse_translate.py`
- Modify: `mpyhw-api/app/routes_llm.py` (delete moved bodies; import the names back), `mpyhw-api/app/llm_sessions.py:9-13` (comment only), `render.yaml:12-16` (comment only)

**Interfaces:**
- Consumes: the symbol inventory of `routes_llm.py` (line anchors: `grep -n "^def \|^async def \|^class " app/routes_llm.py`).
- Produces: `routes_llm` still exposes EVERY moved name in its module namespace (tests monkeypatch `routes_llm.<name>`; `web_recommend.py` imports `_call_deepseek_plain` from it). New modules:
  - `prompt_assembly.py`: `_v0_phase_note`, `_system_prompt`, `SLIM_V0_ADAPTER`, `_V0_PHASE_NOTES_DIR`, `_first_user_text`, `_language_directive`, `_phase`, `_phase_data_injection`, `_CONTEXT_BOARD_ID_RE`, `_clip_context_value`, `_safe_context_token`, `_safe_micropython_download_url`, `_sanitized_preselected_board`, `_context_injection`, `_host_capabilities_note`, `_deepseek_messages`, `_pair_tool_messages`, `_translate_blocks`, `_tool_result_content`, `_BOARDS_DIR`, `_load_board_profile`, `_raw_board_id_candidates`, `_candidate_board_ids`, `_official_only_board_profile`, `_resolve_board`, `_resolve_driver_contexts`.
  - `sse_translate.py`: `_sse`, `_stub_sse`, `UpstreamError`, `DeepSeekProvider`, `get_llm_provider`, `_deepseek_payload`, `_open_deepseek_stream`, `_translate_deepseek_stream`, `_deepseek_tools`, `_noncanonical_tools`, `_PAYLOAD_VALIDATORS`, `_payload_violation`, `_call_deepseek_plain`.
  - STAYS in `routes_llm.py`: `router`, `llm_messages`, `_CircuitBreaker`, `_deepseek_breaker`, `_is_outage_status`, `_daily_global_budget`, `_billable_tokens`, `_release_after` (tests patch `routes_llm.time`, which the breaker uses — moving it would dodge the patch).

**The one pattern that keeps tests unmodified:** tests monkeypatch attributes ON `routes_llm`. A moved function that internally calls a patched sibling must resolve that sibling through `routes_llm` at call time, or the patch is dodged. Add to the TOP of BOTH new modules:

```python
def _R():
    """routes_llm is the monkeypatch namespace of record (tests patch
    routes_llm.<name>). Moved code resolves patched siblings through it at
    call time so those patches keep working. Lazy import avoids the cycle
    (routes_llm imports this module at load)."""
    from app import routes_llm
    return routes_llm
```

and rewrite EXACTLY these call sites in the moved bodies (callee is in the monkeypatched set):

| moved function | call site rewrite |
|---|---|
| `_open_deepseek_stream` | `_deepseek_payload(body)` → `_R()._deepseek_payload(body)` |
| `_deepseek_payload` | `_deepseek_messages(body)` → `_R()._deepseek_messages(body)`; `_deepseek_tools(body.get("tools", []))` → `_R()._deepseek_tools(...)` |
| `_translate_deepseek_stream` | `_payload_violation(entry["name"], arguments)` → `_R()._payload_violation(...)` |
| `DeepSeekProvider.open` | `_open_deepseek_stream(...)` → `_R()._open_deepseek_stream(...)`; `_translate_deepseek_stream(upstream, meter)` → `_R()._translate_deepseek_stream(...)` |
| `_deepseek_messages` | `_phase(body)` → `_R()._phase(body)`; `_system_prompt(phase)` → `_R()._system_prompt(phase)`; `_phase_data_injection(body)` → `_R()._phase_data_injection(body)`; `_host_capabilities_note(...)` → `_R()._host_capabilities_note(...)` |
| `_system_prompt` | `_v0_phase_note(skill_name)` → `_R()._v0_phase_note(skill_name)` |
| `_phase_data_injection` | `_resolve_board(manifest, body)` → `_R()._resolve_board(...)` |

All OTHER internal calls (to unpatched helpers like `_context_injection`, `_language_directive`, `_clip_context_value`, `_resolve_driver_contexts`, `_pair_tool_messages`, `_translate_blocks`, `_tool_result_content`, `_sse`) stay direct within the new module.

- [ ] **Step 1: Record the baseline.** Run (cwd `mpyhw-api`): `python -m pytest tests -q` → note the exact pass count. This count must be identical at the end.

- [ ] **Step 2: Create `prompt_assembly.py`.** Move the listed symbols verbatim (bodies unchanged except the table above), plus the imports each body needs (`json`, `os`, `re`, `functools`, `Path`, `Any`, `Iterable`, `skill_catalog`, `logging` — copy from `routes_llm.py`'s import block, keep only what the moved code uses). Module docstring: `"""Prompt assembly for /v1/llm/messages: system prompt (adapter + verbatim SKILL.md + phase note), context/manifest injection, board/driver grounding, and Claude-blocks -> DeepSeek-messages translation. Pure move out of routes_llm.py (Phase B tidy); routes_llm remains the monkeypatch namespace of record."""`. Include the `_R()` helper.

- [ ] **Step 3: Create `sse_translate.py`.** Same procedure for its symbol list. Module docstring: `"""DeepSeek provider + SSE stream translation for /v1/llm/messages, plus the plain (non-agent) completion helper used by web_recommend. Pure move out of routes_llm.py (Phase B tidy)."""`. Include the `_R()` helper.

- [ ] **Step 4: Rewire `routes_llm.py`.** Delete the moved bodies. Add after the existing imports (names imported INTO the namespace so tests and `web_recommend` keep working — do not use qualified access at the surviving call sites):

```python
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
```

Remove imports from `routes_llm.py`'s header that no longer have any user in the remaining code (check each with grep before removing).

- [ ] **Step 5: Fix the two stale comments (comment-only, values unchanged).**

`llm_sessions.py:9-13` — replace the comment above `DEFAULT_USER_LIMIT = 2` with:
```python
# Historical note: this was 2 because the generate_code tool used to open a
# nested /v1/llm/messages stream (removed in the V0 rearchitecture — the
# server no longer runs nested codegen). Kept at 2 as headroom for a client
# retry/reconnect racing its own dying stream; revisit when there is live
# usage data. Cost stays bounded per turn by credits either way.
DEFAULT_USER_LIMIT = 2
```

`render.yaml:12-16` — replace the WEB_CONCURRENCY comment with:
```yaml
      # Load-bearing: the DeepSeek circuit breaker (_deepseek_breaker) is
      # in-process state, so more than one worker would give each its own
      # breaker. (llm_sessions is DB-backed with advisory locks and would
      # scale; the breaker would not.) Scaling out requires moving the
      # breaker to the DB.
```

- [ ] **Step 6: Verify the pure move.**

Run (cwd `mpyhw-api`): `python -m pytest tests -q`
Expected: EXACTLY the Step 1 pass count, zero test-file modifications (`git status --short mpyhw-api/tests` → empty).
Also: `python -c "from app import web_recommend"` → no import error.

- [ ] **Step 7: Commit**

```bash
git add mpyhw-api/app/routes_llm.py mpyhw-api/app/prompt_assembly.py mpyhw-api/app/sse_translate.py mpyhw-api/app/llm_sessions.py render.yaml
git commit -m "refactor(api): extract prompt_assembly + sse_translate from routes_llm (pure move)

routes_llm stays the monkeypatch namespace of record; moved code resolves
patched siblings through it (see _R()). Breaker/billing stay in routes_llm
(tests patch routes_llm.time). Tests pass unmodified. Also corrects the
stale llm_sessions DEFAULT_USER_LIMIT rationale and the render.yaml
WEB_CONCURRENCY comment (llm_sessions is DB-backed; the breaker is not).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Webview minimal file split (byte-preserving)

**Files:**
- Modify: `mpy-hardware-extension/src/webview/index.html` (2,012 lines → skeleton with markers)
- Create: `mpy-hardware-extension/src/webview/webview.css` (current lines 9–324, the `<style>` body), `mpy-hardware-extension/src/webview/webview.js` (current lines 424–2009, the `<script>` body)
- Modify: `mpy-hardware-extension/src/webview/panel.ts` `readWebviewHtml()` (currently reads one file), `.vscodeignore:8` (whitelist the two new files)

**Interfaces:**
- Consumes: `readWebviewHtml()` in `panel.ts` (dual-path resolution: `./index.html` from src, `../../src/webview/index.html` from dist).
- Produces: identical final HTML string delivered to the webview. Markers: `/*__WEBVIEW_CSS__*/` inside the `<style>` tag, `//__WEBVIEW_JS__` inside the `<script>` tag.

- [ ] **Step 1: Extract the CSS.** Cut the contents BETWEEN `<style>` (line 8) and `</style>` (line 325) — exclusive of the tags — into `src/webview/webview.css`, byte-for-byte. Replace the block in `index.html` so it reads:

```html
    <style>/*__WEBVIEW_CSS__*/</style>
```

- [ ] **Step 2: Extract the JS.** Same for the contents between `<script>` (line 423) and `</script>` (line 2010) into `src/webview/webview.js`. Replacement:

```html
    <script>//__WEBVIEW_JS__</script>
```

- [ ] **Step 3: Teach `readWebviewHtml()` to assemble.** Replace the function body in `panel.ts` (keep the same dual-candidate resolution — the three files sit in the same directory):

```ts
function readWebviewHtml(): string {
  // Dev/test runs this module directly (import.meta.url -> src/webview/), so
  // "./index.html" resolves. The bundled entry lives at dist/extension/, where
  // the packaged files sit at ../../src/webview/. Try both. The css/js live in
  // sibling files (Phase B split) and are inlined here so the webview still
  // receives a single self-contained HTML string.
  const candidates = ["./", "../../src/webview/"];
  for (const base of candidates) {
    try {
      const html = readFileSync(new URL(base + "index.html", import.meta.url), "utf-8");
      const css = readFileSync(new URL(base + "webview.css", import.meta.url), "utf-8");
      const js = readFileSync(new URL(base + "webview.js", import.meta.url), "utf-8");
      return html.replace("/*__WEBVIEW_CSS__*/", () => css).replace("//__WEBVIEW_JS__", () => js);
    } catch {
      // try next candidate
    }
  }
  throw new Error("webview_html_not_found");
}
```

(Note the `() => css` replacer form: the JS source contains `$`-sequences that `String.replace` would otherwise mangle.)

- [ ] **Step 4: Whitelist the new files for packaging.** In `.vscodeignore`, extend line 8:

```
!src/webview/index.html
!src/webview/webview.css
!src/webview/webview.js
```

- [ ] **Step 5: Verify byte-identity and gates.**

Write a throwaway check (scratchpad, not committed): import `readWebviewHtml` is not exported — instead verify via the test suite plus a direct node eval that reconstructs and compares against `git show HEAD:mpy-hardware-extension/src/webview/index.html`:

```bash
cd mpy-hardware-extension
node --no-warnings --experimental-strip-types -e "
const { readFileSync } = require('node:fs');
const { execSync } = require('node:child_process');
const old = execSync('git show HEAD:mpy-hardware-extension/src/webview/index.html', {cwd: '..', maxBuffer: 1<<24}).toString();
const html = readFileSync('src/webview/index.html','utf-8');
const css = readFileSync('src/webview/webview.css','utf-8');
const js = readFileSync('src/webview/webview.js','utf-8');
const merged = html.replace('/*__WEBVIEW_CSS__*/', () => css).replace('//__WEBVIEW_JS__', () => js);
if (merged !== old) { console.error('MISMATCH: first diff at index', [...merged].findIndex((c,i)=>c!==old[i])); process.exit(1); }
console.log('byte-identical OK');
"
```

Expected: `byte-identical OK`. Then `npm test` + `npm run typecheck` → green. Then `npm run package` and confirm the VSIX lists the two new files: `npx vsce ls | grep webview` → shows `index.html`, `webview.css`, `webview.js`.

- [ ] **Step 6: Manual look.** Launch the Extension Development Host (`.claude/skills/dev-up`, mode f5) once, open the Blockless panel, confirm it renders (styles applied, input box present). Screenshot for the record.

- [ ] **Step 7: Commit**

```bash
git add mpy-hardware-extension/src/webview mpy-hardware-extension/src/webview/panel.ts mpy-hardware-extension/.vscodeignore
git commit -m "refactor(webview): split index.html into html/css/js (byte-identical assembly)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Deployment hygiene (CORS residue + config audit)

**Files:**
- Investigate then modify: `mpyhw-api/app/main.py:29-38` (`_DEFAULT_CORS_ORIGINS`)
- Verify only: `mpy-hardware-extension/src/extension/api-base-url.ts` (no hardcoded prod URL outside it)

**Interfaces:**
- Consumes: `_DEFAULT_CORS_ORIGINS` = `[block-less.com, www.block-less.com, blockless.co, www.blockless.co, localhost:3000, 127.0.0.1:3000]` (after Task 1 removed the quarantined 8098 pair).
- Produces: a CORS list with an evidence-backed justification comment per origin; anything unjustifiable removed. NOTE: this task may be evidence-blocked — removal only with proof.

- [ ] **Step 1: Gather evidence per origin.** For each origin, search for who relies on it: `git log --oneline -S "blockless.co" -- mpyhw-api/app/main.py` and `grep -rn "blockless.co\|block-less.com" mpyhw-api/app mpyhw-api/tests docs/ HANDOFF*.md`. Known context: `MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS=https://block-less.com` (render.yaml) and commit `5fec3f1 "Add browser IDE auth routes"` — the browser-IDE auth flow may legitimately need its origins.

- [ ] **Step 2: Decide per origin, conservatively.** Rules: keep any origin the browser-IDE auth routes or handoffs justify; keep localhost:3000 (documented dev origin); REMOVE only an origin with zero references outside the CORS list itself. If every origin turns out justified, this step's output is the justification comment alone — that is a valid outcome, not a failure.

- [ ] **Step 3: Annotate.** Rewrite the block with one comment per line, e.g.:

```python
_DEFAULT_CORS_ORIGINS = [
    "https://block-less.com",      # browser-IDE auth redirect origin (render.yaml MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS)
    "https://www.block-less.com",  # www variant of the above
    "https://blockless.co",        # <keep/remove per Step 2 evidence — cite it here>
    "https://www.blockless.co",    # <same>
    "http://localhost:3000",       # local web dev
    "http://127.0.0.1:3000",       # local web dev
]
```

- [ ] **Step 4: Verify no hardcoded API base outside the resolver.**

Run (cwd `mpy-hardware-extension`): `grep -rn "onrender.com\|blockless-api" src/ | grep -v "api-base-url.ts"`
Expected: no hits in runtime code (hits in comments/docs are fine — list them in the report). If a runtime hit exists, repoint it through `resolveApiBaseUrl` (`src/extension/api-base-url.ts`).

- [ ] **Step 5: Gates + commit.** Backend: `python -m pytest tests -q` (cwd `mpyhw-api`) → baseline count. Extension: `npm test` → green.

```bash
git add mpyhw-api/app/main.py
git commit -m "chore(api): annotate CORS origins with evidence; drop unjustified residue (if any)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Phase B exit gate (full verification + Codex review)

**Files:** none created (report only)

**Interfaces:**
- Consumes: everything above.
- Produces: a green full-suite run + a Codex review of `git diff <pre-task-1>..HEAD`, findings fixed or explicitly deferred with reasons. This gate is required by the spec before any Phase A work.

- [ ] **Step 1: Full gates, both sides.** Extension (cwd `mpy-hardware-extension`): `npm test && npm run typecheck && npm run package`. Backend (cwd `mpyhw-api`, Postgres up): `python -m pytest tests -q`. Expected: all green; pytest count = Task 4 baseline + 3 (the new phase-alias tests).

- [ ] **Step 2: Shim e2e.** Run (cwd `mpy-hardware-extension`): `npm run e2e:v0` with its documented env (see `src/cli/e2e-protocol-v0.ts` header; use the LLM stub `MPYHW_LLM_STUB=1` backend from dev-up if the CLI targets a local API). Expected: exit 0. If the e2e requires a real DEEPSEEK key and the user's key is unavailable, record that this gate ran stubbed.

- [ ] **Step 3: Codex review.** Use the codex rescue skill to review the full Phase B diff (`git diff` from the pre-Task-1 commit to HEAD) with the prompt: "Review this tidy-phase diff for: accidental behavior changes (it claims zero), monkeypatch-dodging in the routes_llm split, webview byte-identity holes, deleted code that something still referenced." Fix CONFIRMED findings (each fix = its own commit, re-run the relevant gate); log disputed/deferred findings in the report.

- [ ] **Step 4: Report.** Summarize to the user: commits made, gates run with results, Codex findings + dispositions, and the note that Phase A planning starts next (against the post-B code).

---

## Self-Review Notes

- **Spec coverage:** B1→Task 1, B2→Task 2 (with the documented pipeline.ts deviation — its conditional delete failed because webview-panel tests consume the template loop), B3→Task 3, B4→Task 4 (2 modules not 3: breaker/billing must stay in routes_llm because tests patch `routes_llm.time` — coarser, which the user explicitly allowed), B5→Task 5, B6→Task 6 (render.yaml comment moved into Task 4 where the file is already touched; service name unchanged per spec default). Codex gate→Task 7.
- **Placeholder scan:** none; every step has exact code/commands. Task 6 is intentionally evidence-driven with a defined conservative rule, not a placeholder.
- **Type consistency:** `DEV_API_BASE_URL` (Task 2) matches its one consumer `panel.ts`; `PHASE_ALIASES` export name (Task 3) matches the TS test import; the Task 4 re-export list matches the monkeypatched-symbol inventory from `grep -o "routes_llm\.[A-Za-z_]*" tests/*.py | sort -u`.
- **Known risk, called out:** Task 4's `_R()` indirection is the one deliberate deviation from "function bodies unchanged" — 11 call-site rewrites, each listed in the table, all resolving through the patch namespace. Behavior is identical when nothing is patched.
