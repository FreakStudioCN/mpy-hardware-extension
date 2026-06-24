# upy-flash-mpy-firmware-plugin 真实下载页分析与修改方向

状态：需求确认后的分析稿。本文只记录分析和后续修改方向，不代表已经修改 `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`。

分析依据：

- `G:\blockless-plugin-course(1)\flash-mpy-firmware-skill-design-notes.md`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\firmware_page_resolve.py`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\flash_mpy_firmware_manifest.py`
- MicroPython 下载首页：`https://micropython.org/download/`
- 抽样板卡页：`ESP32_GENERIC_C5`、`ESP32_GENERIC_C3`、`M5STACK_ATOM`、`ESP8266_GENERIC`、`RPI_PICO_W`、`SEEED_XIAO_RP2040`、`PYBD_SF2`、`PYBV11`、`NUCLEO_F401RE`、`SAMD_GENERIC_D21X18`、`SEEED_XIAO_NRF52`、`TEENSY41`、`WIPY`

## 结论摘要

1. 当前 `SKILL.md` 的主流程、三分支、脚本白名单、checkpoint、phase_complete 基本已经按设计稿落地。
2. 仍然描述不清楚的重点有两个：
   - `board_name` 不应被默认等同于 MicroPython 下载页 slug。
   - `## 手动板卡流程` 缺少字段含义表，也没有明确“页面解析出来的安装说明如何进入 UI/产物”。
3. 实际下载首页可解析到约 216 个板卡 slug，板卡 slug 和常见开发板 display name 经常不一致。
4. ESP32 运行时必须从具体板卡页解析写入命令，不能用芯片族硬编码 offset。真实页面显示：
   - `ESP32_GENERIC_C3` 当前 `write_flash 0`
   - `ESP32_GENERIC_C5` 当前 `write_flash 0x2000`
   - `M5STACK_ATOM` 当前 `write_flash 0x1000`
5. 非 ESP32/Pico 的页面安装说明差异很大，不能只写“打开页面按说明操作”。至少要把页面中的工具提示、文件类型、关键步骤、展示用命令、官方链接结构化到 approval UI 和 `manual_flash_instructions.json`。
6. 当前 `firmware_page_resolve.py` 能从真实 `ESP32_GENERIC_C5` 页面解析 latest `.bin` 和 `write_offset=0x2000`，但 manual 分支只输出通用 steps，丢失了 `PYBD_SF2` 页面里 mboot/USR/RST/dfu-util 等关键说明。

## 对照设计稿的实现状态

| 设计项 | 当前状态 | 说明 |
| --- | --- | --- |
| skill 名称 `upy-flash-mpy-firmware-plugin` | 已实现 | `SKILL.md` frontmatter 已使用正式名称。 |
| 输入 `phase_complete.select_hw.json` | 已描述/脚本已校验 | `SKILL.md` 和 `flash_mpy_firmware_manifest.py` 已要求上游 envelope。 |
| success 后 `next_phase=upy-scaffold-plugin` | 已实现 | 文档、测试和校验脚本均使用该值。 |
| ESP32 从 MicroPython 页面解析命令 | 基本已实现 | `firmware_page_resolve.py` 对真实 `ESP32_GENERIC_C5` 可解析 latest 和 offset。 |
| Pico UF2 拖拽确认 | 已描述 | 当前只覆盖 `RPI_PICO*`，符合“树莓派 Pico”范围。其他 RP2040/RP2350 板卡应走 manual。 |
| 其他板卡手动确认 | 已描述但不够细 | 缺少字段含义、页面解析细则、实际页面差异处理。 |
| 运行时解析真实 latest | 已描述/脚本支持 | 但文档中 `<board_name>` 容易让人误以为直接拼 URL；应改成解析 `download_slug`。 |
| session/checkpoint/retry/cancel/timeout | 已描述 | 可以保留当前设计。 |
| script_run/resource_root | 已描述 | 白名单脚本已列出。 |
| 本地 mock 固定 COM3、真实运行扫描串口 | 已描述/测试覆盖 | `list_serial_ports.py` 和 smoke test 已覆盖 mock 限制。 |
| 手动流程字段含义 | 未实现 | `manual_firmware_flash_confirm` 示例后没有字段表。 |
| 多板卡页真实抽样 | 未写入 skill | 应写成解析策略，不建议把大量板卡列表写进 `SKILL.md`。 |

## MicroPython 下载页真实观察

### 下载首页结构

