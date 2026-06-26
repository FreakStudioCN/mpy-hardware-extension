# MicroPython 六阶段插件完整工作流、文件格式与 UI 规格

日期：2026-06-27（按当前 `G:\MicroPython_Skills` 重新加载更新）

本文是 `mpy-plugin-workflow-and-ui-spec.md` 的补全版，面向 `F:\mpy-hardware-extension` 接入 `G:\MicroPython_Skills` 中 6 个插件化 MicroPython skill。资料范围包括：

- `G:\MicroPython_Skills\upy-analyze-plugin`
- `G:\MicroPython_Skills\upy-select-hw-plugin`
- `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`
- `G:\MicroPython_Skills\upy-scaffold-plugin`
- `G:\MicroPython_Skills\upy-generate-plugin`
- `G:\MicroPython_Skills\upy-deploy-plugin`
- `G:\blockless-plugin-course(1)` 下课程、架构、接口、改造、问题复盘文档
- `F:\mpy-hardware-extension\docs\micropython-skills-plugin-handoff.md`

本文只描述插件工程需要落地的阶段、文件格式、配合关系、按钮和功能要求。生产链路只接入 `-plugin` 改造版 skill。

## 1. 总体链路

主流程固定为：

```text
启动页
-> upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
-> upy-deploy-plugin
```

阶段之间唯一可靠交接物是：

```text
phase_complete.payload.manifest_content
```

本地文件、日志、草稿和调试产物只能作为证据或排错材料。下游不得从对话记忆、旧草稿、文件名、日志文本推断状态。

`upy-analyze-plugin` 可能输出：

```text
next_phase=select-hw
next_skill=/upy-select-hw-plugin
```

插件调度器必须优先使用 `next_skill`，缺失时使用显式映射表，不能只按 `next_phase` 字符串猜目录。

## 2. 协议工具

| 工具 | 执行位置 | 职责 |
|---|---|---|
| `approval_request` | UI/WebView | 用户确认、选择、补充信息、危险操作二次确认 |
| `file_operation` | VS Code 扩展宿主 | 读写项目文件、建目录、列目录、删除项目内路径 |
| `script_run` | Python shim | 运行 skill 白名单脚本、质量门禁、下载/解析/校验脚本 |
| `device_command` | Python shim/mpremote | 串口扫描、上传、软复位、REPL、设备文件系统命令 |
| `status_update` | UI 时间线 | 展示阶段进度，不阻塞 |
| `phase_complete` | 协议控制器 | 阶段 success/partial/failed 收尾并携带 manifest |

硬规则：

- 所有需要用户回答的动作必须走 `approval_request`。
- 每个阶段都必须以 `phase_complete` 收尾，包含 `success`、`partial`、`failed`。
- `partial` 必须带 checkpoint/resume 信息。
- 真实硬件运行不能固定 `COM3`，必须扫描串口并让用户选择。
- artifact/file path 使用项目内 POSIX 相对路径，例如 `firmware/main.py`。
- `resource_root`、`artifact_root`、`session_root`、`project_root`、`file_operation_root` 必须区分。

root 语义：

| 字段 | 含义 |
|---|---|
| `resource_root` | skill 资源根，例如 `third_party/MicroPython_Skills` |
| `artifact_root` | 本次会话产物根 |
| `session_root` | `sessions/<session_id>` |
| `project_root` | 生成项目目录，例如 `sessions/<session_id>/project` |
| `file_operation_root` | `file_operation` 根，通常等于项目根 |

## 3. 启动页和全局 UI

首屏必须同时承载需求、模式、板卡选择、设备工具和流程状态，不能只给一句话输入框。启动页既是主流程入口，也是可独立使用的 MicroPython 设备工作台。

| 控件 | 下游字段 | 要求 |
|---|---|---|
| 一句话需求输入 | `user_description` | 自然语言描述项目 |
| 模式选择 | `preferences.mode` | `beginner` / `custom`，默认可为 `beginner` |
| 语言 | `preferences.locale` | 默认 `zh` |
| 官方板卡选择页 | `pre_selected_board` | 基于 MicroPython 官方下载索引和本地 boards 增强覆盖层，支持搜索/筛选/分页 |
| 板卡品牌/类型/芯片系列筛选 | `pre_selected_board.vendor` / `board_type` / `chip_series` | 按品牌、板卡类型、芯片系列、MicroPython port、功能标签过滤 |
| 官方固件页面链接 | `pre_selected_board.firmware.url` | 必须是可点击链接，可打开外部浏览器/WebView，并支持复制 URL |
| 已有硬件 | `existing_hardware` | 用户已有器件清单，可为空 |
| 设备工具区 | `device_tools_context` | 可独立连接设备、管理文件、安装库、查看日志、烧录本地固件 |
| 开始生成 | `start_phase(analyze)` | 启动完整主链路 |

板卡页必须以 MicroPython 官方下载索引为全量数据源：`https://micropython.org/download/`。当前 `G:\MicroPython_Skills\upy-analyze-plugin\boards` 不是官方全量缓存目录，而是本地增强覆盖层，表示已有 pin layout、板载外设、禁用 GPIO、匹配规则等增强信息的板卡。插件 UI 必须抓取/缓存官方全量索引，并把官方板卡与本地增强层做 overlay：官方索引用于“可选择哪些板卡和固件页”，本地 boards 用于“哪些板卡已具备 pin layout 和规则增强”。网络失败时读取插件侧官方索引缓存，并在 UI 上显示缓存时间和过期风险。

插件侧官方板卡缓存建议结构如下。缓存可以放在宿主工作区、session 缓存或后续明确的 generated cache 目录；不要假设当前 `upy-analyze-plugin/boards` 已经存在这些官方全量文件。

```text
board_official_cache/
  official-index.json
  official-cache/<board_id>.json
  images/<board_id>.<ext>
  vendors/<vendor>.json
  board-types/<board_type>.json
  chip-series/<chip_series>.json
```

当前本地增强目录继续保留：

```text
upy-analyze-plugin/boards/
  _template.json
  matching-rules.json
  <local-enhanced-board>.json
```

`pre_selected_board` 最低结构：

```json
{
  "id": "ESP32_GENERIC_C3",
  "display_name": "ESP32-C3",
  "vendor": "Espressif",
  "board_type": "devkit",
  "chip_series": "ESP32-C3",
  "port": "esp32",
  "mcu": "ESP32-C3",
  "features": ["BLE", "WiFi"],
  "firmware": {
    "url": "https://micropython.org/download/ESP32_GENERIC_C3/",
    "board_name": "ESP32_GENERIC_C3"
  },
  "download_slug": "ESP32_GENERIC_C3",
  "source_url": "https://micropython.org/download/",
  "image": {
    "local_path": "boards/images/ESP32_GENERIC_C3.webp",
    "source_url": "https://micropython.org/...",
    "attribution": "MicroPython official board/download page"
  },
  "local_support": {
    "pin_layout_available": false,
    "pin_layout_path": null
  },
  "fetched_at": "2026-06-26T00:00:00Z"
}
```

板卡 UI 要求：

| 功能 | 要求 |
|---|---|
| 数据源 | 抓取/缓存 `https://micropython.org/download/` 官方索引；再叠加 `upy-analyze-plugin/boards` 的本地增强信息 |
| 官方图片 | 尽量从官方板卡页/下载页爬取并下载到插件侧官方图片缓存，UI 使用本地缓存图；无图时显示占位图 |
| 图片合规 | 保存 `image.source_url`、`image.attribution`、`fetched_at`，避免正常 UI 只依赖远程热链 |
| 搜索 | 板卡名、Vendor、MCU、Port、firmware board name、download slug、Feature |
| 筛选 | Vendor/品牌、`board_type`、`chip_series`、Port、MCU、Feature、本地 pin layout 支持状态 |
| 分类 | 插件侧官方缓存生成 `vendors/`、`board-types/`、`chip-series/` 分类索引，便于启动页快速筛选 |
| 分页/虚拟列表 | 全量板卡不能一次性塞成长列表 |
| 卡片展示 | 官方图片、显示名、Vendor、板卡类型、芯片系列、Port、MCU、Feature、官方固件页、download slug |
| 固件 URL | “官方固件页”必须是可点击按钮/链接，点击打开 `firmware.url`，不能只显示纯文本 |
| 本地支持标识 | 区分“有 pin_layout/外设/禁用 GPIO 增强信息”与“仅官方固件可用” |
| 缓存 | 记录 `fetched_at`、`source_url`、缓存版本；网络失败读旧缓存并提示过期风险 |

设备工具区必须常驻在启动页或可从启动页一键打开，功能参考 Thonny 设备文件视图和 `aily-blockly` 的 FFS/串口工具，但 MicroPython 实现优先走 `mpremote`/`pyserial`/既有 shim。该工具区不依赖主流程是否已经走到 deploy。

| 工具页/按钮 | 功能 | 协议/脚本要求 |
|---|---|---|
| 扫描端口 | 枚举串口、显示 VID/PID/serial/manufacturer | `device_command`，带 timeout |
| 连接/断开 REPL | 打开串口 REPL、持续监听输出 | 独占串口，上传/烧录前自动释放并可恢复 |
| 设备文件浏览器 | 展示 `/`、`/lib` 等设备端目录树 | `mpremote fs ls` 或 shim，支持刷新和错误重试 |
| 刷新目录 | 重新读取当前目录 | 幂等，可重试 |
| 上传文件 | 上传本地文件到设备指定路径 | 覆盖前 `approval_request`，记录 file manifest |
| 上传文件夹 | 递归上传目录 | 预览变更清单，大文件显示进度 |
| 下载文件 | 从设备下载到本地项目/临时目录 | 选择保存位置，记录 artifact |
| 新建目录 | 在设备端创建目录 | 已存在视为成功或提示冲突 |
| 删除文件/目录 | 删除设备端文件或目录 | 必须二次确认，目录删除默认不递归，递归需显式选择 |
| 重命名/移动 | 修改设备端路径 | 覆盖目标前确认 |
| 双击查看设备文件 | 读取设备端文本文件并在只读/可编辑视图打开 | 二进制文件显示下载提示，不强行文本解码 |
| 保存到设备 | 将编辑后的内容写回设备端文件 | 写前保存 checkpoint，失败可重试 |
| 比较本地/设备文件 | 对比大小、mtime/hash 或内容 | 只读操作，失败不阻塞主流程 |
| 读取日志/清空日志 | 查看、下载、清理板端日志 | 删除/清空需确认 |
| 运行设备测试 | 执行 `device/tests` | 输出结构化 `device_tests_result.json` |
| 安装库 | 从 uPyPI(upypi.net) / micropython-lib 安装到 `/lib` | 网络、下载、写设备均需要结构化状态 |
| 选择本地固件烧录 | 选择本地 `.bin` / `.uf2` / 受支持固件文件并烧录 | 调用 `upy-flash-mpy-firmware-plugin`，区别于普通文件上传 |
| 打开官方固件页 | 打开当前板卡 `firmware.url` | 链接按钮，支持复制 |

必须清晰区分两个“烧录/上传”概念：

| 名称 | 含义 | 插件 |
|---|---|---|
| 固件烧录 | 烧录 MicroPython 解释器固件，包含官方固件下载和本地固件选择 | `upy-flash-mpy-firmware-plugin` |
| 项目/文件上传 | 上传 `main.py`、驱动、资源、库到设备文件系统 | `upy-deploy-plugin` 或设备文件浏览器 |

库管理器必须支持从 uPyPI(upypi.net) 和 `micropython-lib` 获取库。uPyPI 的接口和使用流程以 `G:\MicroPython_Skills\upy-pkg-guide\SKILL.md` 为准，同时可参考 `G:\thonny-upypi-manager-main` 的 UI 能力：搜索包、查看元数据、下载多文件包到本地缓存、安装到设备 `/lib`。标准安装优先使用 `mpremote mip install {package_url}/package.json`；当包不是标准 uPyPI 包或 fallback 来源不支持 `mip` 时，再走下载缓存后逐文件复制。所有网络访问、写设备、覆盖、删除都必须进入权限提示和 artifact manifest。

库管理输出建议：

```text
library_cache/index.json
library_cache/<package_name>/package.json
library_install_plan.json
library_install_result.json
mip_install_result.json
```

全局按钮：

| 按钮 | 功能 | 调用对象 |
|---|---|---|
| 一句话生成硬件 | 从 analyze 跑完整主链路 | orchestrator |
| 选择/确认硬件 | 进入硬件选型和引脚确认 | `upy-select-hw-plugin` |
| 打开官方固件页 | 打开当前板卡可点击 `firmware.url` | UI/WebView |
| 烧录 MicroPython 固件 | 下载并烧录官方解释器固件 | `upy-flash-mpy-firmware-plugin` |
| 选择本地固件烧录 | 选择本地 `.bin`/`.uf2` 后烧录 | `upy-flash-mpy-firmware-plugin` |
| 生成项目骨架 | 生成 firmware/tools/.upy | `upy-scaffold-plugin` |
| 生成业务代码 | 生成 driver/task/main/test | `upy-generate-plugin` |
| 部署到设备 | 上传、复位、日志、测试、判定 | `upy-deploy-plugin` |
| 扫描串口 | 枚举真实串口 | `list_serial_ports.py` / shim |
| 串口输出/REPL 监听 | 持久监听设备输出 | `capture_repl.py` 或宿主封装 |
| 设备文件浏览器 | 查看、上传、下载、删除、双击查看设备端文件 | `mpremote fs` / shim |
| 安装库 | uPyPI(upypi.net) / micropython-lib 搜索、下载、安装到 `/lib` | `mpremote mip` / package shim |
| 读取设备日志 | tail/download/clear | `project/tools/read_device_log.py` |
| 运行硬件测试 | 运行 device tests | `run_device_tests.py` |
| 环境检测 | Python/mpremote/串口/REPL probe | Doctor / shim |
| 可视化 Git 变更历史 | 查看项目提交、文件 diff、阶段版本和 artifact 关联 | Git/history provider，只读 |
| 保存当前版本 | 用户输入版本名和版本摘要，保存当前项目状态 | Git commit/tag 或 session snapshot |

