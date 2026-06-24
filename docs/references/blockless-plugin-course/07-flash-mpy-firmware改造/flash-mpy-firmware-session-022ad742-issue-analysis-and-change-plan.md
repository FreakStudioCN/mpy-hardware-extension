# upy-flash-mpy-firmware-plugin 真实 session 问题分析与修改计划

分析对象：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`

重点文件：

- `flash_mpy_firmware_phase_log.md`
- `phase_complete.select_hw.json`
- `firmware_page_resolved.json`
- `firmware_download.json`
- `flash_esp32_log.json`
- `flash_mpy_firmware_state.json`
- `phase_complete.upy_flash_mpy_firmware_plugin.json`

## 结论

这次 session 的核心烧录流程是成功的，不是固件解析、下载或 esptool 烧录失败。

实际成功点：

- 从上游 `phase_complete.select_hw.json` 读取到 ESP32-C3 板卡事实。
- 使用 `https://micropython.org/download/ESP32_GENERIC_C3/` 解析到真实 latest 固件。
- latest 固件为 `ESP32_GENERIC_C3-20260406-v1.28.0.bin`，版本 `v1.28.0`，日期 `2026-04-06`。
- 从 MicroPython 页面解析到 ESP32-C3 写入偏移 `write_offset=0`，不是硬编码。
- 固件下载成功，路径为 `sessions/.../firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin`。
- live 串口扫描发现 `COM88`。
- esptool v4.11.0 成功执行 erase + write。
- 写入后 hash 校验通过。
- 当前 `phase_complete.upy_flash_mpy_firmware_plugin.json` 能通过增强后的 `validate-phase-complete` 校验。

当前真正需要关注的问题只有两个：

1. 上游 select-hw 仍输出旧的 `next_phase=flash-mpy-firmware`。
2. `flash_mpy_firmware_state.json` 的结构不符合当前 state schema。

另外一些看起来像问题的点，例如没有 approval 文件、没有 `esptool_plan.json`、调试日志未进入 artifacts、本机 COM/MAC/路径没有脱敏，当前都不是必须修改项。

## 问题 1：上游 next_phase 仍是旧值

### 现象

`phase_complete.select_hw.json` 中：

```json
"next_phase": "flash-mpy-firmware"
```

当前 flash skill 的正式阶段名是：

```json
"next_phase": "upy-flash-mpy-firmware-plugin"
```

所以直接运行：

```bash
python flash_mpy_firmware_manifest.py --validate-upstream --input phase_complete.select_hw.json
```

会失败，错误为：

```text
upstream payload.next_phase must be upy-flash-mpy-firmware-plugin
```

但加上迁移兼容参数后可以通过：

```bash
python flash_mpy_firmware_manifest.py --validate-upstream --input phase_complete.select_hw.json --allow-legacy-next-phase
```

### 原因分析

这个问题不是本次 `upy-flash-mpy-firmware-plugin` 修改引起的。

原因是该 session 的 `phase_complete.select_hw.json` 生成时间较早，仍使用历史阶段名 `flash-mpy-firmware`。后来新 skill 确定名称为 `upy-flash-mpy-firmware-plugin`，flash skill 的校验器为了兼容历史 session，保留了 `--allow-legacy-next-phase`。

也就是说：

- 旧 session / 旧 select-hw 输出：`flash-mpy-firmware`
- 新 flash skill 标准：`upy-flash-mpy-firmware-plugin`
- 当前日志中使用 `--allow-legacy-next-phase` 是合理的迁移兼容。

### 是否需要现在修改

不建议这次修改 `upy-select-hw-plugin`。

原因：

- 用户前面明确要求不要随意改其他 skill。
- 当前 flash skill 已能通过兼容参数处理旧 session。
- 这个问题不影响本次实际烧录成功。
- 如果现在改 select-hw，会扩大修改范围，并且需要同步更新 select-hw 的 sample/test/校验脚本。

### 后续建议

短期：继续在旧 session、本地回放、历史样例中允许 `--allow-legacy-next-phase`。

中期：当明确要更新 `upy-select-hw-plugin` 时，再统一把输出改为：

```json
"next_phase": "upy-flash-mpy-firmware-plugin"
```

并同步更新 select-hw 的：

- `SKILL.md`
- sample
- test
- `select_hw_manifest.py`
- 课程文档中的阶段名说明

## 问题 2：flash_mpy_firmware_state.json 不符合 state schema

### 现象

当前 `flash_mpy_firmware_state.json`：

```json
{
  "protocol_version": "1.0",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "upy-flash-mpy-firmware-plugin",
  "status": "phase_complete",
  "firmware_action": "download_and_flash",
  "board_name": "ESP32_GENERIC_C3",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
  "firmware_url": "https://micropython.org/resources/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
  "firmware_file": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
  "serial_port": "COM88",
  "chip": "esp32c3",
  "flash_result": "success"
}
```

