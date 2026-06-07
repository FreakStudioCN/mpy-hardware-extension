# Blockless: AI Agent + Hardware + Embodied AI 市场研究报告

> 日期：2026-06-06  
> 目的：补充市场数据和逻辑链，不写 deck 话术。  
> 核心问题：Blockless 的市场到底是不是 maker？美国有没有数据？中国数据如何使用？AI agent 和 embodied AI 如何串到硬件执行层？

## 0. 一句话结论

Blockless 不应该被定义成 “maker 教程工具” 或 “硬件版 ChatGPT”。

更强的市场定义是：

```text
AI-native physical prototyping tool backed by modular hardware supply chain.
```

也就是说：

```text
软件 prototype 已经被 AI 加速。
硬件 prototype 仍然慢在选模块、driver、接线、烧录、串口调试和复现。
中国模块供应链能提供低成本、高密度、快速组合的硬件底座。
Blockless 要做的是把 intent -> hardware context -> code -> run -> observe -> repair -> recipe 这条链压短。
Maker 是被这个工具刺激出来的长期增量，不是今天的主 TAM。
```

关键不是证明 “今天美国 maker SaaS ARPU 已经很大”。  
关键是证明：

1. 真实硬件 prototype 仍然很慢，慢在选板、选模块、driver、接线、烧录、串口调试和复现。
2. AI agent 接入硬件工具链已经发生，说明 prototype workflow 可以被 agent 化。
3. 中国模块供应链能提供低成本、高密度、快速组合的硬件基础。
4. Blockless 的主价值是把 physical prototype 从天/周级压到分钟/小时级。
5. Maker 不是今天的主 TAM，而是被低摩擦 prototype 工具刺激出来的长期增量。

## 1. 逻辑链总览

### 1.1 旧逻辑的问题

弱逻辑：

```text
很多 maker 买模块 / 看教程 / 发项目
=> maker 市场很大
=> Blockless 市场很大
```

问题：

- maker 社区活跃不等于高软件 ARPU。
- Tindie / Hackster / Adafruit / Arduino Project Hub 证明的是社区、分发、购买行为，不直接证明软件订阅市场。
- 只讲 maker 会被质疑为 hobby toy。

### 1.2 新逻辑：prototype-first，maker-secondary

强逻辑：

```text
software prototype 已经被 AI 大幅加速
+ hardware prototype 仍然被模块、driver、接线、烧录、调试、复现卡住
+ 中国模块供应链提供高密度、低成本、快速组合的硬件底座
+ AI agents 正在进入 hardware toolchain
=> 会出现 AI-native hardware prototyping workflow
=> Blockless 是光速 physical prototype 工具
```

这里 maker 不是 “今天的收入池”，而是被工具刺激出来的二级市场。

更准确地说：

```text
先服务愿意为 prototype speed 付费的人；
再用 recipe / AppStore / content 把成功项目扩散到 maker。
```

这和 vibe coding 更接近：不是因为原来 indie maker 市场已经巨大，而是因为工具把“想做东西的人”变多了。但硬件比软件多了一个供应链变量，所以 Blockless 必须把中国模块供应链放进主叙事。

### 1.2.1 为什么 maker 故事单独讲不起来

maker 单独讲不起来，不是因为 maker 没价值，而是因为它不能作为初期商业证明：

- casual maker 的付费密度低；
- 美国模块 TAM 不够硬；
- 项目成功受物料、接线、driver、物流、耐心影响；
- 社区热度不等于 repeat paid usage；
- AppStore 分发不能自动解决硬件供应链。

所以 maker 应该从 “市场主角” 降级成：

```text
被 prototype tool 激发的内容/传播/长尾需求池。
```

短期商业主角应该是：

```text
hardware startups
AI hardware / AIoT prototype teams
module vendors
kit makers
workshops / applied hardware courses
embedded consultants
robotics demo builders
```

这些人不是为了好玩买模块，而是为了更快做出可展示、可复现、可交付的 prototype。

### 1.3 必须先定义清楚：什么叫 AI agent + hardware 产品

你说的 AI agent 不是单独的软件 agent，也不是一个普通硬件 kit。

这里的产品形态应该定义成：

```text
AI agent + hardware context + execution tools + physical feedback
```

它至少包含四层：

| 层 | 含义 | Blockless 对应 |
|---|---|---|
| Agent | 能理解 intent、拆任务、调用工具、根据反馈修复 | LLM / coding agent / hardware agent |
| Hardware context | board、module、driver、pins、power、protocol、package versions | board profile / module manifest / package intelligence |
| Execution tools | build、flash、run、read logs、call device tools、update files | mpremote / MicroPython REPL / package resolver / device bridge |
| Physical feedback | 真实设备输出、serial logs、sensor values、failure evidence | run logs / known failures / verified recipes |

所以市场数据要优先找：

```text
AI agents entering hardware toolchains
edge AI hardware adoption
robotics/embodied AI foundation models
robotics/AIoT prototype spending
module ecosystems with software/tooling
```

而不是只找：

```text
educational robots / STEM toys / maker marketplaces
```

### 1.4 证据强弱分层

| 证据类型 | 和 Blockless 关系 | 应该怎么用 |
|---|---|---|
| AI agent build/flash/control hardware | 最强 | 直接证明 agent-to-hardware 正在发生 |
| Embodied AI / robotics foundation model 融资和部署 | 很强 | 证明 AI 正从 text/code 进入 physical action |
| Edge AI hardware / accelerator / AI board 市场 | 强 | 证明 AI compute 正在进入设备侧和原型侧 |
| Paid prototyping / IoT / robotics automation | 强 | 证明今天有预算和工程价值 |
| Module ecosystem / maker hardware sales | 中等 | 证明 physical creation intent 和分发入口 |
| Educational robot / STEM hardware | 弱到中等 | 只能证明硬件学习/机器人 kit 付费，不直接证明 agent+hardware |
| Tindie / project community | 弱 | 只能证明长尾创作者和分发，不证明软件 ARPU |

这就是为什么 `U.S. educational robot market = USD 416.3M` 不能放在核心逻辑里。它只是旁证，不是主证据。

## 2. 数据层 A：AI Agent 已经在进入硬件开发工具链

这部分是美国叙事里最重要的证据。它说明 Blockless 不是空想 “让 AI 控硬件”，而是在一个已经开始形成的方向上做产品化收束。

| 证据 | 数据 / 事实 | 说明什么 | 不能证明什么 |
|---|---|---|---|
| Espressif ESP-IDF Tools MCP | 官方 MCP server 让 Cursor / Claude Code 等 AI clients 执行 ESP-IDF 项目的 set target、build、flash、status check | AI client 控制硬件开发链路已经发生 | 不能证明跨模块、跨 board 的 recipe 复用已经解决 |
| Espressif Documentation MCP + Tools MCP | 文档 MCP 负责官方文档上下文，Tools MCP 负责 build/flash 等动作 | AI-assisted embedded development 开始形成闭环 | 还偏 ESP-IDF / Espressif 官方生态 |
| ESP-IoT-Solution MCP docs | 支持 ESP32 / ESP32-C3 / ESP32-C6 / ESP32-S3，并示例在 ESP32 上暴露 JSON-RPC tools 控制设备状态 | MCU 设备本身可以成为 agent 可调用 tool | 还不是面向 maker 的完整创作产品 |
| Anthropic + Espressif reference hardware | M5Stack Cardputer / M5StickC Plus 作为 Claude hardware interface reference hardware，通过 BLE 与 Claude Desktop 交互 | LLM 公司和芯片/模块生态已在探索 agent-hardware interface | 不等于已经有商业化 workflow |
| Arduino Cloud AI Assistant | 用 Claude + RAG，基于 sketch、board、use case 提供 Arduino-specific context，目标是减少 hallucinated / misleading code | Arduino 生态承认 generic LLM 写硬件代码会出错，需要 board/context grounding | 不等于真实设备 run/observe/repair 已闭环 |
| Skilled AI Agents paper | 2026 论文在真实硬件上验证 agents：3 个 embedded platforms、23 个 peripherals、42 个 tasks、378 次 experiments | 学术上已经开始用真实硬件执行评估 embedded/IoT agents | 论文实验不等于产品可用性 |

### 2.1 对 Blockless 的含义

这些数据共同说明：

```text
AI agent 接入硬件不是想象，已经发生。
但当前能力是碎片化的：文档、build、flash、设备 tool、日志、recipe、兼容性数据分散在不同生态里。
Blockless 的机会是把这些碎片统一成 agent-to-hardware execution layer。
```

Blockless 的差异点不应该只是 “AI 生成代码”，而是：

```text
agent sees hardware context
-> selects package/driver
-> generates firmware
-> flashes/runs
-> observes logs/errors
-> repairs
-> saves a rerunnable recipe
```

## 3. 数据层 B：Embodied AI / Physical AI 正在变成可融资品类

这部分解释 “为什么 agent + hardware 会是大市场”，而不是一个小 embedded devtool。

| 证据 | 数据 / 事实 | 说明什么 | Blockless 连接点 |
|---|---|---|---|
| Figure AI | 2024 年 $675M Series B，$2.6B valuation；投资方包括 Microsoft、OpenAI Startup Fund、NVIDIA、Jeff Bezos、Intel Capital；与 OpenAI 合作 humanoid robot AI models | 大资本把 humanoid / embodied AI 当成未来品类 | 不是直接卖 humanoid，而是服务 embodied prototype 的 sensor/actuator/controller execution loop |
| Skild AI | 2024 年 $300M Series A，$1.5B valuation；目标是 scalable AI foundation model for robotics，强调 intelligence grounded in physical world | 机器人 foundation model 是美国 AI/robotics 投资主线 | foundation model 需要大量 real hardware interaction / data / prototype loops |
| Physical Intelligence | 2024 年获 $400M 融资，叙事是 general-purpose AI / foundation models for robotics，把 AI 带入 physical world | “AI into physical world” 已经是明确融资语言 | Blockless 可定位为 lower-level hardware execution layer |
| FieldAI | 2025 年宣布累计 $405M 融资，定位 physical AI / robotic autonomy；Field Foundation Models 是 physics-first foundation models for embodied intelligence | physical AI 从实验走向 industrial deployment | industrial deployment 前需要大量原型、传感器、控制器、边缘设备实验 |
| Covariant RFM-1 | 机器人 foundation model 让 human operators / engineers 用自然语言与机器人沟通，降低 customization 门槛 | 自然语言成为机器人行为定制入口 | Blockless 类似降低硬件行为生成和修改门槛 |
| NVIDIA Cosmos / Isaac GR00T / Jetson Thor | NVIDIA 用 Cosmos world foundation models、Isaac GR00T humanoid foundation model、Jetson Thor physical AI compute 平台推动 physical AI | 大平台公司在构建 physical AI full stack | Blockless 可站在更低成本、更模块化、更 maker/AIoT 的硬件执行层 |
| Google DeepMind Open X-Embodiment | 数据集来自 21 个机构、22 种 robot embodiments、500+ skills、150K+ tasks、1M+ episodes | embodied AI 的关键难题是跨硬件形态泛化和真实交互数据 | Blockless 的 recipe / hardware run logs 可成为低端/模块化硬件的 compatibility and execution data |

### 3.1 对 Blockless 的含义

不要说：

```text
Blockless 直接吃 humanoid robot TAM。
```

应该说：

```text
Embodied AI 增加了 sensor / actuator / camera / controller / edge AI prototype 的数量。
每个 embodied AI idea 都需要 intent -> hardware context -> code -> run -> observe -> repair。
Blockless 提供这个 lower-level agent-to-hardware execution loop。
```

### 3.2 为什么这不是泛泛蹭 embodied AI

这段必须讲得更谨慎。严格说，**Blockless 和 embodied AI 的关系不是直接关系，而是相邻关系。**

如果 embodied AI 被定义成：

```text
robot / humanoid / robot arm
+ action trajectory
+ perception
+ task outcome
+ robot policy learning
```

那 Blockless 不能说自己在做 embodied AI。因为 Blockless 目前不做：

- robot policy；
- imitation learning；
- robot manipulation；
- motion planning；
- humanoid / robot arm platform；
- Open X-Embodiment 那种 trajectory dataset。

所以原来的逻辑：

```text
robotics foundation models need embodied data
-> embodied data needs real-world execution
-> real-world execution needs hardware integration
-> Blockless does hardware integration
```

太绕，也太容易被质疑。它把 Blockless 放到了机器人 foundation model 的下游，但 Blockless 现在并没有直接服务 robot foundation model。

更准确的说法应该是：

```text
Embodied AI / robotics 是 physical AI 的一个高端分支；
Blockless 不在这个高端分支里。
Blockless 更接近 physical AI 的 non-robot endpoint layer：
让 AI agent 能构造、运行、观察和复现低成本物理端点。
```

这里的 “physical endpoint” 指的不是机器人，而是：

| Endpoint | 例子 | 为什么和 AI 有关 |
|---|---|---|
| Sensing endpoint | camera、mic、temperature、IMU、distance sensor | AI 需要从真实环境拿信号 |
| Actuation endpoint | relay、servo、motor、LED、display、speaker | AI 需要对真实环境产生可控输出 |
| Field endpoint | LoRa、RS485、CAN、MQTT、data logger | AIoT / industrial edge 需要接现场设备 |
| Edge inference endpoint | ESP32-S3、Jetson、Vision AI module、NPU board | AI model / rule / agent 需要落在设备侧 |
| Task fixture | sensor + actuator + rule / goal / success check | 用于验证一个物理任务是否跑通 |

所以 Blockless 不是在说：

```text
我们是 embodied AI。
```

而是在说：

```text
AI 要进入物理世界，不只有机器人这一种形态。
大量真实应用会先表现为 non-robot physical endpoints。
这些 endpoints 需要被快速构造、运行、复现、暴露成 observation/action 接口。
Blockless 做的是这一层。
```

这和 Schematik 的 “Cursor for Hardware” 叙事相容，但 Blockless 更应该强调：

```text
from prompt to reproducible physical endpoint
```

而不是：

```text
from prompt to robot / embodied AI.
```

### 3.2.1 证据链：这不是凭空想象，但也不是已证明 TAM

要证明 “non-robot physical endpoints” 不是拍脑袋，证据要分四层。每一层能证明的东西不同，不能混用。

| 证据层 | 外部事实 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 物理端点已经大量存在 | Matter device types 覆盖 light、switch、lock、thermostat、sensor、fan、appliance 等；ESPHome 把 ESP8266/ESP32 变成可接入 Home Assistant 的 sensors / switches / lights / displays / covers / climate 等设备 | 非机器人物理端点本来就是大规模存在的设备形态，不是 Blockless 发明的概念 | 不能证明这些用户会买 Blockless |
| AI / LLM 正在控制这些端点 | Home Assistant 2024.6 让 Google Gemini / OpenAI ChatGPT agents 可以 interact with home；Home Assistant LLM API 明确允许 LLM fetch data or control Home Assistant；Assist 支持用自然语言控制智能家居，也支持 ESPHome 自建设备 | AI agent -> non-robot physical device control 已经发生，不局限于机器人 | 不能证明“构造新硬件端点”的需求已经大 |
| Edge AI 正在进入非机器人场景 | NVIDIA edge / Metropolis / IGX / Holoscan 叙事覆盖 smart infrastructure、industrial、medical、sensor integration、real-time edge AI；Advantech 等边缘 AI 系统覆盖 smart cities、factory automation、machine vision | AI 不只在云端/屏幕里，也在摄像头、传感器、边缘盒子、工业现场设备里运行 | 不能证明 Blockless 能拿到这些 enterprise 场景 |
| Agent-to-hardware toolchain 正在出现 | Espressif ESP-IDF Tools MCP 让 Cursor / Claude Code 等 AI clients 执行 build / flash / monitor；Arduino Cloud AI Assistant 用 board / sketch / use case 上下文降低错误代码 | AI 辅助硬件开发和设备执行链路已经有官方生态尝试 | 不能证明 Blockless 的 recipe / AppStore / vendor model 一定成立 |

