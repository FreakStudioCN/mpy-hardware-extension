# upy-flash-mpy-firmware-plugin 执行修改思路

状态：执行前设计稿。本文根据当前 `G:\MicroPython_Skills\flash-mpy-firmware` 草稿、`upy-analyze-plugin` / `upy-select-hw-plugin` 样例，以及真实会话 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2` 的产物重新整理。本文不是追加讨论稿，而是后续修改的具体执行依据。

## 最终目标

把当前草稿 `G:\MicroPython_Skills\flash-mpy-firmware` 升级为插件化 skill：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin
```

正式 skill 名称：

```yaml
name: upy-flash-mpy-firmware-plugin
```

正式承接上游 `next_phase`：

```json
"next_phase": "upy-flash-mpy-firmware-plugin"
```

烧录成功或用户确认固件已烧录后，输出：

```json
"next_phase": "upy-scaffold-plugin"
```

核心职责：

1. 从 `upy-select-hw-plugin` 的 `phase_complete.select_hw.json` 读取板卡事实。
2. 从 MicroPython 官方下载页 `https://micropython.org/download/` 和具体板卡页读取固件来源、latest 固件链接、烧录命令或说明。
3. ESP32 系列：下载 latest `.bin`，从页面解析 `esptool.py` 命令，插件确认串口后通过 skill 内脚本执行擦除和写入。
4. Pico 系列：下载 latest `.uf2`，提示 BOOTSEL + 拖拽 UF2，用户确认后完成。
5. 其他板卡：不执行烧录工具，只提供官方链接和说明，用户手动烧录后点击插件确认。
6. 支持插件模式和 mock 本地测试模式；mock 本地测试仅用于校验输入/输出格式，可固定 `serial_port="COM3"`。Claude Code 实际调用 skill 或真实插件运行时必须扫描真实 COM 接口并由用户选择，不能用固定 COM3 代替。

## 当前事实核对

### 当前 flash 草稿已有内容

目录：`G:\MicroPython_Skills\flash-mpy-firmware`

已有文件：

```text
SKILL.md
agents/openai.yaml
scripts/firmware_fetch.py
scripts/flash_esp32.py
sample/start_phase.flash_mpy_firmware.esp32_c3.json
sample/start_phase.flash_mpy_firmware.pico_w.json
sample/micropython_download_esp32_generic_c3.html
sample/micropython_download_rpi_pico_w.html
test/smoke_tests.py
```

已有能力：

- 能从 mock HTML 解析带 latest 的 `.bin/.uf2`。
- 能生成 ESP32 `erase_flash` / `write_flash` 命令。
- 能用 sample/test 做最小 smoke test。

主要不足：

- skill 名称和上游 `next_phase` 仍是 `flash-mpy-firmware`，不符合现在要求。
- `next_phase` 成功后写的是 `upy-scaffold`，应改为 `upy-scaffold-plugin`。
- 只支持 ESP32/Pico，其他板卡被当作 unsupported，应改成手动说明确认流。
- ESP32 offset 仍有硬编码，必须从 MicroPython 板卡页解析命令；例如 `ESP32_GENERIC_C5` 页面写入 offset 是 `0x2000`，不能靠固定 C 系列表。
- 没有完整 session/checkpoint/retry/cancel/timeout/idempotency/capability/artifact/permission 协议。
- 没有单独校验脚本。
- 没有真实插件串口扫描路径。
- `esptool` 还不是 skill 内脚本封装调用。

### 上游真实输出格式

真实会话目录：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

真实文件：

```text
phase_complete.analyze.json
phase_complete.select_hw.json
manifest_draft.json
manifest_validated.json
select_hw_draft.json
select_hw_validated.json
pin_assignment_log.md
select_hw_phase_log.md
```

烧录插件正式输入必须是：

```text
sessions/<session_id>/phase_complete.select_hw.json
```

不要把下面这些作为正式输入：

- `phase_complete.analyze.json`：这是 select-hw 的上游，不是烧录阶段输入。
- `select_hw_draft.json`：只是草稿。
- `select_hw_validated.json`：可作为排查/校验对比，但不是插件交接 envelope。
- `manifest_draft.json` / `manifest_validated.json`：属于 analyze 阶段，不是烧录阶段输入。

`phase_complete.select_hw.json` 的真实 envelope 结构：

