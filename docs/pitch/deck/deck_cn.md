# Pitch Deck — 中文介绍版 · v7

> 日期：2026-04-30 · 第七版（叙事升级到 agentic 时代 + Slide 4 收敛 5→3 深问题）
> 受众：合作伙伴 / 创客社区 / 顾问 / KOL —— **不是融资**
> 应用框架：Thiel 7 questions · Kawasaki 10 slides · Sky Fernandes（每页 1-5 bullets · 大图 · 不要堆字）· YC pocket guide
>
> **v7 相对 v6 的变化（5 处叙事代际升级）：**
> - **Slide 1 锚换 ChatGPT → Lovable**：ChatGPT 是模型层，对位错；我们是应用工具层的 Lovable 时刻。tagline "让做硬件像拼乐高一样简单" 提到封面。
> - **Slide 2 升级到 agentic 叙事**：从 "AI 替代工具"（Cursor 时代）走到 "AI 自己 ship feature"（Claude Code / Cursor agents / Codex 时代）。物理世界是 agent 革命最后没接入的领域。
> - **Slide 4 由 5 个失败模式 → 3 个 "Opus N+1 也救不了" 的结构性深问题**：删 "寄存器幻觉"（Opus 4.6+ 已缓解）+ "物理破坏"（我们也不解决）。新三问：栈碎片化（数据稀疏）/ 调试回路断裂（agent 没 stderr）/ 硬件无自描述（agent 没眼睛）。
> - **Slide 5 三变量重写**：agent 从辅助跨到自主（不是 "Copilot 付费数"）/ 一年共建 MicroPython 生态（不是 "CEO 是贡献者"）/ BLE+REPL+\$1 ESP32-C3 supply 侧到位。"Schematik \$4.6M" 从变量降为 Slide 9 市场验证锚。
> - **Slide 6 加振聋发聩 hook**：H1 改成 "让做硬件像拼乐高一样简单"，每个 bullet 标明解 Slide 4 哪个新问题。
>
> **v6 相对 v5 的变化：**
> - **新增 Slide 4「今天 AI 做硬件为什么都失败」**（5 个失败模式 deepresearch：寄存器幻觉 / 包版本漂移 / 物理破坏风险 / SDK 碎片化 / compile-flash 闭环断裂）。原 Slide 4–13 顺延为 5–14。
> - **Slide 9（原 8）我们的位置重写**：彻底删 "工程师层 vs 创作者层 2x2"。改成正面碾压式"Schematik vs 我们"技术栈对决表，每行右列锚定 Slide 4 失败模式编号。**Schematik 不再是"上面一层"——是同品类直接竞品，我们靠 MicroPython + 模块化结构性更优。**
> - **Slide 5 / 6 / 11 / 12 同步加注**：每个我们的能力都明确指出解决了 Slide 4 哪个失败模式，论证链闭环。
> - **Slide 12 CEO 第一条 bullet 提级**：从"runtime 基座"提级为"赛道标准制定者"，把 LLM 写 Python > 写 C 10× 这个客观事实和 CEO 身份串成 unfair advantage。
>
> **v5 相对 v4 的变化：**
> - **Slide 10 修正：** Skill 是主营收 stream（Cursor-style SaaS / metered），不是免费。三条复利营收 = Skill SaaS + 模块销售 + 小批量代工。v4 错把 Skill 写成"免费"了。
> - **"Cursor for hardware" 当商业模式 framing 重新启用**（不是当独家 slogan —— Schematik 占工程师层，我们占创作者层）
> - **Slide 8 加一句：** "Schematik 和我们都是 'Cursor for hardware'，只是抽象层不同" *(v6 推翻：见上)*
>
> **v4 相对 v3 的变化：**
> - **加 Schematik 定位（S4 + S8）：** Schematik 2026-04 拿了 $4.6M pre-seed（Lightspeed 领），做工程师级 PCB 电路 AI 设计。我们做创作者级模块组合 + 固件 AI。同品类不同抽象。他们的 funding = 我们的品类背书。
> - **AppStore 重新定位（S5 / S7 / S10 / S12）：** AppStore = 社区配方分享 + 学习 + 二次开发层，**不是商业分发**。营收来自模块销售 + 小批量代工。
> - **Slide 10 第 4 步"卖" drop AppStore：** 第 4 步 = Kickstarter 上线支持 + 小批量代工服务（10-1000 件）。
>
> **v3 相对 v2 的变化：**
> - **wedge 改了：** 模块化生态（无 host）
> - **drop Plaud / Humane / Limitless / Friend：** 跨市场论据不成立
> - **Slide 10 改写：** 端到端价值链（说→造→跑→卖）
> - **类比锁定 Cursor + Lovable**
> - **架构：** uPyOS = 模块端固件框架 + BLE 协议

