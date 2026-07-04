# Ravn (getravn.xyz) — Competitor Teardown & Strategic Collision Map

Date: 2026-06-22
Author: live research pass (web-access skill, primary source = getravn.xyz)
Status: **first capture — Ravn is NOT yet in `blockless_competitor_exhaustion_map.md`.** This doc proposes where it slots and how the existing deck redlines answer it.

Confidence convention (matches `blockless_source_ledger.md` discipline):
**[V]** verified from primary source (getravn.xyz) · **[I]** inferred / secondary · **[U]** unknown, gap to fill.

---

## 0. Disambiguation (read first — there are 4 "Ravn"s)

The product the discussion is about is **getravn.xyz** — "Full-stack hardware development agent." Do **not** confuse with:

| Name | What it is | Relevance |
|---|---|---|
| **getravn.xyz** | AI agent swarm: idea → schematic → PCB → firmware → fab files | **THIS doc** |
| ravn.co | A software-services / agency company (Agentic Software Dev, Experience Design, Applied AI, QA) | Wrong company — ignore |
| useravn.com | "Giving AI agents physical bodies" — robotics/embodiment | Different |
| ravnrobotics.com | "Embodied AI Software" robotics | Different |

The user originally said "ravn.co"; the real target is getravn.xyz.

---

## 1. TL;DR (one paragraph)

Ravn automates the **component-level EDA chain** Blockless deliberately skips: from a plain-English description it runs a swarm of specialist agents that select **individual ICs** (not modules), draw a **schematic**, **route a custom PCB**, write firmware, build a component-level BOM, run **DFM against a real fab's rules**, and export **Gerbers + assembly files** straight to JLCPCB/PCBWay. Output = **a bespoke, fabrication-ready circuit board.** This is the *opposite middle* of Blockless's funnel: where Blockless wires **off-the-shelf modules** and ships a runnable **MicroPython/uPyOS app + ecosystem**, Ravn designs **custom copper** and ships a **bare board with firmware**. The genuine strategic collision is narrow but real: **Ravn fully automates the exact "Manufacture / 小批量代工" stage that the Blockless deck currently treats as a manual, paid, human-delivered revenue line.**

---

## 2. What Ravn is — verified product facts

### 2.1 Input [V]
- "Describe your product in plain English. The Lead Engineer agent reads your goal…"
- Answers a few **non-technical** questions: battery life, wireless, indoor/outdoor, target cost.
- Example prompts: "A soil moisture sensor for my garden," "A BLE heart-rate wearable."

### 2.2 The agent swarm — full pipeline [V]

