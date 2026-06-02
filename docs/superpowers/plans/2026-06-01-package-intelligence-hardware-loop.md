# Phase 1 API-Backed Package Intelligence Hardware Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real product chain using existing infrastructure where possible: Package Intelligence API, driver context, manifest validation, generated MicroPython code, shim execution, and real-board serial observation.

**Architecture:** `mpyhw-api` is canonical for Package Intelligence from day one. The VS Code/client TypeScript side is a thin API client plus manifest/code/shim orchestration; it must not reimplement package search/ranking/context logic. Curated package records are seed data for the canonical package store, not throwaway fixtures.

**Tech Stack:** FastAPI, Python 3.10+, pytest, httpx, TypeScript, Node.js test runner, zod, mpremote, pyserial.

---

## Reuse-First Decisions

Use existing infrastructure before building new code:

- **uPyPI (`FreakStudioCN/upypi`)**
  - Reuse its public API shape and package layout as the first package source.
  - Use `GET https://upypi.net/api/search?q=...` and `GET https://upypi.net/pkgs/{name}/{version}/package.json` as source contracts.
  - Do not build a local vector DB for package search in MVP.

- **GraftSense driver/document corpus**
  - Reuse as a package/driver source behind the same normalized Package Intelligence model.
  - In Phase 1, include only the golden-path records needed for AHT20/LED.
  - In Phase 2, add ingestion jobs for broader GraftSense coverage.

- **MicroPython_Skills (`FreakStudioCN/MicroPython_Skills`)**
  - Reuse existing skills as seed content:
    - `mpremote-device-interaction`
    - `mpremote-file-transfer`
    - `mpremote-live-session`
    - `upy-norm-driver`
    - `upy-project`
  - Convert them into `mpyhw-api/content/skills/...` where needed.
  - Do not treat the repo as a runtime dependency; it is source material for served skill markdown.

- **Official `mpremote`**
  - Reuse as the execution engine through subprocess calls.
  - Do not use `adafruit-ampy`.
  - Do not wrap with `belay-py` in MVP.

- **thonny-upypi-manager**
  - Reuse only as reference evidence for IDE package install/serial workflows and edge-case behavior.
  - Do not copy plugin code or ship a Thonny plugin in MVP.

- **uPyStore / MicroPythonOS**
  - Not part of Phase 1 execution.
  - Keep project output shape compatible with later `.mpk` / app-store packaging: `main.py`, `lib/`, `manifest.json`, README/wiring output.

## Product Chain To Prove

Phase 1 must prove this exact chain:

```text
intent
-> capabilities
-> mpyhw-api /v1/packages/resolve
-> mpyhw-api /v1/packages/{name}/{version}/driver-context
-> manifest
-> code generated from driver context
-> audit using board profile + driver context
-> shim install/write/run/read
-> serial observation
```

If `resolve` or `driver-context` is bypassed, the phase is not complete.

## No-Rewrite Rule

Do not implement a TypeScript `PackageCatalog` that later gets replaced by Python API code.

The only Package Intelligence implementation in Phase 1 is:

```text
mpyhw-api/app/package_store.py
```

The client has only:

```text
mpy-hardware-extension/src/core/package-client.ts
```

The client can use a mock HTTP server in tests, but it must call the same API contract.

## File Structure

Create this minimal structure:

```text
mpyhw-api/
  pyproject.toml
  app/
    main.py
    models.py
    package_store.py
    health.py
    routes_packages.py
    routes_content.py
  content/
    boards/esp32-s3-devkitc-1.json
    packages/curated-driver-contexts.json
    packages/evidence/aht20-driver-source.py
    packages/evidence/SHA256SUMS
    skills/existing/
      mpremote-device-interaction.md
      mpremote-file-transfer.md
      mpremote-live-session.md
      upy-norm-driver.md
      upy-project.md
  tests/
    test_health.py
    test_package_routes.py
    test_driver_context_contract.py
    test_content_routes.py

mpy-hardware-extension/
  package.json
  tsconfig.json
  src/
    core/
      capabilities.ts
      package-client.ts
      board-client.ts
      manifest-schema.ts
      manifest-builder.ts
      codegen.ts
      audit-code.ts
      pipeline.ts
    cli/
      run-golden-path.ts
  python/
    shim/
      serve.py
      requirements.txt
      test_shim.py
  test/
    capabilities.test.ts
    package-client.test.ts
    manifest-schema.test.ts
    codegen.test.ts
    audit-code.test.ts
    pipeline.test.ts
    pipeline-shim.test.ts
```