从 `https://micropython.org/download/` 解析到约 216 个板卡 slug。slug 是 MicroPython 下载页的真实路径名，例如：

```text
https://micropython.org/download/ESP32_GENERIC_C5/
https://micropython.org/download/RPI_PICO_W/
https://micropython.org/download/PYBD_SF2/
```

首页中的 slug 和人类可读 display name 不一定一致。抽样分类：

```text
ESP32: ESP32_GENERIC, ESP32_GENERIC_C2, ESP32_GENERIC_C3, ESP32_GENERIC_C5, ESP32_GENERIC_C6, ESP32_GENERIC_P4, ESP32_GENERIC_S2, ESP32_GENERIC_S3
Pico/RP 系: RPI_PICO, RPI_PICO_W, RPI_PICO2, RPI_PICO2_W, SEEED_XIAO_RP2040, SEEED_XIAO_RP2350, ADAFRUIT_FEATHER_RP2040 ...
Pyboard: PYBD_SF2, PYBD_SF3, PYBD_SF6, PYBLITEV10, PYBV10, PYBV11
STM32/Nucleo: NUCLEO_F401RE, NUCLEO_H743ZI, STM32F4DISC, STM32H747I_DISCO ...
```

### ESP32 页面差异

真实页面支持“从页面解析命令”这个设计，而且必须这样做。

| slug | latest | 页面写入命令重点 |
| --- | --- | --- |
| `ESP32_GENERIC_C5` | `v1.28.0 (2026-04-06) .bin` | `write_flash 0x2000` |
| `ESP32_GENERIC_C3` | `v1.28.0 (2026-04-06) .bin` | `write_flash 0` |
| `M5STACK_ATOM` | `v1.28.0 (2026-04-06) .bin` | `write_flash 0x1000` |

这证明不能写成“ESP32-C 系列固定 offset”。当前脚本真实运行 `ESP32_GENERIC_C5` 可解析出：

```json
{
  "latest": {
    "url": "https://micropython.org/resources/firmware/ESP32_GENERIC_C5-20260406-v1.28.0.bin",
    "file_type": "bin",
    "version": "v1.28.0",
    "date": "2026-04-06",
    "is_latest": true
  },
  "install": {
    "erase_commands": [
      "esptool.py erase_flash",
      "esptool.py --port PORTNAME erase_flash"
    ],
    "write_commands": [
      "esptool.py --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin",
      "esptool.py --port PORTNAME --baud 460800 write_flash 0x2000 ESP32_BOARD_NAME-DATE-VERSION.bin"
    ],
    "write_offset": "0x2000",
    "baud": 460800
  }
}
```

### 非 ESP32/Pico 页面差异

抽样页面显示，manual 分支必须保留官方页面中的“具体方法”，但仍不自动执行工具。

| slug | latest 类型 | 页面安装方式摘要 | V0 行为 |
| --- | --- | --- | --- |
| `PYBD_SF2` | `.dfu` | Pyboard-D 通过 mboot；可在 REPL 执行 `machine.bootloader()`，或按 USR/RST 进入；页面提到 `dfu-util` | 展示步骤和链接，用户自行烧录后确认。 |
| `PYBV11` | `.dfu` | Pyboard v1.x via DFU；进入 DFU bootloader 后用 DFU programmer | 展示步骤和链接，用户确认。 |
| `NUCLEO_F401RE` | `.dfu`，页面也说明 `.bin/.hex` | ST-Link 可用 `st-flash erase`、`st-flash write firmware.bin 0x08000000`；也提到 DFU | 展示命令但不执行。 |
| `SAMD_GENERIC_D21X18` | `.uf2` | 双击 reset 或 `machine.bootloader()`，出现虚拟盘后复制 UF2 | 虽然也是 UF2，但非树莓派 Pico，按当前需求走 manual。 |
| `SEEED_XIAO_NRF52` | `.uf2` | 页面说明 UF2 可直接走第 4 步，HEX 需要额外转换步骤 | 展示页面步骤，提醒选择 latest UF2。 |
| `TEENSY41` | `.uf2` | 页面提到 PJRC Teensy Loader 和 `teensy_loader_cli` | 展示命令但不执行。 |
| `WIPY` | `.zip` | zip 内有 `mcuimg.bin`，通过 FTP 复制到 `/flash/sys` | 展示 FTP 手动说明。 |
| `ESP8266_GENERIC` | `.bin` | 页面引用 esptool 教程 | 按当前需求非 ESP32/Pico，不自动烧录，走 manual。 |

## board_name 不一致问题

