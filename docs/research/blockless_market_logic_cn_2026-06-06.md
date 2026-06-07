# Blockless 市场逻辑中文修正版

> 日期：2026-06-06  
> 用途：重写 pitch deck 市场页和 GTM 逻辑  
> 结论：不能把“美国 maker 今天的直接软件付费”当成已经被证明的大市场；但 maker 已经在为模块、板子、教程、工具和时间付费，这说明 latent demand 存在。真正的大故事是：AI agent 如果能快速接入真实硬件，就能把硬件 creation 像软件 vibe coding 一样扩容。中国 AIoT / 创客空间 / 模块厂商 / embodied AI 原型生态更适合作为动态增长市场。

## 1. 核心判断

原来把市场分成：

```text
Motion A: paid prototype acceleration
Motion B: maker/community recipe distribution
Motion C: China AIoT / maker-space / embodied-AI prototyping
```

这个结构仍然有问题。**Motion B 不应该作为今天已经被证明的独立收入 motion。**

原因很简单：

```text
美国 maker 社区有影响力，但公开证据不足以证明它今天有足够大的直接软件付费市场。
Tindie / Hackster / Arduino Project Hub 这类数据只能证明分发和社区存在，
不能证明 Blockless 可以立刻从美国 maker 人群拿到足够大的软件收入。
```

更正确的结构应该是：

```text
Motion A: 美国 paid prototyping
Motion B: 中国 AIoT / 创客空间 / 模块厂商 / embodied AI 原型生态
Product Loop: AppStore / recipe / community distribution
```

也就是说：

- 美国 maker 不是今天的第一收入市场。
- AppStore 不是一个独立 GTM motion。
- AppStore 是产品增长机制：把一次成功硬件运行变成可 fork、可复现、可二次开发的 recipe。
- 中国市场才更像动态增长市场，因为硬件供应链、模块生态、创客空间、AI 教育硬件、机器人/具身智能原型需求同时存在。
- 但美国 maker / creator 不是弱故事。它是未来品类故事的入口：他们已经愿意买模块、买板子、看教程、花周末时间 debug；如果 AI agent 能把 imagination 直接接到硬件执行，这个市场可能被重新定义。

## 2. 为什么不能把美国 Maker 当成“已证明市场”

这不是说美国 maker 没价值，也不是说未来不能变大。更准确地说：**公开证据不足以证明它今天就是一个可独立支撑 VC 市场页的收入池。**

美国 maker 市场有三个现实问题：

1. **静态软件 ARPU 未被证明**
   - 大量 hobbyist 愿意买模块、买板子、看教程，这不是坏信号，而是 latent demand：用户已经愿意为 physical creation 付钱和付时间。
   - 但这还不能直接推出他们会为一个普通软件工具持续订阅。
   - 如果产品只是 “AI 帮我写一个 Arduino / MicroPython demo”，很容易变成一次性使用。
   - 如果产品能让 AI agent 识别硬件、生成代码、烧录、读日志、修复、再运行，它就不是教程工具，而是硬件 creation runtime。

2. **市场碎片化**
   - Maker 内容分布在 YouTube、Hackster、Instructables、Arduino Project Hub、Adafruit Learn、Reddit、Discord、个人博客。
   - 分发强，但付费闭环弱。

3. **Tindie 体量太小**
   - Tindie 报告 489K+ orders 和 19.9K+ products，只能说明 indie hardware commerce 存在。
   - 这不是一个足够强的美国软件市场锚点。
   - 它更适合作为 “maker-pro / 小批量硬件卖家存在” 的证据，而不是 TAM 证据。

所以美国 maker 不能用静态 TAM 这样讲：

```text
很多 maker 买模块，所以 Blockless 有大市场。
```

应该改成：

```text
美国 maker 社区可以贡献 recipe、SEO、早期用户和兼容性数据，
并可能随着 AI 降低门槛而扩容；
但今天不能只靠 Tindie/Hackster 证明它已经是第一收入市场。
```

更强的讲法是：

