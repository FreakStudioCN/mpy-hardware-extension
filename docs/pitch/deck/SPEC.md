# Pitch Deck SPEC v1

> Date: 2026-04-29
> Owner: CEO (user)
> Status: spine approved, content drafted, awaiting user spec review → frontend-slides render

---

## 1. What this is

Two pitch decks for the same company (AI-native dev kit + ecosystem from `idea.md`):

- **`deck_en.md`** — US VC seed-round fundraising deck. 13 slides. Hard close on Slide 13 ASK.
- **`deck_cn.md`** — General-introduction deck for CN audience (partners, community, advisors, KOL). Same skeleton as EN, drops the ASK slide, replaces with a "vision close" slide. More product/architecture detail per user request.

Both share: the same data, the same architecture, the same team, the same Cursor-level narrative anchor. They differ in tone (EN = urgency + ask; CN = informative + vision) and in slide 13 (EN ask, CN close).

---

## 2. Locked decisions (do not re-litigate)

| Decision | Locked value | Source / why |
|---|---|---|
| EN audience | US VC, seed round, no traction | memory `project_us_fundraise_pitch.md`, user 2026-04-29 |
| CN audience | 介绍 deck (partners / community / advisors / KOL); not for fundraising | user 2026-04-29 |
| Slide 1 hook | "Software's ChatGPT moment was 2022. Hardware's is now." | user 2026-04-29 (option A, AD thesis aligned) |
| Wedge | Dev-kit-style hardware (D-Shell direction); separate from Product 1 (Claude-Buddy 5-LED) | user 2026-04-29 |
| AI layer positioning | Generic LLM, NOT Claude Code-bound | user 2026-04-29 |
| Narrative anchor | Cursor / Replit / Copilot category — "AI-native rewrites X". NOT KS hardware Top 5. | user 2026-04-29 ("我们对标的不是 cursor 这种级别叙事吗") |
| Form factor | Dev kit with screen + module interface + AppStore + battery | user 2026-04-29 |
| AI Skill ≠ Claude IP | Generic, LLM-agnostic positioning | user 2026-04-29 |
| KS launch target | Q4 2026 | user 2026-04-29 (Q7-3 a) |
| Round size | "Raising a seed round" — no specific dollar number on deck | user 2026-04-29 (Q7-2 d) |
| CN deck structure | Same 13-slide skeleton, drop ASK, add product detail | user 2026-04-29 (Q7-4 a) |
| Output format | Markdown content first, then `frontend-slides` skill renders HTML | user 2026-04-29 (Q7-5) |
| Team — CEO | Title only, no bio | user 2026-04-29 |
| Team — CTO | Use the resume facts from `image.png` | user 2026-04-29 |
| Demo video | TBD at KS launch; deck shows architecture diagram + flow | user 2026-04-29 (Q5) |
| Origin hook | Common-insight type (option a) | user 2026-04-29 (Q7-1) |
| Advance assets | None known | user 2026-04-29 (Q8 答"无") |
| Competitor list | Wio Terminal / M5Stack / Adafruit / Arduino / RPi (problem slide) + Cursor / Replit / Copilot (positioning slide) | user 2026-04-29 (Q9 都行) |
| MicroPython framing | NOT external tailwind. Owned by us — CEO is core contributor. Lift to Why-Now force #3 + Team Slide CEO lead bullet | user 2026-04-29 ("你还是没懂 这个是我们带起来的生态") |
| MCU/ESP32 industry stats | OUT of core narrative — Yole 30.6B, Espressif 1B etc. not relevant to our story | user 2026-04-29 ("这个和我们真的关系没那么大") |
| "Physical compute" terminology | OUT — implies B2B GPU. Use "AI hardware" or "hardware creation" instead | user 2026-04-29 ("那些 physicalcompute 都是 tob gpu") |
| Market sizing | TAM/SAM/SOM with $ amounts on each ring (not vague "4 圈层") | user 2026-04-29 ("没有 tamsamson") |
| Analogies | Apple App Store + iPhone (Slide 5); Cursor for hardware (Slide 8); YouTube vs broadcasters (Slide 10) | user 2026-04-29 ("没有足够好的类比") + Thiel/Kawasaki/Fernandes frameworks |
| **v3 wedge: modular ecosystem (no host)** | Active modules = primary product. ESP32-C3 + sensor/actuator + BLE, self-describing, no host device. Phone/web for display & control. | user 2026-04-29 (Q1 (a) "纯模块自给") |
| **v3 analogy lock: Cursor + Lovable only** | Don't expand to LEGO / Squarespace / Roblox / Shopify / YouTube broadcasters. | user 2026-04-29 ("类比不变啊 cursor lovable") |
| **v3 Slide 10 reframe: end-to-end value chain** | Speak → Build → Run → Sell. NOT long-tail platform bet. "We own what Cursor doesn't." | user 2026-04-29 ("不应该是长尾 就是一句话做产品 硬件 帮忙卖") |
| **v3 drop Plaud/Humane/Limitless/Friend entirely** | Cross-market evidence invalid (their B2C consumer customers ≠ our creator customers) | user 2026-04-29 ("plaud 和大众有什么关系吗") |
| **v3 architecture shift** | uPyOS = module-side firmware framework + BLE protocol (not Android-style GUI OS). AppStore lives in phone/web, not device LCD. | user 2026-04-29 (Q1 (a) implication) |
| **v4 Schematik integration** | Schematik (Lightspeed pre-seed Apr 2026) = engineer-layer "Cursor for hardware" / PCB AI; we = creator-layer / module + firmware AI. Same narrative, different abstraction. Their funding = category timing proof. | user 2026-04-29 ("本质上和 schematik 叙事一样") |
| **v4 AppStore reframe** | Phone/web AppStore = community recipe sharing + fork + learn. NOT commercial distribution. | user 2026-04-29 ("app store distribution 不是核心商业模式 类似社区模式") |
| **v5 business model lock** | "Cursor for hardware" IS the business model. Three revenue streams: **Skill SaaS / metered (Cursor-style)** + **module sales** + **small-batch manufacturing**. Skill is NOT free. | user 2026-04-29 ("我们主要商业模式不还是 cursor for hardware 吗 帮别人造东西啊") |
| **v5 slogan rule** | "Cursor for hardware" is OK as business-model framing in body text, NOT as exclusive slogan (Schematik occupies the slogan; we are the creator-level cousin). Cover slide tagline = "AI-native hardware creation platform". | derived from v4 Schematik + v5 business model locks |
| **v6 Schematik = same-category direct competitor (not a different abstraction layer)** | Slide 9 (was 8) rewritten as head-to-head Schematik vs us tech-stack table (11 rows). Each row's right column anchors to one of the 5 Slide-4 failure modes. Drop "engineer vs creator 2x2." Audience-scale (500M vs 50M) demoted from premise to consequence. | user 2026-04-29「我们是碾压他们 而不是他们上面的一层 本质价值是一样的 我们是技术栈优势 因为我们有 micropy 更好动态运行 卖的模块也更好组装」 |
| **v6 New Slide 4 "Why AI hardware is failing today"** | Inserted between original Slide 3 and original Slide 4 (now 5). Lists 5 documented failure modes with sources: register hallucination / package version drift / physical destruction risk / SDK fragmentation / compile-flash loop break. Each capability we ship cross-references this slide. | user 2026-04-29「你的 deck 缺少 目前 ai 做 hardware 的问题 你要做 deepresearch on this 然后你求实可以看到我们为什么能解决这个问题」 |
| **v6 MicroPython moat thesis** | Tech-stack comparison main axis = "AI codegen era fitness." Three-piece evidence: (1) LLMs write Python > C 10–100× (Sonar / Promptlayer / arxiv 2509.09970) (2) REPL hot-reload <1s vs C compile-flash ≥30s (3) Python exception vs C hardfault. Secondary axis: modules plug-and-play vs solder PCB. | user 2026-04-29 same statement |
| **v6 Slide renumbering** | Slides 4–13 → 5–14. CN deck closing vision still on last slide. EN deck Ask still on last slide. | mechanical from new Slide 4 insertion |

