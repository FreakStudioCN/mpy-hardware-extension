# upy-scaffold-plugin session 输出路径问题分析

## 背景

本次只分析文件与日志，不修改 `G:\test\test`、`G:\MicroPython_Skills\upy-scaffold-plugin` 或 Claude skills 内容。

用户调用方式：

```text
/upy-scaffold-plugin G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

重点疑问：为什么 scaffold 文件写到了 `G:\test\test`，而不是写到 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`。

相关日志：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\scaffold_phase_log.md
```

聊天中出现的错误：

```text
UnicodeDecodeError: 'gbk' codec can't decode byte 0xac in position 423: illegal multibyte sequence
init_scaffold.py: full scaffold requires a manifest object
```

## 当前观察结果

`G:\test\test` 当前存在 scaffold 生成的项目根文件：

```text
G:\test\test\.upy
G:\test\test\build
G:\test\test\docs
G:\test\test\firmware
G:\test\test\host
G:\test\test\test
G:\test\test\tools
G:\test\test\.flake8
G:\test\test\LICENSE
G:\test\test\project-manifest.json
G:\test\test\README.md
```

session 目录当前主要保存阶段日志、phase_complete、固件下载等会话产物：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\analyze_phase_log.md
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.select_hw.json
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.upy_flash_mpy_firmware_plugin.json
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.upy_scaffold_plugin.json
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\scaffold_phase_log.md
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\firmware\ESP32_GENERIC_C3-20260406-v1.28.0.bin
```

`scaffold_phase_log.md` 记录 scaffold 阶段为成功：

```text
结果: success
下一阶段: upy-generate-plugin
输出: stdout JSON (44 files, 24 directories)
flake8: 无输出，退出码 0
```

`select_hw_phase_log.md` 和 phase_complete 中的 runtime 上下文显示：

```text
artifact_root: .
artifact_root_mode: cwd
cwd = G:\test\test
session_root = sessions/022ad742-3269-42e9-ac20-c14f477ecdf2
```

当前 `upy-scaffold-plugin/SKILL.md` 的启动消息示例也使用：

```json
{
  "runtime_context": {
    "artifact_root": ".",
    "artifact_root_mode": "cwd",
    "session_root": "sessions/<session_id>",
    "resource_root": "<runtime-provided>"
  }
}
```

scaffold renderer 输出的 `file_operations[]` 路径是相对项目根的路径，例如：

```text
firmware/board.py
firmware/main.py
.upy/scripts/init_scaffold.py
project-manifest.json
.flake8
```

这些路径没有 `sessions/<session_id>` 前缀。因此宿主如果以 `G:\test\test` 为 cwd 应用 file operations，文件自然会写到 `G:\test\test`。

## 初步结论

按当前实现与当前日志，`G:\test\test` 被当成了“项目根目录”，而 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2` 被当成了“阶段产物/日志目录”。

所以从当前 skill 文档和实际运行逻辑看，写入 `G:\test\test` 是符合现有设计的。

但从用户调用语义看：

```text
/upy-scaffold-plugin G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

用户显然是在把 session 目录作为本次运行上下文传给 skill。此时仍然写到父级 `G:\test\test` 会造成歧义，也可能污染工作区根目录。因此这里应视为 skill 指令和本地调用约定不够明确，需要修正。

## 聊天中两个错误的原因分析

### 1. UnicodeDecodeError

错误：

```text
UnicodeDecodeError: 'gbk' codec can't decode byte 0xac in position 423: illegal multibyte sequence
```

原因是 Windows/conda 环境下直接执行：

```python
json.load(open(path))
```

未指定 encoding 时会使用默认 GBK。目标 JSON 含中文并且实际为 UTF-8，因此读取失败。

正确方式应为：

```python
json.load(open(path, encoding="utf-8-sig"))
```

或命令级使用：

```text
python -X utf8 ...
```

`init_scaffold.py` 自身的 `load_manifest()` 已使用 `encoding="utf-8-sig"`，所以如果直接传 `--manifest <json-path>`，通常不会触发这个 GBK 问题。

### 2. full scaffold requires a manifest object

错误：

```text
init_scaffold.py: full scaffold requires a manifest object
```

