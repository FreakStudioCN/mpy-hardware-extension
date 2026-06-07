# Blockless Seed Deck - EN v14

> Date: 2026-06-06  
> Audience: US seed VC  
> Position: software-first AI embedded prototyping platform  
> Core change from v13: clearer analogy and channel-to-sales path.  
> Status: latest pitch draft; founder review still required.

---

## Slide 1 - Cover

# The AI agent for embedded hardware.

Software teams got Cursor.  
Physical builders still debug pins, drivers, and flashing by hand.

**Blockless turns an idea into running MicroPython on real hardware.**

`[Logo]` | AI-native embedded prototyping platform

---

## Slide 2 - The Analogy

### Cursor did not invent programmers. It monetized an existing workflow.

Cursor won because developers were already inside:

- VS Code
- GitHub
- package managers
- test/deploy loops
- Stack Overflow / docs / examples

Hardware has the same ingredients, but they are not connected:

- Adafruit / SparkFun / Seeed / DFRobot modules
- Arduino / MicroPython / CircuitPython drivers
- Hackster / Tindie / Kickstarter creators
- serial logs, flashing tools, board profiles

> Cursor sits on the software creation graph.  
> Blockless sits on the embedded hardware creation graph.

---

## Slide 3 - Thesis

### AI agents changed software. Hardware is next, but the stack is wrong.

- AI coding agents work because software has fast loops and rich package context.
- Embedded hardware has slow loops, fragmented drivers, and blind physical state.
- The first winning AI hardware platform will not start with PCB layout.
- It will start with the fastest path from intent to a working prototype.

> The wedge is not "AI for Altium."  
> The wedge is **AI for getting hardware running**.

---

## Slide 4 - Problem

### Embedded prototyping breaks where AI is weakest.

A simple project still requires:

- choosing the right board and module
- finding a real driver package
- wiring legal pins
- generating firmware against the real API
- flashing, reading serial output, and fixing failures

LLMs can write plausible code.  
They cannot reliably know which driver exists, which constructor is valid, or which pin works.

> The bottleneck is not imagination. It is package and device truth.

---

## Slide 5 - Why Now

### Four forces landed at once.

1. **AI coding agents are now normal.** The market understands "Cursor for X."
2. **Microcontrollers are moving toward Python.** Arduino now markets Python, Linux, RTOS, and AI workflows.
3. **Modular electronics are mainstream.** Qwiic, STEMMA, Grove, Gravity, and Modulino proved the physical pattern.
4. **AI hardware design is fundable.** Schematik raised $4.6M; Flux raised $37M.

The opportunity is not to invent modular hardware.  
It is to make modular hardware legible to an agent.

Sources: Qualcomm/Arduino 2025; SparkFun Qwiic; Adafruit STEMMA; Seeed Grove; DFRobot Gravity; Schematik 2026; Flux 2026.

---

## Slide 6 - What We Built

### An agent loop grounded in real packages, boards, and modules.

**Blockless MVP**

- VS Code extension agent
- backend package intelligence
- board profiles and import audit
- driver contexts extracted from package evidence
- local deploy path through MicroPython tooling
- real demo path: intent -> package resolution -> code -> hardware run

**Local asset evidence**

- 209 package-index records
- 166 GraftSense-sourced records
- 157 `generatable` package records
- 167 GraftSense driver `package.json` descriptors
- tests resolving temperature intent to `aht20_driver`

> We do not ask the model to guess driver APIs.  
> We give it a machine-readable contract.

Sources: local repo package index and tests, 2026-06-05.

---

## Slide 7 - Demo

### "Turn on an LED when temperature is over 30 C."

1. User describes the hardware intent.
2. Agent maps intent to required capabilities.
3. Package intelligence resolves a temperature driver.
4. Driver context gives import names, constructors, read properties, and pin roles.
5. Agent generates audited MicroPython.
6. User approves deploy; code runs on a real board.

Example resolved package: `aht20_driver`.

> Speak. Resolve. Audit. Run.

---

## Slide 8 - Product