### 当前风险

当前 `SKILL.md` 写法是：

```text
运行时必须从 https://micropython.org/download/<board_name>/ 解析真实最新版本
```

这个表述不够准确。很多时候上游或用户看到的是：

```text
display_name: ESP32-C3-DevKitM-1
board_id: esp32-c3-devkitm
mcu.model: ESP32-C3-MINI-1
firmware_board_name: ESP32_GENERIC_C3
MicroPython download slug: ESP32_GENERIC_C3
```

只有最后一个才适合拼下载 URL。类似地：

```text
M5Stack Core / Atom 类板卡可能映射到 M5STACK_ATOM
TinyPICO 页面 slug 是 UM_TINYPICO
Pyboard D-series SF2 页面 slug 是 PYBD_SF2
Nucleo F401RE 页面 slug 是 NUCLEO_F401RE
```

因此 `board_name` 在 skill 中应被拆成两个概念：

| 字段 | 含义 |
| --- | --- |
| `display_name` | 给用户看的板卡名，不用于拼 URL。 |
| `board_id` | 本地板卡库 ID，不用于拼 URL。 |
| `firmware_board_name` | select-hw 给出的 MicroPython 固件板卡名，通常应等于下载页 slug，但仍需运行时验证。 |
| `download_slug` | 从 `firmware.url` 或下载首页解析出的真实 MicroPython 下载页 slug。 |
| `board_url` | 规范化后的 `https://micropython.org/download/<download_slug>/`。 |

### 推荐解析优先级

V0 不需要大改 select-hw。烧录 skill 内部按以下顺序解析即可：

1. 如果 `hardware_selection.selected_board.firmware.url` 存在：
   - 先校验它是否是 `https://micropython.org/download/<slug>/`。
   - 从 URL path 提取 `download_slug`。
   - 访问该页面并以最终 URL 作为 `board_url`。
2. 如果 URL 缺失，使用 `hardware_selection.selected_board.firmware.board_name` 或 `mcu.firmware_board_name`：
   - 到 `https://micropython.org/download/` 首页解析全部 slug。
   - 只有 exact slug match 时才直接拼 URL。
3. 如果 exact slug 不存在，不要直接失败，也不要拿 display name 硬拼 URL。应做候选匹配：
   - 匹配首页卡片 path slug。
   - 匹配卡片标题/描述文本。
   - 匹配 `display_name`、`board_id`、`mcu.model`、`chip_family`、`firmware.port`。
   - 生成候选列表和 confidence。
4. 如果只有一个高置信候选，使用它，并写入 `warnings` 说明采用了索引匹配。
5. 如果候选多个或低置信，发送新的审批：

```json
{
  "approval_id": "firmware_board_resolve",
  "header": "确认 MicroPython 固件下载页",
  "question": "当前板卡名无法唯一匹配 MicroPython 下载页，请选择固件页面",
  "summary": {
    "requested_board_name": "ESP32-C3-DevKitM-1",
    "firmware_board_name": "ESP32_GENERIC_C3",
    "download_index": "https://micropython.org/download/"
  },
  "items": [
    {
      "id": "ESP32_GENERIC_C3",
      "name": "ESP32_GENERIC_C3",
      "subtitle": "https://micropython.org/download/ESP32_GENERIC_C3/",
      "meta": "高置信匹配",
      "selected": true
    }
  ],
  "actions": [
    {"label": "使用选中页面", "value": "confirm", "primary": true},
    {"label": "稍后继续", "value": "save_partial"},
    {"label": "取消", "value": "cancel"}
  ]
}
```

### 建议新增解析结果字段

`firmware_page_resolved.json` 建议新增这些字段：

```json
{
  "requested": {
    "display_name": "ESP32-C3-DevKitM-1",
    "board_id": "esp32-c3-devkitm",
    "firmware_board_name": "ESP32_GENERIC_C3",
    "firmware_url": "https://micropython.org/download/ESP32_GENERIC_C3/"
  },
  "resolved": {
    "download_slug": "ESP32_GENERIC_C3",
    "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/",
    "match_method": "firmware_url_slug",
    "confidence": 1.0,
    "candidate_count": 1
  }
}
```

`phase_complete.payload.firmware` 也建议增加：

```json
{
  "board_name": "ESP32_GENERIC_C3",
  "download_slug": "ESP32_GENERIC_C3",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C3/"
}
```

其中 `board_name` 保持兼容现有样例，`download_slug` 作为更精确的新字段。

## 手动板卡流程需要补清楚

