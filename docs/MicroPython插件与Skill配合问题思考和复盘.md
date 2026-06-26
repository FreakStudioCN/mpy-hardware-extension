# MicroPython插件与Skill配合问题思考和复盘

> 最终汇总版。本文综合 `插件与Skill配合复盘原始材料` 中的上下文加载分析、分阶段加载修正、DeepSeek V4 Pro 判断、以及 `F:/mpy-hardware-extension` 卡死与兼容输入输出分析。原始材料只用于追溯，后续决策以本文为准。

## 1. 最终结论

当前问题不应再简单归因于“DeepSeek V4 Pro 上下文不够”或“模型记不住”。现在已经是分阶段加载，DeepSeek V4 Pro 的上下文长度和记忆能力本身不是主要矛盾。真正的问题是：插件端协议运行时、Skill 输出契约、阶段状态机、工具结果校验、UI 审批卡兼容、checkpoint/resume、错误上报和权限确认还没有形成强约束闭环。

模型确实会倾向最短路径：跳过现成工具、自己发明字段、把说明书当建议、在后半段遗忘前面约束。但这不应该靠无限堆 prompt 解决。正确分工是：prompt 降低偏差率，插件协议层负责兜底，把缺字段、字段别名、超时、取消、重试、权限确认、artifact manifest、checkpoint/resume 都收口为可恢复、可解释、可继续的状态。

因此最终方向是：

- Skill 文档从“长说明书”改成“阶段执行卡 + 强 gate + 模板 + 可机读 schema”。
- 插件端从“相信 LLM 严格输出”改成“兼容归一化 + 严格最终校验”。
- 流程从“失败就重来”改成“session/checkpoint/resume/idempotency”。
- UI 从“等待模型/等待用户但不解释”改成“每个等待都有状态、按钮、超时、取消、重试、保存版本”。
- 工具结果从“给模型参考”升级为“事实源”，模型不能绕过工具结果自己猜。

## 2. 已观察到的典型问题

### 2.1 模型漏信息

表现包括：文档写了 `next_skill` 或阶段 handoff，模型仍按字符串猜；文档写了设备文件浏览、删除、双击查看、uPyPI、micropython-lib，模型只实现上传/部署；文档要求用现成脚本或接口，模型却自己发明参数和流程。

根因不是“模型完全不知道”，而是关键规则分散在长文档里，没有在使用点形成 gate。模型在一轮输出里优先关注当前最近、最显眼、最容易完成的路径。

### 2.2 跳过现成工具

表现包括：不调用已有 `init_manifest.py`、`init_scaffold.py`、固件解析脚本、设备脚本或 uPyPI 适配规则，而是直接编造 JSON、命令或下载流程。

根因是工具调用不是硬约束：没有“无工具结果不得声明事实”的门禁，也没有在工具失败后要求读取 stderr、重试、降级或进入人工确认。

### 2.3 自己发明字段和用法

表现包括：把 `actions` 写成 `buttons/options/choices`，把 `result` 写成 `status/outcome`，把 `manifest_content` 写成 `manifest/project_manifest`，把 `next_phase` 写成字符串 `null`，或者输出缺少 `approval_id/question/summary`。

这类输出不应该直接判失败。插件运行时要先兼容归一化，再在最终 gate 严格校验。

### 2.4 卡死或看起来卡死

`F:/mpy-hardware-extension` 当前默认走 `createProtocolLoop`。关键风险是：`fetch` 超时只保护建连/首响应，不保护 SSE body 后续长时间无完整工具；后端会把 DeepSeek tool call 缓存到上游流结束后再发给插件；`runPhase()` 无工具或 stream 异常时可能变成 `stalled`，再映射成 `awaiting_user`，Webview 不显示错误，也不一定出现 retry 卡。

用户体验就是“转着不动”“不知道等谁”“失败原因不明显”。这不是单纯 prompt 问题，而是运行时缺 watchdog、状态拆分和可见恢复按钮。

## 3. 正确归因

### 3.1 不是主要问题：原始上下文容量

DeepSeek V4 Pro 长上下文能力不是当前主要瓶颈。六阶段已经分阶段加载，单阶段体量通常可控。即使输出文件、日志、manifest、工具结果也算上下文，问题也不是“装不下”，而是“事实优先级和执行约束不够强”。

