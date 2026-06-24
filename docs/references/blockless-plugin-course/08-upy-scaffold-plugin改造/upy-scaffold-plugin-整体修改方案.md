# upy-scaffold-plugin 整体修改方案

## 目标

基于当前真实 session：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

以及分析文件：

```text
G:\blockless-plugin-course(1)\upy-scaffold-plugin-session-output-path-analysis.md
```

整理后续对 `G:\MicroPython_Skills\upy-scaffold-plugin` 的整体修改方案，并标出涉及其他 skill 的同步改动点。

本方案先只给设计和实施计划，不直接修改 skill 内容。

## 已重新加载并核对的相关内容

本次重新读取了以下内容：

```text
G:\MicroPython_Skills\upy-scaffold-plugin\SKILL.md
G:\MicroPython_Skills\upy-select-hw-plugin\SKILL.md
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\phase_complete.upy_flash_mpy_firmware_plugin.esp32_c3_success.json
G:\MicroPython_Skills\upy-project-gen-toolchain-spec\scripts\workflow_time.py
```

关键结论：

- `upy-select-hw-plugin` 已经清晰区分 `artifact_root`、`session_root`、`resource_root`，并明确要求时间来自 `workflow_time.py`。
- `upy-flash-mpy-firmware-plugin` 当前文档要求成功 payload 必须包含 `firmware`，但没有强制完整 `manifest_content`。
- `upy-flash-mpy-firmware-plugin` 的校验脚本 `flash_mpy_firmware_manifest.py` 当前也没有强制校验 `payload.manifest_content`。
- flash 的 sample `phase_complete.upy_flash_mpy_firmware_plugin.esp32_c3_success.json` 有一个极简 `manifest_content`，但真实 session 的 `phase_complete.upy_flash_mpy_firmware_plugin.json` 没有 `manifest_content`。
- `workflow_time.py --json` 可以输出统一 UTC 时间，例如：`{"utc":"2026-06-23T05:49:29Z"}`。

## 路径策略决策

### 问题

当前 scaffold 文件写到了：

```text
G:\test\test
```

而不是用户传入的 session 目录：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

根因是当前 scaffold 的 `file_operations[]` 都是相对项目根路径，例如：

```text
firmware/main.py
project-manifest.json
.upy/scripts/init_scaffold.py
```

宿主把 `cwd=G:\test\test` 当成 project root 执行写入，因此项目文件落在 `G:\test\test`。

### 可选方案对比

| 方案 | 目录结构 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A | 继续写 `G:\test\test` | 简单，符合当前 cwd 逻辑 | 污染工作区根目录；多个 session 会互相覆盖；用户传 session 目录时不直观 | 不推荐 |
| B | 源码直接写 `session_root`，json/log 放 `session_root/_state` | 用户传 session 目录后源码就在该目录 | session 已有固件、phase_complete、日志；源码与会话状态混杂；`firmware/` 会同时有固件 bin 和源码目录语义冲突 | 不推荐 |
| C | json/log 继续在 `session_root`，源码写 `session_root/project` | 语义清晰；不污染工作区根；不混淆固件产物和源码；支持多 session 隔离 | 后续插件必须读取 `project_root` 字段继续工作 | 推荐 |
| D | json/log 写 `session_root/state`，源码写 `session_root/project` | 最干净 | 需要迁移 analyze/select-hw/flash 现有 session 产物约定，跨 skill 改动大 | 后续可演进，不作为本次最小改动 |

### 推荐决策

本次推荐采用方案 C：

```text
session_root = G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
project_root = G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project
```

规则：

```text
1. session_root 保存阶段状态、checkpoint、phase_complete、日志、固件下载等会话产物。
2. project_root 保存 scaffold 生成的 MicroPython 项目源码和项目工具。
3. file_operations[] 的 path 仍保持相对 project_root，不加 sessions/<id>/project 前缀。
4. 宿主或本地 runner 应用 file_operations[] 时，必须以 project_root 作为根目录。
5. flake8 cwd 必须等于 project_root。
6. 后续 upy-generate-plugin 必须从 phase_complete.payload.runtime_context.project_root 继续改项目代码。
```

## 聊天中两个错误的修改建议

### UnicodeDecodeError: gbk

原因：Windows 下 `json.load(open(path))` 默认按 GBK 读文件，中文 UTF-8 JSON 会失败。

修改建议：

1. 文档禁止使用裸 `open(path)` 读取中文 JSON。
2. 所有本地 one-liner 改成：

```python
json.load(open(path, encoding="utf-8-sig"))
```

3. 推荐直接让 renderer 读文件路径：

```text
python -X utf8 scripts/init_scaffold.py --mode timer --manifest "<session_root>\select_hw_validated.json"
```

