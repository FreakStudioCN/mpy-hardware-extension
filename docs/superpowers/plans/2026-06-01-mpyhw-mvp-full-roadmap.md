# mpyhw MVP Full Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete v0.2 MVP from the existing architecture specs: a VS Code MicroPython hardware agent that can turn a user intent into package choice, generated code, board execution, serial observation, and recovery guidance.

**Architecture:** The client owns the agent loop, manifest validation, tool dispatch, WebView UI, and local shim process. The API owns LLM proxying, content endpoints, canonical Package Intelligence, quota, abuse control, and telemetry. The Python shim owns only local hardware IO through `mpremote` and serial.

**Tech Stack:** TypeScript, VS Code Extension API, zod, Node.js test runner, FastAPI, Python 3.10+, mpremote, pyserial, Anthropic Messages SSE.

---

## What "Later Layers" Means

The earlier Phase 1 document only covers the first proof chain:

`intent -> capabilities -> API-backed Package Intelligence -> driver context -> manifest -> code -> real-board smoke test`

Curated package records are not a throwaway implementation. They are seed records in the canonical API package store. The TypeScript client must not reimplement package search/ranking/context lookup.

## Reuse-First Asset Map

Before writing new code, use these existing assets:

- `FreakStudioCN/upypi`: first package source and package layout contract.
- `FreakStudioCN/MicroPython_Skills`: seed skill content for mpremote, file transfer, live serial, driver normalization, and project generation.
- GraftSense driver/docs corpus: second package/driver source behind the same normalized Package Intelligence model.
- official `mpremote`: execution engine for install, upload, run, reset, and device probing.
- `thonny-upypi-manager`: reference only for IDE integration edge cases; do not copy or ship its code.
- uPyStore/MicroPythonOS: later packaging/app-store compatibility target; keep generated artifact shape compatible.

The remaining layers are not vague future work. They are these concrete implementation plans:

1. **Phase 1 - API-backed package intelligence and hardware smoke test**
   - Plan: `2026-06-01-package-intelligence-hardware-loop.md`
   - Proves the chain works without LLM or UI, but with the real Package Intelligence API contract.

2. **Phase 2 - Package ingestion and Package Intelligence expansion**
   - Plan: `2026-06-01-phase-02-api-content-package-intelligence.md`
   - Adds uPyPI/GraftSense ingestion behind the existing API package store.
   - Keeps curated seed records as golden-path verified recipes.

3. **Phase 3 - Client agent loop and tool dispatch**
   - Plan: `2026-06-01-phase-03-client-agent-loop-tools.md`
   - Adds the ReAct loop, SSE client, canonical tool registry, local/api/shim/ui tool executors, and session termination rules.

4. **Phase 4 - VS Code WebView product shell**
   - Plan: `2026-06-01-phase-04-vscode-webview-product.md`
   - Adds the user-facing extension UI: intent input, device picker, trace, manifest preview, code preview, serial output, confirmations, and ask-user prompts.

5. **Phase 5 - Release, observability, and MVP hardening**
   - Plan: `2026-06-01-phase-05-release-observability-hardening.md`
   - Adds quota/telemetry, packaging, install health checks, documentation, and release gates.

## Execution Order

Do not build the UI first. The right order is:

```text
Phase 1: API-backed deterministic chain + real hardware smoke test
Phase 2: package ingestion and broader source coverage
Phase 3: client agent/tool loop using the Phase 1 API contract and Phase 2-expanded package store when available
Phase 4: WebView UI around the working loop
Phase 5: release hardening and operations
```

Reason: each phase has a concrete verification boundary. If Phase 1 fails, the product cannot drive hardware through the real Package Intelligence contract. If Phase 2 fails, hardware coverage stays limited to curated golden records. If Phase 3 fails, the LLM cannot use tools. If Phase 4 fails, the product is not usable. If Phase 5 fails, the MVP is not shippable.

## Global Done Definition

The MVP is done only when all of these pass:

- `mpy-hardware-extension`: unit tests, typecheck, extension integration tests.
- `mpyhw-api`: API unit tests, package endpoint tests, LLM middleware tests.
- `python/shim`: unit tests and hardware smoke test.
- Manual E2E: user enters a hardware intent in VS Code, approves hardware operations, code runs on a real board, serial output confirms success.
- Abuse gate: non-hardware intent cannot use the LLM proxy.
- Tool whitelist: non-canonical tool names are rejected by API.
- Package intelligence: at least one verified package path works, one missing driver context path fails safely, and one install failure maps to a recovery observation.

## Cross-Repo Boundaries

The implementation may live in one monorepo during MVP, but it should keep these logical roots:

```text
mpy-hardware-extension/
  src/core/               # reusable client-side agent/tool/manifest/codegen core
  src/extension/          # VS Code activation, commands, process lifecycle
  src/webview/            # product UI
  python/shim/            # mpremote/serial JSON-RPC shim

mpyhw-api/
  app/                    # FastAPI routes and middleware
  content/                # skills, boards, tools, curated package seed records
  tests/
```

## Phase Exit Gates

Phase 1 exits when:

- Local API-backed deterministic pipeline creates valid manifest and `main.py`.
- Fake-shim integration proves install/write/run/read/serial observation without hardware.
- Real board prints `MPYHW_READY` and `TEMP_C=`.

Phase 2 exits when:

- uPyPI ingestion imports new/updated package metadata into the normalized package store.
- GraftSense ingestion imports driver/document records into the same normalized package store.
- Package endpoints still pass curated golden-path conformance tests.

Phase 3 exits when:

- A scripted/fake SSE stream can drive the client agent through tool calls.
- Tool observations are appended to session messages correctly.
- Terminal conditions are deterministic and tested.

Phase 4 exits when:

- VS Code extension can run a session from the WebView and show trace, manifest, generated code, and serial output.
- User confirmations are required for hardware writes/runs.

Phase 5 exits when:

- Extension package builds.
- API deploy artifact builds.
- Fresh-machine install path is documented and tested.
- MVP demo checklist passes on Windows and macOS.

## Plan Verifier Scope

`python scripts\verify_plans.py` is a planning-document guardrail. It checks the six roadmap/phase plan files for required sections, explicit acceptance gates, incomplete-marker text, and known architecture regressions such as client-side Package Intelligence reimplementation or obsolete local-seed-as-runtime designs.

It does not prove implementation correctness, runtime behavior, API compatibility, VS Code Extension Host behavior, package installs, or real-board hardware behavior. Those are proven only by each phase's automated and manual acceptance commands.

## Final MVP Acceptance Checklist

Automated acceptance:

```powershell
python scripts\verify_plans.py
cd mpyhw-api
python -m pytest -q
cd ..\mpy-hardware-extension
npm test
npm run typecheck
npm run smoke:extension
```

Manual acceptance:

- Phase 1 through Phase 5 acceptance checklists are all satisfied.
- Hardware-dependent Phase 1/5 checks may be deferred only for this planning-review stage; they remain required for MVP completion.
- A fresh engineer can start from Phase 1 without reading the conversation history.
- Every package decision flows through API-backed Package Intelligence, not a local client ranking implementation.
- Every generated driver API use is backed by driver context and evidence.

Blocking failures:

- Any phase plan lacks automated acceptance, manual/data/scenario acceptance where applicable, or blocking failures.
- Any plan reintroduces TypeScript package ranking/search as a replacement for canonical API Package Intelligence.
- Any `verified` package path lacks driver-context contract evidence.
