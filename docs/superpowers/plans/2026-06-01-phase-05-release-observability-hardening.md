# Phase 5 Release Observability And Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working MVP into something that can be demoed, installed, diagnosed, and released without relying on a developer sitting beside the user.

**Architecture:** Add observability, quota display, error classification, packaging, smoke scripts, and release checklists. Do not add new product features in this phase.

**Tech Stack:** VS Code extension packaging, FastAPI deployment artifact, Sentry or structured logs, pytest, Node tests, manual hardware checklist.

---

## File Structure

Create or modify:

```text
mpy-hardware-extension/
  scripts/
    smoke-extension.ps1
    smoke-hardware.ps1
  docs/
    install.md
    demo-checklist.md
    troubleshooting.md
  src/core/
    telemetry.ts
    error-classification.ts
  test/
    telemetry.test.ts
    error-classification.test.ts

mpyhw-api/
  app/
    routes_quota.py
    routes_telemetry.py
  tests/
    test_quota.py
    test_telemetry.py
```

## Task 1: Error Classification

**Files:**
- Create: `mpy-hardware-extension/src/core/error-classification.ts`
- Create: `mpy-hardware-extension/test/error-classification.test.ts`

- [ ] **Step 1: Add tests**

Classify:

- `ImportError` -> `package_import_error`
- `OSError: [Errno 19] ENODEV` -> `i2c_device_not_found`
- permission denied serial error -> `port_busy`
- no serial ports -> `device_not_found`
- network failure during install -> `package_install_network`
- invalid manifest -> `manifest_invalid`

- [ ] **Step 2: Implement classifier**

Return user-facing category, developer diagnostic code, and recommended next action.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpy-hardware-extension
node --test --import tsx test/error-classification.test.ts
```

Expected: all known failure modes map to stable categories.

## Task 2: Telemetry And Trace Export

**Files:**
- Create: `mpy-hardware-extension/src/core/telemetry.ts`
- Create: `mpy-hardware-extension/test/telemetry.test.ts`
- Create: `mpyhw-api/app/routes_telemetry.py`
- Create: `mpyhw-api/tests/test_telemetry.py`

- [ ] **Step 1: Client telemetry tests**

Tests must assert:

- Events include `trace_id`, `event_type`, `timestamp`, and sanitized payload.
- User code is hashed or omitted.
- Serial output is truncated before sending.

- [ ] **Step 2: API telemetry tests**

Tests must assert:

- `POST /v1/telemetry` accepts valid event batch.
- Oversized payload is rejected.
- Unknown event type is rejected.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpy-hardware-extension
node --test --import tsx test/telemetry.test.ts
cd ..\mpyhw-api
python -m pytest tests/test_telemetry.py -q
```

Expected: telemetry is bounded and privacy-safe.

## Task 3: Quota Endpoint And UI Display

**Files:**
- Create: `mpyhw-api/app/routes_quota.py`
- Create: `mpyhw-api/tests/test_quota.py`
- Modify: `mpy-hardware-extension/src/webview/app.ts`

- [ ] **Step 1: API tests**

Tests must assert:

- anonymous user receives default free quota.
- quota response includes `used`, `limit`, and `resets_at`.
- exhausted quota returns a client-usable error body.

- [ ] **Step 2: UI behavior**

WebView shows remaining sessions and disables start when quota is exhausted.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_quota.py -q
```

Then manually verify quota display in Extension Development Host.

## Task 4: Packaging And Install Health Check

**Files:**
- Create: `mpy-hardware-extension/scripts/smoke-extension.ps1`
- Modify: `mpy-hardware-extension/package.json`
- Create: `mpy-hardware-extension/docs/install.md`

- [ ] **Step 1: Add package script**

Add scripts:

- `package`: builds VSIX
- `smoke:extension`: runs typecheck, tests, and package build

- [ ] **Step 2: Health check behavior**

On extension activation, check:

- Python 3.10+
- venv exists or can be created
- `mpremote` import works
- shim process starts
- API `/v1/health` reachable

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpy-hardware-extension
npm run smoke:extension
```

Expected: tests, typecheck, and package build pass.

## Task 5: End-To-End Demo Checklist

**Files:**
- Create: `mpy-hardware-extension/docs/demo-checklist.md`
- Create: `mpy-hardware-extension/docs/troubleshooting.md`
- Create: `mpy-hardware-extension/scripts/smoke-hardware.ps1`

- [ ] **Step 1: Write demo checklist**

Checklist must include:

- required board model
- MicroPython firmware version
- wiring table
- expected VS Code UI states
- expected serial markers
- expected LED behavior
- common failure classifications

- [ ] **Step 2: Write smoke script**

Script must:

- verify `mpremote` exists
- list serial devices
- run `mpremote connect <port> exec "print('MPYHW_PROBE')"`
- exit nonzero on missing port or failed probe

- [ ] **Step 3: Verify manually**

Run:

```powershell
cd mpy-hardware-extension
.\scripts\smoke-hardware.ps1 -Port COM3
```

Expected:

- Script prints `MPYHW_PROBE`.
- Failure modes are actionable.

## Phase 5 Exit Verification

Run:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
npm run smoke:extension
cd ..\mpyhw-api
python -m pytest -q
```

Manual release gate:

- Fresh checkout can install dependencies from documented commands.
- Extension opens on Windows.
- API starts locally.
- Hardware smoke test passes on ESP32-S3 + AHT20 + LED.
- Non-hardware intent is rejected.
- Unknown tool is rejected.
- Trace export contains no raw full user code or long serial dumps.

## Phase 5 Acceptance Checklist

Automated acceptance:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
npm run smoke:extension
cd ..\mpyhw-api
python -m pytest -q
```

Release acceptance:

- Fresh checkout setup follows `docs/install.md` without undocumented steps.
- VSIX/package artifact builds successfully.
- API starts locally and `/v1/health` returns ok.
- `smoke-hardware.ps1 -Port COM3` prints `MPYHW_PROBE`.
- Full demo on ESP32-S3 + AHT20 + LED passes.
- Telemetry omits raw full code and long serial logs.
- Quota exhaustion and non-hardware rejection show user-safe messages.

Blocking failures:

- Any required manual step is missing from install/demo docs.
- Trace export leaks raw full user code.
- Package build succeeds but extension cannot start a health check on a clean machine.
