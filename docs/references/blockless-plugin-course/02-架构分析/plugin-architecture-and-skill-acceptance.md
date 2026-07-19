# Blockless 插件架构与 Skill 改动验收指南

这份文档给接手 Blockless 的开发者使用。目标是让任何人能快速回答三件事：

1. 插件从 WebView 到后端 LLM 再回到本地执行器是怎么跑起来的。
2. 遇到问题或要改功能时，应该看哪些文件。
3. 改了 `SKILL.md`、phase recipe、协议契约或执行器后，怎么验收。

当前实现以 `docs/specs/CURRENT-DECISIONS.md` 为准：agent loop 跑在 VS Code extension 内；`mpyhw-api` 负责 auth、credits、LLM provider proxy、board/package/tool content、telemetry；Python shim 只负责本地设备 IO 和工具链脚本。

## 1. 一条完整调用链

```text
WebView
  -> SessionController
  -> createProtocolLoop
  -> runProtocolBuild
  -> POST /v1/llm/messages
  -> 6 个协议工具
  -> 本地 UI / 文件 / Host 脚本 / 设备执行器
  -> tool_result 回填
  -> phase_complete 推进下一阶段
```

展开后是：

```text
用户点击 Generate
  src/webview/index.html
    vscode.postMessage({ type: "start_session", intent, boardId: "auto" })

扩展宿主收到消息
  src/webview/panel.ts
    checkProtocolVersion(/v1/tools)
    GitHub auth -> POST /v1/auth/github
    controller.start(...)

会话控制器接管异步状态
  src/extension/session-controller.ts
    维护 traceId/state/pendingPrompts/AbortController
    把 onEvent、confirmApproval、signal 传给 loop

协议 loop 发起后端 SSE
  src/core/protocol-build.ts
    createProtocolLoop(...)
  src/core/protocol-loop.ts
    runProtocolBuild(...)
    runPhase(...)
    llmClient.streamMessages(...)

后端构造 phase prompt 并流式返回工具调用
  mpyhw-api/app/routes_llm.py
    _system_prompt(phase)
    _phase_data_injection(...)
    _deepseek_tools(...) 只提供 6 个协议工具
    _translate_deepseek_stream(...)

插件执行工具
  approval_request -> WebView rich card
  file_operation   -> workspace/project 文件读写
  script_run       -> 本地工具链脚本
  device_command   -> Python shim / mpremote / serial
  status_update    -> 时间线进度
  phase_complete   -> 更新 manifest，进入下一 phase
```

## 2. 启动与 UI 层

### 2.1 VS Code 如何发现插件

先读：

- `mpy-hardware-extension/package.json`
- `mpy-hardware-extension/src/extension/activate.ts`
- `mpy-hardware-extension/src/extension/commands.ts`

关键点：

- `main` 指向打包后的 `dist/extension/activate.cjs`。
- `contributes.viewsContainers.activitybar` 声明 Blockless Activity Bar 容器。
- `contributes.views.mpyhw` 声明 `mpyhw.panel`，类型是 `webview`。
- `contributes.commands` 声明 `mpyhw.openPanel`。
- `contributes.configuration` 声明 `mpyhw.apiBaseUrl`、`mpyhw.pythonPath`、`mpyhw.pipIndexUrl`。

`activate.ts` 做的事很少：注册 `mpyhw.panel` 的 WebviewViewProvider，注册 `mpyhw.openPanel` 命令，创建输出通道。业务不在这里。

### 2.2 WebView 负责什么

先读：

- `mpy-hardware-extension/src/webview/index.html`
- `mpy-hardware-extension/src/webview/panel.ts`

WebView 是页面，不直接碰 VS Code API 之外的宿主能力。它通过 `vscode.postMessage(...)` 发消息给 `panel.ts`，通过 `window.addEventListener("message", ...)` 接收宿主事件。

常见 WebView 发出的消息：

- `request_boards`：页面加载后拉板卡、server mode、credits。
- `run_doctor_check`：页面加载后做环境预检。
- `start_session`：用户点击 Generate。
- `retry_session`：用户点击 Retry。
- `cancel_session`：用户中止当前 session。
- `reset_session`：新会话，清掉旧上下文。
- `deploy_rescan`：部署卡片重新扫描串口。
- `ui_prompt_response`：用户回答 approval/plan/deploy 等卡片。
- `doctor_action`：安装 shim 依赖等环境动作。