### Software-first, hardware-aware.

**Core paid product**

- AI embedded agent for firmware generation and debugging
- package intelligence and driver-context retrieval
- board/module manifest generation
- code audit before deploy
- metered LLM usage and team workflows

**Hardware role**

- starter kits and active modules for onboarding
- controlled demo surface for reliability
- future self-describing module graph

Hardware helps the agent trust the physical world.  
Software is the primary business model.

---

## Slide 9 - Beachhead Users

### Start where time-to-working-prototype has economic value.

Ranked first users:

1. **Hardware startups and product studios** building connected-device demos.
2. **Embedded/IoT consultants** who monetize saved engineering hours.
3. **Maker-pros** selling through Tindie, Crowd Supply, or Kickstarter.
4. **University labs and capstone teams** with repeated project cycles.
5. **CTE/STEM educators** after the product becomes curriculum-stable.

Not the initial wedge: general hobbyists and broad K-12 procurement.

> Early adopters are people whose prototype delay already has a cost.

---

## Slide 10 - Channel Evidence

### The US has visible hardware-creator channels.

- Hackster: 2.5M+ members, 44K+ open-source projects.
- Adafruit: 3M+ monthly uniques, 8M+ pageviews/month, 16.2K orders/month.
- Tindie: 489K+ orders shipped, 19.9K+ products.
- Crowd Supply: curated hardware launch platform; claims 90%+ launched-project funding success.
- Kickstarter Technology: $1.95B pledged, 59K+ launched projects.
- US CTE: 11.2M students; Perkins V investment around $1.3B.

These are not sales forecasts.  
They prove there are reachable buyers, projects, and distribution surfaces.

Sources: Hackster; Adafruit media kit; Tindie; Crowd Supply; Kickstarter stats; Advance CTE; US Department of Education.

---

## Slide 11 - Sales Path

### Channel data only matters if it becomes a repeatable funnel.

**Stage 1 - Proof users**

- recruit 20 design partners
- run their real prototypes through Blockless
- measure time saved and failure modes
- convert 5 into paid pilots

**Stage 2 - Public recipes**

- publish 10 working recipes with BOM, code, video, and package evidence
- each recipe has two calls to action: try the agent, buy the starter kit
- target: qualified signups, hardware runs, paid pilots, kit preorders

**Stage 3 - Channel sales**

- place starter kits and tutorials in maker channels
- sell software to repeat creators, consultants, and labs
- use hardware sales to create more package and module truth

> Adafruit's 16.2K orders/month does not become our revenue automatically.  
> It tells us where to test whether hardware buyers convert into agent users.

---

## Slide 12 - Bottom-Up First-Year Test

### A seed-stage plan should be a falsifiable sales experiment.

| Milestone | What It Proves |
|---|---|
| 20 design partners | there is real repeated pain |
| 10 verified recipes | the agent can reproduce useful builds |
| 5 paid pilots | teams will pay for prototype velocity |
| 100 kit preorders | hardware can onboard users |
| 500 qualified signups | public channels can create demand |
| 50 active hardware runs | users move beyond demo interest |

If these fail, the company should not hide behind TAM.

---

## Slide 13 - Competition

### The market is validated, but the winning layer is unsettled.

| Category | Examples | What they solve | Our wedge |
|---|---|---|---|
| AI PCB / EDA | Flux, Celus, CircuitMind, JITX | schematic, BOM, layout | after a prototype path exists |
| Prompt-to-hardware | Schematik | code, parts, wiring, instructions | constrained package + runtime truth |
| Simulation / education | Wokwi, Tinkercad, MakeCode | learning and virtual circuits | real deploy and package intelligence |
| Modular ecosystems | Seeed, DFRobot, M5Stack, Adafruit, SparkFun | physical modules | agent-readable module/package layer |

> We are not replacing Altium.  
> We are building the AI creation layer for embedded prototypes.

---

## Slide 14 - Why We Win

### The stack gives the agent a closed loop.