最可能原因是前面的 `python -c json.load(open(...))` 因编码错误失败，导致管道没有给 `init_scaffold.py` 提供有效 manifest，renderer 收到空对象 `{}`，于是报 full 模式必须有 manifest object。

这不是 `phase_complete.select_hw.json` 本身损坏，而是调用命令的编码处理和 stdin 链路不可靠。

## 目前存在的问题

### 问题 1：项目输出根目录不明确

当前 skill 没有清晰说明：当用户传入的是 session 目录时，scaffold 项目应写到哪里。

可能选项包括：

```text
G:\test\test
G:\test\test\sessions\<session_id>
G:\test\test\sessions\<session_id>\project
```

当前实际落点是 `G:\test\test`，但这不是用户从调用参数能直观看出的行为。

### 问题 2：session_root 与 project_root 混淆

当前协议只明显表达了：

```text
artifact_root = cwd
session_root = sessions/<session_id>
```

但没有在 scaffold 阶段明确输出：

```text
project_root = ?
flake8 cwd = ?
file_operations root = ?
```

这导致后续阶段和用户都难以判断源码项目到底在哪里。

### 问题 3：phase_complete 未记录实际写入根目录

`phase_complete.upy_scaffold_plugin.json` 中有 artifacts 和 manifest，但缺少明确字段记录：

```text
payload.runtime_context.session_root
payload.runtime_context.project_root
payload.lint.cwd
payload.file_manifest.root
```

因此后续 `upy-generate-plugin` 无法稳定知道应该在哪里继续改代码。

### 问题 4：file_list 状态仍是 pending

`phase_complete.upy_scaffold_plugin.json` 里的 artifact `file_list` 来自 renderer 草案，文件状态仍是：

```json
"status": "pending"
```

但日志中已经写入了文件。这会误导后续阶段，因为它看起来像“待写入”，而不是“已创建”。

### 问题 5：本地调用命令容易触发 GBK 读 JSON 问题

使用裸 `python -c json.load(open(...))` 在 Windows 中文 JSON 场景下不可靠。skill 文档应明确禁止这种写法，或给出固定安全写法。

## 建议的路径语义

建议明确三类目录：

| 字段 | 含义 | 示例 |
|---|---|---|
| `workspace_root` | 用户工作区根目录 | `G:\test\test` |
| `session_root` | 当前会话状态、日志、phase_complete、下载固件目录 | `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2` |
| `project_root` | scaffold 生成的 MicroPython 项目源码目录 | `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project` |

推荐默认规则：

```text
如果用户传入的是 session 目录：
  project_root = <session_root>/project

如果用户显式传入 --project-dir：
  project_root = --project-dir

如果正式插件宿主传入 runtime_context.project_root：
  project_root = runtime_context.project_root
```

不建议直接写到 session 根目录，因为 session 目录当前已有：

```text
firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin
phase_complete.*.json
*_phase_log.md
```

如果源码也直接写入 session 根目录，会把“项目源码”和“会话产物”混在一起，后续清理、重试、resume 都更容易混乱。

## 建议修改计划

### 1. 修改 `SKILL.md` 路径规则

在 `upy-scaffold-plugin/SKILL.md` 中新增明确规则：

```text
session_root 只存阶段产物、日志、checkpoint、phase_complete。
project_root 才是 file_operations[] 的应用根目录。
flake8 必须在 project_root 运行。
```

并明确：

```text
当用户或本地 Claude 调用只提供 session_root 时，默认 project_root = session_root/project。
不得默认把 file_operations[] 写到 cwd，除非 cwd 被显式确认为 project_root。
```

### 2. 修改本地 actual runner

修改：

```text
G:\MicroPython_Skills\upy-scaffold-plugin\test\run_local_actual_project.py
```

建议新增参数：

```text
--session-dir <path>
--project-dir <path>
```

规则：

```text
如果传 --project-dir，则写入 --project-dir。
如果只传 --session-dir，则写入 --session-dir/project。
如果两者都不传，则继续使用临时目录。
```

输出 summary 应包含：

```json
{
  "session_dir": "...",
  "project_dir": "...",
  "flake8": {
    "cwd": "<project_dir>",
    "returncode": 0
  }
}
```