所以更严谨的逻辑链是：

```text
1. 非机器人物理端点已经存在：smart home、AIoT、edge camera、sensor/actuator device、field device。
2. LLM / AI agents 已经开始读取和控制这些端点：Home Assistant LLM API / AI agents / Assist 是证据。
3. Edge AI 正在把模型和推理带到设备侧：NVIDIA / Advantech / industrial edge 是证据。
4. 但现有系统更多控制“已经存在的设备”，不是帮助用户快速构造新的 custom endpoint。
5. Blockless 的机会在第 4 点：从 prompt 生成并验证一个新的 physical endpoint。
```

这和 “embodied AI” 的关系应该降级成背景趋势，而不是主证据：

```text
Embodied AI proves AI is moving toward physical interaction,
but Blockless should not claim it is building embodied AI.
The direct evidence is AI-to-device control and edge AI endpoints,
not humanoid robots or robot foundation models.
```

换句话说，Blockless 的强证据不是：

```text
Figure / Skild / Physical Intelligence 融资很大，所以 Blockless 很大。
```

而是：

```text
Home Assistant proves LLMs can control non-robot physical devices.
ESPHome proves low-cost MCUs can become custom sensors/actuators.
Matter proves the device world is already organized around endpoint capabilities.
Espressif MCP proves AI coding clients are entering build/flash/monitor loops.
Blockless tries to combine these into: prompt -> custom endpoint -> run -> verify -> recipe.
```

这仍然是一个假设，不是结论。Blockless 需要自己证明：

| 假设 | 需要的产品证据 |
|---|---|
| 用户不只想控制现有设备，还想快速构造新端点 | prompt-to-endpoint demo 的真实需求、waitlist、paid pilot |
| 构造端点的主要摩擦是 driver / pin / firmware / install / serial debug | support logs、失败归因、first-run time baseline |
| Blockless 能显著降低端点构造成本 | first-working-run time 下降 5x-10x |
| endpoint manifest / task harness 有价值 | agent 能稳定读取 observation、调用 action、判断 task success |
| vendor / workshop 愿意为 endpoint recipe 付费 | paid recipe package / workshop package / vendor renewal |

所以，这里最准确的一句话是：

```text
外部证据证明 AI 正在控制和运行非机器人物理端点；
Blockless 要证明的是 AI 能不能快速构造和复现新的非机器人物理端点。
```

### 3.3 这条关系如果要成立，必须从 endpoint interface 证明

这里需要自我批判：**edge AI / physical AI 趋势不能自动证明 Blockless 有市场。**

如果 Blockless 只是：

```text
自然语言 -> 生成一段硬件代码
```

那它和 physical AI 的关系很弱，甚至会被认为是在蹭趋势。真正成立的连接必须是：

```text
physical intent
-> sensor / camera / actuator / controller 组合
-> board profile / module manifest / driver context / pins
-> firmware generated from grounded context
-> local deploy / run
-> serial logs / sensor values / physical feedback
-> repair
-> reusable recipe
```

也就是说，Blockless 不是 embodied AI model company，也不是 edge AI chip company。更重要的是，**“真实硬件原型的 agent execution loop” 也不够强**。如果只讲到这一层，Blockless 只是一个更好的硬件开发工具，和 physical AI / AI-to-device interaction 仍然隔着接口、任务和评估标准。

更强的连接必须从：

```text
agent can run hardware
```

升级成：

```text
agent can construct, expose, evaluate, and reuse low-cost physical endpoints.
```

这里说的 physical endpoint 可以是：

- 一个带 camera / mic / display / button 的感知终端；
- 一个 sensor + relay / motor / servo 的控制装置；
- 一个 LoRa / RS485 / CAN / MQTT 的现场设备；
- 一个 edge AI board + actuator 的小型自主系统；
- 一个由多个模块组成的 physical task fixture。

这类东西不是机器人，也不是 robot foundation model 本体。它们更像 AI agent 接触真实世界的 I/O 端点：输入是真实环境信号，输出是真实设备动作或状态变化。

本地产品文档和代码里已经有这个技术骨架：

| 技术骨架 | repo 里的证据 | 为什么支撑 agent + hardware |
|---|---|---|
| 硬件上下文 | `board profile`、`available_modules`、`pin_capabilities`、`manifest` | agent 不能凭空写代码，必须知道板子能 import 什么、哪些 pin 合法 |
| 驱动上下文 | `mpyhw-api/content/packages/driver_context/*.json` 包含 `import_names`、constructor、read methods、install method、examples、pin roles | 防止 LLM 发明不存在的 driver API，把“模块”变成机器可读能力 |
| 包安装 | driver context 里记录 `mpremote mip install` 和包 URL | agent 生成代码之后能安装依赖，不停在教程阶段 |
| 本地执行 | VS Code extension / Python shim 负责 scan、package install、file write、flash/run、serial read | 浏览器/服务器不能直接碰串口；本地执行层是硬件闭环的必要条件 |
| 运行反馈 | telemetry 事件包含 `flash_started`、`flash_finished`、`serial_marker_seen`、`runtime_error`、`repair_exhausted` | 可以衡量真实设备是否跑起来，而不是只衡量代码生成 |
| AppStore / recipe | `hardware_tags`、`device_profiles`、`.mpk`、`app_index.json`、install reports | 把一次成功运行沉淀成可复现、可分发、可推荐的数据资产 |
| MicroPython runtime | REPL、`mpremote run/exec/fs`、异常体系、Python 模块结构 | 比 Arduino/C 编译-烧录链更适合 AI trial-and-error loop |

所以旧版技术叙事只能算第一层：

```text
Physical AI / edge AI 增加真实硬件端点需求；
Blockless 不做上层 robot brain，而做 lower-level hardware execution；
MicroPython + driver context + local mpremote + serial feedback
让 agent 可以从“写代码”进入“跑真实设备并修复”。
```

但这还不够。因为 demo 已经能做到“跑真实设备”，下一步必须证明 Blockless 能定义和复用 **physical affordance**：

```text
这个硬件 embodiment 能观察什么？
能执行什么动作？
动作参数是什么？
环境反馈是什么？
任务成功标准是什么？
这些 I/O 和 action 能不能被 agent / model / evaluator 调用？
```

换句话说，Blockless 和 embodied AI 的强关系不是：

```text
我们能让 AI 写硬件代码。
```

而是：

```text
我们把低成本模块化硬件变成 AI 可理解、可调用、可评估的 physical affordance layer。
```

这才和 Open X-Embodiment / LeRobot / Isaac GR00T 这些方向发生真正关系。它们关心的是：

- embodiment；
- observation；
- action；
- trajectory / episode；
- task success；
- cross-embodiment generalization；
- real / synthetic data pipeline；
- hardware-in-the-loop evaluation。

Blockless 现在的 recipe 还不是这些数据，但可以向这层演化：

| 层级 | 现在的 Blockless recipe | 要接 embodied AI 还缺什么 |
|---|---|---|
| Hardware compatibility | board / module / driver / pin / package | 继续保留，这是底座 |
| Execution evidence | run log / serial output / failure | 标准化为 observation schema |
| Action interface | relay on/off、servo angle、motor speed、display text 等 | 标准化为 action schema |
| Task harness | 目前没有或很弱 | 定义 goal、initial state、success check、timeout、safety bound |
| Episode log | 目前更多是 debug log | 记录 observation-action-result sequence |
| Evaluation | 目前看是否跑通 | 看任务是否完成、是否稳定、是否可迁移 |

因此，最该做的 demo 不是普通 blink，也不只是“自动修复一次错误”，而是：

```text
sensor / camera / actuator / edge board
-> agent 选择模块和 driver
-> 生成代码
-> 部署到真实设备
-> 读 serial / sensor output
-> 修复一次真实错误
-> 保存 recipe
-> 另一台设备复现
+ 把 sensor output 标准化成 observation
+ 把 actuator / display / relay / motor 标准化成 action
+ 定义一个 task success condition
+ 记录一次 observation-action-result episode
+ 用同一 task harness 在第二套硬件上复现
```

如果只做到前半段，Blockless 是 hardware agent devtool。  
如果做到后半段，Blockless 才开始变成 non-robot physical AI endpoint / interface / evaluation infrastructure。

### 3.4 更强的新叙事：Blockless 不是机器人，而是 non-robot physical AI endpoint layer

这里必须改得更彻底：**Blockless 不是机器人公司，也不是机器人平台。**

如果一讲 embodied AI，听众脑子里出现的是 humanoid、robot arm、mobile robot，那这个词反而伤害 Blockless。Blockless 当前真正能占的位置不是 robot，而是：

```text
non-robot physical AI endpoints
```

也就是大量低成本、任务特定的物理端点：

```text
sensor -> edge compute -> actuator / display / relay / motor / network output
```

中文：

```text
这不是机器人。
这是 AI 进入物理世界时需要的大量传感-执行端点：
能看、能听、能测、能显示、能开关、能控制、能上传、能触发。
Blockless 的机会是把这些端点快速构造出来，
并变成 agent / model 可调用、可评估、可复现的物理接口。
```

更准确的英文表述可以是：

```text
AI-native physical endpoint construction layer.
```

或者：

```text
The interface layer between AI agents and non-robot physical devices.
```

这比 “embodied AI” 更不容易被误解。因为 Blockless 不是在做完整 embodied agent，而是在做：

```text
physical sensing
+ physical actuation
+ edge execution
+ device feedback
+ reproducible endpoint recipes
```

如果一定要和 embodied AI 建关系，也要说成：

```text
Blockless serves the non-robot edge of physical AI.
It turns modular sensors and actuators into callable physical interfaces for agents.
```

而不是：

```text
Blockless is an embodied AI platform.
```

叙事强度应该重新排序，但这里必须加一句：**越往下越不是已证明事实，而是 Blockless 需要验证的产品假设。**

| 叙事层级 | 强度 | 问题 |
|---|---|---|
| AI 生成硬件代码 | 弱 | 太像 copilot for embedded |
| Agent 跑真实硬件并修复 | 中 | 是 devtool，但不是 physical AI endpoint layer |
| Agent 构造可复现 physical prototype | 中强 | 能支撑 prototype-first 市场 |
| Agent 构造可调用 physical endpoint | 待验证 | 技术上有参照，但 Blockless 还没证明用户要这个 |
| Agent 生成 task harness 和 endpoint logs | 待验证 | 只有当它能驱动付费、复现和评估，才有市场意义 |

所以，Blockless 如果要把 “AI + physical world” 讲强，产品路线可以尝试增加三个对象。但这不是结论，是需要验证的路线：

1. **Endpoint Manifest**

   ```text
   observation: temperature, distance, camera frame, button state
   action: relay_on, set_servo_angle, display_text, motor_speed
   constraints: voltage, pin, safe range, timeout
   ```

2. **Task Harness**

   ```text
   goal: keep temperature below 30C
   initial condition: sensor connected, fan off
   action space: fan_on / fan_off
   success: temperature drops or threshold maintained for N seconds
   failure: timeout, sensor missing, unsafe state
   ```

3. **Endpoint Run Log**

   ```text
   timestamp
   observation
   action
   result
   error / repair
   success / failure
   physical endpoint id
   ```

为什么这三件事技术上不是瞎编？因为已有系统都在用类似抽象：

| Blockless 假设对象 | 相邻技术参照 | 说明 | 缺口 |
|---|---|---|---|
| Endpoint Manifest | W3C Web of Things Thing Description 用 Properties / Actions / Events 描述 Things 的交互能力 | “设备能力可机器读取”是已有标准思想 | WoT 偏通用互操作，不解决从自然语言到固件、接线、driver |
| Endpoint Manifest | Matter 用 device types / clusters / attributes / commands 描述智能设备能力 | 消费 IoT 已经围绕 device capability 标准化 | Matter 面向已成品设备，不面向 prototype 构造 |
| Endpoint Manifest / Run Log | Home Assistant entity 有 state / attributes / services，LLM API 可让模型 fetch data or control Home Assistant | AI 读取状态、调用设备动作已经在真实系统出现 | 控制的是已接入设备，不是构造新 endpoint |
| Endpoint Manifest | ESPHome components 把 ESP8266/ESP32 配成 sensor、switch、light、display、cover 等 | 低成本 MCU 变成物理端点已被验证 | ESPHome 仍要求用户理解 YAML、硬件、组件和调试 |
| Task Harness | 工业测试、IoT commissioning、Home Assistant automation 都有 goal/trigger/action/state 的影子 | “设备任务可验证”不是新概念 | Blockless 需要证明它能自动生成并执行 task harness |

所以准确说法不是：

```text
Endpoint Manifest / Task Harness / Run Log 会自然打开大市场。
```

而是：

```text
这些对象在技术上有先例；
Blockless 的新假设是把它们用于 custom physical endpoint construction：
prompt -> wiring/driver/firmware -> run -> endpoint manifest -> task check -> reusable recipe.
```

市场是否成立，要看三个 proof：

| Proof | 怎么证明 | 不成立的信号 |
|---|---|---|
| 用户真的需要构造新 endpoint | 有人带着具体物理任务来用，而不是只看 demo | 大多数用户只想控制现有 Home Assistant / Matter 设备 |
| manifest / harness 降低了调试和复现成本 | first-working-run 下降 5x；rerun success >70%；失败可归因 >60% | 仍然靠人工解释硬件、手动排错 |
| 这件事有人付费 | vendor recipe package、workshop package、pro-builder project credits | 只有免费试用、没有 paid pilot |

如果这些 proof 没有出现，这套 endpoint manifest / task harness / run log 就只是漂亮抽象，不是公司战略。

### 3.5 重新定义和 embodied AI / physical AI 的关系

更准确的关系链应该写成一个假设，而不是事实：

```text
AI is moving from screens into physical environments.
Some of that movement is robotics.
Some of it is non-robot endpoints: sensors, cameras, relays, displays, motors, field buses, edge boards.
The existence of these endpoints is proven by IoT / smart home / edge AI ecosystems.
The market for constructing them through an AI agent is not yet proven.
Blockless must prove that construction + verification is painful enough to pay for.
```

这比之前的：

```text
embodied AI needs hardware integration;
Blockless helps hardware integration.
```

强一些，但不能写成已验证市场。它只是把 Blockless 放在 physical AI stack 的一个可检验位置，同时避开了“机器人”误解：

```text
model layer: VLA / robot foundation model
simulation layer: synthetic worlds / Isaac / Cosmos
robot platform layer: humanoid / arm / mobile robot
non-robot physical endpoint layer: sensors / actuators / edge devices / fixtures
execution + endpoint interface layer: Blockless
```

Blockless 最适合占的不是 robot platform layer，也不是 embodied model layer，而是：

```text
non-robot physical endpoint layer
+ execution + endpoint interface layer
```

这也解释了为什么中国供应链重要：non-robot physical endpoints 需要大量低成本模块、快速组合、快速替换、快速复现。美国有 AI narrative，但中国更适合把这些 endpoint 做成密集 SKU 和可验证 recipe。

但最后仍然要回到 proof：

```text
技术成立的 proof = Blockless 能自动生成 endpoint manifest、跑 task harness、产出可复现 run log。
市场成立的 proof = vendor / workshop / pro builder 愿意为这些东西付费。
```

### 3.6 诚实结论：严格 embodied AI 基本不沾，physical endpoint 相邻相关

如果按学术和产业主流口径，embodied AI 的核心是：

```text
agent / model
+ body / morphology
+ perception
+ action
+ environment interaction
+ learning / policy / trajectory
```

