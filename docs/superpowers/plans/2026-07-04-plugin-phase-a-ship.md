# Plugin Phase A (Ship) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take `mpy-hardware-extension` from v0.3.12 (published 2026-06-26) to a quality-gated v0.4.0 Marketplace release: pinned toolchain, expanded board catalog, the three carried-over bugs fixed host-side, light usage metering, honest marketplace material, and a golden-path self-verification harness.

**Architecture:** All fixes land host-side (extension TS, shim Python, backend Python, host prompt notes) — `third_party/MicroPython_Skills` is READ-ONLY upstream. Changes that would require upstream edits are collected in a report file for the user's separate upstream flow, never made here.

**Tech Stack:** TypeScript (node --test, `--experimental-strip-types`), Python 3.12 (pytest), FastAPI backend (`mpyhw-api`), device shim (`mpy-hardware-extension/python/shim`), vsce packaging.

## Global Constraints

- `third_party/MicroPython_Skills` (both the repo-root submodule and the vendored `mpy-hardware-extension/third_party` copy) is **never edited**. Needed upstream changes go into `docs/upstream-requests.md` (Task 2/3 create it).
- The two website repos (`blockless-api`, `website-blockless`) are untouched; `blockless-api/content/chips/*.json` may be **read** as a pin-fact cross-check only.
- Fail-fast is not relaxed anywhere. No silent fallbacks (user's standing rule).
- All API endpoints reachable via `mpyhw.apiBaseUrl` config — no hardcoding.
- One commit per task, message style `feat(scope): ...` / `fix(scope): ...` matching git log.
- Backend tests: `python -m pytest` from `mpyhw-api/`. Shim tests: `python -m pytest` from `mpy-hardware-extension/python/shim/`. Extension: `npm test` + `npm run typecheck` from `mpy-hardware-extension/`.
- Dev shell is Windows PowerShell; CI is ubuntu + Python 3.12 + Node 22.
- Version bump to **0.4.0** happens only in Task 11 (publish), not before.

---

### Task 1: A1 — Pin the device-shim toolchain

**Files:**
- Modify: `mpy-hardware-extension/python/shim/requirements.txt` (entire file, 8 lines)
- Create: `mpy-hardware-extension/python/shim/test_requirements_pinned.py`

**Interfaces:**
- Produces: a fully `==`-pinned requirements file that `device-shim.ts` `ensureVenv()`/`installVenvAsync()` install verbatim (they already pass `-r requirements.txt`; no TS change needed).

Versions below were frozen from the currently-passing `~/.mpyhw/venv` on 2026-07-04 (`pip freeze`). `esptool==4.11.0` is already pinned upstream in `requirements-esptool.txt` (separate `.venv-esptool`) — leave it alone.

- [ ] **Step 1: Write the failing test** — `mpy-hardware-extension/python/shim/test_requirements_pinned.py`:

```python
"""Guard: every shim tool is exactly pinned (A1). Unpinned tools made the
16 quality gates drift with upstream lint releases."""
from pathlib import Path

import re


def test_every_requirement_is_exact_pinned():
    lines = [
        ln.strip()
        for ln in (Path(__file__).parent / "requirements.txt").read_text().splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    assert lines, "requirements.txt is empty"
    for ln in lines:
        assert re.fullmatch(r"[A-Za-z0-9._-]+==[A-Za-z0-9.]+", ln), f"not exact-pinned: {ln!r}"


def test_expected_tool_set_unchanged():
    text = (Path(__file__).parent / "requirements.txt").read_text()
    for tool in ("mpremote", "pyserial", "pytest", "jsonschema", "flake8", "pylint", "requests", "pypdf"):
        assert re.search(rf"^{tool}==", text, re.M), f"missing pin for {tool}"
```

- [ ] **Step 2: Run it to verify it fails**
Run (from `mpy-hardware-extension/python/shim/`): `python -m pytest test_requirements_pinned.py -v`
Expected: FAIL (`not exact-pinned: 'mpremote'`).

- [ ] **Step 3: Pin the file** — replace `mpy-hardware-extension/python/shim/requirements.txt` content with:

```
# Exact pins (A1): the 16 quality gates must not drift with upstream lint
# releases. Bump deliberately, then re-run the shim pytest suite and one
# run_quality_gates.py baseline before committing a new set.
mpremote==1.28.0
pyserial==3.5
pytest==9.0.3
jsonschema==4.26.0
flake8==7.3.0
pylint==4.0.5
requests==2.34.2
pypdf==6.13.0
```

- [ ] **Step 4: Verify a from-scratch venv resolves the pins and gates behave identically**

```powershell
python -m venv "$env:TEMP\mpyhw-pin-check"
& "$env:TEMP\mpyhw-pin-check\Scripts\python.exe" -m pip install -q -r mpy-hardware-extension\python\shim\requirements.txt
& "$env:TEMP\mpyhw-pin-check\Scripts\python.exe" -c "import mpremote, serial, jsonschema, flake8, pylint, requests, pypdf; print('probe ok')"
```
Expected: `probe ok` (this is `SHIM_IMPORT_PROBE` from `device-shim.ts:350` verbatim).
Then: `python -m pytest` from `mpy-hardware-extension/python/shim/` → all pass, and Step 1's test passes.

- [ ] **Step 5: Commit**

```bash
git add mpy-hardware-extension/python/shim/requirements.txt mpy-hardware-extension/python/shim/test_requirements_pinned.py
git commit -m "feat(shim): pin the device-shim toolchain to the passing set (A1)"
```

---

### Task 2: A2a — Kill the silent `{board_id}` stub in `_resolve_board`

**Files:**
- Modify: `mpyhw-api/app/prompt_assembly.py:454-466` (function `_resolve_board`; the bare-stub loop is :462-465)
- Modify: `mpyhw-api/tests/test_llm_messages.py` (add one test; existing tests at :86 and :108 are guardrails that must stay green)
- Create: `docs/upstream-requests.md`

**Interfaces:**
- Produces: `_resolve_board` returns, for an unknown board, `{"board_id": <safe>, "support_status": "unknown_board", "pin_allocation_supported": False, "note": ...}` instead of a bare `{"board_id": ...}`. Consumers (prompt injection `_phase_data_injection`) need no change — extra keys flow into the RESOLVED DATA block and tell the model the truth.

- [ ] **Step 1: Write the failing test** — append to `mpyhw-api/tests/test_llm_messages.py`:

```python
def test_resolve_board_marks_unknown_boards_loudly_instead_of_bare_stub():
    from app.routes_llm import _resolve_board

    board = _resolve_board({}, {"pre_selected_board": "totally-unknown-board-9000"})
    assert board["board_id"] == "totally-unknown-board-9000"
    assert board["support_status"] == "unknown_board"
    assert board["pin_allocation_supported"] is False
    assert "pin" in board["note"].lower()
```

- [ ] **Step 2: Run it to verify it fails**
Run (from `mpyhw-api/`): `python -m pytest tests/test_llm_messages.py -k unknown_boards -v`
Expected: FAIL (`KeyError: 'support_status'`).

- [ ] **Step 3: Fix `_resolve_board`** — replace lines 462-466 (the trailing loop + `return {}`) with:

```python
    for board_id in _raw_board_id_candidates(manifest, body):
        safe = board_id if re.fullmatch(r"[A-Za-z0-9._-]{1,96}", board_id) else "unknown"
        # Loud, explicit tier instead of the old bare {"board_id": ...} stub:
        # the model must not invent a pin layout for a board we know nothing about.
        return {
            "board_id": safe,
            "support_status": "unknown_board",
            "pin_allocation_supported": False,
            "note": (
                "No builtin pin layout and no official-catalog record for this board. "
                "Do NOT invent pin numbers; ask the user for wiring or recommend a "
                "builtin_pin_layout board."
            ),
        }
    return {}
```

- [ ] **Step 4: Run the guardrail set**
Run: `python -m pytest tests/test_llm_messages.py -v`
Expected: PASS including `test_resolve_board_uses_preselected_local_board_id_before_auto_or_official_id` (:86) and `test_resolve_board_preserves_official_only_board_facts_without_claiming_pin_layout` (:108).

- [ ] **Step 5: Create `docs/upstream-requests.md`** (used by Tasks 3/5 too):

```markdown
# Upstream change requests (third_party/MicroPython_Skills is read-only here)

Collected during Phase A. Report these through the upstream flow; do not edit the submodule.

## 1. Analyze-format board definitions wanted (blocks more full profiles)
`upy-analyze-plugin/boards/` today ships 7 boards. To promote these to
`builtin_pin_layout` we need upstream definitions for: ESP32-S2, ESP32-C6,
Pico 2 (RPI_PICO2), Pico 2 W, LuatOS/合宙 ESP32-C3 core board, Waveshare Pico
series.

## 2. `check_mpy_imports.py` allowlist
If future confirmed-safe modules trip `MPY_IMPORT_UNSUPPORTED`, widen
`MPY_ALLOWED` upstream. Phase A's host-side fix (deterministic firmware/tools
removal) removes the only recurring false positive (subprocess in
scaffold-dropped host helpers) without touching the gate.

## 3. m5stack-core firmware mapping is wrong
`upy-analyze-plugin/boards/m5stack-core.json` declares
`firmware.board_name = "M5STACK_ATOM"` (and the ATOM download URL) for a board
titled "M5Stack Core (ESP32)". Core and Atom are different devices; the mapping
would flash wrong firmware. Until corrected upstream, m5stack-core stays out of
the full-profile catalog.
```

- [ ] **Step 6: Commit**

```bash
git add mpyhw-api/app/prompt_assembly.py mpyhw-api/tests/test_llm_messages.py docs/upstream-requests.md
git commit -m "fix(api): unknown boards resolve to a loud unknown_board tier, not a bare stub (A2)"
```

---

### Task 3: A2b — Board catalog: 3 → 6 full profiles

**Files:**
- Create: `mpyhw-api/content/boards/esp32-devkit-v1.json`
- Create: `mpyhw-api/content/boards/raspberry-pi-pico.json`
- Create: `mpyhw-api/content/boards/esp8266-nodemcu.json`
- Modify: `mpyhw-api/app/routes_content.py:53-57` (`_OFFICIAL_BOARD_MAPPINGS`)
- Modify: `mpyhw-api/tests/test_content_routes.py` (add coverage test)

**Interfaces:**
- Consumes: pin facts transcribed from (a) upstream analyze-format definitions `third_party/MicroPython_Skills/upy-analyze-plugin/boards/{esp32-devkit-v1,raspberry-pi-pico,esp8266-nodemcu}.json` (READ-ONLY — read, never edit) and (b) cross-check `blockless-api/content/chips/{esp32,rp2040}.json` (read-only reference; no esp8266 chip table exists — upstream analyze JSON is the sole source there).
- Produces: `/v1/boards` lists 6 builtin profiles; the 3 new boards flip to `support_status="builtin_pin_layout"` in `/v1/micropython/boards`.

Scope note (deliberate, from recon + Codex review): a "full profile" requires an upstream analyze-format definition for the select-hw validator (`select_hw_manifest.py` reads `upy-analyze-plugin/boards/`, which we cannot edit). Upstream ships exactly 7; 3 are already served. `m5stack-core` is **excluded because of an upstream source-data mismatch, not a missing slug**: `upy-analyze-plugin/boards/m5stack-core.json:6-10` declares firmware `board_name: "M5STACK_ATOM"` for a board titled "M5Stack Core (ESP32)" — Core and Atom are different devices, and shipping that mapping would flash the wrong firmware (fail-fast: exclude + file upstream, see Task 2's `docs/upstream-requests.md` §3). So Phase A promotes the remaining 3 mappable boards — **6 full profiles total** — and the spec's other candidates stay `official_firmware_only` (recorded in `docs/upstream-requests.md`). The spec's "12-15" is unreachable without upstream edits; this is the honest maximum.

- [ ] **Step 1: Write the failing test** — append to `mpyhw-api/tests/test_content_routes.py`:

```python
def test_expanded_board_catalog_serves_six_full_profiles():
    client = TestClient(app)
    listing = client.get("/v1/boards").json()
    ids = {b["board_id"] for b in listing["builtin"]}
    assert {
        "esp32-s3-devkitc-1", "esp32-c3-devkitm-1", "rpi-pico-w",
        "esp32-devkit-v1", "raspberry-pi-pico", "esp8266-nodemcu",
    } <= ids
    for board_id in ("esp32-devkit-v1", "raspberry-pi-pico", "esp8266-nodemcu"):
        prof = client.get(f"/v1/boards/{board_id}").json()
        assert prof["pin_recommendations"]["i2c_sda"]
        assert prof["forbidden_pins"], board_id
        assert "machine" in prof["available_modules"]
```

- [ ] **Step 2: Run it to verify it fails**
Run: `python -m pytest tests/test_content_routes.py -k six_full_profiles -v`
Expected: FAIL (missing ids).

- [ ] **Step 3: Read the two source files per board, then author the three profiles.**
Read first (transcribe, don't invent): `third_party/MicroPython_Skills/upy-analyze-plugin/boards/esp32-devkit-v1.json` (fields `pin_layout.default_bus_pins`, `pin_layout.restricted_gpio`, `onboard_peripherals`) and `blockless-api/content/chips/esp32.json` (`defaults`, `reserved_pins`, per-gpio `flags`). Where the two disagree, the chip table wins for chip facts, the analyze JSON wins for board-level wiring (user memory: source-derived data wins conflicts).

`mpyhw-api/content/boards/esp32-devkit-v1.json` — shape (pin values below are the well-established DevKit V1 facts; verify each against the two sources in this step before committing):

```json
{
  "board_id": "esp32-devkit-v1",
  "display_name": "ESP32 DevKit V1 (WROOM-32)",
  "manufacturer": "Espressif (generic)",
  "pin_capabilities": {
    "GPIO2": ["gpio_out", "led_anode"],
    "GPIO21": ["gpio_in", "gpio_out", "i2c_sda"],
    "GPIO22": ["gpio_in", "gpio_out", "i2c_scl"],
    "GPIO1": ["uart_tx"],
    "GPIO3": ["uart_rx"],
    "GPIO34": ["gpio_in", "adc"],
    "GPIO35": ["gpio_in", "adc"]
  },
  "pin_recommendations": { "i2c_sda": "GPIO21", "i2c_scl": "GPIO22", "led_default": "GPIO2" },
  "forbidden_pins": ["GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO11"],
  "available_modules": ["machine", "time", "math", "json", "os", "sys", "gc", "struct", "framebuf", "neopixel", "asyncio", "network", "socket", "ssl"],
  "voltage_notes": "3.3V logic only. GPIO34-39 are input-only (no pull-ups). GPIO6-11 are the flash bus - never use."
}
```

`raspberry-pi-pico.json`: same shape; transcribe I2C/SPI/UART defaults from `blockless-api/content/chips/rp2040.json` `defaults` + restricted pins from the upstream analyze JSON; `available_modules` mirrors `rpi-pico-w.json` **minus** `network`/`socket`/`ssl` (no radio); LED = `GPIO25`; voltage_notes mentions 3.3V + GP23/24/29 internal.
`esp8266-nodemcu.json`: transcribe from the upstream analyze JSON only; recommendations `i2c_sda=GPIO4`, `i2c_scl=GPIO5`, `led_default=GPIO2` (active-low — say so in voltage_notes); forbidden GPIO6-11 (flash); modules mirror esp32 minus `asyncio`-heavy extras per the analyze JSON's `specs`.

- [ ] **Step 4: Register the official-slug mappings** — in `mpyhw-api/app/routes_content.py`, extend `_OFFICIAL_BOARD_MAPPINGS`:

```python
_OFFICIAL_BOARD_MAPPINGS = {
    "ESP32_GENERIC_C3": {"local_board_id": "esp32-c3-devkitm-1", "skill_board_id": "esp32-c3-devkitm", "chip_family": "esp32c3"},
    "ESP32_GENERIC_S3": {"local_board_id": "esp32-s3-devkitc-1", "skill_board_id": "esp32-s3-devkitc", "chip_family": "esp32s3"},
    "RPI_PICO_W": {"local_board_id": "rpi-pico-w", "skill_board_id": "raspberry-pi-pico-w", "chip_family": "rp2"},
    "ESP32_GENERIC": {"local_board_id": "esp32-devkit-v1", "skill_board_id": "esp32-devkit-v1", "chip_family": "esp32"},
    "RPI_PICO": {"local_board_id": "raspberry-pi-pico", "skill_board_id": "raspberry-pi-pico", "chip_family": "rp2"},
    "ESP8266_GENERIC": {"local_board_id": "esp8266-nodemcu", "skill_board_id": "esp8266-nodemcu", "chip_family": "esp8266"},
}
```
(`skill_board_id` must equal the upstream analyze-format filename stem — that is what select-hw loads.)

- [ ] **Step 5: Run the full backend suite**
Run: `python -m pytest`
Expected: all green, including the existing two-tier test `test_micropython_board_catalog_serves_official_cached_boards` (:54) — if it pinned PYBD_SF2 as `official_firmware_only` it still passes; if it pinned one of our newly-promoted slugs, update that assertion to a still-unpromoted slug.

- [ ] **Step 6: One shim-level select-hw sanity run per new board** (the spec's gate). From repo root:

```powershell
& "$env:USERPROFILE\.mpyhw\venv\Scripts\python.exe" third_party\MicroPython_Skills\upy-select-hw-plugin\scripts\select_hw_manifest.py --help
```
Then run its validate mode with a minimal manifest naming each new `skill_board_id` (exact invocation per `--help`; it must load the board definition without `board definition not found`). Record the three command lines + outputs in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add mpyhw-api/content/boards/ mpyhw-api/app/routes_content.py mpyhw-api/tests/test_content_routes.py
git commit -m "feat(api): promote esp32-devkit-v1, raspberry-pi-pico, esp8266-nodemcu to full board profiles (A2)"
```

---

### Task 4: A3a — Deterministic `firmware/tools` removal before quality gates

**Files:**
- Modify: `mpy-hardware-extension/python/shim/serve.py` (dispatch `_run_v0_script` :511-545 — NOT the lower-level `run_v0_python` :343; the real invocations pass `project_dir` as a JSON-RPC param, not a CLI arg)
- Modify: `mpy-hardware-extension/python/shim/test_serve.py`
- Modify: `mpyhw-api/content/v0_phase_notes/upy-generate-plugin.md` (line 6)

**Interfaces:**
- Produces: whenever the shim dispatch is asked to run `run_quality_gates.py`, it first deletes `<project>/firmware/tools/` if present (idempotent). Project dir resolution order: `params["project_dir"]` first (the real caller shape — see `test_serve.py:165`), `--project-dir` in args second. The model no longer has to be begged to do it (prompt-note line 6 becomes a factual statement).

- [ ] **Step 1: Write the failing test** — append to `mpy-hardware-extension/python/shim/test_serve.py` (follow the file's existing fixture style for invoking `run_v0_python`/the dispatch — read the neighboring `run_v0` test at :165 first and reuse its harness):

```python
def test_quality_gate_run_removes_firmware_tools_first(tmp_path):
    proj = tmp_path / "proj"
    (proj / "firmware" / "tools").mkdir(parents=True)
    (proj / "firmware" / "tools" / "flash_device.py").write_text("import subprocess\n")
    (proj / "firmware").joinpath("main.py").write_text("print('hi')\n")

    serve.prepare_quality_gate_project(str(proj))

    assert not (proj / "firmware" / "tools").exists()
    assert (proj / "firmware" / "main.py").exists()


def test_prepare_quality_gate_project_is_idempotent_and_safe_without_tools(tmp_path):
    proj = tmp_path / "proj"
    (proj / "firmware").mkdir(parents=True)
    serve.prepare_quality_gate_project(str(proj))  # no tools dir -> no-op, no raise


def test_run_v0_dispatch_removes_firmware_tools_for_quality_gates(tmp_path):
    """Dispatch-level guard: the REAL caller shape (script.run_v0 with a
    project_dir param and no --project-dir arg, mirroring test_serve.py:165)
    must trigger the cleanup."""
    proj = tmp_path / "proj"
    (proj / "firmware" / "tools").mkdir(parents=True)
    (proj / "firmware" / "tools" / "flash_device.py").write_text("import subprocess\n")
    # invoke the dispatcher exactly the way the existing run_v0 test at :165 does,
    # with script "run_quality_gates.py" and params {"project_dir": str(proj)};
    # reuse that test's harness/fixtures verbatim.
    ...
    assert not (proj / "firmware" / "tools").exists()
```

- [ ] **Step 2: Run to verify it fails**
Run (from `mpy-hardware-extension/python/shim/`): `python -m pytest test_serve.py -k quality_gate_project -v`
Expected: FAIL (`AttributeError: module 'serve' has no attribute 'prepare_quality_gate_project'`).

- [ ] **Step 3: Implement in `serve.py`** — add near `run_v0_python`:

```python
def prepare_quality_gate_project(project_dir: str) -> None:
    """Scaffold drops host-only helpers under firmware/tools/ (e.g. flash_device.py,
    which imports subprocess). The mpy_imports gate hard-fails on them. Remove the
    directory deterministically instead of asking the model to (A3a)."""
    tools_dir = os.path.join(project_dir, "firmware", "tools")
    if os.path.isdir(tools_dir):
        shutil.rmtree(tools_dir)
```

and call it inside the dispatch `_run_v0_script` (serve.py:511-545) **after script resolution, before invoking `run_v0_python`** (:545), when the resolved script name ends with `run_quality_gates.py`. Project dir: `params.get("project_dir")` first (this is what real callers send — it's also used as `cwd` at :517), else scan the args list for `--project-dir <value>`. Add `import shutil` if absent.

- [ ] **Step 4: Run shim tests** — `python -m pytest` → green.

- [ ] **Step 5: Rewrite prompt-note line 6** in `mpyhw-api/content/v0_phase_notes/upy-generate-plugin.md` — replace the "DELETE the firmware/tools/ directory … BEFORE running run_quality_gates" plea with:

```
The host removes firmware/tools/ automatically before run_quality_gates executes; you do not need to delete it. Never place device code under firmware/tools/.
```

- [ ] **Step 6: Backend tests still green** (prompt notes are content, but run `python -m pytest` in `mpyhw-api/` anyway — cheap).

- [ ] **Step 7: Commit**

```bash
git add mpy-hardware-extension/python/shim/serve.py mpy-hardware-extension/python/shim/test_serve.py mpyhw-api/content/v0_phase_notes/upy-generate-plugin.md
git commit -m "fix(shim): remove firmware/tools deterministically before quality gates (A3a)"
```

---

### Task 5: A3b — Turn-0 empty-project guard + generate_plan corrective retry

**Files:**
- Modify: `mpy-hardware-extension/src/core/protocol-loop.ts` (`runPhase` :119-183; `notify` route :239-248)
- Modify: `mpy-hardware-extension/test/protocol-loop.test.ts`

**Interfaces:**
- Consumes: existing rejection shape from `notify` (`:243-245` already rejects `phase_complete` without `result`).
- Produces: (c) a `phase_complete{result:"failed"}` that names analyze as next phase, during the generate phase **on turn 0**, is rejected with a corrective tool result instead of accepted — the loop continues (bounded by `maxTurns`); (b) when a `run_quality_gates` script result contains `GENERATE_PLAN_*` structured errors, the loop appends a deterministic corrective user message enumerating the failing entries.

- [ ] **Step 1: Read the exact current code** — `protocol-loop.ts:119-183` (turn loop; confirm the turn index variable name and how tool results are pushed) and `:239-248` (notify route; confirm the rejection return shape `{ok:false, ...}`) and `:277-293` (host route; confirm where script JSON results pass through). Adjust the snippets below to the real identifiers — behavior as specified here.

- [ ] **Step 2: Write the failing tests** — append to `test/protocol-loop.test.ts`, reusing the file's existing fake-LLM/fake-deps harness:

```ts
test("generate phase rejects a turn-0 failed bail to analyze and retries", async () => {
  // Fake LLM: turn 0 emits phase_complete{result:"failed", next_phase:"upy-analyze-plugin"},
  // turn 1 emits a normal successful phase_complete.
  // Assert: loop does NOT end failed on turn 0; the turn-0 tool result carries
  // error_kind "empty_project_hallucination"; final phase result is the turn-1 success.
});

test("quality-gate GENERATE_PLAN errors inject a deterministic corrective message", async () => {
  // Fake host script result: { ok:false, structured_errors:[{code:"GENERATE_PLAN_FILE_PATH_MISSING", path:"firmware/app/x.py"}] }
  // Assert: the next messages[] entry is a user message containing both the code and the path.
});
```
(Fill the fakes concretely from the harness's existing patterns in the same file — it already fabricates tool_use turns for the stall tests.)

- [ ] **Step 3: Run to verify both fail** — `npm test -- --test-name-pattern="turn-0|GENERATE_PLAN"` → FAIL.

- [ ] **Step 4: Implement.** In the `notify`/`phase_complete` handling, add before acceptance:

```ts
if (
  phase === "upy-generate-plugin" &&
  parsed.result === "failed" &&
  String(parsed.next_phase ?? "").includes("analyze") &&
  turn === 0
) {
  return {
    ok: false,
    error_kind: "empty_project_hallucination",
    message:
      "Rejected: scaffold already ran; the project is not empty. Use file_op list " +
      "on firmware/ to see the real tree, then continue generate. Do not bail to analyze.",
  };
}
```
(The turn index must be threaded to the handler — pass it through the same call chain `executeProtocolTool` already receives its context from; smallest change wins.)

In the host script-result path (after `runScript` returns, `:277-293`), add:

```ts
const planErrors = (result?.structured_errors ?? []).filter((e: any) =>
  String(e.code ?? "").startsWith("GENERATE_PLAN"),
);
if (planErrors.length > 0) {
  messages.push({
    role: "user",
    content: [{
      type: "text",
      text:
        "Quality gate failed on generate_plan.json. Fix exactly these entries, then re-run the gate:\n" +
        planErrors.map((e: any) => `- ${e.code}: ${e.path ?? e.message ?? ""}`).join("\n"),
    }],
  });
}
```

- [ ] **Step 5: Run the full extension suite** — `npm test` and `npm run typecheck` → green.

- [ ] **Step 6: Commit**

```bash
git add mpy-hardware-extension/src/core/protocol-loop.ts mpy-hardware-extension/test/protocol-loop.test.ts
git commit -m "fix(loop): reject turn-0 empty-project bail and inject deterministic generate_plan corrections (A3b)"
```

---

### Task 6: A3c — Approval-card race: guard + telemetry (ship guarded+logged)

**Files:**
- Modify: `mpy-hardware-extension/src/webview/webview.js` (dispatch :1486-1579, `addApprovalPrompt` :687-752)
- Modify: `mpy-hardware-extension/src/extension/session-controller.ts` (`resolvePrompt` :269-276)
- Modify: `mpy-hardware-extension/test/webview-dom.test.ts`

Recon verdict: same-card double-click is already double-guarded (webview `answered` + host Map idempotency), so per spec this ships as **guard + telemetry**, chased with live data.

- [ ] **Step 1: Write the failing tests** in `test/webview-dom.test.ts` (reuse its jsdom harness):

```ts
test("rapid double-click on an approval action posts exactly one ui_prompt_response", ...);
test("a duplicate approval_request for an already-rendered promptId does not render a second card", ...);
```

- [ ] **Step 2: Run to verify** — first likely PASSES already (the `answered` guard), second FAILS (no dedupe on render).

- [ ] **Step 3: Implement.** Webview dispatch (`:1523`): before `addApprovalPrompt`, guard:

```js
if (msg.type === "approval_request") {
  if (document.querySelector(`[data-prompt-id="${msg.promptId}"]`)) {
    console.warn("duplicate approval_request ignored", msg.promptId);
  } else {
    addApprovalPrompt(msg.promptId, msg.card);
  }
}
```
and set `card.dataset.promptId = promptId` inside `addApprovalPrompt`. Host side, `resolvePrompt` already-resolved branch: log loudly (extension OutputChannel — follow how the controller logs elsewhere) with promptId + answer, so live sessions leave a trace.

- [ ] **Step 4: Tests green** — `npm test` → green (both new tests pass).

- [ ] **Step 5: Commit**

```bash
git add mpy-hardware-extension/src/webview/webview.js mpy-hardware-extension/src/extension/session-controller.ts mpy-hardware-extension/test/webview-dom.test.ts
git commit -m "fix(webview): dedupe duplicate approval cards and log double-resolves (A3c)"
```

---

### Task 7: A3d — Split `stalled` out of `awaiting_user` + retry UI

**Files:**
- Modify: `mpy-hardware-extension/src/core/protocol-build.ts:190-194`
- Modify: `mpy-hardware-extension/src/webview/webview.js` (`session_done` :1542-1567; string tables :76/:150)
- Modify: `mpy-hardware-extension/test/protocol-build.test.ts`, `mpy-hardware-extension/test/webview-dom.test.ts`

**Interfaces:**
- Produces: new terminal literal `"stalled"` flows `protocol-build` → `session-controller` (forwards verbatim, no change) → webview. `awaiting_user` remains for genuine incomplete-but-clean hand-backs.

- [ ] **Step 1: Failing tests.** `protocol-build.test.ts`: a run whose loop returns `stalled` yields `terminal === "stalled"` (today: `awaiting_user`). `webview-dom.test.ts`: `session_done{terminal:"stalled"}` renders a visible "stuck" activity line AND a retry card; `session_done{terminal:"awaiting_user"}` renders neither error nor retry (current behavior locked in).

- [ ] **Step 2: Run to verify both fail.**

- [ ] **Step 3: Implement.** `protocol-build.ts:190-194`:

```ts
const terminal =
  result.terminal === "complete" ? "complete"
  : result.terminal === "cancelled" ? "cancelled"
  : result.terminal === "failed" ? "failed"
  : result.terminal === "stalled" ? "stalled"
  : "awaiting_user";
```
Webview `session_done` block: add before the generic handling:

```js
if (t === "stalled") {
  addActivity({ text: tr("session_stuck") });
  addRetryCard();
}
```
keep `stalled` out of `isError` (it has its own lane). String tables: `term_stalled: "Build got stuck"` / `"构建卡住了"`, `session_stuck: "The build got stuck mid-way — this is usually transient. Click retry."` / `"构建中途卡住了——通常是暂时性的，点击重试。"`.

- [ ] **Step 4: Full suite green** — `npm test`, `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add mpy-hardware-extension/src/core/protocol-build.ts mpy-hardware-extension/src/webview/webview.js mpy-hardware-extension/test/protocol-build.test.ts mpy-hardware-extension/test/webview-dom.test.ts
git commit -m "fix(ux): stalled builds say so and offer retry instead of masquerading as awaiting_user (A3d)"
```

---

### Task 8: A4a — `/v1/admin/usage` + cost-estimate constant

**Files:**
- Modify: `mpyhw-api/app/analytics.py` (new `usage_rollup`)
- Modify: `mpyhw-api/app/routes_admin.py` (new route)
- Create: `mpyhw-api/tests/test_admin_usage.py`

**Interfaces:**
- Produces: `GET /v1/admin/usage?days=7` (header `X-Admin-Token`) → `{"days": 7, "est_usd_per_credit": <float>, "rows": [{"date": "2026-07-04", "user_id": "...", "turns": 3, "total_tokens": 41210, "credits_charged": 5, "est_cost_usd": 0.07}, ...]}` grouped per day per user, newest first.

- [ ] **Step 1: Failing test** — `mpyhw-api/tests/test_admin_usage.py` (copy the admin-token fixture style from `test_credits.py` / existing admin tests):

```python
def test_admin_usage_rolls_up_llm_turns_per_day_per_user(admin_client, seeded_llm_turns):
    resp = admin_client.get("/v1/admin/usage?days=7", headers={"X-Admin-Token": "test-admin"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["rows"], "expected at least one rollup row"
    row = body["rows"][0]
    assert set(row) == {"date", "user_id", "turns", "total_tokens", "credits_charged", "est_cost_usd"}
    assert row["est_cost_usd"] == round(row["credits_charged"] * body["est_usd_per_credit"], 4)


def test_admin_usage_requires_admin_token(client):
    assert client.get("/v1/admin/usage").status_code == 401
```
(Seed helper: insert 2-3 rows via `analytics.record_llm_turn(...)` with distinct users/days.)

- [ ] **Step 2: Run to verify it fails** — `python -m pytest tests/test_admin_usage.py -v` → 404/AttributeError.

- [ ] **Step 3: Implement.** `analytics.py`:

```python
# Rough cost model for /v1/admin/usage. 1 credit == 10_000 billable tokens
# (credit_store.CREDIT_TOKENS); billable already discounts DeepSeek cache hits
# via MPYHW_CACHE_HIT_WEIGHT (default 0.1, ~85-99% observed hit rate on later
# rounds — see routes_llm._billable_tokens). Estimate is env-tunable, NOT a bill.
EST_USD_PER_CREDIT = float(os.getenv("MPYHW_EST_USD_PER_CREDIT", "0.014"))


def usage_rollup(days: int) -> list[dict[str, Any]]:
    """Per-day per-user rollup of llm_turns. db.fetchall returns dict rows;
    use ? placeholders (db._sql rewrites them to %s)."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with db.connect() as conn:
        rows = db.fetchall(
            conn,
            """
            SELECT substr(started_at, 1, 10) AS day, user_id,
                   COUNT(*) AS turns,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COALESCE(SUM(credits_charged), 0) AS credits_charged
            FROM llm_turns
            WHERE started_at >= ?
            GROUP BY substr(started_at, 1, 10), user_id
            ORDER BY day DESC, user_id
            """,
            (since,),
        )
    return [
        {
            "date": r["day"], "user_id": r["user_id"], "turns": r["turns"],
            "total_tokens": r["total_tokens"], "credits_charged": r["credits_charged"],
            "est_cost_usd": round(r["credits_charged"] * EST_USD_PER_CREDIT, 4),
        }
        for r in rows
    ]
```
(Match the exact connection idiom `metrics_snapshot` at `analytics.py:221-292` uses — it already calls `db.fetchall`/`db.fetchone` on a connection; reuse the same acquire/release shape. Ensure `os` and `timedelta` are imported at the top of `analytics.py` — `timedelta` is currently absent.) `routes_admin.py`:

```python
@router.get("/v1/admin/usage")
def usage(days: int = 7, _: None = Depends(require_admin)) -> dict:
    days = max(1, min(days, 90))
    return {"days": days, "est_usd_per_credit": analytics.EST_USD_PER_CREDIT, "rows": analytics.usage_rollup(days)}
```

- [ ] **Step 4: Full backend suite green** — `python -m pytest`.

- [ ] **Step 5: Commit**

```bash
git add mpyhw-api/app/analytics.py mpyhw-api/app/routes_admin.py mpyhw-api/tests/test_admin_usage.py
git commit -m "feat(api): read-only /v1/admin/usage rollup with documented cost estimate (A4)"
```

---

### Task 9: A4b — Per-user daily credit cap (env-tunable, off by default)

**Files:**
- Modify: `mpyhw-api/app/credit_store.py` (new `user_spend_today`)
- Modify: `mpyhw-api/app/routes_llm.py` (preflight check in `llm_messages`, next to the global-budget check :178-191)
- Modify: `mpy-hardware-extension/src/webview/webview.js` (error string + handler branch at :1539)
- Modify: `mpyhw-api/tests/test_credits.py`, `mpy-hardware-extension/test/webview-dom.test.ts`

**Interfaces:**
- Produces: env `MPYHW_DAILY_USER_CAP` (credits/day/user; `0`/unset = off). Over cap → HTTP 402 `{"error": "daily_cap_reached", "resets_at": ...}`. Distinct from the grant: the cap binds even when an admin has topped up balance. Webview renders a dedicated message.

- [ ] **Step 1: Failing tests.** Backend (`test_credits.py`, mirror `test_llm_messages_returns_402_when_out_of_credits` at :101):

```python
def test_llm_messages_returns_402_daily_cap_reached_when_user_cap_hit(monkeypatch, ...):
    monkeypatch.setenv("MPYHW_DAILY_USER_CAP", "3")
    # seed: user has balance 50 but has already been charged 3 credits today
    ...
    assert response.status_code == 402
    assert response.json()["detail"]["error"] == "daily_cap_reached"


def test_daily_cap_disabled_by_default(...):  # cap unset -> normal flow
```
Webview: `session_error{error:"daily_cap_reached"}` renders the dedicated string (assert in `webview-dom.test.ts`).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `credit_store.py` — **NOT** a mirror of `global_spend_today` (:226): that reads `daily_global_spend`, which has no user column (`db.py:162-165`). Per-user spend must come from `credit_ledger` (`db.py:144-151`). Verified ledger sign semantics: `debit` and `reserve` insert **negative** `credits`, `refund` inserts positive, `grant`/`admin_set` are excluded (see `_ledger` call sites at `credit_store.py:120-280`). So:

```python
def user_spend_today(user: dict, now: datetime | None = None) -> int:
    """Net credits this user spent since UTC midnight, from credit_ledger.
    debit/reserve rows are negative, refund positive; grant/admin_set excluded.
    Floor at 0 (a refund-heavy day must not go negative)."""
    now = now or datetime.now(timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    uid = str(user["id"])
    with db.connect() as conn:
        row = db.fetchone(
            conn,
            """
            SELECT COALESCE(SUM(credits), 0) AS net
            FROM credit_ledger
            WHERE user_id = ? AND created_at >= ?
              AND action IN ('debit', 'reserve', 'refund')
            """,
            (uid, midnight),
        )
    return max(0, -int(row["net"]))
```
(Follow the module's existing connection idiom — see `global_spend_today` / `ledger_for_user` (:292) for the acquire shape.)
`routes_llm.py`, immediately after the global-budget block (:178-191):

```python
    user_cap = int(os.getenv("MPYHW_DAILY_USER_CAP", "0") or 0)
    if user_cap > 0 and credit_store.user_spend_today(user) >= user_cap:
        llm_sessions.release(session_id, "daily_cap_reached")
        raise HTTPException(
            status_code=402,
            detail={"error": "daily_cap_reached", "resets_at": state["resets_at"]},
        )
```
Webview strings: `err_daily_cap_reached: "Daily limit reached — resets at midnight UTC"` / `"今日额度已达上限——UTC 午夜重置"`; handler branch beside the `out_of_credits` one (:1539).

- [ ] **Step 4: Both suites green** — backend `python -m pytest`; extension `npm test`.

- [ ] **Step 5: Commit**

```bash
git add mpyhw-api/app/credit_store.py mpyhw-api/app/routes_llm.py mpyhw-api/tests/test_credits.py mpy-hardware-extension/src/webview/webview.js mpy-hardware-extension/test/webview-dom.test.ts
git commit -m "feat(api): env-tunable per-user daily credit cap with a clear error card (A4)"
```

---

### Task 10: A5 — Marketplace material (README, CHANGELOG, novice guide, acceptance checklist)

**Files:**
- Modify: `mpy-hardware-extension/README.md:45-49` (Requirements)
- Modify: `mpy-hardware-extension/CHANGELOG.md`
- Modify: `docs/新手测试指南.md:115` and `:197` (the two 〔待填〕 holes)
- Create: `docs/real-board-acceptance.md`

- [ ] **Step 1: README Requirements** — replace the two-bullet section with (keep the file's bilingual EN/中文 pattern — mirror in both halves):

```markdown
## Requirements

- A GitHub account (sign-in and daily free credits).
- **Python 3.10+** on PATH (the extension creates its own tool venv at `~/.mpyhw/venv` on first run).
- A network that can reach **GitHub and micropython.org** (firmware and driver downloads).
- For deployment: a MicroPython-capable board over USB. Full pin-aware support:
  ESP32 DevKit V1 · ESP32-S3 DevKitC-1 · ESP32-C3 DevKitM-1 · ESP8266 NodeMCU ·
  Raspberry Pi Pico · Pico W. Other official MicroPython boards work in
  firmware-only mode (you confirm wiring yourself).
- Windows: install the USB-serial driver your board needs (usually CP210x or CH340).
```

- [ ] **Step 2: CHANGELOG entry** — prepend:

```markdown
## 0.4.0

- 6 boards with full pin-aware profiles (was 3): + ESP32 DevKit V1, Raspberry Pi Pico, ESP8266 NodeMCU.
- Stuck builds now say "Build got stuck" with a one-click retry (previously silent).
- Generate phase is more reliable: deterministic cleanup before quality gates, turn-0 hallucination guard, precise gate-failure corrections.
- Pinned Python toolchain — quality gates no longer drift with upstream lint releases.
- Per-user daily cap support + admin usage rollup (server-side).
```

- [ ] **Step 3: Fill the two 〔待填〕 holes** in `docs/新手测试指南.md`: line 115 (network) → "需要能访问 GitHub 与 micropython.org 的网络环境（校园网/公司网若拦截 GitHub，请先自行确认可打开 github.com）。"; line 197 (feedback) → "反馈渠道：GitHub Issues — https://github.com/FreakStudioCN/mpy-hardware-extension/issues （附上「诊断」面板的复制内容）。"

- [ ] **Step 4: Real-board acceptance checklist** — `docs/real-board-acceptance.md`, one page: board models (the 6 full-profile boards), per-step command sequence (install VSIX → Doctor 4-item checkup → pick board → one-sentence idea → approve cards → flash → deploy → observe), the expected observation at each step, and "what to send back on failure" (Doctor copy button output + the `~/.mpyhw/logs` path + trace_id). Write it as the user-facing hand-over the spec requires.

- [ ] **Step 5: Commit**

```bash
git add mpy-hardware-extension/README.md mpy-hardware-extension/CHANGELOG.md docs/新手测试指南.md docs/real-board-acceptance.md
git commit -m "docs: honest marketplace requirements, 0.4.0 changelog, novice-guide holes, acceptance checklist (A5)"
```

---

### Task 11: A6 — Code-shape assertion + golden-path matrix + publish preflight

**Files:**
- Create: `mpy-hardware-extension/scripts/assert-code-shape.mjs`
- Create: `mpy-hardware-extension/scripts/golden-path-matrix.mjs`
- Modify: `mpy-hardware-extension/package.json` (two script entries + version bump `0.3.12` → `0.4.0`)

**Interfaces:**
- Consumes: `e2e-protocol-v0.ts` takes the idea as argv (`:33`, `process.argv.slice(2).join(" ")`); `run_quality_gates.py` JSON output (`ok`, `structured_errors`); the quality-gate count is asserted via `ok === true`, **never** a hardcoded "16" (upstream may add/remove a check).

- [ ] **Step 1: Write `assert-code-shape.mjs`** — takes `--project-dir`, exits non-zero with a reason list on any failure:

```js
// Checks (each prints PASS/FAIL):
// 1. tree: firmware/main.py, firmware/conf/, generate_plan.json exist; firmware/tools/ absent
// 2. scheduler API: firmware/**/*.py contains add_task(, contains NO register(
// 3. imports: run check_mpy_imports.py via ~/.mpyhw/venv python; require ok:true
// 4. gates: run run_quality_gates.py --project-dir <dir>; require JSON ok === true && structured_errors.length === 0
// 5. manifest: every path listed in generate_plan.json exists on disk
```
Implement all five concretely (fs walks + `child_process.execFileSync` on the venv python; script paths under `third_party/MicroPython_Skills/upy-generate-plugin/scripts/`).

- [ ] **Step 2: Write `golden-path-matrix.mjs`** — loops `IDEAS × RUNS`:

```js
const IDEAS = [
  "a temperature logger that prints readings every 5 seconds",       // sensor
  "a scrolling text banner on an SSD1306 OLED",                      // display
  "a servo that sweeps back and forth continuously",                 // actuator
];
const RUNS = Number(process.env.MATRIX_RUNS ?? 5);
// per run: spawn `npm run e2e:v0 -- "<idea>"` with a fresh temp project dir,
// then spawn assert-code-shape.mjs on the produced dir; collect pass/fail,
// print a matrix table, exit non-zero if ANY cell failed.
```
Add package.json scripts: `"code-shape": "node scripts/assert-code-shape.mjs"`, `"golden-matrix": "node scripts/golden-path-matrix.mjs"`.

- [ ] **Step 3: Smoke the harness cheaply** — run `assert-code-shape.mjs` against a scaffold-only fixture (expect FAIL with the reason list — proves it detects), and one single `e2e:v0` run (needs local stack via the dev-up skill + `MPYHW_DEV_JWT` + real DeepSeek key) followed by `code-shape` (expect PASS).

- [ ] **Step 4: Run the full matrix** — `npm run golden-matrix` (15 real LLM runs; walk away, do not parallelize — memory: parallel walkthroughs 429). Record the matrix table in the commit body. If the environment lacks the JWT/key, stop and hand the exact command to the user instead of faking a result.

- [ ] **Step 5: Version bump + publish preflight** — set `"version": "0.4.0"` in `package.json`; run the publish-extension skill in **check** mode (submodule intact → prod health → typecheck → test → package). All green = ready.

- [ ] **Step 6: Commit**

```bash
git add mpy-hardware-extension/scripts/ mpy-hardware-extension/package.json
git commit -m "feat(verify): code-shape assertion + golden-path matrix; bump 0.4.0 (A6)"
```

---

### Task 12: Publish (user-confirmed)

- [ ] **Step 1:** Push main; confirm CI green (extension + api + content-freshness jobs).
- [ ] **Step 2:** Ask the user to confirm the actual publish (hard rule of the publish-extension skill), then tag:

```bash
git tag v0.4.0
git push origin v0.4.0
```
CI job `publish-extension` publishes with `VSCE_PAT`.
- [ ] **Step 3:** Verify `https://marketplace.visualstudio.com/items?itemName=blockless.mpy-hardware-extension` shows 0.4.0; install into a clean VS Code; Doctor's 4-item checkup runs.

---

## Deliberate scope decisions (surface these to the reviewer)

1. **A2 delivers 6 full profiles, not 12-15** — hard-blocked by the read-only upstream analyze-format catalog (7 boards; m5stack-core excluded because its upstream firmware mapping points at M5STACK_ATOM, a different device). Remainder recorded in `docs/upstream-requests.md`.
2. **A3a fixes the subprocess false-positive by deterministic removal, not allowlist widening** — the allowlist is upstream; widening is filed as an upstream request.
3. **A4's cap is credits-based and off by default** (`MPYHW_DAILY_USER_CAP=0`) — turning it on is an ops decision, not a code default.
4. **"16 gates" is asserted as `ok === true`,** never a hardcoded count (the runner emits up to 19 keys; 16 is the informal blocking-set count).
5. **The 15-run matrix costs real DeepSeek tokens** and needs `MPYHW_DEV_JWT` + the local stack; if unavailable at execution time the harness still lands and the user runs the matrix as acceptance.
