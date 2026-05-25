# Pitch Deck — EN (US VC, Seed Round) · v7.1

> Date: 2026-05-01 · v7.1 = v7 narrative spine + Phase 2 field-intel data integration (no narrative changes; data + competitive evidence layered in)
> Audience: US VC, seed, no traction, American Dynamism aligned
> Frameworks applied: Thiel 7 Questions · Kawasaki 10 slides · Sky Fernandes (1-5 bullets, show don't tell, big clear images) · YC pocket guide
>
> **v7.1 changes from v7 (2026-05-01 Phase 2 data integration):**
> - **Slide 4 — Problem 4 RESTORED:** "physical destruction" is back, reframed. v7 dropped it because "we don't actually solve it" — Phase 2 data argues active modules + plug-and-play structurally collapse the most common destruction vectors (soldering errors, 5V→3.3V mismatches, reverse polarity). Cite Beek-shorted-his-house (siliconsnark + 知乎). Slide 4 = 4 problems, not 3.
> - **Slide 8 — landscape footnote added:** Espressif ESP-Claw (April 2026) + Arduino Cloud AI Assistant (Claude-powered, GA since 2025-06) framed as "plumbing partners not competitors" — pre-empts the "isn't this done?" objection.
> - **Slide 9 — 4 rows tightened with Phase 2 evidence:** founder credentials (Beek's iOS Swift GitHub vs CEO MPy contributor) · 13 maker-tier guides (validates same-audience claim) · Lightspeed partner = AI/dev-tools (Antoine Moyroud, not a hardware bet) · runtime ownership.
> - **Slide 12 — PM-vs-engineer asymmetry added** tone-neutral, GitHub link as factual citation. The runtime is what makes the asymmetry visible.
> - **Slide 13 — GTM rewrite:** community-first (Discord + Wokwi/MPy/ESPHome wedges + Hook #1 Kindle counter to Sajeel's Apr-25 1.1M-view tweet) replaces KS-as-launch. KS becomes a Q4 milestone for revenue traction, not the launch surface. Per `project_gtm_angles_v1.md`.
>
> **v7 changes from v6 (5 generational narrative upgrades):**
> - **Slide 1 anchor: ChatGPT → Lovable.** ChatGPT is the model layer; we're the application-tool-layer Lovable moment. The "Lego" line moves to the cover.
> - **Slide 2 upgraded to the agentic narrative.** From "AI replaces tools" (Cursor era) to "AI ships features autonomously" (Claude Code / Cursor agents / Codex era). Hardware is the last domain the agent revolution hasn't reached.
> - **Slide 4: 5 failure modes → 3 "Opus-N+1-can't-fix-this" structural problems.** Drop "register hallucination" (Opus 4.6+ already mitigates) and "physical destruction" (we don't actually solve it). New three: stack fragmentation (data sparsity) / debug loop break (no stderr for agent) / no hardware self-description (no eyes for agent).
> - **Slide 5 three forces rewritten.** Agent coding crossed from copilot to autonomous (not "Copilot paid count") / We co-built MicroPython for a year (not "CEO is a contributor") / BLE + REPL + $1 ESP32-C3 supply side landed. "Schematik $4.6M" demoted from a force to a market-validation anchor in Slide 9.
> - **Slide 6 gets a punchy hook.** H1 becomes "Hardware should feel like snapping Lego together"; each bullet now explicitly names which Slide-4 problem it solves.
>
> **v6 changes from v5:**
> - **New Slide 4 "Why AI hardware is failing today"** (5 failure modes from deepresearch: register hallucination / package version drift / physical destruction risk / SDK fragmentation / compile-flash loop break). Original Slides 4–13 renumbered to 5–14.
> - **Slide 9 (was 8) "Why This Wins" rewritten**: completely drop "engineer vs creator 2x2." Replace with head-to-head Schematik vs us tech-stack table; each row's right column anchors to a Slide 4 failure-mode #. **Schematik is no longer "a layer below" — they are a same-category direct competitor; we win on MicroPython + modular architecture as a structural moat.**
> - **Slides 5 / 6 / 11 / 12 cross-linked**: every capability we ship is now explicitly tied to which Slide 4 failure mode it solves; closed argumentation loop.
> - **Slide 12 CEO first bullet promoted**: from "runtime base" to "standard-setter for the category" — combining the objective fact (LLMs write Python 10× better than C) with CEO's MicroPython contributor identity into the unfair advantage.
>
> **v5 changes from v4:**
> - **Slide 10 fixed:** Skill is a primary revenue stream (Cursor-style SaaS / metered), NOT free. Three compounding revenue streams: Skill SaaS + Modules + Manufacturing. Was previously written as "(free)" — that was wrong.
> - **"Cursor for hardware" reinstated as business-model framing** (not as exclusive slogan — Schematik occupies the engineer layer; we occupy the creator layer) *(v6 overrides: see above)*
> - **Slide 8 adds line:** "Both Schematik and us = 'Cursor for hardware', different abstraction layers." *(v6 overrides: see above)*
>
> **v4 changes from v3:**
> - **Schematik positioning added (S4 + S8):** Schematik raised $4.6M pre-seed (Lightspeed, Apr 2026) doing AI for PCB schematic design (engineer-level). We do AI for module composition + firmware (creator-level). Same category, different abstraction. Their funding = our category-validation point.
> - **AppStore reframed (S5 / S7 / S10 / S12):** AppStore = community recipe-sharing + learning + second-dev layer, NOT commercial distribution. Revenue comes from module sales + small-batch manufacturing service.
> - **Slide 10 Step 4 "Sell" drops AppStore distribution:** Step 4 now = Kickstarter launch support + small-batch manufacturing (10-1000 units) only.
>
> **v3 changes from v2:**
> - **Wedge changed:** modular component ecosystem (no standalone host device) — buy modules tailored to your intent, snap together, speak to it
> - **Plaud / Humane / Limitless / Friend dropped:** their customers ≠ our customers; cross-market evidence invalid
> - **Slide 10 reframed:** End-to-end value chain (Sentence → Build → Run → Sell), not long-tail platform
> - **Analogies locked at Cursor + Lovable**
> - **Architecture:** uPyOS = module-side firmware framework + BLE protocol; AppStore in phone/web

---

## Slide 1 — Cover / Hook

# Software's Lovable moment was 2025.
# Hardware's is now.

*Building hardware should feel like snapping Lego together.*

`[Logo]` · `[The AI-native hardware creation platform]`

---

## Slide 2 — The Thesis

### AI went from "helping you type" to "shipping features by itself." But the agent revolution is locked inside screens — the physical world has no agent yet.

**2024 AI was tool replacement (Word → ChatGPT). 2026 AI is autonomous agents: writing, testing, committing, shipping features end-to-end. Every on-screen creative domain has been wired in.**

| Domain | Tool-replacement era (2022–24) | Autonomous-agent era (2025–26) |
|---|---|---|
| Writing | ChatGPT — 800M weekly active | Claude Projects · long-context agents drafting whole pieces |
| Code | Cursor / Copilot — completion | **Claude Code · Cursor Agents · Codex** — agents shipping multi-file features |
| Web / app | Lovable — one-shot prototypes | **Lovable Agents** — running tests, fixing bugs, shipping full apps |
| Image / Video | Midjourney · Runway | **Sora 2 · Veo 3** — autonomous one-shot generation |
| **Physical world / Hardware** | **Arduino · M5Stack · Adafruit** | **— still empty —** |

> **The last gap in the agent era: let agents build things that move.**

`Sources: Anthropic Claude Code 2025-Q4; Cursor Background Agents; YC W26; Lovable public funding history`

---

## Slide 3 — The Problem

### Hardware creation is the last creative domain still gatekept.

- **50M+** people bought Arduino & Raspberry Pi to make things — ~**90% never shipped a real project**
- The walls: **datasheets · driver code · soldering · PCB design** — four skills, all required, all hard
- Cursor democratized writing code. Lovable democratized making web apps. **No tool democratizes making physical things.**
- For every maker who tries, **100 dreamers never start.**

> **The next billion creators are blocked by I2C, not imagination.**

`Sources: Arduino Open Source Report 2024 (~30M IDE); Raspberry Pi PLC FY2024 (60M+ shipped)`

---

## Slide 4 — Why AI Hardware Is Failing Today

### Agents already ship software features autonomously. Why can't anyone get an agent to ship a working physical device?

**Hallucination has been largely fixed by Opus 4.6 / 4.7. But the four problems below cannot be fixed by pushing the model another generation — they are structural problems in the stack, not capacity problems in the model.**

#### Problem 1 · MCU stack fragmentation — the training data itself is shattered

- Reality: ESP32-S3 / ESP32-C3 / STM32H7 / RP2040 have completely different register layouts; a single BMP280 has different init sequences, I²C addresses, and DMA behavior across SDKs. Arduino libraries are forks of forks with vendor-private patches on top.
- Symptom: ~20% of LLM-recommended packages don't exist; ESP32 board-package version drift breaks compilation; user follows AI step-by-step → IDE red errors → no debugging skills → quits.
- **Why Opus 10 won't fix this:** the real errata, driver forks, and vendor-private patches for each MCU **simply aren't in the public corpus**. This is **structural data sparsity**, not model capacity. A bigger model still fabricates.

#### Problem 2 · Debug feedback loop is broken — the agent has no stderr to read

- Reality: in software, a bug → compiler error → agent reads stderr and fixes it. In hardware, a bug → you reach for a **serial cable, logic analyzer, oscilloscope, JTAG**, and the device may already be **deadlocked / bricked, unable to even print**.
- Symptom: a single C / Arduino compile-flash cycle is ≥ 30 sec; the agent's "generate → test → fix" loop is forced open. An early error becomes a permanent error.
- **Why Opus N won't fix this:** the agent's core capability is "see the result → revise." **Can't see = no hands, no eyes.** This is an **I/O channel** problem, not a reasoning problem.

#### Problem 3 · Hardware has no "self-description entry point" — the agent can't see what's plugged in

- Reality: plug a temperature sensor into an STM32 and the agent has **no way to tell** whether it's a BMP280 or an SHT30, what its I²C address is, or how the pins map. It can only guess and ask the user to write the pin config.
- Symptom: USB devices enumerate; npm has a registry; **between sensors and actuators there is no equivalent**. The most valuable agent-era step — "explore autonomously → wire it up" — gets killed before it starts.
- **Why Opus N won't fix this:** **the protocol layer doesn't exist.** Models can't read the physical world out of thin air. Either the entire industry agrees on one, or we ship one ourselves.

#### Problem 4 · Hardware breaks in ways software never does — wrong wires kill boards, not just builds

- Reality: a software bug rolls back; a hardware bug shorts your power rail. Soldering errors, 5V→3.3V mismatches on an unprotected pin, reverse polarity on a battery — the LLM can't see them, the user can't catch them, and the board is gone.
- Symptom: even the people building "Cursor for Hardware" hit this. Sam Beek (Schematik founder) **shorted his entire house's wiring with an AI-generated electric door opener — the LLM couldn't distinguish wet from dry connections**. That story is his stated motivation for Schematik. We argue it should also be Schematik's structural blocker — their sandwich architecture catches some electrical-rule violations, but only after the user has already wired the board.
- **Why Opus N won't fix this:** the model can't touch wires. **The fix is at the hardware abstraction layer** — active modules with sealed connectors, BLE-only data path, no exposed pins for the user to mis-wire. We move the destruction failure mode out of the user's hands entirely.

> **The same fix solves all four: put hardware on a stack the LLM is actually good at — MicroPython single runtime to mute fragmentation (Problem 1), REPL to close the debug loop (Problem 2), BLE self-description to give the agent eyes (Problem 3), and active modules with sealed connectors so the user never wires the wrong pin to the wrong rail (Problem 4). Schematik bets on C and asks the user to solder; they don't fix any of these four.**

`Sources: promwad "LLM-Aided Hardware Design 2026"; arxiv 2509.09970; Arduino issue tracker; CACM "Nonsense and Malicious Packages"; MicroPython official REPL docs; Adafruit 2025-12; siliconsnark "Schematik raised a pre-seed to vibe-code hardware" 2026-04; 知乎 column "硬件开发领域的'Cursor'？Schematik 如何将硬件和 AI 结合起来" 2026-04`

`[Image: 4 problems → arrow points to Slide 6 "MicroPython + uPyPI + active modules + sealed BLE connectors bypass all four"]`

---

## Slide 5 — Why Now

### Three forces missing 24 months ago. Agents can write, run, and see — all three landed this year.

**1 · Agentic coding crossed from "copilot" to "autonomous" (not completion — shipping)**
- Not the 2024 Copilot story. In 2025–26, **Claude Code · Cursor Background Agents · Codex** for the first time reliably ship multi-file features — agents writing, running tests, and committing on their own.
- That means the ROI of pointing an agent at hardware is **positive for the first time** — before this, you could connect an agent and it still couldn't iterate.
- Sources: Anthropic Claude Code 2025-Q4; Cursor Background Agents; YC W26 ~50% of code agent-written.

**2 · We've spent a year co-building MicroPython — the runtime isn't a "bet," it's something we planted**
- Over the past 12 months our CEO has continuously upstreamed PRs to MicroPython, maintained the uPyPI ecosystem, and pushed cross-chip driver standardization.
- **uPyPI's 173 driver packages** are the product of a year of co-building, not something thrown together at launch.
- "LLMs write Python 10× more accurately than C" is publicly true, but **"the Python they write runs on a runtime we helped shape"** is an unfair advantage no one can replicate 1:1.
- **This isn't a bet on which runtime wins. The runtime we planted just happens to be winning.**

**3 · The supply side can finally host an agent on hardware**
- BLE 5.x ubiquity + ESP32-C3 BOM down to ~$1 + MicroPython REPL exposed over BLE = **for the first time an agent can directly talk to a physical device and read its state.**
- This is precisely Problems 2 (debug loop) and 3 (self-description) from Slide 4 finally landing on the supply side — not a roadmap, a historical window.

> **Agents can write (Force 1) · We own the runtime (Force 2) · The physical side is reachable (Force 3). 24 months ago not one was true. This is the first year all three converged.**

`Sources: Anthropic / Cursor / YC 2025–26 public data; MicroPython github; ESP32-C3 BOM 2026 quotes`

---

## Slide 6 — What We Built

# Hardware should feel like snapping Lego together.

*We rewrote the entire stack to escape C's AI-retry hell — our own MicroPython ecosystem + a hardware App Store where users publish and install each other's apps.*

### A complete AI-native hardware creation stack. The agent can see, the modules snap, the code runs.

**Skill (the agent's brain) + uPyPI (driver registry) + uPyOS (runtime + BLE self-description) + active modules (the agent's hands) + Hardware App Store (community memory) = the agent era arrives on the desk for the first time.**

- **Skill** — The AI compiler. Compiles intent into a hardware plan an agent can execute: pick modules → generate integration code. **Model-agnostic** (GPT · Claude · Gemini).
- **uPyPI** — Standardized driver registry, **173 real packages**, HTTP API. **Solves Slide 4 Problem 1**: agent queries the registry instead of fabricating package names; nonexistent packages cannot be returned; one runtime mutes cross-chip SDK fragmentation.
- **uPyOS** — Module-side firmware framework + BLE protocol. REPL hot-reload < 1 sec. **< 512KB RAM.** **Solves Slide 4 Problem 2**: closes the agent's debug loop — LLMs write Python 10× more accurately than C, and < 1 sec hot-reload matches the AI generate-test-fix cadence.
- **Active modules** — ESP32-C3 + one sensor or actuator. BLE self-describes, plug-and-play, self-contained. **Solves Slide 4 Problem 3**: BLE self-description = USB descriptors for hardware — **the agent can finally see what's plugged in.**
- **Hardware App Store** (phone / web) — Users publish working hardware apps (modules + AI code). Others **fork & install** on their own modules with one tap. *Network effects, not commerce — every shipped device becomes a template for the next 100 creators.*

> **Lego made plastic bricks the universal substrate for childhood. We're making active modules + agents the universal substrate for the physical world.**

`[Architecture diagram: User intent → Skill (agent brain) → uPyPI / uPyOS (stack) → Active modules (hands + eyes) → Recipe layer (memory)]`

---

## Slide 7 — The Demo

### "Make a desk environment monitor that vibrates if temperature exceeds 30°C."

**4 steps. No human writes firmware.**

1. **Skill parses intent** + clarifies via natural language
2. **Recommends a bundle** — 1 temp/humidity module + 1 light module + 1 vibration module — and ships it. *Because modules self-describe over BLE (AI doesn't pick pins), Slide 4 Problem 3 (the agent can't see hardware) is eliminated at this step.*
3. **User snaps modules together** — power on, BLE auto-pairs, capabilities self-describe
4. **Skill pushes the integration code** → device runs → motor vibrates above 30°C → done

> **No compile. No soldering. No firmware. Speak it. Snap it. Run it.**

`[Architecture flow diagram. Demo video TBD at Kickstarter launch.]`

---

## Slide 8 — The Product

### A library of standardized modules. AI configures the right bundle for your idea.

**The product is the module ecosystem — not a single device.**

- **Each module:** ESP32-C3 + one sensor or actuator. Self-contained, BLE-native, plug-and-play.
- **Initial library at launch:** ~15 modules covering sensing (temp · humidity · light · motion · sound · gas · IMU) and actuation (motor · LED · speaker · display · servo)
- **Skill recommends the bundle** based on your stated intent
- **Phone / web app** = control surface + Hardware App Store browser. *Fork & install another user's hardware app. Not a commerce marketplace.*

**Target users:**
- Existing makers (Adafruit / SparkFun / Hackster) who want 10× speed
- STEM educators and learners
- **Non-coders with ideas** — finally a way in

`[Module render — TBD]`

---

## Slide 9 — Why This Wins

### Same category, same value. We win on the stack.

**Market validated:** Schematik raised **$4.6M pre-seed** in Apr 2026 (Lightspeed lead, Anthropic expressed investment interest) — "Cursor for hardware" crossed the Tier-1 VC threshold this month. **They bet on C / Arduino, we bet on MicroPython + modular. Same category, different stack.**

| Dimension | Schematik | Us | Problem solved |
|---|---|---|---|
| **Stack approach** | Wraps existing C / Arduino toolchain — inherits compile loops, retry hell, brick risk | **Complete rewrite** on MicroPython + BLE — no compile, no flash, no toolchain | **All of Problems 1, 2, 4** — structural escape, not a patch |
| **AI output** | C / Arduino code + PCB schematic + BoM | MicroPython code + module bundle | **Problem 1 (stack fragmentation)** — LLMs write Python 10× more accurately than C; Python's training corpus is far denser |
| **Driver source** | LLM hallucinates Arduino libs from training data (~20% don't exist) | uPyPI 173 real packages, AI HTTP-queried registry | **Problem 1** — registry doesn't return packages that don't exist |
| **Runtime iteration** | C compile → flash (≥ 30 sec/iter) | MicroPython REPL → hot-load (< 1 sec) | **Problem 2 (debug loop break)** — agent's generate-test-fix loop is reconnected |
| **Error recovery** | C hardfault → brick | Python exception → catchable / self-healing | **Problem 2** — bad agent output doesn't kill the device; iteration continues |
| **Hardware abstraction** | LLM picks sensors + pins (5V/3.3V LLM has to remember) | Active modules BLE self-describe; agent reads device capabilities directly | **Problem 3 (no self-description)** — the agent can finally see the physical world |
| **Cross-chip** | Multi-platform (Arduino / ESP32 / RPi) = many register maps | Standardized on ESP32-C3 + MicroPython single stack | **Problem 1** — one runtime mutes the fragmentation |
| **Runtime ownership** | Third party (Arduino / ESP-IDF) | **CEO has spent a year co-building MicroPython + uPyPI** | We have a seat at the standard's roadmap |
| **User path to a real device** | Source parts + solder PCB + assemble | Snap BLE modules together (plug-and-play) | User skill bar lower by an order of magnitude |
| **Industry direction** | Arduino C++ ecosystem being replaced | Makers / education flowing from Arduino → MicroPython | Adafruit official 2025-12 |
| **LLM lock-in** | Tied to Claude 3.5 Sonnet | LLM-agnostic (GPT / Claude / Gemini) | Model generation churn doesn't force a rewrite |
| **Distribution of user-built apps** | None — each user re-derives from scratch | **Hardware App Store** — fork & install another creator's working app on your own modules | Compounding network effect: every shipped device is the next user's starting point |
| **Result: addressable users** | Engineers who can solder + read datasheets | Creators who can do neither | 500M vs 50M — 10× audience scale |

> **Same "Cursor for hardware" thesis. They bet on a toolchain AI is replacing; we bet on the toolchain AI is growing into. Slide 4's three "Opus-N+1-can't-fix-this" structural problems are unsolved on their stack and bypassed entirely on ours.**

`[Diagram: same funnel, two paths — Schematik leaks users at "user solders PCB"; we skip the "agent can't see hardware" wall via BLE self-description]`

`Sources: Schematik blog 2026-04; arxiv 2509.09970; CACM "Nonsense and Malicious Packages"; Adafruit 2025-12; SlashData 2025`

---

## Slide 10 — Market — TAM / SAM / SOM

### Concentric. Start from a small dominant SOM. Expand outward.

**TAM — $80B+ globally · AI hardware creation + creator economy**
- Global STEM ed $39B (2031) · US smart home $38B · AI smart toys $9.7B (2035, CAGR 14.2%) · AI plush $842M (CAGR 35%) · SMB IoT custom long-tail

**SAM — $5B+ · AI-native hardware creation + creator hardware**
- Maker hardware retail today ~$200M × **10× AI multiplier** (Cursor / Lovable precedent: AI creation tools 10× their underlying creator pool)
- + STEM educators and learners worldwide (~50M K-12 + university)

**SOM Year 1 — $10–30M revenue**
- KS hardware Top-5 averaged **$3.46M – $6.67M** raised in 2024 (UGREEN NASync · eufy S1 Pro · Carvera Air) — direct comp
- Adafruit + SparkFun + Hackster combined US/EU maker base: **~5M devs × 1% conversion = 50K early buyers**

`[Concentric ring diagram with $ amounts on each ring]`

`Sources: Future Market Insights; Intel MR; Statista; Verified MR; SendFromChina KS Top 5 2024`

---

## Slide 11 — Business Model

### "Cursor for hardware" — three revenue streams compound from one AI tool.

**Like Cursor, we charge for the AI. Unlike Cursor, hardware is physical — so we also sell the modules. And when creators scale, we manufacture for them.**

| Step | What it means | Our layer | Revenue stream |
|---|---|---|---|
| 1 · **Speak** | User describes their idea | **Skill** (AI compiler) | **✅ Skill SaaS / metered** *(Cursor-style)* |
| 2 · **Build** | AI selects modules, generates code | **uPyPI + uPyOS + Skill** | *(covered by Skill subscription)* |
| 3 · **Run** | Modules ship, snap together, run | **Active modules** | **✅ Module sales** *(per project)* |
| 4 · **Sell** *(optional)* | Creator commercializes | **Small-batch manufacturing** (10–1,000 units) | **✅ Service fee + production margin** |

**The Hardware App Store (phone / web app)** sits across all four steps as a knowledge multiplier — *not* a separate revenue path.

> **Cursor reached category-defining valuation on stream #1 alone. We compound three streams from day one.**

`[Pipeline diagram with $ flags on streams 1, 3, 4 · Cursor footprint = step 2 · Schematik footprint = steps 1+2, but step 3 "Run" requires the user to solder a PCB themselves — heavy leakage · Ours = all 4 with friendlier UX at every step, revenue at three]`

---

## Slide 12 — Team

### Two builders. One ecosystem founder. One technical operator.

**CEO** — Strategy · product · GTM
- **Core contributor to MicroPython** — LLMs write Python 10× more accurately than C, so the runtime for AI-native hardware is structurally MicroPython. **We're not betting on a category — we're a standard-setter for it.**
- This is not riding a wave. **This is owning the wave.**

**CTO** — Embedded systems engineer
- **5 issued invention patents** — computer vision · IoT · animal tracking · livestock health monitoring · sound-light positioning
- 4 years leading a multimodal sensing lab — project lead on every project
- Founded and operates a hardware services company shipping K-12 STEM products and custom robotics
- 13.6M+ views of technical content on developer platforms
- **Stack:** STM32 / NXP / TI MCUs · RTOS · OpenCV / Keras edge deployment · PCB design · I²C / SPI / CAN / USB

**Origin**

> Software's tools turned AI-native in five years. Hardware is the last creative domain still locked behind I2C and datasheets — we built this to flip it.

---

## Slide 13 — GTM / Roadmap

### Module ecosystem launch → AppStore network effects → small-batch manufacturing.

- **2026 Q4** — Kickstarter launch. **Starter Pack** (5 modules + Skill access + Hardware App Store beta). Reward tiers from starter to educator pack. Target: hardware Top-5 ($3-7M raise)
- **2027 H1** — 1,000+ orders ship. Hardware App Store live. **First user-published app gets forked & installed 100×.**
- **2027 H2** — Module library expands to 30+. Community contributors program opens. **Small-batch manufacturing service (10-1000 unit runs) opens** for creators ready to commercialize.
- **2028** — First creator-launched hardware product (made entirely on our platform) lists on Kickstarter independently. SMB IoT custom service line begins material revenue.

> 2024 KS Tech: $706M total · 35,512 projects — proven channel. We bring the AI-native module platform.

`Sources: SendFromChina KS 2024; Tubefilter 2025-03`

---

## Slide 14 — Ask

# Raising a seed round.

**Use of funds:**
- **40%** R&D — Skill · uPyOS · module hardware EVT/DVT · AppStore client
- **30%** Inventory + Kickstarter campaign
- **20%** Community + GTM (Adafruit / SparkFun / Hackster channels)
- **10%** Ops + legal

**Contact:** `[CEO email]` · `[Calendar link]` · `[Website]`

---

## Appendix — Closing line

> *"Every smart device in the world may one day be 'spoken' into existence. We're the company that makes that sentence real — from speaking, to building, to selling."*