典型对象是：

- humanoid；
- robot arm；
- mobile robot；
- autonomous vehicle；
- robot manipulation；
- VLA / robot foundation model；
- simulation-to-real；
- trajectory / episode dataset。

Open X-Embodiment、LeRobot、NVIDIA Isaac / GR00T / Cosmos 这一类都基本在这个世界里。它们关心的是：

```text
observation -> action -> trajectory -> task success -> policy learning
```

Blockless 当前技术栈关心的是：

```text
board / module / pin / driver / package
-> code
-> flash / run
-> serial log
-> repair
-> recipe
```

这两者不是一类东西。诚实地说：

```text
Blockless 不是 embodied AI。
Blockless 不做 robot policy。
Blockless 不做 robot trajectory dataset。
Blockless 不做 simulation / world model。
Blockless 不做 motion planning 或 manipulation。
```

所以，如果 pitch 里说：

```text
Blockless is an embodied AI company.
```

这是错的，或者至少是非常容易被专业投资人/研究者打穿的。

更准确的关系是：

```text
Embodied AI / physical AI 是上位趋势：AI 从屏幕走向物理环境。
Blockless 不是这个趋势的核心模型层，也不是机器人层。
Blockless 只可能占相邻的工具层：
帮助构造 non-robot physical endpoints。
```

也就是说，Blockless 和 embodied AI 的关系最多是：

| 关系层级 | 是否成立 | 说明 |
|---|---|---|
| Blockless = embodied AI | 不成立 | 太夸张，技术栈不匹配 |
| Blockless 直接服务 robot foundation models | 目前不成立 | 没有 robot trajectory / action policy / manipulation data |
| Blockless 是 robotics devtool | 大体不成立 | 它更偏 MCU / module / sensor / actuator prototype |
| Blockless 是 physical AI endpoint construction tool | 可能成立 | 需要证明 AI agents 会需要大量 custom physical endpoints |
| Blockless 是 AI-native hardware prototyping tool | 当前最稳 | 和现有产品能力最匹配 |

所以报告应该把 embodied AI 降级为：

```text
背景趋势 / 资本叙事 / physical-world-AI umbrella
```

而不是：

```text
主市场 / 主技术栈 / 直接 TAM
```

最稳的主叙事仍然是：

```text
AI-native physical prototyping.
```

如果还想保留和 physical AI 的连接，建议用这句话：

```text
Blockless is not building embodied AI models or robots.
It builds the agentic prototyping layer for non-robot physical endpoints:
sensors, actuators, displays, relays, motors, field buses, and edge boards.
```

中文：

```text
Blockless 不做 embodied AI 模型，也不做机器人。
它做的是 non-robot physical endpoints 的 agentic prototyping layer：
让 AI agent 更快构造、运行、验证传感器、执行器、显示、继电器、电机、现场总线和边缘板组合。
```

这句话仍然需要 proof，但它比硬蹭 embodied AI 诚实得多。

### 3.7 这个市场怎么说：先讲 AI-to-device prototyping service，再讲软件化

更现实的市场叙事不是：

```text
我们抓 embodied AI TAM。
```

而是：

```text
AI-to-device control is emerging.
Custom physical endpoints are still hard to build.
Blockless starts as an AI-assisted endpoint prototyping service/tool,
then productizes the repeated work into recipes, manifests, and vendor packages.
```

这条线的证据分两类。

第一类证明“非机器人物理端点 + AI 控制”已经存在：

| 证据 | 事实 | 说明 |
|---|---|---|
| Home Assistant Analytics | 官方 analytics 页面显示 635K+ active installations，且 analytics 是 opt-in，不代表全部用户 | 已有大量用户在连接、组织、控制非机器人物理设备 |
| Home Assistant AI agents | 2024.6 之后 OpenAI / Google AI agents 可以 interact with home；官方说 LLM 可以连接和控制设备 | AI-to-device control 已经在真实产品生态里发生 |
| Home Assistant LLM API | 官方文档明确 LLM 可以 fetch data or control Home Assistant；API 也支持 custom integrations 提供自己的工具 | observation/action interface 不是 Blockless 自己发明的概念 |
| ESPHome | 官方定位是把 ESP32 / ESP8266 / BK72xx / RP2040 等变成 smart home devices；支持 hundreds of sensors, displays, components | custom low-cost physical endpoint 已经有成熟开源生态 |
| Matter | device types / clusters / attributes / commands 把设备能力标准化 | 设备世界已经在围绕 capability / command / state 组织 |

第二类证明“构造这些端点/原型”今天有付费预算：

| 证据 | 事实 | 说明 |
|---|---|---|
| Clutch US IoT companies | 2026-06-05 更新，美国 IoT developer 目录有 1,111 companies；平台强调可按 budget、hourly rate、industry 筛选，服务包括 prototype、firmware、cloud integration | IoT / connected-device 构建已经是服务市场 |
| Clutch 项目价格 | 示例服务商常见项目门槛 USD 10K / 25K / 50K+，部分平均项目成本在 USD 50K-199K | 客户已经为 IoT integration / connected product 付项目费 |
| Upwork embedded engineers | Upwork 显示 embedded systems engineers 常见 USD 25-50/hr | 即便在 freelancer 市场，firmware / embedded debug 也有明确人力价格 |
| TriMech prototype cost | 含 electronics 的产品开发 / prototype 很容易超过 USD 50K；无电子的简单 prototype 也可到 USD 15K-40K | physical/electronics prototype 的时间和复杂度能换算成钱 |

所以市场不能说成：

```text
现在已经有一个 AI physical endpoint SaaS market。
```

应该说成：

```text
已有三种相邻预算池：
1. smart home / AI-to-device ecosystem；
2. IoT / connected-device development services；
3. electronics / hardware prototype services。

Blockless 的机会是把其中一部分 custom endpoint construction
从 consulting/service 变成 repeatable AI workflow。
```

这就回答了“我们可以接单吗”：**可以，而且应该接单，但接单的目的不是做外包公司，而是验证可产品化的重复任务。**

建议先接三类单：

| 订单类型 | 客户 | 交付 | 定价假设 | 为什么适合 Blockless |
|---|---|---|---:|---|
| Prompt-to-Endpoint Sprint | founder、maker-pro、AIoT builder、workshop | 1 个 sensor/actuator endpoint，含 firmware、run log、recipe、BOM | USD 1K-5K / RMB 5K-3万 | 最短路径验证 “AI 做硬件 prototype” |
| Home Assistant / ESPHome Custom Device | smart home power user、integrator、小型安装商 | ESP32 endpoint 接入 HA，支持 sensor/switch/display/voice/relay | USD 500-3K / RMB 3K-2万 | 外部生态已有用户和明确 endpoint 概念 |
| Vendor Recipe Pack | 模块/kit 厂商 | 10-20 个 SKU 的 verified recipe、FAQ、run evidence | RMB 3万-20万 / 年 | 更接近长期 vendor economics |

这些订单要强制沉淀为产品资产：

```text
每接一单，都必须产生：
endpoint manifest
task harness
run log
known failures
driver/package context
BOM
reusable recipe
```

不符合这个标准的单不要接。比如纯 PCB layout、纯外壳、纯云平台、纯 Home Assistant 配置服务，都容易把 Blockless 拉成普通外包。

更直白地说：

```text
能沉淀 endpoint recipe 的单，是验证；
不能沉淀 endpoint recipe 的单，是外包。
```

接单验证要看 6 个指标：

| 指标 | 为什么重要 |
|---|---|
| 从客户需求到 first working endpoint 的时间 | 证明 Blockless 是否真的加速 |
| 人工介入小时数 | 判断能否从服务变软件 |
| 失败原因分布 | 决定 driver/pin/package/firmware 哪些要产品化 |
| recipe 复用次数 | 判断是否能沉淀资产 |
| 客户是否愿意为第二个 endpoint 付费 | 判断 repeat demand |
| 是否能从定制交付变成 template | 判断是否有产品化路径 |

最小验证方式：

```text
30 天内接 5 个 endpoint sprint；
每单目标 3-7 天交付；
至少 3 单付费；
至少 2 个 recipe 能被第二个客户复用；
每单人工时间低于传统 embedded freelancer 报价的 50%；
```

如果做不到，说明 Blockless 还只是 demo 工具，不是市场机会。  
如果做到了，就有更强的叙事：

```text
We found a repeatable paid wedge:
AI-assisted construction of custom physical endpoints.
```

中文：

```text
我们找到的不是 embodied AI 市场，
而是 custom physical endpoint prototype 的付费 wedge。
Blockless 用 AI 把这类端点从一次性外包，变成可复用 recipe 和可重复工作流。
```

### 3.8 “构造 endpoint / prototype” 市场多大：没有直接品类，只能从相邻服务池估

这里不能装作已经有一个成熟品类叫：

```text
AI physical endpoint construction market
```

公开市场报告里基本没有这个类目。更严谨的估算方式是：

```text
相邻服务预算池
-> 其中 custom physical endpoint / IoT prototype 的比例
-> Blockless 能产品化和捕获的比例
```

可用证据如下：

| 证据 | 数字 / 事实 | 能证明什么 | 不能证明什么 |
|---|---:|---|---|
| IoT professional services | P&S Intelligence 口径：2024 年 USD 132.5B，2030 年 USD 194.8B | IoT 咨询、系统设计、实施、支持是巨大的服务市场 | 太宽，绝大多数不是小型 endpoint prototype |
| IoT professional services 其他口径 | SNS Insider: 2023 年 USD 120.4B，2032 年 USD 226.8B；Valuates: 2024 年 USD 114.28B，2030 年 USD 164.87B | 多个来源都把 IoT professional service 看成百亿美元级 | 数字口径差异大，不能直接当 TAM |
| Clutch US IoT companies | 2026-06-05 更新，美国 1,111 家 IoT developers；示例服务商项目门槛 USD 5K/10K/25K/50K+ | 美国存在大量 IoT / connected-device 服务供给，客户按项目购买 | Clutch 是供给侧目录，不代表成交总额 |
| Clutch project cost examples | 示例服务商平均项目成本常见 USD 10K-49K、50K-199K，甚至更高 | 原型、firmware、cloud integration 有项目预算 | 不说明 Blockless 能替代完整 IoT agency |
| Upwork embedded engineer rates | Embedded Systems Engineers 常见 USD 25-50/hr | firmware / embedded debug 有清晰人力价格 | 这是 freelancer 低端/中端价格，不代表专业服务总价 |
| TriMech prototype cost | 含 electronics 的 prototype / product development 容易超过 USD 50K；无电子简单 prototype 也可 USD 15K-40K | 电子原型复杂度和工程时间可以换成真实预算 | 这是产品开发服务，不是软件工具市场 |
| Home Assistant | 2025 官方称从 1M 到 2M+ active installations；analytics 页面显示 635K+ opt-in active installations | 大量用户在真实环境中连接和控制设备 | smart home 用户不等于会买 custom endpoint construction |
| ESPHome | 官方定位：把 ESP32/ESP8266/BK72xx/RP2040 变成 smart home devices；支持 hundreds of sensors, displays, components；用户包括 DIY enthusiasts、smart home hobbyists、professional integrators | custom low-cost endpoints 的生态已经存在 | ESPHome 用户可能自己动手，不一定愿意付费 |

基于这些证据，市场可以拆成三层：

#### Layer 1：服务市场上限

这是最大但最不精确的池子：

```text
IoT professional services: USD 100B+ global annual market
Product engineering / electronics prototype: very large but too broad
```

Blockless 不能说自己吃这个市场。它只能说：

```text
这些市场证明 connected-device / electronics prototype 有预算；
Blockless 只切其中最早期、最模块化、最可重复的一小块：
custom physical endpoint prototype.
```

#### Layer 2：可服务细分市场

更接近 Blockless 的是：

| Segment | 估算方式 | 粗略年预算池 |
|---|---|---:|
| Smart home / ESPHome custom endpoints | 2M Home Assistant installations 中 1%-5% 每年愿意为 custom endpoint 付 USD 100-1,000 | USD 2M-100M service pool |
| Pro maker / AIoT builder endpoint sprint | 10K-100K 人/团队每年做 1-3 个 endpoint，每个 USD 500-5K | USD 5M-1.5B service pool |
| IoT prototype / connected-device MVP | 从 IoT professional services 里切 0.1%-1% 作为早期 prototype / endpoint construction | USD 100M-1B+ global pool |
| Module / kit vendor recipe package | 100-1,500 vendor/kit/channel，每年 USD 5K-50K | USD 0.5M-75M |
| Workshop / applied hardware course | 200-3,000 programs，每年 USD 1K-20K | USD 0.2M-60M |

这些数字不是已验证 TAM，而是接单验证前的假设区间。真正有意义的是发现哪一层最先付费。

#### Layer 3：Blockless 可捕获的早期 wedge

早期不要讲大 TAM，要讲一个能接单验证的小 wedge：

```text
AI-assisted custom endpoint sprint
```

建议定义成：

```text
1 physical endpoint
3-7 days
USD 1K-5K
includes firmware, wiring, run log, endpoint manifest, BOM, reusable recipe
```

30 天如果能接 5 单、至少 3 单付费，收入是：

```text
USD 3K-15K
```

这不是大市场，但它证明：

```text
有人愿意为 AI-assisted endpoint construction 付钱。
```

如果 90 天做到：

```text
20 paid endpoint sprints x USD 2K average = USD 40K service revenue
10 reusable recipes
3 repeat customers
1 vendor recipe package
```

才可以说：

```text
我们找到了 paid wedge。
```

如果没有这些数据，继续讲市场规模就是空的。

#### 接单策略：先服务化，再产品化

可以接单，但要按下面规则：

| 接 | 不接 |
|---|---|
| 传感器/执行器/显示/继电器/电机/现场总线 endpoint | 纯 PCB layout |
| ESP32 / MicroPython / ESPHome / Home Assistant 可复现 endpoint | 纯云平台 |
| 能产出 recipe / manifest / run log / BOM | 纯外壳 / 结构 |
| 同类需求可复用到第二个客户 | 一次性集成、完全不可复用 |
| 客户愿意接受“产品化交付物” | 客户只要人工外包结果 |

接单不是为了收入，而是为了回答四个问题：

```text
1. 谁最愿意付钱？
2. 哪类 endpoint 最重复？
3. 哪些 failure mode 最常见？
4. 哪些 recipe 能被第二个客户复用？
```

只有这些问题被回答，Blockless 才能从服务变产品。

### 3.9 最终市场说法：不要讲 TAM，讲 wedge + proof

目前最诚实的市场表述是：

```text
There is no proven AI physical endpoint construction market yet.
But there are large adjacent service pools:
IoT professional services, embedded freelancing, electronics prototyping,
and smart-home/ESPHome custom device ecosystems.

Blockless should validate a narrow paid wedge:
AI-assisted construction of custom physical endpoints.
```

中文：

```text
现在还没有被证明的 “AI 物理端点构造” 市场。
但相邻预算池是真实存在的：
IoT 专业服务、embedded freelancer、电子原型开发、Home Assistant / ESPHome 自定义设备生态。

Blockless 应该先验证一个很窄的付费 wedge：
AI 辅助构造 custom physical endpoint。
```

如果验证成功，再把叙事升级成：

```text
custom endpoint services are being productized into reusable AI-native recipes.
```

如果验证失败，就回到更保守的定位：

```text
Blockless is a useful AI hardware prototyping tool,
but not yet a venture-scale endpoint platform.
```

## 4. 数据层 C：Maker / 模块生态证明 physical creation intent

这里要避免两个极端：

- 不能说 “maker 已经证明巨大软件市场”。
- 也不能说 “maker 弱，所以没用”。

更准确：

