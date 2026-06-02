# 04 — Coding Harness Design

> 仓库：`mpyhw-vscode`（**agent loop 跑在客户端 TS 内**）+ `mpyhw-api`（薄代理）
> 适用版本：v0.2.0
> 读者：所有跟 LLM / agent 相关的开发；建议先读 [`00-architecture-overview.md`](00-architecture-overview.md) 和 [`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md)

这是整套 spec 里最长的一份，包含 13 节。Agent 怎么思考、tool 怎么调、skill 怎么渐进披露、context 怎么管、出错怎么修——全在这里。

**V3 关键事实**：agent loop **不在服务端**。所有 agent brain 跑在 VS Code 扩展 TypeScript 端。`mpyhw-api` 是薄代理，只做 LLM proxy SSE + content + quota + abuse。这是对齐 Cursor / Claude Code / Cline / Continue / Aider **业内全部 5 大 coding agent** 的成熟模式。

---

## 1. 我们的 Agent 与通用 Coding Agent 的本质差异

通用 coding agent（Aider / Cursor / Cline / Continue / Claude Code）改 git 仓库里的文件。我们要把代码烧到一块物理板子上跑然后看串口。这 5 条差异决定了 harness 的不同设计：

| # | 差异 | Harness 影响 |
|---|---|---|
| 1 | **失败成本物理化** | 通用 agent 错了 `git revert`；我们错了可能烧坏传感器或板子 → 必须有 deterministic 的 safety_audit 关卡，**LLM 永远不能直接控制 GPIO 输出** |
| 2 | **执行反馈延迟且窄** | 通用 agent stderr 立即；我们靠串口 100ms–2s 延迟，可能断连 → 串口必须作 first-class state，状态机要明确"等待 observation" |
| 3 | **物理接线不可观测** | LLM 假设的 pin 可能跟用户实际接的不一样 → manifest 必须把"用户真接了什么"作为 input，agent 必须经 `ask_user` tool 收集 |
| 4 | **运行时不能补包** | MicroPython 固件模块在 flash 时固化，`import` 缺包就崩 → 生成代码前必须经 `audit_code` 校验所有 import 都在 `board.available_modules + resolved_driver_context.import_names` 里 |
| 5 | **迭代慢（6–23s/轮）** | 通用 agent < 1s/轮；我们一轮要 mpremote 上传 + 等 boot + 等 5s 串口 → 所有可静态发现的错必须前置拦截，不能依赖"烧上去看" |

### 1.1 硬件支持的抽象关系

Agent 不直接从用户句子跳到某个传感器型号。它必须按这条链工作：

`intent → capabilities → package candidates → driver context → manifest → code → runtime observation`

- **capability**：抽象能力，如 `temperature_sensing`、`display_text`、`motor_actuation`，不绑定包名。
- **package candidates**：来自 uPyPi / GraftSense / curated recipes 的真实 MicroPython 包。
- **driver context**：机器可读的用法摘要，包括 import、构造函数、读写方法/属性、总线、pin roles、install URL、deps、known issues、support level、evidence refs。
- **manifest**：本次项目的确定方案，引用具体 package 和 wiring。

这层抽象解决“不能只支持几个硬件”的问题：v0.2 golden path 可以只验 AHT20/DS18B20/LED，但 agent 的工作流必须能搜索和尝试整个 package index。区别只在支持等级：`discoverable`、`installable`、`generatable`、`verified`、`experimental`。

Package Intelligence 的 canonical 实现在 `mpyhw-api`。客户端的 `search_packages` / `resolve_package_candidates` / `get_package_context` handler 是 thin HTTP wrapper；不得在客户端重写 package ranking、metadata normalization、driver-context extraction。这样 curated seed records、uPyPi ingestion、GraftSense ingestion、verified recipes 共用同一个 store 和同一套 support-level 规则。

**架构差异（与通用 coding agent 一致的部分）**：
- **Agent loop 在客户端**：跟 Cursor / Cline / Continue / Aider / Claude Code 一致；不再像 V2 那样把 agent 推到后端。
- **进程边界**：客户端 Extension Host 内 agent loop + 子进程 python/shim/ 跑 IO + 远端 mpyhw-api 透传 LLM。三层但不需要反向 RPC。

---

## 2. Intent Gate — 服务端 middleware 注入

### 2.1 位置

**服务端 middleware** 在透传 Anthropic Messages API 时，对每个 session 的第一轮（`messages.length == 1`）强制在 system 数组首段插入 intent gate 提示。

**Client 永远看不到这段文本**——它从 `mpyhw-api` 进程的 Python 常量直接进 Anthropic SDK 调用，从未走过网络也未进任何 client 可见数据结构。

### 2.2 Intent gate prompt 文本（server 端，Python 常量）

详 [`02-mpyhw-api-spec.md`](02-mpyhw-api-spec.md) §5.2。骨架：

```
INTENT GATE (only applies on this first turn):

You are about to help a user with a MicroPython hardware project. ...

If the user's intent is OUT OF SCOPE, your FIRST output token must be
the literal string "<not_hardware>" followed by a brief reason in the
user's language, then "</not_hardware>", then STOP.

If IN SCOPE, proceed normally — do not mention this gate.
```

### 2.3 Client 解析

`sse_client.ts` 消费 SSE 流时，偷看第一个 `content_block_delta`（type=text_delta）的开头字符。若以 `<not_hardware>` 起始：
- Client 仍**继续消费完**这个 content block（拿到完整 reason）
- 然后 close 流，emit `not_hardware` 事件给 UI
- 不进入正常 ReAct 流程（不调任何 tool）

### 2.4 拒绝时的提示

```
DEFAULT_REJECT_MSG = (
    "这个工具只用于 MicroPython 硬件项目。\n"
    "请尝试类似的描述：\n"
    "  • '让 ESP32 温度超 30 度亮 LED'\n"
    "  • '按钮按下蜂鸣器响'\n"
    "  • '用 BMP280 测气压并显示在 OLED'\n"
    "如果你确实在做硬件项目但工具误判了，请联系 support@mpyhw.dev"
)
```

LLM 输出的 `<not_hardware>原因</not_hardware>` 里的"原因"会拼到这段后面显示。

### 2.5 可选的 fast-path

详 [`02-mpyhw-api-spec.md`](02-mpyhw-api-spec.md) §11。FastAPI 路由层 ≤ 10 行硬负向匹配，命中直接 403。**真正权威**是 §2.1 的 middleware 注入。

### 2.6 为什么这是唯一防滥用层（与 V2 的对比）

V2 版本曾在客户端 Python 跑关键词分类器。V1 版本曾用纯关键词。V3 全删：
- 客户端代码可改 → 不是权威
- 既然每轮都要调 LLM，第一轮顺手判断零成本
- 词表更新要发版（用户升级阻力）
- 关键词易绕过："用 ESP32 帮我写网站" 命中正向关键词但意图非硬件

LLM inline 判断零额外 cost（intent gate 几百 token，享 cache），权威且语义稳。**且 prompt 文本不下发 client，攻击者无法绕**。

---

## 3. ReAct Agent 主循环（住在 mpyhw-vscode）

### 3.1 关键事实

- Agent loop 跑在 **VS Code 扩展 Extension Host TypeScript** 进程内
- 一次"turn" = 一次 SSE 流（`POST /v1/llm/messages` 到 message_stop）
- Tool dispatch 全本地（local / api-proxy / shim / ui-prompt 四种 executor），**无反向 RPC**
- 嵌套 LLM call（如 `generate_code`）开新 SSE 子流，不污染主流的 messages 历史
- `MAX_TURNS=20`、`MAX_REPAIR_ROUND=3` 都在客户端 TS 计数

### 3.2 完整伪代码（TypeScript）

详细伪代码见 [`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md) §5.2。骨架：

