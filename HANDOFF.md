# HANDOFF

> Last updated: 2026-06-01 (session: code-review fixes + device-library connect + agent-UX redesign)
> Workspace: `C:\Users\Haipeng Wu\Desktop\cursor_for_hardware`
> Three roots: `mpyhw-api/` (FastAPI backend), `mpy-hardware-extension/` (VS Code extension), `docs/`.

## Goal

MicroPython "one-sentence-to-hardware" agent MVP. Product path:
`intent -> capabilities -> API Package Intelligence -> driver context -> manifest -> code -> audit -> shim loop -> serial observation -> repair`.

This session's focus was driven by the user (product owner) hitting real problems while test-driving the live app: a non-hardware request death-looped, the agent refused instead of asking, only one board / one device existed, and an `ask_user` confirm couldn't be answered. Work shifted from "plan execution" to **making the running product actually work and connecting the real device library**.

## First Action On Resume

The API server was restarted at end of session and is running as a **background task** (`uvicorn app.main:app` on `127.0.0.1:8787`, `.env` loaded). If resuming in a new process, assume it is NOT running and restart:

```powershell
cd mpyhw-api ; .\scripts\serve.ps1   # loads .env (DEEPSEEK_API_KEY), starts uvicorn on 8787
```

Run both test suites before changing anything (baseline must be green):
```powershell
cd mpy-hardware-extension ; node --no-warnings --experimental-strip-types test/all.test.ts   # 77 pass
cd mpyhw-api ; python -m pytest -q                                                            # 49 pass
cd mpy-hardware-extension\python\shim ; python -m pytest -q                                   # 6 pass
```

## Current State (this session's deltas)

**Device library is now real (was a single AHT20 fixture):**
- Connected the **live upypi.net registry**. New `ingest_upypi.py --live` sweeps `/api/search` by capability term, fetches each `package.json` + source, and writes `content/packages/package_index.json`. Catalog: **2 -> 28 real devices** (ssd1306, mpu6050, bmp280, dht11, relay, neopixel, servos, ads1115, tcs34725 color, mpr121, ...).
- Improved `infer_capabilities` (package_store.py): 4 -> 13 capability types, so the catalog is searchable by capability.
- **Driver-context depth: 3 -> 10 generatable devices.** Improved `extract_driver_context` (normalize_driver_context.py) to detect multi-arg I2C constructors (`SSD1306_I2C(i2c, addr, ...)`), prioritize the driver's own module in `import_names`, and extract public methods. Generatable now: aht20_driver, ssd1306, graftsense_aht20, ssd1306_driver, mpu6050_driver, bmp280(_driver), tcs34725_color_driver, ads1115_driver, mpr121.
- **Boards: 1 -> 3.** Added `content/boards/rpi-pico-w.json` and `esp32-c3-devkitm-1.json` (esp32-s3 was the only one).

**Agent UX / behavior fixes:**
- Removed the `<not_hardware>` refusal mechanism everywhere (sse-client.ts, agent-loop.ts, webview, routes_llm.py prompt, routes_telemetry.py enum). It was buggy (split-token detection) and wrong product-wise.
- **Death-loop fix:** a turn with no tool call no longer spins to max_turns. `agent-loop.ts` now nudges once then yields `awaiting_user` (uses `state.textOnlyTurns`, initialized in session-state.ts).
- **System prompt** (routes_llm.py): hard rule — any time the model needs the user to choose/confirm/answer it MUST call `ask_user` (renders an answerable input), NEVER a plain-text question. Plus: ambiguous/seemingly-non-hardware requests -> clarify via ask_user, don't refuse.
- **Requirement-first opening** (`buildOpening` in agent-backed-loop.ts): clarify WHAT to build before hardware; board handling = use chosen / auto-adopt the only one / recommend+confirm among several.
- Concurrent edit (kept): multi-turn conversation continuity via `input.state` reuse in agent-backed-loop.ts.

**Also this session — a full code review** found and fixed 10 bugs (serial-read error_kind so repair loop works; quota now server-authoritative not client-trusted; manifest pin-capability gate runs in the real agent path; codegen fails loudly on missing pin instead of `Pin()`; client `safeJson` after ok-check; serial_read_until buffers split fragments; flash path `main.py`; package_index records normalized on load; boards listing skips malformed file). All have regression tests.