4. 本地 runner 的所有 JSON read/write 都使用 `encoding="utf-8-sig"` 读、`encoding="utf-8"` 写。

### full scaffold requires a manifest object

原因：前面的 GBK 解码错误导致 stdin 没有给 `init_scaffold.py` 传入有效 manifest，renderer 收到空对象 `{}` 后报错。

修改建议：

1. 不用 fragile 的管道式 `python -c ... | init_scaffold.py --manifest -`。
2. 优先使用 `--manifest <path>`。
3. `run_local_actual_project.py` 应支持从 `phase_complete.upy_flash_mpy_firmware_plugin.json` 自动追溯 manifest。
4. renderer 报错时输出结构化错误码，例如：

```text
INVALID_MANIFEST
MANIFEST_READ_FAILED
UPSTREAM_PHASE_INVALID
```

## file_list 状态问题怎么改

### 当前问题

renderer 输出 `file_list.status=pending` 是合理的，因为 renderer 只是生成“待写入草案”。

但最终 `phase_complete.upy_scaffold_plugin.json` 是阶段完成消息，此时文件已经写入并通过 flake8，继续保留 `pending` 是错误的。

### 修改方案

分两层：

1. `scripts/init_scaffold.py` 输出保持：

```json
{"path":"firmware/main.py","status":"pending"}
```

2. 宿主或本地 actual runner 写入成功后，最终 phase_complete 改为：

```json
{"path":"firmware/main.py","status":"created","sha256":"..."}
```

3. 如果文件已存在且内容相同：

```json
{"path":"firmware/main.py","status":"unchanged","sha256":"..."}
```

4. 如果文件已存在且内容不同，且没有覆盖许可：

```json
{"path":"firmware/main.py","status":"skipped","reason":"conflict_existing_file"}
```

5. 最终 phase_complete 增加 `file_manifest`：

```json
{
  "type": "file_manifest",
  "root": "<project_root>",
  "files": [
    {
      "path": "firmware/main.py",
      "status": "created",
      "encoding": "utf-8",
      "sha256": "...",
      "bytes": 869
    }
  ]
}
```

## 生成文件中的 MicroPython 版本注释

### 当前问题

模板中硬编码：

```text
# Python env   : MicroPython v1.23.0
```

但真实 flash 阶段固件是：

```text
ESP32_GENERIC_C3 v1.28.0
```

### 修改方案

1. `templates/firmware/*.tmpl` 和 `templates/lib/scheduler/timer_sched.py` 不再硬编码版本。
2. 增加模板变量：

```text
MICROPYTHON_VERSION_LABEL
```

3. 取值优先级：

```text
manifest_content.firmware_flash.latest_version
manifest_content.firmware_flash.version
manifest_content.firmware.latest_version
manifest_content.mcu.firmware_version
"MicroPython"
```

4. 输出示例：

```text
# Python env   : MicroPython v1.28.0
```

如果没有版本事实：

```text
# Python env   : MicroPython
```

5. `init_scaffold.py` 的 `template_variables()` 应从 manifest 中计算该变量。

## 阶段时间戳怎么改

### 当前问题

scaffold 当前用 `datetime.now(timezone.utc)` 自己生成 `updated_at`，最终 phase_complete timestamp 在真实 session 中疑似手写固定值。

### 修改方案

统一使用：

```text
G:\MicroPython_Skills\upy-project-gen-toolchain-spec\scripts\workflow_time.py
```

调用方式：

```text
python -X utf8 G:\MicroPython_Skills\upy-project-gen-toolchain-spec\scripts\workflow_time.py --json
```

返回：

```json
{"utc":"2026-06-23T05:49:29Z"}
```

落地建议：

1. `scripts/init_scaffold.py` 可保留纯 renderer，但它生成 `manifest_content.updated_at` 时应调用统一 helper。
2. 为避免 renderer 依赖子进程，也可以在 scaffold 中新增 `workflow_time()` helper：
   - 优先调用 `TOOLCHAIN_SPEC_DIR/scripts/workflow_time.py --json`
   - 调用失败时 fallback 到本地 `datetime.now(timezone.utc)` 并写 warning
3. 最终 `phase_complete.timestamp` 必须由宿主或 `run_local_actual_project.py` 在全部写入、flake8 通过后再次调用 `workflow_time.py --json` 获取。
4. 禁止在 sample 之外写固定整点 timestamp。

需要记录的时间字段：

```text
payload.manifest_content.updated_at
payload.phase_completed_at
payload.lint.completed_at
payload.file_manifest.generated_at
envelope.timestamp
approval.confirmed_at
permissions[].approved_at
```

## 重试/幂等/覆盖策略

### 原则

scaffold 会写大量项目文件，后续 `upy-generate-plugin` 和用户可能继续修改这些文件。重试时不能无条件覆盖。