---

## 3. US VC red lines (per memory)

- ❌ Don't pitch China / Shenzhen as advantage. Use functional descriptions, not geographic markers.
- ❌ Don't repeat the "5 years Shenzhen hardware" line — the resume only supports a 3-month internship. Reframe the CTO around 5 issued patents + lab leadership + operating company.
- ❌ Don't tie the AI Skill to Claude / Anthropic. Position generically.
- ❌ Don't make pricing claims for the product on the deck.
- ✅ Use Plaud only as a demand validation point; do not echo China-link narrative.
- ✅ Espressif framed as ARM-class open standard, not a Chinese asset.

---

## 4. Slide spine (v6: 14 slides EN — CN swaps last slide for vision close)

| # | EN title | CN title | One-line message |
|---|---|---|---|
| 1 | Cover / Hook | 封面 / Hook | Hardware's ChatGPT moment is now |
| 2 | The Thesis | 核心命题 | AI rewrote every creative tool in 5 years; hardware is next |
| 3 | The Problem | 问题 | 50M makers + 90% never finish — datasheets / I2C / soldering walls |
| **4** | **Why AI Hardware Is Failing Today** | **今天 AI 做硬件为什么都失败** | **5 documented failure modes — register hallucination / package drift / physical destruction / SDK fragmentation / compile-flash loop break** |
| 5 | Why Now | 为什么是现在 | LLM code-gen mature + Schematik validates category + we own the runtime |
| 6 | What We Built | 我们做了什么 | Skill + uPyPI + uPyOS + active modules; each layer cross-links to a Slide 4 failure mode |
| 7 | The Demo | 演示 | "Make a vibrating thermometer" → working device, no firmware writing |
| 8 | The Product | 产品 | Module library, Q4 2026 KS launch, open ecosystem |
| **9** | **Why This Wins** | **我们的位置** | **Schematik vs us head-to-head on stack: MicroPython > C, modules > solder, single runtime > SDK fragmentation** |
| 10 | Market | 市场 | TAM/SAM/SOM concentric rings with $ amounts |
| 11 | Business Model | 商业模式 | Cursor-for-hardware revenue stack: Skill SaaS + module sales + small-batch manufacturing |
| 12 | Team | 团队 | CEO is MicroPython core contributor (= standard-setter) + CTO (5 patents / RTOS / lab) |
| 13 | GTM / Roadmap | GTM / 路线图 | KS Q4 2026 → 1k ship + recipe app α → small-batch manufacturing 2027 H2 |
| 14 (EN) | Ask | — | Raising a seed round; 40/30/20/10 use of funds |
| 14 (CN) | — | 尾声 / 愿景 | Every smart device may one day be "spoken" into existence — join us |