```text
Maker 证明的是 physical creation intent。
人们已经愿意买硬件、看教程、参加 contest、发布项目、忍受 debug。
如果 AI agent 能显著缩短从 imagination 到 working hardware 的路径，这个 intent 可能被放大。
```

| 证据 | 数据 / 事实 | 说明什么 | 不能证明什么 |
|---|---|---|---|
| Hackster | 2.5M+ members、44K+ open source projects、290+ company platforms、6M monthly website views；2019 survey 显示 70% working professionals、36% hardware/software engineers、20% launched a commercial product | 这不是纯儿童玩具社区，包含专业和商业化用户 | 不证明他们都会买 Blockless |
| Hackster contests | 91K+ contest participants、8.4K+ contest submissions、$2.1M+ cash value prizes | 公司愿意通过硬件项目社区做开发者生态和产品推广 | 不证明 SaaS ARPU |
| Adafruit | media kit 显示 8M+ page views/month、3M+ uniques/month、16.2K orders/month；Press page 提到 3M orders milestone | 美国 maker electronics 购买和教程流量真实存在 | 不证明软件订阅意愿 |
| Raspberry Pi | 2024 报道显示 Raspberry Pi/Compute Module 年销量约 7M，microcontroller RP2350/RP2040 约 5.7M；Raspberry Pi 生态累计销量数千万 | SBC/MCU 级别硬件创作需求持续存在 | 不证明 Blockless 能抓住用户 |
| M5Stack | 3M+ products sold globally、400+ SKUs、181K+ maker/developer community、660K+ UIFlow code downloads、50+ distributors、110+ countries | 模块化 AIoT hardware + software + community 生态已成立 | 不证明 Blockless 自动能替代 UIFlow |
| Seeed 2024 review | 重点围绕 AI sensing、edge AI、local LLM、robotics、TinyML、Home Assistant、Jetson、vision/robotics demos、developer programs | 模块生态已经从普通 maker 转向 AIoT / edge AI / robotics | 不证明付费模式 |

### 4.1 关键推理

Maker 买模块、买板子、看教程不是弱信号，而是：

```text
Physical creation intent exists.
```

过去没有变成大软件市场，是因为链路太长：

```text
imagination -> choose board -> buy parts -> wiring -> firmware -> flash -> logs -> debug -> maybe works
```

Blockless 如果能把链路压缩成：

```text
imagination -> agent sees hardware context -> generate/run -> observe -> repair -> recipe
```

那么它不是卖教程，而是在创造新的硬件 creation workflow。

### 4.2 这些数据加起来到底多少钱

不能直接相加。原因是：

- Raspberry Pi 是年度公司 revenue。
- Adafruit 是 orders/month，没有公开 AOV。
- M5Stack 是累计 products sold，没有公开 revenue。
- Hackster 是社区规模、流量、contest prize pool，不是交易额。
- Seeed 是方向和生态信号，没有公开对应收入。

但可以做一个分层估算。

| 生态 | 可观察 money / proxy | 粗略金额 | 可信度 | 如何使用 |
|---|---:|---:|---|---|
| Raspberry Pi | 2024 revenue | USD 259.5M | 高 | 证明 SBC/MCU/embedded creator hardware 是真实年度收入，不是小 hobby |
| Raspberry Pi units | 2024 年 SBC/Compute Module 7.0M units；microcontroller 5.7M units | 已包含在 revenue 中，不另加 | 高 | 证明硬件创作设备有大规模出货 |
| Adafruit | 16.2K orders/month | 若 AOV = $25/$50/$100，则 annual GMV 约 USD 4.9M / 9.7M / 19.4M | 中；AOV 是假设 | 证明美国 maker electronics commerce 是活的，但不能当强 TAM |
| M5Stack | 3M+ cumulative products sold | 若 ASP = $15/$30/$50，则 cumulative GMV 约 USD 45M / 90M / 150M | 中低；ASP 和时间跨度未知 | 证明模块化 AIoT 硬件生态能积累到千万美元级别以上 |
| Hackster contests | $2.1M+ cash value prizes | USD 2.1M+ cumulative prize pool | 中 | 证明企业愿意为硬件开发者生态/contest 付 marketing/devrel budget |
| Hackster traffic/community | 2.5M members、6M monthly website views | 不能直接折成收入 | 低 | 证明 reach 和 creator/professional 混合人群 |
| Seeed | 2024 review: edge AI / local LLM / robotics / TinyML / Jetson / vision demos | 不能直接折成收入 | 低 | 证明模块生态转向 AIoT / edge AI / robotics |

### 4.3 一个保守口径

如果只算比较硬的钱：

```text
Raspberry Pi 2024 revenue: USD 259.5M
+ Adafruit estimated annual GMV: USD 5M-20M
+ Hackster contest prize pool: USD 2.1M+ cumulative, not annual
+ M5Stack estimated cumulative GMV: USD 45M-150M, not annual
```

所以，**不能说这些加起来就是一个 annual TAM**。

但可以说：

```text
Publicly visible maker/module/SBC ecosystems show at least hundreds of millions
of dollars in annual hardware revenue, plus tens/hundreds of millions cumulative
module commerce, plus developer-community sponsorship/contest spend.
```

更严谨的表达：

```text
The existing maker/module ecosystem is already a meaningful hardware-spend base,
but the software workflow spend is not yet proven.
Blockless must convert hardware spend + physical creation intent into repeat agent runs.
```

### 4.4 和 Blockless 的真实关系

这些钱不是 Blockless 可以直接拿走的钱。

它们证明的是三个前提：

1. **人们已经为 physical creation 花钱**  
   Raspberry Pi、Adafruit、M5Stack 说明板卡、模块、配件、教程驱动的购买行为存在。

2. **公司愿意为 hardware developer ecosystem 花钱**  
   Hackster contests / platforms 说明企业愿意通过项目社区触达开发者。

3. **模块生态正在转向 AIoT / edge AI / robotics**  
   M5Stack 和 Seeed 的叙事都已经不是普通 blink demo，而是 AI sensing、edge AI、robotics、TinyML、Jetson、vision demos。

Blockless 要验证的商业转换是：

```text
hardware spend -> agent-assisted setup/debug/run -> repeat recipes -> paid workflow
```

如果转换不成立，这些生态数据只能说明 “周边热闹”，不能说明 Blockless 有收入。

### 4.5 模块 TAM 现实：美国不能只靠 hobby module 消费讲大

你说 “美国模块消费不是很大” 这个判断基本成立，至少从公开数据看，**不能把美国 maker module spend 讲成一个天然巨大的软件 TAM。**

目前公开口径里比较硬的数据是：

| 口径 | 数据 | 能说明什么 | 不能说明什么 |
|---|---:|---|---|
| Raspberry Pi global revenue | FY2024 USD 259.5M；FY2025 USD 323.2M | SBC/MCU/compute module 是真实硬件收入，不是小玩具 | 这是全球收入，不是美国 maker module TAM |
| Raspberry Pi U.S. revenue | FY2024 USD 44.2M；FY2025 USD 69.0M | 美国是 Raspberry Pi 最大 end market，但金额仍是千万美元级 | Raspberry Pi 只是一个生态，且含 OEM / industrial / components |
| U.S. single-board computer market | 第三方报告口径约 USD 1.33B in 2024 | 如果扩大到 industrial / test / defense / education，SBC 是十亿美元级美国市场 | 这不是 maker 模块市场，也不是 Blockless 可直接捕获的软件 TAM |
| U.S. IoT microcontroller market | Grand View Horizon 口径：2024 revenue USD 1.276B，2030 USD 2.889B | IoT/MCU 设备侧硬件需求真实存在 | 这是芯片/微控制器市场，不是开发板/传感器模块消费 |
| Adafruit | 16.2K orders/month；8M+ page views/month；3M+ uniques/month | maker electronics commerce 和教程流量真实存在 | 没有公开 AOV；不能直接变成 TAM |
| SparkFun | 第三方电商估算 2025 online sales 约 USD 27.1M | 美国 maker 电子商务可能是千万美元级，不是零 | 不是公司披露数据，且不代表全市场 |

所以，比较稳的结论不是：

```text
美国 maker 模块 TAM 很大。
```

而是：

```text
美国 maker / SBC / IoT prototyping hardware spend 真实存在，
但公开可见的 maker-oriented module commerce 更像 low hundreds of millions 级别，
不是一个单独就能支撑巨大 VC 叙事的十亿美元级软件池。
```

如果把工业 SBC、IoT microcontroller、edge AI hardware 都加进来，数字会变大，但相关性会下降：

```text
数字越大，越不是 casual maker；
越接近 maker，公开可见的钱越小。
```

这就是报告里必须改掉的地方：模块消费只能做入口和证据，不能做主 TAM。

### 4.6 Blockless 能占多少：不能从硬件 GMV 直接推

Blockless 的可捕获收入不应该按 “硬件 GMV 抽成” 来推，因为你们不是卖模块 marketplace，也不应该把 AppStore 讲成抽成故事。

更合理的捕获模型是三层：

| 捕获层 | 付费对象 | 收费逻辑 | 粗略 ARR 含义 |
|---|---|---|---|
| Pro creator / prototype seat | maker-pro、embedded freelancer、AIoT builder、robotics demo builder | 省 setup/debug 时间，按 seat 或 usage 付费 | 10K seats x $20/month = USD 2.4M ARR；50K seats = USD 12M ARR |
| Vendor / module ecosystem | 模块厂商、kit 厂商、开发板厂商 | verified recipes、support-ticket reduction、example generation、compatibility graph | 100 vendors x $20K/year = USD 2M ARR；300 vendors x $30K/year = USD 9M ARR |
| Workshop / applied education / maker space | workshop、training、bootcamp、maker space、hardware accelerator | repeatable kits、agent-guided setup/debug、post-class recipe reuse | 更适合早期 pilot，不应作为主 TAM 夸大 |

这说明两件事：

1. **如果只卖给美国 casual hobbyist，maker 依然排第二，甚至排第三。**  
   原因不是社区没影响力，而是付费密度和可见 TAM 不够硬。

2. **如果 AppStore/recipe 真的降低二次分发和复现成本，maker 的战略价值会变高。**  
   但它变高的方式不是 marketplace 抽成，而是把一次成功运行变成：

```text
repeatable recipe
-> compatibility data
-> lower support burden
-> more successful module/project attempts
-> more paid agent runs
```

也就是说，AppStore 可以帮助解决二次分发 bottleneck，但它本身不是 TAM 证明。它是产品飞轮的一部分。

### 4.7 中国和美国的模块市场不是同一种打法

美国的强项是：

- Hackster / Adafruit / SparkFun / Raspberry Pi 这类全球影响力社区和品牌；
- AI coding / developer tooling 付费习惯；
- robotics / edge AI / physical AI 资本和研发预算；
- high-value prototype / consulting / startup budget。

中国的强项是：

- 深圳/长三角硬件供应链密度；
- 模块厂商、教育硬件、AIoT kit、机器人样机活动更密集；
- 创客空间、硬科技孵化器、线下 workshop 更容易和供应链连起来；
- 硬件 BOM、打样、采购、课程、渠道可能更快形成闭环。

所以市场顺序应该动态看，不是固定 “美国 maker 第二”：

```text
美国：AI-native developer workflow / pro prototyping / vendor devrel 更强。
中国：模块供应链 + AIoT/机器人样机 + workshop/渠道闭环更强。
```

如果 Blockless 的产品验证是 “agent 能帮美国 pro builder 快速跑通硬件”，美国更强。  
如果产品验证是 “模块厂商/创客空间/课程用 recipe 降低复现和售后”，中国可能更强。

这才是动态市场判断。

## 5. 数据层 D：美国市场怎么讲

美国市场不是没有数据。问题是不能照搬中国 “教育智能硬件” 数据。

美国更适合用三组证据：

```text
AI agent hardware toolchain
+ embodied/physical AI capital and research
+ paid prototyping / robotics / IoT budget
```

### 5.1 美国 AI agent + hardware

核心证据见第 2 节：

- Espressif MCP。
- Arduino Cloud AI Assistant。
- Anthropic/Espressif reference hardware。
- Skilled AI Agents embedded/IoT paper。

这组证据说明美国/全球 AI 工具体系正在把 agent 接到硬件执行链上。

### 5.2 美国 embodied / robotics

核心证据见第 3 节：

- Figure / OpenAI / Microsoft / NVIDIA。
- Skild AI。
- Physical Intelligence。
- FieldAI。
- Covariant。
- NVIDIA physical AI stack。
- Google DeepMind Open X-Embodiment。

这组证据说明美国市场能讲未来大品类：

```text
AI is moving from text/code to physical action.
```

Blockless 的切口：

```text
physical action needs hardware execution loops.
```

### 5.3 美国 paid prototyping / robotics budget

| 证据 | 数据 / 事实 | 说明什么 |
|---|---|---|
| Clutch US IoT | US IoT companies and project budget ranges；IoT POC / hardware prototyping / firmware work can reach tens/hundreds of thousands | 原型和 firmware 是已有付费服务 |
| Upwork / BLS | embedded freelance rates and software developer wage benchmarks | 工程时间节省能换算成价值 |
| GitHub Copilot | 4.7M paid subscribers、77K+ organizations；paid plans $10-$100/user/month | AI workflow acceleration 有已验证付费行为 |
| IFR Americas | 2024 年美国工业机器人 operational stock 393.7K，年安装量 34.2K；美国为全球第三大 industrial robot stock 市场 | robotics / automation 是美国真实产业支出 |
| U.S. educational robot market | 2024 revenue $416.3M，2030 projection $1.6575B，2025-2030 CAGR 27.5% | 美国也有 STEM / robotics learning hardware 增长，但只能辅助使用 |

### 5.4 更多美国/北美相关数据：按相关性分层

这些数据可以补报告，但必须带自我批判。不是每个 market size 都能直接变成 Blockless TAM。

| 数据 | 数字 | 和 Blockless 的关系 | 自我批判 |
|---|---:|---|---|
| U.S. Edge AI market | 2024 年 USD 6.8988B，2025-2030 CAGR 16.9% | 强相关。说明 AI inference / models 正在进入设备侧，agent+hardware 需要 edge context 和本地执行 | Edge AI 包含 enterprise/security/manufacturing，不等于 maker/prototype |
| North America Edge AI market | 2024 年约 USD 8.914B，2034 年预计 USD 62.494B，CAGR 21.5% | 强相关。说明北美 edge AI 是增长市场，可支撑 “AI moves onto devices” | 范围太宽，不能直接当 Blockless TAM |
| Edge AI accelerator market | 2024 年全球 USD 7.68B，2034 年预计 USD 94.27B；北美 2024 年约 USD 2.5B | 强相关。Blockless 服务的是这些 AI accelerator / IoT / robot devices 的开发和原型工作流 | Accelerator sales 不等于 software workflow revenue |
| U.S. industrial robotics | 2024 年 revenue USD 2.3474B，2030 年预计 USD 3.2123B | 中强相关。证明美国 robotics hardware spend 存在 | 工业机器人购买者不是 Blockless 初期用户；需要转成 prototyping/tools 逻辑 |
| U.S. AI robots market | 2025 年 USD 4.93B，2035 年预计 USD 32.62B，CAGR 20.8% | 中强相关。比 educational robots 更贴近 “AI + robot hardware” | 仍是宽泛市场报告，需谨慎；包含 hardware/software/services |
| AI in robotic platforms | 2024 年全球 USD 16.9B，2034 年预计 USD 313.1B；美国 2024 年估计 USD 5.3B | 强相关方向。说明 AI software is being embedded into robotic platforms | 来源是市场估算，不能作为唯一依据；要和 Figure/Skild/FieldAI 等具体融资事实结合 |
| AI-powered humanoid robots | 全球 2024 年 USD 352.3M，2034 年预计 USD 7.739B；美国 2024 年约 USD 169.3M | 中等相关。证明 humanoid/embodied AI 早期市场小但高增长 | Blockless 不卖 humanoid；只能证明 embodied AI prototype demand |
| North America manufacturing automation | 2030 年预计 USD 6.49B，2024-2030 CAGR 9.7% | 中等相关。说明 automation + AI/IoT/robotics 在制造业有预算 | 太 enterprise，不等于 creator tooling |
| U.S. educational robot market | 2024 年 USD 416.3M，2030 年预计 USD 1.6575B，CAGR 27.5% | 弱到中等。说明 robotics/STEM hardware learning 有增长 | 和 Blockless 最远：buyer 常是学校/家长，使用场景是学习，不是 agent+hardware creation |