当前 `SKILL.md` 的 `## 手动板卡流程` 有示例，但缺少字段含义。建议补一个字段表，并明确页面解析结果如何进入 UI。

### manual approval_request 字段含义

| 字段 | 含义 |
| --- | --- |
| `approval_id` | 固定为 `manual_firmware_flash_confirm`，用于插件识别该审批。 |
| `header` | UI 标题，中文。 |
| `question` | UI 提问，说明用户需要按官方说明手动烧录并回来确认。 |
| `summary.board_name` | 上游固件板卡名，通常来自 `firmware_board_name`。 |
| `summary.download_slug` | 实际解析到的 MicroPython 下载页 slug。 |
| `summary.display_name` | 用户可读板卡名，可选。 |
| `summary.firmware_page` | 规范化后的 MicroPython 板卡页 URL。 |
| `summary.latest_firmware_url` | 页面中标记 `(latest)` 的主固件链接。 |
| `summary.latest_version` | 从 latest 链接附近文本解析出的版本，例如 `v1.28.0`。 |
| `summary.latest_date` | 从 latest 链接附近文本解析出的日期，例如 `2026-04-06`。 |
| `summary.file_type` | latest 主固件扩展名，例如 `dfu`、`uf2`、`bin`、`hex`、`zip`。 |
| `summary.flash_method` | 固定 `manual`，表示本 skill 不自动执行烧录工具。 |
| `summary.tool_hint` | 从页面说明推断的工具/方式，例如 `dfu-util`、`st-flash`、`uf2-drag-drop`、`teensy-loader`、`ftp-copy`、`manual`。 |
| `links[]` | 展示给用户的链接，包括下载页、latest 固件、官方文档、工具文档、release notes。 |
| `links[].source` | 机器可读来源，例如 `micropython_official`、`tool_docs`、`vendor_docs`。 |
| `links[].kind` | 链接类型，例如 `download_page`、`latest_firmware`、`official_docs`、`tool_docs`、`release_notes`。 |
| `steps[]` | 从页面安装说明提炼出的中文步骤，必须保留进入 bootloader、选择固件文件、使用工具/复制文件、重启确认这些关键信息。 |
| `commands[]` | 可选，只展示页面中的命令，不执行。每项应带 `execute_allowed=false`。 |
| `warnings[]` | 手动流程风险提示，例如“本阶段不会自动执行 dfu-util/st-flash/teensy_loader_cli”。 |
| `actions[]` | `confirm_flashed`、`save_partial`、`cancel`。 |

### manual approval_request 建议结构

```json
{
  "type": "approval_request",
  "payload": {
    "approval_id": "manual_firmware_flash_confirm",
    "header": "请按说明手动烧录 MicroPython 固件",
    "question": "请按官方页面说明完成固件烧录；完成后点击确认。",
    "summary": {
      "board_name": "PYBD_SF2",
      "download_slug": "PYBD_SF2",
      "firmware_page": "https://micropython.org/download/PYBD_SF2/",
      "latest_firmware_url": "https://micropython.org/resources/firmware/PYBD_SF2-20260406-v1.28.0.dfu",
      "latest_version": "v1.28.0",
      "latest_date": "2026-04-06",
      "file_type": "dfu",
      "flash_method": "manual",
      "tool_hint": "dfu-util"
    },
    "links": [
      {
        "label": "MicroPython 固件下载页",
        "url": "https://micropython.org/download/PYBD_SF2/",
        "source": "micropython_official",
        "kind": "download_page"
      },
      {
        "label": "latest DFU 固件",
        "url": "https://micropython.org/resources/firmware/PYBD_SF2-20260406-v1.28.0.dfu",
        "source": "micropython_official",
        "kind": "latest_firmware"
      }
    ],
    "steps": [
      "下载页面中标记为 latest 的 .dfu 固件。",
      "按官方说明让 Pyboard D 进入 mboot/DFU bootloader；可在 REPL 执行 machine.bootloader()，或按页面说明使用 USR/RST 按键。",
      "使用官方页面推荐的 DFU 工具完成烧录。",
      "设备重启后回到插件窗口点击确认。"
    ],
    "commands": [
      {
        "label": "页面展示命令或工具提示",
        "command": "dfu-util ...",
        "source": "micropython_official",
        "execute_allowed": false
      }
    ],
    "warnings": [
      "本阶段不会自动运行 dfu-util、st-flash、teensy_loader_cli 或其他非 ESP32/Pico 工具。"
    ],
    "actions": [
      {"label": "确认固件已烧录完毕", "value": "confirm_flashed", "primary": true},
      {"label": "稍后继续", "value": "save_partial"},
      {"label": "取消", "value": "cancel"}
    ]
  }
}
```

