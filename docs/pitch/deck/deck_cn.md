# Blockless Pitch Deck - 中文最新版 v23

> 日期：2026-06-06  
> 受众：中国落地合作方 / 比赛评委 / 早期投资人 / 美国 VC 中文沟通材料  
> 定位：软件优先、硬件感知的 AI 嵌入式原型平台  
> 与英文版差异：中文保留“中国先落地”的商业路径，但不把教育采购说成已经验证的收入。

---

## Slide 1 - 封面

# 嵌入式硬件的 AI Agent

软件开发有了 Cursor。  
硬件原型还卡在选型、驱动、引脚、烧录和串口调试。

**Blockless 把一句硬件需求，变成真实开发板上能运行的 MicroPython。**

`[Logo]` | AI 原生嵌入式原型平台

---

## Slide 2 - 清晰类比

### Cursor 没有发明程序员，它商业化了一个已经存在的工作流。

Cursor 之所以能卖，是因为开发者本来就在：

- VS Code
- GitHub
- 包管理器
- 测试 / 部署循环
- Stack Overflow / 文档 / 示例代码

硬件也有同样的“创作图谱”，只是还没有被 AI 串起来：

- Adafruit / SparkFun / Seeed / DFRobot 模块
- Arduino / MicroPython / CircuitPython 驱动
- Hackster / Tindie / Kickstarter 创作者
- 串口日志、烧录工具、板卡能力、真实接线

> Cursor 站在软件创作图谱上。  
> Blockless 站在嵌入式硬件创作图谱上。

---

## Slide 3 - 核心判断

### AI 已经改变软件，硬件下一个，但不能从 PCB 开始。

- 软件 agent 能跑起来，是因为软件有快反馈和丰富包生态。
- 嵌入式硬件的问题是：反馈慢、驱动碎片化、AI 看不见真实设备。
- 第一代成功的 AI 硬件平台，不会先替代 Altium。
- 它会先解决“从想法到真实硬件跑起来”的最短路径。

> 我们不是做“AI 画 PCB”。  
> 我们做的是 **AI 把硬件原型跑起来**。

---

## Slide 4 - 问题

### 嵌入式原型最容易坏在 AI 最不擅长的地方。

一个简单项目仍然要：

- 选开发板和模块
- 找真实可用的驱动包
- 确认合法引脚
- 按真实 API 生成固件
- 烧录、看串口、修错误

LLM 可以写出“看起来对”的代码。  
但它不知道哪个包真的存在、构造函数怎么写、哪些引脚能用。

> 瓶颈不是想象力，而是包、板卡和设备的真实信息。

---

## Slide 5 - 为什么现在

### 四个条件同时成熟。

1. **AI coding agent 已经成为主流。** 市场理解“Cursor for X”。
2. **微控制器工具链正在靠近 Python。** Arduino 已经公开强调 Python、Linux、RTOS 和 AI 工作流。
3. **模块化电子已经成熟。** Qwiic、STEMMA、Grove、Gravity、Modulino 已经证明物理模块模式。
4. **AI 硬件工具已被资本验证。** Schematik 融资 $4.6M，Flux 融资 $37M。

机会不是重新发明模块化硬件。  
机会是让模块化硬件变成 AI 能读懂、能调用、能验证的系统。

---

## Slide 6 - 我们做了什么

### 一个被真实包、板卡和模块约束的 agent 闭环。

**当前 MVP**

- VS Code extension agent
- 后端 Package Intelligence
- board profile 和 import audit
- 从包证据中抽取 driver context
- 通过 MicroPython 工具链本地部署
- 真实 demo 路径：需求 -> 包解析 -> 代码 -> 硬件运行

**本地资产证据**

- 209 条 package-index records
- 166 条 GraftSense-sourced records
- 157 条 `generatable` package records
- 167 个 GraftSense driver `package.json`
- 测试覆盖：温度意图能解析到 `aht20_driver`

> 我们不让模型猜驱动 API。  
> 我们给模型一个机器可读的硬件合同。

---

## Slide 7 - Demo

### “温度超过 30 度，点亮 LED。”

1. 用户描述硬件需求。
2. Agent 把需求映射为能力：温度感知、数字输出。
3. Package Intelligence 解析温度驱动。
4. Driver context 提供 import、构造函数、读取属性和引脚角色。
5. Agent 生成经过 audit 的 MicroPython。
6. 用户确认部署，代码跑在真实开发板上。

示例解析包：`aht20_driver`。

> 说出来。解析包。审计代码。跑起来。

---

## Slide 8 - 产品

### 软件优先，硬件感知。

**核心付费产品**

- AI 嵌入式 agent：固件生成、调试、修错
- Package Intelligence 和 driver context
- board / module manifest
- 部署前 code audit
- LLM 用量计费和团队工作流

**硬件的角色**