### 5.5 为什么 educational robot 数据不够

`U.S. educational robot market = USD 416.3M` 的问题：

1. **产品形态不对**  
   Educational robot 是成品 robot / kit。Blockless 是 agent-to-hardware execution workflow。

2. **buyer 不对**  
   Educational robot 买方可能是学校、家长、培训机构。Blockless 初期更像 developer/prototype/maker-pro/module-vendor 工具。

3. **价值主张不对**  
   Educational robot 卖的是 learning outcome / STEM engagement。Blockless 卖的是 imagination -> working hardware 的执行效率。

4. **不能解释 AI agent**  
   Educational robot 市场增长不能证明 AI agent 能控制硬件、调试硬件、生成 recipe。

所以它只能写成：

```text
美国存在 robotics/STEM hardware learning spend，
但这不是 Blockless 主证据。
主证据应该是 AI agent hardware toolchains + edge AI hardware + embodied AI / robotics foundation model wave。
```

### 5.6 美国叙事结论

不要说：

```text
美国 maker 市场很大，所以 Blockless 很大。
```

要说：

```text
美国已经出现 AI agent -> hardware toolchain 的早期证据。
Embodied AI / physical AI 证明 AI 正在进入真实世界行动。
Paid prototyping / robotics / IoT 证明今天已有预算。
Maker 社区证明 imagination 和 physical creation intent。
Blockless 把这些合成一个 agent-to-hardware execution workflow。
```

## 6. 数据层 E：中国市场怎么讲

中国数据有价值，但不能说 “学校多，所以市场大”。

中国的强逻辑是：

```text
模块供应链密集
+ 创客空间 / 众创空间 / 硬科技孵化
+ AI 教育硬件和智能硬件消费
+ AIoT / robotics / embodied AI 原型热
+ 本地 workshop / kit / vendor support 场景
```

### 6.1 中国模块 / AIoT / 创客空间

| 证据 | 数据 / 事实 | 说明什么 |
|---|---|---|
| M5Stack | 3M+ products sold、400+ SKUs、181K+ community、660K+ UIFlow downloads | 中国模块化硬件公司已经能形成全球产品/社区/软件生态 |
| Seeed | 2024 review 围绕 edge AI、local LLM、TinyML、robotics、Jetson、vision demos、developer programs | 中国模块厂商已明显转向 AIoT / edge AI / robotics |
| 中国科技统计年鉴 / 火炬统计 | 众创空间作为统计对象，包含空间数、面积、团队、企业、融资、就业、IP 等 | 众创空间不是纯 hobby，而是经济基础设施 |
| 北京 2024 数据 | 北京孵化器/众创空间 500+ 家，孵化器参与投资基金超过 RMB 300 亿 | 中国 hard-tech incubation 和空间/资本/产业链更密集 |

### 6.2 中国 AI 硬件消费

| 证据 | 数据 / 事实 | 如何使用 |
|---|---|---|
| 多鲸教育研究院 | 2024 中国教育智能硬件市场预计突破 RMB 1000 亿，C 端超 RMB 800 亿，B 端超 RMB 200 亿 | 证明中国用户/渠道接受 AI + hardware + software/content/service package |
| RUNTO / 新浪 | 2024 中国学习平板销量 592.3 万台，销售额 RMB 190.6 亿，销量同比 +25.5%，销售额同比 +37.6% | 证明 AI/教育硬件消费增长，但不是 Blockless TAM |

正确用法：

```text
中国已经形成 AI 硬件消费习惯和渠道。
Blockless 不卖学习平板，也不卖学校采购。
Blockless 切的是更上游的 AIoT / robotics prototype creation workflow。
```

### 6.3 中国 robotics / embodied AI

| 证据 | 数据 / 事实 | 说明什么 |
|---|---|---|
| IFR global robotics | 2024 全球工业机器人安装量 542K，中国安装 295K，且中国是 top five markets 中唯一增长，+7% | 中国是全球最大工业机器人部署市场 |
| AP / MIIT data | 中国 2025 年有 140+ humanoid robot manufacturers 和 330+ models，但需求和 use cases 仍不成熟 | 具身智能原型活动密集，但商业化仍早 |
| 政府采购案例 | AI 教育平台、humanoid robot、机器人设备等采购案例存在 | 只能证明预算和试点，不证明可规模化 SaaS |

正确用法：

```text
中国 embodied AI 热会增加传感器、执行器、摄像头、控制器、边缘 AI 原型数量。
Blockless 服务的是这些 prototype loops，而不是直接卖机器人。
```

## 7. AppStore / Recipe 的真实价值

AppStore 不应该被说成 marketplace revenue story。

它的真实价值是：

```text
agent memory + compatibility graph + distribution surface
```

每个 recipe 必须包含机器可读事实：

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

### 7.1 不要把 AppStore / Recipe 讲成 embodied AI 数据飞轮

上一版把 recipe 数据和 embodied AI 数据连得太远，这个逻辑应该删掉。

Open X-Embodiment 这类数据集的核心是：

```text
robot embodiment
-> action trajectory
-> perception
-> task outcome
-> policy learning
```

Blockless recipe 的核心是：

```text
board / module / driver / pin / firmware / run log / known failure
```

这两者不是一类数据。Blockless recipe **不能**被说成 humanoid / robotics foundation model 的训练数据，也不能靠这个证明 embodied AI TAM。

更准确的说法是：

```text
AppStore / recipe 是硬件复现层，不是 embodied AI 数据层。
```

它能解决的是更低层、更现实的问题：

- 这个模块有没有可用 MicroPython driver；
- 这个 board 上能不能 import 相关模块；
- 这个 pin / bus / address 组合是否跑通过；
- 这个 recipe 是否能在另一台设备上复现；
- 哪些错误是 wiring / driver / firmware / package version 导致的；
- module vendor 能不能用 verified recipe 降低售后。

所以 AppStore / recipe 的商业价值不是：

```text
我们积累 embodied AI 数据，所以未来很大。
```

而是：

```text
我们把模块和项目从一次性教程变成可安装、可复现、可维护的硬件软件包。
```

这和 embodied AI 只有间接关系：embodied / AIoT 原型会用到更多 sensors、actuators、camera、edge boards，因此更需要低层硬件复现工具。但这不是主 TAM 证明。

不过这里不能只停在否定。更强的升级路径是：

```text
recipe -> endpoint manifest -> task harness -> endpoint run log
```

也就是说，Blockless recipe 本身不是 embodied AI 数据；但 recipe 可以成为 non-robot physical AI endpoint 的前置结构。

| 对象 | 现在是什么 | 升级后和 physical AI endpoint 的关系 |
|---|---|---|
| Recipe | board / module / driver / pin / firmware / run log | 证明某个 physical endpoint 可复现 |
| Endpoint manifest | 目前较弱 | 暴露 observation / action / constraint，让 agent 知道硬件能感知什么、能做什么 |
| Task harness | 目前基本没有 | 定义 goal、success、failure、timeout、safety，用于 physical task evaluation |
| Endpoint run log | 目前是 debug / telemetry | 记录 observation-action-result，用于 physical endpoint evaluation |

所以更准确的判断是：

```text
Blockless recipe is not embodied AI data.
But Blockless can become the infrastructure that creates reproducible non-robot physical endpoints,
and those endpoints can later produce task/evaluation/run data.
```

这个路径比“AppStore 数据飞轮”更严谨，也更有产品含义。要做到这一点，AppStore 不能只是项目分发，必须增加：

- endpoint manifest；
- task harness；
- run / rerun evidence；
- endpoint run log export；
- physical endpoint id；
- safety / constraint metadata。

否则，AppStore 仍然只是硬件 recipe marketplace，不能强接 embodied AI。

## 8. 商业化逻辑

### 8.0 Venture 是否成立：先说负面结论

如果 Blockless 的故事是下面这个版本，**venture 不成立**：

```text
美国 maker 社区很大
-> hobbyist 买模块
-> 我们做 AI 硬件工具
-> AppStore 分发
-> 以后接 embodied AI
```

原因很直接：

1. **美国 maker-oriented module TAM 不够硬**  
   公开可见的钱更多是几十万到几千万美元级公司/渠道，扩大到 SBC / IoT / edge hardware 后相关性下降。

2. **教育机器人比 maker module 更容易显得大，但 buyer 错位**  
   教育机器人是成品 kit / school / parent / curriculum spend。Blockless 是硬件创作执行工具，不能直接吃这个市场。

3. **美国硬件供应链不是 Blockless 的优势区**  
   美国有 AI developer tooling、capital、robotics research、prototyping budget，但没有中国这种模块密度、BOM 速度、线下硬件渠道和低成本迭代能力。

4. **纯软件订阅很难从 casual maker 身上拉出 venture 规模**  
   AI coding 可以靠 millions of software developers；AI hardware creation 的活跃付费人群小得多，且被物料、物流、接线、安全、兼容性卡住。

5. **AppStore 不解决供应链，只解决复现和分发**  
   如果用户买不到/等不起/接不对模块，recipe 再好也不够。

所以不能再讲：

```text
US maker + AppStore + embodied AI future = big venture.
```

这条线很弱。

### 8.1 成立条件：必须把中国供应链优势放进主叙事

Blockless 要像 venture，必须换成这个版本：

```text
AI lowers hardware creation friction
+ China module supply chain solves parts availability / speed / cost
+ Blockless standardizes module software layer and recipe reproducibility
+ vendor / kit / workshop / pro-builder economics pay for it
```

也就是说，Blockless 不是一个单纯美国 SaaS。它更像：

```text
AI-native hardware creation layer
backed by China module supply chain.
```

美国可以是：

- AI-native developer workflow 的品牌市场；
- robotics / AIoT / edge AI prototype 的高价值需求市场；
- investor narrative 和 early adopter 市场；
- pro builder / startup / consultant 的 seat market。

中国更可能是：

- 模块供应链市场；
- kit / workshop / education hardware / AIoT demo 的落地市场；
- vendor partnership 市场；
- AppStore recipe 和硬件 SKU 标准化的高密度试验场。

这不是 “美国 or 中国” 二选一，而是：

```text
美国负责证明 AI-native workflow 价值；
中国负责解决硬件供给、复现、成本和渠道密度。
```

如果不能拿到中国供应链/模块厂商/kit 渠道的实际合作，只在美国卖软件工具，这个项目会很难撑起 venture。

### 8.2 重新排序后的短期 wedge

短期应该按可付费强度重新排序：

| 排名 | Wedge | 为什么比 casual maker 强 | 需要验证什么 |
|---:|---|---|---|
| 1 | 模块厂商 / kit 厂商 | 他们有明确售后、教程、兼容性、示例代码成本 | verified recipe 是否减少 support ticket / 提高模块转化 |
| 2 | 中国 workshop / 创客空间 / AIoT 课程 / 硬件训练营 | 供应链近、项目可标准化、线下复现成本高 | 一套 kit 能否多次复用、降低老师/助教支持 |
| 3 | Pro prototype builders / AIoT consultants | 时间就是钱，愿意为调试加速付费 | first-working-run 时间是否明显下降 |
| 4 | 美国 maker-pro / robotics hobbyist | 有影响力和内容传播，但付费密度不确定 | repeat usage 和付费转化 |
| 5 | 普通 hobbyist / casual maker | 大量人感兴趣，但 ARPU 和留存最弱 | 不能作为早期商业核心 |

### 8.3 长期扩容必须依赖硬件交易或 vendor economics

长期扩容不能只写：

```text
AI lowers creation barrier
-> more people attempt physical projects
-> more agent hardware runs
-> more recipes and compatibility data
-> better agent
-> lower barrier again
```

这太像软件世界的自然增长，硬件不一样。硬件扩容必须同时解决：

- 模块买得到；
- 模块足够标准化；
- driver 和 package 可安装；
- wiring / pin / bus 组合可验证；
- 失败能被归因；
- recipe 能复现；
- vendor / channel / kit 有经济收益。

更真实的长期路径是：

```text
standardized modules / kits
-> verified recipes
-> lower support and setup cost
-> more module / kit sales
-> vendors fund better package/recipe coverage
-> agent gets more reliable
-> more creators can build
```

这个路径里，Blockless 的收入不应该只来自 software subscription，还应该考虑：

- vendor SaaS / verified recipe fee；
- module / kit attach 或硬件 GMV 分成；
- workshop / curriculum / kit licensing；
- pro builder usage-based credits；
- enterprise prototype package。

没有硬件交易或 vendor economics，只靠美国 hobbyist subscription，venture 规模不够。

### 8.4 Prototype-first 市场到底大不大

结论：**直接市场现在不大，相关预算池很大，增长逻辑成立，但必须从“工具”扩成“原型标准化 + 模块/kit/vendor economics”。**

不能说已经存在一个清晰的：

```text
AI hardware prototyping software TAM
```

公开市场报告里没有这个成熟品类。更合理的做法是看三层相邻市场：

| 层级 | 市场 / 预算池 | 数据 | 和 Blockless 的关系 | 自我批判 |
|---|---|---:|---|---|
| 最大外圈 | Product engineering services | Grand View Research: global 2024 USD 1.2635T，2030 USD 1.814T，2025-2030 CAGR 6.4%；North America 2024 revenue share >40% | 说明企业为产品研发、工程服务、time-to-market 花的钱极大 | 过宽，绝大部分不是硬件 prototype，也不是 software tool |
| 工业软件外圈 | Industrial software | IoT Analytics: 2024 global industrial software >USD 160B，2030 前 CAGR 13.5%；包含 CAD、EDA、PLM、machine control 等 | 说明制造/工业工程软件预算在增长，AI/automation/IIoT 拉动 | 偏 enterprise，不是初期用户 |
| IoT/实施预算 | IoT professional services | 多个市场报告口径约 USD 120B-130B in 2023/2024，2030/2032 到 USD 190B-226B | 说明 IoT 集成、部署、咨询、工程实施有预算 | 服务市场不等于工具市场 |
| 实体 prototype 类比 | 3D printing prototyping application | BCC 摘要口径：3D printing prototyping application 2024 约 USD 9.9B，2029 约 USD 14.0B，CAGR 7.2% | 说明“加速实体原型”本身是可付费需求 | 这是机械/制造原型，不是电子模块/固件 |
| 边缘智能背景 | Edge AI / industrial edge | Edge AI、industrial IoT、OPC UA 等都在增长 | 会增加 camera/sensor/actuator/controller/edge gateway 的 prototype 需求 | 不能直接当 Blockless TAM |

所以市场大小要这样讲：

```text
不是已有一个很大的 AI hardware prototyping software market；
而是产品工程、IoT 工程、工业软件、edge AI、快速原型这些大预算池里，
有一块反复出现的 bottleneck：把 idea 快速变成可运行的 physical prototype。
```

这比 maker TAM 强，因为付费对象不是 casual hobbyist，而是：

- 硬件创业公司；
- AI hardware / AIoT prototype team；
- 模块厂商 / kit 厂商；
- 产品工作室；
- embedded / IoT consultant；
- workshop / applied hardware course；
- robotics / edge AI demo builder。