## 4. 通用 start_phase 结构

最小可落地启动消息：

```json
{
  "protocol_version": "1.0",
  "type": "start_phase",
  "phase": "analyze",
  "session_id": "<session_id>",
  "idempotency_key": "analyze:<session_id>:v1",
  "payload": {
    "user_description": "温度超过 30 度时点亮 LED，并在 OLED 显示温度",
    "pre_selected_board": null,
    "preferences": {
      "mode": "beginner",
      "locale": "zh"
    },
    "existing_hardware": [],
    "runtime_context": {
      "resource_root": "third_party/MicroPython_Skills",
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/<session_id>",
      "project_root": "sessions/<session_id>/project",
      "file_operation_root": "sessions/<session_id>/project"
    },
    "capabilities": {
      "approval_request": true,
      "file_operation": true,
      "script_run": true,
      "device_command": true,
      "serial_port_scan": true,
      "checkpoint_resume": true,
      "cancellation": true
    }
  }
}
```

## 5. 阶段一：upy-analyze-plugin

职责：把用户自然语言和首屏上下文转成稳定需求 manifest，确认器件，搜索驱动，给硬件选型阶段交接。

### 输入

| 字段 | 要求 |
|---|---|
| `user_description` | 必填，自然语言需求 |
| `preferences.mode` | `beginner` / `custom`，由首屏提供 |
| `preferences.locale` | 默认 `zh` |
| `pre_selected_board` | 可为 `null`，来自首屏官方板卡页 |
| `existing_hardware` | 可为空数组 |

### 步骤

1. 读取插件输入上下文。
2. 拆解意图：功能、场景、器件、接口、供电、网络、输出方式。
3. 发送 `approval_request(device_confirm)`，这是 analyze 主流程唯一必经确认点。
4. 需要场景/供电/性能/输出补充时，最多收敛成一张 `approval_request(requirement_supplement)`。
5. 搜索驱动并分类：`builtin_runtime`、`micropython_lib`、`upypi`、`awesome-micropython`、`github`、`none`、`cold-driver`。
6. 系统推荐器件无驱动时可发 `approval_request(alternative_device)`；用户指定器件无驱动时进入 cold driver 标记。
7. 运行 `scripts/init_manifest.py` 校验 manifest 和 phase_complete。
8. 输出 `phase_complete(result=success, next_phase=select-hw, next_skill=/upy-select-hw-plugin)`。

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `device_confirm` | 确认、增删、修改器件清单 | 确认、修改、补充 |
| `requirement_supplement` | 补充场景、供电、性能、输出要求 | 提交、保存、取消 |
| `alternative_device` | 替代器件推荐 | 使用替代、坚持原器件、保存 |

### 文件和格式

| 文件/字段 | 用途 |
|---|---|
| `manifest_content` | 下游唯一交接物 |
| `phase_complete.analyze.json` | 直测调试产物，正式流程不能作为唯一事实源 |
| `driver_search_log.md` | 驱动搜索证据，只作审计/排错 |
| `scripts/init_manifest.py` | 生成/校验 manifest 与 phase_complete |

`manifest_content` 最低字段：

```text
schema_version
phase="analyze"
created_at
updated_at
project_name
requirements
devices[]
pre_selected_board
warnings
```

器件行为事实必须保留在器件级字段。例如 TTP223 “按下低电平”应写入 `devices[].notes`，并尽量结构化为 `devices[].behavior.active_level="low"`。

## 6. 阶段二：upy-select-hw-plugin

职责：消费 analyze manifest，完成开发板/MCU 确认、MicroPython 固件事实核验、引脚分配、BOM 和硬件选择。

### 输入

| 输入 | 要求 |
|---|---|
| 上游 `phase_complete.payload.manifest_content` | 必须来自 analyze，`phase="analyze"` |
| `pre_selected_board` | 来自首屏，可跳过 `board_select` 但仍需校验固件和 pin_layout |
| `user_pin_constraints` | 可选，用户指定接线时必须结构化传入 |
| 板卡资源 | 官方全量板卡列表 + 本地有 pin_layout 的 boards |

用户接线约束格式：

```json
{
  "device": "AHT20",
  "device_pin": "SDA",
  "mcu_pin": "GPIO8",
  "signal": "I2C0 SDA",
  "voltage": "3V3",
  "notes": "optional"
}
```

### 步骤

1. 校验上游 `manifest_content.phase="analyze"`。
2. 加载需求、器件、预选板卡、已有硬件。
3. 无预选板卡时发 `approval_request(board_select)`。
4. 预选板卡缺本地 pin_layout 或固件事实不足时发 `approval_request(board_unavailable)` 或 `partial`。
5. 生成 MCU/board/firmware facts。
6. 根据 board JSON 的 `pin_layout`、restricted pins、onboard peripherals、默认总线引脚生成 pin plan。
7. 有 `user_pin_constraints` 时优先使用用户接线，`pinout[].source="user_wiring"`。
8. 发 `approval_request(pin_plan_review)`，用户未确认前不能 success。
9. 生成 `hardware_selection`、`pinout`、`pin_decisions`、`bom`、`hardware_plan`。
10. 运行 `scripts/select_hw_manifest.py` 校验 draft、validated manifest 和 phase_complete。
11. 输出 `phase_complete(result=success, next_phase=upy-flash-mpy-firmware-plugin)`。

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `board_select` | 选择目标开发板 | 选择此板卡、系统推荐、取消 |
| `board_unavailable` | 官方有固件但本地无 pin_layout/资料不足 | 换已支持板卡、手动补资料、保存 checkpoint |
| `pin_plan_review` | 确认引脚分配 | 确认、修改、保存 |

### 输出字段

| 字段 | 说明 |
|---|---|
| `manifest_content.phase="select-hw"` | 阶段标识 |
| `mcu` | MCU、port、firmware board name、固件 URL |
| `hardware_selection` | 已选板卡和选择理由 |
| `pinout[]` | 设备到 MCU 引脚连接 |
| `pin_decisions[]` | 分配来源、理由、deviation、validator action |
| `pin_review` | 用户确认结果，success 时必须 `confirmed=true` |
| `bom[]` | 物料清单 |
| `hardware_plan` | 估价、风险、总览 |
| `warnings` | 非阻塞风险 |

正式产物：

```text
sessions/<session_id>/select_hw_draft.json
sessions/<session_id>/select_hw_validated.json
sessions/<session_id>/phase_complete.select_hw.json
sessions/<session_id>/pin_assignment_log.md
sessions/<session_id>/select_hw_phase_log.md
```

partial checkpoint 必须包含：

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

常见错误码：`missing_pin_layout`、`restricted_gpio_used`、`default_bus_pin_deviation`、`pin_review_required`、`pin_review_rejected`、`artifact_missing`、`absolute_path_in_artifact`、`phase_complete_invalid`。

## 7. 阶段三：upy-flash-mpy-firmware-plugin

职责：准备、下载或烧录 MicroPython 解释器固件。不部署业务代码。

### 输入

| 输入 | 要求 |
|---|---|
| 上游 `phase_complete.select_hw` | `result=success`，`next_phase=upy-flash-mpy-firmware-plugin` |
| `manifest_content.phase` | `select-hw` |
| `firmware_action` | 可选；缺失时必须先审批 |
| `firmware_override` | 可选，本地固件或自定义 URL |
| capabilities | ESP32 真实烧录需要 `serial_port_scan` 和 `device_flash` |

`firmware_action` 枚举：

```text
download_and_flash
download_only
already_flashed
use_local_firmware
save_partial
cancel
```

### 分支

| 分支 | 条件 | 行为 |
|---|---|---|
| ESP32 | `firmware_board_name` 以 `ESP32_` 开头、`firmware.port="esp32"` 或 `chip_family` 为 esp32 | 解析 `.bin`，下载，扫描串口，用户确认后运行 esptool |
| Pico/RP2 | `firmware_board_name` 以 `RPI_PICO` 开头 | 解析 `.uf2`，提示 BOOTSEL 拷贝，用户确认后 success |
| Manual | 其他 MicroPython 板卡 | 展示官方页面和手动说明，只等待用户确认 |

### 步骤

1. 校验上游 select-hw phase_complete。
2. 解析 `hardware_selection.selected_board.firmware.url` 或兜底匹配官方下载页。
3. 缺 `firmware_action` 时发 `approval_request(firmware_action_select)`。
4. `already_flashed` 直接输出 success，标记 `firmware.status="skipped_user_confirmed"`。
5. `download_only`、`save_partial`、取消、超时输出 partial + checkpoint。
6. 运行 `firmware_page_resolve.py` 解析固件页。
7. 下载固件或使用 `firmware_override.local_path`。
8. ESP32 分支扫描端口并发 `approval_request(esp32_flash_confirm)`。
9. ESP32 分支检查/安装技能内 esptool，执行 plan 和 flash。
10. Pico 分支发 `approval_request(pico_uf2_drag_drop)`。
11. Manual 分支发 `approval_request(manual_firmware_flash_confirm)`。
12. 运行 `flash_mpy_firmware_manifest.py` 校验 state 和 phase_complete。
13. 输出 `phase_complete(result=success, next_phase=upy-scaffold-plugin)`。

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `firmware_action_select` | 选择本阶段动作 | 下载并烧录、仅下载、已烧录、使用本地固件、保存、取消 |
| `esp32_flash_confirm` | 选择端口并确认擦写 | 开始烧录、重新扫描、取消 |
| `pico_uf2_drag_drop` | 指导 BOOTSEL/UF2 复制 | 已复制、保存、取消 |
| `manual_firmware_flash_confirm` | 手动烧录确认 | 已刷好、打开官方页面、保存 |

### 脚本和产物

| 脚本 | 用途 |
|---|---|
| `firmware_page_resolve.py` | 解析 MicroPython 下载页、固件 URL、安装说明 |
| `firmware_download.py` | 下载固件或输出下载计划 |
| `list_serial_ports.py` | 扫描串口 |
| `find_uf2_mount.py` | 发现 Pico UF2 挂载点，只报告不自动复制 |
| `bootstrap_esptool.py` | 检查/安装技能内 esptool |
| `esptool_runner.py` | 运行技能内 `python -m esptool` |
| `esp32_flash.py` | ESP32 擦除/写入计划和执行 |
| `flash_mpy_firmware_manifest.py` | 校验 start/state/phase_complete |

正式产物：

```text
sessions/<session_id>/flash_mpy_firmware_state.json
sessions/<session_id>/firmware_page_resolved.json
sessions/<session_id>/firmware_download.json
sessions/<session_id>/firmware/<downloaded-file>
sessions/<session_id>/serial_ports.json
sessions/<session_id>/esptool_plan.json
sessions/<session_id>/phase_complete.upy_flash_mpy_firmware_plugin.json
```

`manifest_content` 必须保留完整上游 select-hw manifest，并追加：

```text
phase="upy-flash-mpy-firmware-plugin"
firmware_flash=<payload.firmware 同等事实>
```

ESP32 成功烧录时 `firmware_flash.flash_result` 必须包含 `baud`、`chip`、`write_offset`，且 `write_offset` 使用 MicroPython 页面解析到的原值。

## 8. 阶段四：upy-scaffold-plugin

职责：创建项目骨架，只搭 `firmware/`、`tools/`、`.upy/` 等工程结构，不写业务 task、不填驱动实现。

### 输入

| 输入 | 要求 |
|---|---|
| 上游 flash phase_complete | 正式链路要求 `result=success` 且 `next_phase=upy-scaffold-plugin` |
| `manifest_content` | 优先读 flash 的完整 manifest，缺失时追溯 select-hw manifest |
| `mode` | `full` / `incremental` |
| scheduler mode | `mode_timer` / `mode_async` / `mode_thread` |
| modules | logger、time helper、maintenance、flash、log tools |

### full 步骤

1. 校验上游 `phase_complete(upy-flash-mpy-firmware-plugin)`。
2. 读取 `mcu`、`devices`、`pinout`、`bom`、`requirements`、`firmware_flash`。
3. 发 `approval_request(scaffold_config)`，把调度模式、模块、自定义文件合并到一张卡片。
4. 运行 `scripts/init_scaffold.py`，脚本 stdout 输出 JSON，不直接写项目目录。
5. 将 `directories[]`、`files[]` 转成 `file_operation` 写入 `project_root`。
6. 在 `project_root` 执行 `python -m flake8 --jobs=1 firmware tools`。
7. 生成 `scaffold_file_manifest.json`。
8. 输出 `phase_complete(result=success, next_phase=upy-generate-plugin)`。

### incremental 步骤

新增器件场景可用 `mode=incremental`，只允许生成新增器件 driver stub 和更新 `project-manifest.json`，不得重写 `main.py`、`board.py` 等既有骨架。输出必须带：

```text
incremental=true
generate_scope="new_devices_only"
```

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `scaffold_config` | 选择调度模式、模块、自定义文件 | 生成骨架、修改、保存 |

调度推荐规则只影响推荐，不限制用户选择：

| 条件 | 推荐 |
|---|---|
| Wi-Fi / display / LVGL / 并发 IO | `mode_async` |
| 简单周期任务 | `mode_timer` |
| 明确多线程需求 | `mode_thread` |

模块映射：

| id | 输出 |
|---|---|
| `module_logger` | `firmware/lib/logger/*` |
| `module_time_helper` | `firmware/lib/time_helper.py` |
| `module_maintenance` | `firmware/tasks/maintenance.py` |
| `module_flash` | `tools/flash_device.py` |
| `module_log_tools` | `tools/read_device_log.py` + `tools/log_report.py` |

### 输出文件和约束