---

## Slide 1 — 封面 / Hook

# 软件的 Lovable 时刻是 2025 年。
# 硬件的 Lovable 时刻就是现在。

*让做硬件像拼乐高一样简单。*

`[Logo]` · `[AI 原生的硬件创作平台]`

---

## Slide 2 — 核心命题

### AI 从 "辅助你打字" 走到 "自己 ship"。但这场 agent 革命只发生在屏幕里 —— 物理世界还没有 agent。

**2024 年的 AI 是工具替代（Word→ChatGPT）。2026 年的 AI 是 agent 自主：自己写、自己跑测试、自己 commit、自己 ship feature。每一个屏幕里的创作领域都已经接入。**

| 领域 | 工具替代时代（2022-24）| Agent 自主时代（2025-26）|
|---|---|---|
| 写作 | ChatGPT —— 8 亿周活 | Claude Projects · 长会话 agent 自主撰稿 |
| 写代码 | Cursor / Copilot —— 补全 | **Claude Code · Cursor Agents · Codex** —— agent 自己 ship 多文件 feature |
| 网页 / app | Lovable —— 一句话出原型 | **Lovable Agents** —— 自己跑测试、自己改 bug、ship 完整 app |
| 图像 / 视频 | Midjourney · Runway | **Sora 2 · Veo 3** —— 一句话自主成片，不再逐帧调整 |
| **物理世界 / 硬件** | **Arduino · M5Stack · Adafruit** | **—— 还是空的 ——** |

> **Agent 时代的最后一个空缺：让 agent 能 "造出会动的东西"。**

`来源：Anthropic Claude Code 2025-Q4; Cursor Background Agents; YC W26; Lovable 公开融资数据`

---

## Slide 3 — 问题

### 硬件创作是最后一个还被把守的创作领域。

- 全球 **5000 万 +** 人买了 Arduino / 树莓派想做东西 —— **~90% 没 ship 出过真东西**
- 四道墙：**datasheet · 驱动代码 · 焊接 · PCB 设计** —— 四种技能，全都要会，全都难
- Cursor 把写代码这件事 democratize 了，Lovable 把做 web app democratize 了 —— **没人把"做物理东西"democratize**
- 每个真正动手的 maker，背后**还有 100 个想做但没开始的"梦想者"**

> **下一批 10 亿创作者卡在 I2C，不卡在想象力。**

`来源：Arduino Open Source Report 2024（~3000 万 IDE 用户）; Raspberry Pi PLC FY2024（6000 万+ 板卡）`

---

## Slide 4 — 今天 AI 做硬件为什么都失败

### Agent 已经能自己写软件 feature 了。为什么还没人能让 agent 造出一台能跑的硬件？

**幻觉问题已经被 Opus 4.6 / 4.7 大幅缓解了。但下面 3 个问题，模型代际再升一档也救不了 —— 它们是栈的结构性问题，不是模型容量问题。**

#### 问题 1 · MCU 栈碎片化 —— 训练数据本身就是碎的

- 现状：ESP32-S3 / ESP32-C3 / STM32H7 / RP2040 寄存器布局完全不同；同一颗 BMP280 在不同 SDK 下 init 序列、I²C 地址、DMA 行为都不一样。Arduino 库还有大量二次 fork 和厂商私有补丁。
- 表现：LLM 推荐的包 ~20% 根本不存在；ESP32 board package 版本一漂移整段编译报错；用户照着 AI 走一遍 → IDE 红字 → 没有调试能力 → 放弃。
- **为什么 Opus 10 也救不了：** 每颗 MCU 的真实 errata、driver fork、客户私有补丁**根本不在公开语料里**。这是**数据层结构性短缺**，模型再大也是在编。

#### 问题 2 · 调试反馈回路断裂 —— Agent 没有 stderr 可看