### 推荐策略

1. `idempotency_key` 稳定：

```text
upy-scaffold-plugin:<session_id>:<mode>:<project_root_hash>:v1
```

2. 首次写入：

```text
目标不存在 -> created
目标存在且内容相同 -> unchanged
目标存在且内容不同 -> conflict，默认不覆盖
```

3. 允许覆盖的条件：

```text
用户明确 approval overwrite_conflicts
或当前 retry_of 对应同一 idempotency_key 且已有 file_manifest 证明内容一致
```

4. 记录每个文件的结果：

```json
{
  "path": "firmware/main.py",
  "status": "created|updated|unchanged|skipped|error",
  "sha256_before": null,
  "sha256_after": "...",
  "overwrite": false,
  "reason": null
}
```

5. 如出现冲突，不能进入 `upy-generate-plugin`：

```json
{
  "result": "partial",
  "next_phase": null,
  "checkpoint": {
    "resume_step": "resolve_file_conflicts",
    "state_file": "<session_root>/scaffold_state.json"
  },
  "structured_errors": [
    {
      "code": "FILE_CONFLICT",
      "severity": "error",
      "recoverable": true,
      "retryable": false,
      "field": "file_operations[].path"
    }
  ]
}
```

### 本地 runner 改动

`test/run_local_actual_project.py` 增加：

```text
--session-dir
--project-dir
--force
--dry-run
--resume-state
```

默认：

```text
--force=false
```

非空 project_root 下遇到冲突默认失败或 partial，不直接覆盖。

## 权限提示/审批结果结构化

### 当前问题

scaffold 阶段涉及：

```text
approval_request(scaffold_config)
script_run(init_scaffold.py)
file_operation(write)
script_run(flake8)
```

但最终 phase_complete 没有沉淀审批和权限事实。

### 修改方案

最终 phase_complete 增加：

```json
{
  "approval": {
    "approval_id": "scaffold_config",
    "confirmed": true,
    "confirmed_at": "<utc>",
    "mode": "timer",
    "modules": ["logger", "flash_device", "log_tools"],
    "custom_files": [],
    "source": "approval_response"
  },
  "permissions": [
    {
      "type": "script_run",
      "name": "init_scaffold",
      "command": "python .../init_scaffold.py ...",
      "approved": true,
      "approved_at": "<utc>",
      "idempotency_key": "upy-scaffold-plugin:<session_id>:script:init-scaffold:v1"
    },
    {
      "type": "file_operation",
      "root": "<project_root>",
      "operation": "write",
      "file_count": 44,
      "approved": true,
      "approved_at": "<utc>",
      "idempotency_key": "upy-scaffold-plugin:<session_id>:file-write:v1"
    },
    {
      "type": "script_run",
      "name": "flake8",
      "command": "python -m flake8 firmware tools",
      "cwd": "<project_root>",
      "approved": true,
      "approved_at": "<utc>",
      "idempotency_key": "upy-scaffold-plugin:<session_id>:script:flake8:v1"
    }
  ]
}
```

如果用户取消或权限拒绝：

```text
result=partial 或 cancelled
next_phase=null
checkpoint.resume_step=await_permission
structured_errors[].code=PERMISSION_DENIED 或 USER_CANCELLED
```

## flash 阶段是否应该传 manifest_content

### 重新核对结果

`upy-flash-mpy-firmware-plugin/SKILL.md` 当前明确要求：

```text
成功 payload 必须包含 firmware
```

但没有明确要求完整 `payload.manifest_content`。

`flash_mpy_firmware_manifest.py` 当前校验：

- 校验 envelope
- 校验 runtime_context
- 校验 `payload.firmware`
- 校验 artifacts
- 不强制 `payload.manifest_content`

sample `phase_complete.upy_flash_mpy_firmware_plugin.esp32_c3_success.json` 包含一个极简 `manifest_content`：

```json
{
  "phase": "upy-flash-mpy-firmware-plugin",
  "board_name": "ESP32_GENERIC_C3",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
  "firmware_action": "download_and_flash",
  "firmware_status": "flashed"
}
```

但这个 sample 里的 manifest_content 不是完整项目 manifest，只是固件摘要。真实 session 的 flash phase_complete 则没有 `manifest_content`。

### 判断

这是跨 skill 协议缺口。按工作流原则，每个 phase 的 `phase_complete.payload.manifest_content` 应携带“截至本阶段的完整项目事实”，否则下游需要回读更早阶段文件并手动合并新增事实。

### 推荐改法

需要同步修改 `upy-flash-mpy-firmware-plugin`：

1. flash 阶段读取上游 select-hw 的完整 `manifest_content`。
2. 成功时复制该 manifest，并追加：

