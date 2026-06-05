# HANDOFF — Phase B complete (Blockless on upstream MicroPython_Skills)

> Phase A (adopt the upstream *contract*) and Phase B (grow into the upstream
> *engine*) are both landed on `main` and verified PC-side. Full plan of record:
> `~/.claude/plans/be-ready-to-finish-glowing-rain.md` (Phase A's was
> `~/.claude/plans/abstract-sleeping-adleman.md`). The user wants work committed
> directly to `main` — NO branches.

## What shipped (Phase B, commits `0c358bd`..`5e34eca`, all on `main`)

The agent now grows a one-sentence request into the upstream phased
project-manifest + firmware/ tree, runs the upstream toolchain host-side via the
shim, and renders wiring/diagram in the webview.

| step | what | key files |
|---|---|---|
| B1 | `write_project_file` tool — agent writes the project tree in-loop. `allowProjectTree` allowlist (project-manifest.json/wiring.json/diagram.json + firmware//test/ `.py` + docs/ `.json`) | `workspace-writer.ts`, `agent-backed-loop.ts`, `panel.ts` |
| B3 | shim runs upstream scripts: `run_validate`/`run_scaffold`/`run_download_drivers`. `serve.py scripts_root()` resolves the submodule at dev (`../../../third_party`) and packaged (`../../third_party`). `ensureVenv` installs from `requirements.txt`. Packager bundles upstream scripts/schemas/templates into the VSIX. | `python/shim/serve.py`, `device-shim.ts`, `scripts/package-extension.mjs` |
| B2 | **core rebuild, additive dual-shape** (branch on `schema_version`; legacy thin path stays green): `propose_manifest` → upstream rich manifest (phase/requirements/devices[]/mcu/pinout[]); `state.phase`+`manifest`; termination `complete`; `wiring-derive.ts` derives `{buses,standalone}` from devices+pinout (**one device = one card → phantom bug gone by construction**); system prompt describes the phase flow | `manifest-schema.ts`, `agent-backed-loop.ts`, `wiring-derive.ts`, `session-state.ts`, `termination.ts`, `mpyhw-api/app/routes_llm.py`, `contracts/canonical_tools.json` |
| B4 | verify track: `run_static_check` (flake8 gate + pylint advisory), `run_simulate` (pytest test/pc). audit_code stays as the cheap pre-gate | `serve.py`, `device-shim.ts`, `agent-backed-loop.ts` |
| B5 | upstream SKILL.md served as-is (Phase A already did the serving; added a lock-in test) | `mpyhw-api/tests/test_skill_catalog.py` |
| B6 | `render_wiring`/`render_diagram` tools (default `md`, offline) + webview **Diagram tab** rendering diagram.json (architecture + run flow), fed by a `diagram_updated` event | `serve.py`, `device-shim.ts`, `src/webview/index.html`, `session-controller.ts` |

**Verification (PC-only, all green):** extension `npm test` **200 pass** (1 pre-existing
skip) · `python -m pytest python/shim` **25 pass** · typecheck clean · VSIX packages
and bundles the 17 upstream files · a real `validate_json.py` run passes a good
manifest (exit 0) and fails a bad one (exit 1 with the precise missing-field errors).

## What's NOT done (the verification the user owns)

- **Live-gen of the full rich phase chain** (one sentence → analyze → select-hw →
  scaffold → generate → simulate). Needs the Postgres harness + real DeepSeek, which
  weren't available here (Docker Desktop was down). The CODE paths are all unit-tested
  dual-shape; what's unverified is the live LLM driving the new phased contract.
- **The full API pytest** (DB-backed credit/session tests). Untouched by Phase B; the
  three API-side changes (system prompt, contract JSON, one rewritten test) were
  verified directly via the pure `_deepseek_tools` check.
- **Real-board flash** (never done; PC-only was the agreed bar).

### Live-e2e recipe (to re-validate the rich flow)
- Start Postgres (`docker start mpyhw-pg`; ensure `mpyhw_test` exists — conftest
  TRUNCATEs, so NEVER point at dev `mpyhw`). **Restart the API after the contract
  change** (no `--reload`; the registry hash gate 403s a stale tool list).
- Start API with `DATABASE_URL` overridden → `…/mpyhw_test`, then
  `uvicorn app.main:app --port 8787`. Run uvicorn **directly** here (set the env first):
  the normal dev backend (`dev-up.ps1` → `api-daemon.ps1`) and `serve.ps1` both load
  `mpyhw-api/.env`, which would reset `DATABASE_URL` back to the dev `mpyhw` db.
- Mint a dev JWT, then `cd mpy-hardware-extension && MPYHW_DEV_JWT=<jwt> npm run
  live-gen -- "用 ssd1306 显示温度"` → inspect the generated project: a rich
  `project-manifest.json` whose `phase` advances, the derived wiring (one I²C bus,
  both devices, no phantom), and `pytest test/pc` green.

## Design notes / gotchas (don't re-trip)
- **Dual-shape is deliberate.** B2 did NOT rip out the thin manifest; it branches on
  `schema_version` so every legacy test stays green. The thin path can be retired later
  once live-gen confirms the rich path.
- **No board-profile enum flip.** The old "A3" `i2c_sda`→`i2c_data` flip was
  intentionally NOT done (high churn, low value); pinout[] uses upstream `pin_name`
  identity and `validate_json.py` owns deep pin correctness.
- **wiring vs wiring.json.** The webview wiring tab renders the manifest-DERIVED
  `{buses,standalone}` (emitted on `manifest_updated`). `manifest.wiring` per the
  upstream schema is render-results; the device-identity model is derived, not authored.
- **Project dir = workspace root** for now (`state.projectDir ?? deps.projectRoot`); the
  `<root>/<slug>` subdir was deferred (the loop interface is stable, so it's a host-side
  refinement). Scaffold + agent writes + scripts all target the same root.
- **Turn budget** is still a flat 20 (`termination.ts`); a long live multi-phase build
  may hit it before `complete` — tune if live-gen shows it.
- Debug artifacts still untracked at repo root (`main.py`, `manifest.json`, `.claude/`,
  `build/*.vsix`, `dist/`) — leave them out.
