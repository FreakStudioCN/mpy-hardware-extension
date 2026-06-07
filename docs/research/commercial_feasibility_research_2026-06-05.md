# Commercial Feasibility Research - Blockless

> Date: 2026-06-05  
> Audience: US seed VC deck rewrite.  
> Goal: find objective evidence, attack points, early adopters, and story constraints.  
> Important: this is not a TAM report. It is a diligence map for rewriting the deck.

## Executive Conclusion

The story has room, but only if it is narrowed.

The strongest fundable claim is:

> Blockless is a software-first AI embedded prototyping platform that turns natural-language hardware intent into audited MicroPython running on real boards, grounded by package intelligence, board profiles, and module manifests.

The weaker old claim is:

> Anyone can build any hardware like Lego, and the market is all makers / students / hardware buyers.

That version is too broad and easy to attack. Modular hardware is already crowded. Education is slow. Hobbyists have weak SaaS willingness to pay. The deck should lead with paid prototype velocity for startups, consultants, maker-pros, and labs.

## Current Project Evidence From Local Repo

Local evidence checked on 2026-06-05:

- `third_party/GraftSense-Drivers-MicroPython` contains 167 `package.json` driver descriptors.
- `mpyhw-api/content/packages/package_index.json` parses as 209 records.
- Package index sources: 166 `graftsense`, 43 `upypi`.
- Support levels: 157 `generatable`, 52 `installable`.
- `mpyhw-api/tests/test_package_routes.py` includes resolution tests:
  - temperature intent selects `aht20_driver`
  - Chinese temperature + LED intent selects `aht20_driver`
  - display intent selects `ssd1306`
- `docs/specs/CURRENT-DECISIONS.md` defines the active agent flow:
  - understand intent
  - query board profile
  - resolve package candidates
  - fetch driver context
  - propose manifest
  - generate code
  - audit code
  - deploy through shim
  - read serial output

Safe deck wording:

- "209 indexed MicroPython package records"
- "157 generatable package records with driver context support"
- "167 GraftSense driver descriptors in the local repository"
- "MVP flow resolves hardware intent into grounded package candidates"

Unsafe deck wording:

- "MicroPython's only package manager"
- "fully autonomous production hardware"
- "all hardware can be spoken into existence"
- "BLE/self-description is the moat"

## Best Free / Low-Cost AI Research Tools

Use a mixed stack:

| Tool | Best Use | Free / Low-Cost Evidence | Link |
|---|---|---:|---|
| Tavily | agentic web search and extract | free monthly credits | https://docs.tavily.com/documentation/api-credits |
| Exa | semantic company/project discovery | free monthly API requests, startup credits possible | https://exa.ai/pricing?tab=api |
| Brave Search API | independent web index | free plan exists, often requires card | https://brave.com/search/api/ |
| Jina Reader/Search | webpage/PDF to markdown | public reader rate limit, API options | https://jina.ai/reader/ |
| SerpApi | precise Google SERP fallback | free monthly quota | https://serpapi.com/ |
| Bocha AI | Chinese search/API | China-focused AI search API | https://open.bochaai.com/ |
| Metaso | Chinese AI search | strong manual Chinese research | https://metaso.cn/about-us |
| SearXNG | self-hosted metasearch | free if self-hosted | https://docs.searxng.org/ |

Recommended workflow:

1. Exa for similar companies and founder/company discovery.
2. Tavily for broad evidence collection.
3. Jina for source extraction into markdown.
4. SerpApi only for high-precision Google result checks.
5. Bocha/Metaso for Chinese sources.

## US Market Facts Usable In Deck

Use these as channel and ecosystem evidence, not as TAM theater.