```json
{
  "phase": "upy-flash-mpy-firmware-plugin",
  "firmware_flash": {
    "status": "flashed",
    "action": "download_and_flash",
    "board_name": "ESP32_GENERIC_C3",
    "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
    "latest_url": "https://micropython.org/resources/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
    "latest_version": "v1.28.0",
    "latest_date": "2026-04-06",
    "file": "sessions/<session_id>/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
    "file_type": "bin",
    "flash_method": "esptool.py",
    "flash_result": {
      "tool": "esptool",
      "tool_version": "4.11.0",
      "port": "COM88",
      "baud": 460800,
      "write_offset": "0",
      "erased_first": true,
      "log": "sessions/<session_id>/flash_esp32_log.json"
    }
  },
  "final_status": "firmware_ready",
  "updated_at": "<utc>"
}
```

3. flash phase_complete 同时保留 `payload.firmware`，因为这是当前插件已定义的阶段摘要。
4. `flash_mpy_firmware_manifest.py` 增加校验：

```text
success 时 payload.manifest_content 必须是对象
payload.manifest_content.phase == upy-flash-mpy-firmware-plugin
payload.manifest_content.firmware_flash.status 与 payload.firmware.status 一致
payload.manifest_content.firmware_flash.file 与 payload.firmware.file 一致
```

5. 更新 flash sample 和 smoke tests。

### scaffold 侧兼容策略

考虑旧 flash 产物可能没有完整 `manifest_content`，scaffold 应支持兼容：

```text
优先：flash phase_complete.payload.manifest_content
兼容：读取 flash payload.source_phase_complete_path 指向的 select-hw manifest，再把 flash payload.firmware 合并为 firmware_flash
最后 fallback：用户显式传入 select_hw_validated.json
```

这样既能支持新协议，又能兼容当前真实 session。

## upy-scaffold-plugin 具体修改清单

### 1. SKILL.md

需要新增或修改：

- 明确 `project_root`、`session_root`、`artifact_root`、`resource_root`。
- 明确传入 session 目录时默认 `project_root=session_root/project`。
- 明确 `file_operations[]` 永远相对 project_root。
- 明确 `phase_complete` 必须记录 `runtime_context.project_root`、`file_operation_root`、`lint.cwd`。
- 明确 Windows JSON 读取必须 UTF-8。
- 明确最终 file_list 状态应为 `created/updated/unchanged/skipped/error`，renderer 草案才用 `pending`。
- 明确时间来自 `workflow_time.py`。
- 明确重试、幂等、冲突、覆盖策略。
- 明确审批和权限结构化字段。
- 明确 flash manifest_content 优先级和兼容合并策略。

### 2. scripts/init_scaffold.py

建议改动：

- 增加 `workflow_utc_now()`，优先调用 `upy-project-gen-toolchain-spec/scripts/workflow_time.py --json`。
- 增加 `merge_flash_facts(manifest, flash_payload)` 或等价逻辑。
- `unwrap_manifest()` 支持 flash phase_complete：
  - 若有 `payload.manifest_content`，使用它。
  - 若只有 `payload.firmware` + `payload.source_phase_complete_path`，需要调用方先传合并后的 manifest；renderer 本身不建议主动跨文件追溯太多。
- `updated_manifest()` 写入：
  - `phase="scaffold"`
  - `final_status="scaffolded"`
  - `firmware_flash` 保留
  - `scaffold` 结构化字段
- `template_variables()` 增加 `MICROPYTHON_VERSION_LABEL`。
- `build_output()` 的 `phase_complete_payload` 可继续作为草案，但增加建议字段：
  - `file_manifest` 草案可选
  - `warnings` 使用结构化形式或至少避免绝对路径
- optional resource warning 不直接暴露本机绝对路径，改为相对候选。

注意：`init_scaffold.py` 仍应保持 side-effect-free，不直接写 project_root。

### 3. templates

需要小改，不做业务复杂化：

```text
templates/firmware/*.tmpl
templates/lib/scheduler/timer_sched.py
```

把：

```text
# Python env   : MicroPython v1.23.0
```

改为：

```text
# Python env   : ${MICROPYTHON_VERSION_LABEL}
```

或对非 Template 复制文件，在 `add_copy` 前做简单变量替换。

### 4. test/run_local_actual_project.py

这是本次最关键的本地宿主模拟器，应承担正式落盘语义：

新增参数：

```text
--session-dir
--project-dir
--source-phase-complete
--force
--dry-run
--resume-state
```

默认规则：

```text
如果 --project-dir 存在：使用它
否则如果 --session-dir 存在：project_dir = session_dir/project
否则：临时目录
```

职责：

