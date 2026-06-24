# upy-analyze-plugin V0 协议改造确认清单

本文用于记录 `G:\MicroPython_Skills\upy-analyze-plugin` 后续改造前，需要人工确认的设计项。目标是先把 analyze 做成其他硬件 skill 的 V0 样板，再复制到 `select-hw / scaffold / generate / wiring / diagram / deploy / autofix / gen-driver / publish` 等阶段。

## 1. 总体结论

`upy-analyze-plugin` 现在已经具备插件化雏形：

- 使用 `approval_request` 表达用户确认点。
- 使用 `status_update` 表达进度。
- 使用 `phase_complete` 作为阶段完成信号。
- 使用 `manifest_content` 作为下游交接主数据。
- Claude Code 直测模式已能写出 `manifest_draft.json`、`manifest_validated.json`、`phase_complete.analyze.json`、`driver_search_log.md`。
- `init_manifest.py` 已能校验 manifest 和 phase_complete 基本结构。

但它还没有完全达到长期工作流协议要求。下一步建议先补 V0 协议骨架，而不是马上实现完整 orchestration runtime。

## 2. 需要你确认的设计项

### 2.1 是否强制完整消息信封

建议：确认。

后续所有正式协议消息，尤其是 `phase_complete.analyze.json`，应从当前简化形态：

```json
{
  "type": "phase_complete",
  "payload": {}
}
```

升级为完整 envelope：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "uuid",
  "phase": "analyze",
  "timestamp": "2026-06-21T00:00:00Z",
  "type": "phase_complete",
  "payload": {}
}
```

需要你确认：

- `protocol_version` 是否从 `"1.0"` 开始。
- `msg_id` 是否统一使用 UUID 字符串。
- `session_id` 是否由插件创建，服务器/skill 只继承。
- 顶层 `phase` 和 `payload.phase` 是否都保留，还是只保留顶层 `phase`。

建议默认：两者都保留，校验时要求一致。这样直测文件也更容易人工检查。

### 2.2 session_id 的来源和直测默认值

建议：确认。

正式插件模式中，`session_id` 应由 VSCode 插件在 `start_phase` 中生成并传入。skill 不应自己创建新的 session。

Claude Code 直测模式中需要一个默认策略，否则人工测试每次都要手写 UUID。

可选方案：

| 方案 | 行为 | 优点 | 缺点 |
|------|------|------|------|
| A | 缺失时生成 `cc-test-YYYYMMDD-HHMMSS` | 直测方便 | 不是真 UUID |
| B | 缺失时生成 UUID | 更接近正式协议 | 人工排查不直观 |
| C | 缺失时报错 | 最严格 | 直测麻烦 |

建议默认：A 或 B。若目标是先稳定 Claude Code 直测，选 A；若目标是尽早贴近插件协议，选 B。

### 2.3 直测产物是否按 session 隔离

建议：暂不强制，先保留单目录，后续再加可选 session 子目录。

当前真实测试目录是：

```text
G:\test\test\
  manifest_draft.json
  manifest_validated.json
  phase_complete.analyze.json
  driver_search_log.md
  analyze_phase_log.md
```

如果强制 session 隔离，会变成：

```text
G:\test\test\sessions\<session_id>\
  manifest_draft.json
  manifest_validated.json
  phase_complete.analyze.json
  driver_search_log.md
  analyze_phase_log.md