```typescript
async function runSession(intent, boardId, onEvent): Promise<SessionResult> {
  const session = newSession(intent, boardId);
  while (session.turnSeq < MAX_TURNS) {
    session.turnSeq++;

    // 1. 组装 system parts + tools + messages
    const system = contextBuilder.build(session, cachedBoardProfile, skillCatalog);
    const tools = toolRegistry.toAnthropicSchemas();

    // 2. 开 SSE 流到 mpyhw-api
    const stream = sseClient.postLlmMessages({ system, messages: session.messages, tools, ... });

    // 3. 消费流 → 拼 assistantContent + 检 not_hardware
    let assistantContent = [], firstText = "", stopReason = null;
    for await (const event of stream) {
      // ... 累积 text_delta / tool_use input_json_delta
      // 推 thinking_delta 给 UI 流式渲染
    }

    // 4. 第一轮检 not_hardware
    if (session.turnSeq === 1 && firstText.startsWith("<not_hardware>")) {
      return { terminal: "not_hardware", reason: parseReason(firstText) };
    }

    // 5. 加 assistant message 进历史
    session.messages.push({ role: "assistant", content: assistantContent });

    // 6. final_answer?
    if (stopReason === "end_turn") {
      return { terminal: "success", finalAnswer: extractText(assistantContent) };
    }

    // 7. dispatch tool_use blocks
    const toolUses = assistantContent.filter(b => b.type === "tool_use");
    const toolResults = [];
    for (const tc of toolUses) {
      if (requiresConfirm(tc.name) && !(await ui.confirm(tc))) {
        toolResults.push(rejectedResult(tc));
        continue;
      }
      const obs = await dispatchTool(tc.name, tc.input, session);
      toolResults.push(toolResult(tc, obs));
    }
    session.messages.push({ role: "user", content: toolResults });

    // 8. repair counter
    if (detectRepairCycle(session)) {
      session.repairRound++;
      if (session.repairRound > MAX_REPAIR_ROUND) return { terminal: "repair_exhausted" };
    }
  }
  return { terminal: "max_turns" };
}
```

### 3.3 全 session 状态

```typescript
interface SessionState {
  traceId: string;
  intent: string;
  boardId: string;
  loadedSkills: Set<string>;     // 已 load 的 skill name → 下轮 system 拼对应 body
  turnSeq: number;
  repairRound: number;
  messages: Message[];           // 完整对话历史
}
```

**全 session 状态住在客户端 TS 内**，无 server-side session store。Server 完全 stateless。

### 3.4 终止条件

详 §8。

### 3.5 实现参考

| 借鉴 | 出处 | 我们的对应 |
|---|---|---|
| Client-side agent loop + LLM streaming | **Cursor / Cline / Continue / Aider / Claude Code** 五家一致模式 | 我们 §3.2 主循环 |
| `apply_updates()` 的 try/dry-run/apply/reflect 流 | **Aider** `aider/coders/base_coder.py` | 我们的 `safety_audit` + `validator` 是 deterministic 关卡 |
| `self.reflected_message` 错误回灌 | **Aider** | tool observation 含 error 时下轮 LLM 自动看到 |
| `Agent.subscribe()` 事件流 | **Cline SDK** | 我们的 `onEvent` callback + WebView postMessage |
| Action / Observation 多态 | **OpenHands** | 我们的 tool observation Typed |
| Anthropic SDK SSE stream parsing | Anthropic 官方文档 | 我们的 `sse_client.ts` |
| **Anthropic Skill 渐进披露**（catalog + 主动 load） | **Claude Code** | 我们 §5 的 catalog + `load_skill` tool |
| Architect + Editor 两阶段 | **Aider** `architect_coder.py` | v0.3 实现 |
| **不抄**：反向 RPC（V2 自创） | 自我反省 | 删除：与 SSE 不兼容，跨进程延迟差，业内无此模式 |
| **不抄**：纯文本 shell 命令 | **SWE-agent** | 我们需要类型安全的 tool schema |
| **不抄**：SEARCH/REPLACE diff 格式 | **Aider** | MicroPython 代码短，整段重生成比 diff 可靠 |

---

## 4. Tool Registry — 14 个内置 Tool（按 executor 分类）

### 4.1 总览

| Tool | Executor | 用途 | 确认 | 平均耗时 |
|---|---|---|---|---|
| `query_board_profile` | **local** | 查 cached board profile JSON | 否 | 1ms |
| `propose_manifest` | **local** | 跑 TS validator（zod + 业务规则 + pin_capabilities 守门）| 否 | 5ms |
| `audit_code` | **local** | 跑 TS regex/AST 扫 banned API | 否 | 10ms |
| `load_skill` | **local** | 加 skill body 到 session.loadedSkills，下轮 system 见 | 否 | <1ms |
| `generate_code` | **local (nested SSE)** | 嵌套 SSE 子流调 `/v1/llm/messages` + 本地 safety_audit | 否 | 3–8s |
| `search_packages` | **api-proxy** | 调 `POST /v1/packages/search`，按关键词/能力/总线找真实包 | 否 | 200ms |
| `resolve_package_candidates` | **api-proxy** | 调 `POST /v1/packages/resolve`，从 intent + capabilities + board 排序候选 | 否 | 200-500ms |
| `get_package_context` | **api-proxy** | 调 `GET /v1/packages/{name}/{version}/driver-context`，拿 import/API/bus/deps/known issues | 否 | 200ms |
| `scan_device` | **shim** | 调 stdio `device.scan` | 否 | 500ms |
| `install_package` | **shim** | 调 stdio `device.install_package`（V3.1.2 新增；先 mkdir /lib 再 mip install；自动递归 deps）| **是** (batch confirm) | 3–10s |
| `flash_and_run` | **shim** | 调 stdio `device.flash_and_run` | **是** | 3–10s |
| `read_serial_until` | **shim** | 调 stdio `device.serial_read_until` | 否 | 0–8s |
| `write_main_py` | **shim** | 调 stdio `device.write_main_py`（命令含 `resume` flag） | **是** | 2s |
| `ask_user` | **ui-prompt** | emit WebView 输入框，等用户答完 | 否 | 不定 |