---

## Task 1: Create Minimal Canonical Package API

**Files:**
- Create: `mpyhw-api/pyproject.toml`
- Create: `mpyhw-api/app/main.py`
- Create: `mpyhw-api/app/models.py`
- Create: `mpyhw-api/app/package_store.py`
- Create: `mpyhw-api/app/health.py`
- Create: `mpyhw-api/app/routes_packages.py`
- Create: `mpyhw-api/content/packages/curated-driver-contexts.json`
- Create: `mpyhw-api/tests/test_health.py`
- Create: `mpyhw-api/tests/test_package_routes.py`

- [ ] **Step 1: Add curated seed records**

Create `curated-driver-contexts.json` with normalized records for:

- AHT20 temperature/humidity package, support level initially `generatable`.
- Built-in `machine.Pin` LED output, support level `verified`.
- SSD1306 display package, support level `generatable`.
- One intentionally incomplete discoverable package with no driver context.

The AHT20 record must include:

- `name`
- `version`
- `source`
- `capabilities`
- `bus`
- `package_json_url`
- `support_level`
- `import_names`
- `constructors`
- `read_methods`
- `pin_roles`
- `install`
- `examples`
- `known_issues`
- `confidence`

- [ ] **Step 2: Implement API routes**

Implement:

- `GET /v1/health`
- `GET /v1/packages/index`
- `POST /v1/packages/search`
- `POST /v1/packages/resolve`
- `GET /v1/packages/{name}/{version}`
- `GET /v1/packages/{name}/{version}/driver-context`

Search/resolve must run over normalized records in `package_store.py`.

- [ ] **Step 3: Add API tests**

Tests must assert:

- health returns `{"status":"ok"}` without reading package/content files.
- temperature capability resolves AHT20.
- digital output resolves built-in LED package.
- display intent resolves SSD1306.
- unknown package returns `package_not_found`.
- missing context returns `driver_context_missing`.
- package endpoint returns support level and install URL.

