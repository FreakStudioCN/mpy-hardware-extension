# Market Validation Runbook

Date: 2026-06-11

Purpose: test whether Blockless is a repeated workflow and business, not just a
compelling first demo.

Do not use this runbook to set pricing. Use it to observe behavior.

Read `../blockless_monetization_falsification_audit.md` before interpreting
pricing or paid-behavior signals. Competitor pricing proves paid surfaces exist;
it does not prove Blockless users will pay for recipes.

Record each observed behavior as a `market_signal.schema.json` object and
validate it before using it in a deck or memo:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_signal.schema.json path\to\market-signal.json
```

Validation is only a structure check. It does not turn compliments into demand.

Summarize each experiment batch with `market_cohort.schema.json`:

```powershell
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_cohort.schema.json path\to\market-cohort.json
```

The cohort summary is the deck gate. Individual signals can show what happened;
the cohort summary must show denominator, segment mix, repeat behavior,
commitments, support load, follow-up, and forbidden inferences before a market
claim is allowed.

## Core Question

> After a successful first hardware run, does the user come back, rerun/fork a
> recipe, buy/commit to hardware or support, or ask to publish/share?

If the answer is no, Blockless may still be a useful tool, but the deck should
not claim appstore, marketplace, subscription, or Cursor/Lovable-like behavior.

## Market Behaviors To Measure

| Behavior | What it means | What it can support |
|---|---|---|
| Second project | User sees Blockless as workflow, not novelty | Workspace or repeat-use claim |
| Third project | Early habit formation | Stronger workflow-market claim |
| Recipe rerun | User trusts someone else's artifact | Recipe registry claim |
| Recipe fork/edit | User sees recipes as reusable building blocks | Appstore/platform direction |
| Kit/module attach | Recipe drives hardware purchase or commitment | Hardware business hypothesis |
| Paid recipe/package interest | Recipe saves enough failure time to monetize | Marketplace hypothesis |
| Vendor/school support interest | Institution values reduced support failures | B2B wedge |
| Support-ticket reduction | Recipes reduce operational pain | Vendor/school ROI |

## Minimum Cohort

Run at least:

- 10 maker/prototyper users;
- 5 second-user rerun attempts;
- 3 school/maker-space/vendor conversations;
- 1 actual commitment event, not just compliments.

Do not call results conclusive. This is an early signal screen.

Each signal must distinguish:

- compliment or curiosity;
- user-initiated behavior;
- completed behavior;
- concrete next step;
- paid unit selected;
- support touches required;
- day-7 and day-30 follow-up status.

## Software-Analogy Transfer Check

Run this check before using Cursor, Lovable, Replit, Bolt, v0, Copilot, Codex,
or Claude Code as more than a workflow analogy.

| Borrowed software claim | Hardware behavior to measure | Minimum early signal |
|---|---|---|
| Daily/repeated AI workflow | Same user starts project 2/3 within 7-30 days | At least 3 of 10 users start project 2 without heavy prompting |
| Cloneable template/project | Second user reruns recipe from artifact only | At least 3 of 5 reruns succeed without undocumented help |
| Fast inspectable artifact | User explains wiring, pins, packages, logs, and behavior proof | Majority can identify what will be wired/flashed before running |
| Debugging assistance | Repair uses real logs and classifies failure correctly | At least one nontrivial pin/package/wiring/runtime failure is repaired |
| Subscription-like value | User takes a concrete paid-workspace or repeated-use step | Commitment tied to future builds, not a compliment |
| Marketplace/appstore value | Users rerun and fork other users' recipes | Rerun and fork both happen before marketplace language |
| Creator expansion | Nontechnical users complete follow-up hardware builds | Completion without founder/expert rescue |

If a software claim cannot be mapped to one of these observed hardware
behaviors, it can appear only as analogy shape, not as market proof.

## Experiment 1: Second Project Test

Question:

> Does a user who completed one Blockless project start another project within
> 7 or 30 days?

Procedure:

1. Give the user one successful guided Blockless build.
2. Let the user choose from 3 follow-up recipes.
3. Do not prompt them daily; send one neutral follow-up.
4. Track whether they start, complete, or abandon project 2.
5. Repeat for project 3 if project 2 completes.

Measure:

- day-7 second-project start rate;
- day-30 second-project start rate;
- second-project completion rate;
- third-project start rate;
- manual support touches;
- whether user asks for new modules/recipes.

Kill condition:

- Users enjoy the first demo but do not start a second project.
- Second project needs heavy support.

## Experiment 2: Recipe Rerun Test

Question:

> Can a different user rerun a verified recipe without hidden context?

Procedure:

1. Pick one level-3+ recipe from `verified-recipe-spec.md`.
2. Give a second tester only the recipe artifact.
3. Do not explain undocumented setup.
4. Record completion, time, interventions, and failure labels.
5. Compare against a high-quality tutorial for the same project.

Measure:

- rerun success rate;
- elapsed time;
- undocumented help needed;
- package/wiring/pin failures;
- user confidence after rerun;
- whether the second user would fork it.

Kill condition:

- Second tester needs the original creator's help.
- Tutorial completion is higher or easier.
- Clone module/board variation breaks the run.

## Experiment 3: Fork/Edit Test

Question:

> Do users treat recipes as building blocks?

Procedure:

1. Give users a working recipe.
2. Ask them to make one specific modification:
   - change threshold;
   - swap display text;
   - add buzzer;
   - send a new event field;
   - move to a compatible module variant.
3. Track whether the user modifies through Blockless, code, or manual docs.

Measure:

- fork started;
- fork completed;
- repair loops;
- new recipe published;
- whether compatibility metadata prevented a mistake.

Kill condition:

- Users copy code manually instead of forking.
- Small changes break reproducibility.

## Experiment 4: Kit/Module Attach Test

Question:

> Does recipe preview create hardware purchase or commitment intent?

Procedure:

1. Show users a recipe preview before they own all parts.
2. Ask them to choose:
   - use their existing parts;
   - request compatible part list;
   - join a kit waitlist;
   - ask for school/vendor batch support.
3. Track actual commitment actions, not verbal enthusiasm.

Measure:

- compatible part-list request rate;
- kit waitlist or preorder intent;
- module substitution requests;
- abandoned due to parts friction;
- support questions before purchase.

Kill condition:

- Users prefer buying from Adafruit/Seeed/Amazon without Blockless owning the
  workflow.
- Parts logistics dominate the product value.

## Experiment 5: Paid Behavior Test

Question:

> Which paid behavior appears first: workspace, kit, recipe/package, vendor
> support, school lab, or prototyping service?

Procedure:

1. After a successful run or rerun, present non-priced paid options:
   - save/manage multiple recipes in a workspace;
   - get a compatible kit;
   - unlock/commission a verified recipe for a module;
   - get vendor-supported recipe maintenance;
   - run a classroom/maker-space lab kit;
   - request paid prototyping help.
2. Ask the user to choose the one they would actually act on.
3. Record whether they take a concrete next step.

Concrete next steps:

- joins waitlist;
- shares purchasing contact;
- asks for invoice/procurement path;
- commits to pilot;
- introduces school/vendor/maker-space buyer;
- returns with a second paid-use case.

Measure:

- option selected;
- commitment action;
- buyer type;
- reason for refusal;
- required proof before payment.

Kill condition:

- Users like the product but choose no paid next step.
- Every paid path requires a different buyer than the user.

## Experiment 6: Vendor/School Support-Deflection Test

Question:

> Would an institution pay because verified recipes reduce support and lab
> failure?

Procedure:

1. Pick one module/vendor or school lab scenario.
2. Convert one common tutorial into a verified recipe.
3. Run with multiple users.
4. Compare support touches against the original tutorial.
5. Ask the institution whether reduced support is valuable enough to sponsor
   maintenance or deployment.

Measure:

- support touches per successful build;
- failed builds;
- time to first working device;
- staff/teacher intervention count;
- maintenance burden;
- sponsor/pilot interest.

Kill condition:

- Support does not decrease.
- Staff prefers tutorials because they teach context better.
- Procurement cycle is too slow for v1.

## Experiment 7: Vibe-Coding Analogy Transfer Test

Question:

> Which parts of the software vibe-coding loop actually survive contact with
> hardware?

Procedure:

1. After a successful first build, show the user the generated artifact.
2. Ask them to inspect it before touching code:
   - what hardware is required;
   - how it is wired;
   - which package/library versions matter;
   - how it will be flashed and run;
   - what logs prove behavior;
   - what failures are known.
3. Ask the user to choose a next action:
   - rerun the same recipe;
   - fork it;
   - start a second recipe;
   - buy/request parts;
   - save/manage a workspace;
   - share it with another builder;
   - stop after the demo.
4. Track actual behavior over 7 and 30 days.
5. Compare each behavior to the software analogy claim it would support.

Measure:

- artifact-inspection success;
- second-project start and completion;
- rerun and fork attempts;
- time between build sessions;
- support touches per session;
- paid or procurement next step;
- refusal reason if no next step happens.

Kill condition:

- Users like the demo but do not return.
- Users cannot inspect the artifact without expert explanation.
- Users prefer tutorials or videos for trust.
- Users want a finished kit/device, not a repeated creation workflow.
- Paid interest appears only after founder support, not from the product
  artifact.

## Segment Decision Rules

| Result | Deck implication |
|---|---|
| Makers do second/third projects | Workspace/prototyping workflow may be viable |
| Makers do one project only | Position around kit + recipe bundle, not subscription |
| Reruns/forks happen | Verified recipe registry is defensible |
| Reruns fail | Do not use appstore language |
| Kit attach is strong | Hardware business may be first |
| Vendor/school support interest is strong | B2B support-deflection wedge may be first |
| No paid behavior appears | Keep deck as technical workflow thesis, not business model proof |

## Paid Unit Decision Rules

| First paid pull | Early interpretation | What not to claim |
|---|---|---|
| Workspace | Repeat projects may exist | Cursor-like subscription before retention |
| Kit | Hardware attach may be first | SaaS gross margin or marketplace liquidity |
| Verified recipe | Recipe saves debug time | Appstore scale before rerun/fork volume |
| Vendor support | Support-deflection wedge may be real | Maker marketplace demand |
| School lab | Institutional wedge may be real | Consumer creator demand |
| Prototyping service | Services can validate pain | Product-led SaaS |
| Device cloud | Recurring IoT value exists | That Blockless beats Blynk/Particle |

## Required Evidence Files

For each market experiment, save:

```text
market_runs/
  YYYY-MM-DD-experiment-user-or-org/
    summary.md
    consent-notes.md
    recipe-used/
    run-results/
    follow-up-log.md
    commitment-evidence.md
  YYYY-MM-DD-experiment-cohort-summary.json
```

Do not record private personal data beyond what is necessary for follow-up.

## Questions To Ask After Each Session

Ask behavior questions, not compliment questions:

1. What would you build next?
2. When would you build it?
3. What stopped you today?
4. Would you rather rerun a recipe or follow a tutorial?
5. What part would you trust least?
6. What would you pay someone to remove?
7. Would you share this recipe with someone else?
8. Would you use someone else's recipe?
9. What proof would make you buy the kit/module/workspace/support?
10. Who else must approve this purchase or deployment?

## What Not To Conclude

Do not infer:

- willingness to pay from "this is cool";
- subscription from one successful demo;
- appstore from recipe browsing;
- marketplace from recipe publishing;
- education adoption from one teacher compliment;
- vendor willingness from a friendly technical conversation.

Only behavior counts.