**v0.3 计划增加**：`generate_test`（test_main.py 生成，nested SSE）。**Git commit 不进 tool registry**——git auto-commit 是 ext-internal hook，agent 不主动调（详 spec 03 §5-tris）。

### 4.2 Executor 分类的意义

每个 tool 调用都在客户端 TS 内 dispatch：

- **local**：纯 TS 计算或对内存状态 mutation，立即返回
- **api-proxy**：HTTP 调 `mpyhw-api` 的 content endpoint，~200ms 一跳
- **local (nested SSE)**：本地 handler 内部开 `POST /v1/llm/messages` 子流（不污染主流 messages）
- **shim**：stdio JSON-RPC 调内嵌 `python/shim/`（5-20ms 进程通信 + mpremote 物理 IO）
- **ui-prompt**：emit `ui_prompt_needed` 给 WebView，等用户回填

**没有反向 RPC**——上述所有 dispatch 都不需要服务端配合，server 只在 `api-proxy` / `local nested SSE` 两类被调到，作为 content 来源。

### 4.3 单个 Tool 完整 schema 示例

跟 Anthropic Messages API 的 `tools` 参数完全兼容（客户端把这 14 个 schema 发到 `/v1/llm/messages` 的 `tools` 字段）：

```json
{
  "name": "search_packages",
  "description": "Search MicroPython package registry by keyword, capability, bus, and board. Use this to find real drivers before selecting concrete hardware packages.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Keyword like capability, sensor name, or chip name, e.g. 'temperature i2c', 'bme280', 'ssd1306'"
      }
    },
    "required": ["query"]
  }
}
```

Observation：

```json
{
  "status": "ok",
  "results": [
    {"name": "aht20_driver", "version": "1.0.0", "package_json_url": "https://upypi.net/pkgs/aht20_driver/1.0.0/package.json", "support_level": "verified", "score": 0.94}
  ],
  "total": 1,
  "cached": true
}
```

### 4.4 Tool `generate_code` —— 嵌套 SSE 子流

```typescript
handler: async (args, session) => {
  // 校验先做（fail fast）
  const vr = manifestValidator.validate(args.manifest, cachedBoardProfile);
  if (!vr.ok) return { status: "error", error_kind: "invalid_manifest", errors: vr.errors };

  const driverContexts = args.driver_contexts ?? session.resolvedDriverContexts;
  if (!driverContexts?.length) {
    return { status: "error", error_kind: "driver_context_missing",
             hint: "call get_package_context before generate_code" };
  }

  // 拉 code_generation_guide skill body
  const skillBody = await skillCatalog.fetchBody("code-generation-guide");

  // 开嵌套 SSE 子流（不污染主 session.messages）
  const subStream = sseClient.postLlmMessages({
    sessionId: session.traceId + "/sub-generate",
    system: [
      { type: "text", text: skillBody },
      { type: "text", text: boardProfileBrief(session.boardId) },
      { type: "text", text: `Driver contexts:\n${JSON.stringify(driverContexts)}` },
    ],
    messages: [{ role: "user",
                 content: `Generate main.py for this manifest:\n${JSON.stringify(args.manifest)}` }],
    tools: [],  // 子流不允许调 tool
    max_tokens: 4096,
  });

  // 消费子流拼完整代码
  let code = "";
  for await (const event of subStream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      code += event.delta.text;
    }
  }

  // 立即过 audit
  const ar = safetyAudit.audit(code, {
    boardProfile: cachedBoardProfile,
    driverContexts,
  });
  if (!ar.passed) {
    return { status: "error", error_kind: "banned_api", banned: ar.banned_calls,
             hint: "remove these calls and try again" };
  }

  return { status: "ok", code, audit: ar };
}
```

**注意子流也走 server middleware**：server 在子流的第一个 turn 也会注入 intent gate。但子流的 user message 是「生成 main.py 给这个 manifest」，明显是硬件 context，LLM 不会触发 not_hardware。

`generate_code` 必须使用 driver context 里的 `import_names`、`constructors`、`read_methods` / `read_properties` 和 examples。driver context 不足时返回 `driver_context_missing` 或 `driver_context_not_generatable`，不能让 LLM 凭记忆补 driver API。

### 4.5 Tool `ask_user`

```typescript
handler: async (args, session) => {
  const promptId = uuid4();
  uiClient.emit("ui_prompt_needed", { prompt_id: promptId, question: args.question });
  // 等用户回答（异步 Promise 由 WebView 的 ui_prompt_response 事件 resolve）
  const answer = await waitForUiPrompt(promptId);
  return { status: "ok", answer };
}
```

### 4.6 实现参考

| 借鉴 | 出处 |
|---|---|
| Tool interface 定义 | **Cline SDK** `packages/shared/src/types.ts` 的 `Tool` interface |
| `createTool()` 工厂函数 | **Cline SDK** 同上 |
| 嵌套 SSE 子流模式 | Anthropic SDK 多轮调用模式；Aider 的 `editor_coder` |
| 工具返回 `{error}` 而不抛 | **Cline SDK** |

---

## 5. Skill 系统 — Anthropic-style 渐进披露（客户端实现）

### 5.1 核心模型

| 类别 | 文件位置 | 注入时机 | 缓存 | 谁决定 load |
|---|---|---|---|---|
| **Foundational** | 扩展打包 `resources/skills/foundational/*.md` | 每轮始终注入 system prompt 头部 | ✓ ephemeral | harness（固定） |
| **Catalog** | 启动时 `GET /v1/skills` 拉，缓存到 workspace state | 每轮始终注入 system prompt 末尾（仅 frontmatter 概要） | ✓ ephemeral | harness（固定） |
| **Loaded body** | 被 `load_skill` 加载过的 skill 的 body（`GET /v1/skills/{name}` 拉） | 加载后所有后续轮注入 system 中部 | ✗ | **LLM 自己**（通过 `load_skill` tool） |

**核心思想**（仿 Claude Code）：LLM 看 catalog（每个 skill 一行简介）就知道有哪些可用，决定何时 load 哪个。Harness **不**写死"什么阶段注入什么 skill"的状态机。

**V3 与 V2 的差异**：catalog / body 都是客户端缓存 + 客户端组装；`load_skill` 不调任何网络（除非 body cache miss 才发 `GET /v1/skills/{name}`）。

### 5.2 Skill 文件格式

