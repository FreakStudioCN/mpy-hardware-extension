# MicroPython Skills 插件化交接说明

日期：2026-06-25

## 交付内容

本次把嵌入式侧维护的 MicroPython skill 资源同步给插件工程侧，目标项目：

```text
F:\mpy-hardware-extension
```

已同步目录：

```text
G:\MicroPython_Skills
-> F:\mpy-hardware-extension\third_party\MicroPython_Skills

G:\blockless-plugin-course(1)
-> F:\mpy-hardware-extension\docs\references\blockless-plugin-course
```

`docs/references/blockless-plugin-course` 只作为插件实现参考资料，不是运行时依赖。

## 只接入 `-plugin` 改造版 skill

插件生产链路应接入后缀为 `-plugin` 的改造版 skill，不要把无后缀的旧 skill 当作插件流程入口。

当前应优先接入的插件化 skill：

```text
third_party/MicroPython_Skills/upy-analyze-plugin
third_party/MicroPython_Skills/upy-select-hw-plugin
third_party/MicroPython_Skills/upy-flash-mpy-firmware-plugin
third_party/MicroPython_Skills/upy-scaffold-plugin
third_party/MicroPython_Skills/upy-generate-plugin
third_party/MicroPython_Skills/upy-deploy-plugin
```

推荐主流程：

```text
用户一句话需求
-> upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
-> upy-deploy-plugin
```

注意：`upy-analyze-plugin` 的历史协议里可能输出 `next_phase=select-hw` 和 `next_skill=/upy-select-hw-plugin`。插件工程侧不要只按 `next_phase` 字符串猜目录，应该优先使用 `next_skill` 或当前 phase 的显式映射表。

## 插件首屏必须有板卡选择页

插件刚开始必须有一个板卡选择页面，不能等到 select-hw 阶段才第一次让用户看到板卡。这个页面和“一句话需求输入”“小白/自定义模式选择”同属启动页输入，最终传给 `upy-analyze-plugin.payload.pre_selected_board` 和 `preferences`。

板卡数据源要求：

1. 正式板卡列表以 MicroPython 官方下载页为准：`https://micropython.org/download/`。
2. 官方下载页当前提供 Port、Feature、Vendor、MCU 等过滤维度，并列出各官方固件板卡；插件侧必须抓取/缓存这个官方索引，展示全部可选板卡。
3. 不允许只展示 `third_party/MicroPython_Skills/upy-analyze-plugin/boards` 里的少量板卡。这个本地 boards 目录只能表示“当前已有引脚布局和规则增强”的板卡，不是完整官方板卡列表。
4. 不允许从 `third_party/GraftSense-Drivers-MicroPython` 推导板卡或驱动支持范围。

板卡页 UI 要求：

| 功能 | 要求 |
| --- | --- |
| 分类 | 至少支持按品牌/Vendor、Port、MCU/芯片族分类；可额外按 Feature、常用开发板类型、官方固件板卡名分类 |
| 分页 | 必须分页或虚拟列表加载，不能一次性把全部板卡塞成不可浏览的长列表 |
| 搜索 | 支持按板卡名、Vendor、MCU、Port、固件 board name 搜索 |
| 筛选 | 支持 Port、Vendor、MCU、Feature 多条件筛选 |
| 板卡卡片 | 展示显示名、Vendor、Port、MCU/芯片族、Feature、官方固件页面 URL、固件 board name/download slug |
| 本地支持标识 | 标出“已内置 pin_layout/可自动分配引脚”和“仅官方固件可用/后续需手动接线或补板卡资料” |
| 刷新 | 提供“刷新官方板卡列表”能力，并记录 `fetched_at`、`source_url`、缓存版本 |
| 兜底 | 网络失败时可读上次缓存，但 UI 必须提示官方列表可能过期 |

选择行为：

1. 用户选择具体板卡时，插件把官方板卡事实写入 `pre_selected_board`，至少包含 `id`、`display_name`、`vendor`、`port`、`mcu`、`features`、`firmware.url`、`firmware.board_name`、`download_slug`、`source_url`。
2. 用户也可以选择“暂不指定板卡/由系统推荐”，此时仍然展示完整板卡页，但传给 analyze 的 `pre_selected_board=null`。
3. 如果用户预选的官方板卡还没有本地 `pin_layout`，`upy-select-hw-plugin` 不能假装自动支持；应进入 `board_unavailable`、推荐相似已知板卡、要求手动接线描述，或输出 partial/checkpoint 等待补板卡资料。
4. 如果 `pre_selected_board` 已经来自插件 UI，`upy-select-hw-plugin` 可以跳过 `board_select`，但仍必须校验该板卡存在固件和 `pin_layout`，并记录跳过原因。

