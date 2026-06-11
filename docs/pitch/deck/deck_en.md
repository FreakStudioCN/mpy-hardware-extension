# Pitch Deck — EN (US VC seed, Uber-style compression + US-market logic) · v12

> Date: 2026-05-26 · v12
> Audience: US VC, seed, no traction, American Dynamism aligned
> Framework: Uber 2008 seed deck inspired — sparse bullets, bottoms-up comps, mechanism-heavy. Total body word count ~900 (vs v7.1 ~2500).
>
> **v12 cumulative changes from v7.1:**
> - **v8/v9** aligned with `docs/specs/` v0.2 (VS Code MVP + client-side ReAct agent + mpyhw-api proxy); Slide 4 rewritten to Schematik $4.6M as falsification case; Slide 14 dropped ASK (no longer a fundraising-specific deck)
> - **v10** Major fact correction on CEO/CTO bios: CEO = USC + former Moorcubes CTO + Qiji Trampoline S26 + Future Stars; CTO = creator of uPyPI, a MicroPython package manager. Removed all "CEO is MicroPython core contributor" framing from v7 and earlier. CTO bio drops the long technology-stack list.
> - **v11** Uber-style compression: every slide ≤ 6 bullets · each bullet ≤ 15 words; dropped unauditable claims (`50M+ people bought` · `~90% never shipped` · `100 dreamers` · speculative TAMs); later Phase 3 diligence downgraded large market anchors to background context.
> - **v12** US-market logic thread now explicit through S3 / S5 / S10 / S13 (was missing in v11 — global stats with no US bridge for a US-VC audience). Adafruit / SparkFun / Hackster framed as US Year-1 channels; Conrad (EU) / Switch Science (JP) moved to 2028 international expansion.

---

## Slide 1 — Cover

# Software has AI-native creation loops.
# Hardware needs verified ones.

*Building hardware should feel like snapping Lego together.*

`[Logo]` · `Verified hardware recipe workflow`

---

## Slide 2 — The Thesis

### AI agents already ship software. Hardware lacks a dominant verified loop.

| Domain | Autonomous-agent era (2025–26) |
|---|---|
| Code | Claude Code · Cursor Agents · Codex — multi-file features |
| Web apps | Lovable Agents — tests, bugfixes, full app shipping |
| Image / Video | AI media tools — prompt-to-media generation |
| **Physical / Hardware** | **Fragmented across docs, wiring, flashing, logs, and repair** |

> **The gap: verified recipes that make physical builds rerunnable.**

---

## Slide 3 — The Problem

### Hardware creation still breaks across too many handoffs.

**The US has deep maker channels, but scale numbers are not demand proof.**

- **Adafruit · SparkFun · Hackster · Hackaday** — all US companies anchoring the global maker base
- Arduino and Raspberry Pi show physical computing is mainstream, not Blockless conversion
- Schools and maker spaces are buyer tests, not TAM shortcuts
- Four walls: datasheets · driver code · soldering · PCB
- Existing tools help users start; verified build/run/repair/reuse is still fragmented

> The next US-led creator wave is blocked by I2C, not imagination.

`Sources: Adafruit; SparkFun; Hackster; Blockless Phase 3 diligence`

---

## Slide 4 — Why AI Hardware Is Still Contested

### The category exists. The verified rerun loop is still unproven.

**Closest public pressure: PleaseDontCode · Embedr · Cirkit · Schematik**

- PleaseDontCode claims wiring, firmware, compile/fix, browser flash, dashboards, remote logs.
- Embedr claims firmware, board bring-up, KiCad, build/flash/monitor, serial, Git.
- Cirkit claims AI wiring/code, browser simulation, sharing, and hardware upload.

### The benchmark question

1. **Generation** — did it choose compatible board, module, pins, driver, package?
2. **Execution** — did it flash, run, log, and repair on real hardware?
3. **Rerun** — can a second user reproduce without hidden founder context?

> Closed loop is contested. Verified rerun is the stricter bet.

`Sources: PleaseDontCode; Embedr; Cirkit Designer; Schematik; Blockless Phase 3 diligence`

---

## Slide 5 — Why Now

### Three forces are converging now.

**1 · AI software tools went from copilot to more autonomous**
- Anthropic · OpenAI · Cursor · Lovable show stronger agentic software loops.
- The capability now exists. Question is which hardware workflow can verify outcomes.

**2 · We control a narrow MicroPython package wedge**
- CTO created **uPyPI, a MicroPython package manager**
- **200+ packages/drivers across uPyPI, GraftSense, and curated recipes**
- Python gives the agent a smaller, faster loop to test against Arduino/C baselines.
- The claim becomes real only if benchmark runs show fewer failures.

**3 · Hardware can expose more state to the agent**
- BLE 5.x + ESP32-C3 + MicroPython REPL over BLE = agent can inspect device state.

**Validation:** PleaseDontCode, Embedr, Cirkit, and Schematik confirm category pressure. We test a narrower stack.

> AI capability + hardware fragmentation + category pressure converged.

`Sources: Anthropic / OpenAI / Cursor public; PleaseDontCode; Embedr; Cirkit Designer; Schematik; Blockless Phase 3 diligence`

---

## Slide 6 — What We Built

# Benchmark target: verified recipe rerun.

### Three phases: MVP (VS Code extension) → Standalone IDE → Hardware shipments

