# Blockless Diligence Pack

Date: 2026-06-11

Purpose: one operating index for the current research state. Use this before
editing the deck, fundraising memo, website copy, or benchmark plan.

## Current Research Position

The strongest current thesis is:

> Blockless is a verified hardware recipe workflow for a controlled ESP32 module
> matrix. It turns intent into a real run, captures logs and repair context, and
> produces a rerunnable recipe.

The strongest current warning is:

> Do not pitch Blockless as the first AI hardware builder, the only closed loop,
> or the inevitable hardware version of Cursor/Lovable. Current sources do not
> support those claims.

## Use These Files In Order

1. `blockless_ubercab_style_clarity_doc.md`
   - Read first for the clean story.
2. `blockless_deck_v12_slide_audit.md`
   - Read before touching the current deck.
3. `blockless_source_ledger.md`
   - Read before adding any claim or citation.
4. `blockless_research_exhaustion_audit.md`
   - Read before claiming research is complete.
5. `blockless_competitor_exhaustion_map.md`
   - Read before using broad "AI hardware builder" language.
6. `blockless_ubercab_page_by_page.md`
   - Read when mapping a deck structure to UberCab-style clarity.
7. `blockless_vibe_coding_analogy_stress_test.md`
   - Read before using Cursor/Lovable/Codex/Replit/Bolt/v0 as analogy or market
     proof.
8. `blockless_hard_questions_addendum.md`
   - Read before claiming hardware context, tool access, agent loops, or serial
     logs are defensible moats.
9. `blockless_direct_substitute_claim_audit.md`
   - Read before saying competitors only generate code, closed loop is unique,
     or public projects are not rerunnable.
10. `blockless_competitor_source_refresh_2026_06_11.md`
   - Dated source refresh for PleaseDontCode, Embedr, Cirkit, Schematik, Aily,
     and the `embedr.app` versus `embedr.ai` citation trap.
11. `blockless_monetization_falsification_audit.md`
   - Read before making appstore, subscription, kit, paid recipe, revenue mix,
     or $100M ARR claims.
12. `blockless_platform_vendor_pressure_audit.md`
   - Read before claiming hardware context, board/module manifests, IDE
     distribution, or vendor data are defensible moats.
13. `blockless_vendor_platform_source_refresh_2026_06_11.md`
   - Dated refresh that restores Espressif ESP-Claw, Espressif MCP, and
     Espressif Docs AI as source-backed pressure while keeping Arduino Cloud AI
     Assistant quarantined.
14. `blockless_adjacent_competitor_gap_refresh_2026_06_11.md`
   - Read before using broad physical-world, robotics, industrial IoT, live
     hardware iteration, or no-code physical-computing language.
15. `blockless_market_size_data_falsification_audit.md`
   - Read before using MCU shipments, Arduino/Raspberry Pi installed base,
     Kickstarter comps, AI hardware revenue, STEM populations, or software ARR
     as market proof.
16. `blockless_clarity_research.md`
   - Read when detailed evidence, competitor analysis, or red-team questions
     are needed.
17. `blockless-benchmark/`
   - Use when converting claims into actual tests.
   - `claim-gate-matrix.json` maps high-risk deck claims to required baselines,
     evidence, pass conditions, kill conditions, and forbidden inferences.
   - `scan_deck_claims.py` scans deck Markdown for risky claim language before
     copy changes ship.
   - `verified-recipe-spec.md` defines what counts as a verified recipe.
   - `market-validation-runbook.md` defines how to test repeat use, rerun/fork,
     and paid behavior.
   - `market_signal.schema.json` records whether a market signal is a concrete
     behavior, commitment, or only a compliment.
   - `market_cohort.schema.json` records whether a batch has enough denominator,
     repeated behavior, support data, and claim permission to cite.
   - `task-01-p0-preregistration.md` fixes the first P0 run before any system
     output can bias the comparison.

## Old Claims Now Downgraded

The following claims appeared in earlier deck/memory logic and should not be
used as-is:

