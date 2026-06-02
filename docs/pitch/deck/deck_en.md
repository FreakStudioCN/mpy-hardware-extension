# Pitch Deck — EN (US VC seed, Uber-style compression + US-market logic) · v12

> Date: 2026-05-26 · v12
> Audience: US VC, seed, no traction, American Dynamism aligned
> Framework: Uber 2008 seed deck inspired — sparse bullets, bottoms-up comps, mechanism-heavy. Total body word count ~900 (vs v7.1 ~2500).
>
> **v12 cumulative changes from v7.1:**
> - **v8/v9** aligned with `docs/specs/` v0.2 (VS Code MVP + client-side ReAct agent + mpyhw-api proxy); Slide 4 rewritten to Schematik $4.6M as falsification case; Slide 14 dropped ASK (no longer a fundraising-specific deck)
> - **v10** Major fact correction on CEO/CTO bios: CEO = USC + former Moorcubes CTO + Qiji Trampoline S26 + Future Stars; CTO = creator of MicroPython's only package management tool (uPyPI). Removed all "CEO is MicroPython core contributor" framing from v7 and earlier. CTO bio drops the long technology-stack list.
> - **v11** Uber-style compression: every slide ≤ 6 bullets · each bullet ≤ 15 words; dropped unauditable claims (`50M+ people bought` · `~90% never shipped` · `100 dreamers` · speculative TAMs); kept only auditable single anchors (60M RPi shipped · 30M Arduino IDE · KS Hardware Top 5 $3.46–6.67M · KS Tech $706M / 35,512 projects).
> - **v12** US-market logic thread now explicit through S3 / S5 / S10 / S13 (was missing in v11 — global stats with no US bridge for a US-VC audience). Adafruit / SparkFun / Hackster framed as US Year-1 channels; Conrad (EU) / Switch Science (JP) moved to 2028 international expansion.

---

## Slide 1 — Cover

# Software's Lovable moment was 2025.
# Hardware's is now.

*Building hardware should feel like snapping Lego together.*

`[Logo]` · `The AI-native hardware creation platform`

---

## Slide 2 — The Thesis

### AI agents already ship software. The physical world has no agent.

| Domain | Autonomous-agent era (2025–26) |
|---|---|
| Code | Claude Code · Cursor Agents · Codex — multi-file features |
| Web apps | Lovable Agents — tests, bugfixes, full app shipping |
| Image / Video | Sora 2 · Veo 3 — one-shot autonomous |
| **Physical / Hardware** | **— still empty —** |

> **The last gap: agents that build things that move.**

---

## Slide 3 — The Problem

### Hardware is the last creative domain still gatekept.

**The US has the strongest maker community in the world — and the deepest STEM education gap.**

- **Adafruit · SparkFun · Hackster · Hackaday** — all US companies anchoring the global maker base
- **30M Arduino IDE downloads** + **60M Raspberry Pi units shipped** *(Arduino 2024 · RPi PLC FY24)* — US is the single largest market
- **US K-12 + post-secondary STEM enrollment: ~50M students** *(NCES 2023)* — AI is rewriting every creative tool except the one they need
- Four walls: datasheets · driver code · soldering · PCB
- Cursor democratized code. Lovable democratized web apps. **Nothing democratizes physical things — yet.**

> The next US-led creator wave is blocked by I2C, not imagination.

`Sources: Arduino Open Source Report 2024; RPi PLC FY24; NCES Digest 2023`

---

## Slide 4 — Why AI Hardware Is Failing Today

### Someone already tried "Cursor for hardware." It didn't work.

**Schematik · Lightspeed lead · $4.6M pre-seed · April 2026**

- AI-generated Arduino code: ~20% of packages don't exist → users quit
- Founder Sam Beek **shorted his house's wiring** in his own public demo
- **$4.6M and a year. Even the founder can't run it.**

### Three structural problems in the C / Arduino stack

1. **Data sparsity** — embedded-C corpus thin · model fabricates
2. **Loop break** — compile-flash ≥30 sec · agent's iterate loop dies
3. **Hardware blindness** — no self-description protocol · agent guesses pins

