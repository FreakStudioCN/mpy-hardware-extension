# 00 — Architecture Overview

> 项目：**mpy-hardware-extension**（一句话生硬件 / MicroPython 硬件扩展）
> 适用版本：v0.2.0 MVP
> 读者：全员入门必读

---

## 1. 项目愿景与价值主张

**愿景**：用户说一句话 → 60 秒内开发板上的 LED 真的随温度亮起来。

**目标用户**：5 亿 hobbyist / 老师 / 学生 / 有创意但不会写代码的创作者。**不是** EE 工程师（那是 Schematik 的市场）。

**核心痛点**：从"我想做 X"到"X 真的工作"中间有 5 道坎——选型、接线、写代码、烧录、调试。每一道都让 90% 的人放弃。

**价值主张**：用户不用懂 GPIO 引脚、不用懂 I2C 协议、不用懂 import、不用懂 mpremote。

**核心赌注**：押 MicroPython 不押 C。理由是 MicroPython 解释型 → REPL 热加载 < 1 秒 → 错了 1 秒就知道 → 用户不放弃。Schematik 押 C 必然撞 5 个失败模式（编译慢、寄存器幻觉、硬故障易砖、SDK 碎片、闭环断裂）。

**护城河**：① 团队握有 MicroPython 生态第三方包管理工具链 ② uPyPi + GraftSense 驱动仓已有超过 200 个真实包/驱动可索引（治 LLM 幻觉）③ board manifest 白名单（治 5V 接 3.3V 烧板）④ skill 渐进披露库 + 真机错误样本的迭代节奏（治代码风格漂移 + 驱动用法漂移）。

---

## 2. 两仓库一产品

```mermaid
flowchart TD
    User[用户在 VS Code 输入<br/>"超过 30 度亮红灯"]
    subgraph VSC[mpyhw-vscode VS Code Extension]
        UI[WebView UI]
        Agent[<b>Agent Loop TS</b><br/>ReAct + tool registry +<br/>skill catalog + validator]
        Shim[python/shim/ 内嵌<br/>mpremote + pyserial 包装]
    end
    Api["<b>mpyhw-api</b> 薄代理<br/>LLM proxy SSE +<br/>content endpoints +<br/>quota / abuse"]
    LLM[Anthropic Claude Sonnet 4.6]
    Board[ESP32-S3 板]

    User --> UI --> Agent
    Agent -. stdio JSON-RPC .- Shim
    Agent <-->|HTTPS + SSE| Api
    Api <-->|HTTPS + SSE| LLM
    Shim <-->|USB serial / mpremote| Board
```

| 仓库 | 职责 | 语言 | 发布渠道 |
|---|---|---|---|
| `mpyhw-vscode` | 唯一面向用户的客户端：WebView UI + **agent loop**（ReAct / tool registry / skill catalog / manifest validator）+ 内嵌 `python/shim/`（本地 hardware IO）+ HTTPS 走 SSE 调 `mpyhw-api` | TypeScript + 嵌入式 Python 脚本 | VS Code Marketplace |
| `mpyhw-api` | **LLM 薄代理 + content 仓库 + Package Intelligence + 配额 + 防滥用**：透传 Anthropic Messages API（SSE 流式）、托管 skill / board profile / tool registry / package index / driver context 静态内容、接收 telemetry | Python (FastAPI) | 内部部署（Fly.io / Railway） |

**为什么不是三仓**：早期 spec 把 Python 业务逻辑抽成独立 `mpyhw-ai-core` PyPI 包，理由是"未来 multi-IDE 复用"。这是过早抽象——MVP 不做 multi-IDE（见 §10），独立成包只带来代价（独立 publishing pipeline、版本兼容矩阵、用户多一步 `pip install`）。Hardware shim 缩到 ~400 行后跟扩展深度耦合，合并进扩展仓后版本 skew 自动消失。

**为什么 agent loop 不在服务端**（V2 → V3 的关键回退）：上一版 spec 曾把 agent loop 推到 `mpyhw-api`，通过反向 RPC 调本地 shim。后来发现两个致命问题：①「SSE server-push」和「反向 RPC server→client→IO」语义天然冲突，无法和谐共存；② 业内全部 5 大 coding agent（Cursor / Claude Code / Cline / Continue / Aider）**全部**把 agent loop 跑客户端——它们这么做不是没想过，而是这套架构本质上就更稳。客户端 agent loop + 服务端薄代理是经过验证的成熟模式。详 [`04-coding-harness-design.md`](04-coding-harness-design.md) §3。

