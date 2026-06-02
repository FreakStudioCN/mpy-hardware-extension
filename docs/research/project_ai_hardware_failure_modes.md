---
name: AI 做硬件 5 个失败模式——deck Slide 4 / 任何对外材料的问题框架
description: 当前所有 AI-硬件玩家都在打的 5 个 boss（API 幻觉 / 包版本漂移 / 物理破坏 / SDK 碎片化 / compile-flash 闭环断裂）+ 各自出处 + 我们栈逐条破解
type: project
originSessionId: 94649df4-53c7-4cb7-b1bc-d396c60dfe85
---

**用户 2026-04-29 原话：** "你的 deck 缺少 目前 ai 做 hardware 的问题 你要做 deepresearch on this 然后你求实可以看到我们为什么能解决这个问题"

deepresearch 跑完后，5 个失败模式锁定如下 ——

## 5 个失败模式

| # | 失败模式 | 后果 | 出处 |
|---|---|---|---|
| **1** | **API / 寄存器幻觉** —— LLM 编造不存在的函数、寄存器地址、引脚 | 编译过、烧不进 / 烧进了不工作 / 烧进了把芯片烧了 | arxiv 2509.09970 (2025) "Securing LLM-Generated Embedded Firmware"; gocodeo "AI Code Generation in Embedded Systems" |
| **2** | **包 / 库版本漂移** —— ESP32 board package 2.0.10 编译报错；Servo lib 3.0.0 不兼容；**~20% 的 LLM 推荐包根本不存在** | 用户 follow AI 步骤 → IDE 红字 → 没有调试能力 → 放弃 | Arduino 官方 issue tracker（forum.arduino.cc, support.arduino.cc）；CACM "Nonsense and Malicious Packages: LLM Hallucinations in Code Generation" |
| **3** | **物理破坏风险** —— LLM 把 5V 信号接到 3.3V 引脚 → 芯片直接烧 | 用户买的板子物理烧毁，无法回退 | electronicsforu "AI That Understands Your Schematic"；Schematik 自己描述的"Sandwich"架构就是为了挡这个 |
| **4** | **MCU SDK 碎片化** —— 不同芯片寄存器映射不同，LLM 跨芯片串台 | 同一段代码在 ESP32-S3 跑 / 在 ESP32-C3 不跑 | promwad "LLM-Aided Hardware Design 2026"；wedolow "Hardware-Aware AI & Embedded Code Generation" |
| **5** | **Compile-flash 闭环断裂** —— C / Arduino 一次迭代 ≥ 30 秒 → AI 试错回路被打断 | LLM 没法"生成—试跑—修复"，错就是死错 | MicroPython 官方 REPL 文档；Adafruit 2025-12 "Why is everyone switching from Arduino to MicroPython"；roboticcoding.com "Is MicroPython Faster Than C" |

## 我们栈逐条破解（v6 deck Slide 9 表格右列）

| 失败模式 | 我们的解 |
|---|---|
| **#1 API/寄存器幻觉** | LLM 写 Python 比写 C 准 10–100×（训练语料分布）；模块封装让 AI 不需要碰寄存器 |
| **#2 包版本漂移 / 不存在的包** | Package Intelligence 聚合 uPyPI/GraftSense/curated 的 200+ 真实包/驱动；不存在的包不会被返回；版本由我们 freeze |
| **#3 物理破坏风险** | 主动模块预先验证电气边界（5V/3.3V 我们处理）；AI 永远不选引脚 |
| **#4 MCU SDK 碎片化** | 标准化 ESP32-C3 + MicroPython 单栈；一套寄存器一套 runtime |
| **#5 compile-flash 闭环断裂** | MicroPython REPL 热加载 < 1 秒；Python 异常可捕获自修复，AI 写错不杀设备 |

## How to apply

- **任何 deck / blog / 落地页 / Q&A 提到 "AI + 硬件"** → 必须用这 5 模式当问题框架，我们的解作为"为什么是我们能解"
- **遇到竞品对比** → 把这 5 模式当 boss 列表，问对方栈解了几条（绝大多数只解 0–1 条）
- **遇到投资人质疑"为什么 MicroPython"** → 引这 5 模式说"C 栈结构性会撞这 5 个 boss，Python 栈结构性 bypass"
- **遇到 maker 社区质疑"换栈成本"** → 用 Adafruit 2025-12 "everyone switching from Arduino to MicroPython" 当行业流向证据
- **不要把这 5 模式当成"我们的产品 feature 列表"**——它们是**行业问题诊断**，我们的栈是答案。先讲问题再讲答案，论证强 10 倍。

## Reference 沉淀

- pitch_deck/deck_en.md v6 Slide 4（5 模式表）+ Slide 9（11 维对决，每行右列锚定模式 #）
- pitch_deck/deck_cn.md v6（同上）
- pitch_deck/SPEC.md v6 lock 行
- feedback_micropython_vs_c_moat.md（论证模式可复用）
- project_schematik_position.md v6（用 5 模式诊断 Schematik 栈）
- project_ceo_micropython_contributor.md v6（central thesis 提级）