- [ ] **Step 4: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_health.py tests/test_package_routes.py -q
```

Expected: health and package routes pass without live network.

---

## Task 2: Add Driver-Context Contract Tests

**Files:**
- Create: `mpyhw-api/tests/test_driver_context_contract.py`
- Create: `mpyhw-api/content/packages/evidence/aht20-driver-source.py`
- Create: `mpyhw-api/content/packages/evidence/SHA256SUMS`
- Modify: `mpyhw-api/content/packages/curated-driver-contexts.json`

- [ ] **Step 1: Add contract test for every `verified` record**

For each record with `support_level="verified"`, test:

- import name is importable in the expected execution context, or marked as `builtin`.
- constructor string is present in examples or source evidence.
- read methods/properties are present in examples or source evidence.
- install URL is present for non-builtin package.
- declared bus and pin roles match examples.

For Phase 1, AHT20 may stay `generatable` until the real package API is verified. Promote it to `verified` only after real install/run succeeds.

- [ ] **Step 2: Add deterministic AHT20 source-evidence check**

Do not trust a hand-written method name and do not require live network in tests. Vendor a minimal source-evidence fixture copied from the exact AHT20 package version used by the seed record:

```text
mpyhw-api/content/packages/evidence/aht20-driver-source.py
mpyhw-api/content/packages/evidence/SHA256SUMS
```

`SHA256SUMS` must include one line:

```text
<sha256>  aht20-driver-source.py
```

The contract test must:

- recompute the SHA-256 of `aht20-driver-source.py`.
- fail if the hash differs from `SHA256SUMS`.
- inspect the fixture text or AST for the driver API shape.
- verify whether the package uses:

```python
sensor.temperature
```

or:

```python
sensor.read_temperature()
```

Then make the driver context and codegen agree with the actual package.

- [ ] **Step 3: Verify**

Run:

```powershell
python -m pytest tests/test_driver_context_contract.py -q
```

Expected: no package can be marked `verified` unless its driver context is backed by evidence.

---

## Task 3: Serve Reused Content

**Files:**
- Create: `mpyhw-api/app/routes_content.py`
- Create: `mpyhw-api/content/boards/esp32-s3-devkitc-1.json`
- Create: `mpyhw-api/content/skills/existing/mpremote-device-interaction.md`
- Create: `mpyhw-api/content/skills/existing/mpremote-file-transfer.md`
- Create: `mpyhw-api/content/skills/existing/mpremote-live-session.md`
- Create: `mpyhw-api/content/skills/existing/upy-norm-driver.md`
- Create: `mpyhw-api/content/skills/existing/upy-project.md`
- Create: `mpyhw-api/tests/test_content_routes.py`

- [ ] **Step 1: Import reusable skill content**

Seed skill markdown from `MicroPython_Skills` material. Keep only behavior needed for MVP:

- device connection and status query
- file upload
- live serial session
- driver normalization
- project generation entry

- [ ] **Step 2: Add board profile**

Add ESP32-S3 DevKitC-1 board profile with:

- `pin_capabilities`
- `pin_recommendations`
- `forbidden_pins`
- `available_modules`
- voltage/safety notes

- [ ] **Step 3: Implement content routes**

Implement:

- `GET /v1/boards`
- `GET /v1/boards/{board_id}`
- `GET /v1/skills`
- `GET /v1/skills/{name}`

- [ ] **Step 4: Verify**

Run:

```powershell
python -m pytest tests/test_content_routes.py -q
```

Expected: board and skill content are served from files with stable hashes.

---

## Task 4: Build Thin TypeScript API Clients

**Files:**
- Create: `mpy-hardware-extension/package.json`
- Create: `mpy-hardware-extension/tsconfig.json`
- Create: `mpy-hardware-extension/src/core/package-client.ts`
- Create: `mpy-hardware-extension/src/core/board-client.ts`
- Create: `mpy-hardware-extension/test/package-client.test.ts`

- [ ] **Step 1: Create TS project**

Add scripts:

```json
{
  "test": "node --test --import tsx test/*.test.ts",
  "typecheck": "tsc --noEmit",
  "golden": "tsx src/cli/run-golden-path.ts"
}
```

- [ ] **Step 2: Implement clients**

`package-client.ts` must call:

- `/v1/packages/search`
- `/v1/packages/resolve`
- `/v1/packages/{name}/{version}/driver-context`

`board-client.ts` must call:

- `/v1/boards/{board_id}`

No search/ranking logic belongs in TypeScript.

- [ ] **Step 3: Test with mocked fetch**

Tests must assert:

- success responses map into typed client objects.
- `driver_context_missing` is preserved as a structured error.
- network failure becomes `upstream_unavailable`.

- [ ] **Step 4: Verify**

Run:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
```

Expected: TS client tests pass without a real API server.

---

## Task 5: Build Manifest From API Driver Context

**Files:**
- Create: `mpy-hardware-extension/src/core/capabilities.ts`
- Create: `mpy-hardware-extension/src/core/manifest-schema.ts`
- Create: `mpy-hardware-extension/src/core/manifest-builder.ts`
- Create: `mpy-hardware-extension/test/capabilities.test.ts`
- Create: `mpy-hardware-extension/test/manifest-schema.test.ts`

- [ ] **Step 1: Extract golden-path capabilities**

Implement deterministic extraction for:

- temperature sensing
- humidity sensing
- digital output
- display text

Use this explicit keyword/synonym table in `capabilities.ts` and tests:

```text
temperature: temperature, temp, hot, heat, over 30, above 30
humidity: humidity, humid, moisture
digital_output: led, light, lamp, turn on, turn off, blink
display_text: display, screen, oled, ssd1306, show text
```

The first implementation may support English keywords only; non-English intents can be added in Phase 3 when LLM extraction is available. Golden-path tests must use these exact English phrases:

- `turn on the LED when temperature is over 30`
- `show temperature on an oled display`
- `read humidity`

- [ ] **Step 2: Define manifest schema**

Manifest must include:

- `board_id`
- `capabilities`
- `packages`
- `driver_context_refs`
- `pins`
- `logic`
- `wiring`

- [ ] **Step 3: Build manifest from resolved packages**

`manifest-builder.ts` must take:

- capabilities from intent
- resolved package candidates from API
- driver contexts from API
- board profile from API

It must not hardcode AHT20 or LED package names.

- [ ] **Step 4: Validate pin roles**

Reject manifest if a pin role is not allowed by the board profile.

- [ ] **Step 5: Verify**

Run:

```powershell
node --test --import tsx test/capabilities.test.ts test/manifest-schema.test.ts
npm run typecheck
```