| 文件 | 说明 |
|---|---|
| `firmware/boot.py` | 启动文件 |
| `firmware/board.py` | 引脚常量和查询函数，不实例化硬件 |
| `firmware/conf.py` | 配置常量，不写密钥 |
| `firmware/main.py` | 硬件实例化和调度框架，业务注册留 TODO |
| `firmware/lib/` | logger/scheduler/time helper |
| `firmware/tasks/maintenance.py` | 维护任务骨架 |
| `tools/flash_device.py` | 项目上传工具 |
| `tools/read_device_log.py` | 设备日志读取工具 |
| `tools/log_report.py` | 日志摘要工具 |
| `.flake8` | MicroPython-aware flake8 配置 |
| `project-manifest.json` | 项目 manifest |
| `scaffold_file_manifest.json` | 实际写入结果 |

输出约束：

- `conf.py` 不得写 Wi-Fi 密码、API Key、token。
- `phase_complete.payload.artifacts` 至少包含 `file_tree`、`file_list`、`file_manifest`。
- `file_operations[].payload.path` 相对 `project_root`，不要带 `sessions/<id>/project` 前缀。
- 文件重试语义：缺失为 `created`，相同为 `unchanged`，冲突未授权为 `skipped` + partial，授权覆盖为 `updated`。
- success manifest 必须设置 `manifest_content.phase="scaffold"`、`domain_phase="scaffold"`、`final_status="scaffolded"`，并保留上游 `firmware_flash` 事实。

## 9. 阶段五：upy-generate-plugin

职责：在 scaffold 基础上生成业务代码、驱动适配、任务、配置、PC 测试、设备端 MicroPython unittest，并通过质量门禁和 git commit。

### 输入

| 输入 | 要求 |
|---|---|
| 上游 scaffold phase_complete | `result=success` 且 `next_phase=upy-generate-plugin` |
| `mode` | `full` / `fix` |
| `project_root` | 必填 |
| `file_operation_root` | 必填，通常等于 project_root |
| `error_context` | fix 模式必填 |

fix 模式输入示例：

```json
{
  "type": "start_phase",
  "phase": "upy-generate-plugin",
  "payload": {
    "mode": "fix",
    "source": "user_feedback_after_deploy",
    "error_context": {
      "user_feedback": "设备上电后 OLED 没显示，串口只打印 boot ok",
      "deploy_result_path": "sessions/<session_id>/phase_complete.upy_deploy_plugin.json",
      "serial_excerpt": "...",
      "previous_generate_commit": "abc123"
    }
  }
}
```

### 必读资源

| 时机 | 文件 |
|---|---|
| 协议字段和 phase_complete | `references/protocol_fields.md` |
| full/fix 生成前 | `references/legacy_constraints.md` |
| driver factory/mock | `references/driver_factory_templates.md` |
| task 和 PC 测试 | `references/task_generation_rules.md` |
| device unittest | `references/device_unittest_subset.md` |
| `conf.py` / `main.py` | `references/main_conf_rules.md` |
| MicroPython API | `knowledge/micropython_official_library_index.json` |
| 云服务/API | `references/cloud_integrations.md`、`knowledge/cloud_service_catalog.json` |
| 质量门禁 | `references/validation_gates.md` |
| success/commit 前 | `references/final_review_checklist.md` |

### full 步骤

1. 校验上游 scaffold phase_complete，并运行 `check_session_state.py` 防止 stale generate 记录误导恢复。
2. 读取 `manifest_content`、`firmware/board.py`、`firmware/conf.py`、`firmware/main.py`、`.flake8`。
3. 可发 `approval_request(generate_behavior)` 补充业务行为、阈值、周期、状态机、日志、模拟场景。新增硬件或改引脚必须回退 analyze/select-hw/scaffold。
4. 写 `generate_plan.json`，先规划不大规模写代码。
5. 运行 `check_generate_plan.py`。
6. 用英文关键词解析驱动和中间件依赖，先查 uPyPI(upypi.net)，再查 awesome-micropython / 官方 / GitHub fallback。
7. 涉及云服务时要求用户确认官方文档、控制台、价格、计费、凭据准备状态；真实密钥不得写入代码、日志、phase_complete 或 git。
8. 运行 `download_drivers.py`，输出 `files[]` 转为 `file_operation(write)` 到 `firmware/lib/...`。
9. 生成 `firmware/drivers/<name>_driver/__init__.py` 和 `mock.py`，mock 签名必须来自驱动源码。
10. 按 scheduler 生成 business tasks。
11. 复用 scaffold logger/time helper/maintenance/scheduler，不重复生成基础库。
12. 更新 `conf.py`，阈值、周期、日志、重试放配置；不硬编码到 task/main。
13. 使用硬件/外设/端口 API 前查 MicroPython 官方文档索引，并写入 `doc_evidence[]`。
14. 更新 `main.py`：启动延时、logger、DI 装配、I2C scan、print + logger 双写关键状态。
15. 生成 PC unittest 和 `device/tests/test_*.py`。设备端测试必须符合 MicroPython unittest 子集；如使用 `unittest`，声明 `runtime_dependencies.mip`。
16. 运行完整质量门禁。
17. 最终审查并输出 `review_findings`。
18. 运行 `check_phase_complete_consistency.py` 和 `check_final_review_consistency.py`。
19. 质量通过后 git commit；full 和 fix 成功都必须 commit。
20. 输出 `phase_complete(result=success, next_phase=upy-deploy-plugin)`。云服务 blocked/mock-only 时不得默认 deploy。
21. 可提供 `optional_next_phases`：diagram/wiring/simulate 等，不覆盖主 `next_phase`。

### fix 步骤

1. 读取 `error_context`、`generate_fix_history.json`、上次 commit。
2. 只做最小修改，不重写整个项目。
3. 根据错误类型决定边界：业务逻辑/驱动 API/阈值/日志走 generate fix；引脚/I2C 地址/总线冲突建议 select-hw 或人工确认；烧录/串口/上传失败留给 deploy。
4. 修改后重跑相关质量门禁。
5. 通过后 git commit。
6. 输出 `code_diff`、`changed_files`、`attempts[]`、`knowledge_refs[]`。

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `generate_behavior` | 补充业务行为、阈值、输出、云服务参数 | 继续生成、只生成代码、转模拟、保存 |

### 质量门禁

统一入口：

```text
scripts/run_quality_gates.py --project-dir <project_root> --session-dir <session_root>
```

应覆盖：

```text
ensure .pylintrc
check_generate_plan.py
py_compile
check_conf_contract.py
check_driver_source_compile.py
flake8
pylint
PC unittest
check_mpy_imports.py
check_dead_config.py
check_task_no_machine_import.py
check_device_unittest_subset.py
check_runtime_dependencies.py
check_doc_evidence.py
check_skeleton_compliance.py
check_generated_semantics.py
check_cloud_integrations.py
update_session_state.py --check
check_final_review_consistency.py
check_phase_complete_consistency.py
```

### 输出文件和字段

| 路径/字段 | 说明 |
|---|---|
| `generate_plan.json` | 生成计划 |
| `project-manifest.json` | 完整项目 manifest，`phase="generate"` |
| `session_state.upy_generate_plugin.json` | checkpoint/resume/idempotency |
| `firmware/lib/` | 驱动和依赖 |
| `firmware/drivers/` | driver adapter 和 mock |
| `firmware/tasks/` | 业务任务 |
| `firmware/conf.py` | 配置 |
| `firmware/main.py` | 入口和 DI 装配 |
| `test/pc/` | PC 测试 |
| `device/tests/test_*.py` | MicroPython 设备端合约测试 |
| `manifest_content.generate.runtime_dependencies.mip` | deploy 通过 `mpremote mip install` 安装 |
| `manifest_content.generate.doc_evidence[]` | 官方文档证据 |
| `file_manifest` artifact | 产物清单 |
| `generate.git.commit` | 生成或修复提交 |

成功硬约束：

- `manifest_content` 必须保留完整上游字段，不得只写摘要。
- `file_manifest.files` 必须包含 `project-manifest.json` 和 `generate_plan.json`。
- 必须包含 `session_state` artifact。
- 成功必须有 git commit；拒绝 commit、dry-run、非 git repo、跳过 commit 都应 partial。
- 需要 mip 包时必须声明 runtime dependency，由 deploy 安装。
- 云服务凭据未准备、mock-only 或 blocked 时不能默认进入 deploy。

## 10. 阶段六：upy-deploy-plugin

职责：把生成项目部署到真实设备，安装运行时依赖，上传 firmware，软复位，捕获 REPL，读取日志，运行设备测试，汇总结果，并把失败反馈给 generate fix/autofix。

### 输入

| 输入 | 要求 |
|---|---|
| 上游 generate phase_complete | `result=success`，`next_phase=upy-deploy-plugin` |
| `manifest_content.phase` | `generate` |
| `project_root` | 包含 `project-manifest.json`、`firmware/`、`tools/` |
| `deploy_strategy` | `upload_only` / `clean_then_upload` / `erase_then_upload` / `save_partial` |
| capabilities | `device_command`、`serial_port_scan`、`script_run`、`approval_request` |

部署策略：

| 策略 | 说明 |
|---|---|
| `upload_only` | 不清理设备文件，直接上传 |
| `clean_then_upload` | dry-run 后清理项目相关文件再上传，推荐默认 |
| `erase_then_upload` | dry-run + 二次确认后擦除设备文件系统再上传 |
| `save_partial` | 保存 checkpoint |

`erase_then_upload` 只清理 MicroPython 文件系统，不等同于重刷解释器固件。

### 步骤

1. 校验 start_phase 和上游 generate phase_complete。
2. 读取 `project_root`、`project-manifest.json`、`firmware/`、`tools/`。
3. 运行 `check_environment.py` 检查 mpremote；缺失时返回 action_required，不碰设备。
4. 运行 `list_serial_ports.py` 扫描真实串口。
5. 发 `approval_request(deploy_port_select)`。
6. 发 `approval_request(deploy_strategy_select)`。
7. 选择清理时先运行 `clean_device_project.py --dry-run` 并展示列表。
8. `clean_then_upload` 确认后清理项目文件；`erase_then_upload` 必须二次确认后执行。
9. 根据 `runtime_dependencies.mip` 运行 `install_mip_dependencies.py`，使用 `mpremote mip install`，安装前后 probe import。
10. 运行 `project/tools/flash_device.py --compile --upload --no-reset --port <port> --json-summary` 上传项目。
11. 软复位并运行 `wait_for_device.py`。
12. 使用 `capture_repl.py` 持久采集 REPL 输出。
13. 运行 `project/tools/read_device_log.py` 和 `log_report.py`。
14. 发 `approval_request(run_device_tests)`。
15. 用户选择运行时执行 `run_device_tests.py`，测试来源为 `device/tests/test_*.py` 和兼容旧路径 `test/device/test_*.py`。
16. 运行 `deploy_result.py` 汇总 upload、mip、REPL、日志、device tests。
17. PASS/PASS_WITH_WARNINGS 发 `approval_request(deploy_result_feedback)`。
18. FAIL/NEEDS_USER_CONFIRMATION 发 `approval_request(deploy_fail_next_action)`。
19. 输出 `phase_complete`。

### 审批卡片和按钮

| approval_id | 用途 | 典型按钮 |
|---|---|---|
| `deploy_port_select` | 选择真实串口 | 选择端口、重新扫描、取消 |
| `deploy_strategy_select` | 选择部署策略 | 清理后上传、仅上传、擦除后上传、保存 |
| `confirm_clean_device_project` | 确认清理项目文件 | 确认清理、取消 |
| `confirm_erase_device_fs` | 二次确认擦除文件系统 | 我确认擦除、取消 |
| `run_device_tests` | 是否运行设备端测试 | 运行测试、跳过 |
| `deploy_result_feedback` | 部署通过后的用户反馈 | 完成、继续优化、进入 fix、上传项目库 |
| `deploy_fail_next_action` | 部署失败后的下一步 | autofix、generate fix、保存 checkpoint |

### 设备工具区按钮

| 按钮 | 功能 |
|---|---|
| 扫描端口 | 刷新串口列表 |
| 连接 REPL | 开始持久监听 |
| 停止 REPL | 停止监听 |
| 清屏 | 清空 UI 输出 |
| 保存输出 | 保存最近串口输出 |
| 复制输出 | 复制最近输出 |
| 设备探测 | 发送轻量 REPL probe |
| 读取日志 | tail 板端日志 |
| 下载日志 | 下载板端日志 |
| 清空日志 | 清理板端日志 |
| 运行设备测试 | 运行 `device/tests` |
| 清理项目 dry-run | 预览将删除的项目文件 |
| 擦除设备 dry-run | 预览将擦除的完整文件树 |

### 脚本和产物

| 脚本 | 用途 |
|---|---|
| `check_environment.py` | mpremote/pyserial 环境检查 |
| `list_serial_ports.py` | 串口扫描 |
| `mpremote_runtime.py` | mpremote 解析和调用封装 |
| `clean_device_project.py` | dry-run/execute 清理设备文件 |
| `install_mip_dependencies.py` | 安装 `runtime_dependencies.mip` |
| `wait_for_device.py` | soft reset 后等待设备恢复 |
| `capture_repl.py` | 持久 REPL 输出采集 |
| `run_device_tests.py` | 运行设备端 unittest |
| `deploy_result.py` | 汇总部署结果 |
| `deploy_manifest.py` | 校验 deploy start/upstream/phase_complete |

正式产物：

| 文件/字段 | 说明 |
|---|---|
| `upload_summary.json` | 上传结果 |
| `clean_result.json` | 清理/擦除结果 |
| `mip_install_result.json` | 运行时依赖安装结果 |
| `repl_capture.log/json` | 串口输出 |
| `device_log_report.json` | 设备日志摘要 |
| `device_tests_result.json` | 设备测试结果 |
| `deploy_result.json` | 综合判定 |
| `manifest_content.deploy` / `deploy_result` | 部署事实 |