```json
{
  "protocol_version": "1.0",
  "msg_id": "c7e8d2a1-4f3b-42e9-b8d6-1a5c7e3f9d20",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "select-hw",
  "timestamp": "2026-06-21T16:38:52Z",
  "type": "phase_complete",
  "idempotency_key": "select-hw:022ad742-3269-42e9-ac20-c14f477ecdf2:phase_complete:v1",
  "retry_of": null,
  "payload": {
    "phase": "select-hw",
    "result": "success",
    "next_phase": "flash-mpy-firmware",
    "manifest_content": {},
    "artifacts": [],
    "warnings": [],
    "errors": [],
    "structured_errors": [],
    "runtime_context": {
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2",
      "resource_root": "C:\\Users\\Administrator\\.claude\\skills"
    }
  }
}
```

注意：当前真实产物还写着 `next_phase="flash-mpy-firmware"`，这是后续需要改 `upy-select-hw-plugin` 的地方。修改后烧录插件应要求：

```json
"payload.next_phase": "upy-flash-mpy-firmware-plugin"
```

### 板卡和固件字段来源

烧录插件解析板卡必须从 `phase_complete.select_hw.json.payload.manifest_content` 读取。

优先字段：

```text
payload.manifest_content.hardware_selection.selected_board.firmware.url
payload.manifest_content.hardware_selection.selected_board.firmware.board_name
payload.manifest_content.hardware_selection.selected_board.firmware.port
payload.manifest_content.hardware_selection.selected_board.chip_family
```

备用字段：

```text
payload.manifest_content.mcu.firmware_url
payload.manifest_content.mcu.firmware_board_name
payload.manifest_content.mcu.flash_tool
payload.manifest_content.mcu.chip_family
payload.manifest_content.mcu.display_name
payload.manifest_content.mcu.board_id
```

真实 ESP32-C3 例子：

```json
{
  "mcu": {
    "model": "ESP32-C3-MINI-1",
    "board_id": "esp32-c3-devkitm",
    "display_name": "ESP32-C3-DevKitM-1",
    "firmware_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
    "firmware_board_name": "ESP32_GENERIC_C3",
    "flash_tool": "esptool.py",
    "chip_family": "esp32c3"
  },
  "hardware_selection": {
    "selected_board": {
      "id": "esp32-c3-devkitm",
      "display_name": "ESP32-C3-DevKitM-1",
      "chip_family": "esp32c3",
      "firmware": {
        "url": "https://micropython.org/download/ESP32_GENERIC_C3/",
        "port": "esp32",
        "board_name": "ESP32_GENERIC_C3",
        "latest_version": "1.24.1"
      }
    }
  }
}
```

固件实际来源不要相信 `latest_version` 缓存。正式固件来源必须运行时从 MicroPython 官方页面抓取：

```text
https://micropython.org/download/
https://micropython.org/download/<firmware_board_name>/
```

如果 select-hw 输出里缺少 `firmware.url`，则用 `firmware_board_name` 到下载首页中匹配板卡卡片，例如下载首页包含：

```html
<a class="board-card" href="ESP32_GENERIC_C5">
<a class="board-card" href="ESP32_GENERIC_C3">
<a class="board-card" href="RPI_PICO_W">
<a class="board-card" href="PYBV11">
```

然后拼出：

```text
https://micropython.org/download/<board_name>/
```

## upy-select-hw-plugin 必须修改的文件

现在要求 select-hw 成功后的 `next_phase` 必须改为：

```text
upy-flash-mpy-firmware-plugin
```

需要修改这些文件。

### 1. scripts/select_hw_manifest.py

当前：

```python
NEXT_PHASE = "flash-mpy-firmware"
```

应改为：

```python
NEXT_PHASE = "upy-flash-mpy-firmware-plugin"
```

影响：

- phase_complete 生成处会输出新 next_phase。
- `--validate-phase-complete` 会要求 success 时 next_phase 为新值。
- 不需要改 partial/failed 规则，它们仍应 `next_phase=null`。

### 2. SKILL.md

需要把所有文档中的：

```text
flash-mpy-firmware
```

用于下游阶段名的地方改为：

```text
upy-flash-mpy-firmware-plugin
```

重点位置包括：

- 角色定位中“输出 phase_complete(select-hw)，next_phase 固定为 ...”。
- 标准消息序列 Step 8 输出说明。
- `phase_complete` 字段规则。
- result 表格中 success 对应 next_phase。
- artifact/table 示例中的“下一阶段”。

### 3. sample/phase_complete.select_hw.success.json

需要更新：

```json
"next_phase": "upy-flash-mpy-firmware-plugin"
```

并更新 artifacts 表格里 “下一阶段” 行。