| Failure mode | Generic LLM hardware tool | Blockless |
|---|---|---|
| nonexistent libraries | guesses package names | resolves indexed packages |
| wrong APIs | hallucinates constructors | uses driver contexts |
| invalid imports | discovers after deploy | audits against board profile |
| slow iteration | compile/flash loop | MicroPython run loop |
| blind hardware | assumes pins/modules | manifest + future self-description |
| fragmented examples | web search | curated package intelligence |

The moat is not BLE alone.  
The moat is accumulated package, board, module, and working-project truth.

---

## Slide 15 - Business Model

### Cursor-style software revenue, hardware as the trust surface.

**Primary revenue**

- individual and team subscriptions
- metered agent runs / package intelligence calls
- paid professional workflows for consultants and startups

**Secondary revenue**

- starter kits and active modules
- education/lab bundles
- small-batch manufacturing support when creators graduate

**Free/community layer**

- public recipes and project forks
- examples that improve package intelligence and distribution

> Hardware makes the workflow real. Software captures the margin.

---

## Slide 16 - GTM

### Design partners first. Community channels second. Education later.

**Next 90 days**

- recruit 20 design partners across startups, consultants, maker-pro sellers, and university labs
- measure time from idea to running hardware
- ship 10 repeatable recipes with real packages and hardware evidence
- publish technical demos through Hackster / GitHub / Adafruit-style tutorials

**2027**

- paid beta for teams and consultants
- starter kit for reliable onboarding
- channel pilots with maker retailers and university labs

**Later**

- CTE/STEM curriculum packages
- China/Shenzhen supply-chain partnerships
- module ecosystem expansion

---

## Slide 17 - China Strategy

### China is a supply-chain and ecosystem edge, not the US deck's first revenue proof.

China brings:

- Shenzhen rapid prototyping and small-batch manufacturing
- Seeed / DFRobot / M5Stack / Yahboom-style modular ecosystems
- large education and robotics tailwinds
- fast module iteration and BOM pressure

But China education procurement is slow, local, and policy-sensitive.

For a US seed deck, China should support:

- lower hardware iteration cost
- module sourcing
- future international expansion

Not the core first-market claim.

---

## Slide 18 - Risks We Will Not Hide

### The story is promising, not yet proven.

- No early users yet.
- Willingness to pay for hardware-agent software is untested.
- Arduino, Seeed, M5Stack, or Flux could add adjacent AI features.
- Modular hardware alone is not defensible.
- Education is attractive but slow.
- Production-grade embedded systems need safety, compliance, and human review.

The fundable claim is narrower:

> We can become the default AI workflow for embedded prototyping before incumbents make their ecosystems agent-native.

---

## Slide 19 - Closing

# Hardware creation needs its own agent-native stack.

The physical world will not be built by generic code completion.

It needs:

- real package truth
- board and module context
- safe deploy loops
- working-project memory

**Blockless is building that stack.**

---

## Source Notes

- Schematik: https://www.schematik.io/blog/schematik-raises-4-6m-pre-seed
- Flux: https://www.flux.ai/p/blog/we-raised-37m-to-take-the-hard-out-of-hardware
- Hackster: https://www.hackster.io/about
- Adafruit media kit: https://cdn-shop.adafruit.com/files/media.pdf
- Tindie: https://www.tindie.com/about/
- Crowd Supply: https://www.crowdsupply.com/apply
- Kickstarter stats: https://www.kickstarter.com/help/stats
- Advance CTE: https://careertech.org/our-vision/cte-in-your-state/
- US Department of Education FY2024 AFR: https://www.ed.gov/media/document/fy24-afr-108470.pdf
- Arduino / Qualcomm: https://www.qualcomm.com/news/releases/2025/10/qualcomm-to-acquire-arduino-accelerating-developers--access-to-i
- SparkFun Qwiic: https://www.sparkfun.com/qwiic
- Adafruit STEMMA: https://www.adafruit.com/stemma
- Seeed Grove: https://wiki.seeedstudio.com/Grove_System/
- DFRobot Gravity: https://www.dfrobot.com/gravity