```text
美国 maker 不是已证明的软件订阅市场，
但它是已证明的 physical creation intent market：
人们已经买模块、买板子、看教程、尝试项目、忍受 debug。
Blockless 要验证的是：AI agent 接入硬件后，能不能把这个 intent 转成高频 creation workflow。
```

## 3. Schematik 是怎么讲故事的

Schematik 的故事不是：

```text
美国 maker 今天已经有巨大软件 ARPU，所以我们卖给 maker。
```

它更像是：

```text
软件开发已经被 Lovable / Claude Code / Cursor 改变了。
AI 让非专业用户也能把 idea 变成软件。
硬件还停留在旧工作流：选元件、读 datasheet、接线、写 firmware、烧录、debug。
现在 AI 足够好，可以生成 firmware、验证 wiring、推理电子元件关系。
所以硬件也会迎来自己的 Cursor / Lovable moment。
```

Schematik 官方公告里几个关键信号：

- 标题直接说 “Help Anyone Build Hardware With AI”。
- 它把自己放在 Lovable / Claude Code 之后，强调软件 creation 门槛已经下降，但 hardware 仍然很难。
- 产品输出不是单纯代码，而是 code、wiring diagrams、component list、assembly instructions。
- 它说第一个视频有 millions of views，thousands of people started building，说明它用早期社区 pull 证明“latent demand”，不是用传统 maker spend TAM 证明。
- 投资人阵容来自 robotics、AI、electronics，说明它讲的是 “AI-native hardware creation category”，不是普通 maker marketplace。

所以 Schematik 的市场页本质是未来范式迁移：

```text
From software vibe coding -> hardware vibe building.
```

这个故事可以讲，而且对 Blockless 有利。

## 4. Blockless 能不能讲未来故事

可以，但要分清两层：

```text
Short-term wedge: 谁今天会付钱？
Future category: AI 会不会把硬件 creation 人群扩大 10x？
```

只讲 future category，会虚。  
只讲今天的 paid prototyping，又会显得市场不够性感。

更好的组合是：

```text
Today: paid prototype acceleration proves willingness to pay.
Tomorrow: AI-native hardware creation expands the number of builders.
Blockless captures this expansion through runnable recipes, module intelligence,
and real-device feedback.
```

类比 vibe coding 是合理的。因为 vibe coding 工具早期也不是从一个清晰传统预算池里长出来的，而是先证明：

- creation barrier 下降；
- 非专业或半专业用户开始创建以前不会创建的东西；
- 一次性 demo 逐渐变成反复使用的 workflow；
- 工具从 toy-like demos 进入 serious work。

硬件也可以有类似路径，但约束更强：

- 软件错了只是 crash；
- 硬件错了可能烧板、短路、接线错误、浪费物料；
- 所以 Blockless 的未来故事不能只是 “prompt to hardware”，必须是 “grounded, rerunnable, physically validated hardware creation”。

这也是 Blockless 可以区别于普通 Schematik 叙事的地方。

## 5. 关键新判断：不是 Maker 教程市场，是 Agent-to-Hardware 市场

你说的 “完全开放想象力” 是更好的市场语言。

硬件 maker 的真实阻塞不是没有消费意愿，也不是没有想法，而是：

```text
imagination -> parts -> wiring -> firmware -> flash -> logs -> debug -> working object
```

这条链太长，所以很多需求没有变成市场。

如果 Blockless 让 AI agent 迅速接入硬件，链条会变成：

```text
imagination -> agent sees hardware context -> generate/run -> observe logs ->
repair -> publish runnable recipe
```

这会把 Blockless 从 “AI maker tool” 提升成：

```text
agent-to-hardware execution layer
```

这个定位比 “maker 市场够不够大” 更强。因为它回答的是未来品类问题：

```text
当 AI agent 能操作真实硬件时，会不会出现一波新的 physical apps / gadgets / robots / AIoT creations？
```

这和 vibe coding 的类比更准确：