推荐启动页输入结构：

```json
{
  "user_description": "做一个温湿度监测仪，超过阈值蜂鸣器报警，并在 OLED 上显示数据",
  "pre_selected_board": {
    "id": "ESP32_GENERIC_C3",
    "display_name": "ESP32-C3",
    "vendor": "Espressif",
    "port": "esp32",
    "mcu": "esp32c3",
    "features": ["BLE", "WiFi"],
    "firmware": {
      "url": "https://micropython.org/download/ESP32_GENERIC_C3/",
      "board_name": "ESP32_GENERIC_C3"
    },
    "download_slug": "ESP32_GENERIC_C3",
    "source_url": "https://micropython.org/download/"
  },
  "preferences": {
    "mode": "beginner",
    "locale": "zh"
  },
  "existing_hardware": []
}
```

## 启动默认选项和模式清单

我按当前 `G:\MicroPython_Skills\*-plugin\SKILL.md` 检查后，插件侧需要显式承载这些默认选项：

| 阶段 | 插件侧选项 | 默认/推荐 | 注意 |
| --- | --- | --- | --- |
| `upy-analyze-plugin` | `preferences.mode`: `beginner` / `custom` | 缺省为 `beginner` | skill 明确“不再先问小白/自定义”，所以插件首屏必须提供模式选择；不能由模型替用户默认点击确认 |
| `upy-analyze-plugin` | `preferences.locale` | 缺省为 `zh` | 影响卡片文案和结果文案 |
| `upy-analyze-plugin` | `pre_selected_board` | 可为 `null` | 来自首屏板卡页；为空时只记录未选板卡，不在 analyze 内最终选型 |
| `upy-analyze-plugin` | `existing_hardware` | 缺省 `[]` | 只作为器件清单补充，不做复杂推导 |
| `upy-select-hw-plugin` | `board_select` | 无预选板卡时默认弹出 | 若 `pre_selected_board` 来自插件 UI，可跳过，但必须校验固件和 `pin_layout` |
| `upy-select-hw-plugin` | `pin_plan_review` | 必须用户确认 | 引脚分配不能在用户未确认前输出 success |
| `upy-flash-mpy-firmware-plugin` | `firmware_action`: `download_and_flash`、`download_only`、`already_flashed`、`use_local_firmware`、`save_partial`、`cancel` | UI 可把 `download_and_flash` 标为 primary | 除非 payload 已有 `firmware_action`，下载或烧录前必须先展示审批 |
| `upy-scaffold-plugin` | `mode`: `full` / `incremental` | 主链路为 `full` | 新增器件可用 incremental |
| `upy-scaffold-plugin` | 调度模式：`mode_timer`、`mode_async`、`mode_thread` | Wi-Fi/display/LVGL 推荐 `mode_async`，其他推荐 `mode_timer` | 推荐只影响 selected/meta，不能限制用户选择 |
| `upy-scaffold-plugin` | 模块：`module_logger`、`module_time_helper`、`module_maintenance`、`module_flash`、`module_log_tools` | 按需求预选 | `module_log_tools` 对应 `tools/read_device_log.py` + `tools/log_report.py` |
| `upy-generate-plugin` | `mode`: `full` / `fix` | 主链路为 `full`，部署/测试失败后为 `fix` | full 成功默认 `next_phase=upy-deploy-plugin`，但云服务 blocked/mock-only 时不能默认 deploy |
| `upy-deploy-plugin` | `deploy_strategy`: `upload_only`、`clean_then_upload`、`erase_then_upload`、`save_partial` | 推荐 `clean_then_upload` | `erase_then_upload` 必须 dry-run 和二次确认 |
| `upy-deploy-plugin` | 串口选择 | 必须扫描真实串口并让用户选择 | 真实运行不能固定 `COM3` |

## 插件如何调用 skill

插件侧不要直接把 skill 当作普通脚本运行。应把每个 `-plugin` 目录下的 `SKILL.md` 当作该阶段的协议和执行约束，把插件宿主能力封装为结构化调用：