```

需要你确认：

- 短期是否继续使用当前单目录直测方式。
- 是否允许未来增加 `sessions/<session_id>/` 目录，但不破坏当前测试路径。

建议默认：短期继续单目录；长期支持 session 子目录作为可选模式。

### 2.4 manifest_validated.json 与 phase_complete.manifest_content 是否强一致

建议：确认。

当前 SKILL.md 已说明两者必须一致，但 smoke 测试还可以进一步强化。

需要你确认：

- 是否要求 `manifest_validated.json` 与 `phase_complete.payload.manifest_content` 在规范化后完全一致。
- 是否忽略 `created_at`、`updated_at` 这类运行时字段差异。

建议默认：规范化后比较核心字段，至少要求以下字段一致：

- `schema_version`
- `phase`
- `project_name`
- `requirements`
- `devices`
- `final_status`

时间字段可以不参与严格一致性比较。

### 2.5 analyze_phase_log.md 是否加入 file_list 必交产物

建议：需要你确认。

当前 `phase_complete.artifacts.file_list` 必交文件是：

- `manifest_draft.json`
- `manifest_validated.json`
- `phase_complete.analyze.json`
- `driver_search_log.md`

真实测试中还生成了：

- `analyze_phase_log.md`

需要你确认是否把 `analyze_phase_log.md` 也列入必交产物。

建议默认：不作为正式协议必交产物，但 Claude Code 直测模式建议写入并允许在 file_list 中声明。

原因：正式插件模式以消息流和 artifacts 为主，不一定需要完整 markdown 日志落盘；直测模式需要它方便人工复盘。

### 2.6 checkpoint/resume 在 analyze 阶段做到什么程度

建议：V0 只定义，不做复杂恢复。

analyze 阶段通常很短，成功路径不需要复杂 checkpoint。但失败或中断时，应能输出 `partial`，而不是只留下半截文件。

建议 V0 支持这些 checkpoint 场景：

| 场景 | result | checkpoint |
|------|--------|------------|
| 用户未确认器件 | partial | `after_intent_extraction` |
| 驱动搜索部分完成 | partial | `after_partial_driver_search` |
| manifest 校验失败 | failed 或 partial | `before_manifest_validation` |
| phase_complete 校验失败 | failed | `before_phase_complete` |

需要你确认：

- analyze 中断是否使用 `result="partial"`。
- `next_phase` 在 partial 时是否必须为 `null`。
- checkpoint 是否先只写在 `phase_complete.payload.checkpoint`，暂不实现真正 resume runtime。

建议默认：partial 时 `next_phase=null`，并写 checkpoint object。

### 2.7 取消、重试、超时是否先写进协议但不实现 runtime

建议：确认。

V0 可以先让 SKILL.md 明确这些语义：

- 用户取消 approval：输出 `phase_complete(result="partial")` 或 `failed`。
- 驱动搜索超时：降级为 warning，不直接失败，除非核心器件完全不可判断。
- `script_run(init_manifest.py)` 失败：允许修正 manifest 后重试一次。
- 重试必须使用相同 `session_id`，并带 `idempotency_key` 或 `retry_of`。

需要你确认：

- 是否现在就引入 `idempotency_key`。
- 是否允许 analyze 阶段最多自动重试 1 次 manifest 校验。
- 用户取消时是 `partial` 还是 `failed`。

建议默认：先引入字段，不实现复杂 runtime；用户取消用 `partial`。

### 2.8 权限确认机制的粒度

建议：需要你确认。

analyze 阶段权限风险较低，但正式插件架构里仍涉及：

- 写文件：`manifest_draft.json`、`manifest_validated.json`、日志文件。
- 执行脚本：`init_manifest.py`。
- 网络搜索：upypi / GitHub / awesome-micropython。

可选方案：

| 方案 | 行为 | 适合阶段 |
|------|------|----------|
| A | analyze 阶段默认允许低风险写入和校验脚本 | analyze |
| B | 每次 file/script/network 都弹权限确认 | 高安全但很打断 |
| C | 首次 session 弹一次总权限，后续沿用 | 长流程 |

建议默认：C。首次 session 明确授权：允许写项目产物、运行白名单脚本、访问驱动搜索源。危险操作如上传、删除、烧录、发布 upypi 必须单独确认。

### 2.9 结构化错误格式

建议：确认。

当前 `errors` 是字符串数组。建议 V0 保持兼容，但新增可选 `structured_errors`：

```json
{
  "code": "manifest_validation_failed",
  "message": "devices[0].driver.source invalid",
  "severity": "error",
  "recoverable": true,
  "retryable": true,
  "source": "init_manifest.py"
}
```

需要你确认：

- 是否保留 `errors: string[]` 作为人类可读摘要。
- 是否新增 `structured_errors: object[]` 给插件 UI 和 orchestration 使用。

建议默认：两者都保留。

### 2.10 artifact 统一模型

建议：确认。

当前 artifact 已有 `table` 和 `file_list`，但字段还偏松散。建议 V0 先统一 file artifact 字段：

```json
{
  "path": "manifest_validated.json",
  "status": "created",
  "kind": "manifest",
  "mime_type": "application/json",
  "description": "校验规范化后的 analyze manifest"
}
```

需要你确认：

- 是否给 artifact 增加 `artifact_id`。
- 是否要求所有 file_list 条目带 `kind` 和 `description`。
- 是否把 `status` 枚举固定为 `created/updated/unchanged/skipped/error`。

建议默认：先不强制 `artifact_id`，但固定 `status` 枚举，并推荐 `kind/description`。

### 2.11 mock message 测试体系的范围

建议：确认。

建议为 analyze 建立这些 mock：

```text
mock-messages/analyze/start_phase.beginner.json
mock-messages/analyze/approval_request.device_confirm.json
mock-messages/analyze/approval_response.device_confirm.confirm.json
mock-messages/analyze/script_run.init_manifest.json
mock-messages/analyze/script_result.init_manifest.ok.json
mock-messages/analyze/phase_complete.success.json
mock-messages/analyze/phase_complete.partial.cancelled.json
mock-messages/analyze/phase_complete.failed.validation.json
```

需要你确认：

- mock 消息放在 `upy-analyze-plugin/mock-messages/`，还是统一放在 `upy-project-gen-toolchain-spec/plugin-interface/mock-messages/`。
- mock 测试是否纳入 `test/smoke_tests.py`。

建议默认：skill 自带最小 mock，协议仓库保留跨 skill mock。也就是两边都可以有，但职责不同。

### 2.12 后续是否将 upy-analyze-plugin 合并回 upy-analyze

建议：暂不合并。

当前 `upy-analyze` 是旧本地直跑形态，`upy-analyze-plugin` 是插件化实验/样板形态。现在合并会让验证边界变模糊。

建议：

- 短期保留两个目录。
- `upy-analyze-plugin` 成为 V0 样板。
- 等 select-hw/generate 等阶段完成同类改造后，再决定是否替换旧 `upy-analyze`。

需要你确认：

- 是否接受短期双轨维护。
- 插件端最终 served skill 名称是否仍叫 `upy-analyze`，只是内容来自 `upy-analyze-plugin`。

建议默认：短期双轨；正式 served 时再统一命名。

## 3. Codex 可以直接执行的修改项

以下事项原则上不需要再做业务确认，可以让 Codex 直接改：

1. 在 `SKILL.md` 中增加 V0 envelope/session 规则章节。
2. 在 `SKILL.md` 中明确正式插件模式与 Claude Code 直测模式的区别。
3. 在 `phase_complete` 示例中补充完整 envelope。
4. 在 `init_manifest.py --validate-phase-complete` 中增加 envelope 基础校验。
5. 在 smoke 测试中检查完整 envelope。
6. 在 smoke 测试中检查 `manifest_validated.json` 与 `phase_complete.payload.manifest_content` 的核心字段一致。
7. 增加 analyze mock message 样本。
8. 增加 partial/failed phase_complete 样本。
9. 把 `file_list` artifact 的 required files 校验继续保留。
10. 保持语义质量规则为 warning 优先，不先卡死太多业务判断。

## 4. 不建议现在立刻做的事

1. 不建议马上实现完整 orchestration runtime。
2. 不建议立刻把所有 skill 一次性改完。
3. 不建议马上强制 session 子目录，否则会影响当前 `G:\test\test` 直测流程。
4. 不建议现在合并 `upy-analyze` 和 `upy-analyze-plugin`。
5. 不建议把权限确认做成每个低风险动作都弹窗，否则 analyze 体验会很碎。
6. 不建议让插件端理解硬件业务逻辑；插件仍应保持 thin plugin。

## 5. 推荐执行顺序

### 阶段 A：让 upy-analyze-plugin 成为 V0 样板

1. 补完整 envelope/session 规则。
2. 扩展 phase_complete 校验。
3. 补 mock messages。
4. 强化 smoke 测试。
5. 复制到 Claude skills 目录，真实 Claude Code 直测。
6. 用 `G:\test\test` 输出作为回归样本验证。

### 阶段 B：按样板改造后续核心 skill

建议顺序：

1. `upy-select-hw`
2. `upy-scaffold`
3. `upy-generate`
4. `upy-wiring`
5. `upy-diagram`
6. `upy-deploy`
7. `upy-autofix`
8. `upy-gen-driver`
9. publish / pack-driver / gen-readme / gen-pkg 收尾链路

### 阶段 C：补长期工作流能力

1. checkpoint/resume runtime
2. cancellation/retry/timeout
3. permission policy
4. structured error reporting
5. artifact viewer model
6. server-side skill orchestration
7. upypi publish final flow

## 6. 建议你优先拍板的 6 个问题

为了开始下一轮修改，最少需要确认这 6 件事：

1. `phase_complete.analyze.json` 是否从现在开始强制完整 envelope。
2. 直测缺少 `session_id` 时，是自动生成还是报错。
3. `manifest_validated.json` 与 `manifest_content` 是否做核心字段一致性校验。
4. `analyze_phase_log.md` 是否列入 file_list 必交产物。
5. 用户取消 analyze 时，结果用 `partial` 还是 `failed`。
6. mock messages 放在 skill 内，还是放在 `plugin-interface/mock-messages` 统一目录。

建议默认答案：

1. 强制完整 envelope。
2. 直测自动生成 `cc-test-...` 或 UUID，正式插件必须传入。
3. 做核心字段一致性校验，忽略时间字段。
4. 不列为正式必交，但直测可以写入和声明。
5. 用户取消用 `partial`，`next_phase=null`。
6. skill 内放最小 mock，plugin-interface 放跨 skill 协议 mock。

## 7. 用户确认结果（2026-06-21）

以下内容为已确认决策，后续改造 `G:\MicroPython_Skills\upy-analyze-plugin` 时按本节执行。

### 7.1 完整消息信封

已确认：

- `protocol_version` 从 `"1.0"` 开始。
- `msg_id` 使用 UUID 字符串。
- `session_id` 由插件创建，服务器/skill 只继承。
- 顶层 `phase` 和 `payload.phase` 都保留。
- 校验时要求顶层 `phase` 与 `payload.phase` 一致。

正式 `phase_complete.analyze.json` 必须使用完整 envelope：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "uuid",
  "phase": "analyze",
  "timestamp": "2026-06-21T00:00:00Z",
  "type": "phase_complete",
  "payload": {
    "phase": "analyze",
    "result": "success",
    "summary": "...",
    "next_phase": "select-hw",
    "manifest_content": {},
    "artifacts": [],
    "warnings": [],
    "errors": [],
    "structured_errors": []
  }
}
```

