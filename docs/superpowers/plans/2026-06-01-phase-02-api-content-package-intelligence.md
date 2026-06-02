# Phase 2 Package Ingestion And Package Intelligence Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Phase 1 canonical Package Intelligence API from curated golden records to broader uPyPI and GraftSense coverage without changing the client contract.

**Architecture:** `mpyhw-api/app/package_store.py` remains the canonical runtime store. Ingestion jobs normalize uPyPI, GraftSense, and curated recipes into the same record schema. Request handlers do not call external networks directly.

**Tech Stack:** Python 3.10+, FastAPI, pydantic, pytest, httpx, scheduled ingestion scripts.

---

## Reused Sources

- **uPyPI**
  - Search: `GET https://upypi.net/api/search?q={query}`
  - Package detail: `GET https://upypi.net/pkgs/{name}/{version}/package.json`
  - README/examples where available.

- **GraftSense**
  - Driver repository/package metadata.
  - README/examples/source files.
  - Hardware module documentation and known wiring conventions.

- **Curated verified recipes**
  - Phase 1 golden-path records.
  - Real-board smoke-test evidence.

- **MicroPython_Skills**
  - Driver normalization rules from `upy-norm-driver`.
  - mpremote command semantics from existing mpremote skills.

## File Structure

Create or modify:

```text
mpyhw-api/
  app/
    package_store.py
    routes_packages.py
  content/
    packages/
      curated-driver-contexts.json
      package_index.json
      driver_context/
        aht20_driver-1.0.0.json
      ingestion_evidence.json
  tests/
    fixtures/package_sources/
      upypi/search-temperature.json
      upypi/aht20-package.json
      graftsense/aht20-readme.md
      graftsense/aht20-source.py
  scripts/
    ingest_upypi.py
    ingest_graftsense.py
    normalize_driver_context.py
  tests/
    test_upypi_ingestion.py
    test_graftsense_ingestion.py
    test_package_conformance.py
    test_driver_context_confidence.py
```

Keep the Phase 1 module path `mpyhw-api/app/routes_packages.py` for this monorepo plan. The spec's `routes/packages.py` tree is a packaging layout variant; do not introduce a second route module during MVP.

## Task 1: Define Normalized Package Record

**Files:**
- Modify: `mpyhw-api/app/package_store.py`
- Modify: `mpyhw-api/app/routes_packages.py`
- Create: `mpyhw-api/tests/test_package_conformance.py`

- [ ] **Step 1: Add conformance tests**

The same record schema must support:

- curated records
- uPyPI records
- GraftSense records

Required normalized fields:

- `name`
- `version`
- `source`
- `description`
- `author`
- `license`
- `chips`
- `fw`
- `deps`
- `urls`
- `package_json_url`
- `readme_url`
- `repository_url`
- `capabilities`
- `support_level`
- `cached`

Internal store fields may also include:

- `score_base`
- `reason_rules`
- `driver_context_ref`
- `evidence_refs`

These internal fields must not leak from `GET /v1/packages/{name}/{version}` unless they are part of the spec response. Search/resolve responses must expose contract fields as `score` and `reason`, derived deterministically from `score_base` and `reason_rules`.

- [ ] **Step 2: Implement normalizer**

Normalize external source records into the Phase 1 package store shape. Do not expose source-specific fields to the client.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_package_conformance.py -q
```

Expected: all source types normalize into one schema and `GET /v1/packages/{name}/{version}` still returns the spec `PackageRecord` fields including `author`, `license`, `urls`, `readme_url`, `repository_url`, and `cached`.

## Task 2: uPyPI Ingestion

**Files:**
- Create: `mpyhw-api/scripts/ingest_upypi.py`
- Create: `mpyhw-api/tests/fixtures/package_sources/upypi/search-temperature.json`
- Create: `mpyhw-api/tests/fixtures/package_sources/upypi/aht20-package.json`
- Create: `mpyhw-api/tests/fixtures/package_sources/upypi/malformed-package.json`
- Create: `mpyhw-api/tests/test_upypi_ingestion.py`

- [ ] **Step 1: Add offline uPyPI fixture tests**

Tests must cover:

- search response with package URLs.
- package JSON response with name/version/chips/fw/urls.
- missing README.
- malformed package JSON.
- duplicate version handling.

Tests must read committed fixture JSON from `tests/fixtures/package_sources/upypi/`. They must not call `upypi.net`.

- [ ] **Step 2: Implement ingestion script**

Script output:

```text
content/packages/package_index.json
content/packages/ingestion_evidence.json
```

The script must support `--fixture-dir tests/fixtures/package_sources/upypi` for deterministic offline acceptance. A live refresh mode may exist, but no request handler and no automated test should call `upypi.net` directly.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_upypi_ingestion.py -q
```

