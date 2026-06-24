# upy-flash-mpy-firmware-plugin session 报错分析与修改计划

分析对象：

- `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`
- `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\flash_mpy_firmware_phase_log.md`
- `C:\Users\Administrator\.claude\projects\G--test-test` 中相关 Claude 日志

本文件只记录问题原因和后续修改计划，不代表已经修改 skill。

## 当前 session 状态

当前 session 的最终 flash 阶段产物整体可用：

- `flash_mpy_firmware_state.json` 通过当前 `validate-state` 校验。
- `phase_complete.upy_flash_mpy_firmware_plugin.json` 通过当前 `validate-phase-complete` 校验。
- `phase_complete.select_hw.json` 严格上游校验失败，原因是旧字段 `payload.next_phase = "flash-mpy-firmware"`；使用 `--allow-legacy-next-phase` 后通过。这属于上游旧协议兼容问题，不是当前 flash 输出损坏。
- `flash_mpy_firmware_phase_log.md` 是调试日志，不是必须产物；它不需要写入最终 `phase_complete.payload.artifacts`。
- `flash_mpy_firmware_phase_log.md` 和 JSON 中的中文内容需要用 UTF-8 读取。若用 Windows 默认 GBK 读取，会显示乱码或触发解码错误。

## 聊天中报错原因

### 1. `payload.artifacts must be an array`

Claude 日志显示，当时中间版本曾把 `payload.artifacts` 写成对象：

```json
"artifacts": {
  "file_list": [
    {"path": "sessions/.../firmware_page_resolved.json"}
  ]
}
```

当前校验器要求的结构是数组，数组里包含一个 `type = "file_list"` 的 artifact group：

```json
"artifacts": [
  {
    "type": "file_list",
    "title": "upy-flash-mpy-firmware-plugin 产物",
    "files": [
      {"path": "sessions/.../firmware_page_resolved.json", "status": "created"}
    ]
  }
]
```

所以这个报错不是最终文件仍然错误，而是执行过程中有过不合约的中间 `phase_complete`。

### 2. `firmware.file must be declared...` 和 `firmware.flash_result.log must be declared...`

这两个错误是 artifacts 结构错误的连锁反应。

日志里还出现过另一种中间结构：

```json
"artifacts": [
  {"path": "sessions/.../firmware.bin", "status": "created"},
  {"path": "sessions/.../flash_esp32_log.json", "status": "created"}
]
```

虽然它是数组，但它是“扁平文件数组”，没有包在 `type = "file_list"` 的对象里。当前校验器只收集：

```json
"artifacts": [
  {
    "type": "file_list",
    "files": [...]
  }
]
```

因此扁平数组中的路径不会进入 declared artifact set，导致 `firmware.file` 和 `firmware.flash_result.log` 被认为没有声明。

当前最终 `phase_complete.upy_flash_mpy_firmware_plugin.json` 已经使用正确的 `file_list` 结构，并且校验通过。

### 3. `UnicodeDecodeError: 'gbk' codec can't decode...`

日志中的命令类似：

```bash
python -c "import json; d=json.load(open('...phase_complete...json')); ..."
```

在 Windows 上，Python 默认编码经常是 GBK。当前 JSON 文件含中文，实际是 UTF-8，因此必须显式指定编码：

```python
open(path, encoding="utf-8")
```

或在运行环境中启用 UTF-8 模式，例如设置 `PYTHONUTF8=1`。

这个错误不是 JSON 文件损坏，而是临时 Python one-liner 的读取方式不正确。

### 4. `Invalid tool parameters`

Claude 日志显示，`AskUserQuestion` 工具限制每个问题最多 4 个 options。当前 skill 的插件协议 `approval_request.actions` 有 6 个动作：

- `download_and_flash`
- `download_only`
- `already_flashed`
- `use_local_firmware`
- `save_partial`
- `cancel`

这 6 个动作适合插件 UI 的 `approval_request`，但不能直接塞进 Claude Code 的 `AskUserQuestion`。直接映射会触发：

```text
Too big: expected array to have <=4 items
```

本地 Claude Code 运行时应只展示 4 个主动作：

- 下载并烧录
- 只下载固件
- 我已自行烧录，跳过
- 使用本地固件文件

`save_partial` 和 `cancel` 可以通过二次确认、自由文本、或插件正式 approval UI 处理。

### 5. `firmware_download.py` 缺少 `--out-dir`

聊天中出现过：

```text
firmware_download.py: error: the following arguments are required: --out-dir
```

原因是当时 Claude 调用脚本时用了错误参数，漏了 `--out-dir`。当前正确形式是：

```text
firmware_download.py --resolved-json <resolved.json> --out-dir <firmware_dir> --output-json <download.json>
```

当前脚本已经兼容 `--output-json` 和 `--out-json` 两种输出参数，但 `--out-dir` 仍是必填输入，不应该省略。