### 7.2 session_id 来源和直测默认值

已确认：

- 正式插件模式：`session_id` 必须由插件在 `start_phase` 中创建并传入。
- 服务器和 skill 不创建新的正式 session，只继承输入 session。
- Claude Code 直测模式：如果缺少 `session_id`，自动生成 UUID。

### 7.3 直测产物隔离

已确认：

- Claude Code 直测产物强制按 session 隔离。
- 推荐目录结构：

```text
{test_root}/sessions/{session_id}/
  manifest_draft.json
  manifest_validated.json
  phase_complete.analyze.json
  driver_search_log.md
  analyze_phase_log.md
```

后续 smoke 测试和真实 Claude Code 直测应适配 session 子目录。

### 7.4 manifest_validated 与 manifest_content 一致性

已确认：

- `manifest_validated.json` 与 `phase_complete.payload.manifest_content` 必须做规范化后一致性校验。
- 时间字段不参与严格一致性比较。
- 至少要求以下核心字段一致：
  - `schema_version`
  - `phase`
  - `project_name`
  - `requirements`
  - `devices`
  - `final_status`

### 7.5 analyze_phase_log.md 的定位

已确认：

- `analyze_phase_log.md` 不作为正式协议必交产物。
- Claude Code 直测模式建议写入。
- Claude Code 直测模式允许在 `phase_complete.artifacts.file_list` 中声明该文件。