但这仍然不是自动的大市场。Blockless 必须证明：

```text
manual prototype: days / weeks / many support loops
Blockless prototype: minutes / hours / repeatable recipe
```

如果只做到 “AI 生成代码”，市场会很小。  
如果做到 “模块供应链 + driver/package + local deploy + recipe + vendor support reduction”，市场才可能变大。

### 8.5 如果考虑 one-person company

如果 OPC 指 one-person company，这个方向比 maker TAM 更接近 Blockless。

一人公司的核心不是：

```text
更多 hobbyist 买模块。
```

而是：

```text
一个人能不能完成过去需要硬件小团队才能完成的 physical product prototype。
```

软件里，一人公司被 AI coding 放大，因为一个人可以完成：

- product idea,
- frontend,
- backend,
- database,
- deployment,
- content,
- sales page.

硬件里，一个人被卡住的地方更多：

- 选模块；
- 买 BOM；
- 接线；
- driver；
- firmware；
- flash / run；
- 串口调试；
- 外壳 / 结构；
- 小批量供应；
- 复现和售后。

所以 Blockless 和 one-person company 的关系是：

```text
AI coding makes one-person software companies possible.
Blockless tries to make one-person physical prototype companies possible.
```

这比 “maker 市场很大” 强，因为它不是在证明今天有多少 hobbyist 付费，而是在证明：

```text
AI 把个人创业的能力边界从 software 推到 physical products。
```

但也要自我批判：

1. **一人 hardware company 不等于一人量产公司**  
   prototype 可以一人完成，供应链、认证、品控、售后、物流仍然需要外部网络。

2. **Blockless 只能解决 prototype 到 small-batch 前的一段**  
   它不解决外壳、认证、质量体系、库存和渠道。

3. **中国供应链仍是必要条件**  
   没有模块/kit/小批量制造支持，一人公司故事会停在 demo。

所以更准确的叙事是：

```text
Blockless is infrastructure for one-person physical product prototyping,
not a full-stack one-person hardware company platform yet.
```

如果未来接上模块采购、kit fulfillment、小批量打样、外壳/PCB/装配伙伴，它才可能从 prototype tool 上升到：

```text
one-person physical product company stack.
```

但硬件比软件更难，所以 Blockless 的核心必须是 grounding：

```text
board profiles
module manifests
driver/package versions
wiring/pins
deploy logs
run evidence
safety boundaries
```

### 8.6 Bottom-up TAM / SAM / SOM：只能用假设模型，不能装成市场报告

这里最重要的是克制。公开数据不能直接回答 “AI hardware prototyping software TAM 多大”，所以只能做 bottom-up 估算，并把每个假设暴露出来。

可用的硬证据和半硬证据是：

| 数据点 | 能说明什么 | 不能说明什么 |
|---|---|---|
| Kickstarter 官方统计：Technology 累计 59,582 个 launched projects，成功 14,793 个，累计 pledged dollars 约 USD 2.00B；截至 2026-01-17 有 236 个 live Technology projects | 公开硬件/技术项目有持续供给，且不是纯内容社区 | Kickstarter 是公开融资漏斗，不等于全部硬件原型，也不等于软件付费意愿 |
| BackerBench Technology 数据：2009-2026 样本 32.6K，成功率 33.1%，median goal USD 12,761；USD 100K+ goal 的成功率只有 9.3% | Technology crowdfunding 是高失败率市场；多数项目不是成熟公司，而是风险很高的原型/产品化尝试 | BackerBench 不是官方 Kickstarter 数据；只能做结构性参考 |
| BackerBench geography：Technology 大体量国家里 Hong Kong creators success rate 77.4%，明显高于类目均值 | 靠近供应链、制造和履约能力会影响硬件项目成功率，这支持“中国供应链必须进主叙事” | Hong Kong 不等于整个中国供应链，也不证明 Blockless 自带转化 |
| Espressif 2025H1 报告：M5Stack 每周推出约 1 个新硬件产品，300+ SKUs，主要卖给 industrial、education、developer markets | 模块 SKU 速度是真实的，且模块厂商有 motive 帮开发者更快 prototype / design-in | 这证明 vendor-side 场景，不证明终端 builder 会直接买软件订阅 |
| Seeed 2024 year-in-review：AI sensing、AI robotics、XIAO、Grove Vision AI、Jetson/reComputer 等产品线扩张 | 深圳模块厂商正在把 maker、AI hardware、robotics、edge AI 混到同一个供给侧体系里 | 这是单个厂商叙事，不能外推成全市场 GMV |
| Clutch 美国 IoT development listing：2026-06-05 更新，United States 口径 1,111 companies；常见项目门槛从 USD 5K/10K/25K/50K 到 USD 250K+，时薪常见 USD 50-300 | IoT / connected-device 原型和实施有真实服务预算，时间节省有付费基础 | listing 不是成交数据，也不是 Blockless 可直接替代的市场 |
| Prototype agency cost proxy：含 electronics 的产品开发 / prototype 容易超过 USD 50K；低复杂度非电子 prototype 也可到 USD 15K-40K | first-working-run 如果能从天/周降到小时，会触碰到真实预算 | 代理开发成本不能直接变成工具 ARPA，只能证明痛点有经济价值 |

所以估算应该从“谁会为 first working hardware run 付钱”开始，而不是从 broad market report 开始。

| 人群 / 付费方 | Bottom-up 口径 | 年付费假设 | 保守 | Base | Aggressive | 自我批判 |
|---|---:|---:|---:|---:|---:|---|
| Serious one-person physical product builders | 愿意反复尝试硬件原型的个人/小团队 | USD 300-800 / seat / year | 20K-50K 人 -> USD 6M-15M | 100K-250K 人 -> USD 30M-200M | 500K-1M 人 -> USD 150M-800M | 这是最大的不确定项；必须由 waitlist、活跃 run、付费转化验证 |
| Pro prototype builders / AIoT consultants | embedded / IoT freelancer、小工作室、产品工作室 | USD 500-2,000 / year 或 usage credits | 5K-10K 个 -> USD 2.5M-20M | 20K-50K 个 -> USD 10M-100M | 100K 个 -> USD 50M-200M | consultant 可能用现有工具链，不一定换 workflow |
| Module / kit vendors | 模块厂商、套件厂商、渠道商 | USD 5K-50K / year verified recipe / support-reduction package | 100-300 家 -> USD 0.5M-15M | 500-1,500 家 -> USD 2.5M-75M | 3K+ 家 -> USD 15M-150M+ | vendor 愿付费要靠 support ticket reduction / attach rate 证明 |
| Workshops / applied hardware courses | 训练营、创客空间、AIoT 课程、企业 workshop | USD 1K-20K / year / program | 200-500 个 -> USD 0.2M-10M | 1K-3K 个 -> USD 1M-60M | 10K 个 -> USD 10M-200M | 教育和 workshop 容易项目制，留存未必好 |
| Project / prototype credits | 每次完整 intent -> run -> repair -> recipe 收费 | USD 20-200 / project | 20K-50K projects -> USD 0.4M-10M | 250K-1M projects -> USD 5M-200M | 2M-5M projects -> USD 40M-1B | 只有当成功率和节省时间明显，usage 才能成立 |
| BOM / kit attach | verified recipe 绑定模块 / kit / BOM | 5%-20% margin / take | USD 5M-20M GMV -> USD 0.25M-4M | USD 50M-200M GMV -> USD 2.5M-40M | USD 500M+ GMV -> USD 25M-100M+ | 这需要供应链和履约，不是纯软件能力 |

粗略结论：

| 场景 | Revenue pool | 成立条件 |
|---|---:|---|
| Conservative | USD 10M-40M / year | 只吃少量 serious builders、consultants、workshops，vendor 付费还没跑通 |
| Base | USD 50M-250M / year | software seats + project credits + vendor recipes 至少两条成立 |
| Aggressive | USD 300M-1B+ / year | Blockless 从 prototype tool 扩到 verified recipe、BOM/kit attach、vendor network、小批量履约入口 |

这张表不能拿去当“已验证 TAM”。它的作用是定义验证路线：

```text
如果只靠 hobbyist subscription，venture 不成立；
如果能证明 first-working-run 提速 + recipe 复现 + vendor/kit economics，
才有机会从小 devtool 变成 AI-native physical prototyping infrastructure。
```

### 8.7 Capture layers：Blockless 到底拿哪一层钱

Blockless 不应该只押一个 pricing model。更合理的是分层捕获：

| Capture layer | 收费对象 | 可验证指标 | 风险 |
|---|---|---|---|
| Software seats | serious builders、consultants、workshop instructors | paid activation、weekly hardware runs、repeat run retention | 人群规模可能偏小 |
| Project credits | 原型项目 / run-repair-recipe loop | first-working-run 成功率、平均节省小时数、repair loop 完成率 | 如果结果不稳定，usage 付费会很弱 |
| Verified recipe SaaS | module / kit vendors | support ticket reduction、recipe install/rerun rate、module conversion lift | vendor 销售周期比个人长 |
| BOM / kit attach | builder + vendor + channel | kit attach rate、GMV、refund/support rate | 需要供应链、库存、履约和售后能力 |
| Workshop package | 课程、训练营、创客空间 | per-cohort setup time、助教支持次数、学生成功率、kit reuse rate | 容易变成服务交付 |
| Small-batch / fulfillment partner take-rate | 成功 recipe 后的小批量需求 | prototype -> kit -> small batch conversion | 距离当前产品最远，不能过早承诺 |

短期最现实的组合不是：

```text
maker subscription + AppStore take-rate
```

而是：

```text
pro builder seats / credits
+ vendor verified recipe package
+ workshop/kit pilots
```

长期如果要上 venture scale，必须接上：

```text
verified recipe -> BOM -> kit -> small-batch fulfillment
```

否则 Blockless 会更像一个好用的 MicroPython AI tool，而不是能长大的硬件原型基础设施。

### 8.8 可以更明确地说：美国 maker 路线很难走，中国应成为落地验证主线

可以说：

```text
美国 maker 适合做叙事、内容传播、早期 credibility；
但如果把它当商业主线，路会很难。
Blockless 的商业验证更应该走中国：模块厂商、kit、workshop、AIoT/机器人原型、供应链 attach。
```

但这句话要讲准。不是因为“中国 maker 更多”，而是因为中国更接近 Blockless 要解决的硬件闭环：

| 维度 | 美国 maker 路线 | 中国路线 |
|---|---|---|
| 需求形态 | 兴趣、教程、内容、个人项目更多 | 模块 SKU、kit、课程、厂商 demo、AIoT/机器人样机更多 |
| 付费方 | casual maker ARPU 不清晰；pro builder 数量有限 | vendor、kit 商、workshop、硬件创业团队、AIoT 集成商更可能为复现和售后降本付费 |
| 供应链 | 模块和小批量履约离用户更远，物流/价格/库存摩擦更高 | 深圳/长三角模块、PCB、SMT、外壳、传感器、渠道更近 |
| 产品闭环 | 容易停在 “AI 生成代码 / 教程” | 更容易跑通 “recipe -> BOM -> kit -> workshop/vendor support reduction” |
| 风险 | 市场显得体面，但收入密度不够 | 需要重运营、BD、供应链协同，不能只做 SaaS |

中国侧更强的证据不是宏观教育硬件市场，而是供给侧事实：

| 证据 | 对 Blockless 的含义 | 自我批判 |
|---|---|---|
| M5Stack 官方称其有 400+ SKUs、3M+ products sold globally、181K+ global maker/developer community、MicroPython/Arduino/PlatformIO 兼容，并强调 modular IoT rapid prototyping | 证明中国模块厂商已经在做“模块化硬件 + 软件工具 + 全球开发者”的组合；Blockless 可切入 recipe / driver / run / repair 层 | M5Stack 自己也有 UiFlow / StackFlow AI，可能既是伙伴也是竞争者 |
| Seeed 2024 year-in-review 把 AI sensing、AI robotics、XIAO、Grove Vision AI、Jetson/reComputer、Co-Create 服务放在同一条产品/服务线上 | 证明深圳模块厂商已经把 maker、edge AI、robotics、co-create、小批量产品化混在一起；这正是 Blockless 需要 attach 的链路 | Seeed 已有 Fusion / Co-Create 能力，Blockless 必须补“agent-to-real-device execution”，不能只做商城 |
| DFRobot 官方称其从本地 maker community 起家，产品线覆盖 Arduino、LattePanda、Raspberry Pi、micro:bit、K12 kits，并有自有工厂与在线文档 | 证明模块/kit 厂商的真实痛点不只是卖货，而是文档、示例、教学、售后和项目复现 | 教育 kit buyer 和 Blockless 的 pro prototype buyer 不完全一样 |
| 国家统计局的创新创业类服务机构统计制度覆盖孵化器、众创空间、大学科技园等；《中国科技统计年鉴》《中国火炬统计年鉴》持续统计众创空间运营、服务团队、初创企业、投融资等 | 证明中国有可触达的创新创业载体网络，可以做 workshop / accelerator / 硬件训练营 pilot | 众创空间不等于付费市场；很多载体偏政策和活动，不能把数量直接当 TAM |
| 工信部 2024 年完成 178 家国家高新区综合评价 | 中国硬件/AIoT/科技企业分布有园区和地方政府入口，适合做区域试点和厂商/课程/产业园合作 | 园区 BD 周期长，不能作为产品早期唯一路径 |

所以，中国路线不是“去中国卖给普通创客”。更准确是：

```text
从中国模块/kit/供应链侧拿到标准化硬件对象，
用 Blockless 把它们变成可运行、可复现、可分发、可售后降本的 recipe，
再把这些 recipe 推给 pro builder、workshop、AIoT/机器人原型团队和海外 developer。
```

### 8.9 中国落地计划：先跑 vendor / kit / workshop，再谈 C 端 maker

目标不是“大规模铺市场”，而是用 90 天证明三件事：

```text
1. 中国模块 SKU 可以被 Blockless 标准化成 verified recipe；
2. verified recipe 可以显著降低 first-working-run 和支持成本；
3. vendor / workshop / pro builder 中至少一个愿意付费。
```

#### Phase 0：两周内定义最小可验证对象

不要一开始覆盖所有硬件。先选 3 条高频、可演示、可重复的 prototype lane：

| Lane | 为什么选 | 初始硬件组合 |
|---|---|---|
| AI sensing | 贴合 edge AI / embodied AI 叙事，容易 demo | XIAO / ESP32-S3 + camera / mic / Vision AI / sensor |
| Sensor-to-action | 最能证明真实物理闭环 | ESP32 / M5Stack + 温湿度/距离/IMU + relay / servo / motor |
| Connected field device | 更接近 AIoT / 工业边缘 | LoRa / RS485 / CAN / MQTT + display / logger / cloud bridge |

两周交付物：

- 10 个 verified recipe；
- 每个 recipe 必须包含 board、module、pin/bus、driver/package、install method、expected serial output、known failure、repair hint；
- 每个 recipe 至少在两台设备或两套环境上 rerun；
- 记录 baseline：人工照教程跑通要多久，Blockless 跑通要多久。

#### Phase 1：30 天 vendor pilot

找 2-3 家模块/kit 厂商，不要泛泛谈战略合作，直接卖一个具体包：

```text
Verified Recipe Pack for 20 SKUs
```

厂商可获得：

- 每个 SKU 的 MicroPython / package / wiring / example recipe；
- Blockless AppStore 页面；
- “一键安装 / 一键运行 / 串口输出验证”；
- support FAQ：常见接线、驱动、版本、供电错误；
- dashboard：install、run、failure、repair、rerun 指标。

Blockless 要验证：

