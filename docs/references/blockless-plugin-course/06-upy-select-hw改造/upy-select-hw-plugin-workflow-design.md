# upy-select-hw-plugin 工作流插件版改造设计

本文用于说明后续如何编写 `upy-select-hw-plugin`。本阶段只更新课程设计文档，不在 `G:\MicroPython_Skills\upy-select-hw-plugin` 下创建文件。

本轮已重新加载并核对：

- `G:\MicroPython_Skills\upy-analyze-plugin`
- `G:\MicroPython_Skills\upy-select-hw`
- `G:\blockless-plugin-course(1)\02-架构分析`
- `G:\blockless-plugin-course(1)\03-Skill接口`
- `G:\test\test` 真实测试输出目录

## 1. 核心结论

`upy-select-hw-plugin` 不是把原 `upy-select-hw/SKILL.md` 原样复制到插件目录，而是要把它改造成长期工作流协议里的 `select-hw` phase。

它的输入不再是“直接读取本地 `project-manifest.json`”，而是上游 `upy-analyze-plugin` 的阶段产物：

```text
phase_complete(analyze).payload.manifest_content
```

它的完成标准不再是“脚本写盘成功”，而是：

```text
phase_complete(select-hw).payload.manifest_content
```

目标链路：

```text
upy-analyze-plugin
  -> phase_complete.analyze.json / manifest_content
  -> upy-select-hw-plugin
  -> board_select / firmware_check / pin_assignment / BOM
  -> script_run(select_hw_manifest.py)
  -> phase_complete.select_hw.json
  -> MPY 固件烧录 phase
```

注意：`select-hw` 成功后的 `next_phase` 已确认不再写 `scaffold` 或 `generate`，而是固定指向“对应 MCU 的 MicroPython 固件烧录步骤”。当前这个烧录 skill 还没有补齐，因此 V0 文档可先使用占位 phase 名：

```text
flash-mpy-firmware
```

后续新增真实 skill 时，再把占位名统一替换为实际 phase 名。

## 2. upy-analyze-plugin 当前真实产物

### 2.1 upy-analyze-plugin 目录内样例文件

`upy-analyze-plugin` 自带 sample 文件如下：

```text
upy-analyze-plugin/sample/start_phase.analyze.json
upy-analyze-plugin/sample/approval_request.device_confirm.json
upy-analyze-plugin/sample/approval_request.requirement_supplement.json
upy-analyze-plugin/sample/approval_request.alternative_device.json
upy-analyze-plugin/sample/phase_complete.analyze.success.json
upy-analyze-plugin/sample/phase_complete.analyze.cold_driver.json
upy-analyze-plugin/sample/README.md
```

这些 sample 用于说明协议形状，但当前真实 Claude Code 直测产物更完整，应优先参考 `G:\test\test`。

### 2.2 G:\test\test 当前真实产物