### 7.6 partial / checkpoint / result 类型

已确认：

- analyze 中断使用 `result="partial"`。
- `partial` 时 `next_phase=null`。
- `partial` 时必须写 `checkpoint` object。
- `SKILL.md` 必须明确说明 `result` 有哪些类型及语义。

建议固定枚举：

| result | 含义 | next_phase | 是否需要 checkpoint |
|--------|------|------------|---------------------|
| `success` | analyze 完整成功，可进入下游 | `select-hw` | 否 |
| `partial` | 流程被取消、中断、缺少输入或只完成部分搜索 | `null` | 是 |
| `failed` | 当前阶段无法产生可用 manifest 或协议输出非法 | `null` | 视情况可选 |

建议 checkpoint 最小结构：

```json
{
  "checkpoint_id": "uuid",
  "resume_phase": "analyze",
  "resume_step": "driver_search",
  "resume_label": "继续 analyze 驱动搜索",
  "reason": "user_cancelled"
}
```

### 7.7 取消、重试、超时

已确认：

- 取消、重试、超时先写进协议和 skill 说明。
- V0 阶段暂不实现完整 runtime。
- 这些字段和语义必须提前进入模板和校验规则，避免后续大面积返工。

建议 V0 约束：

- 用户取消 approval：输出 `result="partial"`，`next_phase=null`，写 checkpoint。
- 驱动搜索超时：优先降级为 warning；核心信息不可判断时才 failed。
- manifest 校验失败：允许修正后重试；重试行为应记录在日志或 payload 元数据中。
- 重试应沿用同一个 `session_id`。