### 结果和回路

- `PASS` 或 `PASS_WITH_WARNINGS`：展示结果反馈卡，可完成、继续优化、进入 fix、上传项目库。
- `FAIL` 或 `NEEDS_USER_CONFIRMATION`：必须构造完整 `error_context`，优先进入 `upy-autofix-plugin`；未落地时回到 `upy-generate-plugin(mode=fix, source=deploy_fail)`。
- REPL 空输出不应直接判失败；若上传、日志、测试正常，应为 warning 或 PASS_WITH_WARNINGS。
- 崩溃日志读取优先使用 `resume fs` 保留现场，避免先 soft reset 改变证据。
- device tests 失败要区分依赖安装失败、runner 失败、业务合约失败。

## 11. 跨阶段配合关系

| 上游阶段 | 输出核心字段 | 下游如何消费 |
|---|---|---|
| analyze | `requirements`、`devices`、`pre_selected_board`、driver facts | select-hw 选板卡、分配引脚、判断 cold driver |
| select-hw | `mcu`、`hardware_selection`、`pinout`、`pin_decisions`、`bom`、`firmware` | flash 解析固件；scaffold 生成 board/conf |
| flash | `firmware_flash`、固件文件、烧录状态、端口事实 | scaffold 确认解释器已就绪 |
| scaffold | `scaffold`、`scheduler`、modules、项目结构、file_manifest | generate 填充业务代码和测试 |
| generate | `generate_plan`、代码、`runtime_dependencies.mip`、`doc_evidence`、`file_manifest`、git commit | deploy 安装依赖、上传、测试 |
| deploy | `deploy_result`、REPL/log/test/mip/upload 证据、`error_context` | generate fix / autofix / 项目库发布 |

`manifest_content` 是累积结构：每阶段只追加/更新自己负责的字段，不得删除上游字段。

主项目文件格式：

| 文件 | 生产阶段 | 用途 |
|---|---|---|
| `project-manifest.json` | scaffold/generate/deploy | 项目本地状态 |
| `phase_complete.<phase>.json` | 各阶段 | 阶段协议事件记录 |
| `generate_plan.json` | generate | 生成计划 |
| `session_state.upy_generate_plugin.json` | generate | checkpoint/resume/idempotency |
| `firmware/**/*.py` | scaffold/generate | 设备端代码 |
| `tools/*.py` | scaffold/generate | PC 侧辅助工具 |
| `test/pc/test_*.py` | generate | PC unittest |
| `device/tests/test_*.py` | generate | MicroPython 设备合约测试 |
| `deploy_result.json` | deploy | 部署综合判定 |

## 12. 文件和 artifact 规则

- `phase_complete.payload.artifacts` 必须是数组。
- `file_list.files[].path` 必须相对 artifact root。
- 正式 artifact 不得写宿主绝对路径或本机 skill 安装路径。
- `artifact.type` 可用：`table`、`file_tree`、`markdown`、`html`、`code_diff`、`file_list`、`file_manifest`。
- 被 manifest、firmware state、checkpoint 引用的文件必须在 artifacts 中声明。
- 直测产物可以存在，但不得替代 `phase_complete.payload.manifest_content`。

## 13. checkpoint/resume 规则

所有 `partial` 必须携带：

```json
{
  "checkpoint_id": "uuid",
  "resume_phase": "<phase>",
  "resume_step": "<step>",
  "resume_label": "继续...",
  "reason": "user_cancelled | timeout | missing_dependency | no_device | ...",
  "state_ref": {
    "artifact": "sessions/<session_id>/<state-file>.json"
  }
}
```

UI 必须把 partial 渲染为可继续的 checkpoint 卡片，提供“继续”“保存”“取消/新会话”等动作。继续时沿用同一 `session_id` 和合适的 `idempotency_key`。

## 14. 错误和幂等

通用 structured error：

```json
{
  "code": "missing_pin_layout",
  "message": "预选板卡缺少本地 pin_layout",
  "severity": "error",
  "recoverable": false,
  "retryable": false,
  "source": "select_hw_manifest.py",
  "field": "mcu.board_id"
}
```

幂等要求：

- retry 沿用同一个 `session_id`。
- 同一动作重试时 `idempotency_key` 保持不变。
- `retry_of` 指向原失败消息 `msg_id`。
- 外部等待动作必须有 `timeout_ms` 和 `on_timeout`。
- `on_timeout` 枚举：`retry_once`、`partial_checkpoint`、`failed`。

## 15. 第三方驱动目录限制

插件工程侧不要从以下目录直接推导板卡或驱动支持范围：

```text
F:\mpy-hardware-extension\third_party\GraftSense-Drivers-MicroPython
```

原因：

1. 内容不完整，不能代表可用驱动全集。
2. 不符合正常驱动包下载和解析流程。
3. `upy-generate-plugin` 应根据 analyze manifest 的 driver facts、uPyPI(upypi.net)、MicroPython 官方仓库、awesome-micropython、GitHub fallback 或用户确认来源解析依赖。
4. 该目录最多作为人工参考，不能作为生产链路默认源。

## 16. 插件整体要求

P0 必须完成：

- 首屏官方板卡选择、搜索、筛选、缓存、官方图片展示、品牌/类型/芯片系列分类。
- 首屏 `beginner/custom` 模式选择。
- 启动 analyze 时传完整 payload：`user_description`、`pre_selected_board`、`preferences`、`existing_hardware`、`runtime_context`、`capabilities`。
- `phase_complete` 推进优先使用 `next_skill`，缺失时显式映射。
- deploy 和独立设备工具区所需设备动作完整桥接：mip install、上传/下载、设备文件浏览、双击查看、删除、dry-run clean/erase、REPL capture、日志读取、设备测试。
- 已知 `approval_id` 专用渲染，通用卡兜底。
- 危险动作必须 dry-run + 用户确认；`erase_then_upload` 必须二次确认。
- 所有阶段 success/partial/failed 都能显示在 Activity 时间线，并可查看 artifacts。

P1 建议完成：

- phase/session artifact 浏览器。
- partial checkpoint 继续按钮。
- deploy -> generate fix/autofix 的 `error_context` 预览和确认。
- UI 中明确区分“解释器固件烧录”和“业务项目部署”，并提供“打开官方固件页”“选择本地固件烧录”按钮。

P2 可后续完成：

- 板卡资料贡献/补 pin_layout 流程。
- uPyPI(upypi.net) / micropython-lib 库搜索、缓存、安装和项目库上传/发布入口。
- wiring/diagram 可选阶段入口。
- 云服务凭据管理 UI。

## 17. 按钮总清单

### 启动区

| 按钮 | 必要性 |
|---|---|
| 生成 | 必须 |
| 停止 | 必须 |
| 继续上次 session | 必须 |
| 新会话/重启 | 建议保留 |
| 刷新官方板卡列表 | 必须 |
| 暂不指定板卡/由系统推荐 | 必须 |
| 打开官方固件页 | 必须，当前板卡有 `firmware.url` 时启用 |
| 选择本地固件烧录 | 必须，进入固件烧录分支 |
| 可视化 Git 变更历史 | 必须，项目目录是 git repo 或已有 session 版本记录时启用 |
| 保存当前版本 | 必须，弹出版本名和版本摘要输入；保存前展示变更摘要 |

### 主流程卡片

| 阶段 | 按钮 |
|---|---|
| analyze | 确认器件、修改器件、补充需求、使用替代、坚持原器件 |
| select-hw | 选择板卡、系统推荐、确认引脚、修改引脚、保存 |
| flash | 下载并烧录、仅下载、已烧录、使用本地固件、重新扫描串口、打开官方固件页、确认已复制 UF2 |
| scaffold | 生成骨架、切换调度器、选择模块、保存 |
| generate | 继续生成、只生成代码、转模拟、保存、进入 fix |
| deploy | 选择端口、重新扫描、清理后上传、仅上传、擦除后上传、运行测试、跳过测试 |
| versioning | 可视化 Git 变更历史、保存当前版本、命名版本摘要、查看版本 artifact |

### 独立设备工具区

| 按钮 | 说明 |
|---|---|
| 扫描端口 | 刷新串口 |
| 连接 REPL | 开始持久监听 |
| 停止 REPL | 停止监听 |
| 清屏 | 清空 UI 输出 |
| 保存输出 | 保存最近串口输出 |
| 复制输出 | 复制最近输出 |
| 文件浏览/刷新目录 | 查看设备文件目录树，刷新 `/`、`/lib` 等路径 |
| 上传文件 | 上传本地文件到设备端路径，覆盖前确认 |
| 上传文件夹 | 递归上传目录，先显示变更清单 |
| 下载文件 | 下载设备端文件到本地 |
| 新建目录 | 在设备端创建目录 |
| 删除文件/目录 | 删除设备端文件或目录，必须二次确认 |
| 重命名 | 重命名或移动设备端文件/目录 |
| 双击查看设备文件 | 双击目录项读取设备端文本文件 |
| 保存到设备 | 将编辑器内容写回设备端文件 |
| 比较本地/设备文件 | 对比文件差异或 hash/大小 |
| 搜索 uPyPI | 调用 `https://upypi.net/api/search?q=<query>` 搜索 MicroPython 包 |
| 安装 uPyPI 库 | 使用 `{package_url}/package.json` 和 `mpremote mip install` 安装到 `/lib` |
| 安装 micropython-lib | 通过 `mip` 或缓存复制安装库 |
| 读取日志 | tail 日志 |
| 下载日志 | 下载板端日志 |
| 清空日志 | 清理板端日志 |
| 运行设备测试 | 运行 `device/tests` |
| 清理项目 dry-run | 预览清理项目文件 |
| 擦除设备 dry-run | 预览擦除整个设备文件系统 |
| 选择本地固件烧录 | 选择本地 `.bin`/`.uf2` 并进入解释器固件烧录 |
| 打开官方固件页 | 打开当前板卡官方 MicroPython 固件页面 |
| 可视化 Git 变更历史 | 查看 commit 列表、文件 diff、阶段产物、版本说明 |
| 保存当前版本 | 输入版本名和版本摘要，保存当前工作区快照或 git commit/tag |

## 18. 最小验收清单

- 首屏能选择官方板卡，或选择“由系统推荐”。
- analyze 出现器件确认卡，用户未确认前不继续。
- select-hw 能区分有/无本地 pin_layout，并强制确认 pin plan。
- flash 能按 ESP32/Pico/manual 分支处理，不固定串口。
- scaffold 能生成项目骨架，写入 `project_root`，并通过 flake8。
- generate 能生成 `generate_plan.json`、完整 `project-manifest.json`、firmware、PC tests、device tests，并通过质量门禁。
- generate success 默认 `next_phase=upy-deploy-plugin`，除非用户停止或存在明确 blocker。
- deploy 能扫描端口、选择策略、安装 mip 依赖、上传、软复位、捕获 REPL、读取日志、运行设备测试。
- deploy FAIL 能构造 `error_context` 并进入 generate fix/autofix。
- 所有阶段 success/partial/failed 都有 `phase_complete`，partial 有 checkpoint。
- 所有用户动作通过 `approval_request`，没有普通文本阻塞问题。
- 插件端必须提供“可视化 Git 变更历史”和“保存当前版本（可命名+版本摘要）”两个按钮。

## 19. 长流程协议机制

本插件链路是长流程，不是一次性聊天回复。UI、后端、扩展宿主、Python shim 和 skill 都必须把每次运行当作可恢复 session。

### 19.1 统一消息 envelope

所有正式协议消息必须使用完整 envelope：

```json
{
  "protocol_version": "1.0",
  "type": "start_phase",
  "phase": "upy-generate-plugin",
  "msg_id": "uuid",
  "session_id": "uuid",
  "timestamp": "2026-06-26T13:00:00Z",
  "idempotency_key": "upy-generate-plugin:<session_id>:full:v1",
  "retry_of": null,
  "payload": {}
}
```

| 字段 | 必要性 | 含义 |
|---|---|---|
| `protocol_version` | 必填 | 当前固定 `1.0`，后续兼容演进用 |
| `type` | 必填 | `start_phase`、`status_update`、`approval_request`、`approval_response`、`script_run`、`script_result`、`file_operation`、`file_result`、`device_command`、`device_result`、`phase_complete` |
| `phase` | 必填 | 当前阶段标识 |
| `msg_id` | 必填 | 单条消息唯一 ID |
| `session_id` | 必填 | 一次用户工作流的稳定 ID |
| `timestamp` | 必填 | UTC 时间 |
| `idempotency_key` | 必填 | 同一动作重试时保持不变 |
| `retry_of` | 可选 | 指向原始失败消息 `msg_id` |
| `payload` | 必填 | 具体消息内容 |

### 19.2 session_state

每个 session 必须有一个可恢复的状态文件，建议位于：

```text
sessions/<session_id>/session_state.json
sessions/<session_id>/session_state.<phase>.json
```

通用结构：

```json
{
  "protocol_version": "1.0",
  "session_id": "<session_id>",
  "current_phase": "upy-generate-plugin",
  "current_step": "quality_gates",
  "status": "running",
  "attempt": 2,
  "started_at": "2026-06-26T13:00:00Z",
  "updated_at": "2026-06-26T13:05:00Z",
  "idempotency_key": "upy-generate-plugin:<session_id>:quality-gates:v1",
  "manifest_hash": "sha256:...",
  "last_successful_checkpoint": {
    "checkpoint_id": "uuid",
    "phase": "upy-generate-plugin",
    "step": "files_generated",
    "state_ref": {
      "path": "sessions/<session_id>/session_state.upy_generate_plugin.json"
    }
  },
  "last_error": null,
  "artifacts": [],
  "cancellation": {
    "requested": false,
    "requested_at": null,
    "reason": null
  }
}
```