| Fact | Why It Matters | Source |
|---|---|---|
| Hackster reports 2.5M+ members and 44K+ open-source projects. | Reachable hardware developer/project community. | https://www.hackster.io/about |
| Hackster survey claims 70% working professionals, 36% hardware/software engineers, 20% launched a commercial product. | Better than pure hobbyist audience. | https://www.hackster.io/about |
| Adafruit media kit reports 3M+ monthly uniques, 8M+ pageviews/month, 16.2K orders/month, 3,590+ products, 2K+ open-source repos. | US maker channel with real commerce and content distribution. | https://cdn-shop.adafruit.com/files/media.pdf |
| Tindie reports 489K+ orders shipped and 19.9K+ products. | Long-tail indie hardware sellers exist. | https://www.tindie.com/about/ |
| Kickstarter Technology stats show 59K+ launched projects and $1.95B pledged. | Hardware launch channel exists; not proof of margin. | https://www.kickstarter.com/help/stats |
| Kickstarter Technology success rate is about 25%. | Pain/opportunity: creators need better prototype-to-launch workflows. | https://www.kickstarter.com/help/stats |
| US CTE has 11.2M students. | Education scale exists, but not first GTM. | https://careertech.org/our-vision/cte-in-your-state/ |
| US Perkins V investment cited around $1.3B. | Possible funding pool for later education bundles. | https://www.ed.gov/media/document/fy24-afr-108470.pdf |
| Arduino reports 30M+ users / thousands of companies on Arduino Pro. | Embedded creator base is large. | https://www.arduino.cc/pro/why-pro |
| Arduino open-source report says 1,198 new libraries entered Library Manager in 2024, +18% YoY. | Library/package sprawl validates package-intelligence pain. | https://blog.arduino.cc/2025/02/19/the-2024-arduino-open-source-report-is-here/ |
| Crowd Supply describes itself as a curated, full-service hardware crowdfunding/incubation platform and claims 90%+ launched-project funding success. | Stronger fit than generic Kickstarter for serious hardware creators. | https://www.crowdsupply.com/apply |

## Channel-To-Sales Model

The core correction: channel numbers do not become revenue by themselves.

Adafruit reporting 16.2K orders/month proves that there is a repeat buyer base for electronics modules. It does not prove Blockless can sell software. The deck must show a falsifiable bridge:

1. Identify the subset of buyers who repeatedly start embedded prototypes.
2. Give them a working recipe and starter kit.
3. Convert a fraction into agent users.
4. Convert repeat agent users into paid seats, metered usage, or team pilots.
5. Use each hardware run to improve package, board, and module truth.

### US Sales Path

| Stage | Action | Evidence Target | Why It Matters |
|---|---|---|---|
| Design partners | Recruit 20 startups, consultants, maker-pros, and labs. | 20 real projects attempted. | Proves the pain is not imagined. |
| Paid pilots | Convert design partners into paid pilots. | 5 paid pilots. | Proves software willingness to pay. |
| Public recipes | Publish 10 repeatable builds with BOM, code, video, and driver evidence. | 10 verified recipes. | Creates discoverable demand and trust. |
| Starter kits | Bundle hardware that makes recipes reliable. | 100 preorders. | Tests hardware as onboarding, not as the main moat. |
| Channel launch | Use Hackster, Adafruit-style tutorials, Tindie/Crowd Supply/Kickstarter creators. | 500 qualified signups and 50 active hardware runs. | Tests whether channel reach converts into actual usage. |

### What Counts As Revenue Proof

Strong proof:

- paid pilot from a consultant, startup, or lab
- repeat monthly usage on real hardware
- users sending their own projects for the agent to attempt
- kit preorder attached to agent usage
- team asking for shared projects, billing, or private package contexts

Weak proof:

- demo likes
- newsletter signups with no hardware run
- generic maker interest
- education conversations without budget owner
- "large TAM" from STEM or IoT reports

### China Sales Path

For China, the first revenue path is likely not pure SaaS. It is more likely:

1. software agent
2. starter/dev kit
3. course or workshop
4. teacher/lab support
5. recurring package, update, and service revenue

The first China customers should be:

- university labs
- FabLab / maker spaces
- robotics and AIoT courses
- competition training groups
- private STEM/innovation education organizations

Do not lead with broad public-school procurement until there is a stable course package, local support model, and proof of classroom reliability.

## China Facts Usable In Appendix

For a US seed deck, China should support supply chain and expansion, not lead the revenue story.