### 3.2 主要问题：协议与状态机没有足够硬

当前更关键的是：

- Skill 规则没有变成可执行 gate。
- 工具结果没有成为唯一事实源。
- LLM 输出小偏差没有兼容层。
- 阶段没有可靠 terminal/retry/partial/checkpoint 语义。
- UI 等待状态没有超时、取消、恢复路径。
- 文件和设备副作用缺少 idempotency key。
- 错误上报仍偏自然语言，不够结构化。

### 3.3 模型能力仍有边界

模型会倾向最短路径，尤其在长输出后半段更容易忽略前文规则。对策不是换模型就结束，而是建立模型无关的工程护栏：runtime card、protocol normalization、strict final validation、no-tool-no-fact、checkpoint/resume。

## 4. 总体架构原则

### 4.1 分阶段加载继续保留

六阶段 Skill 仍按阶段加载，不应一次塞入所有 Skill、所有样例、所有脚本和总规格。每阶段只加载：

- 当前阶段目标。
- 当前阶段输入和上游 manifest 摘要。
- 当前阶段允许工具和必须工具。
- 当前阶段输出 schema。
- 当前阶段失败恢复策略。
- 与当前阶段直接相关的模板和少量示例。

### 4.2 常驻规则要短

全局常驻 prompt 控制在 1k-2k tokens 级别，只放不可违反的硬规则：

- 不凭空发明工具、字段、URL、包名。
- 没有工具结果不得声明事实。
- 所有用户确认必须走 approval_request。
- 文件/设备/脚本/网络/Git 操作必须走权限提示和 idempotency。
- 每阶段必须以 `phase_complete` 或结构化 partial/checkpoint 结束。
- 所有错误必须结构化上报。

### 4.3 每阶段 runtime card 要像执行卡

每阶段 Skill 不应只写背景说明，应提供机器可执行的 runtime card：

```json
{
  "phase": "generate",
  "goal": "生成 firmware 工程并通过静态/模拟检查",
  "must_use_tools": ["file_operation", "script_run"],
  "forbidden_shortcuts": ["不要手写不存在的脚本参数", "不要跳过 gate"],
  "input_manifest_required": true,
  "output_required": ["project-manifest.json", "firmware/main.py", "artifact_manifest"],
  "failure_policy": "retry_or_partial_checkpoint"
}
```

### 4.4 工具结果是事实源

工具结果优先级高于 Skill 文档、历史消息和模型记忆。比如：

- uPyPI 包信息必须来自 upypi.net / upy-pkg-guide 约定或工具结果。
- 板卡信息必须来自 `upy-analyze-plugin/boards` 或官方固件/板卡页面解析结果。
- 文件是否存在必须来自 file_operation/list/read 或 artifact manifest。
- 设备状态必须来自 device_command/serial/script_result。

## 5. 插件端协议运行时要求

### 5.1 session ID

必须显式区分：

- `session_id`: 用户项目会话，跨重试/恢复稳定。
- `trace_id`: 单次运行日志追踪，可变。
- `turn_id`: 单次 LLM turn。
- `checkpoint_id`: 可恢复点。

不要只依赖 traceId 充当所有概念。

### 5.2 checkpoint/resume

以下节点必须保存 checkpoint：

- phase_start。
- approval_request 已发出。
- approval_response 已收到。
- file/script/device tool 执行前后。
- phase_complete。
- session 以非 complete 状态结束。

checkpoint 至少包含：

```json
{
  "session_id": "...",
  "checkpoint_id": "...",
  "phase": "generate",
  "turn": 12,
  "manifest": {},
  "messages_tail": [],
  "pending_prompt": null,
  "artifact_manifest": [],
  "device_state": {},
  "compat_warnings": [],
  "last_error": null
}
```

恢复时先校验 artifact manifest 和文件 hash，再决定继续、提示用户确认、或重新生成。

### 5.3 cancellation

取消必须能释放：

- fetch/SSE reader。
- pending approval promise。
- host script。
- device shim RPC。
- webview running spinner。

取消不是失败，应保存 checkpoint，并给用户“恢复/重新开始/查看日志”的选择。

### 5.4 retry