- 调用 renderer。
- 应用 file_operations 到 project_root。
- 计算 sha256、bytes、status。
- 检测冲突并默认不覆盖。
- 运行 flake8，cwd=project_root。
- 生成本地 phase_complete summary，包含 runtime_context、file_manifest、lint、approval、permissions、idempotency。
- 支持 dry-run 只输出计划，不写文件。

### 5. test/smoke_tests.py

新增/调整断言：

- 生成文件头不再包含 `MicroPython v1.23.0`。
- 如果 manifest 有 `firmware_flash.latest_version=v1.28.0`，生成文件头包含 `MicroPython v1.28.0`。
- `project-manifest.json.final_status == "scaffolded"`。
- `firmware_flash` 不丢失。
- `phase_complete_payload.next_phase == "upy-generate-plugin"`。
- renderer file_list 可以 pending，但 actual runner final file_manifest 必须 created/unchanged。

### 6. sample

更新：

```text
sample/start_phase.upy_scaffold_plugin.full.json
sample/start_phase.upy_scaffold_plugin.incremental.json
sample/approval_request.scaffold_config.json
```

增加或修正：

```text
runtime_context.project_root
runtime_context.session_root
permissions
idempotency_key
真实 timestamp 占位说明，不使用固定时间作为真实运行示例
```

## 涉及其他 skill 的同步修改

### upy-flash-mpy-firmware-plugin

必须改，因为当前没有强制完整 `manifest_content`，真实 session 也没有传。

建议改动：

1. `SKILL.md`：明确成功 phase_complete 必须输出完整 `payload.manifest_content`。
2. `scripts/flash_mpy_firmware_manifest.py`：success 时校验 manifest_content。
3. sample：把极简 manifest_content 改为完整 select-hw manifest + firmware_flash。
4. smoke tests：新增 manifest_content 校验。

### upy-select-hw-plugin

不需要大改。它已经有较完整的 root 和时间规则。

建议只同步一条约定到课程文档或后续 generate：

```text
select-hw 的 artifact_root/session_root 继续表示会话产物，不等于 scaffold project_root。
```

### upy-generate-plugin

当前如果后续创建/改造，应强制：

```text
从 upy-scaffold-plugin phase_complete.payload.runtime_context.project_root 读取和修改项目代码。
不要猜 cwd。
```

如果没有 project_root，必须 partial/failed，不能写到 cwd。

## 推荐实施顺序

### 阶段 1：scaffold 文档与 runner 先改

1. 改 `upy-scaffold-plugin/SKILL.md` 路径、时间、file_manifest、权限、幂等规则。
2. 改 `test/run_local_actual_project.py` 支持 `--session-dir -> session/project`。
3. 先不动 renderer 大逻辑，只让 actual runner 产出正确 final summary。
4. 更新 smoke/actual 测试。

### 阶段 2：renderer 和模板修正

1. 改 MicroPython 版本变量。
2. 改 `updated_manifest()` 保留/写入 firmware_flash 和 final_status。
3. 改 optional resource warning 不暴露绝对路径。
4. 改时间来源为 `workflow_time.py` helper。

### 阶段 3：flash 协议补齐

1. 改 flash `SKILL.md` 要求完整 manifest_content。
2. 改 flash validator。
3. 改 flash sample/smoke tests。
4. scaffold 保留兼容 fallback。

### 阶段 4：同步到 Claude skills 并真实 session 复测

1. 运行：

```text
python -X utf8 upy-scaffold-plugin\test\smoke_tests.py
python -X utf8 upy-scaffold-plugin\test\run_local_actual_project.py --session-dir G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

2. 确认生成：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\firmware\main.py
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\project-manifest.json
```

3. 确认 flake8：

```text
cwd = ...\session\project
returncode = 0
```

4. 同步：

```text
C:\Users\Administrator\.claude\skills\upy-scaffold-plugin
```

## 是否需要移动当前 G:\test\test 已生成文件

本方案不建议自动移动已有 `G:\test\test` 下生成的 scaffold 文件。

原因：

- 这些文件是一次已完成测试产物。
- 自动移动可能破坏当前日志和 phase_complete 对应关系。
- 后续按新规则复测时，应生成到 `session/project`，再由用户决定是否清理旧根目录文件。

如果需要清理，应单独做清理计划，先列出将删除/移动的文件，再确认后执行。

## 最终建议

本次应采用：

```text
session_root/project 作为 scaffold 项目输出目录
```

而不是把 JSON/log 另塞进 session 子目录后让代码直接写 session 根目录。

核心原因：

```text
1. session_root 已经承担阶段产物目录职责。
2. project_root 应独立承载源码项目。
3. 后续 generate/deploy 都可以稳定从 project_root 继续。
4. 重试、幂等、权限、file_manifest 都更容易表达。
```

最小但完整的修改边界：