### 7.8 权限确认机制

已确认：

- 权限确认采用“首次 session 弹一次总权限，后续沿用”的长流程策略。
- analyze 阶段允许低风险动作在授权后执行：
  - 写项目分析产物。
  - 运行白名单校验脚本。
  - 访问驱动搜索源。
- 高风险动作仍必须单独确认，例如：
  - 删除文件。
  - 烧录设备。
  - 执行任意 shell。
  - 上传或发布到 upypi。

### 7.9 结构化错误

已确认：

- 保留 `errors: string[]` 作为人类可读摘要。
- 新增 `structured_errors: object[]` 给插件 UI 和 orchestration 使用。

建议结构：

```json
{
  "code": "manifest_validation_failed",
  "message": "devices[0].driver.source invalid",
  "severity": "error",
  "recoverable": true,
  "retryable": true,
  "source": "init_manifest.py"
}
```

### 7.10 artifact 统一模型

已确认：

- 不强制 `artifact_id`。
- 固定 `status` 枚举。
- 推荐所有 file artifact 带 `kind` 和 `description`。

建议 `status` 枚举：

```text
created / updated / unchanged / skipped / error
```

建议 file_list 条目：

```json
{
  "path": "manifest_validated.json",
  "status": "created",
  "kind": "manifest",
  "mime_type": "application/json",
  "description": "校验规范化后的 analyze manifest"
}
```