### 4. test/select_hw_runner.py

当前 runner 里硬编码：

```python
"next_phase": "flash-mpy-firmware"
```

以及表格行：

```python
["下一阶段", "flash-mpy-firmware"]
```

应全部改为：

```text
upy-flash-mpy-firmware-plugin
```

### 5. test/smoke_tests.py

当前测试查找：

```python
"flash-mpy-firmware"
```

应改为查找：

```python
"upy-flash-mpy-firmware-plugin"
```

### 6. 其他样例和生成产物

用 `rg "flash-mpy-firmware" G:\MicroPython_Skills\upy-select-hw-plugin` 复查。当前命中还包括：

```text
sample/phase_complete.select_hw.success.json
test/select_hw_runner.py
test/smoke_tests.py
scripts/select_hw_manifest.py
SKILL.md
```

`sample/phase_complete.select_hw.partial.json` 中 `next_phase` 是 null，不需要改。

## upy-flash-mpy-firmware-plugin 输入格式

### 插件正式 start_phase

插件可以直接传上游完整 envelope，也可以传路径。推荐传路径 + envelope 摘要，避免大 JSON 重复传输。

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "upy-flash-mpy-firmware-plugin",
  "timestamp": "<runtime-utc-now>",
  "type": "start_phase",
  "idempotency_key": "upy-flash-mpy-firmware-plugin:<session_id>:start:v1",
  "retry_of": null,
  "payload": {
    "phase": "upy-flash-mpy-firmware-plugin",
    "source_phase": "select-hw",
    "source_phase_complete_path": "sessions/<session_id>/phase_complete.select_hw.json",
    "runtime_context": {
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/<session_id>",
      "resource_root": "<runtime-provided>"
    },
    "capabilities": {
      "protocol_versions": ["1.0"],
      "approval_request": true,
      "script_run": true,
      "file_operation": true,
      "network_access": {
        "allowed": true,
        "domains": ["micropython.org", "docs.micropython.org"]
      },
      "web_search": true,
      "serial_port_scan": true,
      "device_flash": true,
      "relative_paths": true,
      "artifact_root": true
    },
    "firmware_action": null,
    "firmware_override": null
  }
}
```

字段含义：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `source_phase_complete_path` | 插件模式建议必填 | 指向 `phase_complete.select_hw.json` 的相对路径。 |
| `runtime_context.artifact_root` | 是 | 当前产物根目录。 |
| `runtime_context.session_root` | 是 | 当前 session 子目录。 |
| `runtime_context.resource_root` | 是 | skill 根资源目录。 |
| `capabilities.script_run` | 是 | 插件是否能运行 skill 内脚本。 |
| `capabilities.network_access` | 是 | 是否允许访问 MicroPython 下载页。 |
| `capabilities.serial_port_scan` | ESP32 真实烧录必需 | 插件是否能扫描串口。 |
| `capabilities.device_flash` | ESP32 真实烧录必需 | 插件是否允许高风险设备擦写动作。 |
| `firmware_action` | 可选 | 如果缺失，skill 先发 action 选择卡片。 |
| `firmware_override` | 可选 | 用户指定本地固件或指定固件 URL。 |

### 本地测试输入

mock 本地测试也使用 JSON 文件，但只用于校验输入/输出格式和脚本 plan，不代表 Claude Code 实际调用行为。Claude Code 实际调用 skill 时必须走真实串口扫描和用户选择。

建议 sample：

```text
sample/start_phase.upy_flash_mpy_firmware_plugin.esp32_c3.json
sample/start_phase.upy_flash_mpy_firmware_plugin.pico_w.json
sample/start_phase.upy_flash_mpy_firmware_plugin.pyboard_manual.json
```

mock 本地测试可以固定：

```json
"serial_port": "COM3"
```

这个固定值只允许出现在 sample/test 的格式校验里；真实插件运行和 Claude Code 实际调用不得用固定值代替扫描结果。

mock 本地测试不执行真实烧录，只运行 plan 模式：

```text
--execute false
```

## 主流程

### Step 0: 读取上游 select-hw 产物

输入只认：

```text
phase_complete.select_hw.json
```

校验：

```text
protocol_version == "1.0"
type == "phase_complete"
phase == "select-hw"
payload.phase == "select-hw"
payload.result == "success"
payload.next_phase == "upy-flash-mpy-firmware-plugin"
payload.manifest_content.phase == "select-hw"
```

如果仍是旧值 `flash-mpy-firmware`：

- 正式插件模式：应报 `invalid_upstream_phase`，因为 select-hw 尚未升级。
- 本地迁移测试：可以提供 `--allow-legacy-next-phase`，但不写进正式协议。

### Step 1: 解析板卡事实

从 `manifest_content` 取：

```text
board_id
firmware_board_name
firmware_url
firmware_port
flash_tool
chip_family
display_name
```

板卡分支判定：

| 分支 | 条件 |
| --- | --- |
| ESP32 | `firmware_board_name` 以 `ESP32_` 开头，或 `firmware.port == "esp32"`，或 `chip_family` 以 `esp32` 开头。 |
| Pico | `firmware_board_name` 以 `RPI_PICO` 开头，或 `firmware.port == "rp2"` 且板卡名是 Pico 系列。 |
| Other manual | 其他 MicroPython 板卡，例如 ESP8266、PYBV11、STM32、SAMD、nRF、MIMXRT、Teensy 等。 |

注意：ESP8266 虽然也可用 esptool，但按当前需求不自动烧录，走 manual 分支。

### Step 2: 先让用户选择烧录动作

不能直接默认烧录。必须先发：

```json
{
  "approval_id": "firmware_action_select",
  "actions": [
    {"value": "download_and_flash", "label": "下载并烧录"},
    {"value": "download_only", "label": "只下载固件"},
    {"value": "already_flashed", "label": "我已自行烧录，跳过"},
    {"value": "use_local_firmware", "label": "使用本地固件文件"},
    {"value": "save_partial", "label": "稍后继续"},
    {"value": "cancel", "label": "取消"}
  ]
}
```

行为：

| action | 行为 |
| --- | --- |
| `download_and_flash` | 解析页面、下载 latest 固件，进入对应烧录/确认分支。 |
| `download_only` | 只下载固件，输出 partial，checkpoint 留在确认烧录步骤。 |
| `already_flashed` | 用户声明已烧录，直接输出 success，`firmware.status=skipped_user_confirmed`。 |
| `use_local_firmware` | 插件返回本地固件路径，跳过下载，但仍解析页面用于命令/说明。 |
| `save_partial` | 输出 partial + checkpoint。 |
| `cancel` | 输出 partial，reason=`user_cancelled`。 |

### Step 3: 从 MicroPython 页面解析固件和命令

新增或重构脚本：

```text
scripts/firmware_page_resolve.py
```

输入：

```text
--download-index-url https://micropython.org/download/
--board-url <firmware_url>
--board-name <firmware_board_name>
--board-family esp32|pico|manual
--out-json <session_root>/firmware_page_resolved.json
--html-file <optional for tests>
```

输出：

```json
{
  "status": "success",
  "board_name": "ESP32_GENERIC_C5",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C5/",
  "family": "esp32",
  "latest": {
    "url": "https://micropython.org/resources/firmware/ESP32_GENERIC_C5-20260406-v1.28.0.bin",
    "filename": "ESP32_GENERIC_C5-20260406-v1.28.0.bin",
    "version": "v1.28.0",
    "date": "2026-04-06",
    "file_type": "bin",
    "is_preview": false
  },
  "install": {
    "tool_hint": "esptool.py",
    "windows_tool_hint": "esptool",
    "docs": [
      "https://docs.espressif.com/projects/esptool/en/latest/esp32c5/"
    ],
    "erase_commands": [
      "esptool.py erase_flash",
      "esptool.py --port PORTNAME erase_flash"
    ],
    "write_commands": [
      "esptool.py --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin",
      "esptool.py --port PORTNAME --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin"
    ],
    "write_offset": "0x2000",
    "baud": 460800,
    "serial_port_placeholder": "PORTNAME",
    "troubleshooting": []
  }
}
```

解析要求：

- latest 固件必须来自 MicroPython 板卡页中带 `(latest)` 的 release，不取 preview builds。
- ESP32 解析 `Installation instructions` 下的 `<pre><code>`，抽取 `erase_flash`、`write_flash`、offset、baud。
- Pico 解析 UF2 bootloader 说明和 latest `.uf2`。
- Manual 分支解析 latest 固件链接、installation/flashing 文本和外链。
- 若页面命令解析失败，ESP32 才允许 fallback 到内置 offset 表，并写 `warnings`。

已验证事实：`ESP32_GENERIC_C5` 页面实际命令是：

```text
esptool.py erase_flash
esptool.py --port PORTNAME erase_flash
esptool.py --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin
esptool.py --port PORTNAME --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin
```

因此不能再写死 C 系列 offset 为 `0x0`。

## esptool 封装方式

插件不要直接调用系统 PATH 上的 `esptool`。正式流程必须从 skill 文件夹调用脚本：

```text
python <resource_root>/upy-flash-mpy-firmware-plugin/scripts/esp32_flash.py ...
```

`esp32_flash.py` 内部负责调用 skill 封装的 esptool 环境。

建议新增：

```text
scripts/requirements-esptool.txt
scripts/bootstrap_esptool.py
scripts/esptool_runner.py
scripts/esp32_flash.py
```

### scripts/requirements-esptool.txt

内容：

```text
esptool==4.11.0
```

版本先固定到本机已验证的 `4.11.0`，后续升级再改。

### scripts/bootstrap_esptool.py

职责：

- 创建 skill-local 环境，例如：

```text
<skill_dir>/scripts/.venv-esptool/
```

- 在该环境里安装 `esptool==4.11.0`。
- 输出：

```json
{
  "status": "success",
  "python": ".../scripts/.venv-esptool/Scripts/python.exe",
  "esptool_version": "4.11.0"
}
```

权限：

- 安装依赖需要 plugin permission prompt。
- 如果环境已存在且版本匹配，不重复安装。

### scripts/esptool_runner.py

职责：

- 统一从 skill-local `.venv-esptool` 调用：

```text
<skill_dir>/scripts/.venv-esptool/Scripts/python.exe -m esptool ...
```

- 不依赖全局 PATH。
- 检测 esptool 命令风格。

本机事实：

```text
where.exe esptool => G:\miniconda\install\Scripts\esptool.exe
python -m pip show esptool => 4.11.0
esptool version => esptool.py v4.11.0 / 4.11.0
python -m esptool version => esptool.py v4.11.0 / 4.11.0
esptool write_flash -h => 支持
esptool write-flash -h => 不支持
esptool erase_flash -h => 支持
esptool erase-flash -h => 不支持
```

所以 V0 默认命令风格是：

```text
erase_flash
write_flash
```

但脚本应支持：

```text
--command-style auto|underscore|hyphen
```

`auto` 行为：

1. 读取 `esptool --help` 或 `python -m esptool --help`。
2. 如果支持 `write_flash`，用 underscore。
3. 如果只支持 `write-flash`，用 hyphen。
4. 两者都没有则报 `esptool_command_style_unknown`。

### scripts/esp32_flash.py

职责：

- 读取 `firmware_page_resolved.json` 中的页面命令。
- 把页面命令里的 `esptool.py` 替换为 skill-local esptool runner。
- 把 `PORTNAME` 替换为插件选择的串口。
- 把 `ESP32_BOARD_NAME-DATE-VERSION.bin` 替换为实际下载文件路径。
- 默认先 erase 再 write。
- `--plan-only` 时只输出命令，不执行。
- `--execute` 时真实执行。

输入示例：

```text
python <resource_root>/upy-flash-mpy-firmware-plugin/scripts/esp32_flash.py \
  --resolved-json <session_root>/firmware_page_resolved.json \
  --firmware <session_root>/firmware/ESP32_GENERIC_C5-20260406-v1.28.0.bin \
  --port COM3 \
  --execute \
  --output-json <session_root>/flash_esp32_log.json