WebView 接收的主要消息：

- `boards`
- `server_mode`
- `session_event`
- `approval_request`
- `status_update`
- `phase_start`
- `phase_complete`
- `manifest_updated`
- `code_updated`
- `serial_output`
- `files_written`
- `session_error`
- `session_done`

## 3. SessionController：异步会话状态机

先读：

- `mpy-hardware-extension/src/extension/session-controller.ts`
- 测试：`mpy-hardware-extension/test/session-controller.test.ts`

`SessionController` 的职责不是“生成硬件方案”，而是管理一个长会话的异步边界：

- 单个 controller 同时只允许一个 in-flight run。
- 保存 `traceId`、`state`、`boardId`、`availableBoards`。
- 管理 `pendingPrompts`，让 `approval_request` 能等用户回答。
- 用 `AbortController` 支持取消。
- 用 `generation` 防止 reset 后旧 run 的迟到消息污染新会话。
- 接收 loop event，转成 WebView 消息。
- 记录 session telemetry。
- 处理 loop-time 写文件后的 `files_written` 报告。

重点方法：

- `start(input)`：新用户输入进入 loop。
- `retry()`：用保存的 state 重试，不伪造新的 user message。
- `reset()`：丢掉会话上下文，下一次从新 trace 开始。
- `confirmApproval(card)`：当前协议路径的统一 rich approval gate。
- `postEvent(event)`：把协议事件、代码、manifest、串口等转发给 WebView。
- `writeArtifactsIfReady()`：真实协议路径通常已经 loop-time 写文件，只报告路径；headless fallback 才做批量写。

## 4. createProtocolLoop 与 runProtocolBuild

先读：

- `mpy-hardware-extension/src/core/protocol-build.ts`
- `mpy-hardware-extension/src/core/protocol-loop.ts`
- `mpy-hardware-extension/src/core/llm-client.ts`
- `mpy-hardware-extension/src/core/sse-client.ts`
- 测试：`mpy-hardware-extension/test/protocol-loop.test.ts`

`panel.ts` 的 `createLoop()` 默认返回 `createProtocolLoop()`。旧的 deterministic template pipeline 只在 `MPYHW_LOOP=template` 时启用。

`createProtocolLoop()` 负责把 VS Code 宿主能力适配成协议执行器依赖：

- `llmClient`：POST `/v1/llm/messages`，解析 SSE。
- `device(action, payload)`：把 `device_command` 映射到 `DeviceShim`。
- `writeFile/readFile/listFiles`：项目文件读写。
- `runScript`：把 `script_run` 映射到 shim 的工具链脚本。

`runProtocolBuild()` 做 phase 驱动：

```text
phase = analyze
while phase:
  runPhase(phase, manifest)
  收集模型工具调用
  executeProtocolTool(...)
  把 tool_result 加回 messages
  遇到 phase_complete:
    manifest = manifest_content
    phase = next_phase
```

当前 `PHASE_ORDER` 包含：

```text
analyze -> select-hw -> scaffold -> generate -> wiring -> diagram -> deploy -> deploy-test -> autofix
```

实际后端 recipe 当前常走简化链路：

```text
analyze -> select-hw -> generate -> wiring -> diagram -> deploy
```

## 5. /v1/llm/messages：云端脑

先读：

- `mpyhw-api/app/routes_llm.py`
- `mpyhw-api/app/tool_registry.py`
- `mpyhw-api/app/skill_catalog.py`
- `mpyhw-api/app/routes_tools.py`
- 测试：
  - `mpyhw-api/tests/test_protocol_backend.py`
  - `mpyhw-api/tests/test_llm_messages.py`
  - `mpyhw-api/tests/test_skill_catalog.py`
  - `mpyhw-api/tests/test_protocol_contract.py`

`/v1/llm/messages` 是后端最关键的接口。它做这些事：

- 校验客户端传入工具是否在白名单内。
- 校验用户 JWT、并发限制和 credits。
- 读取 phase 对应的完整 `SKILL.md`。
- 拼接 adapter preamble，告诉模型“你是云端脑，插件是手和屏幕”。
- 拼接 phase recipe，约束当前 phase 应该怎么使用协议工具。
- 在部分 phase 注入 server-resolved data：board profile、driver contexts、current manifest。
- 只给模型 6 个协议工具。
- 把 DeepSeek/OpenAI-compatible stream 翻译成扩展能读的 SSE 事件。
- 对 `file_operation(op=write, path="firmware/*.py", intent=...)` 做 server-side codegen，把 `intent` 填成真实 `content`。
- 记录 token/credits/analytics。