> Not a model problem. A stack problem.

`Sources: Schematik blog 2026-04; siliconsnark 2026-04; arxiv 2509.09970`

---

## Slide 5 — Why Now

### Three forces missing 24 months ago. All landed this year — and all started in the US.

**1 · US AI labs went from copilot to autonomous**
- Anthropic · OpenAI · Cursor · Lovable — all US — ship multi-file features unattended (2025–26)
- The capability now exists. Question is which domain absorbs it next. **Hardware is the only one still empty.**

**2 · We own the package layer of MicroPython**
- CTO is **the creator of MicroPython's only package manager (uPyPI)**
- **200+ packages/drivers across uPyPI, GraftSense, and curated recipes**
- LLMs write Python **10× more accurately than C** *(arxiv 2509.09970)*
- The Python the agent writes runs on the registry we built. **Not replicable 1:1.**

**3 · Hardware can finally host an agent**
- BLE 5.x + ESP32-C3 (~$1 BOM) + MicroPython REPL over BLE = agent reads device state directly. **First time possible.**

**Validation:** Schematik (Lightspeed · $4.6M · Apr 2026) confirms US VC appetite. They bet wrong (Slide 4). **We bet on the stack AI is growing into.**

> US capability + US creator demand + US VC validation. All three converged this year.

`Sources: Anthropic / OpenAI / Cursor public; arxiv 2509.09970; Schematik blog 2026-04`

---

## Slide 6 — What We Built

# Hardware should feel like snapping Lego together.

### Three phases: MVP (VS Code extension) → Standalone IDE → Hardware shipments

- **Skill** — AI compiler · intent → module bundle + code
- **Package Intelligence** — uPyPI/GraftSense/curated packages · 200+ packages/drivers · driver context · *fixes #1*
- **uPyOS** — module firmware + BLE · REPL hot-reload <1s · *fixes #2*
- **Active modules** — ESP32-C3 + sensor/actuator · BLE self-describes · *fixes #3*
- **Hardware App Store** — fork & install someone else's working build

> Lego made plastic bricks the universal substrate for childhood.
> **Active modules + agents = the substrate for the physical world.**

`[Architecture diagram: User intent → Skill → Package Intelligence/uPyOS → Active modules → App Store]`

---

## Slide 7 — The Demo

### "Desk thermometer. Vibrate if temperature > 30°C."

1. **Skill parses intent** · clarifies in plain English
2. **Recommends a bundle** — temp/humidity + light + vibration · ships
3. **User snaps modules** — BLE auto-pairs · capabilities self-describe
4. **Skill pushes code** → motor vibrates above 30°C

> **Speak. Snap. Run.**

Inside VS Code (MVP). Standalone IDE — H1 2027.

![Real hardware: piranha-LED light module (sample of a module we can ship)](dist/assets/piranha-led-module.gif)

`[Architecture flow diagram. Full-flow demo video TBD at Kickstarter launch.]`

---

## Slide 8 — The Product

### Module library + AI-native IDE. **Hardware is the commercial core.**

- **Hardware:** ESP32-C3 + sensor/actuator · BOM ~$1 · retail $15–$25
- **Launch library:** ~15 modules — sensing + actuation
- **Software:** MVP = VS Code extension · 2027 = standalone IDE
- **App Store:** phone / web — fork working builds with one tap

**Target users:** Adafruit/SparkFun makers · STEM educators · non-coders with ideas

`[Module render — TBD]`

---

## Slide 9 — Why This Wins

### Same category. We win on the stack.

Schematik (Lightspeed · $4.6M · Apr 2026) bets on C / Arduino. We bet on MicroPython + modular.