```markdown
---
name: manifest-resolution-guide
description: Use when the agent has user intent but no validated HardwareManifest yet. Guides discovery of board capabilities, peripheral search, pin assignment, and validation.
when_to_use: After intent classification passes, before generate_code is called
---

You are now in the manifest resolution phase. Your goal: turn the user's intent
into a complete HardwareManifest.

Required fields:
- board_id (already given)
- peripherals[] each with type, pin assignments
- logic {threshold, unit, condition, action}

Steps you should take:
1. query_board_profile to know available pins and modules
2. infer required capabilities from the user intent
3. resolve_package_candidates for each capability group to find real driver packages
4. get_package_context for selected packages before using imports, constructors, methods, or pin roles
5. If user didn't say which pin they wired sensors to, call ask_user
6. propose_manifest to validate; iterate on errors
```

### 5.3 内置 Skill 清单

#### Foundational（扩展打包）

- `agent_identity`
- `safety_boundaries`
- `tool_use_protocol`

骨架文本见 V2 spec §5.3（保持不变，无 V2→V3 修改）。Tool use protocol 文本里更新了 executor 分类的措辞：

```
Tool use rules:
- Call ONE tool at a time when possible, then wait for the observation before deciding next.
- Tools execute on different "executors":
  - local: instant (board profile lookup, manifest validation, audit, skill loading)
  - api-proxy: ~200-500ms (package search/resolve/context)
  - nested-LLM: 3-8s (generate_code, opens a focused sub-stream)
  - shim: 0.5-10s (physical IO via local mpremote / pyserial)
  - ui-prompt: depends on user (ask_user)
- If a tool returns {"status": "error"}, analyze why and try a different approach.
- When code ran successfully on the board, end with a final answer. Do NOT call more tools.
- Use ask_user only when missing critical info. Don't ask if you can find out via other tools.
- The skill catalog at the end of this prompt lists available task/recovery skills.
  When you encounter a situation matching one, call load_skill.
```

#### Task skills（在 catalog，按需 load，server 托管）

- `manifest_resolution_guide` — V3.1.2 含**依赖解析行为**（合并自 dependency_resolution_guide）+ **pin_recommendations 用法**
- `package_resolution_guide` — 从 intent 推 capabilities，调用 `search_packages` / `resolve_package_candidates` / `get_package_context`，按 support level 决定默认候选或询问用户
- `code_generation_guide` — V3.1.2 含**调试点规范**（try/except + print marker）+ **接线表输出指令** + **install_package 顺序提示**（在 flash 前装包）；必须使用 driver context 里的 import/API，不能凭空编驱动方法
- `serial_diagnosis_guide`
- `git_commit_guide` — V3.1.2 新增；嵌套 SSE 调用专用，生成 conventional commit message（feat:/fix:/refactor:/chore:）

`FreakStudioCN/MicroPython_Skills` 是 skill 内容的种子库，不是运行时依赖。v0.2 需要把其中 driver normalization、main/test 生成、mpremote file/device/live session、upy-project 的经验拆成上面的 task/recovery skills；真正运行时仍只通过本 spec 的 14 个 tool 调度。

#### Recovery skills（在 catalog，LLM 看 observation 自己决定 load，server 托管）

- `import_error_recovery`
- `pin_error_recovery`
- `i2c_not_found_recovery`
- `device_disconnected_recovery`
- `watchdog_reset_recovery`

### 5.4 Catalog 渲染（客户端 TS）

`skillCatalog.renderCatalog()` 返回拼到 system prompt 末尾的字符串：

```
AVAILABLE SKILLS (call load_skill with skill_name when relevant):

[task]
- manifest-resolution-guide: Use when the agent has user intent but no
  validated HardwareManifest yet.
  When to use: After intent classification passes, before generate_code is called

- code-generation-guide: ...
- serial-diagnosis-guide: ...

[recovery]
- import-error-recovery: ...
- pin-error-recovery: ...
- i2c-not-found-recovery: ...
- device-disconnected-recovery: ...
- watchdog-reset-recovery: ...
```

### 5.5 `load_skill` handler（客户端，纯 state mutation）

```typescript
handler: async (args, session) => {
  const name = args.skill_name;
  if (session.loadedSkills.has(name)) {
    return { status: "noop", already_loaded: true };
  }
  if (!skillCatalog.hasSkill(name)) {
    return { status: "error", error_kind: "unknown_skill", name };
  }
  // 提前 prefetch body 到 cache（避免下轮 context_builder 等网络）
  await skillCatalog.fetchBody(name);
  session.loadedSkills.add(name);
  uiClient.emit("skill_loaded", { skill_name: name });
  return { status: "ok", skill_name: name, loaded: true };
}
```

下一轮 `context_builder.build()` 会遍历 `session.loadedSkills`，把对应 body 拼进 system parts。

### 5.6 不重复 load + 没有 unload

- `load_skill` 已 load 的 skill → noop
- v0.2 没有 `unload_skill`
- v0.3 评估根据 session 阶段过期老 skill body

### 5.7 上游 5 个现成 skill 的映射

| 上游 skill | 我们的对应 |
|---|---|
| `upy-norm-driver` | 并入 `code_generation_guide` 的代码风格部分 |
| `upy-norm-main` | 并入 `code_generation_guide` 的主循环规范 |
| `upy-gen-main` | 并入 `code_generation_guide` 的整体规范 |
| `mpremote-file-transfer` | 改成 `write_main_py` tool 的 description |
| `mpremote-device-interaction` | 改成 `scan_device` / `flash_and_run` tool 的 description |
| `mpremote-live-session` | **不做 tool**，用 `read_serial_until` 一次性读一段然后回灌 |

### 5.8 为什么这个设计胜过 state machine 注入

| 维度 | 旧式（state machine 注入） | 现在（catalog + load_skill） |
|---|---|---|
| 加新 skill | 改 harness `_active_task_skill()` 代码 | 加 markdown 文件 → server 重启 → client `GET /v1/skills` 重拉 → 自动出现 |
| Recovery 触发 | harness 字符串匹配 `Traceback (...)` 后注入 | LLM 看 observation 自己 load |
| Skill 切换 | harness 决定何时切；LLM 被动接受 | LLM 主动决定；harness 不管 |
| Context 利用 | 所有 skill 都注入即使用不到 | 只有 LLM 决定要的进 context |
| 社区贡献 | 难（要改 Python） | 加 markdown 文件 + PR |

---

## 6. Context 管理算法

### 6.1 完整组装伪代码（客户端 TS）