| 指标 | 目标 |
|---|---:|
| first-working-run median time | 比官方教程 / 人工流程下降 5x 以上 |
| recipe rerun success rate | 70%+ |
| failed run 可归因率 | 60%+ |
| vendor support FAQ 命中率 | 30%+ |
| 厂商付费意愿 | RMB 3万-20万 / 年 / vendor package 的真实报价测试 |

#### Phase 2：60 天 workshop / 训练营 pilot

选择 2 类场景：

- AIoT / edge AI workshop；
- 机器人 / 传感器-执行器课程。

每场 10-30 人，使用统一 kit。不要把目标设成“大家觉得好玩”，而是看：

| 指标 | 目标 |
|---|---:|
| 到 first working run 的中位时间 | 30-60 分钟内 |
| 需要老师/助教介入次数 | 比传统教程下降 50% |
| 同一 recipe 跨电脑/跨板子复现率 | 70%+ |
| 课后 7 天内 repeat run | 30%+ |
| 机构付费意愿 | RMB 5千-3万 / cohort 或 RMB 3万-10万 / 年 |

这一步的价值不是教育市场 TAM，而是证明：

```text
Blockless 能把一次硬件活动从“老师现场救火”变成“recipe 驱动的可复现流程”。
```

#### Phase 3：90 天形成中国侧商业闭环

90 天后必须能回答：

| 问题 | 判断标准 |
|---|---|
| 谁付钱最快？ | vendor、workshop、pro builder 三者里至少一个出现 paid pilot |
| 哪些硬件最适合 Blockless？ | 不是最酷的硬件，而是 run/repair/recipe 成功率最高、复现最稳定的 SKU |
| Blockless 是否真的降低售后？ | vendor support issue 中 wiring/driver/version 类问题是否减少 |
| 是否能形成硬件 GMV attach？ | recipe 页面能否带出 kit / BOM / 模块购买 |
| 是否能反哺美国叙事？ | 中国 verified recipe + 全球开发者使用，能否证明 supply-chain-backed AI hardware prototyping |

90 天可对外讲的版本应该是：

```text
We verified 20-50 China-supply-chain module recipes,
reduced first-working-run from hours/days to minutes,
and showed vendors/workshops will pay for reproducible AI hardware prototypes.
```

中文：

```text
我们不是在中国做 maker 社区。
我们在中国把模块供应链变成 AI agent 可执行、可复现、可售后降本的硬件 recipe 网络。
```

### 8.10 中国路线的风险和反证标准

这条路更强，但也更重。必须提前写清楚什么情况说明它不成立：

| 风险 | 反证信号 | 应对 |
|---|---|---|
| 厂商不愿付费 | 只愿意给样品，不愿意为 recipe / support reduction 付费 | 转向 workshop / pro builder；vendor 只作为 supply partner |
| recipe 维护成本过高 | driver、firmware、SKU 版本变化导致持续失效 | 限定 certified SKU；建立 versioned recipe；不要开放无限 SKU |
| workshop 变成服务公司 | 每场都靠人工支持，软件没有复用 | 强制记录 support tickets，把高频问题产品化 |
| 供应链 attach 太早 | BOM/kit 履约拖慢软件验证 | 前 90 天只做 referral / curated BOM，不碰库存 |
| 中国市场不买 SaaS | 厂商压价、客户要求定制 | 定价从 SaaS 改为 vendor package / recipe certification / workshop package |

如果 90 天内出现下面结果，就要承认中国路线也没跑通：

```text
verified recipe 复现率低于 50%；
first-working-run 没有显著提速；
vendor / workshop / pro builder 都不愿意付费；
所有成功都依赖人工服务，无法沉淀成 recipe。
```

反过来，如果跑通，Blockless 的主叙事可以改成：

```text
China supplies modular hardware density.
Blockless supplies the AI-native execution and reproducibility layer.
The U.S. supplies developer adoption, capital narrative, and high-value AI hardware prototypes.
```

### 8.11 中国为什么不是“另一个市场”，而是 Blockless 的执行层试验场

如果继续沿着 prototype-first 的逻辑，中国的价值不是多卖几个订阅，而是提供一个美国很难复制的实验环境：

```text
hardware SKU density
+ local vendor access
+ low-friction BOM / PCB / PCBA / shell / assembly
+ workshop / incubator / industrial park entry points
+ AIoT / robotics application pressure
= agent-to-hardware execution layer 的最佳验证场
```

美国更像前台市场：

- AI-native workflow adoption；
- 英文开发者传播；
- VC narrative；
- robotics / AI hardware 的高价值场景；
- 和 “Cursor for hardware” 类比更容易被理解。

中国更像后台能力：

- 模块/kit 标准化；
- BOM 和供应链；
- 厂商 support reduction；
- 线下 workshop 复现；
- 小批量从 recipe 到 kit 的交付路径。

这两者应该分工，而不是二选一：

| 模块 | 美国承担 | 中国承担 |
|---|---|---|
| Narrative | AI coding -> physical prototyping | supply-chain-backed execution layer |
| Early users | pro builder、AI hardware founder、robotics hobbyist | vendor、kit 商、AIoT/机器人 workshop、硬件创业团队 |
| Proof | developer workflow、capital story、英文 demo | recipe 复现率、SKU 覆盖、support 降本、kit attach |
| Revenue | seats / credits / pilot | vendor package / workshop package / BOM attach |
| Moat | brand、workflow、agent UX | 硬件上下文数据、vendor relationship、verified SKU graph |

所以更强的公司定位不是：

```text
中国市场 + 美国市场。
```

而是：

```text
US-facing AI-native workflow
backed by China-verified modular hardware execution.
```

如果要讲给美国投资人，主语仍然可以是美国熟悉的 AI workflow；但证据和壁垒要来自中国：

```text
我们不是只写代码。
我们在中国供应链里验证模块、driver、pin、BOM、run log 和 failure mode，
再把这些变成全球开发者可复用的 physical prototype recipes。
```

### 8.12 中国侧 ICP：先不要碰泛 maker，要找“有支持成本的人”

Blockless 在中国的第一批 ICP 不应该是普通创客，而是已经被“别人跑不起来”困扰的人。

| ICP | 真实痛点 | Blockless 卖点 | 进入方式 | 付费形式 |
|---|---|---|---|---|
| 模块厂商 | 文档过时、示例代码碎、用户接线错、售后重复 | verified recipe + run evidence + FAQ automation | 选 20 个高频 SKU 做 recipe pack | RMB 3万-20万 / 年 |
| Kit 厂商 | kit 买了不会跑、课程复现率低、项目一换电脑就坏 | kit-level one-click run / repair / recipe page | 从 AIoT / robot / sensor kit 切入 | kit certification fee + package |
| Workshop / 训练营 | 老师和助教大量救火，硬件环境不一致 | cohort dashboard + per-student run status + guided repair | 10-30 人小课试点 | per-cohort RMB 5千-3万 |
| AIoT / 机器人 demo 团队 | demo 组合多，传感器/执行器/边缘板难联调 | prototype lane templates + hardware context + log repair | 从具体 demo 任务切入 | project credits / pilot fee |
| 硬件创业团队 | MVP 阶段缺 firmware / module integration 能力 | 从 intent 到 working prototype 的加速 | accelerator / 孵化器 / 园区 | seats + project credits |
| 供应链服务商 / PCBA 服务 | 客户从模块 prototype 到 PCB/PCBA 中间断裂 | recipe -> BOM -> schematic/PCB handoff | 和 Seeed Fusion / JLCPCB-like service 联动 | referral / package / co-sell |

这个 ICP 顺序的关键是：先找已有预算或已有损失的人。

```text
普通 maker 的痛点是“我想做但懒得学”；
vendor / workshop / startup 的痛点是“别人做不出来会让我损失钱”。
```

这就是为什么中国路线更适合商业验证。中国不是因为“爱好者更多”，而是因为更容易找到愿意为复现率、售后、课程成功率、kit 转化率付钱的组织型客户。

### 8.13 中国侧 BD playbook：不要卖平台，卖可验收的 recipe package

早期 BD 不能讲大平台。应该拿一个非常具体的交付物去谈：

```text
20-SKU Verified Recipe Pack
```

标准报价可以设计成三档：

| Package | 交付 | 价格假设 | 适合对象 |
|---|---|---:|---|
| Starter | 10 个 SKU recipe + AppStore 页面 + basic run logs | RMB 1万-3万 / 一次性 | 小 vendor / workshop |
| Vendor Pro | 20-50 个 SKU recipe + failure FAQ + analytics + quarterly update | RMB 5万-20万 / 年 | 模块/kit 厂商 |
| Ecosystem | 100+ SKU graph + workshop package + co-branded recipe library + BOM attach | RMB 30万-100万+ / 年 | 大厂商 / 园区 / 渠道 |

第一次谈判不要问：

```text
你们愿不愿意买一个 AI 硬件平台？
```

要问：

```text
你们最常被用户问爆的 20 个模块/kit 是哪些？
这些问题里多少是 wiring、driver、dependency、firmware、环境不一致？
如果我们把它们做成可一键运行、可复现、可定位失败原因的 recipe，
能否减少售后、提高 kit 转化、或者提升课程成功率？
```

每个 BD conversation 都要拿到 5 个数据：

| 数据 | 为什么重要 |
|---|---|
| 每月 support ticket 数 | 判断 support reduction 是否能付费 |
| Top 20 问题 SKU | 决定 recipe 优先级 |
| 当前示例代码维护人力 | 判断 vendor ACV |
| kit / SKU 的月销量区间 | 判断 BOM attach 价值 |
| 是否有 workshop / 渠道 / 海外客户 | 判断 recipe 分发价值 |

这会把 Blockless 从“AI 工具”变成“厂商售后和转化工具”。这比直接卖给 maker 更接近钱。

### 8.14 中国路线要求产品做哪些能力

如果走中国 vendor / kit / workshop 路线，产品不能只做 chat + code generation。必须增加几类产品面：

| 产品能力 | 为什么必须有 | 最小版本 |
|---|---|---|
| SKU registry | 中国供应链 SKU 多、版本多、接口多，没有 registry 就无法复现 | board/module/vendor/variant/version 表 |
| Versioned recipe | driver、firmware、示例代码会变；recipe 必须可版本化 | recipe v1/v2、tested date、compatible firmware |
| Run evidence | vendor 和 workshop 不会只信生成代码，要看跑通过 | serial output、screenshot/log、device ID、timestamp |
| Failure taxonomy | support 降本依赖错误归因 | wiring / power / driver / package / pin / firmware / unknown |
| Cohort dashboard | workshop 场景需要看到谁跑通、谁卡住 | 每个学生设备状态、last error、repair hint |
| Vendor dashboard | 厂商关心哪些 SKU 被安装、失败、复现 | install/run/rerun/failure/support deflection |
| BOM attach | 长期收入要接硬件购买 | recipe -> curated BOM -> vendor link |
| Certified recipe badge | 厂商和用户需要信任标记 | tested by Blockless / vendor verified |

这些能力有一个共同点：它们都在把 Blockless 从 “LLM 生成代码” 推向 “hardware execution infrastructure”。

技术上，repo 已经有一部分骨架：

| 已有骨架 | 还能怎么扩 |
|---|---|
| `driver_context/*.json` | 增加 vendor、SKU、version、known_failures、test_matrix |
| package resolver | 增加 vendor preferred package、firmware compatibility |
| AppStore / `.mpk` / `app_index.json` | 增加 certified recipes、BOM attach、run evidence |
| telemetry events | 增加 vendor/workshop dashboard metrics |
| local mpremote run/debug | 增加 standardized verification script 和 recipe rerun report |

所以中国路线不是另开一条产品线，而是把现有技术骨架商业化：

```text
driver context -> verified recipe
telemetry -> run evidence
AppStore -> vendor/workshop distribution
package resolver -> support reduction
local run/debug -> first-working-run proof
```

### 8.15 中国供应链 attach：短期不要碰库存，先碰 BOM 和 referral

Blockless 最终可能接硬件交易，但早期不能直接做库存和履约。正确顺序应该是：

```text
recipe -> curated BOM -> vendor link -> kit bundle -> small-batch handoff
```

每一步都要有门槛：

| 阶段 | 做什么 | 什么时候进入下一步 |
|---|---|---|
| Curated BOM | recipe 页面列出经过验证的模块和替代 SKU | recipe rerun rate >70% |
| Vendor link | 给官方店 / 淘宝 / AliExpress / distributor 链接 | 有稳定 install/run 转化 |
| Kit bundle | 和 vendor 打包成一个 kit | 同一 recipe 被 3 个以上 workshop 或 100+ users 使用 |
| Small-batch handoff | 转给 Seeed Fusion / JLCPCB / PCBWay 类服务 | 有明确从模块 prototype 到 PCB/PCBA 的需求 |
| Own fulfillment | 自营库存/履约 | 很晚才考虑，除非 GMV 足够大且售后可控 |

这能避免 Blockless 太早变成电商或供应链公司。它应该先证明：

```text
recipe 能影响硬件购买。
```

而不是一开始就试图自己卖硬件。

中国供应链平台已经有成熟角色：

- M5Stack / Seeed / DFRobot：模块、kit、文档、社区；
- Seeed Fusion：PCB/PCBA、customization、Co-Create；
- EasyEDA + LCSC + JLCPCB：EDA、元器件、PCB/SMT 的一体化链路；
- PCBWay 等：PCB prototype / low-volume assembly。

Blockless 的位置应该避开和这些平台正面竞争：

```text
不是替代他们制造硬件；
而是让他们的硬件更容易被 AI agent 跑起来、复现、分发、转化。
```

### 8.16 中国路线的 6 个月里程碑

如果 90 天验证通过，后面 6 个月应该按下面节奏推进：

| 时间 | 目标 | 交付 | 成功标准 |
|---|---|---|---|
| Month 1 | 10 recipes / 2 vendors | verified recipe baseline | first run 提速 5x，rerun 70% |
| Month 2 | 30 recipes / 1 workshop | cohort dashboard v0 | workshop 成功率 70%+ |
| Month 3 | paid pilot | vendor 或 workshop 付费 | 至少 RMB 3万 paid pilot |
| Month 4 | 100 recipes | SKU registry + certified badge | 20% recipes 有 repeat external users |
| Month 5 | BOM attach | curated BOM + vendor links | recipe -> BOM click/attach 可测 |
| Month 6 | China-to-US proof | 英文 case study + demo video + metrics | 可用于美国融资叙事 |

第 6 个月对外材料不应该是宏观市场报告，而应该是实证指标：

```text
100 verified recipes
X vendors / Y workshops
median first-working-run time reduced by Z%
rerun success rate A%
support issue categories reduced / deflected B%
BOM attach C%
```

这比 “中国硬件市场很大” 有说服力得多。

### 8.17 结论更新：中国路线更像 wedge，不是地理扩张

更新后的判断：

```text
美国 maker 路线可以保留，但不能当商业主线。
中国路线不是地理扩张，而是 wedge 本身：
通过模块厂商、kit、workshop 和供应链，把 Blockless 的 agent-to-hardware execution loop 验证出来。
```

最短路径不是：

```text
先做美国 maker 社区 -> 再去中国供应链。
```

而应该是：

```text
先在中国供应链里验证 recipe / rerun / vendor economics；
同时用英文 demo 和美国 pro-builder 叙事获取全球认知；
最后把 China-verified recipes 分发给全球 AI hardware builders。
```

这能把 Blockless 从一个容易被质疑的 “hardware ChatGPT” 叙事，改成：

```text
AI-native physical prototyping layer
validated against real China-supply-chain modules.
```

## 9. AI Agent + Hardware 产品如何从这些市场里长出来

这部分是关键推理，不是数据罗列。

### 9.1 从 Edge AI 到 Blockless