| Old claim | Current status | Replacement |
|---|---|---|
| "Hardware is empty" | False by omission | "The real-device build/run/repair/reuse workflow remains fragmented." |
| "AI hardware builder" | Too broad | "Verified hardware recipe workflow for ESP32-class prototypes." |
| "The physical world has no agent" | Too broad | "No dominant workflow owns verified hardware recipes from intent to rerun." |
| "Competitors only generate code" | Contradicted by PleaseDontCode/Cirkit/etc. | "Existing tools solve pieces; Blockless focuses on verified recipes." |
| "Closed loop is unique" | Contradicted by direct-substitute public claims | "Closed loop is contested; second-user rerunnable recipes are the stricter bet." |
| "No competitor has monetization" | Contradicted by PleaseDontCode/Embedr pricing pages | "Competitor pricing exists; paid adoption remains unverified." |
| "Schematik tried and failed" | Overclaim | "Schematik validates the category and raises stack/reliability questions." |
| "C/Arduino loop dies" | Benchmark-gated | "Arduino/PlatformIO is the baseline to beat." |
| "Python is 10x better than C for hardware" | Unsupported at embedded-task level | "MicroPython is a plausible v1 wedge." |
| "No compile, no flash" | Inaccurate for setup/bootstrap | "Fast hot-reload after firmware setup." |
| "Hardware App Store" | Market-gated | "Verified recipe registry first." |
| "Hardware sales are 70 percent of revenue" | Untested | "Kit attach and gross margin must be measured." |
| "$100M+ ARR" | Premature | "Use bottom-up scenarios only after repeat-use and paid behavior." |
| "Recipe appstore monetization is obvious" | Unsupported | "Competitor pricing proves paid surfaces exist, not that recipes monetize." |
| "AI PCB tools are different, so irrelevant" | Too dismissive | "AI PCB tools are adjacent narrative competitors; Blockless starts at the bench, not fab." |
| "Cursor/Lovable growth proves Blockless market" | False transfer | "Software vibe coding proves workflow appetite; hardware needs separate repeat-use and payment evidence." |
| "Generic AI cannot compete because it lacks hardware context" | Too brittle | "Generic agents can access tools/context; Blockless must prove verified hardware execution data improves outcomes." |
| "Vendors do not have our hardware context" | Too broad | "Vendors own static hardware truth; Blockless must prove dynamic execution history compounds." |
| "Blockless makes the physical world programmable" | Too broad | "Blockless starts with verified bench recipes; robotics/industrial IoT lifecycle claims need separate baselines." |
| "Live hardware iteration is unique" | Contradicted by live/block tools | "Live iteration exists; Blockless must prove verified recipe/rerun value." |
| "Arduino/Qualcomm is only a board story" | Too narrow | "Arduino App Lab/UNO Q is a platform pressure signal across IDE, apps, Python, AI models, modules, and distribution." |
| "MCU shipments prove TAM" | False transfer | "MCU shipments are industry background; Blockless needs active builder and paid behavior data." |
| "Arduino/Raspberry Pi installed base proves demand" | False transfer | "Installed base defines ecosystem pressure and possible channels, not Blockless conversion." |
| "Kickstarter hardware comps prove ARR" | False transfer | "Crowdfunding proves one-time product preorders, not recurring recipe/workspace demand." |

## Claims Safe Enough Today

These can appear in a careful deck:

- Hardware creation is fragmented across docs, drivers, wiring, pins, package
  versions, flashing, serial logs, and tutorials.
- AI code generation alone is not enough for hardware.
- Verified recipes are a sharper artifact than generated firmware or tutorials.
- V1 should be narrow: ESP32-S3/C3 plus a controlled module matrix.
- The moat could be the hardware execution context graph if verified runs make
  future runs more reliable.
- The appstore should start as a verified recipe registry.
- PleaseDontCode is the closest public full-loop benchmark; source pages prove
  claimed capabilities and pricing surfaces, not reliability or adoption.

## Claims That Need Benchmark Evidence

Do not use these until `blockless-benchmark/` has real run folders and result
JSON:

- Blockless is faster.
- Blockless has higher first-run success.
- Blockless repairs failures better.
- Blockless beats PleaseDontCode.
- Blockless beats ChatGPT/Cursor plus PlatformIO.
- MicroPython hot reload materially improves hardware creation.
- Recipes are more reproducible than tutorials or competitor projects.

## Claims That Need Market Evidence

Do not use these until user behavior exists:

- Users will do second and third projects.
- Users will rerun/fork recipes.
- Users will pay for recipes/packages.
- Users will buy kits after recipe preview.
- Schools or vendors will pay for curated recipe libraries.
- A marketplace will form.
- A subscription business will look like Cursor/Lovable.

## The 68 Tough Questions

### Category

1. If PleaseDontCode already claims wiring, flash, OTA, dashboard, public
   projects, and remote serial logs, what does Blockless uniquely own?
2. If Cirkit/Wokwi solve learning through simulation, why is physical-first
   better for the first wedge?
3. If ESPHome solves sensor/actuator automation declaratively, what task does
   Blockless win?
4. If PlatformIO handles boards/toolchains/libraries, what failure class remains
   Blockless-specific?
5. If Arduino/Adafruit/Seeed add AI to their docs/catalogs, what distribution
   advantage remains?
6. If Flux/Quilter/Diode own the phrase "AI hardware builder," should Blockless
   avoid that category label entirely?
7. If tscircuit owns hardware-as-code packages, what is the precise difference
   between a PCB package and a Blockless recipe?