### manual 产物建议

`manual_flash_instructions.json` 建议包含：

```json
{
  "status": "ready_for_user",
  "download_slug": "PYBD_SF2",
  "board_url": "https://micropython.org/download/PYBD_SF2/",
  "latest": {},
  "firmware_variants": [],
  "install": {
    "tool_hint": "dfu-util",
    "raw_text_excerpt": "...",
    "steps": [],
    "commands": [],
    "links": []
  },
  "execute_allowed": false,
  "source_checked_at": "<runtime-utc-now>"
}
```

## 当前脚本需要优化的点

### `firmware_page_resolve.py`

当前可保留的能力：

- 能访问真实 MicroPython 板卡页。
- 能从真实 `ESP32_GENERIC_C5` 页面解析 latest `.bin`、版本、日期、`write_offset=0x2000`、erase/write 命令。
- 能用 `--html-file` 支持 mock 测试。

建议修改：

1. 把 `board_name` 入参语义改清楚：它是“上游提供的 firmware_board_name 或待匹配名称”，不是最终 slug。
2. 新增 `download_slug` / `resolved.download_slug` 输出。
3. 首页解析不要只 exact match。增加候选匹配和 confidence。
4. 如果无法唯一匹配，输出 `status=needs_approval` 或结构化候选列表，由 skill 发 `firmware_board_resolve`。
5. manual 分支不要只返回通用 steps。应解析 `Installation instructions` 文本、代码块、工具链接，并输出：
   - `install.raw_text_excerpt`
   - `install.tool_hint`
   - `install.steps`
   - `install.commands`
   - `install.links`
6. manual 的 latest 选择要保留页面中的多个固件变体，例如 `.dfu/.hex`、`.uf2/.hex`、`.zip`。主 latest 可以按页面第一个 latest 固件保留，但 UI 里要展示 variants。
7. `docs` 链接现在会混入全站导航链接，建议只在 installation section 内提取链接，或者给链接加 `kind` 并过滤无关文档。

### `flash_mpy_firmware_manifest.py`

建议修改：

1. `board_facts_from_upstream` 增加 `download_slug`，优先从 `firmware.url` path 提取。
2. 不要求 `board_name` 一定能直接拼 URL；只要求 `board_url` 或 `board_name` 至少一个存在。
3. `phase_complete.payload.firmware` success 时建议校验 `download_slug`，但 V0 可先设为可选，避免样例大改。

### `SKILL.md`

建议最小修改：

1. 在 `## 板卡事实` 中把这句：

```text
运行时必须从 https://micropython.org/download/<board_name>/ 解析真实最新版本。
```

改成：

```text
运行时必须先解析 MicroPython 下载页真实 slug。优先使用上游 `firmware.url`，其次用 `firmware_board_name` 到 `https://micropython.org/download/` 索引页 exact/candidate 匹配，得到 `download_slug` 后再访问 `https://micropython.org/download/<download_slug>/` 解析真实 latest 版本。不要用 `display_name` 或 `board_id` 直接拼 URL。
```

2. 在 `## 工作流程` 中增加 `firmware_board_resolve` 可选审批步骤：当 URL/slug 不能唯一确定时暂停让用户选择。
3. 在 `## 手动板卡流程` 后补字段含义表。
4. 明确 manual 分支要从页面提取安装说明、工具提示、展示命令和链接，但不执行任何非 ESP32/Pico 工具。
5. 在 `phase_complete.payload.firmware` 示例里可选新增 `download_slug`。

### sample/test

建议新增或调整：

1. 新增 `sample/micropython_download_pybd_sf2.html`，覆盖 Pyboard D mboot/DFU 手动说明。
2. 新增 `sample/micropython_download_nucleo_f401re.html` 或精简 fixture，覆盖 ST-Link/DFU 说明。
3. 新增 test：manual resolver 必须从 `PYBD_SF2` fixture 输出页面相关 steps/tool_hint，而不是只输出通用 steps。
4. 新增 test：`ESP32_GENERIC_C3`、`ESP32_GENERIC_C5`、`M5STACK_ATOM` 三个页面 offset 不同，必须来自页面解析。
5. 新增 test：URL 缺失时可从下载首页 exact slug 匹配；slug 不唯一时输出候选/需要审批。
6. 保留现有 COM3 mock 限制测试。