- vibe coding 不是把已有 IDE 市场切一块，而是让更多人开始做软件。
- Blockless 也不应该只说切已有 maker 软件市场，而是让更多人开始做硬件。
- 买模块、买板子、看教程说明用户已经有物理创造冲动。
- agent-to-hardware 把这个冲动转成可执行 loop。

但这个故事必须绑定可靠性，否则会被投资人打：

```text
Prompt-to-hardware is exciting but dangerous.
Agent-to-hardware needs grounding: board profiles, module manifests,
driver versions, wiring/pins, deploy logs, run evidence, and safety boundaries.
```

## 6. 推荐的新叙事

不要说：

```text
美国 maker 市场不够，所以只能去中国。
```

这太悲观，也太静态。

应该说：

```text
The current paid wedge is prototype acceleration.
The future market is AI-native hardware creation.
Maker communities are not just today's ARPU pool;
they are evidence of physical creation intent and the top of funnel for a larger category AI may create.
China accelerates this because it has dense module supply, maker spaces,
AI hardware demand, and embodied-AI prototyping activity.
Blockless is the agent-to-hardware execution layer that makes imagination runnable.
```

中文：

```text
今天的付费切口是原型加速。
未来的大市场是 AI-native hardware creation。
Maker 社区不是今天已经被证明的主要软件收入池，而是 physical creation intent 的证据和未来品类扩容的入口。
中国会加速这个未来，因为它同时有模块供应链、创客空间、AI 硬件消费和具身智能原型活动。
Blockless 是让 AI agent 接入真实硬件、把想象力变成可运行对象的执行层。
```

## 7. 美国市场应该怎么讲

美国不能用中国 “AI 教育智能硬件 RMB 1000 亿” 的同构数据来讲。美国的强证据不是教育硬件消费，而是：

```text
AI agent 正在进入硬件开发工具链
+ embodied AI / physical AI 正在获得资本和技术验证
+ 美国 paid prototyping / IoT / robotics 有预算
+ STEM / educational robotics 说明硬件学习和机器人 kit 也在增长
```

所以美国市场不是空的，只是证据结构不同。

### 7.1 美国核心证据：AI Agent 正在接入硬件

这层必须放进 deck，因为它直接支撑 Blockless 的核心叙事。

可用证据：

- Espressif ESP-IDF Tools Local MCP Server 已经让 Cursor / Claude Code 这类 AI client 控制 ESP-IDF 项目：set target、build、flash、check status。
- Espressif 文档明确说 Documentation MCP + Tools MCP 形成完整 AI-assisted loop：查官方文档、改代码、build、flash。
- Espressif 的 ESP-IoT-Solution MCP 文档已经支持 ESP32 / ESP32-C3 / ESP32-C6 / ESP32-S3，并提供在 ESP32 上跑 MCP server、暴露 JSON-RPC tools 控制设备状态的例子。
- Anthropic Build with Claude 展示 M5Stack Cardputer / M5StickC Plus 作为 Claude hardware interface reference hardware，通过 BLE 和 Claude Desktop 交互。
- Arduino Cloud AI Assistant 用 Claude + RAG，基于 sketch、board、use case 提供 Arduino-specific context，目标是减少 hallucinated / misleading code。
- 2026 论文 `Skilled AI Agents for Embedded and IoT Systems Development` 用真实硬件执行验证 agent，在 3 个 embedded platforms、23 个 peripherals、42 个 tasks 上做了 378 次 hardware-validated experiments。

这说明一件事：

```text
AI agent 接入硬件不是想象，已经发生。
但现在的能力是碎片化的：文档、build、flash、设备 tool、日志、recipe、兼容性数据还没有统一成一个产品层。
Blockless 的机会就是把这些碎片变成 agent-to-hardware execution layer。
```

### 7.2 美国未来品类证据：Embodied AI / Physical AI

你说的 embodied AI 必须在美国叙事里出现。因为这才解释 “为什么 agent + hardware 会变成大市场”，而不只是一个 embedded devtool。

可用证据：

