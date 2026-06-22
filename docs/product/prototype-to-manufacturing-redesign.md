# Blockless Product Redesign: From Verified Prototype to Manufacturing Handoff

Date: 2026-06-22
Status: product direction draft
Owner: Blockless product

## 1. Decision Summary

Blockless should not become a general-purpose AI PCB CAD product in the next
phase.

The product should become:

> An AI hardware workflow that turns an idea into a verified running
> MicroPython prototype, then turns that verified prototype into a
> manufacturing handoff package.

This keeps the current strength of Blockless: real-device execution,
MicroPython iteration, package intelligence, driver context, wiring, deploy,
serial logs, and repair.

The missing product layer is what happens after the device runs. Today the
story risks stopping at "AI generated code and flashed a board." The next
version must make the verified run become a durable artifact that can be
rerun, forked, published, quoted, and converted into a PCB/manufacturing brief.

## 2. Assumptions

- Current product boundary remains the active constraint in
  `docs/specs/CURRENT-DECISIONS.md`.
- The agent loop stays in the VS Code extension.
- `mpyhw-api` stays responsible for auth, credits, LLM proxying, package/tool
  content, board content, and telemetry.
- The Python shim stays limited to local device IO: scan, install, write,
  flash/run, and serial read.
- V1 hardware remains a controlled MicroPython/ESP32-oriented matrix.
- We do not promise full schematic capture, PCB placement/routing, or DFM
  automation in the immediate product.
- We do add a product path that produces clean inputs for PCB work, factory
  quoting, and human/partner engineering.

## 3. Why This Change Is Needed

Ravn's useful lesson is not "we must copy their PCB CAD stack." The lesson is
that the user and investor mind both want the full hardware journey:

```text
idea -> parts -> wiring -> code -> run -> BOM -> PCB -> DFM -> fabrication
```

Blockless currently has the strongest claim in the middle:

```text
idea -> board/module/driver context -> code -> deploy -> serial log -> repair
```

That is valuable but incomplete. If the product stops there, it can be framed
as a MicroPython coding plugin. If the verified run becomes the input to
manufacturing, Blockless becomes a full hardware workflow with a credible
wedge.

The strategic claim should be:

> The safest path to AI hardware is not idea-to-PCB. It is
> idea-to-running-device-to-PCB.

## 4. Product Thesis

Ravn starts from an idea and designs copper.

Blockless starts from an idea, makes the thing run on real hardware, records
the facts of that run, and uses those facts to generate a manufacturing
handoff.

This gives Blockless a different product center:

- Ravn's asset is the generated board design.
- Blockless's asset is the verified hardware context graph.

The graph is:

```text
intent
  -> selected board
  -> selected modules
  -> capability map
  -> pin map
  -> driver contexts
  -> package versions
  -> generated code
  -> install method
  -> deploy result
  -> serial/run logs
  -> failure classifications
  -> repair trace
  -> verified recipe
  -> rerun evidence
  -> manufacturing handoff
```

## 5. New Product Shape

The product should be organized around four project states.

### 5.1 Plan

The user describes the product goal in natural language.

Example:

> Build a battery-powered soil moisture monitor that shows status on a phone.

Blockless outputs:

- interpreted goal;
- assumptions and missing constraints;
- recommended board;
- recommended modules;
- capability map;
- rough cost range;
- risks: power, enclosure, connectivity, sensor placement, firmware limits;
- next step: build the prototype.

### 5.2 Build

Blockless generates a concrete prototype plan:

- wiring table;
- pin assignment;
- driver/package resolution;
- `main.py`;
- optional helper files only when needed;
- install/deploy plan;
- expected serial output.

The UI should show this as a build plan, not just as chat text.

### 5.3 Verify

This is the key product stage.

Blockless runs the project on real hardware and saves a verification artifact:

- board profile;
- firmware profile;
- module list;
- pin map;
- driver contexts;
- package versions;
- generated files;
- audit result;
- deploy result;
- serial/run log;
- failure labels;
- repair attempts;
- final verified behavior.

This stage creates the `Verified Recipe`.

### 5.4 Manufacture

After a recipe is verified, the user sees a new action:

> Make this into a product

This generates a `Prototype Handoff Pack`, not a finished auto-routed PCB.

The handoff pack is a manufacturing-facing artifact that can be used by:

- an internal Blockless engineer;
- a partner hardware engineer;
- a JLCEDA/KiCad workflow;
- a future PCB agent;
- a factory quote process.

## 6. The Two New Core Artifacts

### 6.1 Verified Recipe

A verified recipe is the durable artifact after a successful run.

It is not a tutorial and not only code. It is a machine-readable hardware build
record.

Suggested file structure:

```text
recipe/
  recipe.json
  board_profile.json
  module_manifest.json
  wiring.json
  wiring.md
  drivers.lock.json
  generated_files/
    main.py
  run_log.txt
  repair_trace.json
  verification.json
```

Minimum fields in `recipe.json`:

