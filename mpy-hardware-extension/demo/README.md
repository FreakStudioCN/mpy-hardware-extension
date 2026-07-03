# Offline end-to-end demo

Runs the full **"一句话 → 运行中的硬件"** six-stage flow with **no backend, no API
keys and no board attached** — so anyone can see the pipeline work in one command.

```bash
npm run demo:e2e "温度超过30度就点亮LED"
# or:  npm run demo:e2e "turn on the LED when temperature is over 30"
# board override:  MPYHW_DEMO_BOARD=rpi-pico-w npm run demo:e2e "blink the onboard LED"
```

It walks the six skills in order and prints the real artifacts at each step:

| Stage | Skill | What runs |
|------|-------|-----------|
| 1 | `upy-analyze-plugin` | `extractCapabilities()` on the intent |
| 2 | `upy-select-hw-plugin` | ranked package resolution + board profile |
| 3 | `upy-flash-mpy-firmware-plugin` | firmware target for the board |
| 4 | `upy-scaffold-plugin` | project skeleton |
| 5 | `upy-generate-plugin` | **real MicroPython codegen** + static audit |
| 6 | `upy-deploy-plugin` | labelled device simulator replays the serial contract |

Artifacts are written to `tmp/demo/` (`main.py`, `manifest.json`, `serial.log`).

## What is real vs simulated

- **Real:** capability analysis, package/board resolution, driver-context lookup,
  MicroPython codegen, static audit — all the production pipeline code paths
  (`src/core/*`), driven by a static snapshot of the production catalog.
- **Simulated:** the final device stage (`src/demo/device-simulator.ts`) — no board
  is attached, so it replays the firmware's own serial contract (`MPYHW_READY`,
  `TEMP_C=<v> LED=<ON|OFF>`) over an illustrative sensor sweep, deciding LED state
  from the **real threshold** in the generated manifest. It does not execute the
  generated Python.

The offline path covers the deterministic golden path only. Live LLM codegen for
arbitrary intents, real firmware flashing, and retry/checkpoint/autofix run against
the production backend (`createProtocolLoop`), not this snapshot.

## Fixtures

`demo/fixtures/` is a static snapshot of the real mpyhw-api catalog, produced by
importing the production `PackageStore` — not a hand-authored mock:

```bash
npm run demo:fixtures   # regenerates from ../mpyhw-api/content
```

- `catalog.json` — all normalised package records (drives ranking)
- `boards/*.json` — board profiles (`/v1/boards/{id}` serves these verbatim)
- `driver-contexts/*.json` — real `get_driver_context()` output per package
- `resolve-golden.json` — the Python `resolve()` output for the demo intents

The offline ranking in `src/demo/offline-catalog.ts` is a faithful port of
`mpyhw-api/app/package_store.py` (`_ranked` / `resolve`). `resolve-golden.json` is
the oracle that `test/offline-demo.test.ts` checks the port against, so the two can
never silently drift.