```

输出示例：

```json
{
  "status": "success",
  "tool": "esptool",
  "tool_version": "4.11.0",
  "command_style": "underscore",
  "port": "COM3",
  "erased_first": true,
  "write_offset": "0x2000",
  "commands": [],
  "runs": []
}
```

## 串口枚举

真实插件模式：

- 插件必须扫描串口。
- `approval_request(esp32_flash_confirm)` 必须带串口候选项。
- 用户选择后，`approval_response.payload.serial_port` 返回如 `COM3`。

建议新增脚本给本地/插件复用：

```text
scripts/list_serial_ports.py
```

输出：

```json
{
  "ports": [
    {"name": "COM3", "description": "USB Serial", "hwid": "..."}
  ]
}
```

如果插件已有串口扫描能力，可以不调用此脚本；但真实模式不能只用固定 `COM3`。

mock 本地测试模式：

- sample/test 的格式校验可固定 `serial_port="COM3"`。
- 只做 plan，不真实执行擦写。
- 不要求本机接入开发板。
- Claude Code 实际调用 skill 或真实插件运行时必须扫描真实 COM 接口，并把扫描结果交给 approval UI 让用户选择。

## 三个烧录分支

### ESP32 分支

流程：

```text
load phase_complete.select_hw.json
resolve board from manifest_content
approval_request(firmware_action_select)
resolve MicroPython board page
download latest .bin
scan serial ports
approval_request(esp32_flash_confirm)
script_run(esp32_flash.py --plan-only)  # 可展示命令
script_run(esp32_flash.py --execute)    # 用户确认后真实执行
phase_complete(success, next_phase=upy-scaffold-plugin)
```

`approval_request(esp32_flash_confirm)` 必须包含：

- 固件文件名。
- MicroPython 页面链接。
- 从页面解析出的 erase/write 命令。
- 串口候选项。
- ESP32 进入下载模式说明。

通用下载模式说明：

```text
按板卡说明进入下载/烧录模式；常见 ESP32 开发板做法是按住 BOOT，点击 EN/RESET，然后松开 BOOT。
```

V0 不强依赖搜索板卡专属 BOOT/EN 文档；可以优先展示通用说明 + MicroPython/esptool 官方链接。后续如果 plugin 允许搜索，可补充厂商链接并记录 source。

### Pico 分支

流程：

```text
load phase_complete.select_hw.json
approval_request(firmware_action_select)
resolve MicroPython board page
download latest .uf2
approval_request(pico_uf2_drag_drop)
user confirms copied_uf2
phase_complete(success, next_phase=upy-scaffold-plugin)
```

Pico 不执行烧录脚本。用户确认 `copied_uf2` 后 V0 视为成功，不再自动验证设备是否运行 MicroPython。

### Other manual 分支

包括 ESP8266、PYBV11、STM32、SAMD、nRF、MIMXRT、Teensy 等非 ESP32/Pico 板卡。

流程：

```text
load phase_complete.select_hw.json
approval_request(firmware_action_select)
resolve MicroPython board page
collect latest URL + installation text + official links
approval_request(manual_firmware_flash_confirm)
user confirms confirm_flashed
phase_complete(success, next_phase=upy-scaffold-plugin)
```

注意：即使 `mcu.flash_tool` 是 `dfu-util`、`teensy-loader` 或 `esptool.py`，非 ESP32/Pico 分支也不执行工具，只展示说明。

`approval_request(manual_firmware_flash_confirm)`：

```json
{
  "approval_id": "manual_firmware_flash_confirm",
  "header": "请按说明手动烧录 MicroPython 固件",
  "question": "请打开下面链接，按官方说明完成固件烧录；完成后点击确认。",
  "summary": {
    "board_name": "PYBV11",
    "firmware_page": "https://micropython.org/download/PYBV11/",
    "latest_firmware_url": "...",
    "flash_method": "manual"
  },
  "links": [],
  "steps": [],
  "actions": [
    {"label": "确认固件已烧录完毕", "value": "confirm_flashed", "primary": true},
    {"label": "稍后继续", "value": "save_partial"},
    {"label": "取消", "value": "cancel"}
  ]
}
```

## 产物和 checkpoint

所有正式产物写入：

```text
sessions/<session_id>/
```

建议产物：

```text
flash_mpy_firmware_state.json
firmware_page_resolved.json
firmware_download.json
firmware/<downloaded-file>
esptool_plan.json
flash_esp32_log.json
manual_flash_instructions.json
phase_complete.upy_flash_mpy_firmware_plugin.json
flash_mpy_firmware_phase_log.md
```

`flash_mpy_firmware_state.json`：

```json
{
  "protocol_version": "1.0",
  "session_id": "<session_id>",
  "phase": "upy-flash-mpy-firmware-plugin",
  "status": "in_progress",
  "last_successful_step": "firmware_downloaded",
  "checkpoint": {
    "resume_step": "esp32_flash_confirm",
    "reason": "waiting_user_approval"
  },
  "source_phase_complete_path": "sessions/<session_id>/phase_complete.select_hw.json",
  "firmware": {},
  "approvals": {},
  "scripts": {}
}
```

`checkpoint.resume_step` 枚举：

```text
load_upstream_select_hw
select_firmware_action
resolve_firmware_page
download_firmware
scan_serial_ports
confirm_esp32_flash
run_esp32_flash
wait_pico_uf2_copy
manual_firmware_flash_confirm
phase_complete_validation
```

## phase_complete 输出

成功输出 envelope：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "<session_id>",
  "phase": "upy-flash-mpy-firmware-plugin",
  "timestamp": "<runtime-utc-now>",
  "type": "phase_complete",
  "idempotency_key": "upy-flash-mpy-firmware-plugin:<session_id>:phase-complete:v1",
  "retry_of": null,
  "payload": {
    "phase": "upy-flash-mpy-firmware-plugin",
    "result": "success",
    "summary": "MicroPython 固件烧录阶段完成",
    "next_phase": "upy-scaffold-plugin",
    "firmware": {
      "status": "flashed",
      "action": "download_and_flash",
      "board_name": "ESP32_GENERIC_C5",
      "board_url": "https://micropython.org/download/ESP32_GENERIC_C5/",
      "latest_url": "https://micropython.org/resources/firmware/ESP32_GENERIC_C5-20260406-v1.28.0.bin",
      "file": "sessions/<session_id>/firmware/ESP32_GENERIC_C5-20260406-v1.28.0.bin",
      "file_type": "bin",
      "source": "micropython_latest",
      "flash_method": "esptool.py",
      "flash_result": {
        "tool": "esptool",
        "tool_version": "4.11.0",
        "port": "COM3",
        "write_offset": "0x2000",
        "erased_first": true,
        "log": "sessions/<session_id>/flash_esp32_log.json"
      }
    },
    "artifacts": [
      {
        "type": "file_list",
        "files": []
      }
    ],
    "warnings": [],
    "errors": [],
    "structured_errors": [],
    "runtime_context": {}
  }
}
```

