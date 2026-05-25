---
name: Schematik = 同品类直接竞品 — 我们靠 MicroPython + 模块化技术栈碾压
description: Schematik (Lightspeed pre-seed $4.6M Apr 2026) 输出 Arduino/ESP32/RPi C 代码 + PCB 图，不仅是 PCB 工程师层；我们和他们直接竞争，差异是技术栈而非抽象层
type: project
originSessionId: 94649df4-53c7-4cb7-b1bc-d396c60dfe85
---

**Schematik 关键事实（2026-04 调研更新）：**
- $4.6M pre-seed，Lightspeed 领投，Anthropic 表达投资意向
- Slogan = "Cursor for Hardware"
- **实际产品输出**（per schematik.io 公开描述 + careeraheadonline / aiproductivity.ai 报道）：
  - 给 Arduino / ESP32 / Raspberry Pi 的**可运行代码** + 接线 + step-by-step 教程
  - PCB schematic + 元件选型（Digikey / Mouser）+ ERC/DRC 检查
  - "Sandwich" 架构：AI 夹在两层硬规则中间（Intent Parsing / Component Retrieval / Constraint Solving）
- 绑 Claude 3.5 Sonnet
- 受众：会读 datasheet / 会焊接的电子工程师 / 嵌入式 / firmware 工程师
- 官网：https://www.schematik.io/

**v5 → v6 关键修正（用户 2026-04-29 推翻 v5 framing）：**

- **v5 错误 framing：** "Schematik 占工程师 PCB 层，我们占创作者模块层 —— 不同抽象层和平共存"
- **v6 正确 framing：** "Schematik 也输出代码 + ESP32 目标平台，我们也是 —— **同品类直接竞品**。差异在技术栈：他们押 C / Arduino，我们押 MicroPython / 模块化"
- 用户原话：「我们和 schematik 的关系 我们是碾压他们 而不是他们上面的一层 我们本质价值是一样的。我们是技术栈优势 因为我们有 micropy 更好动态运行 卖的模块也更好组装」

**Schematik vs 我们 11 维对照表（v6 已落 deck Slide 9）：**

| 维度 | Schematik | 我们 |
|---|---|---|
| AI 输出物 | C / Arduino 代码 + PCB 图 + BoM | MicroPython 代码 + 模块组合方案 |
| 驱动来源 | LLM 脑补 Arduino 库 | uPyPI 173 个真包，HTTP 检索 |
| Runtime | C 编译 → flash（≥ 30 秒/次） | MicroPython REPL → 热加载（< 1 秒） |
| 错误恢复 | C hardfault → brick | Python 异常 → 可捕获 / 自修复 |
| 硬件抽象 | LLM 自选传感器 + 引脚 | 主动模块 BLE 自描述，AI 不选引脚 |
| 跨芯片 | 多平台多套寄存器 | 标准化 ESP32-C3 + MicroPython 单栈 |
| Runtime 所有权 | 第三方 | CEO 是 MicroPython 核心贡献者 |
| 用户造出实物 | 自采 + 焊 PCB + 组装 | 拼 BLE 模块 |
| 行业流向 | Arduino C++ 在被替代 | Arduino → MicroPython 流向（Adafruit 2025-12） |
| LLM 锁定 | 绑 Claude 3.5 Sonnet | LLM-agnostic |
| 可触达人群 | 5000 万 EE 工程师 | 5 亿创作者 |

**Deck v6 用法：**
- Slide 5（Why-Now）force #2：Schematik $4.6M = 品类已被 Tier-1 VC 验证；他们押 C，我们押 MicroPython
- Slide 9（Why This Wins）= 11 维对照表，每行右列锚定 Slide 4 五个失败模式之一
- Slide 11（商业模式）流水线图注释：Schematik 覆盖第 1+2 步但第 3 步流失（用户必须焊 PCB）
- "Cursor for hardware" slogan 不再回避 —— 我们和 Schematik 共享叙事，区别是**技术栈赌局**

**魔鬼律师 Q&A（口头答，不入 deck）：**
- "C 性能不可替代" → 目标用户不是医疗器械 / ADAS
- "Schematik 也能换跑 MicroPython" → 那他们 LLM 输出层要重写 + runtime 不是他们的 + 已绑 Claude / 多平台叙事
- "Sandwich 架构挡了 5 个失败模式" → 只挡 #3（电气违规），其余 4 条没解；Sandwich 还拖慢 LLM 生成速度，反向放大 #5
- "MicroPython GC / 性能不如 C" → 创作者场景的 sensor orchestration 性能足够；trade-off 我们这边收益（迭代速度 + LLM 准确度）远大于代价

**Reference 沉淀：**
- pitch_deck/deck_en.md v6（Slide 4 + Slide 9 重写）
- pitch_deck/deck_cn.md v6
- pitch_deck/SPEC.md v6 lock 行
- feedback_micropython_vs_c_moat.md（论证模式可复用到任何 AI-硬件竞品）
- project_ai_hardware_failure_modes.md（5 个失败模式详细出处）