### 3. 修改本地调用说明

在 skill 文档中明确 Windows JSON 读取必须使用 UTF-8：

```text
不要使用 json.load(open(path)) 读取中文 JSON。
必须使用 encoding="utf-8-sig"。
优先直接把文件路径传给 init_scaffold.py --manifest。
```

推荐命令：

```text
python -X utf8 scripts/init_scaffold.py --mode timer --manifest "<session_root>\select_hw_validated.json"
```

不推荐：

```text
python -c "import json; json.load(open(...))"
```

### 4. 修改 phase_complete 生成规范

最终宿主写出的：

```text
phase_complete.upy_scaffold_plugin.json
```

应包含实际落盘上下文：

```json
{
  "payload": {
    "runtime_context": {
      "session_root": "G:/test/test/sessions/<id>",
      "project_root": "G:/test/test/sessions/<id>/project",
      "file_operation_root": "G:/test/test/sessions/<id>/project"
    },
    "lint": {
      "command": "python -m flake8 firmware tools",
      "cwd": "G:/test/test/sessions/<id>/project",
      "returncode": 0
    }
  }
}
```

### 5. 更新 file manifest / artifacts 状态

renderer 输出可以继续保持 `pending`，因为它只是草案。

但宿主实际写入后生成最终 phase_complete 时，应把文件状态更新为：

```json
"status": "created"
```

并记录实际根目录：

```json
{
  "type": "file_manifest",
  "root": "G:/test/test/sessions/<id>/project",
  "files": [
    {"path": "firmware/main.py", "status": "created", "encoding": "utf-8"}
  ]
}
```

### 6. 同步到 Claude skills

如果确认修改方案，建议流程：

```text
1. 修改 G:\MicroPython_Skills\upy-scaffold-plugin
2. 运行 smoke tests
3. 运行 run_local_actual_project.py --session-dir G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
4. 确认项目落到 session/project
5. 同步到 C:\Users\Administrator\.claude\skills\upy-scaffold-plugin
```

## 需要用户确认的点

建议采用以下默认规则：

```text
/upy-scaffold-plugin G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

则项目源码写入：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project
```

会话日志、checkpoint、phase_complete 继续写入：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

这样可以避免污染 `G:\test\test` 根目录，也避免把源码直接混进 session 阶段产物目录。

## 当前结论

当前写入 `G:\test\test` 不是 renderer 自身错误，而是当前宿主/skill 文档把 `cwd` 当成项目根导致的结果。

真正需要修正的是：

```text
1. 明确 project_root 与 session_root 的边界。
2. 用户传入 session 目录时，默认 project_root=session_root/project。
3. phase_complete 必须记录实际 project_root 和 flake8 cwd。
4. 本地命令统一使用 UTF-8-SIG 读取 JSON，避免 Windows GBK 解码错误。
```

## 补充分析：输出路径之外的问题

除“项目输出目录落到 `G:\test\test`”之外，本次 session 还暴露出几类协议、日志、manifest 和可恢复性问题。这些问题不一定都会导致当前 scaffold 失败，但会影响后续 `upy-generate-plugin`、重试/resume、审计和本地复现。

### 1. phase_complete 的 file_list 状态与实际落盘状态不一致

当前 `phase_complete.upy_scaffold_plugin.json` 中 artifact `file_list` 的 44 个文件全部仍是：

```json
"status": "pending"
```

但 `scaffold_phase_log.md` 记录：

```text
44 files written to 24 directories
flake8 退出码 0
```

实际 `G:\test\test` 中也已经有 44 个 scaffold 文件。

这说明最终 phase_complete 直接沿用了 renderer 的“待写入草案”，没有在宿主实际写入后改成“已创建”。这会误导后续阶段：`upy-generate-plugin` 无法从 phase_complete 判断文件是否已经真正落盘。

建议修正：

```text
renderer 输出：status=pending 可以保留
宿主写入后生成最终 phase_complete：status=created
```

并新增一个真实 file manifest，例如：

```json
{
  "type": "file_manifest",
  "root": "<project_root>",
  "files": [
    {"path": "firmware/main.py", "status": "created", "encoding": "utf-8"}
  ]
}
```