`firmware.status` 枚举：

```text
downloaded
flashed
uf2_copied
manual_confirmed
skipped_user_confirmed
partial_download_only
failed
```

partial 规则：

- 用户稍后继续。
- 只下载不烧录。
- approval 超时。
- 网络暂不可用但可重试。
- manual 分支用户还没确认。

failed 规则：

- 上游文件无效。
- MicroPython 页面不可解析且无 fallback。
- esptool 执行失败。
- artifact 校验失败。

## 校验脚本

新增：

```text
scripts/flash_mpy_firmware_manifest.py
```

支持：

```text
--validate-start-phase --input <start_phase.json>
--validate-state --input <flash_mpy_firmware_state.json>
--validate-phase-complete --input <phase_complete.json> --artifact-root <path> --expected-artifact <relative-path>
```

必须校验：

- envelope 必填字段。
- `phase == upy-flash-mpy-firmware-plugin`。
- 上游 `payload.next_phase == upy-flash-mpy-firmware-plugin`。
- success 时 `payload.next_phase == upy-scaffold-plugin`。
- partial/failed 时 `payload.next_phase == null`。
- `runtime_context` 路径口径。
- `payload.firmware` 字段完整性。
- artifact path 必须是相对路径，不允许 skill 本机绝对路径。
- `file_list` 覆盖本阶段正式产物。