至少支持三类 retry：

- `retry_turn`: 重发当前 LLM turn。
- `retry_tool`: 重跑上一个失败工具。
- `retry_phase`: 从当前 phase checkpoint 重新开始。

重试必须配合 idempotency key，避免重复写文件、重复删除、重复烧录、重复安装库或重复 Git 保存版本。

### 5.5 timeout

必须区分：

- fetch connect timeout。
- SSE idle timeout。
- LLM turn hard timeout。
- phase timeout。
- approval pending timeout。
- script/device timeout。

approval pending timeout 不应自动失败，但 UI 要显示“仍在等待确认”，并提供继续等待、取消、保存 checkpoint。

### 5.6 idempotency key

所有副作用工具必须带 idempotency key：

```json
{
  "idempotency_key": "session_id:phase:turn_id:tool_id:op_hash"
}
```

适用范围：

- 文件写入/覆盖/删除。
- 设备文件上传/删除。
- 固件烧录/复位。
- 安装库。
- 运行脚本生成 artifact。
- Git 保存版本。

### 5.7 protocol versioning 与 capability negotiation

启动时插件和后端应协商：

```json
{
  "protocol_version": "1.1.0",
  "min_protocol_version": "1.0.0",
  "capabilities": {
    "approval_card_v2": true,
    "checkpoint_resume": true,
    "device_file_browser": true,
    "upypi_install": true,
    "git_history_ui": true,
    "compatible_payload_normalization": true
  }
}
```

LLM prompt 必须知道 negotiated capabilities，避免调用插件不支持的按钮、字段或设备操作。

### 5.8 structured error reporting

统一错误结构：

```json
{
  "ok": false,
  "error": {
    "code": "approval_payload_repaired",
    "message": "approval_request 缺少 question，已使用 fallback 文案。",
    "severity": "warning",
    "retryable": true,
    "recoverable": true,
    "phase": "analyze",
    "tool": "approval_request",
    "raw_excerpt": "...",
    "suggested_actions": ["continue", "retry", "cancel", "save_checkpoint"]
  }
}
```

## 6. 兼容输入输出层

### 6.1 原则

运行时 compat，最终 gate strict。

- UI/approval/status/phase_complete 先做兼容归一化。
- 文件、设备、脚本、Git 等副作用操作仍需权限确认和严格路径校验。
- manifest、artifact、最终阶段输出必须 strict validate。

### 6.2 approval_request 兼容

兼容别名：

- `approval_id`: `approval_id | id | card_id | request_id | prompt_id`
- `question`: `question | title | message | prompt | text | summary.description`
- `header`: `header | title | kind`
- `actions`: `actions | buttons | options | choices | suggested_actions`
- `items`: `items | candidates | devices | components | files`
- `text_inputs`: `text_inputs | inputs | fields | form_fields`

如果 actions 缺失，合成安全按钮：继续、重试、取消、保存 checkpoint。不能因为 LLM 少写按钮就判定失败。

### 6.3 approval_response 兼容

兼容别名：

- `action`: `action | value | button_id | selected_action | answer`
- `selected_ids`: `selected_ids | selected | selected_items | checked_ids | values`
- `text_values`: `text_values | fields | inputs | form_values`
- `notes`: `notes | feedback | comment | message`

如果 action 是按钮 label，要映射回 value。未知 action 应返回可恢复错误和 allowed_actions，而不是静默失败。

### 6.4 phase_complete 兼容

兼容别名：

- `result`: `result | status | state | outcome`
- `summary`: `summary | message | result_summary | description`
- `next_phase`: `next_phase | next | phase_next`
- `manifest_content`: `manifest_content | manifest | project_manifest | payload.manifest`
- `artifacts`: `artifacts | files | outputs | manifest.files`

状态映射：

- `ok/done/complete/completed/successful` -> `success`
- `error/fail/failed` -> `failed`
- `waiting/paused/incomplete/partial/needs_input` -> `partial`

缺 `result` 不应直接卡到最大 turn。先尝试修复或要求模型重发；多次失败后进入 partial checkpoint。

## 7. UI 与按钮要求

### 7.1 全局按钮

插件端全局应该有：