`upy-generate-plugin` 必须通过 `scripts/update_session_state.py` 更新自己的状态，不允许手写简化 JSON。其他阶段可以使用同形状状态文件。

### 19.3 checkpoint/resume

所有 `partial` 必须包含 checkpoint。没有 checkpoint 的 `partial` 视为协议错误。

```json
{
  "checkpoint_id": "uuid",
  "resume_phase": "upy-select-hw-plugin",
  "resume_step": "pin_assignment",
  "resume_label": "继续调整引脚分配",
  "reason": "pin_review_rejected",
  "state_ref": {
    "artifact": "sessions/<session_id>/select_hw_draft.json",
    "session_state": "sessions/<session_id>/session_state.select_hw.json"
  },
  "input_refs": {
    "source_phase_complete": "sessions/<session_id>/phase_complete.analyze.json"
  },
  "safe_to_retry": true
}
```

恢复规则：

- resume 必须沿用原 `session_id`。
- resume 应从 `checkpoint.resume_step` 继续，不从 analyze 重新开始。
- resume 前必须重新校验 `source_phase_complete` 和 `manifest_hash`，发现上游 manifest 改变时不得盲目继续。
- UI 必须把 checkpoint 渲染为可点击卡片，至少提供“继续”“保存”“取消/新会话”。

### 19.4 cancellation

取消是协议事件，不是简单停止进程。

```json
{
  "type": "cancellation_request",
  "phase": "upy-deploy-plugin",
  "session_id": "<session_id>",
  "payload": {
    "reason": "user_cancelled",
    "requested_at": "2026-06-26T13:10:00Z"
  }
}
```

阶段收到取消后：

- 不再发起新的危险操作。
- 正在运行的脚本/设备命令如果支持中断，应终止并记录结果。
- 必须输出 `phase_complete(result=partial, next_phase=null)`。
- `checkpoint.reason` 使用 `cancelled_by_user`。
- 已产生的 artifact 必须写入 file manifest。

### 19.5 retry、timeout 和 idempotency

所有外部动作必须有 timeout 和重试策略：

```json
{
  "timeout_ms": 120000,
  "on_timeout": "partial_checkpoint",
  "retry_policy": {
    "max_attempts": 2,
    "backoff_ms": 1000,
    "retryable_errors": ["NETWORK_DISCONNECTED", "UPSTREAM_TIMEOUT"]
  }
}
```

规则：

- 同一个动作重试时 `idempotency_key` 不变。
- 新的用户意图、新的输入、新的危险操作确认必须生成新的 `idempotency_key`。
- `retry_of` 指向原始失败消息。
- `timeout` 后不能继续假装 success，必须 retry、partial 或 failed。
- 写文件、烧录、擦除、上传等副作用动作必须能通过 `idempotency_key` 去重。

推荐 `idempotency_key` 格式：

```text
<phase>:<session_id>:<step>:<input-hash>:v1
```

### 19.6 protocol versioning

当前版本固定 `1.0`。宿主和 skill 必须在 start_phase 中声明支持版本：

```json
{
  "capabilities": {
    "protocol_versions": ["1.0"]
  }
}
```

兼容规则：

- 接收方不支持 `protocol_version` 时必须返回 structured error：`UNSUPPORTED_PROTOCOL_VERSION`。
- 新增字段必须向后兼容；旧宿主可忽略未知字段，但不得忽略必填字段缺失。
- 枚举值新增时，UI 必须用通用卡兜底渲染。

### 19.7 capability negotiation

每个 start_phase 必须带 capabilities：

```json
{
  "capabilities": {
    "protocol_versions": ["1.0"],
    "approval_request": true,
    "file_operation": true,
    "script_run": true,
    "device_command": true,
    "serial_port_scan": true,
    "checkpoint_resume": true,
    "cancellation": true,
    "relative_paths": true,
    "artifact_root": true,
    "network_access": {
      "allowed": true,
      "domains": ["micropython.org", "docs.micropython.org", "upypi.net"]
    },
    "device_flash": true,
    "git_commit": true
  }
}
```

能力缺失处理：

| 缺失能力 | 处理 |
|---|---|
| `approval_request` | 不得进入需要用户确认的阶段，输出 failed |
| `script_run` | select-hw/flash/scaffold/generate/deploy 不得宣称 success |
| `file_operation` | scaffold/generate 不得写项目，输出 partial |
| `device_command` | deploy 只能 partial，不能真实部署 |
| `serial_port_scan` | flash/deploy 真实硬件动作必须 partial |
| `checkpoint_resume` | 长流程仍可运行，但所有中断必须 failed，UI 必须提示不可恢复 |
| `network_access` | flash/generate 需要网络时 partial，允许使用缓存但必须标注 stale |
| `git_commit` | generate 质量通过但不能 commit 时输出 partial |

### 19.8 structured error reporting

统一错误对象：

```json
{
  "code": "MISSING_PIN_LAYOUT",
  "message": "预选板卡缺少本地 pin_layout，无法自动分配引脚",
  "severity": "error",
  "recoverable": true,
  "retryable": false,
  "source": "upy-select-hw-plugin",
  "step": "board_definition_loaded",
  "field": "hardware_selection.selected_board.pin_layout",
  "details": {},
  "suggested_actions": [
    {
      "action": "select_supported_board",
      "label": "换已支持板卡"
    },
    {
      "action": "save_checkpoint",
      "label": "保存后补板卡资料"
    }
  ]
}
```

推荐通用错误码：

| 错误码 | 含义 |
|---|---|
| `INVALID_UPSTREAM_PHASE` | 上游阶段或 result 不符合要求 |
| `MISSING_REQUIRED_FIELD` | 必填字段缺失 |
| `UNSUPPORTED_PROTOCOL_VERSION` | 协议版本不支持 |
| `CAPABILITY_MISSING` | 宿主能力不足 |
| `PERMISSION_DENIED` | 用户拒绝文件/脚本/设备权限 |
| `TIMEOUT` | 外部动作超时 |
| `CANCELLED_BY_USER` | 用户取消 |
| `SCRIPT_FAILED` | 白名单脚本失败 |
| `DEVICE_NOT_FOUND` | 没有可用设备/串口 |
| `DEVICE_COMMAND_FAILED` | 设备命令失败 |
| `NETWORK_DISCONNECTED` | 网络不可用 |
| `UPSTREAM_TIMEOUT` | 上游服务超时 |
| `ARTIFACT_MISSING` | artifact 声明或文件缺失 |
| `ABSOLUTE_PATH_IN_ARTIFACT` | 正式 artifact 出现绝对路径 |
| `PHASE_COMPLETE_INVALID` | phase_complete 校验失败 |

### 19.9 artifact/file manifest

每个阶段都应输出 artifact file manifest。格式：

```json
{
  "type": "file_manifest",
  "path": "sessions/<session_id>/scaffold_file_manifest.json",
  "root": "sessions/<session_id>/project",
  "generated_at": "2026-06-26T13:00:00Z",
  "files": [
    {
      "path": "firmware/main.py",
      "status": "created",
      "encoding": "utf-8",
      "bytes": 1234,
      "sha256": "abc...",
      "sha256_before": null,
      "sha256_after": "abc...",
      "overwrite": false,
      "reason": "generated"
    }
  ]
}
```

状态枚举：

```text
created
updated
unchanged
skipped
deleted
error
pending
```

`pending` 只能用于计划/草案，最终 `phase_complete` 不应再出现 pending 写入结果。

### 19.10 permission prompts

所有文件、设备、脚本高风险动作必须有权限记录。低风险读操作可由宿主预授权，但仍应记录。

```json
{
  "permissions": [
    {
      "permission_id": "perm:<session_id>:write-project-files",
      "type": "file_operation",
      "scope": "project_root",
      "operation": "write",
      "paths": ["firmware/main.py", "project-manifest.json"],
      "risk": "medium",
      "approved": true,
      "approved_at": "2026-06-26T13:00:00Z",
      "idempotency_key": "upy-scaffold-plugin:<session_id>:write-files:v1"
    }
  ]
}
```

权限分类：

| 类型 | 例子 | 要求 |
|---|---|---|
| 文件读 | 读取上游 phase_complete、project-manifest | 可预授权，但要限制在 workspace/session/project root |
| 文件写 | scaffold/generate 写项目文件 | 需要记录 file manifest；冲突需确认或 partial |
| 文件删 | 清理项目文件、设备文件系统 dry-run 后删除 | 必须先 dry-run，再审批 |
| 脚本运行 | skill scripts、quality gates | 只能运行白名单脚本；非白名单需单独确认 |
| 网络访问 | MicroPython 下载页、uPyPI(upypi.net)、官方 docs | 需 capability 和域名范围 |
| 串口扫描 | list serial ports | 可低风险，但真实端口选择要用户确认 |
| 设备写入 | 烧录、上传、mip install、擦除 | 必须审批；擦除必须二次确认 |
| git commit | generate 成功提交、用户点击“保存当前版本” | 必须有用户或策略授权；保存当前版本必须展示变更摘要并记录版本名/摘要 |
| git history read | 可视化 Git 变更历史、查看 diff/log | 只读操作，可低风险预授权；不得修改工作区 |

### 19.11 Git 版本历史和用户命名版本

插件端必须提供两个全局按钮：

| 按钮 | 类型 | 要求 |
|---|---|---|
| 可视化 Git 变更历史 | 只读 | 展示 commit 时间线、文件 diff、阶段 artifact、版本摘要和当前工作区未提交变更 |
| 保存当前版本 | 写操作 | 弹出输入框要求用户填写版本名和版本摘要，展示将保存的变更清单，经确认后保存 |

“可视化 Git 变更历史”用于帮助用户理解 AI 每次生成、修复、部署前后的变化。最低 UI 能力：

- 左侧时间线：commit hash、时间、阶段、版本名、摘要、模型/阶段来源。
- 中间文件列表：created/updated/deleted/unchanged、路径、字节数、hash。
- 右侧 diff 视图：文本 diff、二进制文件提示、artifact 链接。
- 顶部过滤：按阶段、文件类型、版本名、成功/partial/failed、是否用户保存版本。
- 支持打开关联 artifact：`phase_complete`、`file_manifest`、`generate_plan`、`deploy_result`、日志摘要。

“保存当前版本”必须让用户输入：

```json
{
  "version_name": "oled-temp-demo-v1",
  "version_summary": "完成温湿度读取、OLED 显示和报警逻辑，已通过 PC 测试，待真实设备验证",
  "include_untracked": true,
  "create_git_commit": true,
  "create_git_tag": false
}
```

保存动作必须输出 `version_snapshot` artifact：

```json
{
  "type": "version_snapshot",
  "version_name": "oled-temp-demo-v1",
  "version_summary": "完成温湿度读取、OLED 显示和报警逻辑，已通过 PC 测试，待真实设备验证",
  "created_at": "2026-06-27T00:00:00Z",
  "session_id": "<session_id>",
  "project_root": "sessions/<session_id>/project",
  "git": {
    "repo_detected": true,
    "commit": "abc123",
    "tag": null,
    "dirty_before": true,
    "dirty_after": false
  },
  "files": [
    {"path": "firmware/main.py", "status": "updated", "sha256_after": "..."}
  ],
  "related_artifacts": [
    "sessions/<session_id>/phase_complete.upy_generate_plugin.json",
    "sessions/<session_id>/generate_file_manifest.json"
  ]
}
```

协议约束：

- 查看 Git 历史是只读操作，可由宿主低风险预授权，但必须限制在当前 `project_root`。
- 保存当前版本是写操作，必须走 `approval_request(save_version)` 或等价 permission prompt。
- 如果项目不是 git repo，仍必须能保存 session snapshot：写入 `version_snapshot.json` 和 file manifest；UI 提示“未创建 git commit”。
- 如果用户选择创建 git commit，commit message 必须由 `version_name` 和 `version_summary` 组成，不得包含密钥、token、串口日志中的敏感信息。
- 如果存在未跟踪文件，必须在确认卡中明确列出，并由用户选择是否包含。
- 如果 git commit/tag 失败，不能宣称版本保存成功；应输出 `partial` 或 `failed`，并保留 snapshot 草案。
- `generate` 自动 commit 和用户点击“保存当前版本”是两个不同动作：自动 commit 是阶段门禁产物，用户保存版本是用户可命名的版本节点。

建议新增协议工具/动作名：

```text
git.history.list
git.diff.view
git.status.summary
git.version.save
```
## 20. 可选分支和中断恢复矩阵

### 20.1 主流程可选分支

| 阶段 | 可选分支 | 触发条件 | 结果 |
|---|---|---|---|
| analyze | `requirement_supplement` | beginner/custom 输入缺少关键需求 | 补齐后继续 analyze |
| analyze | `alternative_device` | 系统推荐器件无驱动 | 用户选替代或坚持原器件 |
| analyze | `cold_driver` | 用户指定器件无现成驱动 | 标记 cold driver；generate 可 partial/simulate |
| select-hw | `board_select` | 无预选板卡 | 用户选择或系统推荐 |
| select-hw | `board_unavailable` | 官方板卡缺 pin_layout | 换板、手动补资料、checkpoint |
| select-hw | `manual_wiring` | 用户手动指定引脚 | 校验 user_wiring 后继续 |
| flash | `already_flashed` | 用户确认已刷 MicroPython | 跳过烧录，进入 scaffold |
| flash | `download_only` | 用户只下载固件 | partial，等待后续烧录 |
| flash | `pico_uf2` | RP2/Pico | 等用户 BOOTSEL 拷贝确认 |
| flash | `manual_flash` | 非 ESP32/Pico | 展示官方说明，等待确认 |
| scaffold | `incremental` | 后续新增器件 | 只生成新增 stub 和 manifest |
| generate | `cloud_blocked` | 云服务未开通/凭据未准备 | next_phase 为 simulate/null，不进入 deploy |
| generate | `fix` | deploy/autofix/用户反馈失败 | 最小修改后重跑 gate |
| deploy | `upload_only` | 用户不想清理设备 | 直接上传 |
| deploy | `clean_then_upload` | 常规部署 | dry-run 清理项目文件后上传 |
| deploy | `erase_then_upload` | 需要清空设备 FS | dry-run + 二次确认 |
| deploy | `skip_tests` | 用户跳过设备测试 | 结果带 warning |
| deploy | `project_library_upload` | 部署通过后发布 | 进入后续发布流程 |