```json
{
  "protocol_version": "1.0",
  "type": "start_phase",
  "phase": "upy-generate-plugin",
  "session_id": "<session_id>",
  "idempotency_key": "upy-generate-plugin:<session_id>:full:v1",
  "payload": {
    "mode": "full",
    "source_phase": "upy-scaffold-plugin",
    "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_scaffold_plugin.json",
    "runtime_context": {
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/<session_id>",
      "project_root": "sessions/<session_id>/project",
      "resource_root": "F:\\mpy-hardware-extension\\third_party\\MicroPython_Skills"
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

关键 root 约定：

| 字段 | 含义 |
| --- | --- |
| `resource_root` | skill 资源根目录，即 `third_party/MicroPython_Skills` |
| `artifact_root` | 本次会话产物根目录，不是 skill 根目录 |
| `session_root` | 当前 session 的相对目录，例如 `sessions/<session_id>` |
| `project_root` | 生成出来的项目目录，例如 `sessions/<session_id>/project` |

插件侧需要提供的最小能力：

| 能力 | 用途 |
| --- | --- |
| `approval_request` | 展示器件确认、板卡确认、烧录确认、部署策略、失败后下一步等卡片 |
| `file_operation` | 读取上游 phase_complete，写入项目文件和产物 |
| `script_run` | 运行 skill 内白名单脚本和项目内工具 |
| `serial_port_scan` | 枚举真实串口，不能在真实运行中固定 `COM3` |
| `device_command` | 软复位、上传、运行设备端命令、读取日志 |
| `checkpoint_resume` | 长流程中断后恢复 |

每个阶段完成标准都是输出结构化 `phase_complete`，下游必须消费 `payload.manifest_content`，不要从日志、旧草稿或 conversation 记忆推断状态。

## 设备端 unittest 怎么处理

示例目录：

```text
G:\test\test\sessions\9b41c640-99c4-49c8-b267-e0f3ec8ffc89\project\device\tests
```

这个目录里的 `test_audio_contract.py`、`test_led_contract.py` 是 MicroPython 可运行的 `unittest` 合约测试，不是 PC 侧 pytest。

职责建议：

1. `upy-generate-plugin` 负责生成 `project/device/tests/test_*.py`，并在生成阶段运行静态质量门禁 `check_device_unittest_subset.py`，保证只使用 MicroPython 支持的 unittest 子集。
2. `upy-deploy-plugin` 负责在真实设备部署后运行这些测试，并把结果纳入部署判定。推荐时机是：上传 firmware 后、soft reset 后、捕获 REPL 输出前后均可，但最终 `deploy_result` 必须包含 device unittest 结果。
3. 插件 UI 上应同时体现为流程步骤和独立按钮：
   - 主流程中自动出现“运行设备端测试”步骤，默认在部署后执行。
   - 另外提供独立按钮“运行硬件测试/设备测试”，方便用户改线、换板、修代码后单独重跑。

建议运行方式：

```text
mpremote connect <port> resume run project/device/tests/test_audio_contract.py
mpremote connect <port> resume run project/device/tests/test_led_contract.py
```

如果项目实际执行环境要求先上传测试文件到板端，也可以由 deploy 阶段先同步 `device/tests`，再逐个运行。测试失败时优先进入 `upy-autofix-plugin`；如果该阶段未落地，则进入 `upy-generate-plugin(mode=fix, source=deploy_fail)`。

## 日志读取工具怎么处理

示例目录：

```text
G:\test\test\sessions\9b41c640-99c4-49c8-b267-e0f3ec8ffc89\project\tools
```

相关脚本：

```text
project/tools/read_device_log.py
project/tools/log_report.py
```

职责建议：

1. `upy-scaffold-plugin` 在用户选择日志工具模块时生成日志工具骨架。
2. `upy-generate-plugin` 可补齐与业务相关的日志字段和配置，但不负责连接真实设备读取日志。
3. `upy-deploy-plugin` 在部署验证阶段调用 `project/tools/read_device_log.py` 和 `project/tools/log_report.py`，把日志摘要写入 `deploy_result`。
4. 插件 UI 应提供独立按钮“读取设备日志”，支持 tail、下载、清空三类操作，作为部署失败后的诊断入口。

建议按钮能力：

```text
读取日志：python project/tools/read_device_log.py --port <port> --tail 100
下载日志：python project/tools/read_device_log.py --port <port> --download <local_dir>
清空日志：python project/tools/read_device_log.py --port <port> --clear
```

## mpremote 串口输出按钮

建议插件上做一个独立按钮“串口输出/REPL 监听”，直接基于 `mpremote` 连接串口读取输出。这个按钮不应只藏在部署流程里，因为嵌入式调试经常需要反复观察设备启动日志、异常栈和运行状态。

实现建议：

1. 先调用统一串口扫描入口，让用户选择端口。
2. 真实运行必须使用用户选择的端口，不要写死 `COM3`。
3. 长时间监听使用持久会话模型，可复用：

```text
third_party/MicroPython_Skills/upy-deploy-plugin/scripts/capture_repl.py
```

4. 不要用反复 `mpremote resume exec` 代替持久 REPL 监听。
5. 按钮应支持开始、停止、清屏、保存输出、复制输出，并能把最近输出片段传给 `upy-generate-plugin(mode=fix)` 或 `upy-autofix-plugin`。

## 第三方驱动目录限制

插件工程侧不要从下面目录直接调用驱动包：

```text
F:\mpy-hardware-extension\third_party\GraftSense-Drivers-MicroPython
```

原因：

1. 该目录内容不完整，不能代表可用驱动包全集。
2. 它不符合正常的驱动包下载和解析流程。
3. `upy-generate-plugin` 应根据 manifest 中的驱动事实、UpyPI、官方仓库、GitHub fallback 或用户确认的来源来解析/下载/生成驱动依赖。
4. 插件可以把该目录当作人工参考，但不能把它作为生产链路的唯一驱动源或默认 vendor 源。

## 插件侧建议页面/按钮

建议最少提供这些入口：

| 入口 | 调用对象 | 说明 |
| --- | --- | --- |
| 启动页：需求/模式/板卡 | 主链路 orchestrator + 官方板卡索引 | 必须展示小白/自定义模式和 `https://micropython.org/download/` 全量板卡选择页，支持分类、筛选、搜索、分页 |
| 一句话生成硬件 | 主链路 orchestrator | 从 `upy-analyze-plugin` 开始跑完整流程，并传入首屏的 `preferences`、`pre_selected_board`、`existing_hardware` |
| 选择/确认硬件 | `upy-select-hw-plugin` | 可从 analyze 结果继续，也可调试单阶段 |
| 烧录 MicroPython 固件 | `upy-flash-mpy-firmware-plugin` | 只处理解释器固件，不部署业务代码 |
| 生成项目骨架 | `upy-scaffold-plugin` | 生成 `firmware/`、`tools/`、`.upy/` |
| 生成业务代码 | `upy-generate-plugin` | 生成 driver adapter、task、main、测试 |
| 部署到设备 | `upy-deploy-plugin` | 上传、软复位、REPL、日志、测试、结果判定 |
| 串口输出/REPL 监听 | `upy-deploy-plugin/scripts/capture_repl.py` 或宿主封装 | 独立诊断按钮 |
| 读取设备日志 | `project/tools/read_device_log.py` | 独立诊断按钮 |
| 运行硬件测试 | `project/device/tests/test_*.py` | 部署后自动，也支持单独重跑 |