```text
upy-scaffold-plugin：必须改
upy-flash-mpy-firmware-plugin：必须补 manifest_content 交接
upy-select-hw-plugin：无需大改，只沿用 root/time 规则
upy-generate-plugin：后续必须消费 project_root
```

## 合并补充：session-output-path-analysis 中其他问题的修改方案

本节用于补齐 `upy-scaffold-plugin-session-output-path-analysis.md` 中已发现、但前文整体方案尚未展开到实施细节的问题。以下内容应一并纳入后续 `G:\MicroPython_Skills\upy-scaffold-plugin` 改造范围。

## phase_complete 上游来源链路

### 问题

当前 scaffold 的最终 `phase_complete.upy_scaffold_plugin.json` 顶层有 `session_id`，但 payload 中缺少完整来源链路：

```text
source_phase
source_phase_complete_path
source_manifest_path
source_manifest_kind
approval source
selected mode source
```

这导致后续 `upy-generate-plugin` 只读 scaffold phase_complete 时，无法判断项目事实来自 flash phase_complete、select-hw manifest，还是本地直测 fallback。

### 修改方案

最终 scaffold phase_complete 增加：

```json
{
  "source": {
    "source_phase": "upy-flash-mpy-firmware-plugin",
    "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_flash_mpy_firmware_plugin.json",
    "source_manifest_path": "sessions/<session_id>/select_hw_validated.json",
    "source_manifest_kind": "select_hw_validated_fallback",
    "manifest_merge_strategy": "flash_manifest_content_or_select_hw_plus_firmware"
  }
}
```

字段规则：

| 字段 | 要求 |
|---|---|
| `source_phase` | 正式链路必须是 `upy-flash-mpy-firmware-plugin` |
| `source_phase_complete_path` | 正式链路必填，相对 artifact root/session root 口径统一 |
| `source_manifest_path` | 当使用 fallback manifest 文件时必填 |
| `source_manifest_kind` | 枚举：`flash_manifest_content`、`select_hw_validated_fallback`、`direct_manifest_input` |
| `manifest_merge_strategy` | 记录是否合并 `payload.firmware` 为 `firmware_flash` |

如果 source 不完整，不应进入 success，应输出 partial 或 failed，并给 `structured_errors[].code=SOURCE_CONTEXT_MISSING`。

## 调度模式风险 warning

### 问题

真实日志中记录：

```text
系统推荐 asyncio（因 WiFi + voice_control），用户选择 timer。
```

但最终 phase_complete warnings 没有结构化记录该风险。

### 修改方案

在 `approval_request(scaffold_config)` 确认后，如果用户选择和推荐模式不一致，应写入非阻塞 warning：

```json
{
  "code": "SCHEDULER_MODE_RISK",
  "severity": "warning",
  "blocking": false,
  "message": "voice_control + wifi 场景推荐 asyncio，用户选择 timer；后续 generate 阶段不得在 timer callback 中执行阻塞网络或音频逻辑。",
  "recommended_mode": "async",
  "selected_mode": "timer",
  "reason": ["requirements.network=wifi", "special_requirements contains voice_control"]
}
```

实现位置：

- `SKILL.md` 写规则。
- `run_local_actual_project.py` 或宿主最终 phase_complete 生成时写入 warnings。
- renderer 可输出普通 warning，但最终 phase_complete 应转为结构化对象。

## optional resource warning 不暴露本机绝对路径

### 问题

当前 warning 中包含：

```text
C:\Users\Administrator\.claude\skills\...
```

这会把宿主本机路径写入正式 phase_complete，不利于可移植和日志审计。

### 修改方案

`init_scaffold.py` 中 `add_upy_resource()` 的 warning 改为结构化、相对资源 id：

```json
{
  "code": "OPTIONAL_RESOURCE_MISSING",
  "severity": "warning",
  "blocking": false,
  "resource": ".upy/error_lib.json",
  "source_candidates": [
    "upy-autofix-plugin/templates/error_lib.json",
    "upy-autofix/templates/error_lib.json"
  ]
}
```

详细本机绝对候选路径只允许写入 debug log，不进入 `phase_complete.payload.warnings`。

建议实现：

```text
warnings[] 从 string 迁移为 object。
为兼容旧测试，短期可允许 string/object 混合，但最终 phase_complete 应规范化成 object。
```

## scaffold_phase_log 自动生成

### 问题

当前 `scaffold_phase_log.md` 的项目结构摘要与实际文件列表不一致。例如日志只列出 `.upy/scripts` 中三个文件，但实际落盘和 phase_complete 包含更多脚本。

这说明 phase log 是手工摘要或旧模板，不是从最终 file manifest 生成。

### 修改方案

新增一个日志渲染规则：