### 20.2 每阶段失败恢复策略

| 阶段 | 步骤 | 失败/取消/超时 | 恢复策略 |
|---|---|---|---|
| analyze | 输入缺失 | `user_description` 为空 | failed；提示补输入后新 start_phase |
| analyze | `device_confirm` | 用户取消/超时 | partial；checkpoint=`device_confirm` |
| analyze | 驱动搜索 | 网络失败 | retry；仍失败则 partial，保留已知 driver facts |
| analyze | manifest 校验 | schema 错误 | failed；structured error=`PHASE_COMPLETE_INVALID` |
| select-hw | 加载上游 manifest | 上游缺失/phase 不对 | failed；不能自行猜状态 |
| select-hw | 板卡选择 | 用户取消/超时 | partial；checkpoint=`board_select` |
| select-hw | 加载 board JSON | 缺 pin_layout | partial；checkpoint=`board_unavailable` |
| select-hw | 引脚分配 | 用户引脚非法 | partial；checkpoint=`pin_assignment` |
| select-hw | pin review | 用户要求修改 | partial；checkpoint=`pin_assignment` |
| flash | 固件页解析 | 网络失败 | retry；仍失败 partial，允许用户手动链接 |
| flash | 固件下载 | 下载失败 | retry；仍失败 partial，checkpoint=`firmware_download` |
| flash | 串口扫描 | 无设备 | partial，checkpoint=`serial_port_select` |
| flash | esptool bootstrap | 环境缺失 | partial，action_required=`install_esptool` |
| flash | 烧录 | 用户取消/失败 | partial 或 failed；保留 flash_result |
| scaffold | 配置审批 | 用户取消/超时 | partial，checkpoint=`scaffold_config` |
| scaffold | 文件写入 | 文件冲突 | partial，structured error=`FILE_CONFLICT` |
| scaffold | flake8 | lint 失败 | partial，不进入 generate |
| generate | session 检查 | stale 旧记录 | 归档/忽略旧记录，从 scaffold 继续 |
| generate | 计划校验 | plan 不合法 | partial，checkpoint=`generate_plan` |
| generate | 依赖解析 | 网络失败 | retry；仍失败 partial |
| generate | 云服务确认 | 用户未确认/凭据缺失 | partial 或 next_phase=simulate/null |
| generate | 质量门禁 | gate 失败 | partial；保留 session_state 和 error_context |
| generate | git commit | 用户拒绝或非 git repo | partial，不宣称 success |
| deploy | 环境检查 | mpremote 缺失 | partial，action_required=`install_mpremote` |
| deploy | 串口选择 | 用户取消/无设备 | partial，checkpoint=`deploy_port_select` |
| deploy | 清理确认 | 用户取消 | partial 或回退 upload_only |
| deploy | mip install | 安装失败 | failed/partial，error_context 给 generate fix |
| deploy | 上传 | 上传失败 | failed/partial，保留 upload_summary |
| deploy | REPL/log | 空输出或读取失败 | warning，不单独判失败 |
| deploy | device tests | 测试失败 | failed，error_context 指向 generate fix/autofix |

## 21. 每个 skill 的目录内容和含义

### 21.1 `upy-analyze-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | analyze 阶段主规则、输入契约、消息序列、审批卡、manifest 最低字段 |
| `.skillfish.json` | skill 元数据 | skill 名称、描述、入口信息 |
| `boards/*.json` | 板卡增强资料 | 已有 pin layout/onboard peripherals/restricted GPIO 的本地增强板卡，不是官方全量板卡 |
| `boards/matching-rules.json` | 匹配规则 | 板卡/MCU/别名匹配规则 |
| `boards/_template.json` | 模板 | 新增本地板卡增强 JSON 的格式模板 |
| `boards/README.md` | 说明 | boards 目录用途和边界 |
| `sample/start_phase.analyze.json` | 样例 | analyze 启动消息 |
| `sample/approval_request.*.json` | 样例 | `device_confirm`、`requirement_supplement`、`alternative_device` 卡片 |
| `sample/phase_complete.analyze.*.json` | 样例 | success/cold driver/TTP223 行为事实等输出 |
| `scripts/init_manifest.py` | 校验/规范化脚本 | 生成/校验 manifest 与 phase_complete |
| `scripts/README.md` | 说明 | 脚本入口说明 |
| `test/*.py`、`test/*.md` | 本地测试 | mock plugin、runner、smoke、本地交互测试 |

boards JSON 典型含义：

```text
board id/display name/vendor/mcu/firmware
pin_layout.default_bus_pins
restricted_gpio
onboard_peripherals
notes/warnings
```

### 21.2 `upy-select-hw-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | select-hw 阶段输入、root、capability、消息序列、pin 分配、checkpoint、错误 |
| `.skillfish.json` | skill 元数据 | skill 描述和入口 |
| `.codex-plugin/plugin.json` | 插件 manifest | Codex 插件元数据 |
| `sample/start_phase.select_hw.json` | 样例 | select-hw 启动消息 |
| `sample/analyze_phase_complete.input.json` | 样例 | 上游 analyze 输入 |
| `sample/approval_request.board_select.json` | 样例 | 选板卡卡片 |
| `sample/approval_request.board_unavailable.json` | 样例 | 缺板卡资料卡片 |
| `sample/approval_response.pin_plan_review.revise.json` | 样例 | 用户修改引脚方案响应 |
| `sample/select_hw_draft.json` | 草稿样例 | pin plan/board/facts 初稿 |
| `sample/select_hw_manifest.after.json` | 规范化样例 | 脚本处理后的 manifest |
| `sample/phase_complete.select_hw.*.json` | 输出样例 | success/partial 输出 |
| `sample/pin_assignment_log.md` | 日志样例 | GPIO 使用汇总和引脚明细 |
| `sample/select_hw_phase_log.md` | 日志样例 | runtime_context、步骤时间线、产物 |
| `scripts/select_hw_manifest.py` | 校验/规范化脚本 | draft、manifest_content、phase_complete、artifact 校验 |
| `test/*.py` | 测试 | mock session、runner、smoke |

核心格式：

```text
select_hw_draft.json
select_hw_validated.json
phase_complete.select_hw.json
pin_assignment_log.md
select_hw_phase_log.md
```

### 21.3 `upy-flash-mpy-firmware-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | 固件解析、下载、ESP32/Pico/manual 分支、state、phase_complete |
| `agents/openai.yaml` | agent 配置 | OpenAI agent 配置 |
| `sample/start_phase.*.json` | 样例 | ESP32/Pico/manual 启动消息 |
| `sample/approval_response.*.json` | 样例 | 固件动作、烧录确认、UF2、手动确认的用户响应 |
| `sample/flash_mpy_firmware_state.*.json` | state 样例 | 固件阶段可恢复状态 |
| `sample/micropython_download_*.html` | HTML fixture | 固件页面解析测试 fixture |
| `sample/phase_complete.*.json` | 输出样例 | already flashed、ESP32、manual、partial download、Pico |
| `scripts/firmware_page_resolve.py` | 解析脚本 | 解析 MicroPython 板卡下载页 |
| `scripts/firmware_download.py` | 下载脚本 | 下载固件并输出 JSON |
| `scripts/list_serial_ports.py` | 串口脚本 | 扫描端口 |
| `scripts/find_uf2_mount.py` | Pico 脚本 | 查找 UF2 挂载点 |
| `scripts/bootstrap_esptool.py` | 环境脚本 | 检查/安装技能内 esptool |
| `scripts/esptool_runner.py` | 封装脚本 | 调用技能内 esptool |
| `scripts/esp32_flash.py` | 烧录脚本 | ESP32 plan/execute |
| `scripts/flash_mpy_firmware_manifest.py` | 校验脚本 | start/state/phase_complete 校验 |
| `scripts/requirements-esptool.txt` | 依赖 | 固定 esptool 依赖 |
| `test/smoke_tests.py` | 测试 | 固件阶段 smoke |

state 文件含义：保存板卡、固件 URL、下载文件、端口、烧录结果、checkpoint。它不是 phase_complete。

### 21.4 `upy-scaffold-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | full/incremental 骨架生成、审批、file_operation、lint、manifest |
| `.skillfish.json` | skill 元数据 | skill 描述 |
| `sample/approval_request.scaffold_config.json` | 样例 | 骨架配置审批卡 |
| `sample/start_phase.upy_scaffold_plugin.full.json` | 样例 | full 启动 |
| `sample/start_phase.upy_scaffold_plugin.incremental.json` | 样例 | incremental 启动 |
| `scripts/init_scaffold.py` | 渲染脚本 | 读取 manifest，stdout 输出 directories/files/file_operations，不直接写项目 |
| `scripts/apply_scaffold.py` | 本地应用脚本 | 本地测试时把 scaffold 应用到项目目录 |
| `scripts/run_on_device.py` | 辅助脚本 | 设备运行辅助 |
| `templates/firmware/*.tmpl` | 模板 | `boot.py`、`board.py`、`conf.py`、`main.py`、README |
| `templates/lib/*` | 模板/库 | logger、rotating logger、scheduler、time helper |
| `templates/pc/*` | PC 工具模板 | `flash_device.py`、`read_device_log.py`、`log_report.py` |
| `templates/tasks/maintenance.py` | 任务模板 | 维护任务 |
| `test/*.py` | 测试 | actual project、smoke |

模板文件含义：

| 模板 | 输出 | 含义 |
|---|---|---|
| `board.py.tmpl` | `firmware/board.py` | board pin mapping、接口常量、查询函数 |
| `boot.py.tmpl` | `firmware/boot.py` | 早期启动、异常跟踪、watchdog 注释 |
| `conf.py.tmpl` | `firmware/conf.py` | 静态配置常量 |
| `main_timer.py.tmpl` | `firmware/main.py` | Timer scheduler 框架 |
| `main_async.py.tmpl` | `firmware/main.py` | uasyncio 框架 |
| `main_thread.py.tmpl` | `firmware/main.py` | `_thread` 框架 |
| `README.md.tmpl` | `firmware/README.md` | 硬件、BOM、pinout、快速开始 |

### 21.5 `upy-generate-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | full/fix 生成、引用资料、质量门禁、commit、phase_complete |
| `.skillfish.json` | skill 元数据 | skill 描述 |
| `.codex-plugin/plugin.json` | 插件 manifest | Codex 插件元数据 |
| `agents/openai.yaml` | agent 配置 | OpenAI agent 配置 |
| `references/*.md` | 规范资料 | 协议字段、旧约束、driver factory、task、device unittest、main/conf、质量门禁、最终审查 |
| `knowledge/*.json` | 知识库 | 云服务目录、pitfall、MicroPython imports、mip runtime、scheduler modes |
| `sample/start_phase.*.json` | 样例 | full/fix 启动 |
| `sample/approval_request.generate_behavior.json` | 样例 | 业务行为补充卡 |
| `sample/phase_complete.*.json` | 样例 | success/partial/fix success |
| `sample/code_diff.fix.sample.json` | 样例 | fix 代码 diff |
| `sample/status_update.generate.sequence.jsonl` | 样例 | 生成阶段进度流 |
| `scripts/*.py` | 脚本 | 依赖解析、下载、质量门禁、session_state、phase consistency |
| `test/*.py` | 测试 | local mock session、smoke |

主要 references：

| 文件 | 含义 |
|---|---|
| `protocol_fields.md` | phase_complete、manifest、artifact 字段解释 |
| `legacy_constraints.md` | 旧 generate 嵌入式约束 |
| `driver_factory_templates.md` | driver adapter/mock/factory 模板规则 |
| `task_generation_rules.md` | task 生成和日志矩阵 |
| `device_unittest_subset.md` | MicroPython unittest 子集 |
| `main_conf_rules.md` | `main.py` 和 `conf.py` 规则 |
| `cloud_integrations.md` | 云服务/API 接入规则 |
| `validation_gates.md` | 质量门禁顺序和含义 |
| `final_review_checklist.md` | success 前最终审查 |

主要脚本：

| 脚本 | 含义 |
|---|---|
| `resolve_upypi_packages.py` | 解析 uPyPI(upypi.net) 包 |
| `download_drivers.py` | 下载驱动或输出文件计划 |
| `check_generate_plan.py` | 检查生成计划 |
| `check_conf_contract.py` | 检查配置契约 |
| `check_mpy_imports.py` | MicroPython import 检查 |
| `check_device_unittest_subset.py` | 设备 unittest 子集检查 |
| `check_runtime_dependencies.py` | runtime deps 检查 |
| `check_doc_evidence.py` | 文档证据检查 |
| `check_generated_semantics.py` | 生成语义检查 |
| `check_cloud_integrations.py` | 云服务接入检查 |
| `check_phase_complete_consistency.py` | phase_complete 一致性 |
| `check_final_review_consistency.py` | 最终审查一致性 |
| `run_quality_gates.py` | 统一门禁入口 |
| `update_session_state.py` | session/checkpoint 状态更新 |

### 21.6 `upy-deploy-plugin`