后端不是本地执行器。它不直接读用户 workspace、不直接跑 mpremote、不直接弹 UI。它只能通过协议工具让插件执行。

## 6. 6 个协议工具与本地执行器

协议定义在：

- `contracts/protocol_messages.json`
- extension 侧读取：`mpy-hardware-extension/src/core/protocol-registry.ts`
- backend 侧读取：`mpyhw-api/app/tool_registry.py`

### 6.1 approval_request -> UI 执行器

用途：

- 组件确认。
- 用户选择方案。
- 需要用户输入 URL、数字、说明。
- 调试/接线指导。

执行链：

```text
routes_llm.py emits approval_request
  -> protocol-loop executeProtocolTool route ui
  -> SessionController.confirmApproval(card)
  -> WebView addApprovalPrompt(...)
  -> user clicks
  -> ui_prompt_response
  -> tool_result approval_response-like object
```

关键文件：

- `contracts/protocol_messages.json` 的 `approval_request`
- `src/extension/session-controller.ts`
- `src/webview/index.html` 的 `addApprovalPrompt`

验收重点：

- 所有必须用户回答的问题都必须走 `approval_request`，不能只写 plain assistant text。
- 用户取消时返回 `user_cancelled`，不能静默 auto-confirm。

### 6.2 file_operation -> 本地文件执行器

用途：

- 写 `project-manifest.json`。
- 写 `firmware/main.py`。
- 写 `firmware/lib/*.py`。
- 写 `docs/wiring.json`、`docs/diagram.json`。
- 读或列项目文件。

执行链：

```text
file_operation
  -> protocol-loop route fs
  -> writeProjectFile/readWorkspaceFile
  -> workspace-writer.ts path allowlist
  -> <workspace>/blockless-project/...
```

关键文件：

- `src/extension/workspace-writer.ts`
- `src/webview/panel.ts` 的 `makeWorkspaceWriter`
- `src/extension/session-controller.ts` 的 `file_written` 处理

验收重点：

- 路径不能逃出 project root。
- `firmware/*.py` 写入如果只有 `intent`，应由后端 codegen 填 `content` 后再发给插件。
- loop-time 已写的文件不能再被 post-loop batch 重写。

### 6.3 script_run -> Host 脚本执行器

用途：

- validate manifest/wiring/diagram。
- scaffold。
- static check。
- simulate。
- render wiring/diagram。
- extract PDF 等工具链动作。

执行链：

```text
script_run
  -> protocol-loop route host
  -> createProtocolLoop.runScript
  -> DeviceShim.runValidate/runScaffold/runStaticCheck/...
  -> python/shim/serve.py
```

关键文件：

- `src/core/protocol-build.ts`
- `src/extension/device-shim.ts`
- `mpy-hardware-extension/python/shim/serve.py`

验收重点：

- phase recipe 如果明确说不要跑脚本，模型不应发 `script_run`。
- 运行脚本失败要返回结构化结果，不能让 loop 崩掉。

### 6.4 device_command -> 设备执行器

用途：

- 扫描设备。
- 安装包。
- 复制 firmware tree。
- soft reset。
- 读串口。

执行链：

```text
device_command(action)
  -> protocol-loop route device
  -> createProtocolLoop.device(...)
  -> DeviceShim
  -> ShimProcess JSON-RPC
  -> python/shim/serve.py
  -> mpremote / serial
```

关键文件：

- `src/extension/device-shim.ts`
- `src/extension/shim-process.ts`
- `mpy-hardware-extension/python/shim/serve.py`
- `mpy-hardware-extension/src/extension/doctor.ts`

验收重点：

- 部署前 UI 要确认接线和连接。
- 多设备时必须选端口。
- `stream` 需要能把串口输出转成 `serial_output`。
- 成功标准通常是看到 `MPYHW_READY`。

### 6.5 status_update -> Notify 执行器

用途：

- 向用户显示进度，不阻塞。

执行链：

```text
status_update
  -> protocol-loop route notify
  -> SessionController.postEvent
  -> WebView addStatusUpdate
```

验收重点：

- 只能做进度，不应承载必须用户回答的信息。

### 6.6 phase_complete -> Notify 执行器

用途：

- 结束当前 phase。
- 携带 `manifest_content`。
- 指定 `next_phase`。