## 后续最小修改顺序

1. 先改 `SKILL.md`：补 `download_slug` 策略和 manual 字段含义表。
2. 再改 `firmware_page_resolve.py`：
   - 输出 `download_slug` / `resolved`。
   - manual 分支解析真实 installation section。
   - 改进 index candidate matching。
3. 补 `PYBD_SF2` fixture 和 manual test。
4. 如改了 phase_complete 字段，再同步 sample 和 `flash_mpy_firmware_manifest.py`。
5. 跑 smoke test 和 quick_validate。

## 需要和你确认的点

1. `download_slug` 是否作为正式字段加入 `phase_complete.payload.firmware`？建议加入，可选兼容旧样例。
2. `firmware_board_resolve` 审批是否现在就加入？建议加入文档和脚本候选输出，但 V0 可以只在异常路径触发。
3. manual 分支是否默认不下载固件，只提供 latest URL？当前你的要求更偏向“提供说明链接，用户自行确认”，建议 manual 默认不下载；只有用户选择 `download_only` 或提供 `firmware_action=download_only` 时才下载。
4. 非 Raspberry Pi Pico 的 UF2 板卡，如 `SEEED_XIAO_RP2040`、`SAMD_GENERIC_D21X18`，是否仍走 manual？按当前需求建议走 manual，仅 `RPI_PICO*` 走 Pico 专用拖拽流程。

## 不修改其他 skill 时的最小修改方案

目标：只修改 `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`，不修改 `upy-select-hw-plugin`、`upy-analyze-plugin` 或其他 skill。这样可以先把烧录阶段自身做稳，避免牵动上游协议和大量 sample/test。

### 总体取舍

1. 不改 `upy-select-hw-plugin` 的 `next_phase` 常量，因此真实旧 session 里仍可能出现：

```json
"next_phase": "flash-mpy-firmware"
```

2. `upy-flash-mpy-firmware-plugin` 继续把正式目标写成：

```json
"payload.next_phase": "upy-flash-mpy-firmware-plugin"
```

3. 为了不修改其他 skill，迁移兼容路径只放在 flash skill 内部：
   - 校验脚本保留 `--allow-legacy-next-phase`。
   - `SKILL.md` 明确：正式插件模式应接收新值；如果上游尚未升级，本地迁移/兼容运行可显式启用 legacy 接受旧值。
   - 不要求 `select-hw` 现在同步修改。

4. 这不是最终最干净架构，但对当前阶段最省改动、风险最低。等 flash skill 自身稳定后，再单独改 select-hw 的 next_phase。

### 最小修改范围

只动这些文件：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\SKILL.md
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\scripts\firmware_page_resolve.py
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\sample\...
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin\test\smoke_tests.py
```

尽量不动或少动：

```text
scripts\flash_mpy_firmware_manifest.py
scripts\esp32_flash.py
scripts\firmware_download.py
scripts\list_serial_ports.py
```

原因：当前校验脚本、ESP32 烧录计划、下载脚本、串口 mock/live 规则已经能工作。优先补 board slug 和 manual 说明解析，不做大范围协议重构。

### SKILL.md 最小改法

只补三类说明，不重写整体结构。

#### 1. 板卡事实：改清楚 board_name 与 download_slug

在 `## 板卡事实` 中把现在的：

```text
不要信任缓存的 `latest_version`；运行时必须从 `https://micropython.org/download/<board_name>/` 解析真实最新版本。
```

改成更准确的规则：

```text
不要信任缓存的 `latest_version`。运行时必须先解析 MicroPython 下载页真实 slug：优先使用上游 `firmware.url` 提取 `download_slug`；如果 URL 缺失，再用 `firmware_board_name` 到 `https://micropython.org/download/` 索引页匹配；得到 `download_slug` 后访问 `https://micropython.org/download/<download_slug>/` 解析真实 latest 固件和安装说明。不要用 `display_name`、`board_id` 或 MCU 型号直接拼 URL。
```

新增一个小表即可：

| 字段 | 用途 |
| --- | --- |
| `display_name` | 给用户看的板卡名，不用于拼 URL。 |
| `board_id` | 本地板卡库 ID，不用于拼 URL。 |
| `firmware_board_name` | 上游给出的 MicroPython 固件板卡名，通常接近下载页 slug，但仍需验证。 |
| `download_slug` | 从 `firmware.url` 或下载首页解析出的真实 MicroPython 下载页 slug。 |
| `board_url` | 规范化后的 `https://micropython.org/download/<download_slug>/`。 |