**关键设计原则**：
- **客户端 = agent brain**：所有 LLM-driven 业务（ReAct / tool dispatch / skill 选择 / validator / manifest schema）跑在 VS Code 扩展 TS 内
- **服务端 = 薄代理**：mpyhw-api 不跑 agent 逻辑，只做 LLM proxy + content fetch + quota + abuse
- **服务端死保的边界**：API key、intent gate prompt 文本（middleware 注入时 client 看不到）、tool 白名单校验、配额数学
- **本地 shim 仅 IO**：`python/shim/` 暴露 **7 个 IO RPC**（device.scan / flash_and_run / write_main_py / serial_read_until / list_files / health_check / install_package），完全不知道 LLM 是什么

---

## 3. 数据流（端到端）

### 3.0 系统抽象关系

系统不能按“只支持 AHT20 / DS18B20 / OLED”设计。正确抽象是分层：

| 层 | 含义 | 例子 | 谁负责 |
|---|---|---|---|
| **intent** | 用户自然语言目标 | “做一个温湿度超过 30 度亮红灯” | 用户 |
| **capability** | 抽象能力，不绑定具体硬件 | `temperature_sensing` / `humidity_sensing` / `display_text` / `digital_output` | agent 推断 |
| **package / driver** | 真实可安装的 MicroPython 包 | `aht20_driver` / `ds18b20_driver` / `ssd1306` | uPyPi + GraftSense |
| **driver context** | 机器可读的驱动使用说明 | import 名、构造函数、读数方法、总线类型、依赖、示例、已知坑、evidence refs | Package Intelligence 生成/缓存 |
| **manifest** | 本次项目的确定方案 | board、pin、packages、peripherals、logic、wiring | agent 生成 + validator 校验 |
| **project artifacts** | 可写到用户工程的文件 | `main.py`、`manifest.json`、接线表、README | `generate_code` |
| **runtime observation** | 真机执行结果 | import error、串口日志、超时、包安装失败 | shim + agent recovery |

所以“支持很多硬件”不是一开始人工列完所有硬件，而是让系统从包生态中发现候选，再按置信等级使用：

| 支持等级 | 定义 | 产品行为 |
|---|---|---|
| **Discoverable** | package index 能搜到，metadata 基本完整 | 可推荐，但要提示不确定 |
| **Installable** | 有 `package.json` / mip URL / deps，可装到 `/lib` | 允许生成 manifest，但需要更严格 audit |
| **Generatable** | 有 README / examples / driver context，能推导 import 和 API | 允许生成代码 |
| **Verified** | driver context 有 evidence，且在真机/CI/人工 golden recipe 跑通过 | 默认优先选择 |
| **Experimental** | metadata 缺失、README 不清、历史失败多 | 只在用户确认后尝试 |

v0.2 的 AHT20/DS18B20/LED 是 **golden path 验收样例**，不是硬件支持边界。产品边界是“从 package registry 发现和使用硬件能力”，质量边界由上面的支持等级表达。

**Package Intelligence ownership**：`mpyhw-api` 是 package search / resolve / driver-context 的唯一 canonical 实现。客户端只做 thin API client、缓存和 tool observation 包装，不能在 TS 端重写 ranking、package normalization 或 driver-context extraction。这样 Phase 1 的 curated seed records、Phase 2 的 uPyPi/GraftSense ingestion、未来的 verified recipes 都进入同一个 normalized package store，不出现“两套搜索逻辑”。

**Reuse-first source policy**：
- `FreakStudioCN/upypi`：第一 package source 和 package layout contract。
- GraftSense driver/docs corpus：第二 package/driver source，归一化进同一个 Package Intelligence store。
- `FreakStudioCN/MicroPython_Skills`：skill 内容种子库，提炼为服务端 content markdown，不作为运行时依赖。
- official `mpremote`：本地 IO 执行引擎；不使用 `adafruit-ampy`，MVP 不引入 `belay-py`。
- `thonny-upypi-manager`：只作 IDE 集成路径参考，不复制代码、不发布 Thonny 插件。