- Figure 在 2024 年宣布 $675M Series B、$2.6B valuation，投资方包括 Microsoft、OpenAI Startup Fund、NVIDIA、Jeff Bezos、Intel Capital 等，并与 OpenAI 合作开发 humanoid robot 的下一代 AI models。Figure 明确使用 “embodied AI” 语言。
- Skild AI 在 2024 年宣布 $300M Series A、$1.5B valuation，目标是 building a scalable AI foundation model for robotics，并强调 intelligence grounded in the physical world。
- Physical Intelligence 在 2024 年获得 $400M 融资，公开叙事是 general-purpose AI / foundation models for robotics，把 AI 带入 physical world。
- FieldAI 在 2025 年宣布累计 $405M 融资，定位是 physical AI / robotic autonomy，并说其 Field Foundation Models 是为 embodied intelligence 构建的 physics-first foundation models。
- Covariant RFM-1 用 robotics foundation model 让机器人和 human operators / engineers 用自然语言沟通，降低 customizing robot behavior 的门槛。

这些证据说明：

```text
Embodied AI is becoming an investable category.
The bottleneck is no longer only "can AI reason?"
The bottleneck is "can AI reliably act through real hardware?"
```

Blockless 不直接卖 humanoid robot，也不应该声称吃掉 humanoid TAM。更稳的说法是：

```text
Embodied AI increases demand for sensor/actuator/camera/controller prototypes.
Every embodied AI idea needs a loop from intent -> hardware context -> code -> run -> observe -> repair.
Blockless provides this lower-level agent-to-hardware execution loop.
```

### 7.3 美国收入证据：Paid Prototyping / IoT / Robotics

美国市场保留一个硬逻辑：

```text
Paid prototype acceleration
```

目标人群：

- embedded / IoT consultants
- hardware startups
- product studios
- serious creators building investor/customer demos

他们不是在买 “maker 工具”，而是在买：

- 更快 bring-up
- 更少 driver / pin / wiring 错误
- 更快 demo
- 更低交付风险
- 可复现的 prototype package

证据逻辑：

- Clutch 上 US IoT company 数量和 IoT POC / firmware / prototype 项目预算说明，美国有付费原型开发市场。
- Upwork / BLS 工程师工资说明时间节省可以换算成明确价值。
- GitHub Copilot 付费用户说明 developer workflow acceleration 可以收费。
- IFR World Robotics 2025 Americas 报告显示，2024 年美国有 393,700 台工业机器人在工厂运行，年安装量 34,200 台；美国是全球第三大 industrial robot operational stock 市场，仅次于中国和日本。
- 同一 IFR 报告说，美国长期受益于 reshoring production 和 labor scarcity，robotics 市场 2025 年及以后预期增长。

美国市场 slide 不应该强调 maker TAM，而应该强调：

```text
Hardware prototyping is paid work.
The bottleneck is not imagination.
The bottleneck is making real boards, modules, drivers, pins, firmware, flashing,
logs, and reproducible recipes work together.
Blockless lets AI agents enter that loop.
```

### 7.4 美国辅助证据：Educational Robotics / STEM Hardware

美国也有教育机器人和 STEM hardware 需求，但这不应该作为主市场。

可用数据：

- Grand View Research 的 U.S. educational robot market 数据显示：2024 年美国 educational robot revenue 为 USD 416.3M，2030 年预计 USD 1.6575B，2025-2030 CAGR 27.5%。
- 这说明美国也有 “孩子/学校/家庭愿意为机器人和 STEM hardware 付费” 的趋势。
- 但它比中国教育智能硬件叙事更窄，且仍然有 school procurement / curriculum / support 问题，所以只作为辅助证据。

美国市场页建议不要说：

```text
美国教育硬件市场很大，所以 Blockless 很大。
```

要说：

```text
美国有 AI agent 工具链、paid prototyping、robotics automation、STEM robotics demand。
这些共同说明：agent + hardware 的市场拐点正在出现。
```

## 8. 中国市场为什么更值得重新考虑