- 开始/继续当前流程。
- 取消当前流程。
- 重试当前步骤。
- 从 checkpoint 恢复。
- 保存当前版本（可命名 + 版本摘要）。
- 可视化 Git 变更历史。
- 查看 artifact/file manifest。
- 查看结构化错误详情。

### 7.2 设备工具区

设备工具区不应只做烧录，应接近 Thonny 的设备文件能力：

- 查看设备文件目录。
- 上传文件到设备。
- 从设备下载文件。
- 删除设备文件。
- 双击查看设备端文件。
- 新建目录。
- 运行/复位设备。
- 串口输出查看。
- 执行 mpremote 探测命令。
- 选择本地固件并烧录。

这些操作都必须走权限提示、timeout、错误上报和 idempotency。

### 7.3 包管理按钮

需要支持：

- 从 uPyPI(upypi.net) 查询库。
- 从 micropython-lib 查询/下载库。
- 安装到项目 `firmware/lib`。
- 安装到设备端。
- 查看包来源、版本、兼容性、依赖和下载日志。

uPyPI 相关接口和规则以 `G:/MicroPython_Skills/upy-pkg-guide/SKILL.md` 为准，不能按普通 PyPI 随意猜。

### 7.4 Git 版本按钮

应有两个明确入口：

- 可视化 Git 变更历史：查看提交、文件 diff、生成文件和用户修改。
- 保存当前版本：用户可输入版本名和摘要，插件生成 checkpoint + Git commit 或等价快照。

保存版本也是副作用操作，需要权限提示和 idempotency key。

## 8. artifact/file manifest 要求

每阶段都应维护 artifact manifest：

```json
{
  "artifacts": [
    { "path": "project-manifest.json", "kind": "manifest", "sha256": "...", "created_by": "analyze" },
    { "path": "firmware/main.py", "kind": "code", "sha256": "...", "created_by": "generate" },
    { "path": "docs/wiring.md", "kind": "wiring", "sha256": "...", "created_by": "diagram" }
  ]
}
```

作用：

- resume 前检查文件是否变化。
- deploy 前确认要烧录的文件集合。
- Git 保存版本时生成摘要。
- UI 展示“本阶段产物”。
- 错误上报时附带相关文件。

## 9. 上下文加载策略

### 9.1 每阶段最小上下文

每阶段只加载最小必要内容：

| 阶段 | 必须上下文 | 不应直接塞入 |
|---|---|---|
| analyze | 用户需求、板卡目录摘要、uPyPI/driver 规则摘要、输出 manifest schema | 全量 boards 图片、全量包索引 |
| select-hw | analyze manifest、候选板卡/品牌/芯片系列、pin 约束、BOM schema | 全量板卡仓库、无关品牌数据 |
| flash | 板卡 id、固件页面 URL、固件格式、烧录策略 | 全量固件网页缓存 |
| scaffold | manifest、模板清单、脚本使用说明、输出文件树 | 全量 templates 内容 |
| generate | manifest、driver context、文件 manifest、代码约束、测试规则 | 全量 MicroPython 文档索引 |
| deploy | file manifest、设备状态、mpremote 能力、串口/日志策略 | 无关历史日志 |

### 9.2 输出文件也是上下文

manifest、日志、生成代码、artifact manifest、错误报告都会在后续 turn 中变成上下文。必须做摘要：

- manifest summary：只保留阶段、设备、板卡、pin、driver、产物路径。
- log summary：只保留错误签名、最后 N 行、复现命令、exit code。
- file manifest summary：只保留 path、kind、sha256、created_by、是否用户改动。

### 9.3 Prompt checksum

每阶段可记录 prompt/profile checksum：

```json
{
  "phase": "generate",
  "skill_version": "...",
  "runtime_card_hash": "...",
  "schema_hash": "..."
}
```

这样后续复盘能判断：问题来自旧 prompt、旧 schema，还是运行时执行偏差。

## 10. 六阶段重点要求

### 10.1 analyze

- 板卡信息应来自 `G:/MicroPython_Skills/upy-analyze-plugin/boards`。
- 官方图片应爬取/缓存后展示。
- 板卡按品牌、类型、芯片系列分类。
- 官方固件页面 URL 可点击。
- 输出必须包含可 handoff 的 manifest，不得只输出自然语言建议。