- 现状：写软件，bug 了 → 编译器红字 → agent 看 stderr 直接修；写硬件，bug 了 → 要**串口线、逻辑分析仪、示波器、JTAG**，而且**设备本身可能已经死锁 / brick，连 print 都打不出来**。
- 表现：C / Arduino 一次 compile-flash 要 ≥ 30 秒；agent 的 "生成—试跑—修复" 闭环被打成开环。一个早期错误 = 永久错误。
- **为什么 Opus N 也救不了：** Agent 的核心能力是 "看到结果 → 改"。**看不到 = 没手没眼**。这是 **I/O 通道**问题，不是推理能力问题。

#### 问题 3 · 硬件没有 "自描述入口" —— Agent 看不见插上去的是什么

- 现状：把一颗温度传感器插上 STM32，agent **完全看不见**这是 BMP280 还是 SHT30、I²C 地址多少、引脚怎么接。它只能盲猜 + 让用户写 pin 配置。
- 表现：USB 设备能 enumerate，npm 包有 registry，**但传感器 / 执行器之间没有这个对应物**。Agent 时代最值钱的 "自主探索 → 自动 wire 起来" 那一步直接被打死。
- **为什么 Opus N 也救不了：** **协议层不存在**。模型不能凭空读出物理世界。要么所有人统一一套协议，要么我们自己造一套。

> **3 个问题的总解都是同一件事：把硬件接到一个 LLM 真的擅长的栈上 —— MicroPython 单 runtime 屏蔽碎片化 (问题 1)，REPL 闭合调试回路 (问题 2)，BLE 自描述给 agent 装上眼睛 (问题 3)。Schematik 押 C，这 3 个一个都解不了。**

`来源：promwad "LLM-Aided Hardware Design 2026"; arxiv 2509.09970; Arduino issue tracker; CACM "Nonsense and Malicious Packages"; MicroPython 官方 REPL 文档; Adafruit 2025-12`

`[图：3 个问题 → 箭头指向 Slide 6 "MicroPython + uPyPI + 主动模块 一次性全 bypass"]`

---

## Slide 5 — 为什么是现在

### 三个变量 24 个月前都不在场。Agent 能写、能跑、能看 —— 第一次都到位。

**1 · Agentic coding 从 "辅助" 跨到 "自主"（不是补全，是 ship）**
- 不是 2024 年的 Copilot 故事。是 2025-2026 这一年 **Claude Code · Cursor Background Agents · Codex** 第一次稳定 ship 多文件 feature —— agent 自己写、自己跑测试、自己 commit。
- 这意味着把 agent 接到硬件上的 ROI **第一次为正** —— 之前接也白接，agent 还不会自迭代。
- 来源：Anthropic Claude Code 2025-Q4；Cursor Background Agents；YC W26 ~50% 代码 agent 写。

**2 · 我们持续一年共建 MicroPython 生态 —— runtime 不是 "赌"，是 "我们种的"**
- 过去 12 个月 CEO 持续向 MicroPython 上游提交 PR、维护 uPyPI 生态、推动跨芯片 driver 标准化。
- **uPyPI 173 个驱动包**就是这一年共建的产物，不是 launch 时凑的。
- LLM 写 Python 比写 C 强 10× 是公开事实，但 **"写出来的 Python 跑在我们参与塑造的 runtime 上"** 是别人没法 1:1 复制的 unfair advantage。
- **这不是赌哪个 runtime 赢，这是我们种的那个 runtime 顺便赢了。**

**3 · 硬件供给侧第一次能跑 agent**
- BLE 5.x 普及 + ESP32-C3 BOM 跌到 \~$1 + MicroPython REPL 通过 BLE 暴露 = **agent 第一次能直连物理设备读状态**。
- 这恰好是 Slide 4 问题 2（调试回路）+ 问题 3（自描述）在 supply 侧的客观时间点 —— 不是规划，是历史窗口。

> **Agent 能写（变量 1）· Runtime 是我们的（变量 2）· 物理端能联（变量 3）。这 3 件事 24 个月前一件都不成立。今年第一次全到位。**

`来源：Anthropic / Cursor / YC 2025-26 公开数据; MicroPython github; ESP32-C3 BOM 公开报价 2026`

---

## Slide 6 — 我们做了什么

# 让做硬件像拼乐高一样简单。

*我们彻底重写了技术栈，绕开了 C 的 AI 重试地狱 —— 自建 MicroPython 生态 + 硬件 App Store，用户互相发布、互相安装。*

### 一整套 AI 原生硬件创作栈。Agent 看得见，模块拼得起，代码跑得通。