执行链：

```text
phase_complete
  -> protocol-loop captures phaseControl
  -> runProtocolBuild updates manifest
  -> next_phase auto-advance
```

验收重点：

- 每个 phase 必须能到达 `phase_complete`，否则 terminal 会是 `stalled`。
- `result="failed"` 且 `next_phase=null` 应返回 failed，不是 complete。
- `manifest_content` 是跨 phase 的主状态，不要靠旧 conversation 猜。

## 7. Skill 是怎么进入插件流程的

当前 served skills 由后端控制：

- `mpyhw-api/app/skill_catalog.py`
- skill 根目录：`third_party/MicroPython_Skills`

`SERVED_SKILLS` 当前白名单：

```text
upy-analyze
upy-select-hw
upy-scaffold
upy-generate
upy-wiring
upy-diagram
upy-deploy
upy-deploy-test
upy-autofix
upy-simulate
upy-pkg-guide
upy-project
```

phase 映射：

```text
upy-analyze     -> analyze
upy-select-hw   -> select-hw
upy-scaffold    -> scaffold
upy-generate    -> generate
upy-wiring      -> wiring
upy-diagram     -> diagram
upy-deploy      -> deploy
upy-deploy-test -> deploy-test
upy-autofix     -> autofix
upy-simulate    -> simulate
upy-pkg-guide   -> pkg-guide
upy-project     -> project
```

后端会把对应 phase 的完整 `SKILL.md` 拼进 system prompt。注意：skill 里可能写的是本地 agent 视角，比如 `mpremote`、脚本路径、AskUserQuestion。`routes_llm.py` 的 adapter preamble 和 phase recipe 会要求模型把这些意图翻译成 6 个协议工具，而不是照字面跑 shell。

所以改 skill 时，要同时考虑两层：

- `SKILL.md` 表达的产品/流程意图是否正确。
- `routes_llm.py` 的 phase recipe 是否足够约束模型把意图翻译成 protocol tool。

## 8. 改哪些文件看哪些资料

| 改动类型 | 主要文件 | 必看测试 |
| --- | --- | --- |
| WebView UI/卡片 | `src/webview/index.html` | `test/webview-dom.test.ts`, `test/webview-panel.test.ts` |
| WebView-宿主消息 | `src/webview/index.html`, `src/webview/panel.ts` | `test/webview-panel.test.ts` |
| 会话状态 | `src/extension/session-controller.ts` | `test/session-controller.test.ts` |
| 协议执行 | `src/core/protocol-loop.ts`, `src/core/protocol-build.ts` | `test/protocol-loop.test.ts` |
| SSE 客户端 | `src/core/llm-client.ts`, `src/core/sse-client.ts` | `test/sse-client.test.ts`, `test/sse-contract.test.ts` |
| 协议契约 | `contracts/protocol_messages.json` | `mpyhw-api/tests/test_protocol_contract.py`, `test/protocol-loop.test.ts` |
| phase prompt/recipe | `mpyhw-api/app/routes_llm.py` | `test_protocol_backend.py`, `test_llm_messages.py` |
| served skills | `mpyhw-api/app/skill_catalog.py`, `third_party/MicroPython_Skills/*/SKILL.md` | `test_skill_catalog.py`, smoke/e2e |
| 文件写入 | `src/extension/workspace-writer.ts` | `test/workspace-writer.test.ts` |
| 设备与 shim | `src/extension/device-shim.ts`, `src/extension/shim-process.ts`, `python/shim/serve.py` | `test/device-shim.test.ts`, `test/shim-process.test.ts` |
| 后端 auth/credits | `routes_auth.py`, `routes_credits.py`, `credit_store.py` | `test_auth.py`, `test_credits.py`, `test_llm_messages.py` |

## 9. Skill 改完后的验收标准

这里的“skill 改动”包括：

- 改 `third_party/MicroPython_Skills/<served-skill>/SKILL.md`。
- 改 `skill_catalog.py` 的 served skill 列表或 phase 映射。
- 改 `routes_llm.py` 的 adapter preamble 或 `_PHASE_RECIPES`。
- 改 `contracts/protocol_messages.json`。
- 改执行器，使某个协议工具行为变化。

### 9.1 快速静态门：不需要真实 LLM

在 `mpyhw-api` 下：

```powershell
pytest tests/test_skill_catalog.py tests/test_protocol_contract.py tests/test_protocol_backend.py tests/test_llm_messages.py
```