### 10.2 select-hw

- 根据 analyze manifest 选择板卡和硬件。
- pin 分配必须结构化，不能只写建议。
- BOM、购买链接、替代件要区分真实商品链接和搜索 fallback。
- 用户确认要走 approval_request。

### 10.3 flash-mpy-firmware

- 支持本地固件选择并烧录。
- 支持官方固件 URL 点击打开。
- 固件解析、下载、校验、烧录各步骤要有 timeout/retry/cancel。
- 失败要输出结构化错误和恢复建议。

### 10.4 scaffold

- 必须生成稳定项目结构和模板文件。
- 输出 artifact/file manifest。
- 脚本参数不能由模型乱造；脚本失败要读 stderr 并按实际 usage 修正。

### 10.5 generate

- 必须使用上游 manifest、driver context 和项目文件 manifest。
- 生成代码后要做静态/模拟 gate。
- 成功且 deploy-ready 时不应错误地 `next_phase=null`。
- 需要把 deploy 失败反馈带回 generate fix。

### 10.6 deploy

- 不应把 `serial_no_output` 直接判为最终失败，应结合 marker、timeout、日志、用户反馈。
- deploy 主流程要自动读取串口/日志，也要提供单独按钮读取。
- 设备端文件浏览、删除、查看、上传应作为工具区能力。
- 失败结果要带 `error_context` 回 generate/autofix。

## 11. 实施优先级

### P0

- 新增协议归一化层：approval_request、approval_response、phase_complete。
- 增加 SSE idle timeout 和 LLM turn hard timeout。
- `stalled` 不再静默映射成 `awaiting_user`，必须显示可恢复状态。
- 增加 session_id、checkpoint_id、checkpoint/resume 基础数据结构。
- 所有副作用工具增加 permission prompt 和 idempotency key。
- 工具结果成为事实源：no-tool-no-fact。

### P1

- 增加 capability negotiation 和 protocol versioning。
- 增加 artifact/file manifest。
- Webview 增加 retry/continue/cancel/save checkpoint 错误卡。
- 增加 Git 历史可视化和保存当前版本按钮。
- 设备工具区补齐文件浏览、上传、下载、删除、查看、串口输出。

### P2

- 每阶段 runtime card 化。
- prompt/profile checksum。
- 上下文摘要器：manifest/log/file manifest summary。
- 针对每阶段建立 golden session 测试。
- 长流程 telemetry 和失败模式统计。

## 12. 验收标准

一个版本可以认为“插件与 Skill 配合问题基本解决”，必须满足：

- 任意阶段中断后，可以从最近 checkpoint 恢复，不必从头开始。
- LLM 缺少非关键字段或使用常见别名时，UI 不空白、不静默失败。
- phase 没有正常 complete 时，用户能看到错误、重试、取消、保存 checkpoint。
- 文件/设备/脚本/Git 操作都有权限提示和 idempotency。
- 每阶段输出 artifact/file manifest。
- deploy 失败能携带 error_context 回 generate/autofix。
- uPyPI、板卡、固件、设备状态等事实必须来自工具结果或明确数据源。
- Git 保存版本和历史查看可用。
- 所有结构化错误能被记录到 session 日志并在 UI 查看。

## 13. 需要避免的错误方向

不要把所有问题重新归因到“模型不够强”。换模型可以改善部分行为，但不能替代协议运行时。也不要继续无限加长 Skill.md；长文档会降低执行稳定性。更不要让 UI 因为缺一个字段就没有按钮、没有卡片、没有恢复路径。

正确方向是：短常驻硬规则、阶段执行卡、兼容归一化、严格最终校验、工具事实源、checkpoint/resume、可见错误和可恢复 UI。

## 14. 原始材料

原始分析文件保留在：

`G:/blockless-plugin-course(1)/插件与Skill配合复盘原始材料/`

包括：

- `MicroPython六阶段Skill分阶段加载与模型行为分析.md`
- `mpy-six-stage-skill-context-model-leak-analysis.md`
- `mpy-staged-loading-prompt-vs-model-analysis.md`
- `硬件扩展卡死与兼容输入输出分析.md`

这些文件只用于追溯分析过程。后续沟通、实现和验收以本文为准。