当前校验器要求：

- 必须有 `source_phase_complete_path`。
- `status` 必须是以下值之一：
  - `in_progress`
  - `partial`
  - `success`
  - `failed`
  - `cancelled`

因此校验失败：

```text
missing state field source_phase_complete_path
state status must be in_progress, partial, success, failed, or cancelled
state source_phase_complete_path must be a relative path
```

### 原因分析

这个问题不是上次 artifact 增强校验导致的。

`validate_state()` 在当前脚本中本来就要求：

```text
protocol_version
session_id
phase
status
source_phase_complete_path
```

并且本来就限制 `status` 枚举。

本次真实运行生成的 state 更像是一个简化的调试状态摘要，而不是严格协议 state：

- `status="phase_complete"` 混用了“阶段完成事件名”和“状态枚举”。
- `firmware_action`、`board_name`、`board_url` 等字段直接平铺在顶层。
- 缺少 `source_phase_complete_path`，导致无法从 state 反查上游输入。
- `flash_result` 只是字符串 `success`，没有保留和 `phase_complete.payload.firmware.flash_result` 一致的结构。

这说明真实运行时写 state 的方式和校验脚本/sample 中的 state schema 还没有统一。

### 影响范围

不影响已经完成的 ESP32 烧录，也不影响最终 `phase_complete`。

影响的是：

- checkpoint/resume 机制不够可靠。
- 后续如果要从 `flash_mpy_firmware_state.json` 恢复流程，信息结构不够规范。
- 自动化测试如果加入 state 校验，会失败。
- 插件侧如果依赖 state 做恢复、重试、取消、超时处理，会缺少稳定字段。

### 建议的标准 state 结构

成功完成时建议写成：

```json
{
  "protocol_version": "1.0",
  "msg_id": "<uuid>",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "upy-flash-mpy-firmware-plugin",
  "status": "success",
  "timestamp": "<runtime-utc-now>",
  "type": "state",
  "source_phase_complete_path": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/phase_complete.select_hw.json",
  "payload": {
    "phase": "upy-flash-mpy-firmware-plugin",
    "firmware_action": "download_and_flash",
    "board_name": "ESP32_GENERIC_C3",
    "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
    "download_slug": "ESP32_GENERIC_C3",
    "chip_family": "esp32c3",
    "firmware_file": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin",
    "firmware_version": "v1.28.0",
    "firmware_date": "2026-04-06",
    "file_type": "bin",
    "serial_port": "COM88",
    "flash_result": {
      "tool": "esptool",
      "tool_version": "4.11.0",
      "port": "COM88",
      "baud": 460800,
      "write_offset": "0",
      "erased_first": true,
      "chip": "esp32c3",
      "log": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/flash_esp32_log.json"
    }
  }
}
```

如果是等待用户操作或只下载不烧录，则使用：

```json
"status": "partial"
```

并补充：

```json
"checkpoint": {
  "resume_step": "confirm_esp32_flash",
  "reason": "download_only",
  "state_file": "sessions/<session_id>/flash_mpy_firmware_state.json"
}
```

## 不是必须修改的问题

### 1. flash_mpy_firmware_phase_log.md 未进入 artifacts

这不是问题。

该文件用于本机调试和复盘完整流程，不是正式协议产物。前面已经确认不要求写入 `phase_complete.payload.artifacts`。

当前 `SKILL.md` 应明确：

- 可以生成 `flash_mpy_firmware_phase_log.md`。
- 它是调试日志。
- 不强制进入 artifacts。

### 2. 没有 approval_request / approval_response 文件

当前不是必须问题。

日志中已经记录：

- 用户选择 `download_and_flash`
- 用户确认 `flash_now`
- 串口 `COM88`

如果 V0 只要求流程跑通，可以不落 approval 文件。

将来如果要强化恢复、审计、重试、取消、超时，则可以新增：

- `approval_request.firmware_action_select.json`
- `approval_response.firmware_action_select.json`
- `approval_request.esp32_flash_confirm.json`
- `approval_response.esp32_flash_confirm.json`

但这会增加运行产物数量和校验复杂度，不建议现在作为必改项。

### 3. 没有 esptool_plan.json

当前不是必须问题。

`flash_esp32_log.json` 已保存实际命令、执行结果和烧录输出。对于本次成功烧录已经足够。

如果后续要实现更严格的“先 plan-only 展示命令，再 execute 执行”，可以单独增加 `esptool_plan.json`。但当前不建议把它作为强制项，否则会让 V0 流程变重。

### 4. manifest_content 为 null

当前 `phase_complete.upy_flash_mpy_firmware_plugin.json` 中：

```json
"manifest_content": null
```

这不是当前失败原因。

最终输出的关键事实在：

```json
payload.firmware
```