## sample/test 修改计划

### 新 skill sample

```text
sample/start_phase.upy_flash_mpy_firmware_plugin.esp32_c3.json
sample/start_phase.upy_flash_mpy_firmware_plugin.pico_w.json
sample/start_phase.upy_flash_mpy_firmware_plugin.pyboard_manual.json
sample/approval_response.firmware_action_select.download_and_flash.json
sample/approval_response.firmware_action_select.download_only.json
sample/approval_response.firmware_action_select.already_flashed.json
sample/approval_response.esp32_flash_confirm.com3.json
sample/approval_response.pico_uf2_drag_drop.copied.json
sample/approval_response.manual_firmware_flash_confirm.confirmed.json
sample/phase_complete.upy_flash_mpy_firmware_plugin.esp32_success.json
sample/phase_complete.upy_flash_mpy_firmware_plugin.pico_success.json
sample/phase_complete.upy_flash_mpy_firmware_plugin.manual_success.json
sample/phase_complete.upy_flash_mpy_firmware_plugin.already_flashed.json
sample/phase_complete.upy_flash_mpy_firmware_plugin.partial_download_only.json
sample/micropython_download_esp32_generic_c5.html
sample/micropython_download_rpi_pico_w.html
sample/micropython_download_pybv11.html
```

### 新 skill tests