#### 2. 工作流程：加入可选 board resolve

在 `## 工作流程` 中只插入一个可选步骤：

```text
如果 `firmware.url` 缺失或 `firmware_board_name` 不能唯一匹配下载页 slug，发送 `approval_request(firmware_board_resolve)`，让用户确认 MicroPython 固件下载页；用户选择后继续解析 latest。
```

V0 不一定立刻实现完整 UI，但文档先定义行为，脚本可以先输出 candidates/needs_approval。

#### 3. 手动板卡流程：补字段含义表

不重写 manual 示例，只在示例后补字段表，明确这些字段：

| 字段 | 含义 |
| --- | --- |
| `summary.board_name` | 上游固件板卡名。 |
| `summary.download_slug` | 实际解析到的 MicroPython 下载页 slug；新增可选字段。 |
| `summary.firmware_page` | MicroPython 官方板卡页。 |
| `summary.latest_firmware_url` | 页面中标记 latest 的主固件链接。 |
| `summary.latest_version` | latest 固件版本，例如 `v1.28.0`。 |
| `summary.latest_date` | latest 固件日期，例如 `2026-04-06`。 |
| `summary.file_type` | 固件类型，例如 `dfu`、`uf2`、`bin`、`hex`、`zip`。 |
| `summary.flash_method` | 固定 `manual`。 |
| `summary.tool_hint` | 页面说明中提取的工具/方式，例如 `dfu-util`、`st-flash`、`uf2-drag-drop`、`teensy-loader`、`ftp-copy`。 |
| `links[]` | 下载页、latest 固件、官方文档、工具文档等链接。 |
| `steps[]` | 面向用户的中文步骤，来自页面安装说明摘要。 |
| `commands[]` | 可选，只展示页面命令，必须标记不可自动执行。 |
| `warnings[]` | 手动烧录风险提示。 |
| `actions[]` | `confirm_flashed`、`save_partial`、`cancel`。 |

### firmware_page_resolve.py 最小改法

保留现有 CLI 参数，避免改调用方：

```text
--download-index-url
--board-url
--board-name
--board-family
--html-file
--index-html-file
--out-json
```

只增强输出和解析逻辑。

#### 1. 增加 download_slug/resolved 输出

当前输出已有：

```json
"board_name": "ESP32_GENERIC_C5",
"board_url": "https://micropython.org/download/ESP32_GENERIC_C5/"
```

新增：

```json
"download_slug": "ESP32_GENERIC_C5",
"resolved": {
  "download_slug": "ESP32_GENERIC_C5",
  "board_url": "https://micropython.org/download/ESP32_GENERIC_C5/",
  "match_method": "firmware_url_slug",
  "confidence": 1.0,
  "candidate_count": 1
}
```

兼容性：保留旧字段 `board_name`、`board_url`，现有 sample/test 不会被破坏。

#### 2. URL 优先，index 兜底

解析顺序：

1. `--board-url` 存在：
   - 规范化 URL。
   - 从 URL path 末尾提取 `download_slug`。
   - `match_method="firmware_url_slug"`。
2. `--board-url` 缺失：
   - 下载/读取 index。
   - 先 exact 匹配 slug：`board_name.upper() == href_slug.upper()`。
   - 再匹配卡片文本。
   - 无唯一匹配时输出候选。

#### 3. 候选不唯一时不要假装成功

如果无法唯一匹配，输出：

```json
{
  "status": "needs_approval",
  "board_name": "<upstream value>",
  "family": "manual",
  "candidates": [
    {
      "download_slug": "PYBD_SF2",
      "board_url": "https://micropython.org/download/PYBD_SF2/",
      "label": "Pyboard D-series SF2",
      "confidence": 0.82,
      "match_reason": "slug/title similarity"
    }
  ],
  "error": {
    "code": "firmware_board_ambiguous",
    "message": "无法唯一匹配 MicroPython 固件下载页"
  }
}
```

这一步只影响异常路径；正常上游给了 `firmware.url` 时不触发。

#### 4. manual 分支提取页面安装说明

当前 manual 输出是通用 steps，应改成：

