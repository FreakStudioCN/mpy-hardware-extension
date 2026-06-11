# Blockless Market Size and Data Falsification Audit

Date: 2026-06-11

Purpose: pressure-test every large number that could be used to make Blockless
look inevitable: MCU shipments, Arduino/Raspberry Pi installed base,
Kickstarter hardware comps, AI hardware product revenue, Cursor/Lovable ARR,
and generic STEM/maker populations.

This document is stricter than a source ledger. It asks whether a number proves
the exact behavior Blockless needs:

> a user repeatedly creates, reruns, forks, pays for, or distributes verified
> hardware recipes.

## Bottom Line

Most big numbers are not wrong. They are just the wrong proof.

The market question is not:

> Are there many MCUs, boards, makers, STEM students, Kickstarter backers, or AI
> coding users?

The market question is:

> How many people have a repeated hardware-creation workflow painful enough to
> pay for Blockless, and which paid unit do they choose?

Until Blockless has cohort data, use large adjacent numbers only as background
context, not as proof of TAM, ARR, or appstore inevitability.

## Data Claim Ladder

| Claim type | Example | Current status | Why |
|---|---|---|---|
| Industry scale | "Billions of MCUs ship" | Background only | Shipments are mostly invisible embedded volume, not active creators |
| Installed base | "Arduino/Raspberry Pi have tens of millions of users/units" | Weak wedge context | Units/users do not equal repeat project builders or recipe buyers |
| Crowdfunding comps | "Hardware campaigns can raise millions" | Launch-channel context | Campaign demand is not recurring workflow demand |
| Consumer AI hardware revenue | "Plaud/Rabbit/Humane/Limitless show AI hardware demand" | Mostly irrelevant unless selling finished devices | Finished-product buyers differ from hardware-creation tool users |
| Software AI ARR | "Cursor/Lovable grew fast" | Analogy only | Software usage frequency and deployment physics differ |
| Education population | "Millions of STEM students" | Buyer-discovery context | Students are not buyers; teachers/labs/schools buy under support constraints |
| Bottom-up cohort | "X active builders, Y repeat rate, Z paid conversion" | Deck-grade if measured | Directly models Blockless behavior |

## Source-by-Source Stress Test

### 1. MCU Shipment And Market-Size Numbers

Older notes cite Yole-style MCU numbers such as 30.6B units shipped and roughly
$27B market size. In this pass, I did not get a usable primary-source capture
for the Yole report page or report contents.

Even if the number is accurate, it does not prove Blockless demand.

Why:

- MCU shipment volume includes automotive, industrial, appliances, commodity
  electronics, white goods, and deeply embedded products.
- Most shipped MCUs are not in the hands of people trying to create new
  projects from one sentence.
- Unit shipment volume says nothing about software workflow frequency,
  willingness to pay, recipe rerun, or kit attach.
- A huge silicon base can coexist with a tiny creator-tool market.

Allowed:

> The embedded world is large and fragmented.

Not allowed:

> 30B+ MCUs imply a large Blockless TAM.

### 2. Arduino Community / IDE User Numbers

Public reports and media commonly cite Arduino at tens of millions of users or
more than 30M/33M community scale. The strongest recent signal from the current
source pass is Qualcomm/Arduino coverage around the Arduino acquisition and UNO
Q launch, which reports more than 33M active users.

This supports:

- Arduino is a massive maker/developer ecosystem.
- Arduino is a plausible distribution/context baseline.
- Arduino/Qualcomm platform moves matter.

It does not prove:

- those users are active monthly hardware creators;
- they will switch from Arduino IDE/App Lab/Cloud/Project Hub;
- they will pay for Blockless;
- they want a recipe marketplace instead of official examples/tutorials;
- they have recurring project frequency comparable to software developers.

Investor question:

> Of the 30M+ Arduino-like users, how many built a physical project in the last
> 30 days, got stuck, would trust AI to repair it, and would pay?

If that funnel is unknown, do not use the top-line number as TAM.