Expected: generated manifest is valid only when it uses API-returned package and driver context.

---

## Task 6: Generate Code From Driver Context

**Files:**
- Create: `mpy-hardware-extension/src/core/codegen.ts`
- Create: `mpy-hardware-extension/src/core/audit-code.ts`
- Create: `mpy-hardware-extension/test/codegen.test.ts`
- Create: `mpy-hardware-extension/test/audit-code.test.ts`

- [ ] **Step 1: Make codegen consume driver context**

Do not hardcode:

```python
import aht20
sensor = aht20.AHT20(i2c)
temp_c = sensor.temperature
```

Instead derive import, constructor, and read expression from driver context. The first implementation may support only these explicit context patterns:

- I2C sensor constructor using an `i2c` argument.
- read method/property for temperature.
- built-in `machine.Pin` LED output.

If a context does not match a supported pattern, return `driver_context_not_generatable`.

- [ ] **Step 2: Add audit allowlist**

Allowed imports are:

```text
board.available_modules + resolved_driver_context.import_names
```

Parse both:

```python
import module
from module import name
```

- [ ] **Step 3: Add tests**

Tests must assert:

- generated code includes `MPYHW_READY`.
- generated code includes `TEMP_C=`.
- changing driver context import name changes generated code.
- unsupported driver context fails before hardware execution.
- SSD1306 display context returns `driver_context_not_generatable` in Phase 1.
- audit rejects imports outside board modules and driver context imports.

- [ ] **Step 4: Verify**

Run:

```powershell
node --test --import tsx test/codegen.test.ts test/audit-code.test.ts
npm run typecheck
```

Expected: codegen and audit are driven by driver context, not package-specific hardcoding.

---

## Task 7: Implement Shim RPCs Needed For The Real Loop

**Files:**
- Create: `mpy-hardware-extension/python/shim/requirements.txt`
- Create: `mpy-hardware-extension/python/shim/serve.py`
- Create: `mpy-hardware-extension/python/shim/test_shim.py`

- [ ] **Step 1: Implement JSON-RPC methods**

Implement:

- `device.scan`
- `device.install_package`
- `device.write_main_py`
- `device.flash_and_run`
- `device.serial_read_until`
- `device.reset`

`device.reset` is shim-internal support even if it is not a canonical LLM tool. This Phase 1 shim scope intentionally covers the install/write/run/read loop only. The canonical seven-tool RPC surface in the specs also includes `device.list_files` and `device.health_check`; those are implemented in Phase 3/4 when the full extension diagnostic surface is built.

- [ ] **Step 2: Use official mpremote commands**

Use:

- `mpremote connect list`
- `mpremote connect <port> resume fs mkdir :/lib`
- `mpremote connect <port> resume mip install <package_json_url>`
- `mpremote connect <port> resume fs cp <local> :main.py`
- `mpremote connect <port> resume run <local_main.py>`
- serial read through `pyserial` where `mpremote run` does not provide enough streaming control

- [ ] **Step 3: Add shim tests**

Tests must assert:

- command construction is correct.
- port-busy errors map to `port_busy`.
- install failures map to `package_not_found`, `incompatible_chip`, `network`, `port_busy`, or `mpremote_error`.
- `serial_read_until` returns matched lines and times out with `timeout`.
- `device.scan` parses at least Windows `COMn` and macOS `/dev/tty.*` forms.

- [ ] **Step 4: Verify**

Run:

```powershell
cd mpy-hardware-extension\python\shim
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m pytest -q
```

Expected: shim unit tests pass without connected hardware.

---

## Task 8: End-To-End Golden Pipeline

**Files:**
- Create: `mpy-hardware-extension/src/core/pipeline.ts`
- Create: `mpy-hardware-extension/src/cli/run-golden-path.ts`
- Create: `mpy-hardware-extension/test/pipeline.test.ts`
- Create: `mpy-hardware-extension/test/pipeline-shim.test.ts`

- [ ] **Step 1: Pipeline must use API clients**

Pipeline sequence:

```text
extractCapabilities(intent)
packageClient.resolve(...)
packageClient.getPackageContext(...)
boardClient.getBoardProfile(...)
buildManifest(...)
generateMainPy(...)
auditCode(...)
```

- [ ] **Step 2: Add tests with mocked API clients**

Tests must assert:

- pipeline calls resolve and getContext.
- wrong driver context causes codegen failure.
- missing driver context returns structured error.
- generated files include `main.py` and `manifest.json`.

