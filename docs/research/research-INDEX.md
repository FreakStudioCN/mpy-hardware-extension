# Cursor for Hardware · Deck Research Memory

**切割日期**：2026-04-29（v6 deck-positioning sediment）
**Phase 2 添加**：2026-05-01（live field intel + 需求/竞品/GTM 综合 — 16 个新文件，见下方 §"Phase 2"）
**来源**：`C:\Users\Haipeng Wu\.claude\projects\C--Users-Haipeng-Wu-Desktop-claudehardware\memory\`
**用途**：当前 pitch deck（"AI-native hardware creation platform" / 美国融资 / 对标 Cursor）的论据、定位、Slide 内容、修订决策、需求验证、竞品情报、launch GTM。
**怎么用**：未来做 deck / GTM 相关工作时，在 Claude 里 `@C:\Users\Haipeng Wu\Desktop\cursor_for_hardware\INDEX.md` 一次性恢复全部上下文。日常 session 不再自动加载。

**Origin sessions**：`94649df4-53c7-4cb7-b1bc-d396c60dfe85` / `00304ce0-4561-4b5c-aeca-830d2eef5202`

---

## 文件夹结构

```
cursor_for_hardware/
├── INDEX.md                              ← 你正在看
│
├── pitch_deck/                           ← deck 源 + HTML 输出
│   ├── deck_en.md                        英文 deck（v6）
│   ├── deck_cn.md                        中文 deck（v6）
│   ├── SPEC.md                           deck spec（含 v6 lock）
│   └── dist/
│       ├── en/index.html                 英文 deck HTML（待重新渲染至 v6）
│       └── cn/index.html                 中文 deck HTML（待重新渲染至 v6）
│
├── pitch_research/                       ← 融资数据 + 方法论参考
│   ├── data_v1.md                        v1 (2026-04-28 上半天) + v2 amendment (下半天美国 VC 调整)
│   └── joelparkerhenderson_pitch_deck/   开源 pitch 方法论参考库（YC / 500 Startups / Atrium / Stratechery / Floodgate / Elad Gil / Guy Kawasaki / 等）
│
├── ai_hw_one_prompt_research/            ← "一句话生产硬件" landscape 调研
│   └── landscape_v1.md
│
├── idea.md                               ← 早期产品思路（技术栈论述 §3.1–§3.3 是 v6 deck 的根据地）
│
├── 11 个 deck 论据 memory（v6 lock 2026-04-29）
└── 16 个 Phase 2 field intel + 综合 memory（2026-05-01，见下方 §"Phase 2"）
```

---

## Deck 修订链时间线

| 版本 | 时间 | 核心改动 | 落地 memory |
|------|------|---------|-------------|
| v1 → v2 | 2026-04-28 | 砍掉中国市场叙事（艾瑞/教育部/童心制物），改美国/全球数据锚 | `project_us_fundraising.md` (v1 老版) → `project_us_fundraise_pitch.md` (v2) |
| v2 → v3 | 2026-04-29 | (1) Pitch 脊柱锁定 Cursor 品类对标，KS 退出核心叙事；(2) CEO MPy 贡献者 = Thiel-secret，Why-Now 三力重写；(3) 修复 Plaud/Humane demand 论据漏洞（用户群体不匹配） | `feedback_pitch_anchor_cursor.md` / `project_ceo_micropython_contributor.md` / `feedback_evidence_user_match.md` |
| v3 → v4 | 2026-04-29 | (1) Schematik $4.6M Lightspeed 当 timing 论据，Slide 8 改 2x2；(2) 拒长尾创作者经济，Slide 10 改"说→造→跑→卖"端到端；(3) Wedge 锁纯模块化无 host | `project_schematik_position.md` / `project_modular_wedge.md` |
| v4 → v5 | 2026-04-29 | (1) AppStore 从商业分发降级为社区配方层（drop takerate）；(2) 商业模式锁三条复利营收 Skill SaaS + 模块销售 + 小批量代工 | `project_appstore_community_layer.md` / `project_business_model.md` |
| v5 → v6 | 2026-04-29 | (1) **Schematik 重定位**：从"工程师层 vs 创作者层不同抽象"改为"同品类直接竞品 + 技术栈正面对决"——Schematik 实际也输出 ESP32/Arduino/RPi 代码，他们押 C 我们押 MicroPython；(2) **新增 Slide 4「今天 AI 做硬件为什么都失败」**：5 个 deepresearch 失败模式（API 幻觉 / 包版本漂移 / 物理破坏 / SDK 碎片化 / compile-flash 闭环断裂）；(3) **Slide 9 重写**：11 维 Schematik vs 我们对决表，每行右列锚定 Slide 4 失败模式编号；(4) CEO MicroPython 贡献者身份从 secret/moat 提级为 central thesis（LLM 写 Python > 写 C 10× 是客观结论）；(5) 总 slide 数 13 → 14 | `project_schematik_position.md`（重写）/ `project_ceo_micropython_contributor.md`（提级）/ `project_ai_hardware_failure_modes.md`（新建）/ `feedback_micropython_vs_c_moat.md`（新建） |

---

## 11 个文件清单

| # | 文件 | 一行核心 | 涉及 deck Slide |
|---|------|---------|-----------------|
| 1 | [project_us_fundraise_pitch.md](project_us_fundraise_pitch.md) | 美国 VC 听众，欧美/全球叙事；Plaud 只当 demand 数据不当团队类比；Espressif 引出货量不包装成 unfair advantage；法律结构 Delaware/HK/SG | 全 deck 红线 |
| 2 | [project_us_fundraising.md](project_us_fundraising.md) | **(v1 老版存档)** 砍中国市场叙事的最早一版定位 | 历史参考 |
| 3 | [feedback_pitch_anchor_cursor.md](feedback_pitch_anchor_cursor.md) | 脊柱 = AI 改写硬件 = Cursor 改写 IDE；老 dev kit (Wio/M5Stack/Adafruit) 只在 problem slide；KS 是 GTM 战术不进核心叙事 | Slide 5 / 9 / 13 |
| 4 | [project_ceo_micropython_contributor.md](project_ceo_micropython_contributor.md) | **v6 提级为 central thesis**：CEO 是 MPy 核心贡献者；LLM 写 Python > 写 C 10×（客观结论），所以 AI 原生硬件 runtime 必然是 MicroPython 这一脉；MCU 出货量等行业大盘数据**不**进核心叙事 | Slide 5 (Why-Now) / 6 (uPyOS) / 12 (Team) |
| 5 | [feedback_evidence_user_match.md](feedback_evidence_user_match.md) | 引 demand 数据先问"卖给谁 vs 我们卖给谁"；Plaud/Humane/Friend/Limitless B2C 成品销量**不能**当我们创作者工具的 demand；要用 Cursor/Squarespace/Roblox/Shopify/YouTube creator 这类"democratize creation" | 全 deck demand 段 |
| 6 | [project_modular_wedge.md](project_modular_wedge.md) | Wedge = active modules ESP32-C3 自给无 host；类比锁 Cursor + Lovable；Slide 11 = 说→造→跑→卖 4 步端到端 | Slide 11 / 6 / 8 |
| 7 | [project_schematik_position.md](project_schematik_position.md) | **v6 重写**：Schematik = 同品类直接竞品（不是不同抽象层），他们也输出 ESP32/Arduino/RPi 代码；我们靠 MicroPython + 模块化技术栈碾压；11 维对决表 | Slide 5 / 9 |
| 8 | [project_appstore_community_layer.md](project_appstore_community_layer.md) | AppStore = 社区配方层（fork/学习/二次开发），不是商业分发；Slide 11 第 4 步 drop AppStore distribution | Slide 6 / 8 / 11 / 13 |
| 9 | [project_business_model.md](project_business_model.md) | 三条复利营收：Skill SaaS（Cursor-style，**非**免费层）+ 模块销售 + 小批量代工 10-1000 件；AppStore 不商业 ≠ Skill 不商业 | Slide 9 / 11 |
| 10 | [project_ai_hardware_failure_modes.md](project_ai_hardware_failure_modes.md) | **v6 新建**：5 个 AI 硬件失败模式 deepresearch（API 幻觉 / 包版本漂移 / 物理破坏 / SDK 碎片化 / compile-flash 闭环断裂）+ 各自出处 + 我们栈逐条破解 | Slide 4 (主) / 5 / 6 / 7 / 9 |
| 11 | [feedback_micropython_vs_c_moat.md](feedback_micropython_vs_c_moat.md) | **v6 新建**：任何 AI-硬件竞品比较，主轴 = AI codegen 时代谁更适合，证据三件套（LLM 写 Python > C 10× / REPL vs compile-flash / 异常 vs hardfault）+ 模块化次轴 | Slide 9 / 任何竞品对比段 |

---

## 关键论据红线汇总（最高优先级）

下面是做 deck 任何修订时**必须遵守**的硬约束。违反任何一条都说明没看 INDEX。

### 叙事

1. **脊柱**：AI 改写硬件创作 = Cursor 改写 IDE。对标 Cursor / Copilot / Replit / Lovable，**不**对标 KS Top 5 销量、**不**对标 Plaud/Humane/Friend B2C 成品。
2. **Why-Now 三力**：(1) AI 硬件需求被验证（Plaud/Humane 只在这一段出现）+ (2) AI code-gen toolchain 成熟（Cursor/Copilot）+ (3) **底层 runtime 我们自己拥有（MPy + CEO 是核心贡献者）**。
3. **【v6 修正】Schematik = 同品类直接竞品**（v5 之前的"不同抽象层"framing 已推翻）：他们也输出 Arduino/ESP32/RPi 代码，客户重叠；区别是技术栈——他们押 C，我们押 MicroPython + 模块化。Slide 9 用 11 维对决表正面碾压，每行右列锚定 Slide 4 失败模式编号。**他们的 $4.6M Lightspeed 仍当 timing/品类验证论据**，但**不再当"我们高一层"的逻辑前提**。
3a. **【v6 新增】Slide 4「今天 AI 做硬件为什么都失败」必须存在**：5 个 deepresearch 失败模式 = (1) API/寄存器幻觉 (2) 包版本漂移 (3) 物理破坏 (4) SDK 碎片化 (5) compile-flash 闭环断裂。每个都有公开引用源。后续每张能力 slide 都要锚定这 5 模式之一。
3b. **【v6 新增】比较任何 AI-硬件竞品**：主轴 = AI codegen 时代谁更适合（三件套：LLM 写 Python > C 10× / REPL 热加载 < 1s vs C compile-flash ≥ 30s / Python 异常 vs C hardfault）+ 次轴 = 模块化即插即用 vs 自焊 PCB。**禁用**"抽象层不同 / 市场不同 / 我们更高一层"等绕圈论据当主轴。
4. **【v6 修正】"Cursor for hardware" 可以用了**：v5 之前的"slogan 被 Schematik 占了"判断已修正——我们和 Schematik 同品类，slogan 共享，区别是技术栈赌局。封面 tagline 仍优先 "AI-native hardware creation platform"，但 body text 用"Cursor for hardware"无碍。

### 论据合规

5. **demand 数据用户群体必须匹配**：引 X 公司销量/ARR 前先问"X 卖给谁 vs 我们卖给谁"。Plaud/Humane/Friend/Limitless **只**在我们也定位"卖给消费者的成品"时才能用，做创作者工具时**不能用**。
6. **行业大盘数据降权**：MCU 出货量、ESP32 累计销量、Yole 数字等"和我们关系不大"，不进核心叙事。
7. **数字必须官方依据**：不知道就模糊表达，不要凭印象编（per `feedback_official_sources_only` in 主 memory）。

### 团队 / 路径

8. **CEO 第一身份 = MPy 核心贡献者**，比头衔/学历优先。
9. **不强调中国背景**：CFIUS / 国家安全审查风险；"深圳 + 厂房" 翻译成 "global manufacturing partner network / faster prototyping"。
10. **法律结构**：Delaware / HK / SG 主体，中国子公司只做 R&D 服务，不持核心 IP。

### 产品 / 商业模式

11. **Wedge = active modules 自给**（ESP32-C3 + 传感/执行 + BLE，自描述能力）；**无 host 设备**；手机/网页当显示和控制；类比 Cursor + Lovable，**不**扩展到 LEGO/Squarespace/Roblox/Shopify。
12. **【v6 编号顺延】Slide 11 价值链 4 步**：说（Skill 解析）→ 造（uPyPI + uPyOS + AI Skill）→ 跑（主动模块发货拼起来）→ 卖（KS 上线支持 + 小批量代工 10-1000 件）。**不**包含 AppStore distribution。
13. **三条复利营收**：Skill SaaS / metered（Cursor-style 主营收，**不**是免费引流层）+ 模块销售（按 SKU）+ 小批量代工（创作者商业化时使用）。
14. **AppStore = 社区配方层**：fork / 学习 / 二次开发；**不**做 takerate / 应用分成 / 第三方付费分发。
15. **不写具体订阅价 / metered 单价**（per `feedback_no_pricing_advice` in 主 memory）。只写 "SaaS / metered, Cursor-style"。

---

## 与主 memory 的关系

切割后主 memory 仍保留这些**通用**约束（继续生效，不重复在这里）：
- `feedback_official_sources_only.md` — 数字必须官方依据
- `feedback_no_pricing_advice.md` — 不给价格建议
- `feedback_research_sediment.md` — 引数字当场搜+沉淀
- `feedback_competitor_match_audience.md` — 竞品调研贴目标人群
- `user_gender_team.md` — 团队都是男的，不用女创业者人设
- `user_strategy_product_focus.md` — 战略/产品/市场角色，密度输出
- `project_cto_factory_assets.md` — CTO 5 年硬件 + 厂房素材可用

主 memory 中的 deck 索引已替换为单行指针，指向本 INDEX.md。

---

## Phase 2 — Live Field Intel + Synthesis (2026-05-01)

**Source:** 4 parallel research agents (Reddit+HN, X+Discord, China+proxies+adjacent, Schematik+Blueprint deep-dive) + foreground synthesis pass. All claims dated 2026-05-01 with URL citations.

**Why this phase:** v6 deck (locked 2026-04-29) makes claims about demand and competitor weakness that rested on inference. Phase 2 sediments first-party evidence — verbatim user quotes, dated traction signals, founder GitHub histories — so future deck/GTM work has citeable backing.

### Phase 2 file map

#### Demand evidence (5 files)
| 文件 | 一行核心 |
|---|---|
| [feedback_demand_reddit.md](feedback_demand_reddit.md) | Reddit 403-blocked → pivoted to forum-equivalent corpus (Arduino Forum / ESP32 Forum / eevblog); 38 threads, 27 demand-shape matches, 5/5 failure-mode coverage |
| [feedback_demand_hn.md](feedback_demand_hn.md) | 6 anchor HN threads, ~45 entries; **Schematik HN traction is weak (3 submissions, 6 combined points)**; ExtraKaylee "500ms reprogramming loop" validates REPL bet |
| [feedback_demand_x.md](feedback_demand_x.md) | 40 X entries; founder + investor map (Beek / Lightspeed / 3E8 team / Anthropic Felix Rieseberg); Sajeel Apr-25 1.1M-view tweet captured |
| [feedback_demand_discord.md](feedback_demand_discord.md) | 10 communities mapped externally; **Schematik & Blueprint have NO public Discord** — community moat is uncontested |
| [feedback_demand_china.md](feedback_demand_china.md) | 35 entries Bilibili/小红书/知乎/36氪; **D2 quote: Beek shorted his whole house with AI door opener** (failure-mode #3 in competitor's own marketing, in CN media); 10 EE-pro objection lines pre-baked |

#### Demand calibration (1 file)
| 文件 | 一行核心 |
|---|---|
| [feedback_demand_proxies.md](feedback_demand_proxies.md) | 14-row table of adjacent demand proxies; **PlatformIO 6,000,000+ unique installs (Feb 2026)** = the floor for "embedded devs who actively wanted better tooling" |

#### Competitor intel (4 files)
| 文件 | 一行核心 |
|---|---|
| [project_competitor_schematik_intel.md](project_competitor_schematik_intel.md) | Live field intel: 13 build guides 100% breadboard-tier ESP32 (validates v6 framing); Beek = PM with iOS Swift GitHub, no embedded code; sandwich solves only #3; 1–3 headcount, 3 founding-team open roles → **60–90 day pre-team window**; Antoine Moyroud led Lightspeed deal (AI/dev-tools partner, NOT hardware) |
| [project_competitor_blueprint_intel.md](project_competitor_blueprint_intel.md) | **Critical reframe: Blueprint does NOT generate firmware code** (FabScene Medium reviewer verbatim); side product of 3E8 delivery-robot company; scamadviser-flagged; 833 X followers despite 1.1M-view viral demo (0% retention) |
| [project_competitor_schematik_community.md](project_competitor_schematik_community.md) | No Discord, no Discourse, 2 blog posts, 13 SEO-farm press reposts (only siliconsnark is critical); samuelbeek manually planting HN comments — capital-without-community |
| [project_competitor_blueprint_community.md](project_competitor_blueprint_community.md) | No Discord, IG @blueprint.am 436 followers / 30 posts; trust signals weak (one IG comment "Scam") |

#### Outer landscape (1 file)
| 文件 | 一行核心 |
|---|---|
| [project_competitor_adjacent_landscape.md](project_competitor_adjacent_landscape.md) | 8 outer-ring players ranked by VC-will-ask probability; **#1 risk: Espressif ESP-Claw + ESP-IDF MCP servers (Apr 23, 2026)** — chip vendor moved up the stack; #2: Arduino Cloud AI Assistant (Claude-powered, GA since 2025-06); Flux.ai $37M = funding ceiling; YC W26 firmware-AI funded for pro/aerospace, NOT creator/educator (wedge intact); CircuitPython newsletter is publicly asking for our product |

#### Synthesis (4 files — load-bearing for v6.1 deck revisions)
| 文件 | 一行核心 | Deck slot |
|---|---|---|
| [project_competitor_matrix_v6_1.md](project_competitor_matrix_v6_1.md) | **5-stage funnel diagram (Plan→Wire→Code→Run→Manufacture) + 11-dim 2-column matrix (us vs Schematik), Blueprint footnoted** — replaces v6 plan to widen Slide 9 to 3 columns | Slide 9, Slide 11 |
| [project_demand_shape_synthesis.md](project_demand_shape_synthesis.md) | 4 segments (S1 hobbyists / S2 educators / S3 HA power-users / S4 SMB indie); per-segment failure-mode hit matrix; verbatim phrase candidates for headlines; PlatformIO 6M floor; serving order for GTM | Slide 3 (Demand), Slide 13 (GTM) |
| [project_competitive_gap_v6_1.md](project_competitive_gap_v6_1.md) | 6 competitor lanes with strengths / vulnerabilities / structural counter / 1-line deck script each; pre-baked counters for ESP-Claw, Arduino Cloud AI Assistant, EE-pro objections | Slide 4, 5, 9, 12 |
| [project_gtm_angles_v1.md](project_gtm_angles_v1.md) | Top-5 beachhead community ranking; top-7 founder DM list (Uri Shaked / Damien George / Felix Rieseberg / Jesse Hills / Ladyada / Antoine Moyroud / Thomas Wolf); 4 content hooks (Kindle counter / Python-not-C thesis / ESPHome live-stream / Show HN A/B/C); 10 anti-patterns; week-by-week launch sequencing; **#1 launch lever: Hook #1 Kindle counter to Sajeel's tweet, ship within 30 days** | Slide 13 + GTM action |
| [project_competitor_adjacent_landscape.md](project_competitor_adjacent_landscape.md) | (already listed under Outer landscape) | Slide 8 footnote |

#### Launch execution (3 files added 2026-05-01 after the 4-decision strategic gate)
| 文件 | 一行核心 |
|---|---|
| [feedback_phase2_decisions_2026_05_01.md](feedback_phase2_decisions_2026_05_01.md) | 4 durable decisions: D1 Beek-quote-in-Slide-4 / D2 Kindle counter ship 14d / D3 founder DMs send-now / D4 accept Reddit forum-equivalent corpus |
| [project_founder_dms_v1.md](project_founder_dms_v1.md) | 5 drafted DMs: Uri Shaked / Damien George / Felix Rieseberg / Jesse Hills / Ladyada (Adafruit ICYMI submission) — each ≤80 words, one ask + one artifact |
| [project_kindle_counter_hook_v1.md](project_kindle_counter_hook_v1.md) | 14-day production sprint: 90s video shot list, exact prompt, day-by-day owner table, X drop tone, success criteria, anti-patterns |

### v6 → v6.1 — what Phase 2 changes in the deck

| Slide | v6 (locked 2026-04-29) | v6.1 (informed by Phase 2) |
|---|---|---|
| **4** (Failure modes) | 5 modes with academic citations | + siliconsnark line *"physical systems eventually stop accepting poetic intent as a substitute for correctness"* + the Beek-shorted-his-house example as a quotable origin (cite source: 知乎 D2 + siliconsnark, NOT us editorializing) |
| **9** (Showdown matrix) | 11-dim 2-column us vs Schematik | **Confirmed correct** — do NOT widen to 3 columns. Add funnel-position diagram on top of matrix; footnote Blueprint as "stops at Wire stage" |
| **5** (Why-Now) | 3 forces | **Add a 30-day-window paragraph**: Schematik 60-90 day pre-team + Blueprint viral-no-funnel + ESPHome 2026.4.0 wave |
| **8** (AI hardware landscape) | 2x2 grid | **Add Espressif ESP-Claw + Arduino Cloud AI Assistant nodes** to the landscape; mark each "plumbing partner" not competitor |
| **12** (Team) | CEO MPy contributor as central thesis | **Add Beek-as-PM contrast** — but tone-neutral, factual GitHub link, not personal |
| **13** (GTM) | KS as launch tactic | **Replace** — KS is now footnote; primary launch is Discord + Wokwi/MPy/ESPHome community + Kindle counter-demo |

### Phase 2 verification — completed 2026-05-01

✅ **INDEX coherence:** every Phase 2 file linked above (16 files written, 16 indexed).
✅ **Source-traceability spot-check:** Beek-shorted-his-house quote = siliconsnark 2026-04 + 知乎 D2; FabScene Blueprint review = Medium 2026-04; ESP-Claw = CNX 2026-04-23. URLs preserved.
✅ **Audience-match rule:** B2C signals (Plaud/Humane/Friend) explicitly excluded from demand evidence per `feedback_evidence_user_match.md`. PlatformIO 6M and 创客/教育 segments are creator/maker-shaped.
✅ **Failure-mode coverage:** all 5 modes have ≥3 quoted backing entries across `feedback_demand_china.md` + `feedback_demand_hn.md` + `feedback_demand_reddit.md`.
✅ **Competitor matrix re-derivation:** funnel diagram + 11-dim table cells defensible from `project_competitor_schematik_intel.md` + `project_competitor_blueprint_intel.md`.
✅ **GTM angle test:** each angle in `project_gtm_angles_v1.md` maps to a specific Discord / X handle / community name with URL.
⚠️ **Known gap:** Reddit was 403-blocked; agent pivoted to forum equivalents. If first-party Reddit data is required (e.g. for upvote-count claims), commission with paid Pushshift / Reddit API access.
⚠️ **Known gap:** X follower / engagement counts behind 402 paywall on WebFetch. Numbers cited are from Google search snippets; treat as ±20% uncertainty.

### How to use Phase 2 sediment

- **Deck v6.1 revision:** read `project_competitor_matrix_v6_1.md` + `project_competitive_gap_v6_1.md` first; use the per-slide change table above as the work plan.
- **GTM week-1 launch:** read `project_gtm_angles_v1.md` Section 6 (week-by-week sequencing); the single-most-important action is Hook #1 (Kindle counter to Sajeel) within 30 days.
- **VC objection prep:** read `project_demand_shape_synthesis.md` Section 4 (pre-baked counters) + `project_competitive_gap_v6_1.md` per-competitor "1-line deck script."
- **Founder DMs:** read `project_gtm_angles_v1.md` Section 2 (7 high-EV warm-touches in priority order).