```typescript
function build(session: SessionState, boardProfile: BoardProfile,
               catalog: SkillCatalog): SystemBlock[] {
  const parts: SystemBlock[] = [];

  // === Foundational（cache 区，固定顺序）===
  parts.push({ type: "text", text: catalog.foundational("agent_identity"),
               cache_control: { type: "ephemeral" } });
  parts.push({ type: "text", text: catalog.foundational("safety_boundaries"),
               cache_control: { type: "ephemeral" } });
  parts.push({ type: "text", text: catalog.foundational("tool_use_protocol"),
               cache_control: { type: "ephemeral" } });
  parts.push({ type: "text", text: serializeBoardProfile(boardProfile),
               cache_control: { type: "ephemeral" } });

  // === Loaded skill bodies（变化区，不 cache）===
  for (const skillName of session.loadedSkills) {
    parts.push({ type: "text", text: catalog.body(skillName) });
  }

  // === Catalog（cache 区，加 skill 文件才失效）===
  parts.push({ type: "text", text: catalog.renderCatalog(),
               cache_control: { type: "ephemeral" } });

  // ⚠️ 注意：intent gate 不在这里 —— 它由 server middleware 在主 SSE 第一轮注入

  return parts;
}
```

### 6.2 Board profile 序列化（精简）

```typescript
function serializeBoardProfile(p: BoardProfile): string {
  return JSON.stringify({
    board_id: p.board_id,
    micropython_version: p.micropython_versions_supported.at(-1),
    available_modules: p.available_modules,
    safe_voltage_pins: p.safe_voltage_pins,
    strap_pins_AVOID: p.strap_pins,
    forbidden_pins_AVOID: p.forbidden_pins,
    supported_peripherals: p.supported_peripherals,
  });
}
```

### 6.3 Messages 历史 & 截断规则

```typescript
function serializeObs(obs: object, toolName: string): string {
  let content = JSON.stringify(obs);
  if (toolName === "read_serial_until" && content.length > 2000) {
    content = '{"status":"truncated_head","tail":"...' + content.slice(-1900);
  }
  return content.slice(0, 8000);
}
```

### 6.4 截断规则总览

| 来源 | 上限 | 策略 | 理由 |
|---|---|---|---|
| serial output | 2000 chars | 保尾部 | 错误信息通常在末尾 |
| available_modules list | 不截断 | — | 防 ImportError 核心保障 |
| board_profile JSON | 已精简 ~500 chars | — | 序列化时只挑必需字段 |
| LLM 返回的代码 | 4000 chars | 保留完整 | agent 需要看到完整代码做 audit / repair |
| skill body | 每个 ~300–800 chars | 保留完整 | 本来就短 |
| catalog | ~80 chars × N skills | 保留完整 | 是 LLM 唯一知道 skill 存在的渠道 |
| 历史轮 | 不主动截断 | 超 100K → abort session | 不做摘要避免丢失错误细节 |

### 6.5 Prompt Cache 切点

| Block | Cache? | 失效触发 |
|---|---|---|
| Foundational skills 前 3 段 | ✓ | 扩展更新（带新打包文件） |
| Board profile JSON | ✓ | 切 board |
| Loaded skill bodies | ✗ | LLM 每次可能 load 不同 skill |
| Catalog | ✓ | 加 / 删 / 改 skill（catalog version 变） |
| Messages | ✗ | 每轮新增 |
| Intent gate（server 注入） | 不由 client 控制 | 仅第一轮注入 |

`cache_control: ephemeral` marker 由 client 在 system parts 里加，通过 `/v1/llm/messages` 透传到 Anthropic，命中缓存正常工作。

### 6.6 不做的事

- ❌ 不主动摘要历史（hardware 错误细节不能丢）
- ❌ 不裁掉早期 tool_call（agent 需要看见自己之前查过什么）
- ❌ 不缓存 LLM 响应（每轮新鲜，避免缓存导致旧错误持续）
- ❌ 不在客户端实现 prompt cache（让 Anthropic 自己做）

---

## 7. 工具 vs 直接生成代码的边界

**全部经 tool**。

| 行为 | 经哪个 tool | 为什么不直接给 LLM 主循环吐 |
|---|---|---|
| 生成 main.py | `generate_code`（内部嵌套 SSE 子流） | 主流看到统一 tool_call / observation，便于审计和重试 |
| 提出 manifest | `propose_manifest` | validator 是 deterministic 关卡，observation 让 LLM 学 |
| 查询板子信息 | `query_board_profile` | 客观数据，不让 LLM 凭记忆答 |
| 调命令 | `flash_and_run` / `write_main_py` | 隔离副作用，方便加 user_confirm |
| 加载 skill 详细指南 | `load_skill` | LLM 主动决定何时获取详细行为指南 |

**结论**：LLM 主循环里**没有"裸文本输出"是一个产物**。LLM 要么调 tool，要么给 final_answer，要么 reasoning 文字（说思路，但不作为产物消费）。

---

## 8. 双终止条件

### 8.1 Agent loop（外层）MAX_TURNS = 20

客户端 TS 累计的 `session.turnSeq` ≥ 20 → 返回 `{ terminal: "max_turns" }`。

### 8.2 Repair loop（内层）MAX_REPAIR_ROUND = 3

`generate_code` + `flash_and_run` + `read_serial_until` 失败后，agent 可能再调一次 `generate_code` 修代码——这叫一个 repair round。客户端 TS 全局计数。

为什么不让 agent 无限自己修：
- 慢循环：每轮 6–23s
- 失败成本：可能撞物理问题（接线错），LLM 自己修不出来
- 成本：每轮 LLM token 钱

3 轮没修好 → `{ terminal: "repair_exhausted" }` → UI 引导 `ask_user` 介入。

### 8.3 4 个 Terminal 条件汇总

| Reason | 触发 | 用户体验 |
|---|---|---|
| `success` | `stop_reason == "end_turn"` + 上一次 `read_serial_until` 看到预定 marker | UI 显示 "✓ 完成，板子运行正常" |
| `max_turns` | turnSeq ≥ 20 | UI 显示 "尝试次数已达上限，请检查 agent trace" |
| `repair_exhausted` | repairRound ≥ 3 | UI 显示 "自动修复失败，建议人工检查接线/型号" |
| `not_hardware` | 第一轮 LLM 输出 `<not_hardware>` | UI 显示拒绝提示 |
| `physical_blocker` | 设备断连 / I2C 找不到地址 / 用户拒绝 confirm | UI 显示具体物理问题描述 + 修复建议 |

---

## 9. 借鉴的开源 Harness 模式（汇总）