---

## 5. Open items (not blocking v1, but flag for v2)

- Origin hook one-liner: drafted as common-insight type; user can polish before printing
- Slide 7 product visual: render / engineering sample TBD
- Slide 6 demo video: TBD at KS launch
- Cursor specific valuation number: marked as "category-defining valuation" (specific $X.XB will be filled when user confirms a citation)
- "factory / 厂房" assets from memory `project_cto_factory_assets.md`: not used in deck v1 because the resume doesn't support it; flagged for user reconciliation

---

## 6. Out of scope for v1 deck

- Pricing of the product (per `feedback_no_pricing_advice.md`)
- Specific dollar round size (user chose TBD per Q7-2 d)
- KS shu/email-list traction numbers (user said no advance assets)
- The 5-LED Claude-Buddy / FreakStudio collab — that is a separate product line, not this deck's anchor (user 2026-04-29)
- Specific BOM / Hardware spec / circuit design — out of pitch scope

---

## 7. Output plan

1. `pitch_deck/SPEC.md` — this file
2. `pitch_deck/deck_en.md` — EN deck content (slide-separated by `---`)
3. `pitch_deck/deck_cn.md` — CN deck content (slide-separated by `---`)
4. (after user spec review) → invoke `frontend-slides` skill to render HTML presentations from both markdown files
5. Memory updated with: `feedback_pitch_anchor_cursor.md` (Cursor-level narrative anchor rule)

