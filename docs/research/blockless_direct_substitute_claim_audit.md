# Blockless Direct Substitute Claim Audit

Date: 2026-06-11

Purpose: pressure-test the closest direct substitutes against Blockless's exact
workflow claims. This document treats competitor pages as evidence of public
claims, not evidence that the claims work reliably.

## Bottom Line

The direct-substitute risk is stronger than "competitors generate code."

The strongest public competitor claim is now:

> idea -> board/components -> wiring -> firmware -> compile/fix -> flash ->
> monitor/dashboard -> public project or versioned project.

That means Blockless cannot win by saying it is closed loop. It must win on a
stricter artifact:

> verified recipe = board + module + wiring + driver + code + package versions
> + install/flash/run method + logs + failure labels + repair hints + endpoint
> manifest + compatibility matrix + second-user rerun history.

If a competitor can produce that artifact and a second user can rerun it,
Blockless's current differentiation collapses.

## Direct Substitute Matrix

| Product | Public claim surface | Strongest threat to Blockless | What remains unproven | Required test |
|---|---|---|---|---|
| PleaseDontCode | Idea-to-firmware, wiring schematic, compatible libraries, verified pins, compile/fix, USB/Wi-Fi flash, OTA/POTA, dashboards, remote serial, public projects, paid plans | It already claims the loop Blockless wants to own | Reliability, failure diagnosis quality, recipe depth, second-user rerun | Run tasks 1, 2, 3, 8, 9, 10; export/inspect project artifact |
| Embedr | AI workspace for firmware, board bring-up, KiCad-native schematics/PCB layouts, build/flash/monitor, serial/output/terminal, targets/dependencies, checkpoints/Git, paid plans | It can become the pro/embedded version of the same workflow | Natural-language wiring depth, real board success, recipe/rerun artifact | Run tasks 1, 3, 4, 10; inspect logs, dependency state, checkpoints |
| Cirkit Designer | AI wiring/code, browser simulation, real firmware in browser, share links, browser upload to Arduino/ESP32/Pico, classroom workflow | It may beat physical-first Blockless for beginners and classrooms | Physical flash reliability, post-simulation hardware gap, repair depth | Run tasks 1, 3, 6 in simulation and one physical upload |
| Schematik | "Cursor for hardware" narrative, build guides with wiring diagrams/component lists/code, parts guidance, low-voltage safety framing, $4.6M press | It owns the broad narrative and hardware buying/assembly surface | Whether it is an interactive firmware workflow or mainly guide/parts flow | Inspect output from guides/app; run comparable guide-to-device task |
| Aily Blockly | Open-source AI hardware IDE, project/board/library management, AI project generation, pin diagrams, wiring diagrams, AI code, AI library conversion, serial tool, 2.2k GitHub stars | Open source can clone a large part of v1 and undermine "hard to build" claims | Install stability, upload reliability, US adoption, recipe/rerun depth | Install and run one ESP32 task plus package/driver substitution |

Refresh note, 2026-06-11:

- PleaseDontCode is now the benchmark that matters most for closed-loop claims,
  because its live pages explicitly claim browser flash, compile/auto-fix,
  OTA/fleet management, dashboards, remote serial, public projects, and project
  download on the highest tier.
- Embedr claims must cite `https://www.embedr.app/`. `https://embedr.ai/` is a
  different private-knowledge product and is not evidence for embedded hardware
  workflow claims.
- Marketing counters, pricing tiers, GitHub stars, and press narratives remain
  lower-grade evidence than same-task runs.

## PleaseDontCode: The Closest Full-Loop Claim

Current public page claims:

- AI generates wiring schematic and firmware in sync.
- Board selection covers 29+ supported boards.
- The system compiles through Arduino tooling, fixes errors, and uploads from
  the browser.
- USB flash and Wi-Fi/POTA update paths are both positioned.
- Every device gets a real-time dashboard.
- Remote serial console is part of POTA.
- Community projects are visible and users can view code.
- Pricing exists: free, plus paid monthly tiers.

Why this is dangerous:

Blockless's previous strongest contrast was "ordinary AI only generates code."
PleaseDontCode is not ordinary AI. It publicly claims the exact missing middle:
hardware-aware generation, wiring, build, flash, monitoring, and reuse.

What Blockless can still own:

- richer verified recipe schema;
- physical failure classification beyond compile errors;
- second-user rerun history;
- compatibility matrix across boards/modules;
- fork/rerun/publish workflow;
- MicroPython-specific fast iteration if benchmarked.

Failure condition:

If PleaseDontCode public projects can be rerun by a second user with code,
wiring, versions, flash instructions, logs, and dashboard endpoint preserved,
Blockless must stop claiming a unique appstore object.

## Embedr: The Pro Workflow Threat

Current public page claims:

- "Build embedded systems as fast as software."
- AI workspace covers firmware, board bring-up, KiCad-native schematics, and PCB
  layouts.
- Build, flash, monitor, and iterate in one hardware-aware environment.
- Serial Monitor, Output, and Terminal are integrated.
- Targets, dependencies, ports, and build options are managed in one place.
- Checkpoints and Git are built in.
- Pricing exists from free to hobby/pro/team, with model access and PCB
  automation on higher tiers.

Why this is dangerous:

Embedr has a more engineer-legible workflow than a pure maker app: targets,
dependencies, terminal, serial monitor, Git, schematics, and PCB. If Blockless
pushes into pro/prototyping users, Embedr is a stronger foil than Schematik.

What Blockless can still own:

