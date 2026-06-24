# upy-flash-mpy-firmware-plugin 当前修改清单

状态：基于重新加载后的当前事实整理。本文只记录现在要改什么，不代表已经修改 `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`。

重新加载依据：

- `G:\blockless-plugin-course(1)\flash-mpy-firmware-skill-design-notes.md`
- `G:\blockless-plugin-course(1)\flash-mpy-firmware-real-page-analysis-and-change-plan.md`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\firmware_page_resolve.py`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\test\smoke_tests.py`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\*.json`
- `G:\MicroPython_Skills\upy-analyze-plugin\boards\*.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin` 当前 next_phase 相关文件

## 当前事实

### 1. `upy-select-hw-plugin` 当前不需要改

重新检查后，`upy-select-hw-plugin` 当前已经使用：

```text
next_phase = upy-flash-mpy-firmware-plugin
```

命中位置包括：

```text
upy-select-hw-plugin\scripts\select_hw_manifest.py: NEXT_PHASE = "upy-flash-mpy-firmware-plugin"
upy-select-hw-plugin\test\select_hw_runner.py: "next_phase": "upy-flash-mpy-firmware-plugin"
upy-select-hw-plugin\sample\phase_complete.select_hw.success.json: "next_phase": "upy-flash-mpy-firmware-plugin"
upy-select-hw-plugin\SKILL.md: payload.next_phase = "upy-flash-mpy-firmware-plugin"
```

因此早期设计稿里“必须先改 select-hw next_phase”的内容已经过期，当前不再是本轮修改项。

### 2. `upy-analyze-plugin/boards` 已经有固件页 URL

`upy-analyze-plugin/boards/*.json` 中已提供 MicroPython 官方固件页 URL，例如：

| board json | display_name | firmware.board_name | firmware.url |
| --- | --- | --- | --- |
| `esp32-c3-devkitm.json` | `ESP32-C3-DevKitM-1` | `ESP32_GENERIC_C3` | `https://micropython.org/download/ESP32_GENERIC_C3/` |
| `esp32-devkit-v1.json` | `ESP32 DevKit V1` | `ESP32_GENERIC` | `https://micropython.org/download/ESP32_GENERIC/` |
| `esp32-s3-devkitc.json` | `ESP32-S3-DevKitC-1` | `ESP32_GENERIC_S3` | `https://micropython.org/download/ESP32_GENERIC_S3/` |
| `esp8266-nodemcu.json` | `ESP8266 NodeMCU V3` | `ESP8266_GENERIC` | `https://micropython.org/download/ESP8266_GENERIC/` |
| `m5stack-core.json` | `M5Stack Core (ESP32)` | `M5STACK_ATOM` | `https://micropython.org/download/M5STACK_ATOM/` |
| `raspberry-pi-pico-w.json` | `Raspberry Pi Pico W` | `RPI_PICO_W` | `https://micropython.org/download/RPI_PICO_W/` |
| `raspberry-pi-pico.json` | `Raspberry Pi Pico` | `RPI_PICO` | `https://micropython.org/download/RPI_PICO/` |

这说明 flash skill 正常情况下不应该优先从 MicroPython 首页重新猜测板卡 slug。正确主路径是消费 select-hw 输出中的 URL。

### 3. `upy-flash-mpy-firmware-plugin` 主体已经基本成型

当前已经具备：

```text
SKILL.md
agents/openai.yaml
scripts/firmware_page_resolve.py
scripts/firmware_download.py
scripts/list_serial_ports.py
scripts/bootstrap_esptool.py
scripts/esptool_runner.py
scripts/esp32_flash.py
scripts/flash_mpy_firmware_manifest.py
test/smoke_tests.py
sample/start_phase...
sample/phase_complete...
sample/approval_response...
```

已有能力：

- `SKILL.md` 已定义 `upy-flash-mpy-firmware-plugin`。
- success 输出已为 `next_phase=upy-scaffold-plugin`。
- ESP32 页面解析已有 C5 offset 测试。
- Pico UF2 拖拽确认已有测试。
- manual 分支已有最小样例和测试。
- mock `COM3` 只允许 sample/test 使用，真实模式必须扫描串口，这一点已有测试。
- `flash_mpy_firmware_manifest.py` 已有 `--allow-legacy-next-phase`，但当前 select-hw 已经升级，所以它只是迁移兼容能力。

## 当前真正需要修改的内容

### 修改项 1：`SKILL.md` 板卡事实说明

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
```

当前问题：

```text
不要信任缓存的 `latest_version`；运行时必须从 `https://micropython.org/download/<board_name>/` 解析真实最新版本。
```

这句话不够准确。因为当前板卡库已经提供 `firmware.url`，且 select-hw 会把它带到 `phase_complete.select_hw.json`。`board_name`、`display_name`、`board_id` 不应该被拿来直接拼 URL。

应改成：

```text
不要信任缓存的 `latest_version`。运行时必须优先使用上游 `hardware_selection.selected_board.firmware.url`，其次使用 `mcu.firmware_url`，访问该 MicroPython 官方板卡页解析真实 `(latest)` 固件和安装说明。只有当上游 URL 缺失或无效时，才使用 `firmware_board_name` 到 `https://micropython.org/download/` 首页匹配真实下载页 slug。不要用 `display_name`、`board_id` 或 MCU 型号直接拼 URL。
```

同时建议在字段表后增加一个小表：

| 字段 | 用途 |
| --- | --- |
| `firmware.url` / `mcu.firmware_url` | MicroPython 官方固件页 URL，正常主路径。 |
| `firmware.board_name` / `mcu.firmware_board_name` | MicroPython 固件板卡名，优先作为展示和 fallback 匹配关键字。 |
| `display_name` | 给用户看的板卡名，不用于拼下载 URL。 |
| `board_id` | 本地板卡库 ID，不用于拼下载 URL。 |
| `download_slug` | 从固件 URL path 提取或从下载首页匹配出的真实 MicroPython 下载页 slug。 |
| `board_url` | 规范化后的 MicroPython 板卡页 URL。 |

### 修改项 2：`SKILL.md` 工作流程补充 URL 优先规则

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
```

当前工作流程第 7 步已经写：

```text
select-hw 已给出页面时传 `--board-url`，否则用 `--download-index-url` 和 `--board-name` 解析。
```

但还不够明确。建议改为更明确的三段优先级：

1. 正常从上游 `selected_board.firmware.url` / `mcu.firmware_url` 得到 `board_url`。
2. `board_url` 存在时调用：

```text
scripts/firmware_page_resolve.py --board-url <board_url> --board-name <firmware_board_name> --board-family <family>
```

3. 只有 URL 缺失/无效时才调用：

```text
scripts/firmware_page_resolve.py --download-index-url https://micropython.org/download/ --board-name <firmware_board_name> --board-family <family>
```

可选说明：如果首页匹配不能唯一确定，输出候选并触发 `approval_request(firmware_board_resolve)`。

### 修改项 3：`SKILL.md` 手动板卡流程字段含义表

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
```

当前 `## 手动板卡流程` 有 JSON 示例，但没有字段含义表。应补充字段说明，至少包括：

| 字段 | 含义 |
| --- | --- |
| `approval_id` | 固定 `manual_firmware_flash_confirm`。 |
| `summary.board_name` | 上游固件板卡名。 |
| `summary.download_slug` | 实际解析到的 MicroPython 下载页 slug，可选新增。 |
| `summary.firmware_page` | MicroPython 官方板卡页 URL。 |
| `summary.latest_firmware_url` | 页面中标记 latest 的主固件链接。 |
| `summary.latest_version` | latest 版本，例如 `v1.28.0`。 |
| `summary.latest_date` | latest 日期，例如 `2026-04-06`。 |
| `summary.file_type` | 固件类型，例如 `dfu`、`uf2`、`bin`、`hex`、`zip`。 |
| `summary.flash_method` | 固定 `manual`。 |
| `summary.tool_hint` | 页面说明提取出的工具/方式，例如 `dfu-util`、`st-flash`、`uf2-drag-drop`、`teensy-loader`、`ftp-copy`。 |
| `links[]` | 下载页、latest 固件、官方文档、工具文档等。 |
| `steps[]` | 面向用户的中文步骤，来自官方安装说明摘要。 |
| `commands[]` | 可选，仅展示页面命令，不自动执行；每项应有 `execute_allowed=false`。 |
| `warnings[]` | 手动烧录风险提示。 |
| `actions[]` | `confirm_flashed`、`save_partial`、`cancel`。 |

### 修改项 4：`firmware_page_resolve.py` 输出 `download_slug` / `resolved`

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\firmware_page_resolve.py
```

当前输出有：

```json
{
  "board_name": "ESP32_GENERIC_C5",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C5/"
}
```

建议增加但不破坏旧字段：

```json
{
  "download_slug": "ESP32_GENERIC_C5",
  "resolved": {
    "download_slug": "ESP32_GENERIC_C5",
    "board_url": "https://micropython.org/download/ESP32_GENERIC_C5/",
    "match_method": "firmware_url_slug",
    "confidence": 1.0,
    "candidate_count": 1
  }
}
```

规则：

- `--board-url` 存在时，从 URL path 提取 slug，这是正常主路径。
- `--board-url` 缺失时，才读取下载首页匹配。
- 保留 `board_name`，避免现有 sample/test 破坏。

### 修改项 5：`firmware_page_resolve.py` manual 分支解析真实安装说明

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\firmware_page_resolve.py
```

当前 manual 分支只返回通用步骤：

```json
"steps": [
  "Open the MicroPython board download page.",
  "Download the firmware marked latest.",
  "Follow the official installation instructions on the page.",
  "Return to the plugin and confirm flashing is complete."
]
```

应改成从页面 `Installation instructions` 提取信息，输出：

```json
"install": {
  "tool_hint": "dfu-util",
  "raw_text_excerpt": "Pyboard-D via mboot ...",
  "steps": ["...中文步骤或页面摘要步骤..."],
  "commands": [
    {
      "command": "dfu-util ...",
      "source": "micropython_official",
      "execute_allowed": false
    }
  ],
  "links": []
}
```

最小关键词规则：

| 页面关键词 | `tool_hint` |
| --- | --- |
| `dfu-util`、`DFU`、`.dfu` | `dfu-util` |
| `st-flash`、`ST-Link` | `st-flash` |
| `UF2`、`virtual drive` | `uf2-drag-drop` |
| `teensy_loader_cli`、`Teensy Loader` | `teensy-loader` |
| `ftp`、`/flash/sys` | `ftp-copy` |
| 未识别 | `manual` |

注意：manual 分支仍然不执行这些工具，只展示说明并等用户确认。

### 修改项 6：新增 `PYBD_SF2` fixture

新增文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\micropython_download_pybd_sf2.html
```

目的：覆盖 Pyboard D 的真实手动烧录说明，例如 mboot、USR/RST、DFU/dfu-util 相关文本。

这个 fixture 不需要完整复制网页，只要保留 resolver 测试需要的结构：

- latest `.dfu` 链接，附近有 `(latest)`。
- `Installation instructions` 区块。
- 包含 `mboot`、`machine.bootloader()`、`USR`、`RST`、`dfu-util` 等关键字。

### 修改项 7：更新 `test/smoke_tests.py`

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\test\smoke_tests.py
```

新增测试：

1. `firmware_page_resolves_pybd_sf2_manual_instructions`
   - 使用 `sample/micropython_download_pybd_sf2.html`
   - `--board-url https://micropython.org/download/PYBD_SF2/`
   - `--board-name PYBD_SF2`
   - `--board-family manual`
   - 断言：

```text
status == success
latest.file_type == dfu
install.tool_hint in {"dfu-util", "manual_dfu"}
install.raw_text_excerpt 包含 mboot 或 USR 或 RST
commands[].execute_allowed == false
```

2. 更新现有 `firmware_page_resolves_manual_without_serial_or_flash`
   - 允许 manual `tool_hint` 不再固定为 `manual`。
   - 断言重点从“通用步骤”改成“不要求串口、不执行烧录、能输出手动说明”。

可选测试：

- 新增 `ESP32_GENERIC_C3` fixture，断言 C3 offset 是 `0`，C5 offset 是 `0x2000`。这可以证明 offset 来自页面而不是硬编码，但不是本轮必须。

## 可选修改项

### 可选 1：`flash_mpy_firmware_manifest.py` 提取 `download_slug`

文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py
```

可以在 `board_facts_from_upstream()` 中从 `board_url` path 提取：

```json
"download_slug": "ESP32_GENERIC_C5"
```

但不要作为必填字段。这样不会扩大 sample 修改面。

### 可选 2：phase_complete sample 增加 `download_slug`

可以给成功样例里的 `payload.firmware` 加：

```json
"download_slug": "ESP32_GENERIC_C5"
```

但不是必须。当前校验脚本不要求它，先保持兼容更稳。

## 暂时不改的内容

- 不改 `upy-select-hw-plugin`。
- 不改 `upy-analyze-plugin/boards`。
- 不新增完整 216 个 MicroPython slug 映射库。
- 不把首页搜索作为主路径。
- 不自动执行 `dfu-util`、`st-flash`、`teensy_loader_cli` 等非 ESP32/Pico 工具。
- 不扩大 Pico 专用分支到所有 RP2040/RP2350 UF2 板卡；当前仍只把 `RPI_PICO*` 当 Pico 专用流程，其余按 manual。
- 不重构 `esp32_flash.py`、`firmware_download.py`、`list_serial_ports.py`。

## 推荐执行顺序

1. 改 `SKILL.md`：修正固件 URL 来源说明，补 manual 字段含义表。
2. 改 `firmware_page_resolve.py`：增加 `download_slug/resolved`，manual 分支解析 installation section。
3. 新增 `sample/micropython_download_pybd_sf2.html`。
4. 改 `test/smoke_tests.py`：新增 PYBD_SF2 manual 测试，调整旧 manual 测试断言。
5. 运行：

```text
python upy-flash-mpy-firmware-plugin\test\smoke_tests.py
python C:\Users\Administrator\.codex\skills\.system\skill-creator\scripts\quick_validate.py G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin
```

6. 如需要，再做可选项：`flash_mpy_firmware_manifest.py` 返回 `download_slug`。
