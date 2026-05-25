---
name: AI 原生硬件竞品比较——主轴是 AI codegen 时代谁更适合，证据三件套 + 模块化次轴
description: 任何对外材料里比较我们和 AI-硬件竞品（Schematik / Wio AI / Arduino-AI / 任何押 C 的栈）时，主轴必须是"AI codegen 时代技术栈适配度"，不要绕到"抽象层不同""市场不同"等弱论据
type: feedback
originSessionId: 94649df4-53c7-4cb7-b1bc-d396c60dfe85
---

**Rule：** 比较我们和 AI-硬件竞品时，主轴 = **AI codegen 时代谁的技术栈结构性更适合**。证据三件套必须每次都在场：

1. **LLM 写 Python > 写 C 10–100×**（训练语料分布；Sonar / Promptlayer / arxiv 2509.09970 / HN）
2. **REPL 热加载 < 1 秒 vs C compile-flash ≥ 30 秒**（AI 试错回路必须 < 1 秒）
3. **Python 异常可恢复 vs C hardfault brick**（AI 写错代码不能杀设备）

次轴 = **模块化即插即用 vs 自焊 PCB**（用户技能门槛差一个数量级；Schematik 这类输出 PCB 图的栈在"用户造出实物"那一步流失大量用户）

**Why：** 用户 2026-04-29 原话："我们和 schematik 的关系 我们是碾压他们 而不是他们上面的一层 我们本质价值是一样的。我们是技术栈优势 因为我们有 micropy 更好动态运行 卖的模块也更好组装"。
- v5 之前 deck 把 Schematik 框成"工程师层 vs 创作者层"——绕开了正面对决，论证弱
- v6 改成"同品类不同技术栈"，论证强 10 倍
- 客观调研全面支持这个 framing，不是品味话术

**How to apply：**
- 任何 deck slide 提到 Schematik / Wio AI / Arduino-AI / 任何 AI-硬件竞品 → 都用主轴 + 次轴打
- 不再用"抽象层不同""目标人群不同""市场不同"这类绕圈论据当主轴
- 受众规模差异（5 亿创作者 vs 5 千万工程师）当**结果**呈现，不当**前提**论据
- 任何"为什么 MicroPython"问题 → 三件套 + 次轴一次出齐
- 投资人 Q&A 准备：
  - "C 性能不可替代" → 答："目标用户不是医疗器械 / ADAS"
  - "竞品也能换跑 MicroPython" → 答："那他们 LLM 输出层要重写 + runtime 不是他们的 + 已绑定其他平台叙事"
  - "Sandwich 架构挡了失败模式" → 答："只挡电气违规一条，其余 4 条没解；还反向放大 compile-flash 闭环断裂"

**禁用论据（v6 之后）：**
- ❌ "Schematik 是工程师层 我们是创作者层"——客观事实他们也输出 ESP32 代码，框得太弱
- ❌ "市场不同"——客户重叠，价值主张几乎一样
- ❌ "我们抽象层更高"——现在直接对比技术栈优劣

**Reference 沉淀：**
- pitch_deck/deck_en.md v6 Slide 9（Why This Wins 11 维对决）
- pitch_deck/deck_cn.md v6 Slide 9
- project_schematik_position.md v6（同品类直接竞品定位）
- project_ai_hardware_failure_modes.md（5 个失败模式当问题框架）
- project_ceo_micropython_contributor.md v6（central thesis 提级）