Expected: ingestion works against committed offline fixtures.

## Task 3: GraftSense Ingestion

**Files:**
- Create: `mpyhw-api/scripts/ingest_graftsense.py`
- Create: `mpyhw-api/tests/fixtures/package_sources/graftsense/aht20-package.json`
- Create: `mpyhw-api/tests/fixtures/package_sources/graftsense/aht20-readme.md`
- Create: `mpyhw-api/tests/fixtures/package_sources/graftsense/aht20-source.py`
- Create: `mpyhw-api/tests/test_graftsense_ingestion.py`

- [ ] **Step 1: Add offline GraftSense fixture tests**

Tests must cover:

- package metadata extraction.
- README/example extraction.
- bus and pin-role detection.
- missing package JSON.
- source evidence references.

Tests must read committed fixture files from `tests/fixtures/package_sources/graftsense/`. They must not clone or fetch a live GraftSense repository.

- [ ] **Step 2: Implement ingestion script**

Normalize GraftSense records into the same `package_index.json` shape and per-package `driver_context/{name}-{version}.json` files.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_graftsense_ingestion.py -q
```

Expected: GraftSense records merge without changing package API behavior.

## Task 4: Driver Context Extraction And Confidence

**Files:**
- Create: `mpyhw-api/scripts/normalize_driver_context.py`
- Create: `mpyhw-api/tests/test_driver_context_confidence.py`

- [ ] **Step 1: Add confidence tests**

Support-level rules:

- `discoverable`: package exists, metadata basic.
- `installable`: package has `package_json_url` and deps/install metadata.
- `generatable`: import/constructor/read/write methods can be extracted with evidence.
- `verified`: all of these are true:
  - driver context has `evidence_refs`.
  - contract test proves import, constructor, and read method/property match source evidence.
  - golden path passed on real hardware or reliable CI/hardware-in-loop evidence.
- `experimental`: metadata is weak or conflicting.

Tests must include records that try to claim `verified` with only one or two of those requirements and assert they are rejected or downgraded.

- [ ] **Step 2: Implement extraction**

Extract:

- import names
- constructors
- read/write methods or properties
- bus
- pin roles
- install URL
- deps
- examples
- known issues
- evidence references

Write driver context files under:

```text
content/packages/driver_context/{name}-{version}.json
```

`driver_context_ref` in the package index must point to that per-package file.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_driver_context_confidence.py -q
```

Expected: support levels are deterministic and `verified` cannot pass without evidence refs, contract evidence, and smoke evidence.

## Task 5: API Regression Against Phase 1 Golden Path

**Files:**
- Modify: `mpyhw-api/tests/test_package_routes.py`
- Modify: `mpyhw-api/tests/test_package_conformance.py`

- [ ] **Step 1: Add golden conformance tests**

Tests must assert:

- Phase 1 golden AHT20/LED records still resolve first.
- incomplete records still return `driver_context_missing`.
- expanded package index does not demote verified recipes.
- ranking is deterministic across repeated runs.
- `PackageHit.score` and `PackageHit.reason` are returned for search/resolve results.
- every `verified` record has evidence refs, contract evidence, and smoke evidence.

- [ ] **Step 2: Verify**

Run:

```powershell
cd mpyhw-api
python -m pytest tests/test_package_routes.py tests/test_package_conformance.py -q
```

Expected: ingestion expansion does not break Phase 1 behavior.

## Phase 2 Exit Verification

Run:

```powershell
cd mpyhw-api
python -m pytest -q
```

Expected:

- uPyPI ingestion tests pass.
- GraftSense ingestion tests pass.
- driver-context confidence tests pass.
- package API route tests still pass.
- Phase 1 golden path remains top-ranked and evidence-backed.

## Phase 2 Acceptance Checklist

Automated acceptance:

```powershell
cd mpyhw-api
python -m pytest tests/test_upypi_ingestion.py tests/test_graftsense_ingestion.py tests/test_driver_context_confidence.py tests/test_package_conformance.py tests/test_package_routes.py -q
```

Data acceptance:

- Running ingestion against committed offline fixtures creates `content/packages/package_index.json` with records from `curated`, `upypi`, and `graftsense`.
- All records have normalized fields listed in Task 1.
- No request handler calls external package sources directly.
- Automated tests and acceptance do not require live network access.
- Expanded ingestion does not change the Phase 1 API response shape.
- Golden AHT20/LED path remains top-ranked for the temperature-threshold LED intent.

Blocking failures:

- uPyPI and GraftSense records use source-specific fields in API responses.
- A package is promoted to `generatable` without import/constructor/read evidence.
- A package is promoted to `verified` without driver-context evidence refs, contract evidence, and real-board or reliable CI/hardware-in-loop smoke evidence.
- Request handlers call external package sources at user-request time.