后续 `upy-scaffold-plugin` 更应该读取 `payload.firmware` 和上游 select-hw manifest，而不是依赖 flash 阶段的 `manifest_content`。

因此暂不建议把 `manifest_content` 设为必填。

### 5. 本机路径、COM88、MAC/USB 信息没有脱敏

用户已经确认无需脱敏。

这些信息只在本机真实测试 session 中出现，可以保留用于调试。

## 是否由上次修改引起

总体判断：不是。

上次改动主要包括：

- `firmware_download.py` 输出路径统一为 `/`。
- `phase_complete` artifact 校验增强，要求 `firmware.file` 和 `flash_result.log` 必须声明。
- sample/test 增加 ESP32-C3 和 C5 offset 对照。
- `SKILL.md` 明确调试日志不是必须 artifact。

当前 session 反而说明上次修复是有效的：

- `firmware_download.json` 中 `downloaded_path` 已经是 `/` 路径。
- `phase_complete` 已声明固件文件。
- `phase_complete` 已声明 `flash_esp32_log.json`。
- `validate-phase-complete` 通过。

当前剩余问题主要来自两个历史/运行时口径：

1. select-hw 的旧 next_phase。
2. flash 阶段运行时 state 文件写法没有按 schema 输出。

其中第 1 个是上游旧产物问题；第 2 个是本 skill 实际运行指引/样例不够明确，导致 LLM 或插件生成了简化 state。

## 修改计划

### 必改 1：明确 state 文件格式

修改 `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md`：

- 增加 `flash_mpy_firmware_state.json` 成功态示例。
- 明确 `status` 只能使用：
  - `in_progress`
  - `partial`
  - `success`
  - `failed`
  - `cancelled`
- 明确禁止使用 `status="phase_complete"`。
- 明确必须写入 `source_phase_complete_path`。
- 建议将阶段详情放入 `payload`，不要全部平铺在顶层。

### 必改 2：补充 state sample/test

修改 `sample/flash_mpy_firmware_state.esp32_c5.json` 或新增 `sample/flash_mpy_firmware_state.esp32_c3_success.json`：

- 使用真实成功态结构。
- 覆盖 `status="success"`。
- 覆盖 `source_phase_complete_path`。
- 覆盖 `payload.flash_result.log`。

修改 `test/smoke_tests.py`：

- 增加成功态 state sample 校验。
- 增加禁止 `status="phase_complete"` 的负向测试，确保之后不会再写回这个旧格式。

### 必改 3：小幅增强 validate_state

当前 `validate_state` 已能发现问题，但可以让错误更明确：

- 当 `status="phase_complete"` 时，输出更明确的提示：应使用 `status="success"`，阶段完成事件由 `type="phase_complete"` 表达。
- 如果存在顶层 `firmware_file`、`serial_port`、`flash_result`，可以给 warning 或 error，提示应放入 `payload`。

建议先只做明确错误提示，不强行禁止顶层字段，避免影响旧 session 回放。

### 暂不改 1：select-hw next_phase

暂时不修改 `upy-select-hw-plugin`。

保留 flash 校验器的：

```bash
--allow-legacy-next-phase
```

用于旧 session 兼容。

等后续明确要更新 select-hw 时，再统一修改上游阶段名。

### 暂不改 2：approval 文件和 esptool_plan.json

当前不强制新增。

原因：

- 本次问题不由它们导致。
- 加入后会扩大 sample/test/schema 修改范围。
- V0 只需要保证 ESP32/Pico 固件流程可跑通。

后续如果要实现完整 checkpoint/resume 审计，再作为第二轮增强。

## 推荐本轮最小修改范围

只改 `upy-flash-mpy-firmware-plugin`，不改其他 skill。

建议修改文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\flash_mpy_firmware_state.esp32_c5.json
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\test\smoke_tests.py
```

可选新增：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\flash_mpy_firmware_state.esp32_c3_success.json
```

不建议本轮修改：

```text
G:\MicroPython_Skills\upy-select-hw-plugin
G:\MicroPython_Skills\upy-analyze-plugin
```

## 修改后验证

执行：

```bash
python upy-flash-mpy-firmware-plugin\test\smoke_tests.py
python C:\Users\Administrator\.codex\skills\.system\skill-creator\scripts\quick_validate.py G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin
python upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py --validate-state --input <state-sample.json>
python upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py --validate-phase-complete --input <phase-complete.json> --artifact-root <artifact-root>
```

如果使用旧 select-hw session，继续验证：

```bash
python upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py --validate-upstream --input phase_complete.select_hw.json --allow-legacy-next-phase
```

## 最终建议

本轮只修 state schema 表达问题。

不要把调试日志、approval 文件、plan 文件、本机脱敏、select-hw 阶段名迁移一起做，否则会把一个很小的实际问题扩大成多 skill 联动修改。