| 模式 | 出处 | 我们怎么用 | 引用文件 |
|---|---|---|---|
| **Client-side agent loop + LLM streaming SSE** | **Cursor / Cline / Continue / Aider / Claude Code 业内统一** | V3 整体架构 | 各家源码 |
| `apply_updates` try/dry-run/apply/reflect | **Aider** | agent 主循环 + `audit_code`/`validator` 作 deterministic 关卡 | `aider/coders/base_coder.py` |
| `reflected_message` 错误回灌 | **Aider** | observation 含 error 时下轮 LLM 自然看到 | 同上 |
| **Anthropic Skill 渐进披露**（description in system + LLM-driven load） | **Claude Code** | catalog + `load_skill` tool | Anthropic docs |
| Architect + Editor 两阶段 | **Aider** | v0.3 实现 | `architect_coder.py` |
| `createTool()` 工厂 + executor categorization | **Cline SDK** | `tool_registry.ts` | `packages/shared/src/types.ts` |
| `Agent.subscribe()` 事件流 | **Cline SDK** | `onEvent` callback + WebView postMessage | 同上 |
| Action / Observation 多态 | **OpenHands** | tool observation Typed | `openhands/events/` |
| Anthropic SDK SSE event format | Anthropic 官方 | `sse_client.ts` | docs.anthropic.com |
| Prompt cache 精确切点 | Anthropic 官方 | 详 §6.5 | docs.anthropic.com |
| **不抄**：纯文本 shell 命令 | **SWE-agent** | 我们需要类型安全的 tool schema | — |
| **不抄**：SEARCH/REPLACE diff 格式 | **Aider** | MicroPython 代码短，整段重生成比 diff 可靠 | — |
| **不抄**：本地关键词 intent classifier | V1 自创 | 删除 —— 用 server middleware 注入 inline gate 替代 | — |
| **不抄**：服务端 agent loop + 反向 RPC | V2 自创 | 删除 —— 与 SSE 冲突；业内无此模式 | — |

---

## 10. 失败模式 + 缓解（详表）

| # | 失败 | 触发场景 | 缓解 |
|---|---|---|---|
| 1 | Tool 调用打转 | LLM 反复 `query_board_profile` 不前进 | MAX_TURNS=20 硬截；每 5 turn 检查 manifest 字段是否进展 |
| 2 | Context 爆炸 | tool history 累积超 100K token | 不做摘要；直接 abort 并提示用户 "请缩小需求范围" |
| 3 | Tool 幻觉（不存在的 tool 名） | LLM 编造工具 | `tool_registry.dispatch` 返回 `UnknownToolError` observation 喂回 |
| 4 | Skill 幻觉（load_skill 写错名字） | LLM 编造 skill_name | handler 返回 `error_kind="unknown_skill"`，让 LLM 看 catalog 重选 |
| 5 | Manifest 死锁 | `propose_manifest` 反复 validator fail | 连续 3 次同 root cause → 强制 `ask_user` 介入 |
| 6 | Repair 无穷 | flash 失败后反复重生成 | 全局 round counter max=3 |
| 7 | 滥用 / 非硬件 intent | 用户写"帮我写网站" | server middleware 注入 intent gate（client 无法绕） |
| 8 | LLM 幻觉 pin | LLM 选了 `GPIO_FAKE` | `manifest_validator.ts` 强制关卡，`propose_manifest` 返回 ForbiddenPinError |
| 9 | 包版本漂移 | 包升级 API 变了 | `get_package_context` 锁定精确版本，manifest 写 pinned version |
| 10 | 串口断连 | 烧录中拔了 USB | shim 返回 `DeviceDisconnected`，作 observation；LLM 看到自然 `load_skill("device_disconnected_recovery")` |
| 11 | I2C 扫不到地址 | 接线错 / 用户买错传感器 | `read_serial_until` 含特定模式 → LLM `load_skill("i2c_not_found_recovery")` 后 `ask_user` |
| 12 | 跨语言 intent（用户中英混） | "make ESP32 灯亮" | LLM inline gate 多语言原生支持 |
| 13 | Shim 进程崩溃 / Python 没装 | 用户没装 Python；shim 启动失败 | 客户端 `findPython()` + 弹窗指引（详 spec 03 §4）；shim 崩溃时 ext 自动重启一次 + Sentry 上报 |
| 14 | **SSE 流中断** | 网络抖动 / Fly.io 重启 / Anthropic 5xx | 客户端保留已收 messages；UI 提示 "网络中断，[重试] / [中止]"；点重试 → 用现有 messages 重发 `/v1/llm/messages`（agent 看到自己之前调过什么 tool 自然继续） |
| 15 | **缓存的 skill / board / tool 过期** | server 加新 skill 或改 board profile | client 启动时 `If-None-Match: <version>` 检查；过期重拉；运行中不重拉避免 mid-session state 漂移 |
| 16 | **Tool 白名单不一致** | client 打包的 tool 比 server canonical 多/少 | client 启动时 `GET /v1/tools` 比对，差异 → 警告用户"扩展可能需要升级"，但允许继续（用 client 自带 schema） |
| 17 | LLM 输出非 JSON | response 格式坏 | Anthropic SDK 自带 retry；超过 3 次 → terminal `api_error` |
| 18 | Confirm 弹窗用户关掉 VS Code | 用户烦了直接关 | `await waitForUserConfirm()` 在 ext deactivate 时 reject → session abort，保留 messages 下次启动可继续 |
| **19** | **Git 仓库脏**（用户外部改文件未 commit） | 用户在 VS Code 外部用别的编辑器改了文件，没 commit 就启动 agent | 扩展启动 `git status` 检测 → 弹窗 "检测到未提交改动，是否先 commit？" → 走自动 commit flow（详 spec 03 §5-tris） |
| **20** | **install_package 失败** | 包 chip 不兼容、网络断、包不存在、mpremote 非分类错误 | shim 返回 `{status:"error", error_kind:"package_not_found"\|"incompatible_chip"\|"network"\|"port_busy"\|"mpremote_error"}`；observation 给 LLM → LLM 看错误自然换包或 `ask_user` |
| **21** | **driver context 缺失** | 包能搜到但 README/examples 不足，无法确定 import/API | `get_package_context` 返回 `driver_context_missing`；agent 降级为 experimental，必须 `ask_user` 或换 verified/generatable 候选 |
| **22** | **串口被外部进程占用** | Thonny 在跑、另一个 mpyhw-vscode 窗口已经占 port | shim 拿 lock 后探测 `mpremote exec "pass"` 失败 → 返回 `{status:"error", error_kind:"port_busy"}` + ext 弹窗指引关闭占用方（详 spec 03 §4.4 + §4-bis.4） |
| **23** | **LLM 编出不在 pin_capabilities 的 role** | manifest 含 `{pin:"GPIO2", role:"spi_mosi"}` 但 board profile 的 `pin_capabilities["GPIO2"]` 不含 spi_mosi | `manifest_validator.ts` 强制拒绝；returns `error_kind="capability_violation"` + 列出该 pin 实际 capabilities → LLM 自然 load `pin_error_recovery` |

---

## 11. 可观测性 + 调试

### 11.1 ID 体系

