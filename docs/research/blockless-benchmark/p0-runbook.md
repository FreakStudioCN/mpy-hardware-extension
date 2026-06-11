# P0 Benchmark Runbook

Date: 2026-06-11

Purpose: run the minimum benchmark needed before claiming Blockless beats
tutorials, generic AI plus PlatformIO/Arduino CLI, agentic IDE/CLI workflows,
or PleaseDontCode.

This runbook is intentionally adversarial. It should make weak Blockless claims
fail early.

## P0 Question

> On the same real hardware tasks, does Blockless produce a working, repairable,
> second-user-rerunnable hardware recipe with less friction than the strongest
> available alternatives?

## Systems To Run

Run these in order:

1. `blockless`
2. `chatgpt_cursor_platformio`
3. `agentic_ide_cli`
4. `pleasedontcode`
5. `tutorial`

Optional after P0:

- `wokwi`
- `cirkit`
- `esphome`

## Required Tasks

Use these tasks from `tasks.json`:

1. `task-01-temperature-fan`
2. `task-03-agent-status-display`
3. `task-04-sensor-events-app`
4. `task-10-bad-pin-repair`

Run `task-08-publish-recipe` and `task-09-rerun-recipe` immediately after the
first task that succeeds in each system, if the system supports reusable
artifacts.

Before running `task-01-temperature-fan`, fill
`task-01-p0-preregistration.md`. The preregistration fixes the hardware,
evidence, null hypotheses, and scoring thresholds before any system output can
bias the comparison.

## Fixed Hardware Matrix

Use the same hardware across all systems where possible:

- Board: ESP32-S3 DevKit or ESP32-C3 DevKit.
- Temperature sensor: DHT22, SHT31, or DS18B20. Pick one and keep it fixed.
- Display: SSD1306 I2C OLED.
- Actuator: relay module, fan module, or LED substitute if fan power is unsafe.
- Network: same Wi-Fi network and endpoint.
- Cables/power: same USB cable, same computer, same power source.

Before the run, record exact variants in `run-sheet.md`.

## Tester Roles

Use two roles:

1. Primary tester:
   - Runs the original build.
   - Records every prompt, manual edit, wiring change, and log.
2. Second tester:
   - Receives only the produced recipe/project/tutorial artifact.
   - Attempts rerun without help from the primary tester.

The second tester is required for any claim about recipe reproducibility.

## Anti-Bias Controls

Apply these rules to every system:

1. Use the same task wording from `tasks.json`.
2. Use the same hardware inventory.
3. Do not silently fix generated code.
4. Do not silently correct wiring instructions.
5. Count every manual docs search.
6. Count every manual package/library lookup.
7. Count every manual code edit.
8. Count every manual pin/wiring change.
9. Save failed logs, not only successful logs.
10. Let each system attempt repair, but record whether repair used real logs.
11. If a tool cannot flash/run directly, record the handoff steps separately.
12. If a tool produces only a tutorial or code snippet, mark recipe score low.

Do not give Blockless extra context that the baselines do not receive unless the
context is part of Blockless's product surface.

## Run Folder Structure

For each run:

```text
benchmark_runs/
  YYYY-MM-DD-system-task-id/
    run-sheet.md
    result.json
    prompt-log.md
    generated/
      code/
      package-files/
      wiring/
      recipe/
    logs/
      install.log
      flash.log
      serial.log
      run.log
      repair.log
    media/
      screenshots/
      video/
```

Validate `result.json` before using a run in any deck or memo:

```powershell
python docs\research\blockless-benchmark\validate_result.py benchmark_runs\YYYY-MM-DD-system-task-id\result.json
```

Validation is a floor. The run can still be weak, biased, or non-reproducible.
The `examples/` folder contains validator fixtures only; never cite them as
benchmark results.

## System-Specific Rules

### Blockless

Allow:

- built-in board/module/package selection;
- generated wiring/code;
- dependency install;
- flash/run;
- serial/run log reading;
- automatic repair;
- recipe export.

Do not allow:

- founder-only knowledge not visible in the product;
- manually editing recipe metadata after success;
- manually choosing pins if Blockless claims it chooses pins.

Score harshly if:

- the recipe lacks package versions, wiring, logs, or repair context;
- the run succeeds only through hidden manual help;
- second tester cannot rerun.

Use `verified-recipe-spec.md` and `recipe.schema.json` to evaluate the exported
recipe artifact.

### ChatGPT/Cursor + PlatformIO or Arduino CLI

Use a fresh project and the same prompt.

Allow:

- one AI assistant;
- PlatformIO or Arduino CLI;
- official docs searches counted as manual docs searches;
- generated code edits only when recorded.

Do not allow:

- copying from Blockless output;
- using Blockless manifests or known-failure hints;
- ignoring failed compile/flash/serial logs.

This baseline answers:

> Is Blockless better than a careful user with generic AI plus mature tooling?

### Agentic IDE/CLI

Use a modern coding agent as intended, with command execution, docs retrieval,
local file inspection, dependency installation, flash tooling, and serial-log
inspection enabled if available.

Allow:

- official documentation retrieval;
- PlatformIO, Arduino CLI, esptool, mpremote, or equivalent command execution;
- serial monitor inspection;
- generated code edits and repair attempts when recorded.

Do not allow:

- copying from Blockless output;
- using private Blockless manifests, repair hints, or recipes;
- silently fixing wiring/code outside the agent-visible workflow.

This baseline answers:

> Does Blockless beat generic AI once the AI can actually use tools?

### PleaseDontCode

Use the product as intended.

Allow:

- its own board selection, wiring, code, compile, flash, OTA, dashboard, public
  project, and serial features if available.

Record:

- whether it produces a durable artifact;
- whether that artifact can be rerun by a second tester;
- whether repair uses compile logs only or physical/serial/runtime context;
- whether pin/wiring/package decisions are inspectable.
- whether public projects preserve enough context to recreate the build;
- whether project download preserves code, wiring, board, pin, dependency,
  compile, flash, dashboard, and version state;
- whether a finalized binary, dashboard, or POTA project is useful without the
  original account/session;
- whether version history captures board, wiring, code, package, and flash
  decisions or only generated text/code.

This baseline answers:

> Is Blockless meaningfully different from the closest public full-loop
> competitor?

PleaseDontCode is not beaten by showing that Blockless has a nicer recipe
format. It is beaten only if the same-task artifact is more rerunnable, exposes
more hardware context, requires fewer hidden steps, or repairs a failure class
PleaseDontCode misses.

### Tutorial Baseline

Use one high-quality tutorial from Arduino Project Hub, Adafruit Learn, Seeed
Wiki, or Instructables.

Allow:

- following tutorial steps exactly;
- using tutorial-provided wiring, code, and package instructions.

Record:

- hidden assumptions;
- outdated package/API steps;
- missing board variant details;
- where a beginner would need forum/search help.

This baseline answers:

> Are verified recipes actually better than the incumbent tutorial object?

## Scoring Thresholds

Use the 100-point score in `result.schema.json`.

Minimum to claim "Blockless has a promising P0 win":

- Blockless total score is at least 15 points higher than generic AI+PlatformIO.
- Blockless total score is at least 10 points higher than `agentic_ide_cli`.
- Blockless total score is at least 10 points higher than tutorial baseline.
- Blockless completes `task-10-bad-pin-repair` with correct diagnosis.
- At least one second tester reruns a Blockless recipe successfully.
- No winning task required unrecorded manual fixes.

Minimum to claim "Blockless beats PleaseDontCode":

- Blockless score is at least 10 points higher on the same tasks.
- Blockless recipe artifact is more complete.
- Blockless second-user rerun succeeds where PleaseDontCode's artifact does not,
  or requires fewer hidden steps.

If PleaseDontCode wins or ties:

- Do not claim closed-loop differentiation.
- Reframe around MicroPython package/recipe registry only if the artifact is
  meaningfully better.

## Failure Taxonomy

Assign at least one failure label from `result.schema.json`:

- `intent_misread`
- `board_mismatch`
- `module_mismatch`
- `pin_invalid`
- `wiring_unknown`
- `wiring_wrong`
- `driver_missing`
- `driver_api_wrong`
- `package_version`
- `install_failure`
- `flash_failure`
- `runtime_exception`
- `behavior_wrong`
- `log_unhelpful`
- `repair_wrong`
- `recipe_incomplete`
- `not_reproducible`
- `unknown`

If the failure is caused by tester error, still record it. Hardware workflows
must survive normal user error.

## Claim Updates After P0

After the first P0 batch, update:

1. `../blockless_research_exhaustion_audit.md`
2. `../blockless_deck_v12_slide_audit.md`
3. `../blockless_diligence_pack.md`
4. `../blockless_clarity_research.md`

Use these rules:

- If Blockless wins: graduate only the specific tasks and claims tested.
- If Blockless loses: weaken the deck immediately.
- If results are mixed: narrow the wedge to the winning task class.
- If all systems struggle: pitch the verified recipe problem, not product
  superiority.

## What Not To Conclude

Even a successful P0 does not prove:

- broad hardware appstore demand;
- education adoption;
- recurring subscription behavior;
- $100M ARR;
- production IoT suitability;
- support cost at scale.

Those require separate wedge gates and market tests.