```text
scaffold_phase_log.md 必须由最终 phase_complete / file_manifest 渲染，不能手写项目树摘要。
```

建议新增或扩展本地 runner：

```text
test/run_local_actual_project.py --write-phase-log
```

输出：

```text
<session_root>/scaffold_phase_log.md
```

日志内容来源：

| 日志段落 | 数据源 |
|---|---|
| 会话 ID / 阶段 / 时间 | final phase_complete envelope |
| project_root / session_root | payload.runtime_context |
| 上游校验 | payload.source |
| 用户配置 | payload.approval |
| 写入结果 | payload.file_manifest |
| flake8 | payload.lint |
| warnings/errors | payload.warnings / structured_errors |
| 项目结构 | payload.file_manifest.files 自动生成 |

这样可以避免日志和最终 JSON 分叉。

## phase 命名歧义

### 问题

当前 scaffold phase_complete 形状类似：

```json
{
  "phase": "upy-scaffold-plugin",
  "payload": {
    "phase": "scaffold"
  }
}
```

这不一定错误，但必须固定语义，否则后续插件容易误判。

### 修改方案

推荐保留顶层：

```text
top-level phase = plugin phase id = upy-scaffold-plugin
```

payload 中改名，避免重复字段：

```json
{
  "payload": {
    "domain_phase": "scaffold",
    "result": "success"
  }
}
```

兼容策略：

```text
短期保留 payload.phase="scaffold"，同时新增 payload.domain_phase="scaffold"。
文档明确 payload.phase 是历史兼容字段。
后续新插件优先读 payload.domain_phase。
```

测试中新增断言：

```text
phase_complete.phase == "upy-scaffold-plugin"
payload.domain_phase == "scaffold"
```

## cancellation / timeout / retry mock 覆盖

### 问题

当前测试只覆盖成功路径，没有覆盖：

```text
cancellation
timeout
retry
idempotency
partial failure
permission denied
file conflict
```

### 修改方案

新增测试文件：

```text
upy-scaffold-plugin/test/mock_protocol_cases.py
```

或扩展：

```text
upy-scaffold-plugin/test/run_local_actual_project.py
```

建议覆盖场景：

| 场景 | 输入/动作 | 期望 |
|---|---|---|
| cancellation before write | 模拟用户取消 file permission | `result=cancelled` 或 `partial`，`next_phase=null` |
| timeout before approval | `approval_response` 超时 | `result=partial`，checkpoint `resume_step=scaffold_config` |
| retry same idempotency | 同一 idempotency_key 重跑 | 已写相同文件为 `unchanged` |
| conflict existing file | 修改目标 `firmware/main.py` 后重跑 | `FILE_CONFLICT`，默认不覆盖 |
| permission denied | 拒绝写 project_root | `PERMISSION_DENIED`，不进入 generate |
| flake8 failed | 注入坏 py 文件 | `SCAFFOLD_LINT_FAILED`，`next_phase=null` |

这些 mock 不需要真实插件宿主，应该由本地 runner 生成结构化 phase_complete 草案并断言字段。

## structured_errors taxonomy

### 问题

当前 scaffold 成功路径 `errors=[]`，但失败路径缺少稳定错误码设计。

### 修改方案

在 `SKILL.md` 和测试中定义错误码：

```text
UPSTREAM_PHASE_INVALID
MANIFEST_READ_FAILED
INVALID_MANIFEST
PROJECT_ROOT_MISSING
UNSAFE_PATH
FILE_MANIFEST_MISMATCH
FILE_CONFLICT
PERMISSION_DENIED
USER_CANCELLED
APPROVAL_TIMEOUT
SCAFFOLD_RENDER_FAILED
SCAFFOLD_WRITE_FAILED
SCAFFOLD_LINT_FAILED
SOURCE_CONTEXT_MISSING
PHASE_COMPLETE_INVALID
```

结构：

```json
{
  "code": "FILE_CONFLICT",
  "message": "目标文件已存在且内容不同，默认不覆盖。",
  "severity": "error",
  "recoverable": true,
  "retryable": false,
  "source": "run_local_actual_project.py",
  "field": "file_operations[].path"
}
```

`errors[]` 可保留字符串摘要，但机器判断必须使用 `structured_errors[]`。

## artifact/file manifest 类型扩展

### 问题

当前 renderer 只有 `file_tree` 和 `file_list`，没有明确最终落盘根、hash、字节数、写入状态。

### 修改方案

最终 phase_complete 的 artifacts 至少包含三类：

```text
file_tree       用于 UI 展示项目结构
file_list       兼容旧协议，列出文件状态
file_manifest   新协议，带 root/hash/bytes/status
```

示例：

