# Task 01 P0 Preregistration - Temperature Fan

Date: 2026-06-11

Purpose: make the first real benchmark hard to bias. Fill this before running
Blockless, generic AI, agentic CLI, PleaseDontCode, or a tutorial on
`task-01-temperature-fan`.

This is a preregistration packet, not a result. Do not use it as evidence that
Blockless works.

## Task

Use the exact prompt from `tasks.json`:

> Temperature over 30 C turns on the fan.

Pass condition:

> On real hardware, raising the measured temperature above 30 C turns the fan or
> relay on; lowering it turns the output off.

## Null Hypotheses

The run is designed to falsify these Blockless claims:

1. Generic AI plus PlatformIO/Arduino CLI solves the task well enough.
2. A modern agentic IDE/CLI with docs, shell, flash tooling, and serial logs
   solves the task well enough.
3. PleaseDontCode produces an equally rerunnable artifact.
4. A high-quality tutorial produces a clearer second-user path.
5. Blockless's recipe artifact is incomplete, even if the first device runs.

Blockless only earns a narrow P0 win if the evidence beats these null
hypotheses on artifact completeness and rerun quality, not just first-run
success.

## Fixed Hardware Before Starting

Do not choose parts separately per system. Pick once and copy into every run
folder.

| Kind | Exact item | Variant/version | Why this item |
|---|---|---|---|
| Board | TBD | TBD | Must be ESP32-S3 or ESP32-C3 devkit |
| Temperature sensor | TBD | TBD | DHT22, SHT31, or DS18B20; choose one |
| Fan/output | TBD | TBD | Relay/fan if safe; LED substitute allowed if documented |
| Power/cable | TBD | TBD | Same cable/power source across systems |
| Network | TBD | TBD | Same Wi-Fi or explicitly no network |
| Host machine | TBD | TBD | Same OS/tooling machine across systems where possible |

If the fan is replaced by an LED for safety, the claim becomes:

> "temperature threshold controls a safe output"

not:

> "fan control has been validated."

## Systems And Order

Run in this order unless access blocks a system:

1. `blockless`
2. `chatgpt_cursor_platformio`
3. `agentic_ide_cli`
4. `pleasedontcode`
5. `tutorial`

Reason for order:

- Blockless should be measured before seeing competitor artifacts.
- Generic AI and agentic CLI test the "mature tools plus AI is enough" null.
- PleaseDontCode tests the closest claimed closed-loop substitute.
- Tutorial tests the incumbent artifact that users actually follow today.

If PleaseDontCode or another tool requires account/payment access, mark the run
`blocked` only after recording the exact access barrier and any public artifact
that could still be inspected.

## Pre-Run Context Rules

Allowed for every system:

- the exact task prompt;
- the fixed hardware inventory;
- official product workflow as intended;
- public official docs when the system/user naturally needs them;
- compile, flash, and serial logs when the workflow exposes them.

Not allowed:

- copying output from a previous system;
- silently fixing wiring or code;
- giving Blockless hidden founder/module knowledge that is not product-visible;
- giving generic AI a Blockless recipe, manifest, or known-failure hint;
- ignoring failed logs or bad generated instructions;
- changing hardware to fit one system after the run starts.

## Required Evidence Per System

Each run folder must include:

| File | Required content |
|---|---|
| `run-sheet.md` | Filled copy of `run-sheet.md` |
| `result.json` | Must conform to `result.schema.json` |
| `prompt-log.md` | Every prompt, clarification, click-equivalent instruction |
| `generated/code/` | Code, firmware, YAML, project files, or empty note |
| `generated/wiring/` | Wiring diagram, pin table, screenshot, or empty note |
| `generated/recipe/` | Recipe/project/share/download artifact or empty note |
| `logs/install.log` | Install/dependency transcript or empty note |
| `logs/flash.log` | Flash/upload transcript or empty note |
| `logs/serial.log` | Serial/monitor transcript or empty note |
| `logs/run.log` | Behavior observation and threshold test |
| `logs/repair.log` | All repair attempts and whether logs were used |
| `media/` | Photo/video/screenshots proving physical behavior or UI artifact |

An empty note must explain why the evidence does not exist. Missing evidence is
not neutral; it lowers the artifact and reproducibility scores.

Run the structural validator before citing any run:

```powershell
python docs\research\blockless-benchmark\validate_result.py benchmark_runs\YYYY-MM-DD-system-task-id\result.json
```

Validator success only means the result packet has the required fields. It does
not mean the result is strong evidence.

## Artifact Questions To Answer Before Scoring

For every system, answer these in `run-sheet.md` artifact notes:

1. Does the artifact preserve exact board variant and runtime?
2. Does it preserve exact sensor/output module variant?
3. Does it preserve pin assignments and pin-capability checks?
4. Does it preserve wiring in sync with code?
5. Does it preserve package/library names and versions?
6. Does it preserve install, flash, and run methods?
7. Does it preserve serial/run logs?
8. Does it preserve repair attempts and known failure hints?
9. Can a second tester rerun without the original account/session?
10. Would a user share this artifact with a friend: recipe, project, tutorial,
    code zip, dashboard, firmware binary, or something else?

For PleaseDontCode, also answer:

11. Does project download or public project state preserve enough context for
    rerun, or only code/project text?
12. Are dashboard, OTA/POTA, and remote serial artifacts useful outside the
    original account?

## Score Interpretation

First-run success alone is not enough.

Minimum narrow Blockless P0 signal:

- physical behavior verified;
- total score at least 15 points above `chatgpt_cursor_platformio`;
- total score at least 10 points above `agentic_ide_cli`;
- total score at least 10 points above `tutorial`;
- artifact score at least 8/10;
- reproducibility score at least 7/10 after second-user attempt;
- no unrecorded manual fix.

Minimum to say Blockless beats PleaseDontCode on this task:

- Blockless score is at least 10 points higher;
- Blockless artifact preserves more required context;
- second-user rerun is easier or succeeds where PleaseDontCode does not;
- the claim is limited to this task and hardware matrix.

If PleaseDontCode ties or wins, stop using closed-loop differentiation. If
generic AI plus mature tools ties or wins, Blockless must narrow to recipe
registry, module-matrix, or package/runtime claims until another task proves
otherwise.

## One Tough Question Before Running

If the tutorial baseline wins because it is clearer, cheaper, and more trusted
than any AI output, what is Blockless?

Recommended answer:

> A support-deflection and recipe-verification layer, not an AI hardware
> builder. The first wedge would shift toward converting proven tutorials into
> machine-readable, rerunnable recipes and measuring whether second-user
> success improves.

Bad answer:

> Tutorials are old, so AI will beat them.