```
1. 用户在 VS Code WebView 输入框打字
2. Extension Host 触发 agent.runSession(intent, board_id):
   a. context_builder 组装 system parts:
      - Foundational skill bodies (打包)
      - cached board profile JSON (启动时从 /v1/boards 拉)
      - skill catalog (启动时从 /v1/skills 拉)
      - 已 load 的 skill bodies (本 session state)
      - cache_control: ephemeral markers (透传 Anthropic prompt cache)
   b. messages = [{role:"user", content: intent}]
3. ext POST /v1/llm/messages 走 SSE
4. mpyhw-api middleware 串联处理:
   a. 校验 tools 字段在 canonical whitelist 内 (不在 → 403)
   b. 配额检查
   c. 若是 session 第一轮 (messages.length == 1) → 强制在 system 首段注入 intent gate prompt
   d. 透传到 Anthropic Messages API stream=true
5. SSE 流回 client:
   - 第一个 text content_block 若以 "<not_hardware>" 开头 → ext close stream + UI 显示拒绝
   - 否则继续消费流; thinking tokens 实时推 WebView
6. 流到 tool_use block → ext 立即本地 dispatch:
   ┌─ local       : query_board_profile / propose_manifest / audit_code / load_skill
   ├─ api-proxy   : search_packages / resolve_package_candidates / get_package_context
   ├─ nested-LLM  : generate_code (开新 SSE 子流调 /v1/llm/messages, 拿生成代码)
   ├─ shim        : scan_device / install_package / flash_and_run / read_serial_until / write_main_py
   │                (stdio JSON-RPC 到内嵌 python/shim/)
   └─ ui-prompt   : ask_user (emit WebView 输入框, 等用户答完)
7. tool observation 入 messages → message_stop 后开新 SSE 子流继续 ReAct
8. 循环到 final_answer 或终止条件 (max_turns=20 / repair_round=3 / physical_blocker)
```

整个流程：1 个主 SSE 长连接（多轮 ReAct 在同一流内的多个 message_stop / 新流之间来回，但**没有反向 RPC**，**没有 8 次 HTTP roundtrip**）。

---

## 4. 已拍板决策汇总

| # | 决策 | 选择 |
|---|---|---|
| 1 | 用户唯一接触点 | VS Code Extension |
| 2 | thonny-upypi-manager 角色 | 仅作"路径存在证明"，不抄代码、不发布 |
| 3 | mpremote / package index / 串口实现 | 官方 `mpremote` CLI（subprocess）+ `httpx` 调 uPyPi/GraftSense 内容源 + `pyserial` 标准库 |
| 4 | Agent 模式 | Multi-step ReAct loop（reason → tool call → observation），**跑在客户端 TS** |
| 5 | LLM provider | Anthropic Claude Sonnet 4.6（启用 prompt cache） |
| 6 | 硬件支持 | board profile JSON plugin-style，架构无限制；MVP demo 锁 ESP32-S3 |
| 7 | 防滥用 | **Server middleware 强制注入 intent gate 到 LLM proxy 第一轮 system 首段**（client 看不到 prompt 文本，无法绕）；外加 tool 白名单 + abuse counter + 配额惩罚 |
| 8 | LLM 集成 | 服务器代理 + 每日免费额度 + BYOK fallback（v0.3 评估 BYOK 直连 Anthropic 跳过 api） |
| 9 | 客户端形态 | 单仓 VS Code 扩展，内嵌 `python/shim/` 子目录；shim 不发 PyPI |
| 10 | Skill 渐进披露 | 仿 Claude Code：Foundational 注入 + skill catalog 常驻 + `load_skill` tool LLM 主动加载 body |
| 11 | **Agent loop 位置** | **客户端 TS 内**，对齐 Cursor / Claude Code / Cline / Continue / Aider 业内主流；服务端不跑 agent |
| 12 | **LLM 流式** | **v0.2 直接上 SSE**（Anthropic Messages API stream=true 透传）；client token-by-token 显示 thinking |
| 13 | **Git 隐形 commit hook** | 扩展激活时若项目非 git repo → 自动 `git init`；每次代码生成/烧录成功后自动 `git add .` + `git commit`（commit message 走嵌套 SSE 让 LLM 生成）。**v0.2 不做** Timeline UI 和回滚 UI（推 v0.3）——commit 入 git 历史但用户不直接看 |
| 14 | **项目模板库** | 内置 3 个 intent 模板（温度阈值 LED / 按钮蜂鸣器 / OLED 显示）打包扩展 `resources/templates/`；模板只提供任务结构和推荐 board / pin，不限定硬件支持范围；具体传感器/外设仍走 package resolution |
| 15 | **uPyPi 包装到设备方式** | `mpremote mip install <package.json url>`（官方实现，自动递归 deps）；shim 调用前先 `mpremote fs mkdir :/lib`（idempotent） |