`test/smoke_tests.py` 应覆盖：

- sample JSON 全部合法。
- 从 select-hw phase_complete 提取 board/firmware 字段。
- 从 ESP32_GENERIC_C5 mock HTML 解析 latest `.bin` 和 `write_offset=0x2000`。
- 从 Pico mock HTML 解析 latest `.uf2` 和 UF2 手动步骤。
- manual 分支不调用 ESP32 烧录脚本，不要求串口。
- mock 本地测试 ESP32 固定 `serial_port="COM3"`，只校验格式、生成 plan，不执行；Claude Code 实际调用必须使用真实 COM 接口。
- success 时 `next_phase == upy-scaffold-plugin`。
- phase_complete artifact path 都是相对路径。

可选新增：

```text
test/mock_plugin.py
```

用于模拟 approval、retry、cancel、timeout。

## 当前 flash 草稿具体怎么改

### 1. 目录迁移

从：

```text
flash-mpy-firmware
```

迁移到：

```text
upy-flash-mpy-firmware-plugin
```

不要保留两个并行版本，避免 skill 触发混乱。迁移完成后旧目录删除或只留迁移说明。

### 2. SKILL.md 重写

保留当前 ESP32/Pico 的核心思想，但必须新增：

- 正式名称 `upy-flash-mpy-firmware-plugin`。
- 上游输入必须是 `phase_complete.select_hw.json`。
- 下游 success `next_phase=upy-scaffold-plugin`。
- 三分支：ESP32 / Pico / Other manual。
- `firmware_action_select`。
- JSON 字段含义表。
- session/checkpoint/retry/cancel/timeout/idempotency。
- capability negotiation。
- permission prompts。
- artifact/file manifest。
- esptool skill-local 封装说明。