| Stage (Ravn's own name) | What it does | Tool/fab integrations |
|---|---|---|
| **Sourcing** | researches & selects **individual components** | Digi-Key, Mouser, LCSC |
| **Schematic** | draws the schematic | KiCad, Altium, SnapEDA |
| **PCB Layout** | places & routes a **custom PCB** | KiCad |
| **Bill of Materials** | component-level BOM + unit pricing | — |
| **Firmware** | writes firmware | PlatformIO, Arduino, Zephyr RTOS, GitHub |
| **Mfg Checks** | DFM against the **fab's real design rules** | JLCPCB, PCBWay, OSH Park |
| **Fabrication** | one-click **Gerbers + BOM + assembly files** | export to KiCad, push to fab |

### 2.3 Human-in-the-loop model [V]
- "Ravn won't lock in a part, finalize a board, or send files to the fab without you."
- "~4 decisions actually need you," "<8s average time per decision."
- Decisions that lock cost / select critical parts / send files to fab surface for **1-click approval with full context**.

### 2.4 Output & timeline [V]
- "complete, fabrication-ready design in **under 1 hour**."
- "**In two weeks, real hardware arrives**" — i.e. the *user* sends exported files to JLCPCB/PCBWay; **[I]** Ravn does not appear to own logistics/assembly, it hands off files.
- "Under $200 for your first prototype including boards."

### 2.5 Pricing [V]
| Tier | Price | Notable gating |
|---|---|---|
| Make | Free | full agent swarm, up to 5 projects, DFM checks, BOM export |
| Pro | $49/mo | unlimited projects, advanced DFM, firmware editor, substitution intelligence |
| Teams | $299/mo | up to 10 seats, shared library, version control, Altium/Cadence schematic import |

### 2.6 What Ravn explicitly does NOT cover [V]
- **No enclosure / mechanical / 3D CAD** for housing.
- **No simulation / verification** as a discrete stage.

### 2.7 Company facts [U]
- Funding, YC batch, founders, team size, traction (HN/X) — **not found** in this pass. Gap to fill before any VC-objection use.
- Auto-routing **quality** is a vendor claim, unverified — see §7.

---

## 3. The funnel map — same endpoints, opposite middle

Using the repo's existing 5-stage funnel (`project_competitor_matrix_v6_1.md`: **Plan → Wire → Code → Run → Manufacture**):

| Funnel stage | Blockless | Ravn |
|---|---|---|
| **Plan** | NL intent → board + **module** selection (catalog/Package Intelligence) | NL intent → **component (IC)** selection |
| **Wire** | pin-mapping for **off-the-shelf modules** (Grove / active BLE modules) | **schematic + custom PCB routing** (replaces "wire" with "design copper") |
| **Code** | MicroPython on uPyOS, REPL hot-reload (<1s loop) | firmware via PlatformIO/Arduino/Zephyr (compile-flash loop) |
| **Run** | **flash + live REPL iteration on a real module; app runs on uPyOS** | flash firmware to the **custom board** (no OS/runtime/app layer) |
| **Manufacture** | **manual paid service** ("联系我们 → redesign PCB → 10–1000 units") | **fully automated**: Gerbers/BOM/assembly → JLCPCB/PCBWay |

**Key reading:** Ravn and Blockless target the *same two endpoints* (idea → manufacturable device) but invert the middle:
- Blockless = **board/module level** → instant, software-iterable, ecosystem (OS + app store + modules).
- Ravn = **component level** → manufacturable bespoke board, but **bare** (no runtime, no app layer, no ecosystem).

---

## 4. What Blockless lacks vs Ravn (the literal gap list)

Confirmed by grep over the tree: **no PCB/schematic/EDA automation engine exists** (matches are only catalog JSON + competitor/pitch docs). Blockless is missing the entire automated EDA chain:

- ❌ Component-level (IC/passive) selection — Blockless stops at module/board level
- ❌ Automated schematic capture (原理图)
- ❌ Automated PCB layout/routing (the "CAD")
- ❌ Component-level BOM
- ❌ DFM checks against a fab's real design rules
- ❌ Gerber / assembly file export + direct fab handoff (JLCPCB/PCBWay/OSH Park)
- ❌ KiCad / Altium project export

In Blockless this is **a human, paid service**; in Ravn it is **the product**.

---

## 5. What Ravn lacks vs Blockless (the symmetric gap — this is the moat)

"缺啥" is **not** one-directional. Ravn delivers a bare board; everything that makes it *usable and an ecosystem* is absent:

- ❌ Runtime / OS — no uPyOS, no Activity lifecycle, no app model
- ❌ App store / distribution — no "others can install your creation" layer
- ❌ Plug-and-play module ecosystem (self-describing BLE/ESP-NOW active modules)
- ❌ MicroPython REPL <1s hot-iteration; Ravn's firmware loop is compile-flash (this is exactly **deck redline #3b**, see §6)
- ❌ Chinese support / zero-EE-knowledge UX **for the post-design steps**: Ravn hands a first-timer **a fine-pitch SMD board they still have to assemble/solder/reflow or pay PCBA for** before anything runs. "Today it runs" is a Blockless property, not a Ravn one.

---

## 6. How Ravn slots into the existing competitive apparatus

### 6.1 Competitor class
Ravn belongs in the **"AI ECAD / PCB automation"** row of `blockless_competitor_exhaustion_map.md` (alongside Flux, Quilter, Diode, SnapMagic, tscircuit, SchGen, pcbGPT) — **but it is the only full-stack orchestrator** in that row. The others are point tools:
- **Quilter** [V, secondary] — physics-driven *layout/routing only*, returns files to existing CAD.
- **Flux.ai** — browser eCAD environment; AI auto-layout works for *2–4 layer, 40–100 component* boards.
- **DeepPCB** — RL routing, *2-layer beta*.
- **Diode** — AI custom-board *design service* (high-ticket, human review).

Ravn's differentiation **within EDA-AI** = it chains Plan→Schematic→PCB→Firmware→Fab into one agent swarm. That is also what makes it the most direct pressure on Blockless's "造→卖" end.

### 6.2 The deck already has the answer — redline #3b
`blockless_competitor_exhaustion_map` / INDEX redline **#3b** prescribes the axis for *any* AI-hardware competitor:
> main axis = who fits the AI-codegen era (LLM writes Python > C 10× / REPL <1s vs compile-flash ≥30s / Python exceptions vs C hardfault) + secondary axis = **plug-and-play modules vs self-soldered PCB**.

Ravn lands cleanly on the **wrong side of the secondary axis**: its deliverable is a **self-soldered/PCBA custom PCB**, and its firmware path (PlatformIO/Arduino/Zephyr) is **compile-flash**, not REPL. The existing frame answers Ravn without inventing new narrative — **do not** rebut Ravn with "different abstraction layer" (banned per redline #3/#3b); rebut on assemble-a-bare-board vs runs-today + compile-flash vs REPL.

### 6.3 Where Ravn is *stronger* pressure than Schematik
The deck's Slide 9 showdown is "us vs Schematik." Ravn pressures a **different stage** than Schematik does:
- Schematik (per `project_competitor_schematik_intel.md`) = breadboard-tier ESP32 guides; stops early in the funnel.
- **Ravn reaches all the way to Manufacture** — the stage Blockless monetizes manually. So Ravn is the **first competitor that automates Blockless's paid 小批量代工 / custom-PCB revenue line.** That is the real news.

---

## 7. Threat assessment

| Dimension | Severity | Why |
|---|---|---|
| Steals the "AI hardware builder" **narrative** | **Medium–High** | Cleanest idea→fab demo in the category; "fabrication-ready in 1 hour" is a strong headline. |
| Threatens Blockless's **prototype/runtime wedge** (Plan→Wire→Code→Run) | **Low** | Opposite philosophy; no OS/app/module/REPL; first-timer still can't *run* a bare board today. |
| Threatens Blockless's **Manufacture revenue** (小批量代工 / custom PCB) | **High (structural)** | Ravn *automates* exactly what the deck sells as a manual human service. This is the line item to defend. |
| Near-term **execution** threat | **Bounded** | Full-auto routing is still simple-board-only across the field (Quilter/Flux/DeepPCB cap at 2–4 layer, ≤~100 components). Ravn's "<1hr fabrication-ready" is **[I] credible only for low-complexity boards**; complex/RF/HDI almost certainly still needs humans. Treat the claim as bounded, not magic. |

---

## 8. Recommendation

**Do not** chase general full-auto PCB-CAD head-on. Reasons:
1. It's the crowded, capital-heavy battlefield of Quilter / Flux / DeepPCB / Diode / Ravn — and **off-persona**. Blockless's persona (idea-driven non-engineer) cannot assemble the fine-pitch SMD board a router spits out; for them an auto-routed bare board is *less* useful than instant plug-and-play modules.
2. Ravn's own "for first-timers" claim is aspirational on the **assembly** side — bare-board delivery is an EE-adjacent deliverable.

**Do** treat Ravn as the trigger to harden the *one* place it actually collides — the **Manufacture stage**:
- The defensible, on-strategy wedge = **automate the "validated module combo → consolidated single-board integration" handoff.** I.e. once a user's off-the-shelf-module recipe is *verified to run* (Blockless's unique closed loop), auto-generate the integration spec / consolidated schematic / BOM that *feeds* the paid custom-PCB layer — making 小批量代工 faster and cheaper.
- This **reuses the module ecosystem + verified-recipe moat** instead of competing on generic EDA, and it converts Ravn's strength (auto-EDA) into a *downstream* step that starts from Blockless's *upstream* advantage (a recipe that already runs).

Framing line for the deck: *Ravn designs copper from a sentence; Blockless makes the thing run today from modules, then — only when the user has a validated, running design — hands a clean integration spec to manufacturing. Ravn starts at the bare board; we start at "it works."*

---

## 9. Open questions / gaps to fill [U]

1. Ravn funding / YC batch / founders / team size / traction — **unknown**; fill before any investor-facing use.
2. Real routing **quality** & complexity ceiling — vendor claim only; find a third-party teardown or test it.
3. Does Ravn touch **logistics/assembly**, or only export files? Current read = export-only handoff **[I]**.
4. Firmware language reality — PlatformIO/Arduino/Zephyr implies **C/C++**; confirm whether any MicroPython path exists (matters for redline #3b).
5. Is there overlap risk on the **active-module** idea (does Ravn do module-level at all)? Current read = **no, component-level only** **[V]**.

---

## 10. Sources

- [getravn.xyz](https://www.getravn.xyz/) — primary, all [V] facts
- Category context: [Quilter](https://www.quilter.ai/), [Flux.ai](https://www.flux.ai/), DeepPCB, [Diode](https://www.diode.computer/) — secondary, for §6.1 / §7 complexity-ceiling
- Internal: `blockless_competitor_exhaustion_map.md` (AI ECAD/PCB row), `research-INDEX.md` redlines #3 / #3b, `project_competitor_matrix_v6_1.md` (5-stage funnel)