- starter kit 和 active module 用于可靠上手
- 受控 demo 面，降低首次失败率
- 未来沉淀自描述 module graph

硬件让 agent 相信真实世界。  
软件才是高毛利主收入。

---

## Slide 9 - 早期用户

### 从“原型跑不起来就有经济损失”的人开始。

第一批用户优先级：

1. **硬件创业团队 / 产品工作室**：需要快速做出联网设备 demo。
2. **嵌入式 / IoT 咨询公司**：节省的时间可以直接变成利润。
3. **Maker-pro / 独立硬件卖家**：在 Tindie、Crowd Supply、Kickstarter 上卖项目。
4. **大学实验室 / 课程项目 / capstone 团队**：每学期重复做原型。
5. **CTE / STEM 老师**：产品稳定后再做课程化。

不是第一批：泛 hobbyist、大规模 K12 采购。

> 早期用户不是“对硬件感兴趣的人”，而是“硬件原型延迟已经有成本的人”。

---

## Slide 10 - 渠道数据

### 渠道数据不等于收入，但证明人群可触达。

美国公开渠道：

- Hackster：2.5M+ members，44K+ open-source projects。
- Adafruit：3M+ monthly uniques，8M+ pageviews/month，16.2K orders/month。
- Tindie：489K+ orders shipped，19.9K+ products。
- Crowd Supply：硬件众筹和交付平台，官方称 launched projects 90%+ 达成融资目标。
- Kickstarter Technology：$1.95B pledged，59K+ launched projects。
- 美国 CTE：11.2M students，Perkins V 约 $1.3B 投入。

这些数字不能直接变成我们的收入。  
它们说明哪里有正在买模块、做项目、发起硬件产品的人。

---

## Slide 11 - 从渠道到销售

### Adafruit 一个月 16.2K 单，不会自动变成我们的销售。

正确路径是可验证漏斗：

**第一步：设计伙伴**

- 找 20 个真实硬件原型用户。
- 用他们自己的项目跑 Blockless。
- 记录省了多少时间、失败在哪里。
- 转化 5 个付费试点。

**第二步：公开 recipe**

- 发布 10 个真实可复现项目。
- 每个 recipe 包含 BOM、代码、视频、driver evidence。
- 每个 recipe 两个 CTA：试用 agent、购买 starter kit。

**第三步：渠道销售**

- 把 starter kit 和教程放进创客渠道。
- 对重复创作者、咨询公司、实验室卖软件。
- 用硬件销售反哺更多 package / module truth。

> 渠道数据证明“可以触达”。  
> 付费试点和套件预售才证明“可以销售”。

---

## Slide 12 - 第一年的销售验证

### Seed 阶段不应该讲大 TAM，应该讲可证伪的销售实验。

| 里程碑 | 证明什么 |
|---|---|
| 20 个 design partners | 痛点真实、重复存在 |
| 10 个 verified recipes | agent 能稳定复现有用项目 |
| 5 个付费试点 | 团队愿意为原型速度付费 |
| 100 套 starter kit 预售 | 硬件可以作为 onboarding 入口 |
| 500 个 qualified signups | 公开渠道能产生需求 |
| 50 次 active hardware runs | 用户不是只看 demo，而是真的跑硬件 |

如果这些指标做不到，就不能靠 TAM 硬讲。

---

## Slide 13 - 中国先落地的道理

### 中文版可以更强调中国先做验证，但不能说教育采购已经验证。

中国适合先落地的原因：

- 深圳供应链能快速迭代模块、PCB、SMT、小批量。
- Seeed / DFRobot / M5Stack / Yahboom 已经教育了模块化硬件市场。
- 中国高校、创客空间、机器人竞赛、AI 教育基地有真实硬件实践需求。
- 中文用户对“软硬结合课程 + 套件 + 服务”接受度高于纯 SaaS。

中国不适合作为一开始的大规模公立学校采购故事：

- 采购周期慢。
- 地方关系和课程标准重要。
- 需要套件、课程、培训、售后一起交付。

> 中国先落地不是“先卖给全国学校”。  
> 而是先用高校 / 实验室 / 创客课程 / 比赛训练营验证项目闭环。

---

## Slide 14 - 中国商业路径

### 中国先从“课程化套件 + 软件 agent + 小批量交付”开始。

**第 1 阶段：高校 / FabLab / 创客空间**

- 目标：课程、实验、竞赛、创新项目。
- 收入：软件授权 + 套件 + 工作坊 / 培训。
- 价值：快速获得真实项目、真实反馈、真实教学场景。

**第 2 阶段：机器人 / AIoT / 科创教育机构**

- 目标：重复开课、重复使用硬件。
- 收入：课程包、套件包、机构授权。
- 价值：比单个 hobbyist 更稳定。

**第 3 阶段：学校和区域采购**

- 前提：课程、稳定性、售后、教学成果已经跑通。
- 收入：实验室套装、教师培训、年度软件服务。

