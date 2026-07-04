# Plugin Production-Readiness (Marketplace Update) Design — 2026-07-03

## Goal

Bring the plugin stack (`mpy-hardware-extension` + `mpyhw-api` + original upstream `MicroPython_Skills`) to VS Code Marketplace publish-ready quality (v0.3.12 is already listed; this is a quality-gated update release). The golden path (one sentence → analyze → select-hw → flash → scaffold → generate → deploy) is proven end-to-end up to the final real-board step; the physical USB test is performed by the user (we hand over a one-page acceptance checklist).

Two phases: **Phase B (tidy) first, then Phase A (ship) on a clean foundation.**

## Hard Constraints

1. `third_party/MicroPython_Skills` is the original upstream — **never edited** in this project. If a skill text change turns out to be required, report it to the user separately for the upstream flow.
2. The two website repos (new `blockless-api` / `website-blockless`) are untouched. The new stack's `content/chips/*.json` may be used as a read-only fact reference only.
3. Fail-fast is not relaxed: the uncommitted "report success even when quality gates can't run" diff must not land on main.
4. v1 assumes users can reach GitHub/the cloud (VPN-capable). All API endpoints go through configuration (`mpyhw.apiBaseUrl`) — no hardcoding — to keep a future Aliyun-hosted deployment a config change.
5. One commit per step; Phase B passes a Codex review before Phase A begins.

## Phase B — Tidy (no behavior change)

### B1 Working-tree cleanup
- New branch `experiment/browser-host-capabilities`: commit the uncommitted fail-fast-weakening diff there (`main.py` CORS 8098 + `routes_llm.py` `_disabled_tool_names`/success exemption + the two uncommitted test files) to quarantine it. The commit message records why it is quarantined (violates fail-fast; targets a browser host, not the plugin; never reviewed). main returns to clean.
- Triage the remaining uncommitted files (`.pylintrc`, HANDOFF docs, etc.): commit what belongs, archive the rest. End the "frozen mid-review" state.
- Gate: `git status` clean; backend tests all green.

### B2 Delete dead code
- `agent-backed-loop.ts` (932 lines, legacy 27-tool loop): move `DEV_API_BASE_URL` to a new `src/core/config.ts`, update the `panel.ts` import, delete the file plus the tool-registry/canonical_tools parts referenced only by it.
- `src/core/skill-catalog.ts` (calls the removed `/v1/phase-profiles`, gets 404): delete. Its consumers `run-live-gen.ts` / `run-golden-path.ts`: check whether package.json scripts still reference them; delete if unused, otherwise port to the V0 protocol path.
- Template loop (`pipeline.ts` + `MPYHW_LOOP=template`): after confirming nothing but the env switch reaches it, delete; `createLoop` collapses to a single path.
- Gate: `npm run typecheck` + `npm test` green; the esbuild bundle no longer contains agent-backed-loop; `e2e:v0` (shim) passes.

### B3 Single source of truth for phase aliases
- `contracts/protocol_messages.json` becomes the only source: add a consistency test on each side (TS `PHASE_ALIASES`, Python `PHASE_BY_SKILL`) that compares entry-by-entry against the contract. No runtime restructuring — smallest possible change.
- Gate: changing one alias on either side turns both tests red.

### B4 Coarse split of routes_llm.py (1115 lines → ~3 modules)
- Extract: `billing_breaker.py` (credit metering + circuit breaker), `prompt_assembly.py` (SLIM_V0_ADAPTER + skill injection + phase notes + board/driver grounding), `sse_translate.py` (DeepSeek SSE → protocol-stream translation). `routes_llm.py` keeps only routing and orchestration.
- Rule: pure move — function bodies unchanged; the old module re-exports public symbols so tests and external references keep working.
- Piggybacked corrections: `llm_sessions.py` `DEFAULT_USER_LIMIT=2` has a stale rationale (nested codegen no longer exists) → re-evaluate the value and update the comment; fix the incorrect "llm_sessions is in-process" comment in `render.yaml`.
- Gate: the full backend test suite passes **unmodified** (strongest evidence of a correct move); `git diff` on the old file shows only deletions and re-exports.

### B5 Minimal webview split
- Split `index.html` (2,012 lines) into `index.html` + `webview.css` + `webview.js`, byte-for-byte moves; `panel.ts` loading logic assembles/inlines the three. No componentization, no logic changes.
- Gate: `webview-dom.test.ts` / `webview-panel.test.ts` green; one manual open of the panel shows no visual difference.

### B6 Deployment hygiene
- Fact: the live services do **not** collide — plugin backend = `blockless-api.onrender.com` (Postgres `blockless-db`), new product = `blockless-web-api.onrender.com` (`blockless-web-db`). The collision is only repo/naming-level confusion.
- Therefore B6 narrows to hygiene: fix the stale comment in `render.yaml`; remove new-product domain leftovers from the CORS origin list (keep any still needed for the login redirect); the Render service name stays **unchanged by default** (renaming would ripple into the cloud-test/publish-extension skills and the published extension's default apiBaseUrl — user's call if ever).
- Confirm the extension reads the API base exclusively from the `mpyhw.apiBaseUrl` setting, no hardcoding.
- Repo files only — **no live-service changes**; the user decides when/if to touch production.