中国不是因为 “学校多” 而值得讲。学校/lab/capstone 仍然不作为主市场。

中国值得讲，是因为它有一个美国没有那么密集的动态结构：

```text
低成本模块供应链
+ 创客空间 / 众创空间 / 硬科技孵化
+ AI 教育硬件消费
+ AIoT / robotics / embodied AI 原型热
+ 本地 workshop / kit / vendor support 场景
```

这更像 Blockless 的土壤。

### 8.1 模块和 AIoT 生态

M5Stack 官方数据：

- 3M+ products sold globally
- 400+ SKUs
- 181K+ maker & developer community
- 660K+ UIFlow code downloads
- 50+ distributors
- 110+ countries coverage

这说明中国出来的模块化硬件公司已经把 “模块 + 软件 + 社区 + 分发” 做成了一个真实生态。

Seeed 2024 year-in-review 也明确围绕：

- AI sensing
- edge AI
- local LLM
- robotics
- TinyML
- Home Assistant
- Jetson / vision / robotics demos
- maker/developer programs

这比美国纯 maker 社区更接近 Blockless：用户不是只做玩具，而是在快速拼 AIoT / edge AI / robotics 原型。

### 8.2 创客空间 / 众创空间是经济基础设施

中国的众创空间不只是 hobby hackerspace。

中国科技统计年鉴和火炬统计年鉴把众创空间作为统计对象，包含：

- 空间数量
- 面积
- 常驻团队和企业
- 服务创业团队
- 初创企业
- 融资
- 就业
- 知识产权

北京 2024 年报道显示：

- 北京有各类孵化器和众创空间 500+ 家。
- 孵化器参与投资基金超过 RMB 300 亿。
- 政策方向强调硬科技孵化、成果转化和产业链协同。

这和美国 maker community 不一样。中国的 maker-space / incubator 更可能连接：

- workshop
- kit package
- module vendor
- startup prototype
- local manufacturing
- training / showcase / demo day

### 8.3 AI 教育硬件说明硬件+AI 付费意愿

这里要谨慎：AI 教育硬件不是 Blockless TAM。

但它说明中国用户和渠道已经接受：

```text
AI + hardware + software/content/service package
```

相关数据：

- 多鲸教育研究院报告摘要称，2024 中国教育智能硬件市场规模预计突破 RMB 1000 亿，其中 C 端超 RMB 800 亿，B 端超 RMB 200 亿。
- RUNTO 数据显示，2024 中国学习平板销量 592.3 万台，销售额 RMB 190.6 亿，销量同比 +25.5%，销售额同比 +37.6%。

Blockless 不应该说 “我们卖给学校”。  
应该说：

```text
中国已经有 AI 硬件消费和软硬结合付费习惯。
Blockless 切的是更上游的 AIoT / robotics prototype creation workflow。
```

### 8.4 Embodied AI 增加原型需求

具身智能现在还不是成熟商业市场，但它会增加原型活动。

可用证据：

- IFR 报告称，2024 全球工业机器人安装量 542K 台，中国安装 295K 台，且中国在 top five markets 中唯一增长，+7%。
- AP 2026 报道引用 MIIT 数据：中国 2025 年有 140+ humanoid robot manufacturers 和 330+ models。
- 同一篇 AP 报道也提醒：humanoid use cases 仍然有限，需求和商业化还不成熟。

这个结论很关键：

```text
不要说 Blockless 直接吃 humanoid robot 大市场。
要说 embodied AI 热潮增加传感器、执行器、摄像头、控制器、边缘 AI 原型数量。
Blockless 站在这些 prototype workflow 的工具层。
```

## 9. AppStore 应该怎么定位

AppStore 不是一个 marketplace revenue story。

它应该被定位为：

```text
recipe distribution + compatibility graph + rerun evidence
```

每个 recipe 必须包含：

- BOM
- board profile
- module manifest
- driver / package versions
- wiring / pins
- generated code
- deploy target
- run logs
- known failures
- compatibility notes

如果没有这些，它就只是普通教程社区。

AppStore 解决的是：