- **Skill** — AI compiler · intent → module bundle + code
- **Package Intelligence** — uPyPI/GraftSense/curated packages · 200+ packages/drivers · driver context · *fixes #1*
- **uPyOS** — module firmware + BLE · fast REPL iteration after setup · *tests #2*
- **Active modules** — ESP32-C3 + sensor/actuator · BLE self-describes · *fixes #3*
- **Verified recipe registry** — fork and rerun a working build after proof

> Lego is the aspiration, not the evidence.
> **Active modules + verified recipes are the mechanism we will test.**

`[Architecture diagram: User intent → Skill → Package Intelligence/uPyOS → Active modules → Recipe registry]`

---

## Slide 7 — Demo Target

### "Desk thermometer. Vibrate if temperature > 30°C."

1. **Skill parses intent** · clarifies in plain English
2. **Recommends a bundle** — temp/humidity + vibration
3. **User connects modules** — capabilities and constraints are recorded
4. **Skill pushes code** → behavior, logs, and recipe are captured

> **Speak. Connect. Run. Rerun.**

Inside VS Code (MVP). Standalone IDE remains roadmap.

![Real hardware: piranha-LED light module (sample of a module we can ship)](dist/assets/piranha-led-module.gif)

`[Architecture flow diagram. Full-flow demo video TBD after benchmark run.]`

---

## Slide 8 — The Product

### Module library + AI-native IDE. Hardware attach is a hypothesis.

- **Hardware:** ESP32-C3 + sensor/actuator · BOM/retail targets still to validate
- **Launch library:** ~15 modules — sensing + actuation
- **Software:** MVP = VS Code extension · 2027 = standalone IDE
- **Recipe registry:** phone / web — fork working builds after rerun proof

**Initial user test:** ESP32 makers and module vendors; education is a later gate.

`[Module render — TBD]`

---

## Slide 9 — What We Must Prove

### Same category. Different artifact to benchmark.

Direct substitutes already claim pieces of the loop. We test whether Blockless produces a stronger rerunnable artifact.

| | Direct substitutes | Blockless test |
|---|---|---|
| Artifact | Code, schematic, project, dashboard, or guide | Verified recipe with run logs and repair history |
| Board/pin truth | Claimed hardware-aware support | Controlled ESP32 module matrix |
| Execution | Claimed build/flash/monitor flows | Same-task real-device benchmark |
| Repair | Claimed compile/debug help | Failure labels from logs and reruns |
| Reuse | Public projects or share links | Second-user rerun record |
| Iteration | Arduino/IDE/simulation/browser loops | MicroPython/BLE iteration after setup |
| Market proof | Pricing surfaces exist | Paid/repeat behavior still unproven |

> We do not claim victory yet. The benchmark must show fewer failures, faster repair, and better reruns.

`Sources: PleaseDontCode; Embedr; Cirkit Designer; Aily Blockly; Schematik; Blockless benchmark scaffold`

---

## Slide 10 — Market

### Bottoms-up. US-first. No TAM theater.

**Direct US comparables (auditable):**
- Arduino, Raspberry Pi, and Kickstarter indicate broad physical-computing activity.
- They do **not** prove Blockless repeat use, recipe reruns, or ARR.
- Our first market is measured from active builders, not shipped MCUs.

**First proof wedge:**
- US makers, educators, maker spaces, and module vendors.
- One ESP32-class matrix, one kit path, one verified recipe format.
- Measure first build, second build, rerun, fork, kit attach, and paid intent.

**Market model comes after behavior:**
- Active builders per month.
- Projects per builder.
- Paid workspace, kit, recipe, vendor, or school conversion.
- Gross margin, support cost, churn, and recipe maintenance.

> We do not claim TAM yet. We are testing the paid wedge.

---

## Slide 11 — Business Model

### Business model is a test, not a revenue mix.

| Step | Layer | Revenue | Share |
|---|---|---|---|
| **Create** | Workspace | Subscription or metered usage | Unproven |
| **Rerun** | Verified recipe | Paid recipe/package or free registry | Unproven |
| **Build** | Compatible kit/modules | Hardware attach + margin | Unproven |
| **Support** | Vendor/school/prototyping | Support deflection or service | Unproven |

> First paid behavior decides the model: workspace, kit, recipe, vendor, school, or service.

---

## Slide 12 — Team

### Two builders.

**CEO**
- USC
- Former CTO · Moorcubes
- Qiji Trampoline S26 — "Future Stars" track (Lu Qi's startup program)

**CTO**
- **Creator of uPyPI, a MicroPython package manager**
- 5 issued invention patents
- 4 years lab project lead
- Operates a hardware services company (K-12 STEM + custom robotics)
- 13.6M+ developer-platform views

> Software went AI-native in 5 years. Hardware creation is still too often locked behind I2C.

---

## Slide 13 — GTM / Roadmap

### Milestone-gated: benchmark → beta → reruns → paid behavior.

- **2026 Q4** — VS Code extension v0.2 · ESP32-S3 demo · closed beta
- **2027 H1** — Same-task benchmarks · first verified recipe reruns · channel interviews
- **2027 H2** — Kit/channel launch only if rerun and support metrics pass
- **2028** — Expand modules, education, or international only if pilots pass gates
- **2029+** — Expand only if pilots prove completion, support cost, and repeat use

> Kickstarter remains a possible launch channel, not proof of recurring demand.

`Sources: Blockless benchmark scaffold; Phase 3 diligence`

---

## Slide 14 — Closing

# "Every smart device may one day be 'spoken' into existence."

We built this to make that real.

> Not just an AI tool. Not just a hardware company.
> **A verified recipe workflow for physical creation.**

`[Contact · website · email]`