### 2. phase_complete 缺少 lint 结果结构化记录

日志里写了：

```text
python -m flake8 firmware tools
结果: 无输出，退出码 0
```

但 `phase_complete.upy_scaffold_plugin.json` 没有结构化字段记录：

```text
lint.command
lint.cwd
lint.config
lint.returncode
lint.stdout
lint.stderr
```

这会导致后续无法机器校验 scaffold 阶段是否真的经过 flake8 gate。

建议最终 phase_complete 增加：

```json
{
  "lint": {
    "command": "python -m flake8 firmware tools",
    "cwd": "<project_root>",
    "config": ".flake8",
    "returncode": 0,
    "stdout": "",
    "stderr": ""
  }
}
```

### 3. scaffold manifest 未合并固件阶段事实

`phase_complete.upy_flash_mpy_firmware_plugin.json` 记录实际固件为：

```text
ESP32_GENERIC_C3 v1.28.0
firmware file: sessions/<id>/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin
port: COM88
esptool: 4.11.0
```

但 scaffold 产出的 `project-manifest.json` / `payload.manifest_content` 仍保留 select-hw 阶段旧事实：

```text
hardware_selection.selected_board.firmware.latest_version = 1.24.1
final_status = hardware_selected
```

这说明 scaffold 消费的是 `select_hw_validated.json`，而没有把 flash 阶段实际固件结果合并进 manifest。

影响：

- `project-manifest.json` 不是完整项目事实。
- 后续 deploy/generate 可能看不到实际已烧录固件版本与固件文件路径。
- `final_status=hardware_selected` 与当前 `phase=scaffold` 不一致。

建议修正：

```text
优先从 upy-flash-mpy-firmware-plugin phase_complete.payload.firmware 合并固件事实。
如果 flash phase_complete 不带 manifest_content，则 scaffold 应把 payload.firmware 写入 manifest_content.firmware 或 manifest_content.firmware_flash。
```

建议字段：

```json
{
  "firmware_flash": {
    "status": "flashed",
    "board_name": "ESP32_GENERIC_C3",
    "version": "v1.28.0",
    "file": "sessions/<id>/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
    "port": "COM88",
    "tool": "esptool",
    "tool_version": "4.11.0"
  },
  "final_status": "scaffolded"
}
```

### 4. 生成文件中的 MicroPython 版本注释不准确

实际固件阶段记录为：

```text
MicroPython v1.28.0
```

但生成的 `firmware/main.py` 和 `firmware/board.py` 文件头写的是：

```text
# Python env   : MicroPython v1.23.0
```

这属于生成元数据错误。虽然不影响 flake8，但会误导用户和后续调试。

建议修正：

```text
不要在模板中硬编码 MicroPython v1.23.0。
优先使用 manifest 中的 firmware_flash.version。
如果没有固件事实，则写 MicroPython，而不是具体版本。
```

### 5. 阶段时间戳可疑，存在实际时间与 envelope timestamp 不一致

文件系统显示 scaffold 产物写入时间约为：

```text
2026/6/23 1:52:43 Asia/Shanghai
```

`project-manifest.json.updated_at` 为：

```text
2026-06-22T17:52:37Z
```

这个与本地时间基本对应。

但 `phase_complete.upy_scaffold_plugin.json.timestamp` 为：

```text
2026-06-23T04:00:00Z
```

这不像实际生成时间，可能是手写或固定值。上游 flash 阶段也有类似问题：`timestamp=2026-06-22T04:00:00Z`，与文件写入时间不完全匹配。

影响：

- checkpoint/resume 难以判断最新阶段。
- retry 审计不可靠。
- 多阶段排序可能出错。

建议修正：

```text
所有 phase_complete envelope timestamp 必须由宿主用实际 UTC now 生成。
不要手写固定整点时间。
```

### 6. phase_complete 缺少上游来源链路

当前 scaffold phase_complete 顶层有 `session_id`，但 payload 中没有明确记录：

```text
source_phase_complete_path
source_manifest_path
source_phase
approval_id / approval result
selected scaffold mode source
```