| Fact | Use | Source |
|---|---|---|
| China MOE 2024: 470K schools, 286.5M students, 18.85M teachers. | Shows education scale only. | https://www.moe.gov.cn/jyb_sjzl/sjzl_fztjgb/202506/t20250611_1193760.html |
| MOE guidance strengthens AI education in primary/secondary schools. | Policy tailwind, not budget proof. | https://en.moe.gov.cn/news/press_releases/202412/t20241210_1166454.html |
| China selected 184 primary/secondary AI education bases. | Pilot ecosystem signal. | https://english.www.gov.cn/news/202402/23/content_WS65d85f47c6d0868f4e8e44a7.html |
| Major China electronic information manufacturing revenue was RMB 16.19T in 2024. | Supply-chain/manufacturing context. | https://english.www.gov.cn/archive/statistics/202502/07/content_WS67a545b2c6d0868f4e8ef6c9.html |
| IFR: China represented 54% of global industrial robot deployments in 2024. | Robotics/automation demand context. | https://ifr.org/worldrobotics/report-2025 |
| Seeed helps productize prototypes from 1 to 1,000 pcs. | Shenzhen small-batch pathway. | https://wiki.seeedstudio.com/About/ |
| DFRobot reports 2,000+ products, 100+ distributors, 200+ countries/areas. | China-origin modular hardware ecosystem. | https://www.dfrobot.com/about-us |
| M5Stack reports 3M+ products sold, 400+ SKUs, 181K+ community. | Modular MicroPython/IoT ecosystem evidence. | https://m5stack.com/about-us |

Unsafe China claims:

- "China education will be easy revenue."
- "AI curriculum means immediate software budget."
- "China is the primary US VC market wedge."
- "China sourcing is risk-free."

## Competitor Map

| Category | Companies | What They Solve | Attack On Us | Rebuttal |
|---|---|---|---|---|
| AI PCB / EDA | Flux, CircuitMind, Celus, JITX | schematic, BOM, PCB, layout | "They already own AI hardware design." | They start around EDA. We start with embedded prototype execution and runtime truth. |
| Prompt-to-hardware | Schematik | code, wiring, parts, instructions | "Same idea, better funded." | Yes, validates category. Our wedge is constrained MicroPython/package intelligence + module manifests. |
| Simulation / education | Wokwi, Tinkercad, MakeCode | virtual circuits and block education | "Users can learn/build there." | They reduce learning friction; they do not solve package-grounded real deploy loops. |
| Cloud IDE / ecosystem | Arduino Cloud, M5Stack UIFlow | cloud coding, blocks, modular devices | "Incumbents can add AI." | They can. We need speed, cross-ecosystem package intelligence, and agent-first UX. |
| Component data | SnapMagic, Ultra Librarian | CAD models and footprints | "Data incumbents have the parts graph." | Their graph is EDA components; ours must become runtime/package/module truth. |

Important funding evidence:

- Schematik raised $4.6M pre-seed in April 2026, led by Lightspeed/Puzzle. Source: https://www.schematik.io/blog/schematik-raises-4-6m-pre-seed
- Flux announced $37M new funding in February 2026. Source: https://www.flux.ai/p/blog/we-raised-37m-to-take-the-hard-out-of-hardware
- JITX announced $12M Series A in 2022 led by Sequoia. Source: https://www.jitx.com/blog/series-a-announcement
- Celus announced EUR25M Series A in 2022. Source: https://7288952.fs1.hubspotusercontent-eu1.net/hubfs/7288952/Press_Release_Series_A_ENG.pdf

## Early Adopters

Ranked by likely willingness to pay:

1. Hardware startups / product studios
   - Pain: demo speed, investor/customer prototypes, firmware bring-up.
   - Why pay: time saved maps directly to fundraising and customer cycles.
   - Where to find: HAX, SOSV, Techstars hardware, YC hardware companies, Crowd Supply creators, Kickstarter hardware founders.

2. Embedded/IoT consultants and agencies
   - Pain: repeated board bring-up, driver discovery, firmware skeletons, docs.
   - Why pay: software saves billable or delivery time.
   - Where to find: LinkedIn "embedded consultant", Hackster professional users, Upwork embedded contractors, IoT product development agencies.

3. Maker-pros / indie hardware sellers
   - Pain: getting from prototype to sellable kit/project documentation.
   - Why pay: project launch and support burden.
   - Where to find: Tindie sellers, Crowd Supply creators, Hackster top project authors, Adafruit/SparkFun community authors.

4. University labs and capstone programs
   - Pain: repeated semester project setup and debugging.
   - Why pay: lab productivity and student outcomes.
   - Where to find: robotics labs, HCI/physical computing labs, mechanical/electrical capstone instructors, university makerspaces.

5. CTE/STEM educators and robotics mentors
   - Pain: lesson setup, hardware debugging, teacher support.
   - Why pay: only after curriculum and reliability exist.
   - Where to find: FIRST mentors, SkillsUSA electronics/robotics instructors, CTE directors, community college makerspaces.

## Who To Interview First

Do not start with broad consumers. Interview people with repeated hardware pain.