**Skill（agent 大脑）+ uPyPI（驱动 registry）+ uPyOS（runtime + BLE 自描述）+ 主动模块（agent 的 "手"）+ 硬件 App Store（社区记忆）= 第一次把 agent 时代搬到桌面上。**

- **Skill** —— AI 编译器。把意图编译成 agent 能执行的硬件计划：选模块 → 生成集成代码。**模型不挑**（GPT · Claude · Gemini）。
- **uPyPI** —— 标准化驱动 registry，**173 个真包**，HTTP API。**解 Slide 4 问题 1**：agent 检索 registry 而不是脑补包名，不存在的包不会被返回；单 runtime 屏蔽跨芯片 SDK 碎片化。
- **uPyOS** —— 模块端固件框架 + BLE 协议，REPL 热加载 < 1 秒，**< 512KB RAM**。**解 Slide 4 问题 2**：闭合 agent 的调试回路 —— LLM 写 Python 比写 C 准 10×，热加载 < 1 秒匹配 AI 试错节奏。
- **主动模块** —— ESP32-C3 + 一个传感/执行单元，BLE 自描述、即插即用、独立可跑。**解 Slide 4 问题 3**：BLE 自描述 = 硬件的 USB descriptor，**agent 第一次能 "看见" 插上的是什么**。
- **硬件 App Store（手机 / 网页）** —— 用户把跑通的硬件作品（模块组合 + AI 代码）发布出去，别人**一键 fork + 安装**到自己的模块上。*网络效应，不是商业市场 —— 每出一台设备就是给下 100 个创作者的模板。*

> **乐高把塑料积木变成童年的通用底层。我们把主动模块 + agent 变成物理世界的通用底层。**

`[架构图：用户意图 → Skill (agent 大脑) → uPyPI/uPyOS (栈) → 主动模块 (手 + 眼) → 硬件 App Store (记忆)]`

---

## Slide 7 — 演示

### "做一个桌面环境监测器，温度超过 30 度就让马达震动。"

**4 步。没有人手写固件。**

1. **Skill 解析意图** + 用自然语言追问澄清
2. **推荐模块组合** —— 1 个温湿度 + 1 个光照 + 1 个震动 —— 直接发货。*因为模块 BLE 自描述（不是 AI 选引脚），Slide 4 问题 3（agent 看不见硬件）在这一步直接被消除。*
3. **用户拼装** —— 上电 → BLE 自动配对 → 模块互相识别能力
4. **Skill 推送集成代码** → 设备跑起来 → 温度 > 30°C 时马达震动 → 完成

> **不编译。不焊接。不写固件。说出来。拼起来。跑起来。**

`[架构流程图。demo 视频在 Kickstarter 上线时同步发布。]`

---

## Slide 8 — 产品

### 标准化模块库。AI 根据你的想法配出对应的方案。

**产品是模块生态本身 —— 不是一台设备。**

- **每个模块：** ESP32-C3 + 一个传感器或执行器。独立、BLE 原生、即插即用
- **首发模块库：** 约 15 个 —— 传感（温湿度 · 光照 · 运动 · 声音 · 气体 · IMU）+ 执行（马达 · LED · 喇叭 · 显示 · 舵机）
- **Skill 根据你说的事推荐组合**
- **手机 / 网页 app** = 控制台 + 硬件 App Store 浏览器。*一键 fork + 安装别人跑通的硬件作品。不是商业市场。*

**目标人群：**
- 已有创客（Adafruit / SparkFun / Hackster）想要 10× 提速
- STEM 教育者和学习者
- **有想法但不会写代码的人** —— 终于有进路

`[模块渲染图 —— TBD]`

---

## Slide 9 — 我们的位置

### 同品类，同价值，我们赢在技术栈。

**市场已经被验证：** Schematik 2026-04 拿了 **$4.6M pre-seed**（Lightspeed 领投，Anthropic 表达投资意向）—— "Cursor for hardware" 这个月跨过 Tier-1 VC 门槛。**他们押 C / Arduino，我们押 MicroPython + 模块化。同品类、不同栈。**

