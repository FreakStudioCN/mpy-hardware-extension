# Handoff

## Goal

Continue market and narrative research for Blockless / Cursor-for-hardware.

The current goal is not to write a deck. The user wants a rigorous Chinese research document that can support or reject the venture logic with data, self-critique, and a clear market narrative.

The current strongest direction is:

```text
Blockless is not a maker community story.
It is an AI-native physical prototyping tool.

AI coding made one-person software products possible.
Blockless aims to make one-person physical product prototypes possible.
```

More concretely:

```text
software prototype has been accelerated by AI
+ hardware prototype is still blocked by module choice, drivers, wiring, flashing, serial debugging, and reproducibility
+ China has the modular hardware supply-chain density
+ Blockless standardizes the software/execution layer
=> one person or a tiny team can build a working physical product prototype much faster
```

## Current Progress

Main research file:

```text
docs/research/blockless_agent_hardware_embodied_ai_research_cn_2026-06-06.md
```

Important sections already added or rewritten:

- `1.2 新逻辑：prototype-first，maker-secondary`
- `1.2.1 为什么 maker 故事单独讲不起来`
- `3.3 但这条关系必须被技术闭环证明`
- `4.5 模块 TAM 现实：美国不能只靠 hobby module 消费讲大`
- `4.6 Blockless 能占多少：不能从硬件 GMV 直接推`
- `4.7 中国和美国的模块市场不是同一种打法`
- `7.1 不要把 AppStore / Recipe 讲成 embodied AI 数据飞轮`
- `8.0 Venture 是否成立：先说负面结论`
- `8.1 成立条件：必须把中国供应链优势放进主叙事`
- `8.2 重新排序后的短期 wedge`
- `8.3 长期扩容必须依赖硬件交易或 vendor economics`
- `8.4 Prototype-first 市场到底大不大`
- `8.5 如果考虑 one-person company`
- `12. 最终研究结论`

Current conclusion:

```text
Initial wedge = prototype speed, not hobbyist module consumption.
Supply-chain advantage = China, not the U.S.
The U.S. is useful for AI-native workflow adoption, pro prototyping, fundraising narrative, and early adopter credibility.
Maker is a secondary market stimulated after prototype friction collapses.
```

## What Worked

1. Prototype-first is stronger than maker-first.

   The user rejected maker as the main story. That rejection is correct. U.S. maker module consumption is not a strong enough TAM and does not prove SaaS ARPU.

2. One-person company is closer than industrial software.

   The user clarified "OPC" meant one-person company, not industrial OPC UA. The relevant market lens is:

   ```text
   one-person software company enabled by AI coding
   -> one-person physical product prototype enabled by Blockless + China supply chain
   ```

3. Bottom-up market estimation is the right method.

   Do not lead with broad market reports. Estimate:

   ```text
   serious physical prototype builders
   x annual willingness to pay
   + prototype attempts x usage/project
   + BOM/kit GMV x margin/take
   + module/kit vendors x verified recipe/support-reduction ACV
   ```

4. AppStore / recipe has value only as reproducibility and distribution infrastructure.

   It should not be framed as marketplace take-rate or embodied AI training data.

5. Technical support from the repo is real.

   Useful local proof points:

   - `docs/product/core.md`: natural language -> package/driver -> code -> local `mpremote` run/debug -> serial output -> fix loop.
   - `docs/product/appstore.md`: uPyPI, uPyOS, `.mpk`, `app_index.json`, `hardware_tags`, device profiles, app install/update.
   - `docs/specs/CURRENT-DECISIONS.md`: product boundary, board profiles, driver contexts, code audit, package intelligence, session flow.
   - `mpyhw-api/content/packages/driver_context/*.json`: machine-readable driver context with imports, constructors, examples, install method, pin roles.
   - `mpyhw-api/app/analytics.py`: telemetry events such as `package_resolved`, `driver_context_loaded`, `flash_finished`, `serial_marker_seen`, `runtime_error`, `repair_exhausted`.

## What Did Not Work

1. "U.S. maker market is large" does not hold.

   Public evidence shows community activity, tutorials, and module buying, but not a large software TAM.

2. U.S. hobby module TAM is probably weaker than U.S. educational robot market.

   Narrow maker module commerce is likely low hundreds of millions or less. U.S. educational robot market has clearer reported numbers, but the buyer and use case are wrong for Blockless.

3. Embodied AI cannot be the main market bridge.

   Do not say recipe data is embodied AI data. Open X-Embodiment-style data is robot embodiment, action trajectories, perception, task outcomes, and policy learning. Blockless recipe data is board/module/driver/pin/firmware/run-log compatibility data.

4. "Small embodied device" is bad language.

   The user disliked it and it sounds toy-like. Avoid this phrase.