在 `mpy-hardware-extension` 下：

```powershell
npm test
npm run typecheck
```

至少要保证：

- served skills 都能解析到真实 `SKILL.md`。
- driver-authoring family 没被误暴露到 consumer agent。
- protocol contract JSON schema 合法。
- LLM 只看到 6 个协议工具。
- 旧 27-tool 名称会被拒绝。
- `file_operation` 写文件必须有 `content` 或 `intent`。
- server-side codegen 只拦截 `firmware/*.py`。
- extension 侧 protocol loop 能执行 approval/file/device/phase_complete。

### 9.2 真实模型 smoke：验证单个 phase 是否还会按协议说话

在 `mpyhw-api` 下，需要 `DEEPSEEK_API_KEY`：

```powershell
python scripts/smoke_analyze_protocol.py "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警"
```

通过标准：

- 输出 `GATE: PASS`。
- emitted tool calls 全部在 6-tool protocol 内。
- payload schema 全部有效。
- analyze phase 能到达 `approval_request`。
- 不以无关环境预检 `script_run` 开头。
- assistant prose 里没有 raw shell smell，如 `mpremote`、`pip install`、```bash。

这个脚本只验 analyze。改了 analyze skill、adapter preamble、语言约束、approval 逻辑时必须跑。

### 9.3 真实模型 headless E2E：验证多 phase 能连起来

在 `mpyhw-api` 下，需要 `DEEPSEEK_API_KEY`：

```powershell
python scripts/e2e_protocol.py "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数"
```

通过标准：

- 输出 `E2E: PASS`。
- 没有 off-protocol tool。
- payload validity 至少 95%。
- 至少到达 generate。
- 写出 `firmware/main.py`。
- `firmware/main.py` 包含 `MPYHW_READY`。

这个脚本模拟“薄插件”：自动确认 approval，写 temp project，mock device/script，但走真实后端 prompt、真实 DeepSeek、真实 codegen interception、真实 payload validation。改 generate/wiring/diagram/deploy skill 或 recipe 时优先跑它。

### 9.4 本地插件验收：验证 VS Code 侧没有断

如果改了 WebView、SessionController、protocol loop、executor、shim 或 API URL，至少跑：

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
npm run package
```

手工验收：

- Activity Bar 能看到 Blockless。
- 面板能打开。
- 页面加载后能请求 `/v1/boards`。
- server mode badge 正常。
- GitHub 登录能触发。
- credits 能显示。
- 输入中文 intent 后能看到 approval card。
- 用户确认后能看到 phase progress。
- 生成文件落到 `blockless-project`。
- 没 workspace 时会提示保存位置，而不是写到 `process.cwd()`。

### 9.5 云端后端验收：验证发布环境可用

如果目标是用线上后端测本地插件，使用本仓库 `cloud-test` skill。云端就是扩展默认后端（`mpyhw.apiBaseUrl` 现为 `scope: machine`，本地开关改用 `MPYHW_API_BASE`／`launch.json` 的 `env`，不再靠工作区 `.vscode/settings.json`）。它确保没有本地覆盖并探活：

```text
https://blockless.upypi.net
```

并检查：

- `/v1/health`
- `/v1/tools`
- 避免本仓库踩过的 `Cannot reach the auth API`
- 避免 `tool_registry_mismatch` / protocol drift

如果目标是本地全栈开发，使用 `dev-up` skill。它会启动 Postgres、`mpyhw-api`、探活 `/v1/health` 与 `/v1/boards`，再加载 VS Code 扩展。

## 10. 不同改动的最小验收矩阵

| 你改了 | 必跑 | 需要真实 LLM？ | 需要 VS Code？ | 需要硬件？ |
| --- | --- | --- | --- | --- |
| `SKILL.md` 文案/步骤 | `test_skill_catalog.py`, `test_protocol_backend.py`, `smoke_analyze_protocol.py` 或 `e2e_protocol.py` | 是，至少 smoke/e2e 一个 | 否 | 否 |
| analyze skill/recipe | `smoke_analyze_protocol.py` | 是 | 否 | 否 |
| select/generate/wiring/diagram/deploy recipe | `e2e_protocol.py` | 是 | 否 | 否 |
| `protocol_messages.json` | `test_protocol_contract.py`, `npm test`, `npm run typecheck` | 否 | 否 | 否 |
| `protocol-loop.ts` | `test/protocol-loop.test.ts`, `test/session-controller.test.ts` | 否 | 否 | 否 |
| `panel.ts` message routing | `test/webview-panel.test.ts`, `npm test` | 否 | 建议手工 | 否 |
| `index.html` approval/deploy UI | `test/webview-dom.test.ts`, `test/webview-panel.test.ts` | 否 | 建议手工 | 否 |
| `device-shim.ts` 或 shim RPC | `test/device-shim.test.ts`, `test/shim-process.test.ts` | 否 | 建议 | 最好有 |
| 发布前 | `npm test`, `npm run typecheck`, `npm run package`, 线上 health/tools | 否 | 是 | 可选 |