当前测试目录采用 session 隔离：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\
```

该 session 下实际存在 5 个产物文件：

```text
manifest_draft.json
manifest_validated.json
phase_complete.analyze.json
driver_search_log.md
analyze_phase_log.md
```

含义如下：

| 文件 | 含义 | select-hw 是否直接消费 |
| --- | --- | --- |
| `manifest_draft.json` | analyze 校验前草稿 | 否，只作排查参考 |
| `manifest_validated.json` | `init_manifest.py` 校验/规范化后的 analyze manifest | 可作为直测 fallback，但正式链路仍以 phase_complete 为准 |
| `phase_complete.analyze.json` | 完整 analyze 阶段完成消息，含 `manifest_content` | 是，select-hw 首选输入 |
| `driver_search_log.md` | 驱动搜索过程记录 | 否，只作排查参考 |
| `analyze_phase_log.md` | Claude Code 直测完整过程日志 | 否，只作排查参考 |

当前 `phase_complete.analyze.json` 的 `artifacts.file_list` 声明了前 4 个文件：

```text
manifest_draft.json
manifest_validated.json
phase_complete.analyze.json
driver_search_log.md
```

`analyze_phase_log.md` 实际存在，并在日志的“产物文件”表格中出现，但当前 `phase_complete.analyze.json` 的 `file_list` 尚未声明它。后续可以允许声明，但 select-hw 不应依赖这个文件。

### 2.3 phase_complete.analyze.json 的完整 envelope

真实 `phase_complete.analyze.json` 使用完整消息信封：

```json
{
  "protocol_version": "1.0",
  "msg_id": "8a3f2c71-b5d4-4e1a-9f6c-0d8e3a7b2c11",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "analyze",
  "timestamp": "2026-06-21T06:50:00Z",
  "type": "phase_complete",
  "payload": {
    "phase": "analyze",
    "result": "success",
    "next_phase": "select-hw",
    "manifest_content": {},
    "artifacts": [],
    "warnings": [],
    "errors": [],
    "structured_errors": []
  }
}
```

`select-hw` 必须继承同一个 `session_id`，不得新建正式 session。`msg_id` 每条消息重新生成，`phase` 改为 `select-hw`。

### 2.4 analyze manifest 当前真实字段

真实 `manifest_content` 已包含：

```text
schema_version = "1.0"
phase = "analyze"
project_name
requirements
devices
final_status = "pending"
```

真实测试中的 `requirements` 包含：

```text
description
scene
power
network
sample_rate
precision
response_time
temp_range
size_constraint
budget_yuan
experience
output
existing_hardware
special_requirements
mcu_specified
```

真实测试中的 `mcu_specified` 是：

```text
ESP32-C3
```

这里已确认：`requirements.mcu_specified` 表示 MCU/芯片/模组型号，不等于具体开发板型号。因此 `select-hw` 必须弹出 `board_select`，除非 `pre_selected_board` 已经来自插件 UI 并且可信。

## 3. 相对路径约定

后续插件实现里的所有现有文件加载都应使用相对路径，因为相关 skill 都在同一个仓库根目录 `G:\MicroPython_Skills` 下。

建议用仓库根作为路径基准：

```text
upy-analyze-plugin/boards
upy-analyze-plugin/sample/phase_complete.analyze.success.json
upy-analyze-plugin/scripts/init_manifest.py
upy-select-hw/SKILL.md
upy-select-hw/scripts/update_manifest.py
upy-select-hw-plugin/SKILL.md
upy-select-hw-plugin/scripts/select_hw_manifest.py
```

不要在 `SKILL.md` 或脚本接口里硬编码：

```text
G:\MicroPython_Skills\...
```

如果脚本需要定位资源，应通过：

```text
repo_root / "upy-analyze-plugin" / "boards"
repo_root / "upy-select-hw-plugin" / "scripts"
```

或者由 runner 显式传入 `--repo-root`。

## 4. 板卡数据处理

已确认：V0 允许直接复用 `upy-analyze-plugin/boards`。

注意：这里必须用相对路径读取板卡资源：

```text
upy-analyze-plugin/boards
```

不是硬编码绝对路径。

当前可用板卡资源包括：

```text
upy-analyze-plugin/boards/esp32-c3-devkitm.json
upy-analyze-plugin/boards/esp32-devkit-v1.json
upy-analyze-plugin/boards/esp32-s3-devkitc.json
upy-analyze-plugin/boards/esp8266-nodemcu.json
upy-analyze-plugin/boards/m5stack-core.json
upy-analyze-plugin/boards/raspberry-pi-pico-w.json
upy-analyze-plugin/boards/raspberry-pi-pico.json
upy-analyze-plugin/boards/matching-rules.json
upy-analyze-plugin/boards/_template.json
```

处理策略：

1. `requirements.mcu_specified` 是 MCU/模组型号时，按板卡资源里的 `mcu`、`chip_family`、`firmware.board_name` 做候选匹配。
2. 匹配到候选后必须走 `approval_request(board_select)`。
3. 如果 `pre_selected_board` 已经来自插件 UI，可跳过 `board_select`，但仍要记录跳过原因并校验该 board 是否存在固件和 pin_layout。
4. 如果候选板卡缺少 `pin_layout`，默认行为不是让用户上传引脚图，而是推荐/切换到功能类似且有 `pin_layout` 的已知板卡。
5. 如果所有功能类似板卡都缺 `pin_layout`，才输出 `partial + checkpoint`，等待后续补资料。

## 5. upy-select-hw-plugin 应放哪些文件

已确认：后续实际实现时，`SKILL.md` 放到插件目录根部：

```text
upy-select-hw-plugin/SKILL.md
```

不用单独为了 SKILL 再建子文件夹。

建议 V0 目录结构：

```text
upy-select-hw-plugin/
  SKILL.md
  .skillfish.json
  .codex-plugin/plugin.json          # 如果需要 Codex 插件 manifest，再补
  scripts/
    select_hw_manifest.py
  sample/
    start_phase.select_hw.json
    analyze_phase_complete.input.json
    approval_request.board_select.json
    phase_complete.select_hw.success.json
    phase_complete.select_hw.partial.json
    select_hw_manifest.after.json
  test/
    select_hw_runner.py
    mock_plugin.py
    run_local_mock_session.py
    smoke_tests.py
