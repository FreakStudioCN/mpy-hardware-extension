# 一句话造硬件 — AI 嵌入式生成工具功能规划

> 目标：用户只需用自然语言描述需求，系统自动完成从选型、生成代码、编译到烧录的全流程。

---

## 核心用户旅程

```
用户说一句话
    ↓
AI 理解意图 + 硬件选型
    ↓
自动生成代码 + 接线图
    ↓
库依赖自动解析安装
    ↓
一键编译 + 烧录
    ↓
串口调试 + 错误自动修复
```

---

## 功能模块

### 1. 自然语言理解（输入层）
- 用户用一句话描述项目需求（中英文均支持）
- AI 拆解意图：功能需求 / 传感器 / 通信方式 / 触发条件
- 支持追问澄清（多轮对话补全信息）
- 示例：`"做一个温湿度监测仪，超过阈值发微信通知"`

### 2. 硬件选型推荐
- 根据需求自动推荐开发板型号（ESP32 / Arduino Uno / STM32 等）
- 列出所需传感器/模块清单（含型号、数量）
- 给出购买建议（价格区间、替代方案）
- 考虑用户已有硬件（可告知已有设备）

### 3. 接线图生成
- 自动生成引脚连接图（哪个引脚接哪里）
- 可视化接线示意图（Fritzing 风格或文字表格）
- 标注注意事项（电压、电流限制等）

### 4. 代码生成
- 支持多语言：Arduino C++ / MicroPython / ESP-IDF
- 生成完整可运行项目（含 main 文件 + 配置文件）
- 代码含必要注释，适合入门阅读
- 支持 Blockly 积木与代码双向同步（可选）

### 5. 库依赖自动管理（关键难点）
- 自动识别代码所需的第三方库
- 自动下载安装正确版本（避免版本冲突）
- 项目级依赖隔离（不同项目互不干扰）
- 参考：AutoEmbed 的 component-aware library resolution

### 6. 编译与烧录
- 内置编译器 或 云端编译（缩短本地环境配置时间）
- 自动检测串口 / COM 口
- 一键烧录到设备
- 编译错误自动 AI 解释 + 修复建议

### 7. 串口调试与反馈
- 实时串口监视器（日志输出）
- AI 解读设备输出（异常自动报警）
- 代码自动迭代修复循环（生成→测试→修复）

### 8. AI × Git 版本控制

- 项目创建时自动 `git init`，无需用户手动操作
- 每次 AI 生成/修改代码后自动提交，生成规范描述：
  - `feat: 添加 I2S 麦克风驱动`
  - `fix: 修复屏幕显示 BUG`
  - `refactor: 优化 WiFi 重连逻辑`
- 手动修改代码后，AI 自动识别变更内容并生成提交描述
- 烧录失败 / 设备异常时，一键回滚到上一个可用版本
- 对用户隐藏 Git 复杂性，以**时间轴 UI** 展示版本历史（类似 Figma 版本历史）
- 版本历史 = 项目开发日志，方便分享、复现、协作

> 差异化：所有竞品均无此功能，是入门创客"改乱了回不去"痛点的直接解法。

### 9. 项目模板库
- 常见场景模板（智能家居 / 环境监测 / 机器人 / 显示屏 / 网络通信）
- 一键复用 + 自定义修改
- 社区共享模板

---

## 类似产品全景

### 商业/在线平台