- [ ] **Step 3: CLI writes artifacts**

`run-golden-path.ts` must write:

```text
tmp/main.py
tmp/manifest.json
```

- [ ] **Step 4: Add non-hardware shim-loop integration test**

`pipeline-shim.test.ts` must use fake API clients and a fake shim client to prove the device half of the loop without hardware:

```text
pipeline output main.py + manifest.json
-> fake device.install_package observes package_json_url
-> fake device.write_main_py observes main.py content
-> fake device.flash_and_run observes local main.py path
-> fake device.serial_read_until returns ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]
-> pipeline returns serial observation
```

The test must fail if any call is skipped, reordered before its prerequisites, or searches for legacy unprefixed ready/temp markers.

- [ ] **Step 5: Verify**

Run:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
npm run golden -- "超过30度亮红灯"
```

Expected: artifacts are generated from mocked or local API responses, not hardcoded package names.

---

## Task 9: Real API + Real Board Smoke Test

**Files:**
- Optional output: `mpy-hardware-extension/tmp/main.py`
- Optional output: `mpy-hardware-extension/tmp/manifest.json`

- [ ] **Step 1: Start local API**

Run:

```powershell
cd mpyhw-api
python -m uvicorn app.main:app --reload --port 8787
```

Expected:

```text
GET http://127.0.0.1:8787/v1/health
```

returns `{"status":"ok"}`.

- [ ] **Step 2: Generate artifacts through API-backed pipeline**

Run:

```powershell
cd mpy-hardware-extension
$env:MPYHW_API_BASE='http://127.0.0.1:8787'
npm run golden -- "超过30度亮红灯"
```

Expected:

- `tmp/main.py` exists.
- `tmp/manifest.json` references the API-selected package and driver context.

- [ ] **Step 3: Wire hardware**

Use ESP32-S3 + AHT20:

```text
AHT20 VIN -> 3V3
AHT20 GND -> GND
AHT20 SDA -> GPIO5
AHT20 SCL -> GPIO6
LED anode -> GPIO2 through resistor, LED cathode -> GND
```

If using onboard LED on GPIO2, skip the external LED.

- [ ] **Step 4: Install package, write, run, read through shim**

Use shim RPC or equivalent commands:

```powershell
mpremote connect COM3 resume fs mkdir :/lib
mpremote connect COM3 resume mip install <package_json_url_from_manifest>
mpremote connect COM3 resume run .\tmp\main.py
```

Expected serial markers:

```text
MPYHW_READY
TEMP_C=
LED=
```

- [ ] **Step 5: Promote support level**

Only after the real-board smoke test passes:

- promote AHT20 golden-path record from `generatable` to `verified`.
- record board, firmware version, wiring, package version, and observed serial output.

## Phase 1 Exit Gate

Phase 1 is complete only when:

- API package route tests pass.
- API health route tests pass.
- driver-context contract tests pass.
- content route tests pass.
- TypeScript pipeline tests pass.
- TypeScript fake-shim pipeline integration test proves install/write/run/read/serial observation without hardware.
- codegen uses driver context.
- audit allowlist uses board modules plus driver context imports.
- shim tests include scan/install/write/run/read.
- local API + real board smoke test prints `MPYHW_READY` and `TEMP_C=`.

## Phase 1 Acceptance Checklist

Automated acceptance:

```powershell
cd mpyhw-api
python -m pytest tests/test_health.py tests/test_package_routes.py tests/test_driver_context_contract.py tests/test_content_routes.py -q
cd ..\mpy-hardware-extension
npm test
npm run typecheck
cd python\shim
.\.venv\Scripts\python -m pytest -q
```

Manual hardware acceptance:

- Start local API on `http://127.0.0.1:8787`.
- Run `npm run golden -- "超过30度亮红灯"` with `MPYHW_API_BASE` pointed to the local API.
- Confirm generated `tmp/manifest.json` references API-selected package/context records.
- Run on real ESP32-S3 + AHT20 + LED.
- Serial output must include `MPYHW_READY`, `TEMP_C=`, and `LED=`.

Blocking failures:

- The pipeline hardcodes AHT20 instead of calling `/v1/packages/resolve`.
- A `verified` package has no evidence-backed driver-context contract test.
- `generateMainPy` uses an import/constructor/read API not present in driver context.
- Shim cannot perform `device.scan` or `device.serial_read_until`.