---

## 5. 依赖清单

### VS Code Extension (`mpyhw-vscode`)

| 包 | 用途 |
|---|---|
| `@vscode/vsce` | 打包 |
| `monaco-editor` | 代码 diff 高亮 |
| `xterm.js` | 串口流面板 |
| `eventsource` (或自实现 SSE parser ~50 行) | 消费 `/v1/llm/messages` SSE 流 |
| `zod` | TS-side schema 校验（manifest + board profile + tool args） |
| `simple-git` | Git 隐形 commit hook（决策 13）|

### `python/shim/`（扩展内嵌，跑在用户机器上）

| 库 | 用途 | 安装方式 |
|---|---|---|
| `mpremote` | 调 MicroPython 板（subprocess） | 扩展首次启动时在 `~/.mpyhw/venv/` 自动 `pip install` |
| `pyserial` | 串口降级 | 同上 |

用户**不需要**手动 `pip install` 任何东西。用户机器必须有 Python 3.10+（不 bundle runtime 是 MVP 的取舍，详 §9 风险表）。

### API (`mpyhw-api`)

| 库 | 用途 |
|---|---|
| `fastapi` | HTTP 框架（SSE 用 `StreamingResponse`） |
| `slowapi` | 限流 |
| `anthropic` | Claude SDK（带 `stream=true` 支持） |
| `httpx` | 调 uPyPi REST（代理）+ 流式转发 Anthropic |
| `sentry-sdk` | 错误监控 + telemetry breadcrumb 接收 |

**删了**：`pydantic` v2 的 manifest schema 模块（搬客户端 zod）、`instructor`（不需要——agent 逻辑在客户端）。

### 不在依赖里的（明确不用）

- **`belay-py`** —— 269 stars 活跃，但多一层依赖，v0.3 评估
- **`adafruit-ampy`** —— 已被 mpremote 取代
- **`thonny-upypi-manager`** —— 见下节
- **嵌入式 Python runtime** —— Codex 评估后 MVP 不 bundle（CI 矩阵 + 跨平台签名复杂度太大），v0.3 评估

---

## 6. thonny-upypi-manager 的角色

**不抄代码，不打包，不发布 Thonny 插件**。

它在我们项目里的全部价值是："**路径存在证明**"——证明了「在 IDE 里集成 mpremote + uPyPi + 串口管理」这条链路可以 work，给我们 v0.2.0 的设计提供了信心。

可能用到的极少数场景：
- 某 board 的 vid/pid 识别有怪异 edge case，翻它源码看怎么处理的
- 某个 uPyPi 包的 metadata 字段不规范，翻它怎么兜底

但这些都不会进我们的代码库。`python/shim/` 直接基于 `mpremote` CLI 官方文档自己实现；`mpyhw-api` 直接调 uPyPi REST API。

参考链接：https://github.com/FreakStudioCN/thonny-upypi-manager（README 里挂一下作为"灵感来源"致谢）

---

## 7. 防滥用总原则

我们提供 LLM 代理服务（用户用我们的 token），所以必须防止用户用我们的服务做"写网站 / 爬虫 / 邮件 / SQL"等非硬件需求。

**四层防御**（见 spec 04 §2 详细实现）：