---

## 8. Self-review check (filled inline post-write)

**v1 checks (2026-04-29 first draft):**
- [x] No placeholders / TODO blocks left in deck content
- [x] Cursor / Copilot / Replit referenced as positioning peers, not as competitors
- [x] No "5 years Shenzhen" lines
- [x] No Claude / Anthropic vendor lock language in the AI Skill description
- [x] No pricing claim for the product
- [x] No round-size dollar number on Slide 13
- [x] CTO bio uses only resume-supported facts (5 patents, OpenCV, RTOS, lab leadership, operating company, 13.6M+ views)
- [x] Plaud reference does not include China-link narrative
- [x] Every cited number has a footnote source link (or marked "TBC by user")
- [x] CN deck drops ASK and replaces with Vision-close
- [x] CN deck adds product/architecture detail vs EN per Q7-4 (a)

**v2 checks (2026-04-29 revision after user review):**
- [x] Slide 4 Why Now reframed: AI hardware demand validated + AI code-gen toolchain + **MicroPython runtime owned by us (CEO core contributor)**
- [x] MCU shipment data (Yole 30.6B / Espressif 1B) removed from Slide 4 + Slide 8
- [x] "Physical compute" framing removed from Slide 8 (B2B-GPU connotation)
- [x] Slide 8 Why-This-Wins now anchored as "Cursor for hardware" + Thiel monopoly conditions
- [x] Slide 9 Market rewritten as proper TAM ($80B+) / SAM ($5B+) / SOM Y1 ($10-30M) with concrete $ numbers
- [x] Slide 10 Long-Tail adds YouTube vs broadcasters analog
- [x] Slide 11 Team CEO line lifted: **MicroPython core contributor** is first bullet, not buried
- [x] Slide 5 What-We-Built adds Apple App Store + iPhone analog
- [x] Frameworks applied: Thiel 7 questions (esp. Secret + Monopoly), Kawasaki 10 slides, Sky Fernandes (1-5 bullets, show don't tell)
- [x] CN deck mirrors all v2 changes

**v6 checks (2026-04-29 Schematik repositioning + AI-hardware failure mode deepresearch):**
- [x] **New Slide 4 inserted** with 5 documented failure modes + sources (arxiv 2509.09970, CACM, gocodeo, electronicsforu, promwad, Adafruit 2025-12)
- [x] Slide 9 (was 8) rewritten: drop "engineer vs creator 2x2", replace with 11-row Schematik vs us head-to-head tech-stack table; each row's right column anchors to a Slide 4 failure-mode #
- [x] Slide 5 (Why Now) force #2 wording changed from "we sit one layer above" to "they bet on C, we bet on MicroPython — same category, different stack"
- [x] Slide 6 (What We Built) uPyPI bullet adds "cure for failure mode #2"; uPyOS bullet adds LLM-Python > C 10× evidence + REPL-loop reasoning
- [x] Slide 7 (Demo) step 2 adds note that module self-description eliminates failure mode #3
- [x] Slide 11 (Business Model) pipeline-diagram footnote updated: Schematik covers steps 1+2 but loses users at step 3 (must-solder-PCB)
- [x] Slide 12 (Team) CEO first bullet promoted: "standard-setter for the category"
- [x] CN deck and EN deck both v6, slide numbering aligned (4–14)
- [x] All 5 failure modes in Slide 4 have publicly-citable sources
- [x] Slide spine table in §4 of SPEC updated to v6 layout