## What Worked

- Probing upypi.net directly (`curl /api/search?q=...`, `/pkgs/<name>/<ver>/package.json`) before coding the ingest — confirmed the real API shape and that the registry is live.
- Improving the extractor + re-ingesting (reset index to baseline first, then `--live`) to regenerate driver contexts — turned "listed/installable" into "generatable" for I2C sensors.
- Diagnosing "fix doesn't work" as **stale deployed artifacts**: the extension runs from `dist/extension/activate.cjs` (esbuild bundle), and uvicorn holds the prompt in memory — neither picks up `src/` edits without rebuild/restart. Verified via bundle mtime + `grep` of the bundle.
- Content (`content/packages`, `content/boards`) is read from disk per request, so catalog/board changes are live WITHOUT restarting the server; only code (prompt) changes need a restart.

## What Did NOT Work / Gotchas

- `node --test test/*.test.ts` hits sandbox `spawn EPERM`; use `node --no-warnings --experimental-strip-types test/all.test.ts`.
- `Start-Process powershell -File serve.ps1 -WindowStyle Hidden` did not stick; starting uvicorn directly in a background task (after loading `.env`) worked.
- A concurrent process/linter is actively editing files this session (agent-loop.ts, serve.py, test files, etc.). The first combined test run was a mid-rewrite snapshot (false failures); re-running clean was green. **If tests fail oddly, re-run before debugging.**
- `extract_driver_context` is I2C-centric: GPIO/OneWire/SPI drivers (relay, ds18b20, led) get NO context yet -> they stay `installable`, not `generatable`.
- upypi `/api/pkgs` (full listing) returns 500; discovery must sweep `/api/search` by keyword, so the catalog is only as complete as `DISCOVERY_TERMS` in ingest_upypi.py.

## Next Steps

1. **GraftSense modules -> profiles (BLOCKED on data).** `dev/extracted/开发生产宣传SOP.md` lists the GraftSense module line (Grove-based; RCWL-9623 ultrasonic, etc.) but only as names/process docs — no machine-readable pin/driver specs. Need a spec table from the user, or derive from the matching upypi driver. Ask the user where to get specs.
2. **Driver-context for non-I2C devices** (GPIO/OneWire/SPI) so relay/led/ds18b20 become generatable, not just installable.
3. **Re-test the live agent UX** after the user reloads the VS Code window (new bundle) — confirm "造个 AI 女朋友" now pops an `ask_user` input instead of refusing/looping, and that requirement-first + board recommend works across the 3 boards.
4. Expand `DISCOVERY_TERMS` / add a fuller upypi catalog sweep.
5. Real hardware gate still unreached: `mpy-hardware-extension/scripts/smoke-hardware.ps1 -Port COM3` with ESP32-S3 + AHT20 + LED. Promote AHT20 `generatable -> verified` only after that passes.

## Key Files Touched This Session

API: `app/routes_llm.py` (prompt), `app/routes_quota.py` (server-side quota), `app/package_store.py` (infer_capabilities, record normalization), `app/routes_content.py` (boards robustness), `scripts/ingest_upypi.py` (live ingest), `scripts/normalize_driver_context.py` (extractor), `content/packages/package_index.json` + `content/packages/driver_context/*` (regenerated), `content/boards/{rpi-pico-w,esp32-c3-devkitm-1}.json` (new).
Extension: `src/core/{agent-loop,agent-backed-loop,sse-client,manifest-schema,codegen,manifest-builder,api-client,board-client,package-client,pipeline}.ts`, `src/webview/index.html`, `python/shim/serve.py`. Bundle rebuilt: `dist/extension/activate.cjs` (run `node scripts/build-extension.mjs` after src changes).

## User Preferences / Constraints

- Product correctness over plan/spec fidelity; plans can be wrong.
- Be honest about what's verified vs. stale/untested — the user explicitly distrusts "tests pass" when the running app is broken (it was a stale bundle/server).
- Surgical edits; surface tradeoffs; don't revert unrelated dirty files in docs/ or dev/.
- The user is the product owner (CEO). Anti-abuse is a stated pillar, but the `<not_hardware>` refusal specifically was removed in favor of ask_user clarification.
- Replies to this user can be in Chinese.