| 层 | 位置 | 实现 | 作用 |
|---|---|---|---|
| 1（可选） | API 路由层 fast-path | 硬负向匹配 ≤ 10 行（命中"写网站/爬虫/SQL/翻译/写邮件"且无硬件 token） | 省一次 LLM call，nice-to-have |
| 2（必须） | **API middleware 注入 intent gate** | 第一轮请求时，middleware 在 messages 透传给 Anthropic 之前**强制**在 system 数组首段插入 intent gate 提示文本（client 永远看不到这段） | 唯一权威判断；零额外 LLM call |
| 3（必须） | **API middleware tool 白名单校验** | client 发的 `tools` 字段必须全部命中 canonical registry，不匹配 reject 403 | 防 client 发 `web_search` / `exec_arbitrary_python` 让 LLM 帮他干非硬件活 |
| 4（兜底） | abuse_counter | abuse counter 解析 SSE 第一 chunk 若是 `<not_hardware>` 则记一次 abuse；当日 ≥ 3 次配额清零 | 经济成本兜底 |

**为什么 intent gate 文本不下发 client**：放 client 端任何位置（即使是打包在扩展里的常量）都可被反编译 + 移除。Middleware 注入在 Anthropic 看到 system 之前 happens server-side，client 完全无法绕。

**BYOK 不绕过 intent gate**——BYOK key 只改计费来源；middleware 仍工作。

**拒绝时的提示**："这个工具只用于 MicroPython 硬件项目。请尝试 '让 ESP32 温度超 30 度亮 LED' 这样的描述。"

---

## 8. 术语表

| 术语 | 含义 |
|---|---|
| **capability** | 用户目标里的抽象硬件能力，如 `temperature_sensing`、`display_text`、`motor_actuation`。它不等于具体芯片或包名。 |
| **package / driver** | uPyPi / GraftSense 中真实存在、可查询、可安装的 MicroPython 包。agent 只能基于 package metadata / driver context 使用包，不能凭空编驱动 API。 |
| **driver context** | 从 `package.json`、README、examples、源码和真机错误样本提炼出的机器可读用法：import、class/function、bus、pin 角色、install URL、deps、known issues、support level。 |
| **manifest** | `HardwareManifest`，**TS zod schema** 定义，包含 board、capabilities、packages、peripherals、pin 分配、阈值、逻辑方向。从 user intent + package tools 派生。**Schema 现在住在客户端**。 |
| **board profile** | 单块板的描述 JSON（pin map、strap pins、可用模块、固件版本）；plugin-style 可扩展。**JSON 文件由 mpyhw-api 静态托管**，client 启动时 `GET /v1/boards` 拉缓存。 |
| **verified recipe** | 已在真机或可靠 CI 上跑通过的一组 board + package + wiring + code pattern。它是优先候选，不是唯一支持范围。 |
| **skill** | 给 LLM 的 markdown 指令文件，frontmatter 含 `name` + `description` + `when_to_use`，body 是详细行为指南。**Foundational** 打包到扩展始终注入 system；**其他** skill 的 frontmatter 进 catalog 常驻、body 由 LLM 通过 `load_skill` tool 按需加载（TS state mutation 无网络） |
| **tool** | agent 可调用的能力，按执行位置分四类：**local TS**（query_board_profile / propose_manifest / audit_code / load_skill）、**api-proxy**（search_packages / resolve_package_candidates / get_package_context）、**shim**（scan_device / install_package / flash_and_run / write_main_py / read_serial_until）、**ui-prompt**（ask_user） |
| **intent gate** | 服务端 middleware 在透传 Anthropic Messages API 第一轮时强制注入到 system 首段的判断指令；client 不可见 |
| **canonical tool registry** | mpyhw-api 维护的权威 tool 列表（14 个内置）；client 发的 tools 字段必须全部命中 |
| **SSE 主流 / 子流** | 主流 = ReAct 主循环里 client 发起的 `POST /v1/llm/messages`；子流 = `generate_code` 内部 client 嵌套发起的另一个 `POST /v1/llm/messages`（带专门的 code generation skill body） |
| **observation** | tool 执行结果（成功/失败/数据）。OpenHands 多态借鉴 |
| **round / turn** | 一次完整的 LLM SSE 流 + tool dispatch 循环（一次 message_stop） |
| **离线降级** | skill / board / tool catalog 一旦 client 缓存，UI 可启动、可看 device picker、可调 shim 读串口；只是需要 LLM 那一步必联网 |
| **generated artifact** | LLM 生成的代码文件（main.py）、manifest JSON 等成品 |