- `trace_id = uuid4()`：客户端生成，每个 session 一个
- `turn_seq`：每个 SSE 流递增
- Sub-stream（如 `generate_code`）共享父 trace_id 加 sub-id 后缀

`trace_id` 贯穿三个进程：vscode（生成）→ api（透传 + Sentry breadcrumb）→ shim（args 里加 `_trace_id` 字段，shim 写日志）→ Anthropic（HTTP header `x-anthropic-metadata`）。

### 11.2 必 log 的事件

客户端 ext 收集所有事件，批量 `POST /v1/telemetry`：

| Event | 字段 |
|---|---|
| `session_started` | trace_id, intent_hash, board_id, ts |
| `turn_started` | trace_id, turn_seq, ts |
| `tool_dispatch` | trace_id, turn_seq, name, executor, args_hash |
| `tool_result` | trace_id, turn_seq, name, status, duration_ms |
| `shim_call` | trace_id, method, status, duration_ms |
| `skill_loaded` | trace_id, skill_name, turn_seq |
| `not_hardware_detected` | trace_id, intent_hash, reason_hash |
| `terminal` | trace_id, reason, total_turns, total_tokens |
| `sse_stream_interrupted` | trace_id, turn_seq, bytes_received |

Server 收 `/v1/telemetry` 转 Sentry breadcrumb，**不存** payload 内容。

### 11.3 不 log 的（隐私 + 噪音）

- 完整 LLM messages（仅 sha256 哈希）
- 完整用户代码（仅 sha256）
- 每行 serial（只 log 含 exception/error 的行）
- shim args 里的 `code` 字段（仅 hash）

### 11.4 失败类型 → 必查日志

| 失败 | 立即查 |
|---|---|
| `BANNED_API` | 客户端 tool_result 里 `audit_code` 的 `banned` 字段 |
| `FLASH_FAIL` | shim_call observation 的 stderr 全文（开发者模式可看） |
| `SERIAL_TIMEOUT` | shim observation + shim 端 tail buffer |
| `MANIFEST_INCOMPLETE` | client tool_result `propose_manifest` 的 errors[] |
| `MAX_TURNS` | tool_dispatch 序列（仅 name + status） |
| `NOT_HARDWARE` | not_hardware_detected event 里的 intent_hash + reason_hash |
| `SHIM_CRASH` | 客户端 stderr 捕获 + Sentry |
| `SSE_INTERRUPTED` | sse_stream_interrupted event + 客户端最近一次 fetch 的 status |

### 11.5 开发者模式

UI 抽屉显示完整 agent trace（每个 turn 的 SSE event stream + tool dispatch + observation 全 JSON）。用户可一键复制到剪贴板用于报 bug。

健康检查按钮跑 `device.health_check` → 输出 python / mpremote / 串口设备列表（Codex 要求的唯一诊断 surface）。

---

## 12. 端到端 Agent Trace 示例

以下是一次完整 session 的 trace，展示 SSE 流 + 本地 tool dispatch + 嵌套子流形态：