## Phase A — Ship

### A1 Pin the toolchain
- Pin exact versions for `esptool`, `mpremote`, `pyserial`, `flake8`, `pylint`, `jsonschema`, `pypdf` (lock to the currently passing versions); the device-shim venv install command carries versions. The 16 quality gates stop drifting with upstream lint releases.
- Gate: a from-scratch venv install → the 16 gates produce identical results on a baseline project as before pinning.

### A2 Board catalog expansion (3 → ~12–15 full profiles)
- Draft list (user may add/remove): ESP32-WROOM DevKitC, ESP32-S2, ESP32-S3 (existing), ESP32-C3 (existing), ESP32-C6, Pico, Pico W (existing), Pico 2, Pico 2 W + 2–3 China-market favorites (LuatOS/合宙 ESP32-C3 core board, Waveshare Pico series).
- Profiles hand-written to the existing 3-board JSON schema: pin layout, official firmware slug, flash method (esptool/UF2), USB-serial chip hints. The new stack's chip-fact tables are a read-only cross-check for pins.
- Keep the two-tier semantics: full profile = `builtin_pin_layout`; every other official board = `official_firmware_only`, and selecting one states the capability limits explicitly. Fix the `_resolve_board` silent `{board_id}` stub fallback (replace with explicit `official_firmware_only` semantics or a loud error).
- Gate: every new board passes one select-hw shim run with a legal pin allocation; profile data passes a Codex review.

### A3 Fix the carried-over bugs
- Generate finalization flake, structural fix: the three prompt-note-papered failure modes (subprocess import tripping `mpy_imports`; `generate_plan.json` allowlist; turn-0 "empty project" hallucination) move to validator-side guards — widen the allowlist to the confirmed-safe set; detect and reject the turn-0 empty-project case with a retry of that turn, instead of pleading with the model.
- Approval-card gray-screen race: write a shim-mode reproduction script (rapid double-click on "modify device list"); if it reproduces → fix the webview message ordering; if not → add a state-machine guard at the message dispatch plus telemetry logging, and chase it with live data after release.
- `terminal=awaiting_user` semantics split: genuine user-wait vs protocol stall get distinct UI (stall shows "build is stuck" + a retry button) — the most common novice death point.
- Gate: e2e:v0 golden path 5 consecutive runs without a flake; the gray-screen repro script (if it reproduces) turns green.

### A4 Light usage metering (explicitly not rigorous)
- Per-user daily credit cap (env-tunable); over-cap returns a clear error card.
- Read-only `/v1/admin/usage` endpoint (reusing the existing admin-token pattern), per-day/per-user token totals + cost estimate; the DeepSeek cache-hit-rate assumption is documented next to the constant.
- No dashboard, no alerting.
- Gate: an over-cap user is rejected with a clear message; usage numbers reconcile with `llm_turns` records.

### A5 Packaging & marketplace material
- The publish machinery already exists (`.claude/skills/publish-extension`: publisher=blockless, Marketplace ID `blockless.mpy-hardware-extension`, GitHub Actions v* tag + VSCE_PAT). This project **verifies and reuses** it — no rebuilding; preflight (health probe / typecheck / tests / package) runs through that skill's check mode.
- Verify the `prepare-vsce` chain: the VSIX contains only the 6 `-plugin` skills + shared scripts (the submodule guard test stays); install into a clean VS Code and confirm activation.
- Marketplace minimum set: README (honest prerequisites: Python 3.10+, USB-serial driver, supported-board list, network that can reach GitHub), icon, categories, CHANGELOG. Fill the two 〔待填〕 holes in the novice guide: network → "requires a network that can reach GitHub"; feedback channel → GitHub Issues.
- The actual publish action (publisher token) is executed by the user; everything is prepared here.
- Gate: `vsce package` clean; a clean Windows environment installs the VSIX → the Doctor's 4-item checkup runs.

### A6 Golden-path self-verification
- Local stack + extension loading reuses `.claude/skills/dev-up` (Postgres + mpyhw-api:8787 + extension); shim-mode end-to-end: idea → all 6 phases green → project produced.
- Code-shape assertion script (lands in the repo as a regression test): `firmware/` tree structure, scheduler API usage (`add_task`, `register` forbidden), all imports within the MicroPython whitelist, all 16 quality gates pass, manifest consistent with files.
- Coverage: 3 idea categories (sensor / display / actuator) × 5 consecutive runs, all green.
- Deliver the user a one-page real-board acceptance checklist: board model, command sequence, expected observation at each step, what to send back on failure.

## Explicitly Out of Scope (this release)

- Webview componentization rewrite; multi-LLM-provider abstraction (the DeepSeek model name is merely consolidated into a single constant); course-content realignment (marketplace material does not reference the course); alerting/monitoring dashboards; the actual Aliyun deployment (only configurability/portability is guaranteed).

## Known Issues Shipped As-Is

- If the approval-card race does not reproduce, it ships in guarded+logged state.
- The final real-board end-to-end is the user's acceptance step; everything before it is verified via shim + code-shape assertions.
