# Blockless Competitor Benchmark

This benchmark turns the Blockless clarity research into executable evidence.
It is intentionally adversarial: the goal is to find where the narrative breaks,
not to confirm the deck.

## What This Tests

Blockless should not win because an LLM can write code. The benchmark tests
whether a system can close the physical hardware loop:

1. Understand the user's hardware intent.
2. Select compatible board, module, driver, pins, and package versions.
3. Produce wiring and code.
4. Install dependencies, flash, and run on a real device.
5. Read serial/run logs.
6. Repair failures.
7. Produce a reusable recipe that another user can rerun.

## P0 Systems

Run these first because they most directly test the main claim:

1. `blockless`
2. `chatgpt_cursor_platformio`
3. `pleasedontcode`
4. `tutorial`

P1 systems: `wokwi`, `cirkit`, `embedr`, `aily_blockly`.

P2 systems: `schematik`, `tinkercad`, `makecode`, `visuino`, `mindplus`,
`mixly`, `other`.

IoT/app-control systems are gate-specific, not optional trivia:
`esphome`, `tasmota`, `arduino_cloud`, `blynk`, `particle_workbench`,
`node_red`, `adafruit_io`, `ubidots`, and `home_assistant` must be used before
claiming Blockless owns sensor events, dashboards, OTA, automations, or
device-app workflows.

Vendor/platform systems are also gate-specific. Run `platformio`,
`arduino_cli`, `arduino_ide`, `arduino_app_lab`, `esp_idf`,
`espressif_vscode`, `esp_claw`, `espressif_docs_mcp`, `espressif_docs_ai`,
`vendor_docs_ai`, and `vendor_tutorial_conversion` before claiming Blockless
owns board/module context, IDE distribution, toolchain setup, or vendor-data
advantage. These baselines test whether official docs, official IDEs,
vendor AI/MCP surfaces, and generic agents already solve the workflow well
enough.

Edge-AI and production-IoT systems are task-specific baselines. Run
`edge_impulse` or `sensecraft` before claiming Blockless owns AI-on-hardware,
vision, sound, anomaly, no-code edge AI, or hardware vibe-coding workflows. Run
`viam` before claiming robotics lifecycle, machine API, driver/model registry,
remote-control, or robot-fleet value. Run `blues_notehub`, `golioth`,
`thingsboard`, `hologram`, `losant`, `zerynth`, or
`espressif_rainmaker_mcp` before claiming Blockless owns connected-product,
fleet, cellular/satellite/LoRa/Wi-Fi, device monitoring, device-cloud control,
industrial IoT, app-enablement, or production IoT workflow value. Run
`microblocks` or `xod` before claiming Blockless owns live hardware iteration,
visual/no-code physical computing, or no-compile/no-download workflows.

## How To Run

Start with `p0-runbook.md` for the first adversarial benchmark batch.
For the first temperature-control run, fill
`task-01-p0-preregistration.md` before opening any benchmark system.
Before moving any benchmark result into a deck, check `claim-gate-matrix.json`
against `claim_gate_matrix.schema.json`; the matrix records which claims remain
allowed, benchmark-gated, market-gated, or forbidden.
Before shipping deck edits, scan the deck with `scan_deck_claims.py` and
`claim-scan-patterns.json`.

1. Pick a task from `tasks.json`.
2. Create a run folder:
   `benchmark_runs/YYYY-MM-DD-system-task-id/`
3. Copy `run-sheet.md` into the run folder.
4. Save every artifact: prompts, screenshots, generated code, wiring diagrams,
   package files, flash logs, serial logs, repair attempts, and final recipe.
5. Fill a `result.json` that conforms to `result.schema.json`.
6. After each batch, update the research memo's claim maturity table.

Validate each result before citing it:

```powershell
python docs\research\blockless-benchmark\validate_result.py benchmark_runs\YYYY-MM-DD-system-task-id\result.json
```

Passing validation only proves the evidence packet is structurally complete.
It does not prove Blockless, or any competitor, worked.

Validate the claim gate matrix after edits:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\claim_gate_matrix.schema.json docs\research\blockless-benchmark\claim-gate-matrix.json
```

Claim-gate validation is only a structure check. It does not graduate a claim;
it makes the missing benchmark or market proof explicit.

Validate scan patterns and scan the current English deck:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\claim_scan_patterns.schema.json docs\research\blockless-benchmark\claim-scan-patterns.json
python docs\research\blockless-benchmark\scan_deck_claims.py docs\pitch\deck\deck_en.md --fail-on benchmark_gated
```

Use the fixture to verify the scanner still catches bad language:

```powershell
python docs\research\blockless-benchmark\scan_deck_claims.py docs\research\blockless-benchmark\examples\forbidden-claim-deck.example.md --expect-findings
```

`examples/blocked-access-result.example.json` is a validator fixture and is not
benchmark evidence.

Market behavior signals use `market_signal.schema.json`:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_signal.schema.json docs\research\blockless-benchmark\examples\no-commitment-market-signal.example.json
```

Market-signal validation only proves structure. Compliments, curiosity, and
"sounds useful" are not paid/repeat-use evidence unless the signal records a
concrete behavior or commitment.

Summarize batches of market signals with `market_cohort.schema.json`:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_cohort.schema.json docs\research\blockless-benchmark\examples\insufficient-market-cohort.example.json
```

Cohort validation forces denominators, segment mix, support burden, follow-up,
claim permissions, and basic count consistency into the record. It still does
not prove market demand; the summary must show enough repeated behavior,
reruns/forks, and commitments before the deck can use appstore, subscription,
or Cursor-like market language.

## Evidence Standard

Marketing pages and demos can identify competitors, but they do not prove
workflow superiority. A claim only graduates when the benchmark captures:

- elapsed time;
- number of manual interventions;
- failure taxonomy labels;
- serial/run/flash logs;
- reproducibility by a second user;
- whether the produced artifact can be forked or rerun.

Use `verified-recipe-spec.md` and `recipe.schema.json` to decide whether a
produced artifact is actually a verified recipe.

For IoT/app-control runs, also record whether the artifact is a YAML config,
cloud template, dashboard, flow, firmware binary, or verified recipe. A working
dashboard is not the same as a rerunnable hardware recipe.

For vendor/platform runs, record whether the artifact is an IDE project,
PlatformIO project, Arduino project, App Lab project, ESP-IDF project,
ESP-Claw project, MCP interaction transcript, vendor docs answer, RainMaker
device project, vendor tutorial, or verified recipe. A clean official project
or useful MCP answer is not automatically a reusable recipe unless the second
tester receives enough context to rerun it.

For edge-AI and production-IoT runs, record whether the artifact is a model
bundle, robotics machine project, device fleet project, industrial IoT app,
connectivity project, dashboard, deployment template, visual blocks project,
dataflow hardware project, or verified recipe. A deployed model, monitored
fleet, dashboard, visual program, or industrial app proves a different workflow
than a second-user-rerunnable hardware recipe.

## Stop Conditions

Stop calling a claim "validated" if any of these happens:

- the system cannot run on real hardware;
- the user must manually debug wiring, pins, package versions, or flash errors;
- the output is a tutorial rather than a rerunnable recipe;
- a second user cannot reproduce the result from the saved artifact;
- a closer competitor performs the same loop with less friction.