8. If Node-RED/Blynk/Arduino Cloud already own app events, dashboards, and
   automations, what exactly remains in "send sensor events to my app"?

### Product

9. What is the exact recipe schema users see?
10. Which fields are required for second-user rerun?
11. What is the minimum hardware matrix where success rate is high?
12. What happens when a module clone has different pins or voltage behavior?
13. How does Blockless know the difference between code failure and wiring
    failure?
14. What is the minimum endpoint manifest needed before "AI workflow" or "my
    app" stops being hand-wavy?
15. Does the user experience look more like a tool, a recipe registry, a kit
    store, or a support-deflection system?

### Benchmark

16. What is first-run success on the 10 benchmark tasks?
17. What is median sentence-to-working-device time?
18. How many manual docs searches happen per successful build?
19. How many manual wiring changes happen?
20. How many repair loops are required?
21. Which failures are fixed from serial/run logs?
22. Does Blockless solve task 10 bad-pin repair?
23. Does generic AI plus PlatformIO solve 80 percent of v1?
24. Does PleaseDontCode produce an equivalent rerunnable artifact?
25. Does Wokwi/Cirkit beat Blockless for beginner setup?
26. Does ESPHome/Tasmota beat Blockless for home-automation-style tasks?
27. Does DeviceScript/Johnny-Five show the runtime advantage is not uniquely
    MicroPython?

### Market

28. Who is the first paying buyer: maker, school, vendor, workspace user, or kit
    buyer?
29. Does the same user make a second and third project?
30. Does recipe browsing turn into rerun?
31. Does rerun turn into fork?
32. Does fork turn into paid package/recipe/kit?
33. What is support cost per successful build?
34. Does support cost rise faster than module count?
35. Would users pay for Blockless if Flux/Diode/Quilter are paid by hardware
    startups for PCB/fab, not maker recipes?
36. Does software vibe-coding project creation translate to hardware project
    completion, or does physical friction kill the loop?
37. Does the user feel faster but actually spend more time debugging wiring,
    packages, and flash failures?
38. Does Blockless create monetizable recipes, or just demos like many
    non-monetized vibe-coded apps?

### Moat

39. What proprietary data does each failed run add?
40. Can a competitor copy the recipe schema without the run data?
41. Does the context graph measurably reduce future failures?
42. Which context is hardest to copy: board profiles, module manifests, repair
    traces, run logs, compatibility graph, or distribution?
43. If vendors expose official manifests, does Blockless gain a moat or become
    an orchestration layer with weak defensibility?

### Agent Plumbing

44. If board/module manifests become MCP servers, what proprietary context
    remains?
45. If Copilot/Claude/Codex/Cursor can call official docs, PlatformIO, esptool,
    and a serial monitor, what exact failure class remains Blockless-only?
46. Is Blockless's moat the schema, the agent, the UI, or the accumulated
    verified run graph?
46a. If Espressif exposes official docs and RainMaker through MCP, and ESP-Claw
     covers chat-defined IoT behavior on ESP chips, what ESP32 context can
     Blockless defensibly own?

### Direct Substitutes

47. If PleaseDontCode already has priced tiers, device counts, OTA, dashboards,
    public projects, browser flash, and remote serial logs, why is Blockless
    more than a recipe-shaped competitor?
48. If Embedr owns the pro workflow with firmware, board bring-up, serial,
    terminal, dependencies, Git, schematics, and PCB, which buyer segment should
    Blockless avoid at first?
49. If Cirkit simulation lets beginners finish more often before touching real
    hardware, is physical-first the right education wedge?

### Monetization

50. Are users paying for the recipe, the workspace, the kit, the device cloud,
    the support, or the service?
51. If Blynk/Particle own device/fleet recurring revenue, should Blockless
    export endpoint manifests instead of building an IoT cloud?
52. If Wokwi monetizes simulation/classrooms, what makes real-hardware labs a
    better first paid wedge?
53. If Flux/Embedr monetize pro seats and AI credits, is Blockless willing to
    compete as a pro tool, or should it stay maker/recipe-first?
54. What bottom-up inputs are required before any $100M ARR slide is honest?

### Platform / Vendor

55. Why will Blockless own the hardware context graph instead of Arduino,
    Espressif, Adafruit, Seeed, SparkFun, PlatformIO, or Particle?
56. Which Blockless fields are proprietary execution data rather than
    normalized vendor documentation?
57. If Arduino App Lab becomes the default surface for sketch/Python/AI
    hardware apps, is Blockless a destination, plugin, or backend recipe layer?
58. Can vendor tutorials become machine-readable recipes faster than Blockless
    can build marketplace liquidity?
59. If vendors publish official manifests for boards, modules, pins, libraries,
    and examples, does Blockless's moat get stronger or weaker?