| 维度 | Schematik | 我们 | 解决的问题 |
|---|---|---|---|
| **技术栈思路** | 套用现有 C / Arduino 工具链 —— 继承 compile 闭环、重试地狱、brick 风险 | **彻底重写** —— MicroPython + BLE 单栈，不编译、不烧录、不需要工具链 | **问题 1、2、4 一次性全 bypass** —— 结构性跳出，不是打补丁 |
| **AI 输出物** | C / Arduino 代码 + PCB 图 + BoM | MicroPython 代码 + 模块组合方案 | **问题 1（栈碎片化）** —— LLM 写 Python 比 C 准 10×，Python 训练语料密度高 |
| **驱动来源** | LLM 从训练数据脑补 Arduino 库（~20% 不存在）| uPyPI 173 个真包，AI HTTP 检索 registry | **问题 1** —— registry 不返回不存在的包 |
| **Runtime 迭代** | C 编译 → flash（≥ 30 秒 / 次）| MicroPython REPL → 热加载（< 1 秒）| **问题 2（调试回路断裂）** —— agent 试错回路接上 |
| **错误恢复** | C hardfault → brick | Python 异常 → 可捕获 / 自修复 | **问题 2** —— agent 写错不杀设备，能继续迭代 |
| **硬件抽象** | LLM 自选传感器 + 引脚（5V/3.3V LLM 记）| 主动模块 BLE 自描述，agent 直读设备能力 | **问题 3（无自描述入口）** —— agent 第一次能 "看见" 物理世界 |
| **跨芯片** | 多平台（Arduino / ESP32 / RPi）= 多套寄存器 | 标准化 ESP32-C3 + MicroPython 单栈 | **问题 1** —— 一套 runtime 屏蔽碎片 |
| **Runtime 所有权** | 第三方（Arduino / ESP-IDF）| **CEO 一年持续共建 MicroPython + uPyPI** | 标准演进我们参与决策 |
| **用户造出实物** | 自采元件 + 焊 PCB + 组装 | 拼 BLE 模块（即插即用）| 用户技能门槛差一个数量级 |
| **行业流向** | Arduino C++ 生态被替代中 | 创客 / 教育从 Arduino 流向 MicroPython | Adafruit 官方 2025-12 |
| **LLM 锁定** | 绑 Claude 3.5 Sonnet | LLM-agnostic（GPT / Claude / Gemini）| 模型代际更替我们不重写 |
| **用户作品分发** | 无 —— 每个用户都从零推一遍 | **硬件 App Store** —— fork 别人跑通的作品，一键装到自己的模块上 | 复利网络效应：每出一台设备就是下一个用户的起点 |
| **结果：可触达人群** | 会焊接 + 看 datasheet 的工程师 | 不会焊接也能完成的创作者 | 5 亿 vs 5 千万 —— 受众规模差 10× |

> **同样的 "Cursor for hardware" 叙事，他们押在被 AI 替代的工具链上，我们押在 AI 长出来的工具链上。Slide 4 那 3 个 "Opus N+1 也救不了" 的结构性问题，他们一个都没解，我们一次性全 bypass。**

`[图：同一个 funnel 两条路径 —— Schematik 在 "用户焊 PCB" 流失；我们在 "agent 看不见硬件" 这一关靠 BLE 自描述全跳过]`

`来源：Schematik blog 2026-04; arxiv 2509.09970; CACM "Nonsense and Malicious Packages"; Adafruit 2025-12; SlashData 2025`

---

## Slide 10 — 市场 — TAM / SAM / SOM

### 同心圆。从可主导的小 SOM 起步，向外扩张。

**TAM —— 全球 $800 亿+ · AI 硬件创作 + 创作者经济**
- 全球 STEM 教育 $39B（2031）· 美国智能家居 $38B · AI 智能玩具 $9.7B（2035, CAGR 14.2%）· AI 毛绒 $842M（CAGR 35%）· 中小企业 IoT 长尾

**SAM —— $50 亿+ · AI 原生硬件创作 + 创作者硬件**
- 创客硬件零售今天约 $2 亿 × **10× AI 放大**（Cursor / Lovable 先例：AI 创作工具放大底层创作者池 10×）
- + 全球 STEM 教育者和学习者（约 5000 万 K-12 + 大学）

**SOM Year 1 —— $10–30M 营收**
- KS 硬件 Top 5 平均募资 **$3.46M – $6.67M**（UGREEN / eufy / Carvera）—— 直接对照档
- Adafruit + SparkFun + Hackster 合计欧美 maker 基础：**~500 万开发者 × 1% 转化 = 5 万早期买家**

`[同心圆图，每圈标 $ 金额]`

