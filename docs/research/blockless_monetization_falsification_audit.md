# Blockless Monetization Falsification Audit

Date: 2026-06-11

Purpose: pressure-test whether Blockless should make claims about appstore,
subscriptions, kits, paid recipes, or $100M ARR before market behavior exists.

This document uses competitor pricing as evidence of monetization surfaces, not
evidence of customer adoption, retention, or revenue scale.

## Bottom Line

Competitors already show that hardware-adjacent software can charge money.

They do not show that users will pay for verified recipes.

The pricing objects visible in the market are mostly:

- AI credits or requests;
- seats/editors;
- private projects;
- devices/fleets;
- data operations/messages;
- build/CI minutes;
- OTA/update capability;
- dashboards/apps;
- support, SLA, security, and procurement;
- hardware/devices/services.

The missing proof is:

> Will users pay for a recipe because it saves hardware failure time and makes a
> second-user rerun more likely?

Record proof using
`docs/research/blockless-benchmark/market_signal.schema.json`. A validated
market signal is still not enough by itself; it must record concrete behavior
or commitment, not only enthusiasm. Summarize batches with
`docs/research/blockless-benchmark/market_cohort.schema.json` before citing any
market conclusion in a deck; the cohort must show denominator, segment mix,
support load, follow-up, and claim permissions.

Until that is proven, Blockless should say:

> The first business model is an open question. We are testing workspace, kit,
> verified recipe, vendor support, school lab, and prototyping-service demand.

Not:

> Hardware appstore monetization is obvious.

## Pricing Objects In The Market

| Category | Examples | What they charge for | What this proves | What it does not prove |
|---|---|---|---|---|
| Direct AI firmware/workflow | PleaseDontCode, Embedr | Credits, devices, private projects, OTA, AI model access, pro features | Direct substitutes can ask for subscription-like payment | Users will pay Blockless for recipe/rerun artifacts |
| IoT app/cloud | Blynk, Particle | Devices, users, messages/data operations, dashboards, automations, SLA, support | Device/fleet operations are established paid surfaces | Device creation or recipe marketplace demand |
| Simulation/education | Wokwi | Build minutes, private/unlisted projects, VS Code/offline plugin, classroom licenses, CI minutes | Simulation and classroom workflows can monetize without physical-first recipes | Real hardware recipe value |
| AI ECAD/PCB | Flux | Seats/editors, AI usage credits, private projects, imports, team workspaces, enterprise controls | Pro hardware design tools can charge high seat prices | Maker recipe subscriptions or kit attach |
| Software vibe coding | Cursor, Lovable, Replit/Bolt/v0 class | Seats, subscriptions, usage, deployments/projects | Users pay for fast software artifact loops | Hardware repeat-use/payment frequency |

## Direct Pricing Pressure

### PleaseDontCode

Public pricing exposes a credible direct monetization shape:

- free plan with credits and one device;
- paid tiers around credits, device count, private projects, AI copilot, and OTA;
- payment through Stripe-supported methods;
- credits consumed by wiring schematic generation, code modification, and
  finalization/flash.

Implication:

Blockless cannot say "no one has monetization." A direct competitor already
charges around the firmware/device workflow. Blockless must prove a better paid
unit than credits/devices/OTA.

### Embedr

Embedr pricing exposes a pro-tool shape:

- free limited usage;
- paid Hobby and Pro plans;
- model access as a pricing axis;
- AI credits;
- PCB auto-place/auto-layout on higher tier;
- team/enterprise custom pricing.

Implication:

For embedded/prototyping users, the natural paid object may be a seat or AI
credit inside a serious workspace, not a recipe marketplace. Blockless should
avoid pro-user claims unless it beats this workflow.

### Blynk

Blynk pricing is device/fleet/application oriented:

- free exploration tier;
- paid Starter/Prototype/Production tiers;
- device count, users, retention, messages, dashboards, AI workflows,
  multi-tenancy/RBAC, SLA, and support as value axes;
- enterprise white-label/private-infrastructure option.

Implication:

"Send sensor events to my app" is a commodity paid surface. If Blockless enters
IoT cloud, it competes with mature device/app pricing. Blockless should instead
own device creation and recipe-to-endpoint packaging unless it has cloud
workflow evidence.

### Particle

Particle pricing is deployment and data-operations oriented:

- free tier for prototyping/personal/education;
- paid blocks around 100 devices and data operations;
- premium support, connectivity, retention, implementation services,
  certification, device discounts, and procurement as enterprise levers.

Implication:

The paid buyer in serious IoT is often paying for fleet reliability, data
operations, support, and procurement. Blockless's recipe object must either feed
those systems or prove it reduces creation/support cost before fleet scale.

### Wokwi

Wokwi pricing is simulation/workflow oriented:

- free community/open-source projects;
- paid personal/pro tiers around fast build minutes, unlisted projects, custom
  libraries, private IoT gateway, VS Code/offline plugin, CI minutes;
- classroom license path.

Implication:

Education and beginner workflows can monetize by reducing setup, offering
privacy, and supporting classrooms/CI. Blockless must prove real-hardware
recipes produce more value than simulation-first learning.

### Flux

Flux pricing is pro hardware-design workspace oriented:

- starter/pro/team/editor pricing;
- AI credits as a metered resource;
- private projects and public projects;
- imports, workspaces, enterprise privacy/security/SOC2/SLA/invoicing.

Implication:

AI hardware design tools already look like pro SaaS. If Blockless borrows
software-style seat pricing, investors may compare it to Flux/Embedr, not
maker recipes. That comparison is only good if Blockless targets pro users with
pro-grade workflow evidence.

## What Pricing Comparables Actually Say

Safe conclusions:

- Hardware-adjacent software can charge.
- Device/fleet operations are proven pricing objects.
- Seats, credits, private projects, and support are familiar monetization units.
- Simulation/classroom workflows can charge without physical-first hardware.
- AI ECAD/PCB tools can charge much more than maker tools.

Unsafe conclusions:

- Users will pay per verified recipe.
- Recipe marketplace liquidity will emerge.
- Kit attach will be large enough to define the business.
- Maker hobbyists will subscribe monthly at software-like frequency.
- Schools/vendors will buy before support reduction is measured.
- Cursor/Lovable ARR supports Blockless ARR.

## Blockless Business Model Kill Tests

| Model | What must happen | Kill condition | Deck consequence if killed |
|---|---|---|---|
| Workspace subscription | Users start second/third projects and want saved recipes/logs/devices | Users do one demo and stop | Do not pitch Cursor-like subscription |
| Paid verified recipe | Users pay to avoid debug time or unlock a reliable module workflow | Users browse but do not rerun/pay | Keep "recipe registry," not marketplace |
| Kit attach | Recipe preview causes waitlist/preorder or part-list commitment | Users buy elsewhere or abandon due to parts | Do not model hardware as 70% revenue |
| Vendor support | Vendor sees fewer support tickets from verified recipes | Support touches do not drop | Do not pitch vendor-support wedge |
| School lab | Teacher/staff intervention drops versus tutorial/simulation | Physical kits increase support burden | Do not lead with education physical-first |
| IoT/device cloud | Device/app workflows create recurring device value | Blynk/Particle/Arduino Cloud own the recurring layer | Export endpoint manifests instead of building cloud |
| Pro workspace | Embedded users pay for serious workflow | Embedr/Flux/PlatformIO are preferred | Stay maker/recipe wedge first |
| Prototyping service | Users pay for done-with-you build help | Service demand dominates product usage | Treat as services-led validation, not SaaS proof |

## Pricing Questions For User Tests

Ask after the user has succeeded or rerun a recipe, not before:

1. What would you pay to avoid next time: wiring uncertainty, package errors,
   flash failure, parts selection, app endpoint setup, or support?
2. Would you rather pay per month, per recipe, per kit, per module, per class,
   or per device?
3. Would you pay before the recipe works, after first run, or only after second
   user rerun proof?
4. If the recipe were free, would you pay for compatible parts?
5. If parts were cheap, would you pay for verified support?
6. If support were free, would you still need the workspace?
7. Who has budget: the maker, teacher, lab, vendor, startup, or client?
8. What proof would make procurement possible?

## Bottom-Up Model Requirements

Do not build a $100M ARR slide until these are measured:

- active builders per month;
- projects per active builder;
- second-project rate;
- third-project rate;
- recipe rerun rate;
- fork/edit rate;
- paid conversion by model;
- ARPU by buyer segment;
- kit attach rate and gross margin;
- support cost per successful build;
- churn or repeat interval;
- recipe supply creation cost;
- recipe maintenance cost across board/module/package versions.

## Deck Consequence

Use:

> Competitors show several paid surfaces: AI credits, devices, seats, private
> projects, build minutes, dashboards, support, and enterprise controls.
> Blockless is testing which paid unit fits verified hardware recipes.

Avoid:

> The appstore business model is obvious.

Avoid:

> Hardware sales will be 70 percent of revenue.

Avoid:

> The subscription will look like Cursor/Lovable.

Those are output metrics after behavior, not assumptions before behavior.