### 7.11 mock message 测试体系

已确认：

- skill 自带最小 mock。
- 协议仓库保留跨 skill mock。
- 两边都可以有 mock，但职责不同：
  - skill 内 mock 用于验证该 skill 的实际输出。
  - `plugin-interface/mock-messages` 用于验证跨 skill 协议和插件 UI renderer。

### 7.12 upy-analyze-plugin 与 upy-analyze 的关系

已确认：

- 不将 `upy-analyze-plugin` 合并回 `upy-analyze`。
- 短期继续双轨维护。
- `upy-analyze-plugin` 作为插件化 V0 样板。

## 8. 新增硬性规则：格式、枚举、模板必须强制校验

已确认：

所有涉及格式、类型枚举、模板结构、阶段完成输出的内容，必须满足以下规则：

1. **必须有模板文件**
   - envelope 模板。
   - `phase_complete` 模板。
   - `checkpoint` 模板。
   - `structured_errors` 模板。
   - `artifact.file_list` 模板。
   - mock message 模板。

2. **必须有枚举定义**
   - `phase`
   - `result`
   - `next_phase`
   - `artifact.type`
   - `artifact.files[].status`
   - `structured_errors[].severity`
   - `driver.source`
   - `requirements` 内已有枚举字段。

3. **必须强制校验**
   - skill 运行完成后，必须调用校验脚本验证格式。
   - `phase_complete.analyze.json` 必须通过 `init_manifest.py --validate-phase-complete`。
   - `manifest_validated.json` 必须通过 manifest 校验。
   - `phase_complete.payload.manifest_content` 必须通过 manifest 校验。
   - `manifest_validated.json` 与 `manifest_content` 必须做核心字段一致性校验。

4. **校验失败不得宣称阶段成功**
   - 如果 manifest 校验失败，不得输出 `result="success"`。
   - 如果 `phase_complete` envelope 或 payload 校验失败，不得宣称 analyze 完成。
   - 如果 artifact/file_list 声明了不存在的文件，Claude Code 直测不得判定为通过。

5. **业务语义先 warning，协议格式必须 error**
   - 业务判断类问题优先作为 warning，例如 TouchPad 板卡兼容性、语音 output schema 不完整。
   - 协议格式、必填字段、枚举非法、manifest 核心结构错误必须作为 error。

## 9. 下一轮 Codex 修改目标

基于以上确认，下一轮可直接修改 `G:\MicroPython_Skills\upy-analyze-plugin`：

1. 修改 `SKILL.md`
   - 增加完整 envelope/session 规则。
   - 增加 result 枚举说明。
   - 增加 partial/checkpoint 规则。
   - 增加取消、重试、超时 V0 语义。
   - 增加权限确认策略说明。
   - 增加 artifact/file_list 统一模型说明。
   - 强制要求运行结束调用校验脚本。

2. 修改 `scripts/init_manifest.py`
   - 强制校验 envelope。
   - 校验 UUID 形态的 `msg_id/session_id`。
   - 校验 `protocol_version == "1.0"`。
   - 校验顶层 `phase` 与 `payload.phase` 一致。
   - 校验 `result` 枚举和 `next_phase` 规则。
   - 校验 `structured_errors` 结构。
   - 校验 artifact file status 枚举。
   - 支持 manifest 与 phase_complete manifest_content 核心字段一致性校验。

3. 修改 `test/smoke_tests.py`
   - 适配 session 隔离目录。
   - 校验完整 envelope。
   - 校验 file_list 声明文件存在。
   - 校验 manifest 核心字段一致。
   - 加入 partial/failed 样本。

4. 增加 mock messages
   - skill 内最小 mock。
   - success / partial / failed phase_complete 样本。
   - start_phase / approval / script_run / script_result 样本。

