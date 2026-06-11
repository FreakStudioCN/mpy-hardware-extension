# Blockless Competitor Source Refresh - 2026-06-11

Purpose: refresh the closest live competitor pages and question whether the
current Blockless diligence is citing the right source, drawing the right
inference, and prioritizing the right benchmark.

This is not a reliability audit. Product pages prove public claims and pricing
surfaces. They do not prove the product works, users retain, or users pay.

## Bottom Line

The direct-substitute pressure is stronger after this refresh, not weaker.

PleaseDontCode is the sharpest immediate pressure because its current public
site claims a hardware-aware loop across wiring, firmware, compile/auto-fix,
browser flashing, OTA/fleet updates, dashboards, public projects, and remote
serial logs. Its pricing page also exposes self-reported builder/update counters
and a project-download feature on the highest tier.

That still does not prove adoption or reliability. It does mean Blockless cannot
lean on "closed loop" or "browser flash" as differentiation. The only stronger
claim left is:

> Blockless produces a more complete verified recipe artifact that a second user
> can rerun with fewer hidden steps and better repair context.

That claim remains unproven.

## Refreshed Sources

| Source checked | What the page currently supports | What it does not support | Diligence consequence |
|---|---|---|---|
| [PleaseDontCode](https://www.pleasedontcode.com/) | AI writes firmware, generates wiring, supports 29+ boards, compiles/auto-fixes, flashes from browser, offers OTA/POTA, dashboards, remote serial, public projects | Task success, physical reliability, second-user rerun, actual paid retention | Treat as P0 direct benchmark, not an example of "codegen only" |
| [PleaseDontCode pricing](https://www.pleasedontcode.com/pricing/) | Paid tiers around credits, IoT devices, OTA, private projects, project download, support; page shows self-reported builder/update counters | Verified revenue, active users, independent adoption, retention | Use as monetization-surface evidence only; do not use counters as market proof |
| [Embedr](https://www.embedr.app/) | AI workspace for firmware, board bring-up, KiCad schematics/PCB, build/flash/monitor, serial terminal/output, dependencies, Git/checkpoints | Natural-language wiring quality, real hardware success, recipe rerun artifact | Real pro-workflow pressure; must not be confused with `embedr.ai` |
| [Embedr pricing](https://www.embedr.app/pricing) | Free/Hobby/Pro tiers, AI credits, model access, Pro PCB auto-place/layout, team demo path | Paid conversion or retention | Pro users may compare Blockless with seat/credit workspace pricing |
| [embedr.ai](https://embedr.ai/) | Generic private-knowledge/RAG product | Embedded hardware workflow | Do not cite this domain for embedded competitor claims |
| [Cirkit Designer](https://www.cirkitdesigner.com/) | AI wiring/code, browser simulation, firmware running in browser, share links, browser upload, custom components, classroom positioning | Physical flash reliability, classroom outcomes, repair depth | Education/beginner wedge needs simulation-first baseline |
| [Schematik](https://www.schematik.io/) | Sparse official surface: AI Hardware IDE framing, guides/parts/blog/download navigation, funding announcement | Product reliability, workflow depth, Blockless superiority | Treat as narrative/guide/parts pressure until product output is inspected |
| [WIRED on Schematik](https://www.wired.com/story/schematik-is-cursor-for-hardware-anthropic-wants-in-on-it) | Media framing around "Cursor for hardware," funding, low-voltage safety, parts/assembly guidance | Exact technical performance or failure | Use only as narrative pressure; do not claim Schematik failed |
| [Aily Blockly GitHub](https://github.com/ailyProject/aily-blockly) | Open-source AI hardware IDE with board/library management, AI project/code/library/config generation, pin/wiring diagrams, serial tool, visible stars/releases | Install reliability, western adoption, production quality | Open-source clone pressure; benchmark before saying v1 is hard to reproduce |

## Hard Questions From This Refresh

### 1. If PleaseDontCode already claims compile/fix/browser flash/OTA/dashboard/remote serial, what does Blockless own?

Recommended answer:

> Nothing broad. Blockless only owns something if the verified recipe artifact
> is visibly deeper and second-user reruns work better. The benchmark must
> inspect artifact completeness, not just whether the first demo flashes.

Bad answer:

> PleaseDontCode is only codegen.

### 2. If PleaseDontCode has pricing plus device/fleet language, can Blockless still claim the obvious paid unit is recipes?

Recommended answer:

> No. PleaseDontCode makes credits, devices, OTA, private projects, project
> download, and support look like more natural paid objects. Blockless must
> test whether users pay for recipes, kits, workspace, support, or services.

Bad answer:

> A hardware appstore will monetize like software.

### 3. If Embedr is a pro embedded workspace, should Blockless chase pro users first?

Recommended answer:

> Not without evidence. Pro users will compare against serious workspaces with
> terminal, serial, build options, dependencies, Git, PCB, and model access.
> Blockless should start where the verified recipe/rerun artifact creates a
> sharper difference.

Bad answer:

> Pro users will switch because natural language is easier.

### 4. If Cirkit lets classrooms simulate before hardware, why is physical-first better?

Recommended answer:

> It may not be. Physical-first wins only if the kit/recipe path lowers total
> teacher intervention and produces real-device completion without more support
> burden. Otherwise, Cirkit/Wokwi are better first classroom baselines.

Bad answer:

> Simulation is not real hardware, so it does not matter.

### 5. If Schematik owns the media phrase, should Blockless use "Cursor for hardware"?

Recommended answer:

> Use it only as a quick analogy, never as the category claim. The category
> claim should be "verified hardware recipe workflow" unless benchmark and
> market evidence support broader language.

Bad answer:

> Schematik failed, so the phrase is free.

## New Benchmark Priority

The P0 benchmark should not merely compare first-run success. It must compare:

1. First-run success on the same task.
2. Manual context supplied outside the product.
3. Build/flash/log/repair evidence captured.
4. Artifact completeness.
5. Whether public/share/project-download artifacts preserve enough state.
6. Second-user rerun without founder/session context.
7. Paid-object clarity after success.

For PleaseDontCode specifically, record whether project download/public project
state includes code, wiring, board, pins, package/library versions, compile
state, flash method, dashboard/endpoint state, remote serial/log state, and
version history.

## Source-Hygiene Rules Added

1. Cite `embedr.app` for the AI embedded workspace. Do not cite `embedr.ai`.
2. Treat PleaseDontCode counters as self-reported marketing data unless
   independently verified.
3. Treat pricing pages as proof of packaging, not proof of conversion.
4. Treat GitHub stars/releases as project activity, not product adoption.
5. Treat press as narrative/funding evidence, not technical superiority.

## Current Verdict

The source refresh does not change the narrowed thesis:

> Blockless is a verified hardware recipe workflow for a controlled ESP32 module
> matrix.

It does make the proof burden sharper:

> Blockless must beat PleaseDontCode on artifact/rerun quality, not simply on
> being "closed loop."