```json
{
  "type": "file_manifest",
  "title": "Scaffold 写入清单",
  "root": "G:/test/test/sessions/<id>/project",
  "generated_at": "<utc>",
  "files": [
    {
      "path": "firmware/main.py",
      "status": "created",
      "encoding": "utf-8",
      "bytes": 869,
      "sha256": "..."
    }
  ]
}
```

同时 payload 顶层可加快捷字段：

```json
"file_manifest": { ...同上... }
```

但 artifacts 中必须也声明，方便统一 UI 和校验器消费。

## final_status 与 phase 字段一致性

### 问题

当前 scaffold 后 manifest 中：

```text
phase = scaffold
final_status = hardware_selected
```

`final_status` 停留在 select-hw 阶段，不符合当前阶段。

### 修改方案

`updated_manifest()` 写入：

```json
{
  "phase": "scaffold",
  "final_status": "scaffolded",
  "scaffold": {
    "mode": "timer",
    "modules": ["logger", "flash_device", "log_tools"],
    "project_root": "<project_root or protocol path>",
    "generated_files": 44
  }
}
```

保留旧字段兼容：

```text
scaffold_mode
scaffold_modules
```

但新增结构化 `scaffold` 字段作为新协议主字段。

## 当前 G:\test\test 已生成文件处理策略

### 问题

旧运行已经在 `G:\test\test` 根目录写了 scaffold 文件。如果后续按新方案生成到 `session/project`，根目录会残留旧产物。

### 修改方案

不要在 scaffold 修改任务中自动移动或删除旧文件。

如果用户要求清理，单独创建清理计划：

```text
1. 列出 G:\test\test 根目录下由 scaffold 生成的文件。
2. 排除 sessions/ 目录。
3. 询问是删除、移动到 session/project，还是保留。
4. 获得确认后再执行。
```

原因：

```text
自动移动会改变本次分析对应的真实现场，不利于复盘。
```

## 与 upy-generate-plugin 的衔接要求

虽然当前任务是 scaffold，但 session-output-path-analysis 中的问题会直接影响下一阶段。

`upy-generate-plugin` 后续必须遵守：

```text
1. 只从 upy-scaffold-plugin phase_complete.payload.runtime_context.project_root 定位项目源码。
2. 不从 cwd 猜项目根。
3. 如果缺 project_root，输出 partial/failed，不写文件。
4. 读取 project-manifest.json 时以 project_root 为根。
5. 写业务代码时复用 scaffold file_manifest/hash 作为冲突检测依据。
```

如果 `project_root` 指向不存在目录，generate 应输出：

```text
PROJECT_ROOT_MISSING
next_phase=null
checkpoint.resume_step=locate_project_root
```

## 追加后的完整修改边界

| 模块 | 必改内容 |
|---|---|
| `upy-scaffold-plugin/SKILL.md` | 路径语义、时间、source、approval、permissions、file_manifest、structured_errors、phase 命名、mock 场景 |
| `scripts/init_scaffold.py` | manifest 合并、MicroPython 版本变量、final_status、warning 结构化、workflow_time helper |
| `templates/firmware/*` | 去掉硬编码 MicroPython v1.23.0 |
| `test/run_local_actual_project.py` | session/project 输出、hash、冲突、permissions、lint、final phase_complete summary |
| `test/smoke_tests.py` | 新字段与版本注释断言 |
| `test/mock_protocol_cases.py` | cancellation/retry/timeout/idempotency mock 覆盖 |
| `upy-flash-mpy-firmware-plugin` | 完整 manifest_content 输出和校验 |
| `upy-generate-plugin` | 后续必须消费 project_root |

## 合并后的优先级

| 优先级 | 修改项 |
|---|---|
| P0 | `project_root=session_root/project` 规则 |
| P0 | phase_complete 记录 `runtime_context.project_root`、`file_operation_root`、`lint.cwd` |
| P0 | final `file_list` 状态从 pending 改为 created/unchanged/skipped/error |
| P0 | `file_manifest` 带 root/hash/bytes/status |
| P0 | flash 完整 manifest_content 或 scaffold 兼容合并 firmware facts |
| P0 | Windows UTF-8 JSON 读取规则 |
| P1 | MicroPython 版本注释不硬编码 |
| P1 | timestamp 调用 `workflow_time.py` |
| P1 | 权限/审批结构化 |
| P1 | 重试/幂等/覆盖策略 |
| P1 | source 链路结构化 |
| P1 | scheduler mode risk warning |
| P1 | warning 不暴露本机绝对路径 |
| P1 | scaffold_phase_log 从 file_manifest 自动生成 |
| P2 | cancellation/timeout/retry mock protocol cases |
| P2 | `payload.domain_phase` 命名兼容迁移 |
| P2 | 旧 `G:\test\test` 根目录产物清理另行处理 |