| 路径 | 类型 | 含义 |
|---|---|---|
| `SKILL.md` | 协议/行为规范 | 部署策略、mpremote、日志、设备测试、结果回路 |
| `.codex-plugin/plugin.json` | 插件 manifest | Codex 插件元数据 |
| `sample/start_phase.upy_deploy_plugin.full.json` | 样例 | deploy 启动 |
| `sample/approval_request.*.json` | 样例 | 端口、策略、清理、擦除、测试、结果反馈、失败下一步 |
| `sample/phase_complete.*.json` | 样例 | success/failed/partial |
| `scripts/check_environment.py` | 环境脚本 | 检查 mpremote/pyserial |
| `scripts/list_serial_ports.py` | 串口脚本 | 扫描端口 |
| `scripts/mpremote_runtime.py` | mpremote 封装 | 解析 mpremote 并执行命令 |
| `scripts/clean_device_project.py` | 清理脚本 | dry-run/execute 清理项目或设备 FS |
| `scripts/install_mip_dependencies.py` | 依赖脚本 | `mpremote mip install` 并 verify import |
| `scripts/wait_for_device.py` | 等待脚本 | soft reset 后等待恢复 |
| `scripts/capture_repl.py` | REPL 脚本 | 持久串口输出采集 |
| `scripts/run_device_tests.py` | 测试脚本 | 运行设备端 unittest |
| `scripts/deploy_result.py` | 汇总脚本 | 汇总 upload/mip/repl/log/tests 判定 |
| `scripts/deploy_manifest.py` | 校验脚本 | deploy start/upstream/phase_complete 校验 |
| `scripts/requirements-runtime.txt` | 依赖 | `mpremote`、`pyserial` |
| `test/smoke_tests.py` | 测试 | deploy smoke |

deploy 输出格式重点：

```text
upload_summary.json
clean_result.json
mip_install_result.json
repl_capture.log/json
device_log_report.json
device_tests_result.json
deploy_result.json
phase_complete.upy_deploy_plugin.json
```

## 22. 每个 skill 的 phase_complete 最低要求

| skill | `payload.result=success` 时最低要求 |
|---|---|
| analyze | `manifest_content.phase=\"analyze\"`、requirements、devices、driver facts、`next_phase=select-hw`、`next_skill=/upy-select-hw-plugin` |
| select-hw | `manifest_content.phase=\"select-hw\"`、mcu、hardware_selection、pinout、pin_decisions、pin_review.confirmed、bom、`next_phase=upy-flash-mpy-firmware-plugin` |
| flash | `manifest_content.phase=\"upy-flash-mpy-firmware-plugin\"`、完整上游字段、firmware_flash、firmware summary、artifacts、`next_phase=upy-scaffold-plugin` |
| scaffold | `manifest_content.phase=\"scaffold\"`、scaffold/scaffold_modules、project-manifest、file_manifest、lint、permissions、`next_phase=upy-generate-plugin` |
| generate | `manifest_content.phase=\"generate\"`、generate_plan、runtime_dependencies、doc_evidence、file_manifest、checks、session_state、git commit、`next_phase=upy-deploy-plugin` 或明确 blocker |
| deploy | `manifest_content.phase=\"upy-deploy-plugin\"`、deploy/deploy_result、upload/mip/repl/log/tests artifacts、用户反馈或 next action |

## 23. UI 对协议机制的落地要求

- Activity 时间线展示 `status_update`、`approval_request`、`script_run`、`device_command`、`phase_complete`。
- 每个 `approval_id` 有专用渲染，未知 approval 使用通用表单卡。
- `partial` 渲染 checkpoint 卡，必须能继续。
- `failed` 渲染 structured errors、suggested actions、artifact 链接。
- 设备工具区可独立运行，不依赖主流程走到 deploy。
- artifact 浏览器按 session 展示 file manifest、phase_complete、日志、脚本 JSON。
- Git 历史视图按 session/project 展示 commit、diff、命名版本、version_snapshot 和关联 artifacts。
- 取消按钮发送 cancellation request，并等待阶段输出 partial。
- 重试按钮复用原 `idempotency_key` 和 `retry_of`。
- 超时必须在 UI 上显示，并按 `on_timeout` 执行 retry/partial/failed。

## 24. 启动页、板卡资产和设备工具区补充要求

本节补充 2026-06-26 对启动页和全局 UI 的修订要求，优先级高于前文中较早的简化描述。

### 24.1 官方板卡索引与 `upy-analyze-plugin/boards` 的职责边界

正式板卡列表必须来自 MicroPython 官方下载页 `https://micropython.org/download/`，插件侧需要抓取/缓存 Port、Feature、Vendor、MCU、固件 board name、官方固件页 URL 等全量索引，并在 UI 中按品牌/类型/芯片系列/port/feature 展示。

`G:\MicroPython_Skills\upy-analyze-plugin\boards` 当前不是官方全量板卡库，也不是官方图片缓存库。它的职责是本地增强覆盖层：保存少量已补齐 `pin_layout`、板载外设、禁用 GPIO、匹配规则和相似板卡规则的板卡 JSON。UI 和 orchestrator 必须把官方索引与该增强目录做 overlay，显示“官方固件可用”和“本地 pin layout/规则增强可用”两个不同状态；不能因为本地增强目录没有某板卡，就从启动页隐藏官方板卡。

官方全量缓存和图片缓存建议放在插件侧 generated cache/session cache 中，例如 `board_official_cache/official-index.json`、`board_official_cache/images/`、`board_official_cache/vendors/`。如果后续决定把官方缓存写进 `upy-analyze-plugin/boards`，必须先设计生成文件与手工增强文件的边界，确保刷新缓存不会覆盖用户手工维护的 pin layout、备注、禁用 GPIO 或 matching rules。

官方索引板卡 JSON 或 overlay 后的 UI 数据至少包含：

| 字段 | 含义 |
|---|---|
| `id` | 稳定板卡 ID，建议与 MicroPython firmware board name 或归一化 slug 对齐 |
| `display_name` | UI 显示名 |
| `vendor` | 品牌/厂商，例如 Espressif、Raspberry Pi、Arduino、SeeedStudio |
| `board_type` | 板卡类型，例如 `devkit`、`pico`、`pyboard`、`module`、`m5stack`、`xiao` |
| `chip_series` | 芯片系列，例如 ESP32、ESP32-C3、ESP32-S3、RP2040、STM32、ESP8266 |
| `mcu` | 具体 MCU 或 SoC |
| `port` | MicroPython port，例如 `esp32`、`rp2`、`stm32`、`esp8266` |
| `features` | WiFi、BLE、USB、Display、Camera、Battery 等能力标签 |
| `firmware.url` | 官方固件页面 URL，UI 必须可点击 |
| `firmware.board_name` | MicroPython 下载页 board name |
| `download_slug` | 官方下载页 slug |
| `source_url` | 板卡资料来源页 |
| `image.local_path` | 已下载的官方图片缓存路径；当前本地 boards 目录未必存在 |
| `image.source_url` | 图片来源 URL |
| `image.attribution` | 图片来源/署名/许可提示 |
| `local_support.pin_layout_available` | 是否有本地 pin layout 增强 |
| `pin_layout` | 可选，本地引脚定义 |
| `onboard_peripherals` | 可选，板载 LED、按钮、显示屏、传感器等 |
| `restricted_gpio` | 可选，启动脚、Flash/PSRAM 占用脚、只输入脚等限制 |
| `fetched_at` | 抓取时间 |

官方图片处理规则：

- 爬取官方板卡页/下载页时，如果能找到板卡图片，下载到插件侧官方图片缓存，并写入 `image.local_path`。
- UI 优先展示本地缓存图片，避免每次打开启动页依赖远程热链。
- 图片不可用时展示一致的占位图，并保留 `image_unavailable_reason`。
- 必须保留 `image.source_url` 和 `image.attribution`，方便后续合规审查。
- 刷新官方索引或图片缓存时不得删除 `upy-analyze-plugin/boards` 中用户手工补充的 pin layout、备注、禁用 GPIO 等增强字段。

分类索引要求：

```text
board_official_cache/vendors/espressif.json
board_official_cache/vendors/raspberry-pi.json
board_official_cache/board-types/devkit.json
board_official_cache/board-types/pico.json
board_official_cache/chip-series/esp32-c3.json
board_official_cache/chip-series/rp2040.json
```

分类索引只做加速和 UI 筛选，最终事实仍以每个板卡 JSON 为准。分类索引可由脚本重建，必须具备幂等性。

### 24.2 固件 URL 和本地固件烧录

官方固件页面 URL 必须作为可点击 UI 元素展示，不能只显示字符串。点击后打开系统浏览器或内嵌 WebView；右键/按钮支持复制 URL。

“固件烧录”按钮有两条分支：

| 分支 | 触发 | 行为 |
|---|---|---|
| 官方固件 | 选择官方板卡后点击“烧录 MicroPython 固件” | 使用 `firmware.url` 解析/下载官方固件，再按 ESP32/UF2/manual 分支烧录 |
| 本地固件 | 点击“选择本地固件烧录” | 弹出本地文件选择，只允许 `.bin`、`.uf2` 或当前 port 支持的固件格式，之后调用 `upy-flash-mpy-firmware-plugin` |

本地固件烧录必须记录：`local_firmware_path`、文件大小、sha256、选择时间、目标端口、擦写参数、用户确认记录和烧录结果。ESP32 `.bin` 必须明确 flash address；地址未知时不得静默烧录，必须询问用户或走板卡默认规则。

### 24.3 设备文件浏览器

设备文件浏览器是独立工具，不是 deploy 阶段的临时按钮。它需要支持 Thonny 类似的设备文件目录体验：左侧设备目录树，右侧文件预览/编辑，底部操作日志和进度。双击设备端文本文件时读取内容；双击目录时展开；二进制文件显示大小和下载/保存入口。

建议 `device_command` 操作名称：

```text
device.fs.list
device.fs.read_file
device.fs.write_file
device.fs.upload_file
device.fs.upload_dir
device.fs.download_file
device.fs.mkdir
device.fs.rename
device.fs.delete
device.fs.stat
device.fs.compare
device.repl.connect
device.repl.disconnect
```

失败恢复要求：

| 失败点 | 恢复/重试 |
|---|---|
| 串口被 REPL 占用 | 自动暂停 REPL、释放端口，操作结束后恢复；恢复失败给出手动连接按钮 |
| `mpremote` 不存在 | 提示安装/环境检测，保留当前 session checkpoint |
| 设备断开 | 标记 operation failed，保留最后目录缓存，允许重新扫描端口后重试 |
| 写入中断 | 写入前记录目标路径和本地源文件 hash，重试时只重放未完成操作 |
| 删除失败 | 不刷新为成功状态，保留失败项并允许重试 |
| 读取大文件超时 | 支持延长 timeout、下载到本地、取消 |
| 空间不足 | 报告设备剩余空间和待上传文件大小，建议删除/清理/换路径 |

删除、覆盖、递归上传、递归删除、清空日志、擦除文件系统、固件烧录都必须走 `approval_request`。所有写设备操作必须带 `idempotency_key`，并写入 `artifact/file manifest`。

### 24.4 uPyPI(upypi.net) 和 `micropython-lib` 库管理

库管理器必须以 `G:\MicroPython_Skills\upy-pkg-guide\SKILL.md` 中定义的 uPyPI(upypi.net) 流程为准；`G:\thonny-upypi-manager-main` 只作为 UI/交互能力参考。核心能力是：按器件名/库名搜索 uPyPI，读取标准 `package.json`，展示包元数据和文件清单，下载驱动文件、示例和 README 到缓存，再安装到设备 `/lib`。uPyPI 无结果时，再进入 awesome-micropython fallback；`micropython-lib` 作为标准库/通用库补充来源。

uPyPI 接口和字段：

| 动作 | 接口/路径 | 说明 |
|---|---|---|
| 搜索 | `https://upypi.net/api/search?q={query}` | `{query}` 可为器件名、芯片名、库名；有结果才进入 uPyPI 路径 |
| 读取包清单 | `{package_url}/package.json` | 提取 `urls`、`version`、`author`、`description`、`deps` |
| 文件 base URL | `https://upypi.net/pkgs/{name}/{version}/` | `{name}`、`{version}` 来自包信息 |
| 驱动文件 | `{base_url}{source_path}` | `source_path` 来自 `package.json.urls` |
| 示例 | `{base_url}code/main.py` | 404 跳过，不报错 |
| 文档 | `{base_url}README.md` | 404 跳过，不报错 |
| 标准安装 | `mpremote mip install {package_url}/package.json` | 写设备前必须让用户确认目标端口和 `/lib` 写入 |

支持来源：

| 来源 | 行为 |
|---|---|
| uPyPI(upypi.net) | 搜索、读取 `package.json`、展示元数据/依赖/文件清单、下载文件、通过 `mpremote mip install {package_url}/package.json` 安装 |
| awesome-micropython fallback | uPyPI 无结果时调用 `upy-pkg-guide/scripts/search_awesome.py`，展示候选仓库；选定后拉取 README、main.py 和驱动 `.py`，再手动复制到设备 |
| `micropython-lib` | 按包名/模块名搜索，优先 `mpremote mip install`，必要时下载缓存后复制 |
| 本地缓存 | 离线复用已下载文件，显示缓存版本、来源 URL、sha256、抓取时间 |
| 项目 manifest | 将库依赖写入 `runtime_dependencies`、`library_install_plan.json` 和部署清单 |

安装流程：

```text
搜索 uPyPI -> 读取 package.json -> 展示元数据/版本/作者/描述/deps/urls -> 下载 README/main.py/驱动文件到缓存 -> 生成 install plan -> 用户确认写设备 -> mpremote mip install 或逐文件复制到 /lib -> 可选 import 验证 -> 生成 install result
```

缓存和产物建议：

```text
library_cache/upypi/search_result.json
library_cache/upypi/<name>/<version>/package.json
library_cache/upypi/<name>/<version>/README.md
library_cache/upypi/<name>/<version>/code/main.py
library_cache/upypi/<name>/<version>/files_manifest.json
library_cache/awesome/search_result.json
library_install_plan.json
library_install_result.json
mip_install_result.json
```