`来源：Future Market Insights; Intel MR; Statista; Verified MR; SendFromChina KS Top 5 2024`

---

## Slide 11 — 商业模式

### "Cursor for hardware" —— 一个 AI 工具复利出三条营收。

**和 Cursor 一样，我们卖 AI 工具本身。但硬件是实体的，所以我们还卖模块。当创作者要量产，我们再代工。**

| 步骤 | 含义 | 我们的层 | 营收 stream |
|---|---|---|---|
| 1 · **说** | 用户描述想法 | **Skill**（AI 编译器）| **✅ Skill SaaS / metered** *(Cursor-style 订阅)* |
| 2 · **造** | AI 选模块、出代码 | **uPyPI + uPyOS + Skill** | *(包含在 Skill 订阅里)* |
| 3 · **跑** | 模块发货、拼起来、跑起来 | **主动模块** | **✅ 模块销售**（每项目）|
| 4 · **卖**（可选）| 创作者要商业化 | **小批量代工**（10-1000 件量产）| **✅ 服务费 + 生产毛利** |

**硬件 App Store（手机/网页 app）** 横跨 4 步当知识倍增器 —— **不是**独立的营收路径。

> **Cursor 单靠 stream #1 就到品类定义级估值。我们 day-one 就有三条复利。**

`[流水线图：营收旗子标在 stream 1/3/4 · Cursor 覆盖 = 第 2 步 · Schematik 覆盖 = 第 1+2 步，但第 3 步"跑"要用户自己焊 PCB，大幅流失 · 我们 = 4 步全覆盖，每步友好度都高一档，其中 3 步有营收]`

---

## Slide 12 — 团队

### 两个 builder。一个生态创办人。一个技术操作员。

**CEO** —— 战略 · 产品 · 出海 GTM
- **MicroPython 核心贡献者** —— LLM 写 Python 比写 C 强 10×，所以 AI 原生硬件的 runtime 必然是 MicroPython 这一脉。**我们不是赌赛道——我们是赛道的标准制定者之一。**
- 这不是追风口。**这是在塑造风口。**

**CTO** —— 嵌入式 / RTOS 工程师
- **5 项发明专利** —— CV · IoT · 动物追踪 · 生猪健康监测 · 声光定位
- 多模多源智能感知实验室 **4 年**项目负责人
- 创办青木之道科技，做电子外包 + K-12 STEM 产品 + 定制机器人 + 教育信息化
- 自媒体（B 站 / 知乎）累计 **13.6 万 +** 播放
- **技术栈：** STM32 / NXP / TI MCU · RTOS · OpenCV / Keras 边缘部署 · PCB 设计 · I²C / SPI / CAN / USB

**Origin**

> 软件的工具 5 年里全部 AI 化了。硬件是最后一个还困在 I2C 和 datasheet 后面的创作领域 —— 我们建这家公司，把它翻过来。

---

## Slide 13 — GTM / 路线图

### 模块生态发布 → AppStore 网络效应 → 小批量代工服务。

- **2026 Q4** —— Kickstarter 上线。**Starter Pack**（5 个模块 + Skill 接入 + 硬件 App Store 公测）。从入门到教育套装多档奖励。目标：硬件类目 Top 5（$3-7M 募资）
- **2027 H1** —— 1000+ 订单出货。硬件 App Store 正式上线。**第一个用户发布的硬件 app 被 fork + 安装 100 次。**
- **2027 H2** —— 模块库扩展到 30+。社区贡献者计划开放。**小批量代工服务（10-1000 件）开放给想要把作品商品化的创作者**
- **2028** —— 第一个完全在我们平台上孵化出的硬件产品独立上 KS。中小企业 IoT 定制服务线开始可观营收。

> 2024 年 KS 科技：$7.06 亿总额 · 35,512 个项目 —— 已被验证渠道。**我们带 AI 原生模块平台进来。**

`来源：SendFromChina KS 2024; Tubefilter 2025-03`

---

## Slide 14 — 尾声 / 愿景

# "未来世界上的每一个智能设备，都可能是'说'出来的。"

- 我们不只在做一个模块库
- 我们在打开一个时代 —— 从**说**，到**造**，到**卖**
- 你说一句话，世界多一个会动、能用、能卖的东西

> **欢迎成为第一批同行者。**

`[联系方式 · 公众号 · 邮箱 · 网站]`