Minimum first 20:

- 5 hardware startup founders building connected devices.
- 5 embedded consultants / IoT agencies.
- 4 Tindie/Crowd Supply/Kickstarter maker-pro sellers.
- 3 university lab/capstone instructors.
- 3 robotics/CTE educators or mentors.

Interview script:

1. What was the last hardware prototype you built?
2. Where did the most time disappear: parts, drivers, wiring, firmware, flashing, debugging, docs, or manufacturing?
3. What did you try first: Arduino, MicroPython, CircuitPython, Wokwi, ChatGPT, forums, vendor examples?
4. Did an LLM help? Where did it fail?
5. What package/driver problem blocked you?
6. How many times per month do you start a new embedded prototype?
7. What would a tool need to do before you trust it on real hardware?
8. Would you pay $X/month or $Y/project if it saved Z hours?
9. Would you use it inside VS Code, a standalone IDE, or web?
10. Would you buy a starter kit if it made the software reliable?

Success criteria:

- At least 10/20 have repeated monthly prototype workflows.
- At least 5/20 can name a concrete paid use case.
- At least 3/20 agree to send a real project for the agent to attempt.
- At least 2/20 are willing to pay or sign LOIs after demo.

## Investor Attack Pack

**Attack: This is a maker toy.**

Answer: We are not starting with hobbyists. The first buyers are startups, consultants, maker-pros, and labs where prototype delay has a measurable cost. Hobbyists are a community channel, not the first revenue proof.

**Attack: Flux/Schematik/Celus/JITX already exist.**

Answer: Correct; that validates AI hardware tooling. Most competitors start at EDA, PCB, or generic prompt-to-instructions. Our wedge is the execution layer: package-grounded embedded firmware and real module runtime.

**Attack: Why won't Arduino or M5Stack add this?**

Answer: They can add AI features. The opportunity is to become the cross-ecosystem agent layer before any single hardware ecosystem becomes dominant. Our moat must be package intelligence, validated driver contexts, board profiles, recipes, and real failure data.

**Attack: BLE self-description is easy to copy.**

Answer: The protocol alone is not the moat. It is a data-acquisition surface. The moat is accumulated compatibility truth and working-project memory.

**Attack: Software-first revenue is unproven. Makers do not pay.**

Answer: Agreed; that is the key risk. That is why the first design partners should be consultants, startups, and labs, not broad hobbyists. The next milestone is paid pilots, not a large TAM slide.

**Attack: Education is slow.**

Answer: Agreed. Education is expansion after reliability and curriculum packaging. It should not be the first GTM claim.

**Attack: MicroPython is not production C.**

Answer: We are not claiming it replaces C for safety-critical or high-performance embedded systems. It is the right wedge for fast prototyping, education, lab automation, and many connected-device demos because it gives a faster agent loop and better recoverability.

**Attack: LLM-generated hardware can be dangerous.**

Answer: We constrain generation with package contexts, board profiles, import audits, manifests, and user approval before deploy. We should not claim autonomous safety-critical design.

## New Deck Direction

Recommended narrative:

1. AI agents changed software.
2. Hardware is blocked because the physical stack has no package/device truth.
3. Blockless grounds the agent in real packages, board profiles, and module manifests.
4. The first market is embedded prototyping, not production EDA or broad K-12.
5. Software is primary revenue; hardware is the trust/onboarding surface.
6. China supports supply chain and module velocity; US channels support early GTM.

Avoid:

- TAM theater.
- "Everyone will build hardware."
- "We invented modular hardware."
- "Hardware sales are the main venture-scale story."
- "Education procurement will be easy."

## Remaining Founder Questions

These must be answered before the deck is final:

1. What is the company/product name: Blockless, GraftSense, uPyOS, or something else?
2. What exact demo can be shown live today, and on which board/module?
3. Is the paid product a VS Code extension, standalone IDE, cloud agent, or all three?
4. What is the first pricing test: per seat, per run, per project, or team plan?
5. Which 20 design partners can be contacted this month?
6. Can ownership/control of uPyPI/GraftSense assets be shown cleanly to investors?
7. What data can be collected from demo runs: success rate, time saved, package resolution accuracy?
8. What is the legal/IP status of the 166 GraftSense-sourced records and borrowed/ported drivers?
9. What is the first hardware kit, if any, and what is its real BOM/margin?
10. What round size and use of funds should the final US seed deck include?