```json
{
  "schema_version": "0.1",
  "title": "Soil moisture monitor",
  "intent": "Battery-powered soil moisture monitor with phone status",
  "board_id": "esp32-s3-devkitc-1",
  "capabilities": ["soil_moisture_sensing", "wireless_status"],
  "modules": [],
  "packages": [],
  "pins": {},
  "verified_at": "2026-06-22T00:00:00Z",
  "verification_status": "passed"
}
```

The exact schema should be tightened during implementation. The product
requirement is that a second user can rerun the recipe without rediscovering
hidden context.

### 6.2 Prototype Handoff Pack

The handoff pack is generated only from a verified recipe.

Suggested file structure:

```text
handoff/
  manufacturing_brief.md
  bom.csv
  interface_spec.md
  pcb_handoff.md
  power_budget.md
  enclosure_notes.md
  test_plan.md
  quote_request.md
  source_recipe/
    recipe.json
```

The handoff pack should answer:

- What does the product need to do?
- What prototype was verified?
- Which modules, pins, buses, and packages worked?
- Which parts are dev boards/modules that need consolidation?
- Which components can stay as modules?
- Which components should move onto a PCB?
- What power, enclosure, and connectivity constraints matter?
- What should a factory or engineer quote?
- What tests must the manufactured sample pass to match the prototype?

## 7. Module-to-PCB Migration

This is the most important product intelligence layer to add before full PCB
CAD.

For each verified module, Blockless classifies it into one of three migration
paths:

| Prototype item | Manufacturing path | Example |
|---|---|---|
| Keep as module | Use connector/cable/socket | Grove sensor kept as field-replaceable module |
| Replace with component | Move IC/passives onto PCB | BME280 breakout -> BME280 + pull-ups + decoupling |
| Replace with module-on-PCB | Use certified module | ESP32 DevKit -> ESP32-S3-MINI-1 module |

The generated `pcb_handoff.md` should not say "draw this exact PCB" unless the
system has enough evidence. It should say:

- known working prototype topology;
- bus and signal requirements;
- voltage domains;
- connector needs;
- parts to preserve;
- parts to replace;
- open engineering decisions.

This is a stronger near-term product than premature automatic routing.

## 8. UX Changes

The product should stop feeling like only a chat panel.

Recommended project workspace:

```text
left rail: project stages
  Idea
  Parts
  Wiring
  Code
  Run
  Verified
  Manufacture

center: active artifact
  plan, wiring, code, serial log, recipe, handoff pack

right rail: AI engineer feed
  decisions, warnings, repairs, approvals
```

The AI feed should be action-oriented:

- "I found 3 compatible temperature packages. I recommend A because it has
  driver context and works on ESP32-S3."
- "GPIO8/GPIO9 satisfy I2C on this board profile."
- "Deploy failed because the package import is missing."
- "Repair attempt 1 changed the import to the resolved driver context."
- "Verified: sensor output observed every 2 seconds."
- "Manufacturing handoff is ready. Three prototype modules need replacement
  decisions."

Avoid showing a plain text menu when there is a project artifact to render.

## 9. Backend And Extension Changes

### 9.1 Backend additions

Add backend support for:

- recipe schema validation;
- recipe export;
- recipe storage;
- handoff pack generation;
- package-to-BOM mapping;
- module-to-PCB migration hints;
- quote request packet generation;
- telemetry for rerun success and repair classification.

Potential endpoints:

```text
POST /v1/recipes
GET  /v1/recipes/{id}
POST /v1/recipes/{id}/verify
POST /v1/recipes/{id}/handoff
GET  /v1/recipes/{id}/handoff
```

These are directional. They should not be added to the active API spec until
implementation planning.

### 9.2 Extension additions

Add extension support for:

- saving recipe artifacts after successful deploy;
- showing recipe status in the UI;
- rerun from recipe;
- export recipe to local workspace;
- generate handoff pack;
- display manufacturing checklist;
- user approval before any external quote/factory action.

### 9.3 Python shim additions

Keep the shim narrow.

Allowed additions:

- return structured deploy result;
- return serial run evidence;
- return detected board/device facts.

Not allowed:

- LLM logic;
- package selection;
- manufacturing logic;
- BOM reasoning.

## 10. Milestones

### Milestone 1: Verified Recipe MVP

Goal:

> A successful run creates a recipe artifact that can be saved and rerun.

Scope:

- generate `recipe.json`;
- save board, package, pin, code, deploy, and run-log data;
- export recipe to local project;
- rerun recipe on the same hardware setup.

Success criteria:

- 10 standard projects generate recipes;
- every recipe includes enough data for a second run;
- no recipe is marked verified without serial/run evidence.

### Milestone 2: Second-User Rerun

Goal:

> Another user can reproduce the recipe on compatible hardware.

Scope:

- import recipe;
- check board compatibility;
- install dependencies;
- show wiring;
- deploy and run;
- record rerun result.

Success criteria:

- at least 70% second-user rerun success across the controlled matrix;
- failures are labeled as code, package, wiring, board mismatch, device IO, or
  unknown.