```
[trace_id=8f3a...; intent="超过 30 度亮红灯"; board=esp32-s3-devkitc-1]

=========== 主 SSE 流 #1 (turn 1) ===========

[client] context_builder.build() →
  system parts: [Foundational×3, board profile, package index summary, catalog (含 8 skill 概要)]
  messages: [{role:"user", content:"超过 30 度亮红灯"}]
  tools: [14 canonical schemas]

[client] POST /v1/llm/messages stream=true
  body: {sessionId:"8f3a...", system, messages, tools}

[api middleware]
  tool_whitelist OK (14 tools 全在 canonical)
  intent_gate: messages.length==1 → inject INTENT_GATE_PROMPT 到 system[0]
  proxy → Anthropic Messages API stream=true

[api → client SSE]
  message_start
  content_block_start {type:"text"}
  content_block_delta "我先查"           ← UI 显示 thinking
  content_block_delta "板子配置。"
  content_block_stop
  content_block_start {type:"tool_use", name:"query_board_profile",
                       id:"toolu_01..."}
  content_block_delta input_json "{}"
  content_block_stop
  message_delta stop_reason="tool_use"
  message_stop

[client] dispatch query_board_profile (local) → 查 cached boardProfile → obs
[client] messages += [assistant, tool_result]

=========== 主 SSE 流 #2 (turn 2) ===========

[client] POST /v1/llm/messages
[api middleware] messages.length > 1 → 不注入 intent_gate
[api → client SSE]
  thinking: "需要把温湿度需求解析成能力，再从包目录找候选"
  tool_use: resolve_package_candidates(intent="超过 30 度亮红灯",
                                      capabilities=["temperature_sensing", "digital_output"],
                                      board_id="esp32-s3-devkitc-1")
  message_stop

[client] dispatch resolve_package_candidates (api-proxy) → POST /v1/packages/resolve → obs
        {selected:{name:"aht20_driver", version:"1.0.0",
                   package_json_url:"https://upypi.net/pkgs/aht20_driver/1.0.0/package.json",
                   support_level:"verified", score:0.94},
         needs_user_choice:false}

=========== 主 SSE 流 #3 (turn 3) ===========

[client → api → Anthropic]
  thinking: "先拿 driver context，避免编错 import 或方法名。"
  tool_use: get_package_context(name="aht20_driver", version="1.0.0")

[client] dispatch (api-proxy) → GET /v1/packages/aht20_driver/1.0.0/driver-context → obs
        {import_names:["aht20"], constructors:["AHT20(i2c)"],
         read_methods:["read_temperature()", "read_humidity()"],
         bus:["i2c"], pin_roles:["i2c_sda", "i2c_scl"],
         confidence:0.91}

=========== 主 SSE 流 #4 (turn 4) ===========

[Anthropic SSE]
  thinking: "需要 manifest_resolution_guide 的详细规范。"
  tool_use: load_skill(skill_name="manifest-resolution-guide",
                       reason="构建 manifest")

[client] dispatch load_skill (local) → session.loadedSkills.add → obs {ok}
[client] 下轮 context_builder 会把 manifest-resolution-guide body 拼进 system

=========== 主 SSE 流 #5 (turn 5) ===========

[client context_builder]
  system parts: [Foundational×3, board profile, package index summary,
                 manifest-resolution-guide body,   ← 新增
                 catalog]

[Anthropic SSE]
  thinking: "用户没说接哪个 pin。问一下。"
  tool_use: ask_user(question="温湿度传感器和 LED 各接哪个 pin？...")

[client] dispatch ask_user (ui-prompt) → emit ui_prompt_needed → WebView 渲染输入框
[user] 输入"按你建议接"
[client] obs = {answer:"按你建议接"}

=========== 主 SSE 流 #6 (turn 6) ===========

[Anthropic SSE]
  tool_use: propose_manifest(manifest={board_id:"...", peripherals:[...], logic:{...}})

[client] dispatch propose_manifest (local) → manifestValidator.validate() → obs {ok, warnings:[]}

=========== 主 SSE 流 #7 (turn 7) ===========

[Anthropic SSE]
  tool_use: generate_code(manifest=...)

[client] dispatch generate_code (local, nested SSE):

  --- 嵌套 SSE 子流 ---
  [client] skillCatalog.fetchBody("code-generation-guide") → 缓存
  [client] POST /v1/llm/messages stream=true
    body: {sessionId:"8f3a.../sub-generate",
           system: [{code_generation_guide body}, {board profile brief}],
           messages: [{role:"user", content:"Generate main.py for ..."}],
           tools: []}

  [api middleware]
    tool_whitelist OK (tools 空)
    intent_gate: messages.length==1 → inject (但 prompt 明显硬件，不会触发 not_hardware)
    proxy → Anthropic

  [api → client SSE]
    content_block_delta "from machine "
    content_block_delta "import Pin, I2C\n"
    ... (4000 chars main.py 代码流式)
    message_stop

  [client] code = "拼接完整代码"
  [client] safetyAudit.audit(code, {boardProfile, driverContexts}) → {passed: true}
  [client] return {status:"ok", code, audit}
  --- 嵌套流结束 ---

[主流 continues] tool_result for generate_code → 主流 messages

=========== 主 SSE 流 #8 (turn 8) ===========

[Anthropic SSE] tool_use: scan_device()
[client] dispatch scan_device (shim) → stdio JSON-RPC device.scan
[shim → mpremote connect list] → obs {devices:[{port:"COM3", board_match:"esp32-s3-devkitc-1"}]}

=========== 主 SSE 流 #9 (turn 9) ===========  (V3.1.2 新增 install_package 步骤)

[Anthropic SSE]
  thinking: "main.py 会 import aht20，需要先装包到设备 /lib"
  tool_use: install_package(url="https://upypi.net/pkgs/aht20_driver/1.0.0/package.json", port="COM3")

[client] requires_user_confirm=true → emit confirm_needed (batch confirm)
[ext UI] 弹单一对话框: "Install these packages to COM3: aht20_driver"
[user] approve
[client] dispatch install_package (shim) → 拿 per-port lock + 文件锁 ~/.mpyhw/locks/COM3.lock
[shim] mpremote COM3 resume fs mkdir :/lib  (idempotent)
[shim] mpremote COM3 resume mip install https://upypi.net/pkgs/aht20_driver/1.0.0/package.json
[shim] (mpremote 自动递归 deps；本例 deps=[])
[shim → client] obs {status:"ok", stdout:"installed aht20_driver-1.0.0", duration_ms:4520}

=========== 主 SSE 流 #10 (turn 10) ===========

[Anthropic SSE] tool_use: flash_and_run(code=..., port="COM3")
[client] requires_user_confirm=true → emit confirm_needed → 弹对话框
[user] approve
[client] dispatch (shim) → 拿同 port lock (跟 install 共享 lock path) → mpremote run
[shim → client] obs {status:"ok", stdout:"", stderr:"", duration_ms:5230}

=========== 主 SSE 流 #11 (turn 11) ===========

[Anthropic SSE] tool_use: read_serial_until(pattern="LED=", timeout_sec=8)
[client] dispatch (shim) → obs {lines:["MPYHW_READY","TEMP_C=28.4 LED=OFF","TEMP_C=28.6 LED=OFF"]}

=========== 主 SSE 流 #12 (turn 12) ===========

[Anthropic SSE]
  thinking: "板子正常运行。LED=OFF 因没超 30 度。需要让用户验证。"
  tool_use: ask_user(question="板子已运行。当前温度 28.6 度，LED 灭。请加热传感器到 30 度以上...")

[client] dispatch ask_user → user 答 "亮了！"

=========== 主 SSE 流 #13 (turn 13) ===========

[Anthropic SSE]
  final_answer (无 tool_use): "✓ 完成。已生成温度阈值 LED 控制程序并临时烧到 ESP32-S3。
                                 接线表：SDA=GPIO5, SCL=GPIO6, LED=GPIO2..."
  message_delta stop_reason="end_turn"
  message_stop

[client] emit session_done, outcome:"success"

=========== ext-internal: Git auto-commit hook (V3.1.2 新增) ===========

[ext] detect success terminal → git_integration.autoCommit() 触发
[ext] git status → 看到 main.py (新建) 改动
[ext] === 嵌套 SSE 子流 #2 (git commit msg) ===
[ext] POST /v1/llm/messages stream=true
       body: {sessionId:"8f3a.../sub-git-commit",
              system:[{git_commit_guide body}],
              messages:[{role:"user",
                         content:"Generate a conventional commit message ..."  ← 明显硬件措辞 (Q6)
                                 "for this MicroPython hardware project change:\n<diff>..."}],
              tools:[]}
[api] middleware: messages.length==1 → inject intent gate (but LLM 看 user message 是硬件 context → 不触发)
[api] proxy → Anthropic
[anthropic → api → ext] SSE 流出: "feat: 添加 AHT20 温度阈值 LED 控制"
[ext] === 嵌套子流结束 ===

[ext] git add . && git commit -m "feat: 添加 AHT20 温度阈值 LED 控制"
[ext] POST /v1/telemetry {trace_id, event_type:"git_commit_done", commit_sha:"abc123..."}

**注意**：git_commit 不入 agent trace（不通过 tool registry），但记 telemetry。
**注意**：v0.2 无 timeline UI，用户在终端 `git log` 才能看到这条 commit。

[terminal: success; total_turns=13; total_sse_streams=13 (主) + 1 (子 generate_code) + 1 (子 git_commit);
 loaded_skills={"manifest-resolution-guide"};
 total_shim_calls=4 (含 install_package);
 total_api_proxy_calls=2;
 total_local_dispatches=5;
 git_commits=1]
```

**关键对比 V2**：V2 形态需要 8 个独立 HTTP request（每个 600ms 跨洋 RTT）。V3.1.2 总 SSE 流 13 个但都在同一 HTTP 长连接哲学（每个流独立但低延迟）+ 大部分 tool 是 local 即时。**纯网络开销从 V2 的 ~5s 降到 V3.1.2 的 ~1.5s**（13 流 × 短开销 + 2 个 api-proxy 调用）。Install_package 多了一次 shim 调用（4520ms）但是 demo 必需的，因为没装包 main.py 跑不起来。

---

## 13. 文档导航

- 整体架构：[`00-architecture-overview.md`](00-architecture-overview.md)
- 后端 API（薄代理）：[`02-mpyhw-api-spec.md`](02-mpyhw-api-spec.md)
- VS Code 客户端（含 agent loop 和 shim）：[`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md)