### 6. `list_serial_ports.py` 不识别 `--out-json`

聊天中出现过：

```text
list_serial_ports.py: error: unrecognized arguments: --out-json .../serial_ports.json
```

这是旧脚本参数兼容性不足引起。当前仓库里的 `list_serial_ports.py` 已经支持：

```text
--output-json
--out-json
```

因此这是已修复过的问题，但 SKILL.md 里仍应强调 canonical 参数优先使用 `--output-json`，别名只作为容错。

## 当前 session 的小问题

### 1. summary 中 board name 有拼写不一致

当前最终文件的 summary 写成：

```text
ESP32_C3_GENERIC
```

真实 MicroPython board name 是：

```text
ESP32_GENERIC_C3
```

这不影响校验，但如果这个 session 要作为标准样例保留，建议修正 summary 文案。

### 2. `esptool_bootstrap.json` 未声明为 artifact

目录里存在：

```text
esptool_bootstrap.json
```

但最终 `phase_complete.payload.artifacts` 没有声明它。当前校验不会失败，因为它没有被 `firmware.file`、`firmware.flash_result.log` 或 checkpoint 引用。

处理建议二选一：

- 如果把它视为正式产物，就加入 `payload.artifacts[0].files`。
- 如果只把它视为本地辅助调试文件，则不必加入 artifacts，但 SKILL.md 要明确这类 bootstrap/debug 文件是否必须声明。

### 3. `resource_root` 口径略不一致

最终 JSON 中：

```json
"resource_root": "C:\\Users\\Administrator\\.claude\\skills"
```

调试日志中写的是具体 skill 目录：

```text
C:\Users\Administrator\.claude\skills\upy-flash-mpy-firmware-plugin
```

当前校验器只要求 `resource_root` 非空，不检查具体口径。建议后续在文档里统一：

- `resource_root` 表示 skills 根目录；脚本路径用 `resource_root/upy-flash-mpy-firmware-plugin/scripts/...`。
- 或 `resource_root` 表示当前 skill 根目录；脚本路径用 `resource_root/scripts/...`。

二者不要混用。

## 最小修改计划

等待确认后，建议只做以下最小修改。

### 1. 修改 `upy-flash-mpy-firmware-plugin/SKILL.md`

新增 “Claude Code 本地运行注意事项” 小节：

- 插件协议 `approval_request.actions` 可以有 6 个动作，但 Claude Code 的 `AskUserQuestion` 每题最多 4 个 options。
- Claude Code 本地运行时，`firmware_action_select` 只展示 4 个主动作：`download_and_flash`、`download_only`、`already_flashed`、`use_local_firmware`。
- `save_partial` 和 `cancel` 在插件 approval UI 中保留；本地 Claude Code 可通过二次确认或普通对话处理。
- Windows 下临时 Python one-liner 读取 JSON 必须显式 `encoding="utf-8"`。
- `firmware_download.py` 必须传 `--out-dir`。
- `phase_complete.payload.artifacts` 必须是 `[{"type":"file_list", "files":[...]}]`，不能是对象，也不能是扁平文件数组。

### 2. 增强 `scripts/flash_mpy_firmware_manifest.py` 错误提示

当前校验器对 artifacts 的错误提示偏泛化。建议增加更定向的提示：

- 如果 `payload.artifacts` 是对象并包含 `file_list`：提示“不要写成 `{file_list: [...]}`，必须写成数组中的 `type=file_list` 对象”。
- 如果 `payload.artifacts` 是扁平文件数组：提示“每个文件必须放进 `artifacts[].files`，外层 artifact 需要 `type=file_list`”。
- 这样可以减少后续 Claude 看到 missing declared artifact 后误判。

### 3. 补充 smoke test

在 `upy-flash-mpy-firmware-plugin/test/smoke_tests.py` 增加两个小测试：

- `phase_complete_rejects_object_artifacts_with_clear_error`
- `phase_complete_rejects_flat_artifacts_with_clear_error`

目的不是放宽协议，而是保证报错更清楚，防止同类中间文件再次难以定位。

### 4. 是否修当前 session，单独确认

如果 `022ad742-3269-42e9-ac20-c14f477ecdf2` 要作为“当前标准样例”保留，建议修：

- summary 中 `ESP32_C3_GENERIC` 改为 `ESP32_GENERIC_C3`。
- 决定 `esptool_bootstrap.json` 是否加入 artifacts。
- 统一 `resource_root` 口径。

如果它只是调试记录，则可以不改 session，只修 skill 文档、校验器和测试。

## 建议优先级

1. 先修 SKILL.md 的本地运行注意事项和 artifacts 结构说明。
2. 再修 manifest 校验器的错误提示。
3. 再补 smoke test。
4. 最后再决定是否整理当前 session 样例。