- beginner sentence-to-device workflow;
- constrained verified recipe marketplace;
- module/pin/package compatibility graph;
- second-user recipe rerun rather than repo/checkpoint recovery.

Failure condition:

If Embedr can take the same prompt and produce working firmware plus wiring,
dependency state, flash logs, serial logs, and a shareable project, Blockless's
"AI embedded IDEs do not close the loop" claim fails.

## Cirkit Designer: The Classroom/Beginner Threat

Current public page/docs claim:

- AI design tools for wiring, code, and circuit-aware questions.
- Browser simulation for Arduino, ESP32, and Raspberry Pi Pico code.
- Components respond in simulation.
- Projects can be shared as links.
- Firmware can be uploaded to real Arduino/ESP32/Pico hardware from the
  browser.
- Classroom positioning emphasizes no local installs and less fragile setup.
- Docs claim over 30,000 community-contributed components and integrated
  Arduino IDE behavior.

Why this is dangerous:

For education and first-time users, physical-first can be a bug, not a feature.
Simulation avoids bad cables, missing parts, bad soldering, boot pins, and
teacher support overload.

What Blockless can still own:

- real hardware verification;
- recipe artifact for physical rerun;
- repair from serial/run logs;
- kit/module distribution if it lowers physical friction.

Failure condition:

If students or beginners complete more benchmark tasks faster in Cirkit
simulation and only later flash hardware, Blockless should not lead with a
classroom physical-first wedge.

## Schematik: Narrative And Parts Guidance Threat

Schematik's website is currently sparse, but public pages and press still
matter:

- The homepage preserves the $4.6M pre-seed announcement and navigation to
  guides, parts, blog, company, and download.
- Build guides are step-by-step electronics projects with wiring diagrams,
  component lists, and ready-to-deploy code.
- WIRED frames Schematik as "Cursor for hardware," describes AI-assisted
  physical-device building, parts guidance, low-voltage safety boundaries, and
  Lightspeed funding.

Why this is dangerous:

Schematik may not be the deepest workflow competitor today, but it owns the
investor/media phrase and the parts/assembly mental model. If Blockless uses
"Cursor for hardware," it enters Schematik's frame.

What Blockless can still own:

- verified recipe execution;
- real flash/run/serial repair;
- MicroPython/module matrix;
- appstore/rerun object.

Failure condition:

If Schematik's downloadable product turns guides into runnable/versioned
projects with code, wiring, parts, flash/run, and rerun state, Blockless must
benchmark it as a P0/P1 direct substitute rather than a narrative foil.

## Aily Blockly: Open-Source Clone Threat

Current GitHub README claims:

- AI-assisted programming for hardware.
- Long-term goal of natural-language programming.
- Project management via npm with independent board/library versions.
- 200+ extension libraries.
- Serial debug tool.
- AI project generation that recommends boards, modules, libraries, architecture
  diagrams, and pin connection diagrams.
- AI code generation.
- AI library conversion from Arduino libraries.
- AI development-board configuration generation.
- Wiring diagram generation.
- Current alpha status and not recommended for mass-production firmware.

Why this is dangerous:

This is not a polished commercial threat, but it proves that many ingredients in
Blockless v1 are reproducible in open source: board/library state, AI project
generation, pin diagrams, wiring diagrams, serial tools, and library
conversion.

What Blockless can still own:

- packaged, hosted, verified workflow;
- real hardware outcomes;
- recipe registry and rerun history;
- curated module matrix;
- support/QA layer.

Failure condition:

If Aily can install cleanly and run a simple ESP32 module task with less manual
work than Blockless, the deck must stop using "this is too hard to clone" as a
near-term moat.

## Claims That Must Be Downgraded

| Claim | Status after direct-substitute audit | Replacement |
|---|---|---|
| "Competitors only generate code." | False | "Several competitors already claim wiring/code/build/flash/monitor pieces." |
| "Closed loop is unique." | False until benchmarked | "Closed loop is contested; verified recipe rerun is the stricter claim." |
| "No one has public project reuse." | Unsafe | "Public projects exist; second-user rerunnability remains unproven." |
| "Blockless is the only hardware-aware AI." | False | "Blockless must prove better hardware-aware outcomes." |
| "Generic tools are the main baseline." | Incomplete | "Direct AI hardware tools and agentic IDE/CLI baselines are required." |

## New Direct-Substitute Benchmark Questions

1. Does the competitor preserve board, module, pin, driver, package, and version
   decisions in a machine-readable artifact?
2. Does the competitor preserve wiring and code in sync after iterative edits?
3. Does the competitor compile/build the code, or only generate text?
4. Does the competitor flash to real hardware from the product surface?
5. Does the competitor read serial/runtime logs?
6. Does the competitor repair compile errors only, or also pin/wiring/runtime
   failures?
7. Does the competitor expose public projects, and are they runnable by a
   second user?
8. Does the competitor support fork/edit/rerun?
9. Does the competitor expose endpoint/dashboard/device-management artifacts?
10. Does the competitor already charge for credits/devices/private projects?
11. Does the competitor's artifact look more like a tutorial, project repo,
    firmware binary, dashboard, or verified recipe?
12. Which artifact would a user actually share with a friend?

## Deck Consequence

Use:

> Direct AI hardware tools already claim much of the loop. Blockless is betting
> that the winning artifact is not generated firmware, a guide, or a simulated
> project, but a verified recipe that a second user can rerun on real hardware.

Avoid:

> Nobody else is doing this.

That line is no longer defensible.