| | Schematik | Us |
|---|---|---|
| Stack | C / Arduino — compile, retry, brick | **MicroPython + BLE** — no compile, no flash |
| Drivers | LLM hallucinates libs (~20% don't exist) | Package Intelligence over 200+ real packages/drivers |
| Iteration | ≥30 sec/cycle | **<1 sec hot-reload** |
| Error recovery | C hardfault → brick | Python exception → catchable |
| Hardware abstraction | LLM guesses pins | BLE self-describe |
| **Package ecosystem** | Third-party (Arduino / ESP-IDF) | **uPyPI foundation + Package Intelligence layer** |
| User path | Source + solder PCB | Snap modules |
| LLM / IDE lock | Tied to Claude 3.5 | LLM- and IDE-agnostic |
| Supply | Distributed (high BOM) | Vertically integrated (low BOM) |

> They bet on the toolchain AI is replacing. **We bet on the one AI is growing into.**

`Sources: Schematik blog 2026-04; arxiv 2509.09970; CACM "Nonsense and Malicious Packages"`

---

## Slide 10 — Market

### Bottoms-up. US-first. No TAM theater.

**Direct US comparables (auditable):**
- **2024 Kickstarter Hardware Top 5 raised $3.46M–$6.67M** *(SendFromChina KS 2024 — UGREEN NASync · eufy S1 Pro · Carvera Air)* — KS is a US platform, US backers dominate
- **2024 Kickstarter Tech category: $706M total · 35,512 projects** *(Tubefilter 2025-03)*
- **Adafruit + SparkFun + Hackster** = primary US maker retail channels we plan to enter (all US-founded, US-HQ)

**Year 1 SOM (US-focused):** $5–15M revenue from US KS launch + early US B2B (educators · makerspaces · STEM programs)

**Three-year scenarios:**
- **Best** — US-led category default · $100M+ ARR · international channels follow
- **Realistic** — profitable US hardware company · 50K active creators · $10–30M ARR
- **Floor** — US dev-kit business · breakeven on 5K kits sold

> We don't claim a TAM. We claim a US comp.

---

## Slide 11 — Business Model

### "Cursor for hardware" — but **hardware is the commercial core**.

| Step | Layer | Revenue | Share |
|---|---|---|---|
| **Speak** | Skill | SaaS / metered | ~15% |
| **Build** | uPyPI + uPyOS + IDE | (in SaaS) | — |
| **Run** | **Active modules + IDE bundle** | **Hardware sales** | **~70%** |
| **Sell** | Small-batch manufacturing | Service + margin | ~15% |

> Moat = three-layer coupling (hardware + software + AI) + integrated supply.

---

## Slide 12 — Team

### Two builders.

**CEO**
- USC
- Former CTO · Moorcubes
- Qiji Trampoline S26 — "Future Stars" track (Lu Qi's startup program)

**CTO**
- **Creator of MicroPython's only package manager — uPyPI**
- 5 issued invention patents
- 4 years lab project lead
- Operates a hardware services company (K-12 STEM + custom robotics)
- 13.6M+ developer-platform views

> Software went AI-native in 5 years. Hardware is the last domain still locked behind I2C.

---

## Slide 13 — GTM / Roadmap

### MVP → IDE → US-first hardware launch → International.

- **2026 Q4** — VS Code extension v0.2 · ESP32-S3 demo · US closed beta (Adafruit/SparkFun-tier maker advisors)
- **2027 H1** — Standalone IDE α · **Kickstarter US launch** (target Hardware Top-5: $3–7M) · Adafruit/SparkFun/Hackster channel partnerships
- **2027 H2** — 1,000+ orders shipped (US-majority) · library to 30+ modules
- **2028** — International expansion: Conrad (EU) · Switch Science (JP) · manufacturing service opens for US creators ready to scale
- **2029+** — Package Intelligence + uPyOS adopted as default stack in US K-12 and university STEM curricula

> KS Tech 2024: $706M · 35,512 projects · US-platform-dominant backer base. **Proven US channel.**

`Sources: SendFromChina KS 2024; Tubefilter 2025-03`

---

## Slide 14 — Closing

# "Every smart device may one day be 'spoken' into existence."

We built this to make that real.

> Not just an AI tool. Not just a hardware company.
> **A complete stack for the agent era of physical creation.**

`[Contact · website · email]`