---

## 9. 风险 Top 6

| # | 风险 | P×I | 缓解 |
|---|---|---|---|
| 1 | LLM 生成代码真机错误率高 | 高×高 | multi-step agent 内置 audit/validate/preflight 三关；repair 兜底（详 spec 04 §10） |
| 2 | 免费额度耗尽体验断崖 | 高×中 | UI 显示剩余次数 + BYOK 一键填 key 引导 |
| 3 | Windows 上找不到 / 选错 Python interpreter | 高×中 | 扩展实现 interpreter 发现逻辑（Codex 要求，~100 行）+ `mpyhw.pythonPath` settings 覆盖 + 首次启动 health-check 命令打印诊断信息 |
| 4 | Windows 串口驱动阻断 demo | 中×高 | 文档前置驱动链接；`device.scan` 失败时弹安装指引（详 spec 03 §7） |
| 5 | 客户端 agent loop bug 修复要等扩展更新（vs 上版 server-side 立刻修） | 中×中 | agent loop 代码做到最薄（< 500 行 TS），bug 面积小；skill / board / tool 全从 server 拉，那些热更新照旧；agent 逻辑 A/B 仍要发版（可接受） |
| 6 | 社区贡献的 board profile 质量差导致烧板 | 中×中 | schema 严格校验；内置板 vs 社区板分类，社区板默认要求用户确认（详 spec 02 §「Board profile」） |
| 7 | 串口被外部进程占用（Thonny / 另一个 VS Code 窗口 / 手动 mpremote） | 中×中 | shim 实现 `~/.mpyhw/locks/{port}.lock` 文件锁（PID + stale lock cleanup）+ shim-internal asyncio per-port lock；扩展启动时检测锁状态弹窗指引（详 03 §4-bis） |
| 8 | git 仓库脏（用户外部改文件未 commit）| 中×低 | 扩展启动时 `git status` 检测 → 弹窗"检测到未提交改动，是否先 commit？" |

---

## 10. 路线图

| 版本 | 内容 |
|---|---|
| **v0.2.0**（本 MVP） | 两仓全发，VS Code Marketplace 发布；package index + driver context + support level 作为硬件扩展基础；golden path demo: **ESP32-S3 + AHT20（或 DS18B20）+ LED**；3 块板内置；inline intent gate（middleware）；skill 渐进披露完整实现；**SSE 流式从 day 1**；隐形 git auto-commit；接线表输出；3 个 intent 模板；`mpremote mip install` 包安装到设备 |
| v0.3.0 | GitHub OAuth + 注册用户额度；Linux 支持；Architect+Editor 两阶段生成；评估切 belay-py；评估 bundle 嵌入式 Python runtime；**BYOK 直连 Anthropic 跳过 api**；SSE 断流恢复（`Last-Event-Id`）；**Git Timeline UI + 一键回滚**；**测试代码生成（test_main.py）**；package index 增量同步与 package quality dashboard；PDF→驱动转换；Arduino→MicroPython 转换；GitHub Search API fallback；硬件型号推荐；报错周期分析；submodule CI/CD 同步 skill；网页项目库 SEO 入口 |
| v1.0.0 | 主动模块 BLE 自描述；**`.mpk` 打包 + uPyStore 应用商城对接**（项目结构 v0.2 已预留 main.py + lib/ + manifest.json）；VS Code 换皮 fork（Cursor 模式）；多模型切换 |

**Non-goal（明确不做）**：v0.x 不做 multi-IDE 复用（Thonny / 网页 / CLI）。后端 API 设计契约 IDE-agnostic（HTTP + JSON + SSE），但 v0.2 只产出 VS Code 一个客户端。

---

## 11. 文档导航

| 想了解 | 看这份 |
|---|---|
| 后端 API（薄代理 / content / quota） | [`02-mpyhw-api-spec.md`](02-mpyhw-api-spec.md) |
| VS Code 扩展实现（含 agent loop + 内嵌 hardware shim） | [`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md) |
| Agent 怎么思考、tool 怎么调、context 怎么管、skill 怎么渐进披露 | [`04-coding-harness-design.md`](04-coding-harness-design.md) |
| Product 视角 | `docs/product/core.md`、`docs/product/idea.md` |
