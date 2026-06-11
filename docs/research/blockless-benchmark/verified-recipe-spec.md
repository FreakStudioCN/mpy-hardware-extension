# Verified Recipe Spec

Date: 2026-06-11

Purpose: define the minimum artifact required before Blockless can call an
output a verified hardware recipe.

This spec exists to make "recipe" testable. If an artifact lacks these fields,
it may be a project, tutorial, code bundle, or demo, but it is not a verified
recipe.

## Definition

A verified recipe is a machine-readable hardware package that proves:

1. What the user wanted.
2. Which hardware was selected.
3. How the hardware was wired.
4. Which code and packages were used.
5. How the code was installed/flashed/run.
6. What logs were observed.
7. Which failures occurred and how they were repaired.
8. Which compatible hardware variants can rerun it.
9. Whether a second user actually reproduced it.

## Minimum Required Files

```text
recipe/
  recipe.json
  code/
  manifests/
    board.json
    modules.json
    wiring.json
    packages.json
    endpoint.json
  logs/
    install.log
    flash.log
    serial.log
    run.log
    repair.log
  media/
    wiring-photo-or-diagram.*
    behavior-proof.*
```

`recipe.json` is the canonical index. The other files may be embedded or
referenced by path.

## Verification Levels

| Level | Name | Meaning | Deck language allowed |
|---|---|---|---|
| 0 | Draft | Generated code or tutorial exists, not run | "generated project" |
| 1 | Buildable | Dependencies install and code compiles or uploads | "buildable project" |
| 2 | Device-run | Real hardware performs requested behavior once | "working hardware project" |
| 3 | Verified recipe | Level 2 plus full metadata, logs, wiring, packages, and repair trace | "verified recipe" |
| 4 | Rerunnable recipe | Level 3 plus second-user rerun succeeds | "rerunnable recipe" |
| 5 | Published compatible recipe | Level 4 plus compatibility matrix and versioned registry listing | "published verified recipe" |

Do not use "appstore" or "marketplace" language before level 5 plus observed
rerun/fork/payment behavior.

## Required Recipe Fields

### Identity

- `recipe_id`
- `title`
- `version`
- `created_at`
- `author`
- `source_prompt`
- `task_id`
- `status`
- `verification_level`

### Hardware

- `board_profile`
  - board id
  - exact variant
  - MCU
  - firmware/runtime
  - flash method
  - known constraints
- `module_manifests`
  - module id
  - exact variant
  - required bus/protocol
  - voltage/current requirements
  - driver
  - package dependency
- `pin_assignments`
  - logical signal
  - physical pin
  - pin capability
  - bus membership
  - conflict check
  - boot/strap warnings

### Wiring

- `wiring_profile`
  - source module pin
  - destination board pin
  - bus/protocol
  - voltage level
  - pull-up/pull-down requirement
  - diagram/photo reference
  - user confirmation status

### Software

- `code_artifacts`
  - entrypoint
  - files
  - generated-by tool/model if applicable
  - checksum
- `package_lock`
  - package name
  - version
  - source/index
  - install method
  - checksum if available
- `runtime_config`
  - interpreter/firmware version
  - board runtime mode
  - environment variables or secrets placeholders

### Execution

- `install_method`
- `flash_method`
- `run_method`
- `install_log`
- `flash_log`
- `serial_log`
- `run_log`
- `behavior_proof`

### Repair

- `failure_events`
  - timestamp
  - failure label
  - observed log excerpt reference
  - diagnosis
  - repair action
  - result
- `known_failures`
  - condition
  - symptom
  - cause
  - repair hint

### Distribution

- `endpoint_manifest`
  - event names
  - payload schema
  - auth placeholder
  - retry behavior
  - local/offline behavior
- `compatibility_matrix`
  - compatible boards
  - compatible module variants
  - required substitutions
  - known incompatible variants
- `rerun_history`
  - tester id
  - hardware variant
  - result
  - elapsed time
  - manual interventions
  - logs reference

## Recipe Completeness Score

Use this in benchmarks:

| Score | Meaning |
|---:|---|
| 0 | Code/tutorial only |
| 2 | Code plus partial wiring |
| 4 | Code, wiring, package list, but no real run logs |
| 6 | Real run logs, but weak metadata or no repair context |
| 8 | Full metadata, logs, wiring, package lock, and known failures |
| 10 | Full verified recipe plus successful second-user rerun |

## Failure Conditions

Mark `recipe_incomplete` if any are true:

- no exact board variant;
- no exact module variant;
- no package versions;
- no wiring profile;
- no flash/run/serial logs;
- no behavior proof;
- no compatibility constraints;
- no known-failure or repair section after a failure occurred;
- secret/manual setup hidden in chat history;
- second tester needs undocumented help.

Mark `not_reproducible` if:

- a second tester cannot rerun from the artifact;
- rerun requires guessing pins, packages, or setup;
- rerun depends on unavailable local state;
- rerun succeeds only after undocumented manual edits.

## Comparison Rule

When comparing Blockless to PleaseDontCode, tutorials, Wokwi/Cirkit, or generic
AI plus PlatformIO, ask:

> Which artifact contains the most rerun-critical context with the fewest hidden
> assumptions?

Do not score a polished tutorial higher than a recipe unless the tutorial
actually leads to higher second-user completion.