### 3. Raspberry Pi Unit Sales

Current secondary/financial reporting points to more than 60M-68M Raspberry Pi
units sold, with Raspberry Pi Holdings' public-company context indicating a
large industrial/embedded component of demand. Some summaries cite around 70%
of sales to industrial customers in 2024.

This supports:

- low-cost physical computing is a large ecosystem;
- education/enthusiast/professional use cases coexist;
- hardware distribution can scale;
- industrial embedded demand is real.

It weakens sloppy maker TAM:

- industrial Pi buyers are not the same as hobbyist recipe buyers;
- unit sales are cumulative, not monthly active builders;
- a board installed in a factory is not a Blockless appstore user;
- hardware demand can be B2B/industrial, not creator-marketplace demand.

Safer use:

> Raspberry Pi shows physical computing has mainstream scale, but its industrial
> mix warns against treating unit sales as maker-tool TAM.

### 4. Kickstarter Hardware / Product-Design Comps

Kickstarter can show launch-channel appetite and hardware-product willingness
to prepay. Public Kickstarter statistics and year-end coverage show large
platform scale and occasional multi-million-dollar hardware/product-design
campaigns.

But Kickstarter proves a different behavior:

- backing a finished product;
- preordering a gadget;
- supporting a creator campaign;
- buying a one-time reward.

Blockless needs:

- repeat hardware creation;
- workspace retention;
- recipe rerun/fork;
- paid recipe/package/kit behavior;
- support-cost economics.

Therefore:

> Kickstarter is a launch-channel comp, not a workflow-market proof.

A hardware campaign can raise millions while the number of people who want to
build hardware repeatedly remains small.

### 5. AI Consumer Hardware Revenue / Funding

Older notes cite AI hardware products such as Humane, Rabbit, Friend, Limitless,
and Plaud as evidence of AI hardware demand.

This is mostly the wrong buyer unless Blockless sells finished products.

Finished-product demand proves:

- consumers buy a device if the job-to-be-done is clear;
- hardware can carry AI value;
- distribution and industrial design matter.

It does not prove:

- makers want to create their own AI hardware;
- users want to buy recipes;
- users will maintain physical projects;
- creator tools can capture the same spend;
- appstore liquidity exists.

Use these only if the story is:

> Blockless helps teams build many product prototypes faster.

Do not use them for:

> Consumers bought AI gadgets, therefore creators will pay for hardware vibe
> coding.

### 6. Cursor / Lovable / Software Vibe-Coding ARR

Cursor and Lovable are useful because they show an AI-native artifact workflow
can monetize. They are dangerous because they make hardware look more
software-like than it is.

Software AI tools benefit from:

- daily usage frequency;
- immediate visual inspection;
- cheap retries;
- live deployment URLs;
- instant global distribution;
- no inventory;
- low marginal cost for cloning/forking.

Hardware workflows face:

- parts availability;
- wiring;
- voltage/current/pin constraints;
- flash and driver issues;
- physical observation;
- safety/support risk;
- slower project cadence.

So the only transferable claim is:

> AI-native creation workflows can be valuable when the artifact is inspectable
> and the loop is fast.

The non-transferable claim is:

> Blockless can have Cursor/Lovable-like ARR without proving hardware repeat
> frequency and paid conversion.

### 7. STEM / Education Population

Large student and STEM population numbers are especially easy to misuse.

Students are often users, not buyers. Teachers, departments, districts, labs,
maker spaces, or parents are buyers. Their buying criteria are not just "cool
demo." They care about:

- setup time;
- classroom failure rate;
- teacher intervention;
- kit loss/breakage;
- curriculum alignment;
- safety;
- procurement;
- support;
- repeatability across many students.

Education TAM should start with pilots:

- one teacher;
- one class;
- one kit matrix;
- one lab;
- measured completion and support burden.

Not:

> millions of STEM students.

## The Only Honest Bottom-Up Market Model

Before showing ARR outcomes, Blockless needs measured inputs:

| Input | Why it matters |
|---|---|
| Active builders per month | Real reachable usage, not installed base |
| First-project completion rate | Product solves the initial job |
| Second-project rate | Workflow, not toy/demo |
| Third-project rate | Habit or real repeated need |
| Projects per active builder per month | Subscription frequency |
| Rerun rate | Recipe value |
| Fork/edit rate | Appstore/reuse value |
| Paid conversion by unit | Workspace vs kit vs recipe vs school vs vendor |
| ARPU by buyer type | Revenue model shape |
| Kit attach rate | Hardware revenue plausibility |
| Gross margin by kit/module | Whether hardware can be core revenue |
| Support touches per success | Scalability |
| Support cost per board/module expansion | Matrix economics |
| Recipe maintenance cost | Appstore supply cost |
| Churn / repeat interval | ARR realism |

If these are missing, use scenarios as hypotheses, not outcomes.

## ARR Sanity Math

Any $100M ARR story must name its path. Examples:

| Path | What must be true |
|---|---|
| 100K paid workspaces at $83/mo | Very high repeat project frequency and low churn |
| 500K hobby users at $17/mo | Broad consumer adoption and monthly hardware activity |
| 10K schools/labs at $10K/yr | Institutional sales, curriculum/support fit, procurement |
| 2K vendors at $50K/yr | Vendor support-deflection ROI and enterprise sales |
| Hardware/kit revenue path | High attach rate, margin, inventory discipline, support control |

Do not mix these paths casually. Each has a different buyer, sales motion,
support model, and competitor set.

## Claims To Quarantine

| Claim | Why it is unsafe |
|---|---|
| "30B MCUs = TAM" | Shipment volume is not creator workflow demand |
| "60M+ Raspberry Pis = maker buyers" | Cumulative units and industrial deployments are not monthly recipe users |
| "30M+ Arduino users = Blockless users" | Arduino users may stay in Arduino IDE/App Lab/Cloud/Project Hub |
| "Kickstarter hardware proves paid demand" | Crowdfunding proves product preorders, not recurring recipe/workspace use |
| "AI gadget revenue proves Blockless demand" | Finished-product buyers differ from creator-tool users |
| "Cursor/Lovable ARR proves Blockless ARR" | Software usage frequency does not transfer |
| "US STEM enrollment is TAM" | Students are not necessarily buyers; classroom support burden may dominate |
| "50K active creators" | Must be measured or derived from a real acquisition funnel |
| "70% hardware revenue" | Requires attach rate, margin, inventory, and support data |
| "$100M ARR" | Requires bottom-up paid cohorts and churn/repeat assumptions |

## Safer Deck Language

Use:

> We are not using MCU shipments as TAM. The first market is the subset of
> builders who repeatedly create ESP32-class physical prototypes and lose time
> to wiring, packages, flashing, logs, and repair.

Use:

> Large Arduino/Raspberry Pi ecosystems prove physical computing is mainstream.
> They do not prove Blockless demand; they define the baseline and distribution
> pressure we must beat.

Use:

> Our first market model is bottom-up: active builders, projects per builder,
> second-project rate, rerun/fork rate, paid conversion, kit attach, margin,
> support cost, and churn.

Avoid:

> 30B MCUs shipped, so the market is enormous.

Avoid:

> Kickstarter hardware comps prove our ARR path.

Avoid:

> Cursor for hardware means Cursor-like monetization.

## What Would Change This Conclusion

The conclusion changes only with measured behavior:

1. 50-100 users attempt real hardware builds.
2. At least 30-50 finish a first project.
3. A meaningful share starts project two within 7-30 days.
4. Second users rerun recipes without founder help.
5. Some users pay or commit to pay for a specific unit.
6. Support touches per successful build are low enough to scale.
7. Kit attach or workspace conversion is measured, not surveyed in the
   abstract.

Until then, Blockless's market slide should be a wedge and proof plan, not a
TAM theater slide.