Edge AI 数据说明的是：

```text
AI inference is moving onto devices.
```

但 device-side AI 增长本身还缺一层：

```text
谁来把 sensor/camera/actuator/board/model/package 接起来？
```

典型原型链路：

```text
camera/sensor -> board/edge accelerator -> model/runtime -> firmware/app ->
device action/logs -> debugging -> repeatable demo
```

Blockless 的位置：

```text
agent reads hardware context
-> selects driver/package/runtime
-> generates code
-> runs on device
-> observes physical/log feedback
-> repairs
-> saves recipe
```

所以 Edge AI market 不是 Blockless TAM，但它证明越来越多 AI workload 会落到设备侧，而设备侧需要开发/调试/复现工具。

### 9.2 从 Robotics / Embodied AI 到 Blockless

Robotics foundation model 公司证明的是：

```text
AI is moving from language/code into physical action.
```

但 physical action 的 bottleneck 不只是模型，还包括：

- sensor integration,
- actuator control,
- camera pipeline,
- edge compute,
- MCU/SoC firmware,
- latency and power constraints,
- safety and failure handling,
- real-world test logs.

Blockless 不需要直接训练 robot foundation model。它的切口是：

```text
make physical prototypes executable by agents.
```

这可以服务：

- robotics demos,
- AIoT prototypes,
- embodied AI peripheral experiments,
- sensor/actuator recipes,
- module-vendor examples,
- maker-pro physical apps.

### 9.3 从 Maker 到 Blockless

Maker 数据说明：

```text
people already spend money and time trying to make physical things.
```

但以前 maker workflow 是：

```text
watch tutorial -> buy parts -> copy code -> wiring mismatch -> driver mismatch ->
forum search -> maybe works
```

Blockless 要验证的新 workflow 是：

```text
describe intent -> agent identifies hardware -> generates/runs ->
observes logs -> fixes -> publishes recipe
```

这就是为什么 maker 不能只当 “低 ARPU hobbyist”，也不能直接当 “已证明大 SaaS 市场”。它是：

```text
latent physical creation demand waiting for execution friction to collapse.
```

### 9.4 从 Module Vendors / Hardware Sellers 到 Blockless

模块厂商的问题通常不是没有硬件，而是：

- 用户不会接线；
- 用户不会装 driver；
- 示例代码过时；
- 不同 board/pin/package 组合爆炸；
- 售后支持重复；
- 教程无法覆盖长尾组合。

Blockless 的潜在付费点：

```text
verified recipe package
support-ticket reduction
module attach improvement
AI-generated examples
hardware compatibility graph
```

这比直接向 casual maker 收订阅更现实。

### 9.5 从 Workshop / Maker Space 到 Blockless

空间/课程/workshop 的问题不是 “有没有学生”，而是：

- 每次活动 setup 成本高；
- 硬件环境不一致；
- instructor support 负担重；
- 项目难复现；
- 失败无法沉淀成下次可用的经验。

Blockless 的潜在付费点：

```text
repeatable kit recipes
pre-verified board/module combinations
agent-guided debugging
post-workshop reusable project pages
hardware run evidence
```

这比 broad school procurement 更接近可控早期试点。

## 10. 不能过度声称的地方

这些不能在报告里写成已证明：

1. 不能说美国 maker 今天已经是大 SaaS 市场。
2. 不能说中国教育智能硬件 RMB 1000 亿就是 Blockless TAM。
3. 不能说 Blockless 直接吃 humanoid robot 市场。
4. 不能说 AppStore 可以靠抽成成为主要收入。
5. 不能说 generic AI agent 能安全可靠地控制所有硬件。

应该写成待验证：

1. agent-to-hardware 是否能显著提升 first working run 成功率。
2. verified recipes 是否能提高 rerun / fork / remix。
3. maker physical creation intent 是否能转成 repeat agent runs。
4. module vendor 是否愿意为 verified recipes / support reduction 付费。
5. physical AI endpoint / AIoT builders 是否需要 Blockless 作为低层原型工具。

## 11. 建议验证指标

不要只看：

- likes,
- views,
- Discord signups,
- Tindie product count,
- school logos,
- generic maker excitement.

要看：

- first working run time,
- hardware task success rate,
- flash/run/log/repair loop completion,
- successful rerun rate,
- recipe fork/remix rate,
- repeat agent runs per user,
- module/kit attach rate,
- support-ticket reduction for vendors,
- paid prototype pilot conversion,
- paid workshop/vendor package,
- physical AI endpoint / AIoT prototype recipe usage.

## 12. 最终研究结论

最强的研究结论是：

```text
Blockless is not a maker community story.
It is an AI-native physical prototyping tool.

The initial wedge is prototype speed, not hobbyist module consumption.
The supply-chain advantage is China, not the United States.
The U.S. market is useful for AI-native workflow adoption, pro prototyping, and narrative.
Maker becomes a stimulated secondary market only after prototype friction collapses.

The product must prove that an agent can turn hardware intent into a working,
repeatable real-device prototype dramatically faster than today's manual workflow.
But Blockless should not be framed as robotics or an embodied AI platform.
The stronger frame is non-robot physical AI endpoints:
turn low-cost modular sensors, actuators, displays, relays, motors, and edge boards
into reusable endpoint manifests, task harnesses, and endpoint run/evaluation logs.

The venture case does not rest on maker subscriptions alone.
It needs at least two capture layers to work: pro-builder seats or credits,
vendor verified recipes, workshop/kit packages, and eventually BOM/kit attach.

China should not be treated as a later geographic expansion.
It is the practical wedge for verifying supply-chain-backed recipes,
vendor economics, kit/workshop reproducibility, and BOM attach.
```

中文：

```text
Blockless 不是 maker 社区故事。
它是 AI-native physical prototyping tool。

初期 wedge 是 prototype speed，不是 hobbyist 模块消费。
供应链优势在中国，不在美国。
美国适合证明 AI-native workflow、pro prototyping 和资本叙事。
Maker 是原型摩擦降低之后被刺激出来的二级市场。

Blockless 要证明的是：
AI agent 能不能把硬件意图快速变成可运行、可复现、可交付的真实设备原型。
但不要把 Blockless 讲成机器人，也不要讲成 embodied AI platform。
更强的说法是 non-robot physical AI endpoints：
把低成本模块化传感器、执行器、显示、继电器、电机、边缘板，
变成可复用的 endpoint manifest、task harness 和 endpoint run/evaluation log。

venture case 不能只靠 maker subscription。
它至少要跑通两层收入：pro builder seats / credits、vendor verified recipe、
workshop / kit package，长期再接 BOM / kit attach。

中国不应该被当成后续地理扩张。
它更像当前 wedge：用模块供应链验证 recipe、vendor economics、
kit/workshop 复现和 BOM attach。
```

## 13. Sources

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
- NVIDIA Isaac GR00T N1 / humanoid foundation model: https://nvidianews.nvidia.com/news/nvidia-isaac-gr00t-n1-open-humanoid-robot-foundation-model-simulation-frameworks
- NVIDIA Cosmos world foundation model platform: https://nvidianews.nvidia.com/news/nvidia-launches-cosmos-world-foundation-model-platform-to-accelerate-physical-ai-development
- NVIDIA Jetson Thor / physical AI: https://nvidianews.nvidia.com/news/nvidia-blackwell-powered-jetson-thor-now-available-accelerating-the-age-of-general-robotics
- Google DeepMind Open X-Embodiment: https://deepmind.google/discover/blog/scaling-up-learning-across-many-different-robot-types/
- Open X-Embodiment paper: https://arxiv.org/abs/2310.08864
- Hugging Face LeRobot: https://huggingface.co/lerobot
- Hugging Face LeRobotDataset v3.0: https://huggingface.co/blog/lerobot-datasets-v3
- NVIDIA Project GR00T / Isaac robotics platform: https://nvidianews.nvidia.com/news/foundation-model-isaac-robotics-platform
- Home Assistant AI agents for the smart home: https://www.home-assistant.io/blog/2024/06/07/ai-agents-for-the-smart-home/
- Home Assistant Analytics active installations: https://analytics.home-assistant.io/
- Home Assistant State of the Open Home 2025 / 2M active installations: https://www.home-assistant.io/blog/2025/04/16/state-of-the-open-home-recap/
- Home Assistant LLM API developer docs: https://developers.home-assistant.io/docs/core/llm/
- Home Assistant Assist voice control: https://www.home-assistant.io/voice_control/
- Home Assistant entity developer docs: https://developers.home-assistant.io/docs/core/entity/
- Home Assistant integration service actions: https://developers.home-assistant.io/docs/dev_101_services
- ESPHome smart home device platform: https://esphome.io/
- ESPHome components: https://esphome.io/components/
- Matter supported device types handbook: https://handbook.buildwithmatter.com/how-it-works/device-types/
- Matter application cluster specification: https://csa-iot.org/wp-content/uploads/2024/05/matter-application-cluster-specification.pdf
- W3C Web of Things Thing Description 1.1: https://www.w3.org/TR/wot-thing-description/
- W3C Web of Things Architecture: https://www.w3.org/TR/wot-architecture11/
- NVIDIA Edge Computing: https://www.nvidia.com/en-us/edge-computing/
- NVIDIA Metropolis intelligent vision AI: https://www.nvidia.com/en-us/autonomous-machines/intelligent-video-analytics-platform/
- Advantech Edge AI systems: https://www.advantech.com/en-us/solutions/edge-computing-and-wise-edge/edge-ai-systems
- Hackster about: https://www.hackster.io/about
- Adafruit media overview: https://cdn-shop.adafruit.com/files/media.pdf
- Raspberry Pi 2024 sales reporting: https://www.heise.de/en/news/Raspi-manufacturer-discloses-sales-figures-and-costs-10339630.html
- Raspberry Pi investor reports page: https://investors.raspberrypi.com/reports
- Raspberry Pi FY2025 results with U.S. revenue disclosure: https://www.investegate.co.uk/announcement/rns/raspberry-pi-holdings-wi---rpi/fy-2025-results/9499135
- Raspberry Pi FY2024 final results: https://www.investegate.co.uk/announcement/rns/raspberry-pi-holdings-wi---rpi/fy-2024-final-results/8809266
- U.S. single-board computer market proxy: https://www.gminsights.com/industry-analysis/single-board-computer-sbc-market
- U.S. IoT microcontroller market proxy: https://www.grandviewresearch.com/horizon/outlook/iot-microcontroller-market/united-states
- SparkFun online sales estimate: https://gripsintelligence.com/insights/retailers/sparkfun.com
- Product engineering services market: https://www.grandviewresearch.com/industry-analysis/product-engineering-services-market-report
- Industrial software market 2024 / IoT Analytics: https://iot-analytics.com/wp-content/uploads/2024/12/INSIGHTS-RELEASE-The-industrial-software-market-landscape-7-key-statistics-going-into-2025.pdf
- IoT professional services market proxy: https://www.psmarketresearch.com/market-analysis/iot-professional-services-market
- 3D printing prototyping application proxy / BCC Research summary: https://www.bccresearch.com/public/RedactedRO/MFG074C.pdf
- OPC definition / Industry 4.0 role: https://www.techtarget.com/searcherp/definition/Open-Platform-Communications-OPC/
- OPC UA market proxy: https://dataintelo.com/report/opc-ua-market
- OPC Foundation MTConnect collaboration: https://opcfoundation.org/markets-collaboration/mtconnect/
- M5Stack about / ecosystem stats: https://m5stack.com/about-us
- Seeed Studio 2024 year in review: https://www.seeedstudio.com/blog/2025/01/03/seeed-studio-2024-year-in-review/
- DFRobot about / open-source hardware and kits: https://www.dfrobot.com/about-us
- National Bureau of Statistics innovation and entrepreneurship service institution survey system: https://www.stats.gov.cn/fw/bmdcxmsp/bmzd/202302/t20230215_1907179.html
- China Science and Technology Statistical Yearbook 2024 / makerspace operation entry: https://www.tjnj.net/navipage-n3025011009000235.html
- China Torch Statistical Yearbook 2024 / national registered makerspace entry: https://www.tjnj.net/navipage-n3025030701000157.html
- MIIT 2024 national high-tech zones evaluation: https://www.miit.gov.cn/xwfb/gxdt/sjdt/art/2024/art_0b80a511849b433c87621b0bbbaa46d0.html
- Shenzhen robotics 2024 whitepaper coverage / industry chain output: https://www.sznews.com/news/content/2025-04/25/content_31549205.htm
- Shenzhen AI pioneer city policy/application context: https://www.sz.gov.cn/cn/xxgk/zfxxgj/zwdt/content/post_11475299.html
- Seeed Fusion one-stop PCB assembly and custom hardware manufacturing: https://www.seeedstudio.com/fusion
- EasyEDA about / LCSC and JLCPCB integration: https://easyeda.com/page/about
- LCSC component distribution scale: https://www.lcsc.com/
- Clutch US IoT companies: https://clutch.co/us/developers/internet-of-things
- IoT professional services market / P&S Intelligence: https://www.psmarketresearch.com/market-analysis/iot-professional-services-market
- IoT professional services market / SNS Insider via GlobeNewswire: https://www.globenewswire.com/news-release/2024/12/10/2994597/0/en/IoT-Professional-Services-Market-to-USD-226-8-Billion-by-2032-Owing-to-Growing-Demand-for-IoT-Solutions-Across-Industries-Research-by-SNS-Insider.html
- IoT professional service market / Valuates: https://reports.valuates.com/market-reports/QYRE-Auto-4N6230/global-iot-professional-service
- Kickstarter official stats: https://www.kickstarter.com/help/stats/
- BackerBench Technology benchmark: https://backerbench.com/benchmark/tech
- Espressif Systems 2025 Q2 & Half-Year Report / M5Stack SKU velocity: https://www.espressif.com/sites/default/files/financial/688018_%E4%B9%90%E9%91%AB%E7%A7%91%E6%8A%80_2025-08-30_%E4%B9%90%E9%91%AB%E7%A7%91%E6%8A%80%EF%BC%9AEspressifSystems2025Q2_Half-YearReport.pdf
- Prototype development cost proxy / TriMech: https://design.trimech.com/blog/how-much-does-product-development-cost-design-prototype/
- Upwork embedded systems engineer rates: https://www.upwork.com/hire/embedded-systems-engineers/cost/
- GitHub Copilot plans/pricing: https://github.com/features/copilot/plans
- GitHub Newsroom / Copilot paid subscriber data: https://github.com/newsroom
- IFR World Robotics 2025 Americas / US robot deployment: https://ifr.org/downloads/press_docs/2025-09-25-IFR_press_release_Americas_in_English.pdf
- U.S. educational robot market size: https://www.grandviewresearch.com/horizon/outlook/educational-robot-market/united-states
- China Science and Technology Statistical Yearbook makerspace table: https://www.tjnj.net/navipage-n3025011009000235.html
- China Torch Statistical Yearbook national makerspace operating table: https://www.tjnj.net/navipage-n3025030701000157.html
- Beijing incubator/makerspace hard-tech ecosystem: https://www.chinanews.com.cn/cj/2024/04-16/10200042.shtml
- Duojing 2024 China education intelligent hardware report summary: https://www.djcapital.net/nd.jsp?id=988
- Sina / RUNTO 2024 China learning tablet sales: https://finance.sina.com.cn/tech/roll/2025-01-22/doc-inefvuvx6989660.shtml
- IFR 2025 president report / World Robotics 2024 installation summary: https://ifr.org/ifr-press-releases/news/presidents-report-by-takayuki-ito-3-2025
- AP News China humanoid robot demand analysis: https://apnews.com/article/china-humanoid-robots-ai-demand-7d542b5ee92caa9d79efa28de89afbbe
