# Blockless Clarity Doc

Date: 2026-06-11

Purpose: compress the long research memo into a deck-ready operating story.
This is not the pitch deck. It is the reasoning spine the deck should obey.

Companion analysis: `docs/research/blockless_ubercab_page_by_page.md` maps the
25-page UberCab deck to the evidence Blockless needs page by page.

Completion audit: `docs/research/blockless_research_exhaustion_audit.md`
defines what is desk-research complete and what still requires benchmark or
market evidence.

Current deck audit: `docs/research/blockless_deck_v12_slide_audit.md` applies
this research to `docs/pitch/deck/deck_en.md` v12 slide by slide.

Source ledger: `docs/research/blockless_source_ledger.md` records what each
source can and cannot prove.

Competitor exhaustion map: `docs/research/blockless_competitor_exhaustion_map.md`
separates direct AI hardware workflow rivals from AI ECAD/PCB, IoT/event
platforms, runtimes, tutorials, and software analogy sources.

Vibe-coding analogy stress test:
`docs/research/blockless_vibe_coding_analogy_stress_test.md` defines which
Cursor/Lovable-style claims transfer and which require separate hardware proof.

## One-line thesis

Blockless turns a sentence into a verified hardware recipe: a real device runs,
the logs prove it, and another user can rerun or fork the build.

## The problem

Hardware creation fails in the gap between tutorial and real device.

The user does not mainly need "AI code." The user needs answers to hidden
hardware questions:

- Which board works?
- Which module works?
- Which pins are safe?
- Which driver and package version are compatible?
- What wiring is required?
- Did flashing fail, did code fail, did the driver fail, or is the wire wrong?
- Can someone else reproduce this project later?

Code assistants stop too early. Tutorials leave hidden assumptions. Simulation
does not prove the physical device works. Forums do not produce a rerunnable
artifact.

## The product

User prompt:

> Temperature over 30 C turns on the fan.

Blockless workflow:

1. Parse hardware intent.
2. Select board, module, driver, pins, packages, and install method.
3. Generate wiring and code.
4. Install dependencies.
5. Flash and run on a real device.
6. Read flash, serial, and run logs.
7. Repair from observed failure.
8. Save a verified recipe.
9. Let another user fork, rerun, or publish it.

The product is not the model. The product is the loop.

## The durable artifact

The unit of distribution is not a tutorial, not a code snippet, and not a
chat transcript.

The unit is a verified recipe:

- board profile;
- module manifest;
- wiring profile;
- pin capability map;
- driver context;
- package version;
- install method;
- generated code;
- flash log;
- serial/run log;
- known failure;
- repair hint;
- endpoint manifest;
- compatibility matrix;
- rerun/fork history.

The recipe is the hardware equivalent of a deployed app, package lockfile,
CI run, logs, and template combined.

## The moat

The defensible asset is the hardware execution context graph:

```text
intent -> capability -> board -> pins -> module -> driver -> package
       -> wiring -> code -> flash -> serial log -> failure -> repair
       -> verified recipe -> compatibility matrix
```

This graph compounds only if real runs create better future runs. Data is not
a moat by itself. Verified run data is the possible moat.

## The uncomfortable competitor truth

Do not say "no one is doing this."

PleaseDontCode already claims a large part of the closed loop: idea to wiring,
firmware, browser flashing, OTA, dashboards, version history, public projects,
verified pins, compatible libraries, compile, auto-fix, and remote serial logs.

Cirkit Designer already attacks AI wiring, simulation, code, sharing, custom
parts, and browser upload.

PlatformIO already owns board/toolchain/library abstraction.

ESPHome already proves declarative hardware configuration works for smart-home
sensor and actuator workflows.

Wokwi already makes simulation, debugging, and shareable project links easy.

Schematik already owns the media phrase "Cursor for hardware."

Arduino Cloud, Blynk, and Particle already own pieces of cloud dashboards,
device templates, OTA, firmware lifecycle, and fleet/device management.

MakeCode, Tinkercad, Visuino, Mind+, and Mixly already own much of the beginner
and classroom no-code/visual programming wedge.

Arduino Project Hub, Adafruit Learn, Seeed Wiki, Hackster, and Instructables
already own the tutorial plus hardware-store distribution loop.

Therefore the claim is not:

> Blockless is first.

The defensible claim is:

> Blockless is testing whether verified, rerunnable hardware recipes are the
> missing durable artifact for AI hardware creation.

## Why the vibe-coding analogy helps

Cursor, Lovable, v0, Bolt, Replit Agent, and Copilot show that AI-native
creation works when generation is attached to an inspectable artifact:

- branch;
- diff;
- pull request;
- tests;
- logs;
- deploy;
- live URL;
- template;
- analytics.

Blockless must build the hardware equivalents:

- recipe diff;
- wiring diff;
- package/driver lockfile;
- flash log;
- serial log;
- physical run proof;
- endpoint manifest;
- verified compatibility matrix;
- rerun/fork metrics.

## Why the analogy breaks

Software has instant hosted artifacts. Hardware has parts, wiring, drivers,
board variants, unsafe pins, firmware modes, and physical failure.

Vibe coding does not prove Blockless's market. It only suggests the shape of
the workflow if the hardware friction can be controlled.

The hardware proof has to be separate:

- user gets a real device running;
- user makes a second and third project;
- another user reruns the recipe;
- someone pays for a kit, workspace, recipe, or package;
- support cost does not explode as the board/module matrix grows.

## The v1 wedge

V1 should be narrow enough to win visibly:

- 1-2 ESP32 boards;
- 8-12 modules;
- 20-30 verified recipes;
- MicroPython where hot iteration matters;
- explicit exclusion of hard real-time, high-power, custom PCB, and broad
  industrial workflows.

The point of v1 is not breadth. The point is repeatable success.

## The appstore

Call it a verified recipe registry until behavior proves marketplace demand.

Marketplace is not validated by publishing many recipes. It is validated by:

- reruns;
- forks;
- second-user successful reproductions;
- recipe combinations;
- paid recipes;
- kit attach rate;
- lower support cost from known failure and repair hints.

## Business model hypotheses

The business model depends on observed behavior, not analogy.

Possible models:

- kit margin if users buy hardware after previewing recipes;
- workspace subscription if users build repeatedly;
- paid recipe/package if recipes save enough failure time;
- education/vendor licensing if schools or hardware sellers need curated
  reproducible labs;
- cloud/device endpoint layer if recipes connect to apps and agents.

Do not commit to revenue mix before attach-rate and repeat-use data.

## Market wedge decision

Blockless cannot pitch maker, education, IoT cloud, and marketplace as one
undifferentiated market. Each wedge has a different incumbent and proof gate.

| Wedge | Incumbents | Proof Blockless needs |
|---|---|---|
| Maker prototyping | Arduino, Adafruit, Seeed, PlatformIO, PleaseDontCode | Faster real-device success and fewer hidden failures |
| Education | MakeCode, Tinkercad, Wokwi, Cirkit, visual tools | Higher classroom completion without more teacher support |
| IoT app/control | Arduino Cloud, Blynk, Particle, ESPHome | Recipes create reusable device-app workflows, not just dashboards |
| Recipe marketplace | Hackster, Instructables, Project Hub, Adafruit Learn | Rerun/fork/payment behavior beats tutorials and galleries |

The safest v1 story is maker prototyping with a controlled hardware matrix.
Education, IoT cloud, and marketplace should stay as expansion paths until
measured behavior supports them.

## What must be proven before the deck can be aggressive

Run the 10-task benchmark against:

1. Blockless.
2. ChatGPT/Cursor plus PlatformIO or Arduino CLI.
3. PleaseDontCode.
4. One simulation baseline: Wokwi or Cirkit Designer.
5. One tutorial baseline: Arduino, Adafruit, Seeed, or Instructables.

Measure:

- time to working device;
- first-run success;
- number of manual docs searches;
- number of manual code edits;
- number of wiring changes;
- install/flash failures;
- serial/run-log usefulness;
- repair success;
- recipe completeness;
- second-user rerun success.

## Claims allowed today

- AI code generation alone is not enough for hardware.
- Hardware needs verified context: boards, modules, pins, drivers, packages,
  wiring, logs, and repair hints.
- The strongest Blockless thesis is verified hardware recipes, not "LLM writes
  firmware."
- The v1 matrix must be narrow.
- Marketplace claims are unproven until rerun/fork/payment behavior exists.

## Claims not allowed yet

- "The physical world has no agent."
- "Hardware is empty."
- "Competitors only generate code."
- "Blockless is the first closed-loop AI hardware workflow."
- "MicroPython is 10x better for all hardware."
- "Hardware App Store is obvious."
- "Users will pay because vibe coding users paid."
- "$100M ARR" without bottom-up attach rate, active usage, margin, churn, and
  repeat-project assumptions.

## Deck spine

1. Hardware ideas fail between tutorial and real device.
2. AI code is not enough because hardware has hidden context.
3. Existing tools solve pieces: code, simulation, flashing, tutorials.
4. The missing artifact is a verified rerunnable hardware recipe.
5. Blockless owns the loop from sentence to real run to recipe.
6. The context graph is the compounding asset.
7. V1 is narrow: ESP32 plus a controlled module matrix.
8. Success is measured by repeat projects, reruns, forks, and paid behavior.
9. The benchmark is the proof gate.

## Final sentence

AI can write code. Hardware needs verified recipes.