60. What proof shows verified run logs and repair history reduce future
    failures beyond what vendor docs and generic AI can do?

### Market Data

61. Which market number measures Blockless's actual buyer, not adjacent hardware
    scale?
62. If 30B+ MCUs ship but most are embedded in finished products, what fraction
    corresponds to people building new projects from intent?
63. If Arduino/Raspberry Pi ecosystems are huge, why will users leave their
    existing IDEs, tutorials, clouds, and forums?
64. If Raspberry Pi demand is heavily industrial, does that support a maker
    recipe marketplace or a B2B support/prototyping wedge?
65. If Kickstarter proves one-time product preorder demand, what proves
    recurring workspace or recipe demand?
66. If AI consumer hardware succeeds or fails, why should that transfer to a
    creator tool rather than a finished-device market?
67. What bottom-up funnel converts visitors into first builds, second builds,
    reruns, forks, kit purchases, and paid workspaces?
68. What support cost and recipe maintenance burden must be subtracted before
    any ARR or hardware-revenue scenario is honest?

## Decision Rules

Use these rules before any deck rewrite:

1. If a claim names "first," "only," "empty," or "wins," assume it is unsafe.
2. If a claim compares speed, reliability, repair, or reproducibility, require a
   benchmark.
3. If a claim compares market size, ARR, appstore, or paid behavior, require
   user/payment data.
4. If a claim relies on Cursor/Lovable, translate it into a hardware artifact
   equivalent or remove it.
5. If a slide cannot name the exact user and task, narrow it.
6. If a slide cannot name the evidence gate, label it as roadmap or hypothesis.

## Immediate Work Queue

1. Run the P0 maker-prototyping benchmark:
   - Blockless;
   - ChatGPT/Cursor plus PlatformIO or Arduino CLI;
   - agentic IDE/CLI;
   - PleaseDontCode;
   - Embedr if accessible;
   - one tutorial baseline.
2. Follow `blockless-benchmark/p0-runbook.md`.
3. Add an agentic IDE/CLI baseline with docs retrieval, command execution,
   flashing, and serial-log inspection.
4. Capture evidence using `blockless-benchmark/run-sheet.md`.
5. Validate results against `blockless-benchmark/result.schema.json`.
6. Use the first benchmark batch to rewrite v13 deck.
   Check every upgraded deck sentence against
   `blockless-benchmark/claim-gate-matrix.json`, then run
   `blockless-benchmark/scan_deck_claims.py` on the deck.
7. Run `blockless-benchmark/market-validation-runbook.md` before making
   appstore, subscription, kit-attach, or paid-recipe claims.
   Summarize batches with `market_cohort.schema.json`; do not cite isolated
   signals as cohort evidence.
8. Do not add marketplace/education/IoT-cloud claims until their wedge gates
   pass.
9. Do not use broad "AI hardware builder" language unless the slide explicitly
   separates Blockless from AI PCB/ECAD/fabrication tools.
10. Before using "sensor events," "dashboard," "automation," "OTA," or
    "device-app workflow" as differentiators, run Gate 3 against ESPHome/Home
    Assistant, Arduino Cloud, Blynk, Particle where hardware fit exists, and
    Node-RED/Adafruit IO/Ubidots where the task is mainly routing or dashboarding.
11. Before using Cursor/Lovable/Replit/Bolt/v0 as market proof, run the
    software-analogy transfer check in `blockless-benchmark/market-validation-runbook.md`.
12. Before saying Blockless owns hardware context, module manifests, IDE
    distribution, or vendor-data advantage, run Gate 5 against PlatformIO,
    Arduino CLI/IDE/App Lab, ESP-IDF/Espressif VS Code, vendor docs plus
    generic AI, and one vendor tutorial conversion.
13. Before using "AI on hardware," "AI vision," "sound detection," "anomaly
    detection," "hardware vibe-coding," "connected product," "fleet," or
    "production IoT" language, run Gate 6 against Edge Impulse, SenseCraft,
    Blues Notehub, ThingsBoard, and Hologram when task fit exists.
14. Before using robotics lifecycle, physical-world platform, industrial IoT,
    factory AI, live hardware iteration, or no-code physical-computing language,
    check `blockless_adjacent_competitor_gap_refresh_2026_06_11.md` and add
    Viam, Golioth, Losant, Zerynth, MicroBlocks, or XOD baselines when task fit
    exists.

## Honest State

The research has produced a stronger story and a stricter evidence standard.
It has not yet produced proof that Blockless wins.

The correct investor posture is:

> We have identified the missing artifact: verified hardware recipes. We have a
> narrow wedge and a benchmark plan. The next milestone is proving we beat
> tutorials, generic AI plus PlatformIO, and PleaseDontCode on real hardware.