```json
"install": {
  "tool_hint": "dfu-util",
  "raw_text_excerpt": "Pyboard-D via mboot ...",
  "steps": ["...中文步骤..."],
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

最小实现不需要完美 NLP。可以按关键词规则生成 tool_hint：

| 关键词 | `tool_hint` |
| --- | --- |
| `dfu-util`、`DFU`、`.dfu` | `dfu-util` |
| `st-flash`、`ST-Link` | `st-flash` |
| `UF2`、`virtual drive` | `uf2-drag-drop` |
| `teensy_loader_cli`、`Teensy Loader` | `teensy-loader` |
| `ftp`、`/flash/sys` | `ftp-copy` |
| 未识别 | `manual` |

### sample/test 最小改法

不需要一次性新增很多页面 fixture。建议只加两个测试点：

1. 新增或替换 manual fixture：`sample/micropython_download_pybd_sf2.html`
   - 覆盖 `PYBD_SF2` 的 mboot/USR/RST/DFU 说明。
   - 新增 test：manual resolver 输出不是纯通用 steps，`tool_hint` 应为 `dfu-util` 或 `manual_dfu`，`raw_text_excerpt` 包含 `mboot` 或 `USR`。

2. 新增一个 ESP32 offset 对比 fixture 或直接用已有 C5 fixture + 增加 C3 fixture：
   - 最小只保留现有 C5 测试也可以。
   - 如果要证明不硬编码，再新增 `ESP32_GENERIC_C3` fixture，断言 offset 是 `0`，而 C5 是 `0x2000`。

现有 smoke tests 中这些必须保留：

```text
Only mock/sample tests may use a fixed `serial_port="COM3"`
Claude Code live use and real plugin use must scan real COM ports
```

### flash_mpy_firmware_manifest.py 是否要改

最小方案：可以先不改。

理由：

- 当前它已经支持 `--allow-legacy-next-phase`，足够支撑“不修改 select-hw”的迁移测试。
- `phase_complete.payload.firmware` 目前没有强制 `download_slug`，所以新增 `download_slug` 不会破坏校验。
- 等 sample 中稳定加入 `download_slug` 后，再把它变成推荐字段或可选校验。

如果要做一个很小的增强，可以只在 `board_facts_from_upstream()` 返回值里增加：

```json
"download_slug": "<从 board_url path 提取>"
```

但不作为必填错误。

### 不修改其他 skill 的运行方式

当前真实旧 select-hw 产物可能还是：

```json
"payload.next_phase": "flash-mpy-firmware"
```

因此测试旧产物时必须显式使用：

```text
flash_mpy_firmware_manifest.py --validate-upstream --allow-legacy-next-phase --input sessions/<session_id>/phase_complete.select_hw.json
```

正式新 sample 继续使用：

```json
"payload.next_phase": "upy-flash-mpy-firmware-plugin"
```

这样做的含义：

- 不阻塞当前 flash skill 的开发和验证。
- 不让旧 next_phase 扩散进新的正式输出。
- 后续再单独改 `upy-select-hw-plugin` 时，只需要移除或弱化 legacy 说明。

### 最小修改顺序

1. 改 `SKILL.md`：只补 `download_slug` 策略、`firmware_board_resolve` 可选说明、manual 字段含义表。
2. 改 `firmware_page_resolve.py`：新增 `download_slug/resolved`，增强 index 匹配，manual 解析 installation section。
3. 补 `PYBD_SF2` fixture 和一个 manual resolver 测试。
4. 视情况补 `ESP32_GENERIC_C3` offset 测试；如果想更省，先不补。
5. 跑 `python upy-flash-mpy-firmware-plugin\test\smoke_tests.py`。
6. 跑 quick_validate。

### 本方案暂不处理的内容

为保持最小改动，以下内容暂不处理：

- 不修改 `upy-select-hw-plugin` 的正式 next_phase。
- 不修改 `upy-analyze-plugin`。
- 不新增完整板卡 slug 映射库。
- 不把所有 216 个 MicroPython slug 写进 sample。
- 不实现复杂搜索/LLM 匹配，只做 URL 优先、slug exact、简单候选。
- 不自动执行任何非 ESP32/Pico 工具。
- 不扩大 Pico 专用分支到所有 RP2040/RP2350 UF2 板卡；仍仅 `RPI_PICO*` 走 Pico 专用流程，其余走 manual。

### 推荐决策

建议采用这个最小方案。它只增强 `upy-flash-mpy-firmware-plugin` 自身，能解决两个关键真实问题：

1. `board_name` 与 MicroPython 下载页 slug 不总是一回事。
2. manual 分支必须把官方页面安装说明结构化给插件 UI，而不是只给泛泛链接。

同时，它不会要求现在改其他 skill，也不会破坏现有 sample/test 的正式新协议。