> 中国第一桶金更可能来自“套件 + 课程 + 服务”，不是纯软件订阅。

---

## Slide 15 - 中美路径差异

### 美国验证 VC 叙事，中国验证交付和供应链。

| 维度 | 美国路径 | 中国路径 |
|---|---|---|
| 首批用户 | startup、consultant、maker-pro、lab | 高校、FabLab、创客教育、AIoT 课程 |
| 收入形态 | 软件订阅 / metered / team pilot | 软件 + 套件 + 课程 + 培训 |
| 渠道 | Hackster、Adafruit、Tindie、Crowd Supply、Kickstarter | 高校实验室、创客空间、机器人竞赛、教育机构 |
| 优势 | 高客单、VC 叙事清晰、软件付费更自然 | 供应链快、硬件套件落地快、课程场景密集 |
| 风险 | 没有 early users 时容易被质疑需求 | 教育采购慢、服务重、区域差异大 |

两条路不冲突：  
美国证明软件平台价值，中国证明硬件和交付闭环。

---

## Slide 16 - 竞品

### 赛道已被验证，但最终层还没有定型。

| 类别 | 代表 | 解决什么 | 我们的切入 |
|---|---|---|---|
| AI PCB / EDA | Flux、Celus、CircuitMind、JITX | 原理图、BOM、PCB、layout | 在 PCB 之前，把原型跑起来 |
| Prompt-to-hardware | Schematik | 代码、接线、物料、说明 | 受约束的 package + runtime truth |
| 仿真 / 教育 | Wokwi、Tinkercad、MakeCode | 虚拟电路、教学和模拟 | 真实部署和包智能 |
| 模块生态 | Seeed、DFRobot、M5Stack、Adafruit、SparkFun | 物理模块 | agent 可读的 module / package layer |

> 我们不替代 Altium。  
> 我们做嵌入式原型的 AI 创建层。

---

## Slide 17 - 为什么能赢

### 我们给 agent 一个可闭环的栈。

| 失败模式 | 普通 LLM 硬件工具 | Blockless |
|---|---|---|
| 不存在的库 | 猜 package name | 解析 indexed packages |
| API 写错 | 幻觉 constructor | 使用 driver context |
| import 不合法 | 部署后才发现 | 按 board profile 审计 |
| 反馈慢 | compile / flash loop | MicroPython run loop |
| 看不见硬件 | 猜 pin / module | manifest + 未来自描述模块 |
| 示例碎片化 | web search | curated package intelligence |

护城河不是 BLE 本身。  
护城河是持续积累的 package、board、module 和 working-project truth。

---

## Slide 18 - 商业模式

### 软件是主收入，硬件是信任入口。

**主收入**

- 个人 / 团队订阅
- metered agent runs / package intelligence calls
- 面向咨询公司、创业团队、实验室的专业工作流

**辅助收入**

- starter kit 和 active module
- 教育 / 实验室套装
- 创作者小批量生产支持

**社区层**

- public recipes
- 项目 fork
- 反哺 package intelligence 的示例和数据

---

## Slide 19 - 风险

### 这个故事有空间，但还没有被证明。

- 现在还没有 early users。
- 硬件 agent 软件的付费意愿还没验证。
- Arduino、Seeed、M5Stack、Flux 都可能加 AI。
- 模块化硬件本身不是护城河。
- 教育市场大，但慢。
- 生产级嵌入式系统需要安全、合规和人工确认。

可融资的窄主张是：

> 在硬件生态变成 agent-native 之前，我们先成为嵌入式原型的默认 AI 工作流。

---

## Slide 20 - 结尾

# 硬件创作需要自己的 agent-native stack。

物理世界不会靠通用代码补全被构建出来。

它需要：

- 真实 package truth
- board 和 module context
- 安全部署闭环
- working-project memory
- 中国供应链和套件交付能力

**Blockless 正在构建这套栈。**

---

## Sources

- Schematik: https://www.schematik.io/blog/schematik-raises-4-6m-pre-seed
- Flux: https://www.flux.ai/p/blog/we-raised-37m-to-take-the-hard-out-of-hardware
- Hackster: https://www.hackster.io/about
- Adafruit media kit: https://cdn-shop.adafruit.com/files/media.pdf
- Tindie: https://www.tindie.com/about/
- Crowd Supply: https://www.crowdsupply.com/apply
- Kickstarter stats: https://www.kickstarter.com/help/stats
- Advance CTE: https://careertech.org/our-vision/cte-in-your-state/
- China MOE 2024: https://www.moe.gov.cn/jyb_sjzl/sjzl_fztjgb/202506/t20250611_1193760.html
- Seeed: https://wiki.seeedstudio.com/About/
- DFRobot: https://www.dfrobot.com/about-us
- M5Stack: https://m5stack.com/about-us