### 3. scripts/firmware_fetch.py

建议改名或拆分为：

```text
scripts/firmware_page_resolve.py
scripts/firmware_download.py
```

原因：当前脚本只做 latest 链接解析，不够承载安装命令解析。

### 4. scripts/flash_esp32.py

建议替换为：

```text
scripts/esp32_flash.py
scripts/esptool_runner.py
scripts/bootstrap_esptool.py
```

核心变化：

- 不再用硬编码 offset 表作为主路径。
- 主路径读取 `firmware_page_resolved.json.install.write_commands`。
- 通过 skill-local esptool 环境执行。
- 支持 `--plan-only` 和 `--execute`。

### 5. agents/openai.yaml

更新为：

```yaml
interface:
  display_name: "UPY Flash MPY Firmware"
  short_description: "Flash or confirm MicroPython firmware."
  default_prompt: "Use $upy-flash-mpy-firmware-plugin after select-hw to resolve MicroPython firmware and complete flashing."
policy:
  allow_implicit_invocation: true
```

## 执行顺序

建议实际修改时按这个顺序做，避免一次性改崩：

1. 先改 `upy-select-hw-plugin` 的 `next_phase` 常量、文档、sample、test，跑 select-hw smoke test。
2. 迁移 `flash-mpy-firmware` 到 `upy-flash-mpy-firmware-plugin`，改 frontmatter 和 agents。
3. 重写 `SKILL.md` 的协议和三分支流程。
4. 新增 `firmware_page_resolve.py`，先用 mock HTML 测 ESP32_GENERIC_C5、RPI_PICO_W、PYBV11。
5. 新增 `firmware_download.py`，下载 latest 固件到 `sessions/<session_id>/firmware/`。
6. 新增 skill-local esptool 封装：`requirements-esptool.txt`、`bootstrap_esptool.py`、`esptool_runner.py`、`esp32_flash.py`。
7. 新增 `list_serial_ports.py`；mock 本地测试可固定 COM3，Claude Code 实际调用和真实插件都必须使用扫描结果。
8. 新增 `flash_mpy_firmware_manifest.py` 校验脚本。
9. 补 sample/test/mock_plugin。
10. 跑新 skill smoke test 和 quick_validate。
11. 用真实 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.select_hw.json` 做本地迁移测试；如果上游尚未改 next_phase，测试时只允许 legacy flag，不写进正式输出。

## 关键结论

- 烧录插件输入不是 analyze 输出，而是 select-hw 的完整 `phase_complete.select_hw.json`。
- 板卡事实来自 select-hw 输出；固件 latest、烧录命令和说明来自 MicroPython 官方下载页。
- ESP32 命令必须从具体板卡页解析；`ESP32_GENERIC_C5` 已验证需要 `write_flash 0x2000`。
- pip 安装的 esptool 不应由插件直接调用，应通过 skill 内 `scripts` 封装脚本和 skill-local esptool 环境调用。
- select-hw 的 `next_phase` 要改成 `upy-flash-mpy-firmware-plugin`，涉及脚本、SKILL、sample 和 tests。
- 真实插件和 Claude Code 实际调用必须扫描串口；只有 mock 格式校验测试才允许固定 `COM3`。
- 非 ESP32/Pico 板卡不执行烧录工具，只展示说明链接并等待用户确认。