### Milestone 3: Prototype Handoff Pack

Goal:

> A verified recipe can become a manufacturing-facing packet.

Scope:

- generate `manufacturing_brief.md`;
- generate `bom.csv`;
- generate `interface_spec.md`;
- generate `pcb_handoff.md`;
- generate `test_plan.md`;
- generate `quote_request.md`.

Success criteria:

- a hardware engineer can understand the prototype without reading chat logs;
- a factory/partner can quote next steps from the packet;
- open decisions are explicit instead of hidden.

### Milestone 4: First Manufactured Sample

Goal:

> One verified Blockless prototype becomes a small custom-board sample.

Scope:

- choose one simple verified recipe;
- generate handoff pack;
- hand to engineer/partner;
- create PCB through existing EDA workflow;
- manufacture 5-10 samples;
- run the original Blockless test plan on the samples.

Success criteria:

- manufactured sample matches the verified prototype behavior;
- the handoff pack reduced engineering clarification time;
- gaps are recorded and folded back into handoff generation.

## 11. Non-Goals

Do not build these immediately:

- full automatic PCB placement/routing;
- RF/antenna design automation;
- high-speed signal integrity automation;
- enclosure CAD generation;
- certification automation;
- factory logistics ownership;
- production fleet management.

These are possible future layers, but adding them now would make the product
too broad and weaken the current execution advantage.

## 12. Product Messaging

Avoid:

> We also do PCB CAD.

Use:

> Blockless makes the device run first, then turns the verified prototype into
> the manufacturing handoff.

Avoid:

> Competitors only generate code.

Use:

> AI hardware tools are racing toward generation. Blockless focuses on the
> verified artifact after generation: the recipe, logs, hardware context, and
> rerun evidence.

Avoid:

> Hardware app store.

Use until proven:

> Verified recipe registry.

Use as the main strategic line:

> Say one sentence. Get a real device running. Turn the verified run into a
> product handoff.

## 13. How This Answers Ravn

Ravn is strong because it sells the full journey:

```text
idea -> schematic -> PCB -> firmware -> BOM -> DFM -> fab files
```

Blockless should answer with a different order:

```text
idea -> running prototype -> verified recipe -> manufacturing handoff -> PCB
```

The rebuttal is not that Ravn is "wrong." The rebuttal is that for many users,
especially non-EE builders, a PCB file is not proof that the product works.

Blockless should own the proof:

- the code ran;
- the driver worked;
- the pins matched;
- the device produced expected logs;
- the recipe can be rerun;
- the manufacturing packet starts from verified facts.

## 14. Risks

### Risk: handoff pack is too shallow

Mitigation:

- test it with a real hardware engineer;
- track clarification questions;
- add missing fields only when they reduce real ambiguity.

### Risk: verified recipe is not reproducible

Mitigation:

- make second-user rerun a milestone before marketplace language;
- store package versions, firmware profile, and board profile;
- classify rerun failures.

### Risk: manufacturing expectations get too high

Mitigation:

- clearly separate "handoff pack" from "finished PCB";
- label open engineering decisions;
- require human approval before quote or fab actions.

### Risk: current product becomes too complicated

Mitigation:

- keep V1 matrix narrow;
- only generate handoff after verified run;
- avoid broad hardware support claims.

## 15. Immediate Next Steps

1. Define `recipe.json` schema for the current controlled hardware matrix.
2. Add recipe export after successful deploy/run.
3. Build a rerun flow from exported recipe.
4. Define the first handoff pack templates.
5. Run 10 benchmark tasks and save recipe artifacts.
6. Ask one hardware engineer to convert one handoff pack into a PCB plan.
7. Use the findings to decide whether to build KiCad/JLCEDA skeleton export.

## 16. One-Page Product North Star

Blockless should become the system of record for AI-generated hardware
prototypes.

The key product unit is not a chat session and not a code file. It is a
verified recipe:

```text
what the user wanted
what hardware was selected
what code was generated
what packages were installed
how it was wired
what happened when it ran
how failures were repaired
how another user can rerun it
how it can become a product
```

If Blockless owns that artifact, it can expand into recipe registry, module
sales, paid workspace, partner quoting, PCB handoff, and eventually deeper EDA
automation.

If Blockless does not own that artifact, it risks becoming another AI codegen
surface for embedded projects.

## 17. Reference Context

Internal references:

- `docs/specs/CURRENT-DECISIONS.md`: current MVP boundary and runtime
  architecture.
- `docs/research/blockless_competitor_ravn_teardown_2026_06.md`: Ravn
  teardown and collision map.
- `docs/research/blockless_clarity_research.md`: narrowed thesis around
  verified recipes, reruns, and claim gates.
- `docs/research/hardware_pipeline_guide.md`: hardware pipeline from idea to
  PCB, PCBA, test, enclosure, and production.

External reference:

- `https://www.getravn.xyz/`: Ravn primary product source for the claimed
  sourcing, schematic, PCB layout, firmware, BOM, DFM, and fabrication-file
  workflow.