日志里能看到这些信息，但后续插件只读 phase_complete 时拿不到完整来源链路。

建议增加：

```json
{
  "source": {
    "source_phase": "upy-flash-mpy-firmware-plugin",
    "source_phase_complete_path": "sessions/<id>/phase_complete.upy_flash_mpy_firmware_plugin.json",
    "source_manifest_path": "sessions/<id>/select_hw_validated.json"
  },
  "approval": {
    "approval_id": "scaffold_config",
    "mode": "timer",
    "modules": ["logger", "flash_device", "log_tools"],
    "confirmed": true
  }
}
```

### 7. 用户选择 Timer 与系统推荐 asyncio 的风险未进入结构化 warnings

日志中写明：

```text
系统推荐 asyncio（因 WiFi + voice_control），用户选择 timer。
```

这不是阻塞错误，但应该成为结构化 warning，因为后续 `upy-generate-plugin` 生成语音对话、WiFi、云端 API 代码时，Timer 模式可能并不适合长耗时网络/音频任务。

当前 phase_complete 的 warnings 只有 optional resource missing，没有记录这个关键调度风险。

建议增加 warning：

```json
{
  "code": "SCHEDULER_MODE_RISK",
  "severity": "warning",
  "message": "voice_control + wifi 场景推荐 asyncio，用户选择 timer；后续 generate 阶段需要避免在 timer callback 中执行阻塞网络/音频逻辑。",
  "blocking": false
}
```

### 8. warnings 暴露本机绝对路径，协议可移植性较差

当前 warning 包含：

```text
C:\Users\Administrator\.claude\skills\upy-autofix-plugin\templates\...
```

这对本地调试有用，但放进 phase_complete 会降低可移植性，也可能暴露宿主路径。

建议：

- 面向机器协议的 warning 使用资源 id 或相对描述。
- 详细 checked paths 放入 debug log，而不是 phase_complete 主 payload。

例如：

```json
{
  "code": "OPTIONAL_RESOURCE_MISSING",
  "resource": ".upy/error_lib.json",
  "source_candidates": ["upy-autofix-plugin/templates/error_lib.json", "upy-autofix/templates/error_lib.json"],
  "blocking": false
}
```

### 9. scaffold_phase_log 的项目结构与实际 phase_complete/落盘文件不完全一致

日志中的 `.upy/scripts` 只列出：

```text
validate_json.py
init_scaffold.py
download_drivers.py
```

但实际 `G:\test\test\.upy\scripts` 和 phase_complete 中还有：

```text
render_wiring_local.py
render_diagram_local.py
extract_pdf.py
convert_arduino.py
flash_device.py
read_device_log.py
run_on_device.py
hardware_sanity.py
triage.py
```

说明阶段日志的“生成产物”部分是手工摘要或旧模板，没有从最终 file manifest 自动生成。

建议：

```text
scaffold_phase_log.md 中的项目结构应由最终 file manifest 渲染，避免与实际文件列表分叉。
```

### 10. 重试/幂等/覆盖策略没有记录

当前 scaffold 已经实际写了 44 个文件，但没有看到：

```text
idempotency write checkpoint
content hash
existing file conflict policy
overwrite / skip / merge 记录
retry_of 处理
```

如果用户重跑 `/upy-scaffold-plugin`，宿主可能直接覆盖已有 `firmware/main.py`、`project-manifest.json` 等文件。后续 generate 阶段或用户手工修改后，风险更高。

建议：

```text
首次 scaffold：允许写入空 project_root。
重试 scaffold：根据 idempotency_key 和 file hash 判断是否重复写入。
如果目标文件已存在且 hash 不同：默认不覆盖，必须进入 approval_request 或 conflict report。
```

建议 manifest：

```json
{
  "file_manifest": {
    "root": "<project_root>",
    "files": [
      {
        "path": "firmware/main.py",
        "status": "created",
        "sha256": "...",
        "overwrite": false
      }
    ]
  }
}
```

### 11. 权限提示/审批结果没有结构化沉淀

本阶段涉及：

```text
file write
script_run(init_scaffold.py)
script_run(flake8)
```