## 建议 commit 内容

`third_party/MicroPython_Skills` 是 git submodule，不能只在父仓库提交 `third_party/MicroPython_Skills/**` 的文件内容。建议分两层提交：

1. 先在 submodule 内提交 MicroPython skill 同步内容。
2. 再在父仓库提交 submodule 指针、交接文档和课程参考资料。

### Submodule commit

建议标题：

```text
feat: add pluginized MicroPython workflow skills
```

建议摘要：

```text
Sync the updated MicroPython skill resources, including the pluginized one-sentence hardware workflow phases and shared mpremote helpers.
```

建议正文：

```text
feat: add pluginized MicroPython workflow skills

- Add `upy-analyze-plugin`, `upy-select-hw-plugin`, `upy-flash-mpy-firmware-plugin`, `upy-scaffold-plugin`, `upy-generate-plugin`, and `upy-deploy-plugin`.
- Add shared mpremote helpers used by flash/deploy plugin phases.
- Sync updated legacy skill documentation and helper scripts from the embedded-side MicroPython_Skills workspace.
```

建议提交范围：

```text
cd F:\mpy-hardware-extension\third_party\MicroPython_Skills
git add .
git commit -m "feat: add pluginized MicroPython workflow skills"
```

### Parent repo commit

建议标题：

```text
docs: hand off MicroPython plugin skills
```

建议摘要：

```text
Add the MicroPython plugin-skill handoff document, plugin-course reference material, and update the MicroPython_Skills submodule pointer.
```

建议正文：

```text
docs: hand off MicroPython plugin skills

- Update the MicroPython_Skills submodule pointer to the synced pluginized workflow skills.
- Add blockless plugin course reference material under docs/references/blockless-plugin-course for extension-side implementation reference.
- Document how the extension should call `-plugin` skills, pass runtime roots/capabilities, run device unittests, read logs, expose mpremote serial output, and avoid using the incomplete GraftSense driver mirror as a production driver source.
```

建议提交范围：

```text
third_party/MicroPython_Skills
docs/references/blockless-plugin-course/**
docs/micropython-skills-plugin-handoff.md
```

不要提交 `.git`、`.idea`、`__pycache__`、`*.pyc` 等本地元数据或缓存。