```

本文件只是设计说明，本轮不创建这些文件。

## 6. 长期工作流协议必须从设计之初支持

`select-hw` 不应只做一个短期消息格式。它从 V0 开始就要按长期工作流协议设计，至少支持以下能力。

### 6.1 协议信封字段

| 字段 | 类型 | 必填 | 含义 | 校验 |
| --- | --- | --- | --- | --- |
| `protocol_version` | string | 是 | 协议版本，V0 固定为 `"1.0"` | 必须等于支持版本 |
| `msg_id` | string | 是 | 当前消息 UUID | UUID 格式 |
| `session_id` | string | 是 | 会话 ID，由插件创建，phase 继承 | 非空；正式模式必须来自 start_phase |
| `phase` | string | 是 | 当前 phase，select-hw 阶段固定 `"select-hw"` | 顶层与 payload.phase 一致 |
| `timestamp` | string | 是 | UTC ISO 时间 | 可解析为时间 |
| `type` | string | 是 | 消息类型 | 枚举校验 |
| `idempotency_key` | string | 建议 | 幂等键，用于 retry 去重 | 同一动作重试保持不变 |
| `retry_of` | string/null | 可选 | 本消息重试自哪个 msg_id | 若存在必须引用旧 msg_id |
| `capabilities` | object | 可选 | 插件/宿主声明的能力 | 按 capability schema 校验 |

`type` 枚举：

```text
start_phase
status_update
approval_request
approval_response
script_run
script_result
file_operation
file_result
device_command
device_result
phase_complete
```

### 6.2 session ID

规则：

- 正式插件模式：`session_id` 由插件创建。
- skill/server 不创建新的正式 session，只继承。
- Claude Code 直测模式：允许缺失时生成 UUID，但必须在日志里说明这是直测 session。
- 所有直测产物必须写入 session 目录：

```text
sessions/<session_id>/...
```

### 6.3 checkpoint/resume

`partial` 必须带 checkpoint。

checkpoint 最小结构：

```json
{
  "checkpoint_id": "uuid",
  "resume_phase": "select-hw",
  "resume_step": "board_select",
  "resume_label": "继续选择 MicroPython 开发板",
  "reason": "user_cancelled",
  "state_ref": {
    "artifact": "select_hw_draft.json"
  }
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `checkpoint_id` | 唯一 checkpoint ID |
| `resume_phase` | 恢复时进入的 phase，固定 `select-hw` |
| `resume_step` | 恢复步骤，例如 `board_select / pin_assignment / manifest_validation` |
| `resume_label` | UI 上给用户看的恢复动作名称 |
| `reason` | 产生 checkpoint 的原因 |
| `state_ref` | 可选，指向直测或 artifact 中保存的状态 |

`resume_step` 枚举：

```text
load_upstream_manifest
board_select
firmware_check
pin_assignment
bom_generation
manifest_validation
phase_complete_validation
```

`reason` 枚举：

```text
user_cancelled
missing_pin_layout
firmware_unknown
pin_conflict
script_failed
timeout
permission_denied
```

### 6.4 cancellation

用户取消任何 `approval_request` 时：

```text
result = "partial"
next_phase = null
checkpoint 必填
```

取消不应伪装成 success。

### 6.5 retry

重试规则：

- retry 必须沿用同一个 `session_id`。
- 同一个本地动作重试时，`idempotency_key` 保持不变。
- `retry_of` 指向原始失败消息的 `msg_id`。
- manifest 校验失败允许修正后重试，但每次 retry 都要记录在日志或 `metadata.retries` 中。

### 6.6 timeout

每个需要等待外部动作的消息必须定义 timeout。

建议字段：

```json
{
  "timeout_ms": 30000,
  "on_timeout": "partial_checkpoint"
}
```

`on_timeout` 枚举：

```text
retry_once
partial_checkpoint
failed
```

### 6.7 capability negotiation

`select-hw` 启动前应知道插件宿主能力，至少包括：

```json
{
  "capabilities": {
    "protocol_versions": ["1.0"],
    "approval_request": true,
    "script_run": true,
    "file_operation": true,
    "device_command": false,
    "artifact_root": true,
    "relative_paths": true
  }
}
```

规则：

- 若不支持 `approval_request`，不能进入需要用户确认的流程。
- 若不支持 `script_run`，不能宣称完成 manifest 校验。
- `select-hw` V0 不需要 `device_command`，因此该能力为 false 不阻塞。

### 6.8 structured error reporting

保留人类可读的 `errors: string[]`，同时必须支持结构化错误：

```json
{
  "code": "missing_pin_layout",
  "message": "selected board lacks pin_layout",
  "severity": "error",
  "recoverable": true,
  "retryable": false,
  "source": "select_hw_manifest.py",
  "field": "mcu.board_id"
}
```

`severity` 枚举：

```text
info
warning
error
fatal
```

`code` 建议枚举：

```text
invalid_upstream_manifest
missing_required_field
invalid_enum
board_not_found
firmware_unknown
missing_pin_layout
pin_conflict
i2c_address_conflict
permission_denied
script_failed
timeout
phase_complete_invalid
```

### 6.9 artifact/file manifest

`phase_complete.payload.artifacts` 必须是数组，不能写成对象映射。

artifact 类型枚举沿用 analyze：

```text
table
file_tree
markdown
html
code_diff
file_list
```

`file_list.files[]` 建议字段：

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `path` | string | 是 | 相对 artifact root 的路径 |
| `status` | string | 是 | 文件状态 |
| `kind` | string | 建议 | 文件语义类型 |
| `mime_type` | string | 建议 | MIME 类型 |
| `description` | string | 建议 | 人类可读说明 |

`status` 枚举：

```text
created
updated
unchanged
skipped
error
```

select-hw 直测建议产物：

```text
select_hw_draft.json
select_hw_validated.json
phase_complete.select_hw.json
pin_assignment_log.md
```

### 6.10 permission prompts

设计之初必须考虑权限提示，但 V0 不需要每一步都弹窗。

权限动作枚举：

```text
file_read
file_write
script_run
device_command
network_request
```

select-hw V0 推荐策略：

- 首次 session 已授权低风险文件读写和白名单脚本后，可继续。
- `script_run(select_hw_manifest.py)` 必须是白名单脚本。
- V0 不应调用 `device_command`。
- 任意非白名单脚本、删除文件、烧录、设备访问都必须单独 permission prompt。

permission_request 建议结构：

```json
{
  "approval_id": "permission_select_hw_local_tools",
  "permission_scope": ["file_read", "file_write", "script_run"],
  "scripts": ["upy-select-hw-plugin/scripts/select_hw_manifest.py"],
  "paths": ["sessions/<session_id>/"]
}
```

## 7. 与原 upy-select-hw 的差异

原 `upy-select-hw` 的职责仍然保留：

- MCU 选型
- 固件核验
- 引脚分配
- BOM 生成
- manifest 更新

但插件化表达必须改变：

| 原本地 skill 写法 | 插件化工作流写法 |
| --- | --- |
| 读 `project-manifest.json` | 读 `phase_complete.analyze.json` 的 `manifest_content` |
| WebSearch/手动找 pinout | 先用 `upy-analyze-plugin/boards` 相对路径板卡资源 |
| 缺 pinout 就让用户上传 | 默认换功能类似且有 pin_layout 的已知板卡 |
| 自然语言“请确认” | `approval_request(board_select)` |
| `update_manifest.py` 直接写盘 | `select_hw_manifest.py` 只支持新 draft schema，校验/规范化后输出 JSON |
| 成功看写盘文件 | 成功看 `phase_complete.select_hw.json` |

## 8. select-hw 输入 draft schema

`select_hw_manifest.py` 已确认只支持新 draft schema，不兼容旧 `update_manifest.py` 输入形状。

建议 draft：

```json
{
  "protocol_version": "1.0",
  "session_id": "uuid",
  "source_phase": "analyze",
  "upstream_manifest": {},
  "selected_board": {},
  "hardware_plan": {
    "mcu": {},
    "pinout": [],
    "bom": [],
    "estimated_total_yuan": 0
  },
  "warnings": [],
  "metadata": {
    "idempotency_key": "select-hw:<session_id>:manifest-validation:v1"
  }
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `upstream_manifest` | analyze 的 `manifest_content` 原样或规范化副本 |
| `selected_board` | 用户确认或 pre_selected_board 跳过确认后的板卡对象 |
| `hardware_plan.mcu` | 输出到最终 manifest 的 MCU 信息 |
| `hardware_plan.pinout` | 引脚分配结果 |
| `hardware_plan.bom` | BOM 明细 |
| `estimated_total_yuan` | BOM 估算总价，V0 接受 LLM 常识估算 |

## 9. 输出 manifest_content schema

`phase_complete(select-hw).payload.manifest_content` 必须保留 analyze 核心字段，并新增：

```text
phase = "select-hw"
mcu
hardware_selection
pinout
bom
estimated_total_yuan
final_status = "hardware_selected"
```

### 9.1 mcu 字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `model` | string | 是 | MCU/模组型号，例如 `ESP32-C3` |
| `board_id` | string | 是 | 板卡资源 ID，例如 `esp32-c3-devkitm` |
| `display_name` | string | 是 | 用户可读开发板名称 |
| `firmware_url` | string | 是 | MicroPython 固件页面 |
| `firmware_board_name` | string | 是 | MicroPython download board name |
| `flash_tool` | string | 是 | 烧录工具类别 |
| `chip_family` | string | 建议 | 板卡族，如 `esp32c3` |

`flash_tool` 枚举：

```text
esptool.py
uf2-drag-drop
dfu-util
teensy-loader
unknown
```

### 9.2 pinout 字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `device` | string | 是 | 器件名 |
| `pin_name` | string | 是 | 器件引脚名或功能名 |
| `gpio` | string/number | 是 | MCU GPIO 或电源标识 |
| `type` | string | 是 | 引脚电气/功能类型 |
| `bus` | string | 可选 | I2C/SPI/UART/I2S bus 标识 |
| `i2c_addr` | string | 可选 | I2C 地址 |
| `physical_pin` | number/string | 可选 | 物理引脚编号 |
| `notes` | string | 可选 | 说明 |

`type` 枚举：

```text
power_3v3
power_5v
gnd
i2c_data
i2c_clock
spi_mosi
spi_miso
spi_sck
spi_cs
uart_tx
uart_rx
gpio_out
gpio_in
gpio_in_pullup
adc
pwm
i2s_bck
i2s_ws
i2s_data_in
i2s_data_out
wifi_internal
reserved
```

### 9.3 bom 字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `name` | string | 是 | 物料名称 |
| `model` | string | 是 | 型号 |
| `quantity` | number | 是 | 数量 |
| `unit_price_yuan` | number | 是 | V0 估算单价 |
| `notes` | string | 可选 | 备注 |

BOM 价格已确认：V0 暂时接受 LLM 常识估算，不接商城数据源。

## 10. phase_complete.select_hw.json

已确认：`phase_complete.select_hw.json` 与 analyze 保持一致，必须使用完整 envelope。

成功形状：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "select-hw",
  "timestamp": "2026-06-21T00:00:00Z",
  "type": "phase_complete",
  "idempotency_key": "select-hw:<session_id>:phase-complete:v1",
  "payload": {
    "phase": "select-hw",
    "result": "success",
    "summary": "硬件选型完成：ESP32-C3 开发板，已生成固件、引脚和 BOM 方案",
    "next_phase": "flash-mpy-firmware",
    "manifest_content": {},
    "artifacts": [],
    "warnings": [],
    "errors": [],
    "structured_errors": []
  }
}
```

`result` 枚举：

| result | 含义 | next_phase | checkpoint |
| --- | --- | --- | --- |
| `success` | MCU/固件/pinout/BOM 全部完成 | `flash-mpy-firmware` | 不需要 |
| `partial` | 可恢复中断，例如取消、缺 pin_layout、冲突待处理 | `null` | 必填 |
| `failed` | 输入非法或协议输出非法，不能恢复到可用状态 | `null` | 可选 |

校验规则：

- `protocol_version == "1.0"`
- 顶层 `phase == "select-hw"`
- `payload.phase == "select-hw"`
- success 时 `next_phase == "flash-mpy-firmware"`
- partial 时 `next_phase == null` 且 `checkpoint` 必填
- `manifest_content.phase == "select-hw"`
- `artifacts` 必须是数组
- `warnings/errors/structured_errors` 必须是数组

## 11. 板卡确认与特殊分支

已确认决策：

1. `requirements.mcu_specified` 表示 MCU/模组型号，不是具体开发板。
2. 因此默认必须弹 `board_select`。
3. 如果 `pre_selected_board` 已经来自插件 UI，可跳过 `board_select`。
4. 缺少 `pin_layout` 时，默认换已知功能类似的板卡。
5. `cold-driver` 不影响 MCU 推荐和 pinout 分配。
6. BOM 价格暂时接受 LLM 常识估算。
7. V0 复用 `upy-analyze-plugin/boards`。
8. `select_hw_manifest.py` 只支持新 draft schema。
9. 后续以插件目录为准反向更新课程文档。

## 12. 引脚分配规则

V0 先覆盖常见接口。

基础规则：

- I2C 器件默认共享一条 I2C 总线；若 `i2c_addr` 冲突，改用第二条 I2C 或输出 partial。
- SPI 器件共享 MOSI/MISO/SCK，每个器件独立 CS。
- UART 避开 REPL/USB 串口。
- I2S 需要分别分配 BCK/WS/DIN/DOUT，麦克风和功放可共享 BCK/WS，但数据方向不同。
- ADC 只能用 ADC-capable pin；ESP32 系列优先避开 WiFi 冲突 ADC2。
- GPIO 输出避开 boot/strapping、flash/PSRAM、USB OTG、只读脚。
- 电源与 GND 必须进入 `pinout`。

冲突必须由 `select_hw_manifest.py` 校验：

```text
同一 GPIO 重复占用
I2C 地址冲突
使用 restricted_gpio
ADC 设备分配到非 ADC pin
I2S 缺少必要信号线
缺少 power/gnd
```

## 13. 脚本校验要求

必须实现：

```text
upy-select-hw-plugin/scripts/select_hw_manifest.py
```

定位：校验器/规范化器，不是默认写盘脚本。

建议命令：

```powershell
python upy-select-hw-plugin/scripts/select_hw_manifest.py --stdin
python upy-select-hw-plugin/scripts/select_hw_manifest.py --input sample/select_hw_manifest.after.json
python upy-select-hw-plugin/scripts/select_hw_manifest.py --validate-phase-complete --input sample/phase_complete.select_hw.success.json --compare-manifest sample/select_hw_manifest.after.json --artifact-root sample
```

输出：

```json
{
  "status": "ok",
  "errors": [],
  "warnings": [],
  "manifest": {},
  "written_path": null
}
```

必须校验：

- draft schema 只接受新格式。
- 上游 manifest 至少满足 analyze 最低交付字段。
- `mcu` 必填字段完整。
- `pinout` 类型枚举合法。
- `bom` 数量和价格为数字。
- `phase_complete` envelope 合法。
- `phase_complete.payload.manifest_content` 与 `select_hw_validated.json` 核心字段一致。
- file artifact 声明的相对路径在 `--artifact-root` 下真实存在。

## 14. permission prompt 策略

V0 不应调用设备，也不应烧录。

允许低风险动作：

```text
读取上游 phase_complete 文件
读取 upy-analyze-plugin/boards
写 sessions/<session_id>/select_hw_*.json
运行白名单脚本 select_hw_manifest.py
```

需要单独 permission prompt 的动作：

```text
任意非白名单脚本
删除文件
访问设备串口
烧录固件
联网查商城价格
```

## 15. 本地测试建议

后续实现必须至少覆盖：

1. 读取 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.analyze.json`，从 `payload.manifest_content` 启动 select-hw。
2. 使用相对路径 `upy-analyze-plugin/boards` 匹配 `ESP32-C3` 候选板卡。
3. `mcu_specified` 存在但无 `pre_selected_board` 时，触发 `approval_request(board_select)`。
4. `pre_selected_board` 来自插件 UI 时，允许跳过 board_select。
5. 缺 pin_layout 时，推荐功能类似且有 pin_layout 的已知板卡。
6. cold-driver 输入不阻塞 MCU 推荐和 pinout。
7. 生成 `phase_complete.select_hw.json`，且 envelope 与 analyze 一致。
8. `select_hw_manifest.py --validate-phase-complete` 通过。
9. artifact file_list 中声明的文件都存在。
10. timeout/retry/cancellation 至少在 sample 中有 partial 案例。

## 16. 后续执行顺序

1. 以本文为准，先实现 `upy-select-hw-plugin/SKILL.md`。
2. 实现 `scripts/select_hw_manifest.py`，只支持新 draft schema。
3. 添加 sample，直接引用或复制 `G:\test\test\sessions\<session_id>\phase_complete.analyze.json` 的结构。
4. 添加本地 runner/mock/smoke_tests。
5. 实现后以插件目录内容为准，反向更新本课程文档。

## 17. 本阶段边界

本阶段只更新：

```text
G:\blockless-plugin-course(1)\upy-select-hw-plugin-workflow-design.md
```

不创建或修改：

```text
G:\MicroPython_Skills\upy-select-hw-plugin
```