| 产品 | 类型 | 核心能力 | 不足 | 链接 |
|------|------|----------|------|------|
| **PleaseDoNotCode** | 网页 | AI 选传感器 → 自动画接线图 → 生成固件 → USB/WiFi 烧录，支持 100+ 开发板 | 闭源收费，无库管理 | [pleasedontcode.com](https://www.pleasedontcode.com/) |
| **Wokwi** | 网页仿真 | 浏览器内 Arduino/ESP32 仿真，集成 AI 代码生成，无需真实硬件 | 仿真为主，无烧录 | [wokwi.com](https://wokwi.com) |
| **Cirkit Designer** | 网页 | 浏览器内设计电路 + AI 接线 + 代码生成 + 仿真，支持 Arduino/ESP32/Pico | 闭源，仿真精度有限 | [cirkitdesigner.com](https://cirkitdesigner.com/) |
| **Embedr** | 网页 | AI workspace，自然语言 → 固件 + KiCad 原理图 + PCB 布局，覆盖从固件到硬件设计 | 闭源，偏专业用户 | [embedr.cc](https://www.embedr.cc/) |
| **Tinkercad** | 网页仿真 | Autodesk 出品，图形化电路设计 + Arduino 仿真，面向教育 | 无 AI 生成，仿真器件少 | [tinkercad.com](https://www.tinkercad.com/) |
| **ESP-Claw** | 工具 | 通过聊天与 ESP32 交互，无需写代码即可控制硬件 | 仅支持 ESP32，功能有限 | [hackster.io](https://www.hackster.io/news/esp-claw-lets-you-build-iot-projects-via-chat-4b7eead1c3ca) |

### 开源项目

| 项目 | 类型 | 核心能力 | 不足 | 链接 |
|------|------|----------|------|------|
| **aily-blockly** | 桌面 IDE | Blockly 积木 + AI 生成 + 库管理(npm) + 编译烧录 + 串口调试，支持 ESP32/STM32/NRF5 | Alpha 版，AI 生成为辅助 | [GitHub](https://github.com/ailyProject/aily-blockly) |
| **ArduinoGPT** | 桌面工具 | 自然语言 → Arduino 代码 → 自动编译上传，支持 Ollama/Groq，含接线文字说明 | 无库管理，无仿真 | [GitHub](https://github.com/ANBU-304/ArduinoGPT-AI-Based-Arduino-Development-Assistant) |
| **AutoEmbed** | 研究平台 | 全自动嵌入式软件开发：LLM + 硬件库知识注入 + 依赖解析 + 自动部署（ACM SenSys 2026） | 学术项目，无 GUI | [autoembed.github.io](https://autoembed.github.io/) |
| **AutoIOT** | 研究工具 | 自然语言 → AIoT 应用代码，自动迭代优化，本地执行保护隐私 | 学术项目，仅支持传感器数据处理 | [GitHub](https://github.com/lemingshen/AutoIOT) |
| **LLM4PLC** | 研究工具 | LLM 生成 PLC 工业控制代码，含形式化验证机制 | 仅 PLC，非消费级硬件 | [GitHub](https://github.com/AICPS/LLM_4_PLC) |
| **ubicomplab/llm-embedded** | 研究 | UW 研究，LLM 用于嵌入式系统代码生成与优化 | 纯研究，无工具链 | [GitHub](https://github.com/ubicomplab/llm-embedded) |
| **Singular Blockly** | VS Code 插件 | Blockly 积木 + PlatformIO 编译，支持 Arduino/MicroPython/ESP32，集成 GitHub Copilot MCP | 依赖 VS Code，无 AI 项目生成 | [Marketplace](https://marketplace.visualstudio.com/items?itemName=singular-ray.singular-blockly) |
| **PICMG/iot_builder** | 工具 | 基于配置文件自动生成 IoT 固件项目结构 | 无 AI，纯模板生成 | [GitHub](https://github.com/PICMG/iot_builder) |
| **project_generator** | 工具 | 嵌入式项目生成器，支持 IAR/uVision/Makefile/Eclipse 等多种 IDE | 无 AI，纯配置驱动 | [GitHub](https://github.com/project-generator/project_generator) |
| **Mixly（米思齐）** | 桌面 IDE | 国内最主流图形化编程，支持 Arduino/MicroPython，广泛用于中小学 | 无 AI 生成 | [GitHub](https://github.com/mixly/Mixly_Arduino) |
| **Mind+** | 桌面 IDE | DFRobot 出品，图形化+代码双模式，支持 Arduino/MicroPython/AI 模块 | 无自然语言输入 | [mindplus.cc](https://mindplus.cc) |
| **KidsBlock** | 桌面 IDE | 面向儿童，拖拽积木控制 Arduino/ESP32/Micro:bit | 无 AI，面向低龄 | [kidsblock.cc](https://www.kidsblock.cc/) |
| **ElectroBlocks** | 网页 | Blockly + Arduino 在线仿真器 | 无 AI，仿真器件少 | [GitHub](https://github.com/ElectroBlocks/ElectroBlocks) |
| **BlocklyDuino v2** | 网页 | Blockly 积木生成 Arduino 代码 | 无 AI，无编译烧录 | [GitHub](https://github.com/BlocklyDuino/BlocklyDuino-v2) |
| **Visuino** | 桌面 IDE | 图形化连线式编程，支持 Arduino/ESP32/STM32，无需写代码 | 商业收费，无 AI | [visuino.com](https://www.visuino.com/) |
| **MakeCode** | 网页 | 微软出品，Blockly + JavaScript，主要面向 Micro:bit/Circuit Playground | 硬件平台有限 | [makecode.com](https://makecode.com) |

---

## 竞品差异化分析

| 功能 | PleaseDoNotCode | Cirkit Designer | Embedr | aily-blockly | AutoEmbed | ArduinoGPT | **本产品目标** |
|------|:---------------:|:---------------:|:------:|:------------:|:---------:|:----------:|:-----------:|
| 自然语言输入 | ✅ | ✅ | ✅ | ✅ | 部分 | ✅ | ✅ |
| 硬件选型推荐 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 接线图生成 | ✅ | ✅ | ✅(PCB) | ✅ | ❌ | 文字 | ✅ |
| 库自动管理 | ❌ | ❌ | ❌ | ✅ | ✅(最强) | ❌ | ✅ |
| 一键编译烧录 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 串口调试 | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| 仿真模拟 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | 可选 |
| 可视化积木 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | 可选 |
| 错误自动修复 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 开源 | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 中文支持 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| 入门友好度 | 高 | 高 | 低 | 高 | 低 | 中 | **最高** |

---

## 产品形式选择

### 功能 vs 形式适配

| 功能 | 网页 | 桌面 IDE | VS Code 插件 |
|------|:----:|:--------:|:------------:|
| 自然语言输入 | ✅ | ✅ | ✅ |
| 硬件选型推荐 | ✅ | ✅ | ✅ |
| 接线图生成 | ✅ | ✅ | 受限 |
| 库自动管理（upypi） | ⚠️ 需后端 | ✅ 本地执行 | ✅ |
| 一键编译/烧录 | ❌ 串口受限 | ✅ | ✅ |
| mpremote 调试 | ❌ | ✅ | ✅ |
| 错误自动修复 | ✅ | ✅ | ✅ |
| 自动化测试生成 | ✅ | ✅ | ✅ |

**硬伤**：烧录和 mpremote 调试必须访问本地串口，网页做不到（Web Serial API 仅 Chrome 支持且不稳定）。

### 结论：桌面 IDE 为核心，网页+插件为入口漏斗

```
桌面 IDE（核心，跑完整链路）
    ↑ 引流
网页（模板库 + 在线体验 + SEO）
    ↑ 引流
VS Code 插件（覆盖已有开发者用户）
```

---

## 用户入口策略

**第一入口：首屏一个输入框**
产品打开就是 `"你想做什么？"` — 不选板子、不注册、直接说需求。零门槛冷启动，类似 ChatGPT 体验。

**第二入口：网页项目库**
后续项目库网页天然是 SEO 入口。用户搜"ESP32 温湿度"→ 落地页展示项目 → 引导"在 IDE 中打开" → 触发下载安装。

**第三入口：VS Code 插件（轻量钩子）**
不做完整功能，只做 AI 生成代码 + 跳转到桌面 IDE 烧录。覆盖已有开发者，降低迁移成本。

---

## 技术选型参考

- **AI 核心**：LLM（Claude / GPT）+ RAG（硬件库知识库）
- **库管理**：MicroPython → upypi.net 接口 + mpremote；Arduino → arduino-cli
- **调试**：MicroPython → mpremote REPL；Arduino → 串口监视器
- **编译**：arduino-cli / 无编译（MicroPython 直接运行）
- **前端**：Electron 桌面应用
- **串口通信**：serialport（Node.js）

---

## 优先级排序（MVP 建议）

1. 自然语言 → 代码生成（核心价值）
2. 一键烧录 + mpremote 调试（闭环体验）
3. 库自动管理（upypi 接口）（最大痛点）
4. 错误自动修复（减少用户挫败感）
5. 硬件选型推荐（降低门槛）
6. 接线图生成（锦上添花）
7. 自动化测试生成（进阶功能）

---

*基于对 AutoEmbed、AutoIOT、ArduinoGPT、aily-blockly 等开源项目的分析整理*
*2026-05-18*

---

## VS Code 插件架构详细设计

### 整体架构

```
用户操作（VS Code 插件）
    │
    ├── 本地执行（插件直接调用）
    │     ├── mpremote → 串口烧录/调试（物理串口，服务器够不到）
    │     ├── git      → 版本控制（操作本地仓库）
    │     └── 文件读写 → 项目文件（VS Code 工作区）
    │
    └── 服务器 API 调用（其余全部）
          ├── /generate    → 代码生成（LLM）
          ├── /search-lib  → upypi + GitHub 驱动搜索
          ├── /hardware    → 选型推荐 + 接线图（引脚 mapping 服务器维护）
          ├── /fix-error   → 错误修复分析（LLM）
          ├── /convert     → PDF/Arduino → MicroPython 驱动转换
          ├── /gen-test    → 测试代码生成（LLM）
          └── /git-msg     → 提交描述生成（diff → LLM）
```

**引脚 mapping 放服务器的好处**：新开发板支持无需用户更新插件，服务器更新即生效。

### VS Code 插件技术可行性

插件本质是 Node.js 进程，以下能力均支持：

| 能力 | API |
|------|-----|
| 调用本地 mpremote / git | `child_process.spawn` |
| 调用服务器 API | `fetch` / `axios` |
| 渲染接线图、时间轴、对话界面 | `WebviewPanel` |
| 读写本地项目文件 | `vscode.workspace.fs` |
| 显示 mpremote 实时输出 | `vscode.window.createTerminal` |

**插件只是本地执行层 + 服务器 API 的调用壳，轻量，业务逻辑全在服务器。**

---

### 模块一：代码生成

**流程：**
```
用户输入
  → upy-project skill 解析需求
  → 查 upypi（驱动包 + 文档作为 RAG 库）
  → upypi 没有 → GitHub Search API 搜元器件驱动
  → 套用 upy-code-arch skill 统一架构生成代码
```

**upy-code-arch skill.md 需定义：**
- 文件结构规范（`main.py` / `config.py` / `lib/`）
- 驱动封装模式（类结构、初始化、异常处理模板）
- upypi 包引用方式 vs 本地 `lib/` 放置方式

**执行位置：** LLM 调用、upypi 查询、GitHub 搜索 → 服务器；代码写入文件 → 本地

---

### 模块二：mpremote 烧录/调试

直接复用已有三个 skill 的逻辑，包装为 VS Code 命令：

| skill | 对应场景 |
|-------|----------|
| `mpremote-device-interaction` | 连接设备、检测串口、单次命令 |
| `mpremote-file-transfer` | 上传 `main.py` + `lib/` 到设备 |
| `mpremote-live-session` | 持久连接，实时读取输出 |

**执行位置：** 全部本地，零服务器依赖

---

### 模块三：错误自动修复

**upy-error-fix skill.md 定义：**

```
1. 代码生成时的调试点规范
   └─ 每个关键操作加 try/except + print(traceback)
   └─ 传感器初始化后加 print("OK") 确认点

2. 错误捕获流程
   └─ mpremote-live-session 读取输出
   └─ 匹配已知错误模式（ImportError / OSError / AttributeError）
   └─ 常见错误处理知识库（内嵌在 skill.md）

3. 修复闭环
   └─ 错误文本 → LLM（带 skill.md 上下文）→ 修复代码
   └─ 重新上传 → 重新运行 → 最多 3 次
```

**执行位置：** LLM 修复分析 → 服务器；mpremote 执行 → 本地

---

### 模块四：硬件助手

**选型逻辑（upy-hardware-select skill.md）：**
```
需求关键词
  → upypi 搜索（优先，有驱动即可用）
  → 没有 → GitHub 搜索元器件名 + "MicroPython"
  → 输出：型号 + 参数 + 是否有现成驱动
```

**接线图生成（upy-wiring skill.md）：**

需维护各开发板引脚 mapping 文件（本地 JSON），例如：
```json
{
  "ESP32":    { "SDA": "GPIO21", "SCL": "GPIO22", "TX": "GPIO1" },
  "ESP32-S3": { "SDA": "GPIO8",  "SCL": "GPIO9"  }
}
```
AI 根据传感器所需引脚类型 + 开发板 mapping → 生成接线表。

**执行位置：** upypi/GitHub 搜索、LLM 生成 → 服务器；mapping 文件查询 → 本地

---

### 模块五：AI × Git 版本控制

**upy-git-commit skill.md 定义：**
- 触发时机：AI 生成后 / 烧录成功后 / 用户手动触发
- 提交描述生成：diff → LLM → conventional commit 格式
- 回滚触发：烧录失败 / 用户指令

**时间轴 UI：** VS Code 插件 WebView + Timeline API（原生支持），展示 git log，点击可 checkout。

**执行位置：** git 命令 → 本地；提交描述生成 → LLM 服务器

---

### 模块六：自动化测试生成

**upy-test-gen skill.md 定义：**
- 业务代码生成的同时并行生成 `test_main.py`
- mock 规范：`machine.Pin` / `machine.I2C` 等用 `unittest.mock`
- 测试结构：每个传感器驱动一个 TestCase
- PC 端可运行，不依赖真实硬件

**执行位置：** LLM 生成 → 服务器；测试文件写入和运行 → 本地

---

### 本地 vs 服务器 汇总

| 功能 | 本地 | 服务器 |
|------|:----:|:------:|
| mpremote 烧录/调试 | ✅ | ❌ |
| 文件读写 / Git 操作 | ✅ | ❌ |
| 引脚 mapping 查询 | ✅ | ❌ |
| 代码/测试生成 | ❌ | ✅ LLM |
| upypi 库搜索 | ❌ | ✅ upypi API |
| GitHub 驱动搜索 | ❌ | ✅ GitHub API |
| 错误修复分析 | ❌ | ✅ LLM |
| Git 提交描述生成 | ❌ | ✅ LLM |
| 接线图生成 | ❌ | ✅ LLM（mapping服务器维护） |
| PDF 解析 → 驱动生成 | ❌ | ✅ 服务器端 PDF 解析 + LLM |
| Arduino 代码转换 | ❌ | ✅ LLM |

---

### 模块七：冷门硬件支持

upypi 和 GitHub 覆盖主流传感器，但冷门硬件（国产模块、工业传感器、新芯片）往往只有厂商 PDF 或 Arduino 代码，需要单独处理。

**子功能 A：参考代码转换（upy-convert-driver skill.md）**
```
输入：Arduino .ino / C++ 驱动代码
  → AI 分析寄存器操作 / I2C-SPI 时序 / GPIO 控制逻辑
  → API 映射：
      digitalWrite  → machine.Pin
      Wire.begin/write → machine.I2C
      SPI.transfer  → machine.SPI
      delay         → utime.sleep_ms
  → 输出：标准 MicroPython 驱动类
  → 同步触发 upy-test-gen 生成验证测试
```

**子功能 B：PDF 数据手册 → 驱动（upy-gen-driver skill.md）**
```
输入：PDF 数据手册
  → 服务器端提取：通信协议 / 寄存器地址表 / 初始化序列 / 时序图
  → LLM 生成驱动框架（类结构 + 寄存器常量 + 使用示例）
  → 输出放入项目 lib/
  → 自动触发 upy-test-gen 验证
```

**冷门硬件完整路径：**
```
用户提供冷门硬件
  → upypi 搜索 → 没有
  → GitHub 搜索 → 没有 / 只有 Arduino 代码
  → 用户上传 PDF 或 Arduino 代码
  → upy-convert-driver / upy-gen-driver（服务器）
  → 生成 MicroPython 驱动 → 放入 lib/
  → upy-test-gen 生成测试 → mpremote 验证（本地）
```

**执行位置：** PDF 解析、代码转换、驱动生成 → 服务器；驱动文件写入、mpremote 验证 → 本地

---

### skill.md 清单

| skill | 状态 | 作用 |
|-------|------|------|
| `upy-project` | 已有 | 需求解析 + 项目生成入口 |
| `mpremote-device-interaction` | 已有 | 设备连接 |
| `mpremote-file-transfer` | 已有 | 文件上传 |
| `mpremote-live-session` | 已有 | 持久调试会话 |
| `upy-norm-driver` | 已有 | 驱动规范化 |
| `upy-code-arch` | 待建 | 统一代码架构规范 |
| `upy-error-fix` | 待建 | 调试点规范 + 错误处理知识库 + 修复闭环 |
| `upy-hardware-select` | 待建 | 硬件选型逻辑（upypi优先→GitHub） |
| `upy-wiring` | 待建 | 接线图生成规则（引脚 mapping 服务器维护） |
| `upy-test-gen` | 待建 | 测试框架生成规范 |
| `upy-git-commit` | 待建 | AI 自动提交描述规则 |
| `upy-convert-driver` | 待建 | Arduino/C++ → MicroPython 转换规则 |
| `upy-gen-driver` | 待建 | PDF 数据手册 → MicroPython 驱动生成 |

已有 5 个 skill 直接复用，新增 8 个。

---

## VS Code 换皮方案

### 层次一：插件 WebView 全面接管 UI（MVP 阶段推荐）

VS Code 插件用 `WebviewPanel` 渲染任意 HTML/CSS/JS，把所有用户交互界面做成 WebView，用户大部分时间看到的是自己品牌的 UI：

```
侧边栏   → WebView（AI 对话 + 项目管理）
底部面板 → WebView（串口输出 + 调试时间轴）
编辑器区 → Monaco（可自定义主题 + 图标）
```

成本低，效果好，用户感知是"专属 IDE"。

### 层次二：VS Code 发行版（正式产品阶段）

VS Code 开源（MIT），fork 后修改：
- `product.json` → 应用名、Logo、启动画面
- 默认主题、图标包
- 内置扩展、欢迎页、菜单栏

代表案例：Cursor、Windsurf、VSCodium。工作量约 1~2 周配置，不需要改 VS Code 核心代码。

### 推荐路径

```
MVP 阶段   → 插件 WebView 换皮（先验证产品）
正式产品   → VS Code 发行版（用户下载的是"你的 IDE"）
```

---

## 子模块管理与 CI/CD 自动同步

### 子模块结构

将核心依赖作为 git submodule 纳入项目仓库：

```
项目根目录/
├── submodules/
│   ├── micropython/        # MicroPython 官方仓库
│   ├── upypi/              # upypi 库仓库（你们自己的）
│   └── mpremote/           # mpremote 工具仓库
├── scripts/
│   ├── extract_mpy_api.py  # 提取 MicroPython API 变更
│   ├── extract_upypi_pkg.py # 提取 upypi 新增/更新包列表
│   └── extract_mpremote_cmd.py # 提取 mpremote 命令变更
└── skills/
    ├── upy-code-arch.md
    ├── upy-error-fix.md
    └── ...（各 skill.md）
```

### API 提取脚本职责

| 脚本 | 监听内容 | 更新目标 skill |
|------|----------|---------------|
| `extract_mpy_api.py` | MicroPython 新模块、API 变更、废弃接口 | `upy-code-arch` / `upy-error-fix` |
| `extract_upypi_pkg.py` | upypi 新增包、版本更新、包描述 | `upy-hardware-select` / `upy-code-arch` |
| `extract_mpremote_cmd.py` | mpremote 新命令、参数变更 | `mpremote-device-interaction` / `mpremote-file-transfer` / `mpremote-live-session` |

### CI/CD 流程

```yaml
触发条件：submodule 任一更新（定时检查 或 webhook）
    ↓
1. git submodule update --remote
    ↓
2. 运行对应 extract_*.py 脚本
   → 输出：变更摘要 JSON
    ↓
3. LLM 读取变更摘要 → 更新对应 skill.md
    ↓
4. 自动提交：update: sync skill.md with micropython@{version}
    ↓
5. 触发服务器端 skill 热重载（无需重新部署）
```

### 核心价值

- **skill.md 始终与工具链版本同步**，AI 生成的代码不会用到已废弃的 API
- upypi 新增驱动包后，硬件选型推荐自动感知，无需人工维护
- mpremote 命令变更后，调试 skill 自动更新，不会出现命令不存在的错误

---

## AI 生成嵌入式代码：MicroPython vs Arduino 平台对比

> 从 AI 辅助开发的角度，分析哪个平台更适合作为"一句话造硬件"的代码生成目标。

### 评估维度

#### 1. 工程化调试闭环

**MicroPython 胜**

- REPL 交互式调试：无需重新烧录，直接在设备上执行单行代码验证
- `mpremote` 工具链：`run`、`exec`、`fs` 命令支持热更新单文件
- AI 生成代码 → `mpremote run main.py` → 立即看结果，闭环极短
- Arduino：每次改动必须完整编译（10s~60s）+ 烧录，闭环长

#### 2. 自动化测试框架

**MicroPython 胜**

- `unittest` 模块可直接在设备上运行
- AI 可生成引脚 mock、外设 stub，结构与 PC 端 Python 测试一致
- Arduino 没有标准测试框架，`ArduinoUnit` 等第三方库集成复杂
- AI 对 Python 测试代码的生成质量远高于 C++ 测试代码（训练数据优势）

#### 3. 开发者感知（算力/帧率/外设调度）

**Arduino 略胜，但差距在缩小**

- Arduino：`micros()`/`millis()` 精度高，裸机调度透明，资源占用可精确计算
- MicroPython：GC 暂停、解释器开销不透明，但：
  - `utime.ticks_us()` 可测帧率
  - `micropython.mem_info()` 可查内存
  - AI 可生成标准化 profiling 模板，弥补感知缺口

#### 4. 基本开发技能（内存/看门狗/重连）

| 能力 | MicroPython | Arduino |
|------|-------------|---------|
| 内存管理 | `gc.collect()` 显式调用，AI 易生成 | 手动 malloc/free，AI 易出错 |
| 看门狗 | `machine.WDT()` 一行搞定 | 寄存器操作，平台差异大 |
| 重连机制 | `try/except` 结构清晰，AI 生成质量高 | 状态机写法，AI 容易漏边界 |
| 异常保护 | Python 异常体系完整 | 需手写错误码，AI 容易不一致 |

MicroPython 的异常/重连代码，AI 生成的可靠性更高。

#### 5. 生成流程图/架构图/依赖图

**MicroPython 胜**

- Python 模块结构（`import`、类、函数）对静态分析友好
- AI 可直接从 `.py` 文件提取调用图、依赖图
- Arduino `.ino` 文件的隐式函数声明、多文件拼接机制让依赖分析困难
- Mermaid/PlantUML 生成：Python 代码结构更线性，AI 转换准确率更高

### 结论

| 维度 | 胜者 |
|------|------|
| 调试闭环 | MicroPython |
| 自动化测试 | MicroPython |
| 运行感知 | Arduino（微弱） |
| 基本开发技能 | MicroPython |
| 架构可视化 | MicroPython |

**对 AI 辅助嵌入式开发，MicroPython 是更适合的目标平台。** 核心原因是 Python 的结构化特性让 AI 生成、测试、分析代码的质量和可靠性系统性地高于 C/C++，而不只是"库多少"的问题。

*2026-05-18*

---

## 完整项目架构

### 仓库目录结构

```
one-sentence-hardware/
├── vscode-extension/          # VS Code 插件（本地执行层）
│   ├── src/
│   │   ├── commands/
│   │   │   ├── flash.ts       # 烧录 → 调用 mpremote
│   │   │   ├── debug.ts       # 调试 → mpremote live session
│   │   │   └── git.ts         # Git commit / rollback
│   │   ├── api/
│   │   │   └── client.ts      # 服务器 API 调用封装
│   │   └── webview/
│   │       ├── chat/          # AI 对话界面
│   │       ├── timeline/      # Git 时间轴 UI
│   │       └── wiring/        # 接线图渲染
│   └── package.json
│
├── server/                    # 服务器（AI 智能层）
│   ├── api/
│   │   ├── generate.ts        # 代码生成
│   │   ├── search-lib.ts      # upypi API 代理 + GitHub fallback
│   │   ├── hardware.ts        # 硬件选型 + 接线图
│   │   ├── fix-error.ts       # 错误修复闭环
│   │   ├── convert.ts         # PDF / Arduino → MicroPython
│   │   ├── gen-test.ts        # 测试代码生成
│   │   └── git-msg.ts         # 提交描述生成
│   ├── rag/
│   │   ├── board-mapping/     # 开发板引脚 mapping 数据库
│   │   └── error-patterns/    # 常见错误模式知识库
│   └── skills-loader/         # 动态加载 skill.md 注入 prompt
│
├── skills/                    # skill.md 知识库
│   ├── 已有（复用）
│   │   ├── upy-project.md
│   │   ├── mpremote-device-interaction.md
│   │   ├── mpremote-file-transfer.md
│   │   ├── mpremote-live-session.md
│   │   └── upy-norm-driver.md
│   └── 待建
│       ├── upy-code-arch.md       # 统一代码架构规范
│       ├── upy-error-fix.md       # 调试点 + 错误处理 + 修复闭环
│       ├── upy-hardware-select.md # 选型逻辑（upypi优先→GitHub）
│       ├── upy-wiring.md          # 接线图生成规则
│       ├── upy-test-gen.md        # 测试框架规范
│       ├── upy-git-commit.md      # 提交描述规则
│       ├── upy-convert-driver.md  # Arduino/C++ → MicroPython
│       └── upy-gen-driver.md      # PDF → 驱动生成
│
├── submodules/                # 工具链子模块
│   ├── micropython/           # git submodule
│   ├── upypi/                 # git submodule（upypi 仓库）
│   └── mpremote/              # git submodule
│
├── scripts/                   # API 提取 + CI/CD 脚本
│   ├── extract_mpy_api.py     # 提取 MicroPython API 变更
│   ├── extract_upypi_pkg.py   # 提取 upypi 新增/更新包
│   └── extract_mpremote_cmd.py # 提取 mpremote 命令变更
│
├── .github/workflows/
│   └── sync-skills.yml        # submodule 更新 → skill.md 自动同步
│
└── web/                       # 网页入口
    ├── landing/               # 首页（下载引导 + SEO）
    ├── projects/              # 项目模板库（第二用户入口）
    └── docs/                  # 文档站
```

---

### upypi 接口使用规范

upypi 是结构化驱动包仓库，直接调用 API，无需本地向量库。

```
# 搜索驱动包
GET https://upypi.net/api/search?q={关键词}
→ { query, results: [{name, url}] }

# 获取包详情（兼容性 + 文件列表）
GET https://upypi.net/pkgs/{name}/{version}/package.json
→ { name, version, chips, fw, urls }

# 读取驱动文档（规范化 README）
GET https://upypi.net/pkgs/{name}/{version}/README.md

# 安装到设备
mpremote mip install https://upypi.net/pkgs/{name}/{version}/package.json
```

**驱动包标准目录结构：**
```
{chip}_driver/
├── code/
│   ├── {chip}.py
│   ├── main.py
│   └── {subpkg}/
├── package.json
├── README.md
└── LICENSE
```

---

### 库搜索完整流程

```
AI 分析需求 → 确定所需传感器/模块
    ↓
GET upypi /api/search?q={传感器名}
    ↓
有结果
  → 读取 package.json（确认 chips/fw 兼容性）
  → 读取 README.md（获取 API 用法）
  → 生成代码按 README 示例调用
  → 安装：mpremote mip install {url}
    ↓
无结果
  → GitHub Search API 搜索 "{传感器名} MicroPython"
  → 有 → 读取代码，生成适配驱动
  → 无 → 引导用户上传 PDF 或 Arduino 代码
         → 服务器 /convert 生成 MicroPython 驱动
         → 放入项目 lib/
```

---

### 完整数据流

```
用户说一句话（插件 WebView）
    ↓
服务器 /generate
  ├── skills-loader 加载 upy-project + upy-code-arch
  ├── upypi search API 查询驱动
  ├── 没有 → GitHub API fallback
  └── LLM 生成业务代码 + 测试代码（并行）
    ↓
插件写入本地文件（main.py / test_main.py / lib/）
    ↓
服务器 /git-msg 生成提交描述 → 本地 git commit
    ↓
mpremote 上传文件 + 运行（本地串口）
    ↓
成功 → 串口输出显示在 WebView 时间轴
失败 → 错误发到服务器 /fix-error
       → LLM 分析 + 修复代码
       → 重新上传运行（最多 3 次）
```

---

### CI/CD 自动同步流程

```
submodule 任一更新（定时检查 or webhook）
    ↓
git submodule update --remote
    ↓
运行对应 extract_*.py 脚本 → 输出变更摘要 JSON
    ↓
LLM 读取变更摘要 → 更新对应 skill.md
    ↓
自动提交：update: sync skill.md with {module}@{version}
    ↓
服务器 skills-loader 热重载（无需重新部署）
```

---

### 三层用户入口

```
网页项目库（SEO 获客）
  → 用户搜"ESP32 温湿度" → 落地页展示项目
  → "在 IDE 中打开" → 触发插件安装

VS Code 插件（核心产品）
  → 完整功能链路
  → WebView 全面接管 UI（品牌化）

VS Code 发行版（后期品牌产品）
  → 同一套插件，fork VS Code 换皮打包
  → 用户下载的是"你的 IDE"
```

---

### 用户报错数据回流机制

**核心价值：** 用户真实失败案例是发现知识盲区的最直接信号，驱动 skill.md、error-patterns、board-mapping 持续迭代。

```
用户报错 → /fix-error 处理
    ↓
服务器埋点记录（可选上报，用户授权）：
  ├── 错误类型 + 原文 traceback
  ├── 开发板型号 + upypi 包名/版本
  ├── AI 第几次修复成功 / 最终失败
  └── 当前使用的 skill.md 版本号
```

**数据分析流程（每周/月定期）：**

```
聚合报错数据
    ↓
按错误类型分类：
  ├── ImportError     → upypi 缺包 / 包名不一致
  ├── OSError         → 接线错误 / board-mapping 有误
  ├── AttributeError  → API 用法与 README 不符
  └── 3次修复失败     → skill.md 知识盲区（最高优先级）
    ↓
LLM 聚合分析 → 输出改进建议报告
    ↓
人工审核确认
    ↓
更新 skill.md / error-patterns / board-mapping
    ↓
同一套 CI/CD 流提交 → 服务器热重载
```

**错误信号与知识库的映射关系：**

| 错误类型 | 说明 | 更新目标 |
|----------|------|----------|
| `ImportError` 高频 | upypi 缺少某类驱动 | 通知 upypi 补充包 / upy-hardware-select |
| `OSError: [Errno 19]` | 引脚 mapping 错误 | board-mapping 数据库 |
| `AttributeError` | README API 示例与实际不符 | upy-code-arch / upy-norm-driver |
| 3次修复全部失败 | 当前 error-fix skill 知识盲区 | upy-error-fix.md |
| 特定开发板高频报错 | 该板 mapping 或兼容性有问题 | board-mapping + upy-wiring |

**隐私原则：**
- 只收集错误类型和技术上下文，不收集用户业务代码
- 插件内明确提示，用户勾选"帮助改进产品"后才上报
- 数据匿名化处理，不关联用户身份

*2026-05-19*