```text
一个硬件项目不再停留在视频、博客、GitHub repo。
它可以被 fork、匹配用户硬件、重新生成、推送到设备、记录运行结果。
```

这对美国和中国都有价值，但它不是独立市场。

更准确地说，AppStore 是 agent-to-hardware 的记忆层：

```text
每一次成功或失败的真实运行，都会沉淀成 agent 下次能用的硬件事实。
```

## 10. 新的市场叙事

建议 deck 里这样讲：

```text
Software developers proved they pay for AI workflow acceleration.
Hardware prototyping is still stuck in board/module/driver/pin/firmware/deploy mismatch.
Blockless starts with paid prototype acceleration,
rides the AI-native hardware creation wave,
and expands through China AIoT / maker-space / module-vendor / embodied-AI prototype ecosystems,
using AppStore recipes as the distribution and compatibility-data loop.
The product is the agent-to-hardware execution layer.
```

中文版本：

```text
软件开发者已经证明：AI 工作流加速可以收费。
硬件原型的问题不是没有想法，而是板卡、模块、驱动、引脚、固件、烧录和日志无法可靠对齐。
Blockless 先用付费原型开发证明价值，
再抓住 AI-native hardware creation 的未来品类机会，
进入中国 AIoT、创客空间、模块厂商和具身智能原型生态，
用 AppStore recipe 形成分发和兼容性数据闭环。
产品本质是 agent-to-hardware execution layer。
```

## 11. Slide 9-12 建议

### Slide 9: Market Is Paid Prototype Workflow, Not Maker TAM

不要说：

```text
There are millions of makers.
```

要说：

```text
Hardware prototyping is already paid work.
AI is expanding who can create hardware,
but real-device execution is still broken.
Blockless lets AI agents execute, observe, and repair on real devices.
```

可用 proof points：

- Espressif MCP: AI clients can build/flash/check ESP-IDF projects; AI agents are entering hardware toolchains.
- Anthropic + Espressif: M5Stack/ESP32 reference hardware for Claude hardware interface.
- Hardware-validated agent research: embedded/IoT agents tested on real hardware across platforms/peripherals/tasks.
- Figure / Skild / Physical Intelligence / FieldAI / Covariant: embodied AI and robotics foundation models are now fundable categories.
- GitHub Copilot paid subscribers: developer workflow acceleration is monetizable.
- Clutch US IoT companies: prototype / firmware / IoT work has budget.
- IFR Americas: 393.7K industrial robots working in US factories in 2024; 34.2K annual installations.
- U.S. educational robot market: USD 416.3M revenue in 2024, projected USD 1.6575B by 2030.
- M5Stack / Seeed: modular AIoT hardware ecosystems are active.
- China robotics / AI hardware: AI+hardware prototype demand is rising.
- Schematik: VC-backed proof that "Cursor for hardware" is now a fundable category.

### Slide 10: Workflow Bottleneck

```text
intent -> board/module choice -> driver/package search -> wiring/pins ->
firmware -> flash -> serial logs -> debug -> reproducible recipe
```

核心句：

```text
LLMs can write code.
They cannot reliably make code match real hardware context.
```

### Slide 11: GTM Motions

```text
1. US paid prototype acceleration
2. Embodied AI / physical AI prototype demand
3. China AIoT / maker-space / module-vendor / embodied-AI prototype ecosystem
4. AppStore recipe loop as product memory/distribution mechanism
5. Maker/creator community as imagination and recipe supply, not today's proven revenue pool
```

不要把 “US maker” 单独放成第二市场。

### Slide 12: Validation Metrics

不要用：

- maker likes
- Hackster views
- Tindie product count
- school logos
- generic community signups

用：

- paid prototype pilots
- time saved per real hardware task
- successful recipe reruns
- repeat agent runs
- agent hardware loop success rate
- module/kit attach rate
- vendor support-ticket reduction
- workshop package revenue
- China maker-space/vendor paid pilot

## 12. 最终结论

最强版本：