但最终 phase_complete 没有记录用户是否批准写文件、是否批准运行脚本、审批 ID、审批时间等。

这与之前总体目标中的 permission prompts、cancellation/retry/timeout/error reporting 要求不完全对齐。

建议：

```json
{
  "permissions": [
    {"type": "script_run", "command": "init_scaffold.py", "approved": true},
    {"type": "file_operation", "root": "<project_root>", "approved": true},
    {"type": "script_run", "command": "python -m flake8 firmware tools", "approved": true}
  ]
}
```

### 12. cancellation / timeout / retry 没有本次 mock 覆盖痕迹

当前日志只覆盖成功路径，没有看到 mock protocol 对以下场景的记录：

```text
cancellation
retry
timeout
idempotency
partial failure
```

这不影响本次成功，但不满足之前规划里的本地测试样例目标。

建议在后续最小修改中补：

```text
test/mock_protocol_cases.py 或扩展 run_local_actual_project.py
覆盖 cancellation/retry/timeout/idempotency 的本地 mock 行为
```

### 13. phase_complete.payload.phase 与顶层 phase 命名需要固定解释

当前：

```json
{
  "phase": "upy-scaffold-plugin",
  "payload": {
    "phase": "scaffold"
  }
}
```

这不一定错误，但需要在协议里明确：

```text
top-level phase = plugin phase id
payload.phase = domain phase name
```

否则后续插件可能误判上游阶段。

建议：

```text
保留也可以，但必须在 SKILL.md 中明确。
或者 payload 中改用 scaffold_phase/domain_phase，避免与 envelope phase 重名。
```

### 14. flash 阶段没有向 scaffold 传递 manifest_content，导致 scaffold 需要回读 select_hw 文件

`phase_complete.upy_flash_mpy_firmware_plugin.json` 有 `source_phase_complete_path` 和 `payload.firmware`，但没有 `payload.manifest_content`。

scaffold 因此只能回读：

```text
sessions/<id>/select_hw_validated.json
```

这导致 flash 阶段新增事实没有自然进入 manifest。

建议两种做法二选一：

```text
方案 A：flash phase_complete 携带更新后的 manifest_content。
方案 B：scaffold 读取 flash phase_complete，并把 payload.firmware 合并到 select_hw manifest。
```

更推荐方案 A，因为每个阶段完成时都应输出当前完整 manifest_content，后续阶段只消费上游 phase_complete 即可。

## 补充后的优先级建议

| 优先级 | 问题 | 建议处理 |
|---|---|---|
| P0 | project_root / session_root 不清晰 | 必须改 |
| P0 | phase_complete 缺少 project_root、lint.cwd、file_operation_root | 必须改 |
| P0 | file_list 全部 pending 但实际已写入 | 必须改 |
| P0 | flash 固件事实未合并进 scaffold manifest | 必须改 |
| P1 | MicroPython 版本注释硬编码 v1.23.0 | 应改 |
| P1 | Timer 与 voice_control/WiFi 风险未进入 warnings | 应改 |
| P1 | 时间戳疑似手写固定值 | 应改 |
| P1 | 日志项目结构与实际文件列表不一致 | 应改 |
| P1 | warning 暴露绝对本机路径 | 应改 |
| P2 | retry/idempotency/hash/overwrite 记录不足 | 后续补强 |
| P2 | cancellation/timeout mock 覆盖不足 | 后续补强 |
| P2 | envelope phase 与 payload.phase 命名歧义 | 文档或字段名修正 |

## 总体判断

这次 scaffold 成功路径本身能跑通，flake8 也返回 0；真正的问题主要不在生成代码语法，而在“插件协议闭环”和“后续阶段可消费性”：

```text
1. 项目源码写在哪里不够明确。
2. 最终 phase_complete 没有准确表达实际落盘状态。
3. 固件阶段事实没有合并进项目 manifest。
4. lint、审批、权限、重试、文件 hash 等关键运行事实没有结构化记录。
5. 日志摘要和实际产物列表存在分叉。
```

因此后续修改不应只是把输出路径改到 `session/project`，还应同步修正最终 phase_complete 的 runtime_context、file_manifest、lint、source、approval、warnings 和 manifest 合并策略。
