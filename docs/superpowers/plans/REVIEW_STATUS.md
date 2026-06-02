# Plan Review Status

Last reviewed: 2026-06-01

Scope of this review:

- Planning documents only.
- Non-hardware verification only.
- No package installs, no API server startup, no VS Code Extension Development Host, and no board smoke test in this stage.

## Verifier Scope

`python scripts\verify_plans.py` is a planning-document guardrail. It checks the six roadmap/phase plan files for required structure, acceptance gates, blocking-failure sections, incomplete-marker text, and known architecture regressions.

It does not prove implementation correctness, runtime behavior, API compatibility, extension behavior, package installs, or real-board behavior. Those remain phase acceptance tests.

## Latest External Review Follow-Up

Claude Code reviewed the roadmap and Phase 1 plan against the current specs. The accepted findings were fixed in the plan/spec layer:

- Added a non-hardware fake-shim pipeline integration test for install/write/run/read/serial observation.
- Added explicit `/v1/health` implementation and test requirements to Phase 1.
- Unified generated artifact naming on `manifest.json`.
- Unified serial markers on `MPYHW_READY`, `TEMP_C=...`, and `LED=...`.
- Added deterministic AHT20 source-evidence fixture and hash requirement.
- Added explicit deterministic capability keyword table and golden phrases.
- Added the Phase 1 SSD1306 `driver_context_not_generatable` test.
- Aligned shim install error taxonomy across plan/specs.
- Documented `verify_plans.py` scope and limits.

## Verification Commands Run

```powershell
python scripts\verify_plans.py
rg -n "search_upypi|get_package_metadata|/v1/upypi|Replace local|without LLM, API|local fixture|stuck on fixtures|13 ge tool|11 builtin|available_modules.*all import|safetyAudit\.audit\(code\)|mpyhw\.manifest\.json" docs\specs docs\superpowers\plans
rg -n -P "(?<!MPYHW_)READY|TEMP=" docs\specs docs\superpowers\plans
```

Results:

- `python scripts\verify_plans.py` passed: 6 plan files checked.
- Bare legacy serial marker scan returned no matches.
- Architecture regression scan is clean for plan/spec source files after ignoring verifier self-references.

## Reviewed Plans

| Plan | Status | Evidence |
|---|---|---|
| `2026-06-01-mpyhw-mvp-full-roadmap.md` | Reviewed for current planning stage | Has final MVP acceptance checklist, verifier scope, fake-shim Phase 1 exit gate, reuse-first asset map |
| `2026-06-01-package-intelligence-hardware-loop.md` | Reviewed for current planning stage | Has Phase 1 acceptance checklist, health route gate, API-backed pipeline, driver-context evidence contract, fake-shim integration, shim RPC scope |
| `2026-06-01-phase-02-api-content-package-intelligence.md` | Reviewed for current planning stage | Has Phase 2 acceptance checklist, uPyPI/GraftSense ingestion scope, conformance and confidence tests |
| `2026-06-01-phase-03-client-agent-loop-tools.md` | Reviewed for current planning stage | Has Phase 3 acceptance checklist, scripted SSE scenarios, tool routing and API client checks |
| `2026-06-01-phase-04-vscode-webview-product.md` | Reviewed for current planning stage | Has Phase 4 acceptance checklist, Extension Development Host manual UI gates, `manifest.json` workspace artifact |
| `2026-06-01-phase-05-release-observability-hardening.md` | Reviewed for current planning stage | Has Phase 5 acceptance checklist, release, telemetry, quota, packaging, and smoke checks |

## Deferred Verification

These remain required later, but were intentionally not run in this stage:

- Real hardware smoke test on ESP32-S3 + AHT20 + LED.
- Full `mpyhw-api` pytest suite, because implementation code does not exist yet.
- Full `mpy-hardware-extension` npm test/typecheck, because implementation code does not exist yet.
- VS Code Extension Development Host manual UI test, because implementation code does not exist yet.

## Current Blocking Rules For Future Work

- Do not implement TypeScript package ranking/search/context extraction. Use `mpyhw-api` Package Intelligence.
- Do not mark any package `verified` without driver-context evidence plus smoke evidence.
- Do not let `generate_code` run without driver context.
- Do not let `audit_code` allow imports outside `board.available_modules + resolved_driver_context.import_names`.
- Do not ship WebView actions that install, write, flash, or run without Extension Host confirmation.