## 11. 常见失败怎么定位

### WebView 没反应

看：

- `index.html` 是否发了对应 `postMessage`。
- `panel.ts` 是否有 `onDidReceiveMessage` 分支。
- 测试 `webview-panel.test.ts` 是否覆盖该消息。

### start 后直接 session_error

看：

- `panel.ts` 的 `checkProtocolVersion`。
- `github-auth.ts`。
- `/v1/tools` 是否返回同样的 `protocol_version`。
- `/v1/auth/github` 是否可达。

### phase 卡住 awaiting_user/stalled

看：

- `protocol-loop.ts` 是否收到 tool calls。
- 后端 prompt 是否让模型只输出 plain text，没有发工具。
- `routes_llm.py` phase recipe 是否缺少“必须 phase_complete”约束。
- `scripts/e2e_protocol.py` 哪个 phase 没 complete。

### 模型发旧工具名

看：

- `routes_llm.py` 的 adapter preamble 是否还明确“只用 6 个协议工具”。
- `_deepseek_tools` 是否只提供 protocol tools。
- `test_protocol_backend.py::test_whitelist_rejects_dead_27_tool_names`。

### 写文件失败

看：

- `workspace-writer.ts` 的 allowlist。
- `panel.ts` 的 `PROJECT_SUBDIR` 和 project root。
- `SessionController` 是否收到 `file_written`。

### 部署失败或串口没输出

看：

- WebView deploy card 是否先确认端口。
- `protocol-build.ts` 的 `device` action mapping。
- `device-shim.ts` 的 `deployFirmwareTree`、`flashAndRun`、`serialReadUntil`。
- `python/shim/serve.py` 真实 mpremote 调用。
- 生成的 `firmware/main.py` 是否第一时间打印 `MPYHW_READY`。

## 12. 维护约束

- 不要让模型看到或调用旧 27-tool path，除非明确在 legacy/template 路径工作。
- 必须用户回答的问题走 `approval_request`，不要靠 plain text 问。
- 后端可以决定、可以注入上下文、可以做 server-side codegen，但不能直接碰用户本地文件和串口。
- 插件可以执行本地动作，但不要在扩展侧重新实现 package ranking 或 driver-context extraction。
- Python shim 不放 LLM、manifest、audit、package selection 逻辑。
- 协议有形状变更时，同时更新 `contracts/protocol_messages.json`、extension registry、backend registry、测试和发布验收。

## 13. 必读资料清单

本仓库：

- `docs/specs/CURRENT-DECISIONS.md`
- `contracts/protocol_messages.json`
- `mpy-hardware-extension/package.json`
- `mpy-hardware-extension/src/webview/panel.ts`
- `mpy-hardware-extension/src/extension/session-controller.ts`
- `mpy-hardware-extension/src/core/protocol-build.ts`
- `mpy-hardware-extension/src/core/protocol-loop.ts`
- `mpy-hardware-extension/src/extension/device-shim.ts`
- `mpyhw-api/app/routes_llm.py`
- `mpyhw-api/app/skill_catalog.py`
- `mpyhw-api/scripts/smoke_analyze_protocol.py`
- `mpyhw-api/scripts/e2e_protocol.py`

外部官方资料：

- VS Code Extension API: <https://code.visualstudio.com/api>
- Extension Manifest: <https://code.visualstudio.com/api/references/extension-manifest>
- Contribution Points: <https://code.visualstudio.com/api/references/contribution-points>
- Webview API: <https://code.visualstudio.com/api/extension-guides/webview>
- Commands: <https://code.visualstudio.com/api/extension-guides/command>
- Testing Extensions: <https://code.visualstudio.com/api/working-with-extensions/testing-extension>
- Publishing Extensions: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
