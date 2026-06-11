# Blockless Adjacent Competitor Gap Refresh

Date: 2026-06-11

Purpose: close remaining desk-research blind spots around adjacent competitors
that are not direct Blockless substitutes, but can still punish broad pitch
language around robotics, industrial IoT, live physical computing, and
"programmable physical world" claims.

This refresh does not replace the P0 direct benchmark. PleaseDontCode remains
the closest closed-loop benchmark. The point here is narrower: if the deck
expands beyond verified ESP32 recipes, these adjacent systems become the
investor's comparison set.

## Newly Restored / Added Pressure Sources

| Source | What the source supports | What it does not prove | Blockless consequence |
|---|---|---|---|
| [Viam](https://www.viam.com/) | Robotics software platform positioning; hardware abstracted through APIs; registry for drivers and ML models; remote access/control; fleet monitoring; OTA for software and ML models | Intent-to-devkit recipe generation, wiring, pin/package repair, or second-user rerun | Do not claim Blockless makes the physical world programmable without separating bench recipes from robotics lifecycle/fleet platforms |
| [Golioth docs](https://docs.golioth.io/) | IoT cloud services for embedded devices, secure connections, OTA, device management, logs, settings, RPC, data routing, SDK support for Zephyr, nRF Connect SDK, ESP-IDF, and ModusToolbox | Natural-language hardware creation or reusable recipe artifacts | Production IoT baselines should include Golioth-style device-cloud workflows when Zephyr/ESP-IDF fleet value is claimed |
| [Losant](https://www.losant.com/) | Enterprise IoT application-enablement platform with low-code workflows, dashboards, provisioning, digital twins, multi-tenancy, edge agent, and industrial IoT positioning; public page also references a Losant MCP Server | Board/module/pin selection, firmware repair, or maker recipe demand | "Low-code IoT app/platform" and "AI over telemetry/config" language is not empty; Blockless must stay anchored to recipe creation unless measured against app-enablement platforms |
| [Zerynth](https://zerynth.com/) | Industrial AI copilot and IoT core for factories, edge devices, dashboards, anomaly detection, APIs, production visibility, machine control, ERP/MES integrations, and expert services | Maker/prototyper workflow or Blockless recipe superiority | Industrial AI/IoT claims are a different buyer and value chain; do not transfer them into maker recipe TAM |
| [MicroBlocks](https://microblocks.fun/) | Blocks programming for physical computing on microcontrollers; live interactive block execution on the board; real-time sensor graphs; no compile/download wait; portability across supported boards | Natural-language recipe generation, wiring repair, or marketplace demand | "Live hardware iteration" and "no compile wait" are not unique to Blockless/MicroPython; benchmark the runtime claim instead of asserting it |
| [XOD docs](https://xod.io/docs/) | Visual/dataflow programming for Arduino/Raspberry Pi-class hardware, browser/desktop IDE, hardware nodes/libraries, XOD Cloud, supported hardware, and project showcase | AI intent-to-hardware or verified rerunnable recipe quality | Visual programming has long occupied the no-code physical-computing wedge; Blockless must prove NL + verified recipes beat visual inspectability |

## Hard Question

> If Viam, Golioth, Losant, and Zerynth own robotics/industrial IoT lifecycle
> value, while MicroBlocks and XOD own live/visual physical-computing
> workflows, what is Blockless still allowed to claim?

Recommended answer:

> Blockless can claim only the bench-level verified recipe workflow until
> proven otherwise: intent to compatible ESP32-class parts, wiring, code,
> package versions, flash/run logs, repair context, and a second-user-rerunnable
> recipe. It should not claim robotics lifecycle, industrial IoT app-enablement,
> device-cloud/fleet operations, or unique live hardware iteration unless
> same-task evidence beats these adjacent systems.

## Updated Logic

### Robotics / Physical World Language

"Make the physical world programmable" is too broad. Viam uses a robotics
lifecycle frame with cloud-managed machines, hardware APIs, drivers, ML models,
remote control, fleet monitoring, and OTA. Blockless should avoid competing on
that entire category unless the task is explicitly a bench prototype recipe.

Safer language:

> Blockless turns a hardware intent into a verified bench recipe.

Not:

> Blockless is the platform for programming the physical world.

### Industrial IoT / Production Claims

Golioth, Losant, and Zerynth show that production IoT value is often:

- secure device connectivity;
- OTA and settings;
- logs, RPC, and fleet management;
- low-code workflow/application enablement;
- dashboards and digital twins;
- factory analytics, anomaly detection, and ERP/MES integration;
- support and services.

Those are not Blockless's current evidence base. If the deck says production
IoT, industrial AI, robotics lifecycle, or connected-product platform, it must
add these baselines to Gate 6.

### Live Physical-Computing Claims

MicroBlocks directly challenges any claim that live hardware interaction,
sensor graphs, and avoiding compile/download waits are novel. XOD challenges
the idea that no-code physical computing is new. Blockless can still win if
verified recipe state and second-user reruns beat blocks/dataflow tools, but it
needs benchmark evidence.

## Deck Consequences

Do not use these claims without benchmark evidence:

- "No compile or download wait is unique."
- "Blockless owns live hardware iteration."
- "Blockless is the physical-world programming platform."
- "Blockless owns industrial IoT."
- "Blockless owns robotics workflows."
- "No-code hardware is empty."

Allowed today:

- "Live and visual hardware tools exist; Blockless's narrower bet is verified
  recipes that capture execution and repair context."
- "Industrial IoT and robotics platforms own downstream lifecycle value;
  Blockless starts upstream at bench recipe creation."

## Benchmark Implication

Do not add all of these to P0. Add them only when the claim requires it:

- Add `viam` for robotics/machine-lifecycle claims.
- Add `golioth` for Zephyr/ESP-IDF device-cloud, OTA, logs, settings, RPC, or
  fleet claims.
- Add `losant` or `zerynth` for industrial IoT app-enablement, dashboards,
  workflows, factory analytics, or AI-copilot-over-telemetry claims.
- Add `microblocks` or `xod` for live/visual physical-computing, education, or
  no-code hardware claims.

## What Remains Unresolved

Desk research can only say these systems are relevant pressure. It cannot say
Blockless loses or wins.

The unresolved evidence question is:

> On the same hardware task, does Blockless create a more rerunnable physical
> artifact with lower support burden than these adjacent tools when their
> workflow actually fits the job?