awesome-micropython fallback 规则：无结果时告知用户 uPyPI 未找到；多个结果必须列出名称、描述、分类、仓库 URL 并让用户选择；只有一个结果可直接使用。GitHub/GitLab/Codeberg 文件拉取失败时跳过单个文件，但必须在 result 中记录 `missing_files`。

结构化错误至少包括：`UPYPI_SEARCH_FAILED`、`UPYPI_NO_RESULT`、`PACKAGE_JSON_NOT_FOUND`、`PACKAGE_METADATA_INVALID`、`PACKAGE_FILE_404`、`AWESOME_SEARCH_FAILED`、`AWESOME_MULTIPLE_MATCHES_NEED_SELECTION`、`NETWORK_UNAVAILABLE`、`MPREMOTE_MISSING`、`DEVICE_NOT_CONNECTED`、`DEVICE_NO_SPACE`、`INSTALL_PARTIAL`、`IMPORT_VERIFY_FAILED`。`INSTALL_PARTIAL` 必须列出已写入文件和未完成文件，允许继续/回滚/重试。

### 24.5 从 `aily-blockly` 可借鉴的设计

已检查 `https://github.com/ailyProject/aily-blockly` 及其板卡仓库。可借鉴点如下，落地时不照搬 Arduino/Blockly 的编译模型，只吸收 UI 和资产组织思路：

| 参考点 | 对本插件链路的落地方式 |
|---|---|
| 工程化项目管理 | 每个 session/project 记录板卡、库、固件、生成文件和部署结果，避免全局状态污染 |
| 板卡按包组织 | 本地 boards 可学习 `board.json`、`board.webp`、`pinmap.webp`、`template/` 的分层思路 |
| 品牌/芯片筛选 | 启动页增加 Vendor、board type、chip series、port、feature 组合筛选 |
| 板卡卡片展示图片 | 爬取官方图并缓存展示，缺图时占位 |
| 库包结构校验 | MicroPython 库缓存也要有 manifest、来源、版本、文件列表和校验结果 |
| 串口工具 | REPL、串口日志、上传/烧录期间端口释放和恢复要成为通用能力 |
| FFS/文件系统工具 | 借鉴设备信息、分区/文件列表、上传、下载、重命名、删除、格式化/擦除前确认的交互模式 |
| AI 生成板卡配置 | 后续可提供“从板卡文档生成 boards JSON/pin layout”的贡献流程，但 P0 先实现官方索引缓存和手工增强 |

aily-blockly 板卡仓库中常见结构如下，可作为 `upy-analyze-plugin/boards` 后续扩展参考：

```text
board_name/
  board.json
  board.webp
  pinmap.webp
  package.json
  readme.md
  template/project.abi
  template/package.json
```

MicroPython 插件不需要引入 npm board package 机制，但可以借鉴“板卡元数据 + 图片 + 引脚图 + 模板 + 校验”的组织思想。对于本项目，模板仍由 `upy-scaffold-plugin` 负责；官方板卡事实、图片和分类由插件侧官方索引缓存提供，当前 `upy-analyze-plugin/boards` 只提供本地 pin/peripheral 增强信息和匹配规则。

## 25. 2026-06-27 当前本地重载基线与修订结论

本节按当前 `G:\MicroPython_Skills` 重新读取后追加，优先级高于前文中仍带有 2026-06-26 旧假设的段落。实现时以本节作为“当前事实源校正层”，尤其是板卡数据源、阶段输入输出和恢复机制。

### 25.1 当前应接入的目录和文件基线

生产插件只接入以下 6 个 `-plugin` skill，旧目录如 `upy-analyze`、`upy-select-hw`、`upy-generate`、`upy-deploy` 只能作为历史参考，不应进入生产 orchestrator 的 phase 映射。

| 阶段 | 当前目录 | `SKILL.md` 大小 | 当前子目录 |
|---|---|---:|---|
| analyze | `G:\MicroPython_Skills\upy-analyze-plugin` | 28348 | `boards`、`sample`、`scripts`、`test` |
| select-hw | `G:\MicroPython_Skills\upy-select-hw-plugin` | 40441 | `.codex-plugin`、`sample`、`scripts`、`test` |
| flash firmware | `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin` | 30677 | `agents`、`sample`、`scripts`、`test` |
| scaffold | `G:\MicroPython_Skills\upy-scaffold-plugin` | 16015 | `sample`、`scripts`、`templates`、`test` |
| generate | `G:\MicroPython_Skills\upy-generate-plugin` | 26463 | `.codex-plugin`、`agents`、`knowledge`、`references`、`sample`、`scripts`、`test` |
| deploy | `G:\MicroPython_Skills\upy-deploy-plugin` | 16060 | `.codex-plugin`、`sample`、`scripts`、`test` |
| package guide | `G:\MicroPython_Skills\upy-pkg-guide` | 4847 | `scripts` |

当前 `upy-analyze-plugin/boards` 实际文件是 `_template.json`、`matching-rules.json`、`README.md`、`esp32-c3-devkitm.json`、`esp32-devkit-v1.json`、`esp32-s3-devkitc.json`、`esp8266-nodemcu.json`、`m5stack-core.json`、`raspberry-pi-pico.json`、`raspberry-pi-pico-w.json`。这说明它是“本地增强板卡基线”，不是 MicroPython 官方全量索引。

### 25.2 板卡数据源边界的最终修订

- 官方全量板卡列表、Port/Feature/Vendor/MCU 过滤、官方固件页 URL，必须来自 `https://micropython.org/download/` 的抓取和缓存。
- `upy-analyze-plugin/boards` 只作为本地增强 overlay：pin layout、onboard peripherals、restricted GPIO、matching rules、相似板卡推荐。
- UI 不允许只展示 `upy-analyze-plugin/boards` 里的少量板卡；必须展示官方全量索引，并用 badge 区分“官方固件可用”“本地 pin layout 可用”“仅官方板卡，需手动接线或补 pin layout”。
- 官方图片可以抓取并缓存，但当前本地事实源没有 `boards/images/`。因此实现要求是“插件侧需要官方图片缓存能力”，不是“当前 boards 目录已经承载图片库”。
- 选择了官方板卡但本地无 `pin_layout` 时，`upy-select-hw-plugin` 不得伪造引脚；应进入 `board_unavailable`、相似已知板卡推荐、手动接线描述或 `partial/checkpoint`。

### 25.3 当前六阶段最短正确链路

```text
启动页：一句话需求 + beginner/custom + 官方板卡选择 + 已有硬件
-> start_phase(analyze)
-> upy-analyze-plugin phase_complete(next_phase=select-hw, next_skill=/upy-select-hw-plugin)
-> upy-select-hw-plugin phase_complete(next_phase=upy-flash-mpy-firmware-plugin)
-> upy-flash-mpy-firmware-plugin phase_complete(next_phase=upy-scaffold-plugin)
-> upy-scaffold-plugin phase_complete(next_phase=upy-generate-plugin)
-> upy-generate-plugin phase_complete(next_phase=upy-deploy-plugin 或 blocked/null)
-> upy-deploy-plugin phase_complete(result=PASS/FAIL/PASS_WITH_WARNINGS 对应的结构化结果)
```

每一阶段下游只消费上游 `phase_complete.payload.manifest_content`。日志、草稿文件、旧 conversation、旧 success 文件、模型记忆都不能作为阶段事实源。`phase_complete.payload.artifacts` 必须是数组，并包含 `file_list`、必要的 `file_manifest`、session/checkpoint 文件和本阶段正式产物。

### 25.4 当前各阶段硬约束补充

| 阶段 | 当前重载后的必须点 |
|---|---|
| analyze | 主确认是 `device_confirm`；最多一张补充卡；驱动搜索按 `builtin_runtime`、`micropython_lib`、`upypi`、`awesome-micropython`、`github`、`none/cold-driver` 分类；成功固定交给 `select-hw` 和 `/upy-select-hw-plugin`。 |
| select-hw | 从 analyze 的 `payload.manifest_content` 启动；无预选板卡发 `board_select`；本地板卡库无 pin layout 发 `board_unavailable`；`pin_plan_review` 未确认不得 success；非法 GPIO 不得静默改脚。 |
| flash | 从 select-hw manifest 读取板卡事实；`firmware_action` 支持 `download_and_flash`、`download_only`、`already_flashed`、`use_local_firmware`、`save_partial`、`cancel`；ESP32 必须真实扫描串口并确认后执行；Pico 走 UF2 复制确认；其他板卡走 manual。 |
| scaffold | 正式 full 链路要求 flash success；只发一张 `scaffold_config`，包含 scheduler 和模块选择；`module_logger`、`module_time_helper`、`module_maintenance`、`module_flash`、`module_log_tools` 决定实际文件；incremental 只生成新 driver stub 和 manifest，不重写主骨架。 |
| generate | full 先写 `generate_plan.json` 并校验；读取 mandatory references；先查 uPyPI 包索引，再 fallback；生成 PC unittest 和设备端 MicroPython unittest；云服务必须确认服务商、文档、价格、计费和凭据状态；质量门禁通过后必须 git commit；云服务 blocked/mock-only 不得默认 deploy。 |
| deploy | 必须真实扫描并选择串口；策略为 `upload_only`、`clean_then_upload`、`erase_then_upload`、`save_partial`；安装 `runtime_dependencies.mip` 用 `mpremote mip install` 并 fs verify；上传后捕获持久 REPL、读取日志、可运行 device tests；空 REPL 不直接 fail，可判 `PASS_WITH_WARNINGS`。 |

### 25.5 长流程协议和兼容输入要求

插件端必须把 LLM 输出视为“不稳定但可归一化的候选消息”，不能因为字段轻微变体、按钮别名、布尔/枚举大小写差异、审批卡片字段位置变化就直接判失败。宿主需要在进入阶段校验前做兼容 normalization，但 normalization 后仍必须写入原始消息、规范化消息和差异记录，便于复盘。

所有阶段必须支持：

| 机制 | 实现要求 |
|---|---|
| `session_id` | 一个用户项目/流程全程稳定；所有 artifact、checkpoint、日志、git 版本都关联该 ID。 |
| `checkpoint/resume` | `partial` 必须给 `checkpoint_id`、`resume_phase`、`resume_step`、`state_file`、`resume_label`；恢复时从 checkpoint 和上游 phase_complete 继续，不从头重跑。 |
| cancellation | 用户取消、关闭窗口、设备拔出、审批拒绝都要生成结构化取消状态；可恢复取消与不可恢复取消分开。 |
| retry | 同一动作重试复用原 `idempotency_key`，增加 `retry_of` 和 attempt；网络/串口/脚本临时错误可重试，模型上下文耗尽、用户取消默认不可自动重试。 |
| timeout | 所有审批、脚本、网络、串口、设备命令都必须有 `timeout_ms` 和 `on_timeout`；超时后按 retry/partial/failed 处理。 |
| idempotency key | 文件写入、下载、烧录、上传、删除、git commit、设备命令都要有稳定幂等键；危险动作不能靠重复按钮重复执行。 |
| protocol versioning | `protocol_version` 必填；破坏性字段调整必须升版本，旧版本走 adapter。 |
| capability negotiation | start_phase 显式声明 `approval_request`、`file_operation`、`script_run`、`device_command`、`serial_port_scan`、`checkpoint_resume`、`cancellation`、`git_operation` 等能力。 |
| structured error | 错误至少包含 code、severity、phase、step、retryable、message、details、artifact_refs、suggested_action。 |
| artifact/file manifest | 每个阶段列出正式产物、路径口径、sha256、状态、来源；路径应相对 artifact root，避免本机绝对路径泄露到正式 manifest。 |
| permission prompt | 文件读写、设备写入/删除、脚本执行、网络下载、固件烧录、擦除文件系统、git commit/tag 都要有权限提示和审计记录。 |

### 25.6 UI 按钮和全局工具的当前必备集合

主流程按钮包括：开始生成、选择/确认硬件、烧录 MicroPython 固件、选择本地固件烧录、生成项目骨架、生成业务代码、部署到设备、重试当前步骤、保存 checkpoint、取消流程、从 checkpoint 恢复。

设备工具区按钮包括：扫描端口、连接/断开 REPL、串口输出/REPL 监听、设备文件浏览器、刷新目录、上传文件、下载文件、双击查看设备端文件、删除设备文件、创建目录、重命名、清理/擦除设备文件系统、安装库、读取日志、下载日志、清空日志、运行设备测试、打开官方固件页。

版本工具按钮包括：可视化 Git 变更历史、查看文件 diff、按阶段查看 artifact 与 commit 关联、保存当前版本。保存当前版本必须允许用户输入版本名和版本摘要；实现可用 git commit/tag 或 session snapshot，但必须记录 `session_id`、manifest hash、artifact manifest 和用户摘要。

### 25.7 分阶段加载下的 prompt 与模型能力结论

在分阶段加载架构下，DeepSeek V4 Pro 这类后端模型的上下文长度本身通常不是首要问题；更大的风险是“阶段事实源不单一、加载顺序不稳定、输出文件也占用一次上下文、宿主缺少强校验和恢复协议”。如果每阶段都把上游完整旧文档、草稿、日志、目标输出和历史复盘一起塞入 prompt，模型会倾向走最短路径、漏读后文、发明工具用法或把旧状态当新状态。

正确做法是：每阶段只加载当前 `SKILL.md`、必要 references、上游 `phase_complete.payload.manifest_content`、当前 checkpoint/session state 和目标输出模板；不要同时加载旧 skill、旧草稿、长日志和完整汇总文档。输出文件本身要算入上下文预算：长规范、长 manifest、长错误日志应通过 artifact 引用和摘要进入 prompt，只有被当前步骤消费的字段才展开。模型能力可以影响稳定性，但如果没有 `phase_complete` 单一事实源、checkpoint/resume、幂等重试、结构化错误和兼容 normalization，即使换更强模型也会继续出现漏信息和中途卡死。