```text
美国 paid prototype acceleration 负责证明今天有人付费。
Schematik 证明 "Cursor for hardware" / AI-native hardware creation 已经是可融资未来品类。
Maker 买模块、买板子、看教程，证明 physical creation intent 存在；Blockless 要证明 agent 接入硬件后，这个 intent 能变成高频 workflow。
中国市场负责证明动态增长：AIoT、创客空间、模块供应链、具身智能原型需求。
AppStore 不负责证明市场规模，它负责把一次成功运行变成可复现、可分发、可学习的数据资产。
Blockless 的最终定位不是教程社区，而是 agent-to-hardware execution layer。
```

最弱版本：

```text
美国有很多 maker，所以今天市场已经很大。
```

不要用弱版本。

## 13. Sources

- Schematik pre-seed announcement: https://www.schematik.io/blog/schematik-raises-4-6m-pre-seed
- Espressif ESP-IDF Tools Local MCP Server: https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/
- Espressif Anthropic Claude hardware interface news: https://www.espressif.com/en/node/10695
- Espressif ESP-IoT-Solution MCP documentation: https://docs.espressif.com/projects/esp-iot-solution/en/latest/ai/mcp.html
- Arduino Cloud AI Assistant / Claude: https://blog.arduino.cc/2025/06/26/why-we-chose-claude-for-the-arduino-cloud-ai-assistant/
- Skilled AI Agents for Embedded and IoT Systems Development: https://arxiv.org/abs/2603.19583
- Figure AI $675M / OpenAI collaboration: https://www.prnewswire.com/news-releases/figure-raises-675m-at-2-6b-valuation-and-signs-collaboration-agreement-with-openai-302074897.html
- Skild AI $300M Series A / robotics foundation model: https://www.skild.ai/blogs/announcing-our-300m-series-a
- Physical Intelligence $400M / robotics foundation models: https://www.cnbc.com/2024/11/04/jeff-bezos-and-openai-invest-in-robot-startup-physical-intelligence.html
- FieldAI physical AI / embodied intelligence funding: https://www.fieldai.com/news/fieldai-announces-over-400m-in-funds-raised-to-advance-embodied-ai-at-scale
- Covariant RFM-1 robotics foundation model: https://covariant.ai/insights/rfm-1-allowing-robots-and-people-to-communicate-in-natural-language/
- IFR World Robotics 2025 Americas / US robot deployment: https://ifr.org/downloads/press_docs/2025-09-25-IFR_press_release_Americas_in_English.pdf
- U.S. educational robot market size: https://www.grandviewresearch.com/horizon/outlook/educational-robot-market/united-states
- M5Stack about / ecosystem stats: https://m5stack.com/about-us
- Seeed Studio 2024 year in review: https://www.seeedstudio.com/blog/2025/01/03/seeed-studio-2024-year-in-review/
- China Science and Technology Statistical Yearbook makerspace table: https://www.tjnj.net/navipage-n3025011009000235.html
- China Torch Statistical Yearbook national makerspace operating table: https://www.tjnj.net/navipage-n3025030701000157.html
- Beijing incubator/makerspace hard-tech ecosystem: https://www.chinanews.com.cn/cj/2024/04-16/10200042.shtml
- Duojing 2024 China education intelligent hardware report summary: https://www.djcapital.net/nd.jsp?id=988
- Sina / RUNTO 2024 China learning tablet sales: https://finance.sina.com.cn/tech/roll/2025-01-22/doc-inefvuvx6989660.shtml
- IFR 2025 president report / World Robotics 2024 installation summary: https://ifr.org/ifr-press-releases/news/presidents-report-by-takayuki-ito-3-2025
- AP News China humanoid robot demand analysis: https://apnews.com/article/china-humanoid-robots-ai-demand-7d542b5ee92caa9d79efa28de89afbbe
- Clutch US IoT companies: https://clutch.co/us/developers/internet-of-things
- GitHub Copilot plans/pricing: https://github.com/features/copilot/plans
- Tindie about: https://www.tindie.com/about/