5. Industrial software / product engineering services are too far as direct markets.

   They can prove engineering/time-to-market budgets exist, but they are too broad and too enterprise-heavy to be the near-term market.

6. Do not write deck copy unless explicitly asked.

   The user repeatedly asked for research, not deck writing.

## Current Market Estimation Frame

Use a bottom-up model:

```text
Revenue pool =
serious builders x $300-$800/year
+ prototype attempts x $20-$200/project
+ BOM/kit GMV x 5%-20% margin/take
+ vendors x $5K-$50K/year
```

Suggested scenarios:

| Scenario | Assumption | Annual revenue pool |
|---|---|---:|
| Conservative | 20K-50K serious builders, around $300/year ARPA | $6M-$15M software ARR pool |
| Base | 100K-250K builders, $300-$800 ARPA, plus some kit/vendor revenue | $50M-$250M revenue pool |
| Aggressive | AI makes 500K-1M people/tiny teams attempt physical product prototypes, with BOM/kit/vendor economics attached | $300M-$1B+ revenue pool |

Important: the aggressive case requires Blockless to expand beyond code generation into:

```text
prototype -> verified recipe -> BOM -> kit -> small-batch fulfillment
```

## Useful Sources Already Used

Market / community / bottom-up proxies:

- Kickstarter stats: https://www.kickstarter.com/help/stats/
- BackerBench Technology category: https://backerbench.com/benchmark/tech
- Shopify 2024 10-K: https://s27.q4cdn.com/572064924/files/doc_financials/2024/q4/SHOP-10K-Q4-2024.pdf
- Shopify stats proxy: https://www.demandsage.com/shopify-statistics/
- Hackster about: https://www.hackster.io/about
- Adafruit media overview: https://cdn-shop.adafruit.com/files/media.pdf
- Raspberry Pi investor reports: https://investors.raspberrypi.com/reports
- Raspberry Pi FY2025 results: https://www.investegate.co.uk/announcement/rns/raspberry-pi-holdings-wi---rpi/fy-2025-results/9499135
- SparkFun online sales estimate: https://gripsintelligence.com/insights/retailers/sparkfun.com

AI agent / hardware toolchain:

- Espressif ESP-IDF Tools MCP: https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/
- Espressif Claude hardware interface news: https://www.espressif.com/en/node/10695
- Espressif ESP-IoT-Solution MCP docs: https://docs.espressif.com/projects/esp-iot-solution/en/latest/ai/mcp.html
- Arduino Cloud AI Assistant / Claude: https://blog.arduino.cc/2025/06/26/why-we-chose-claude-for-the-arduino-cloud-ai-assistant/
- Skilled AI Agents for Embedded and IoT Systems Development: https://arxiv.org/abs/2603.19583

Adjacent markets, use cautiously:

- Product engineering services: https://www.grandviewresearch.com/industry-analysis/product-engineering-services-market-report
- Industrial software market / IoT Analytics: https://iot-analytics.com/wp-content/uploads/2024/12/INSIGHTS-RELEASE-The-industrial-software-market-landscape-7-key-statistics-going-into-2025.pdf
- IoT professional services proxy: https://www.psmarketresearch.com/market-analysis/iot-professional-services-market
- 3D printing prototyping application proxy: https://www.bccresearch.com/public/RedactedRO/MFG074C.pdf

## Next Steps

1. Tighten the one-person physical product prototype market estimate.

   Find better data for:

   - number of hardware/electronics Kickstarter/Indiegogo technology projects per year;
   - number of hardware creators using Shopify/Amazon/TikTok Shop/Kickstarter;
   - number of embedded/IoT freelancers or consultants;
   - module/kit vendor count and likely ACV for verified recipes/support reduction;
   - typical prototype agency/consultant project cost, to quantify time savings.

2. Build a bottom-up TAM/SAM/SOM table.

   Suggested rows:

   - serious one-person physical product builders;
   - AI hardware/AIoT prototype teams;
   - hardware startup prototypes;
   - module/kit vendors;
   - workshops/applied hardware courses;
   - embedded/IoT consultants.

3. Define Blockless' capture layers.

   Suggested layers:

   - software seats / usage credits;
   - project credits;
   - verified recipe/vendor SaaS;
   - BOM/kit attach margin;
   - small-batch/fulfillment partner take-rate.

4. Add a "venture成立/不成立" test.

   Strong version:

   ```text
   If Blockless reduces first working hardware prototype time by 5-10x and connects recipes to BOM/kit/vendor economics, venture can be argued.
   ```

   Weak version:

   ```text
   If Blockless remains a MicroPython code generator for U.S. hobby makers, venture does not hold.
   ```

5. Keep the tone self-critical.

   The user values direct pushback. Avoid optimism without evidence. Explicitly label:

   - what the data proves;
   - what it cannot prove;
   - what must be validated by product metrics.

