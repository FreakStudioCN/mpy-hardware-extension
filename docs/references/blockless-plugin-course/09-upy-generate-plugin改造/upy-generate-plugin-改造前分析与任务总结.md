# upy-generate-plugin 改造前分析与任务总结

生成时间：2026-06-23

本文件只做分析和改造规划，不修改现有 skill。后续真正实施时，应在 `G:\MicroPython_Skills` 下新建 `upy-generate-plugin`，不得覆盖或原地改造 `G:\MicroPython_Skills\upy-generate`。

---

## 1. 本次任务目标

本次任务的直接目标是：

1. 先分析“一句话生成硬件”工作流中 `upy-generate` 阶段如何插件化。
2. 把分析结果输出为 `G:\blockless-plugin-course(1)` 下的新建 Markdown 文件。
3. 明确后续应创建新的 `G:\MicroPython_Skills\upy-generate-plugin`，而不是覆盖原有 `G:\MicroPython_Skills\upy-generate`。
4. 对齐前置四个插件化阶段：
   - `G:\MicroPython_Skills\upy-analyze-plugin`
   - `G:\MicroPython_Skills\upy-select-hw-plugin`
   - `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`
   - `G:\MicroPython_Skills\upy-scaffold-plugin`
5. 参考原始产品规划和目标接口：
   - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\一句话造硬件-功能规划.md`
   - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\upy-generate.md`
6. 结合已有架构分析与 Skill 接口分析：
   - `G:\blockless-plugin-course(1)\02-架构分析`
   - `G:\blockless-plugin-course(1)\03-Skill接口`

本次不做的事：

- 不创建 `upy-generate-plugin` 目录。
- 不修改 `upy-generate`、`upy-analyze-plugin`、`upy-select-hw-plugin`、`upy-flash-mpy-firmware-plugin`、`upy-scaffold-plugin`。
- 不修改 `plugin-interface/skills/upy-generate.md`。
- 不跑联网下载、烧录、设备命令。

---

## 2. 当前证据和结论

### 2.1 原始规划里的 generate 定位

原始规划把“一句话造硬件”拆成流水线：

```text
用户自然语言
-> upy-analyze
-> upy-select-hw
-> upy-scaffold
-> upy-generate
-> upy-simulate
-> upy-deploy
-> upy-autofix
-> upy-wiring / upy-diagram
```

其中 `upy-generate` 是 Phase 4，职责是生成完整业务代码。原始规划强调：

- Skill 间通过 `project-manifest.json` 传递状态。
- LLM 负责代码生成、需求理解、修复判断。
- 脚本负责确定性校验、数据转换、设备动作。
- MicroPython 是优先目标平台。

### 2.2 旧 `upy-generate` 的真实现状

当前 `G:\MicroPython_Skills\upy-generate` 只有：

```text
upy-generate/
├── SKILL.md
└── scripts/download_drivers.py
```

旧 `SKILL.md` 是本地直跑形态，默认可以直接：

- 读取 `project-manifest.json`
- 执行 Bash / Python
- 把驱动下载到 `firmware/lib/`
- 修改 `firmware/lib/` 下的驱动源码
- 生成 `drivers/*_driver`
- 生成 `tasks/*`
- 修改 `firmware/conf.py`
- 修改 `firmware/main.py`
- 生成 `test/pc` 和 `test/device`
- 本地跑 `flake8`、`pylint`
- 用内联脚本做 MicroPython import 检查和死配置检查
- 直接更新 `project-manifest.json`

这说明旧 `upy-generate` 的本质是：

```text
本地 agent 直接执行的专家操作手册
```

它同时承担业务决策和本地执行，尚未拆成“服务器端 LLM 决策 + 插件端执行工具”的协议形态。

### 2.3 旧 `download_drivers.py` 的关键问题

旧脚本当前形态：

```text
python download_drivers.py --project-dir <project_dir>
```

它会：

- 从 `<project_dir>/project-manifest.json` 读 manifest。
- 直接联网请求 upypi / GitHub。
- 直接写 `<project_dir>/firmware/lib/*`。
- 直接修改 `<project_dir>/project-manifest.json`。
- 只通过 stdout/stderr 输出文本日志，不输出稳定 JSON 产物。

这与目标插件协议不匹配。插件化后不应该让脚本直接写项目目录，也不应该让它直接改 manifest。目标应改为：

```text
stdin manifest 或 --manifest <path>
-> stdout JSON
-> LLM / host 解析 JSON
-> file_operation(write) 写入插件端项目目录
-> phase_complete.payload.manifest_content 统一交付新 manifest
```

### 2.4 目标接口文档里的 generate 定位

`plugin-interface/skills/upy-generate.md` 已经给出目标接口，核心点是：

- phase: `generate`
- 上游：
  - `upy-scaffold` 的 full 模式
  - `upy-autofix` 的 fix 模式
- 下游：
  - `upy-simulate` 手动触发
  - `upy-deploy` 自动进入
- 运行模式：
  - `full`
  - `fix`
- full 模式职责：
  - 下载驱动
  - 理解 API
  - 生成工厂 + Mock
  - 生成 task
  - 补充 conf.py
  - 生成 main.py DI 装配
  - 生成测试
  - 多层校验
  - 输出 `phase_complete`
- fix 模式职责：
  - 读取报错文件
  - 最小化修改
  - lint 验证
  - 返回 code_diff

这份目标接口是后续实现 `upy-generate-plugin` 的蓝图，不等于当前旧 `upy-generate` 已经实现。

---

## 3. 与前置四个插件阶段的衔接关系

### 3.1 当前插件化主链路

从已存在的插件版 skill 看，当前链路已经朝这个方向收敛：

```text
upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
```

`upy-scaffold-plugin/SKILL.md` 已经明确写出：

```text
upy-analyze-plugin -> upy-select-hw-plugin -> upy-flash-mpy-firmware-plugin -> upy-scaffold-plugin -> upy-generate-plugin
```

并且 scaffold 成功时 `next_phase` 应为 `upy-generate-plugin`。

这说明 `upy-generate-plugin` 不是可选命名，而是前置插件阶段已经预留的正式下游。

### 3.2 `upy-analyze-plugin` 给 generate 的间接输入

`upy-analyze-plugin` 不直接调用 generate，但它写入 generate 必须依赖的基础事实：

- `requirements.description`
- `requirements.network`
- `requirements.output`
- `requirements.special_requirements`
- `devices[]`
- `devices[].driver`
- 冷门驱动标记
- 用户明确指定的器件和行为语义

generate 后续不能重新发明需求，也不能丢失用户指定器件。它应把 analyze 的 `manifest_content` 视为业务需求来源。

### 3.3 `upy-select-hw-plugin` 给 generate 的关键输入

`upy-select-hw-plugin` 输出：

- `mcu`
- `hardware_selection.selected_board`
- `pinout`
- `pin_decisions`
- `pin_review`
- `bom`
- 经过用户确认或带 checkpoint 的引脚方案

generate 必须使用这些字段生成：

- `board.py` 引脚引用
- `main.py` 中的 `Pin/I2C/SPI/I2S/UART` 初始化
- `test/device/test_smoke.py`
- I2C 地址扫描逻辑
- GPIO / I2S / WiFi / 网络初始化逻辑

generate 不应该重新选择 MCU、重新分配引脚或静默改写用户确认的 pinout。发现 pinout 不可用时，应输出结构化错误或交给上游修正，而不是在代码里偷偷换脚。

### 3.4 `upy-flash-mpy-firmware-plugin` 给 generate 的边界

`upy-flash-mpy-firmware-plugin` 负责 MicroPython 固件准备：

- 下载固件
- 烧录固件
- 或确认用户已烧录
- 输出 `firmware_flash`
- 将 `next_phase` 指向 `upy-scaffold-plugin`

generate 不应重复做 MicroPython 固件烧录，也不应把“固件是否已刷好”当作自己内部步骤。它可以读取 manifest 中的 `firmware_flash.status` 作为运行前提和下游 deploy 的上下文。

### 3.5 `upy-scaffold-plugin` 给 generate 的直接输入

`upy-scaffold-plugin` 是 generate 的直接上游。它只生成骨架，不生成业务逻辑：

- `firmware/board.py`
- `firmware/conf.py`
- `firmware/main.py`
- `firmware/boot.py`
- `firmware/lib/logger/*`
- `firmware/lib/scheduler/*`
- `tools/*`
- `.flake8`
- `project-manifest.json`

scaffold 明确把这些留给 generate：

- 不写业务 task
- 不填驱动实现
- 不做同步/异步驱动转换
- 不生成业务代码

因此 `upy-generate-plugin` 的 full 模式必须以 scaffold 的项目根为输入，读取已有 `conf.py` 和 `main.py` 后再补全。它不能假设本地当前目录就是项目根，必须使用 `runtime_context.project_root` 或 `file_operation_root`。

### 3.6 generate 之后的下一阶段判断

`upy-generate-plugin` 后面不是简单二选一，而是三条不同性质的路径：

```text
默认真实设备路径:
  upy-generate-plugin
  -> upy-deploy-plugin
  -> 设备运行 / 日志捕获 / 硬件连通性验证

用户可选业务模拟路径:
  upy-generate-plugin
  -> upy-simulate-plugin
  -> PC 端数据发生器 / 业务状态机 / task 调度逻辑模拟

用户可选图表产物路径:
  upy-generate-plugin
  -> upy-diagram-plugin
  -> 架构图 / 流程图 / 数据流图

失败修复路径:
  upy-deploy-plugin 发现运行失败、设备输出异常或硬件 sanity 失败
  -> upy-autofix-plugin
  -> 按错误类型委托 upy-generate-plugin / upy-select-hw-plugin / upy-analyze-plugin 等上游修复
  -> 修复后重新回到 upy-deploy-plugin 验证
```

因此，`upy-generate-plugin` 的 full 模式成功时，默认 `next_phase` 应该指向 `upy-deploy-plugin`，但用户可以选择先进入 `upy-simulate-plugin`。`upy-autofix-plugin` 不是 generate 成功后的直接下一阶段。原因是 generate 阶段只完成“代码可生成、静态校验可过、测试文件可生成”，还没有把代码上传到真实设备运行；只有 deploy 阶段掌握设备上传、软复位、串口输出、mpremote 运行结果、I2C scan 等真实反馈。而 simulate 阶段适合在没有设备、暂不想烧录、或想先检查业务逻辑时，先用 PC 端数据发生器验证 task、状态机和输出行为。

建议 `start_phase` 支持用户或宿主传入：

```json
{
  "payload": {
    "next_phase_preference": "deploy | simulate | stop_after_generate"
  }
}
```

决策规则：

| 条件 | `next_phase` |
|---|---|
| 用户选择“先模拟业务逻辑” | `upy-simulate-plugin` |
| 没有设备、没有串口、固件未确认、用户暂不烧录 | `upy-simulate-plugin` 或 `null`，由用户选择 |
| 生成的是复杂状态机、网络/语音/报警逻辑，用户希望先看行为 | `upy-simulate-plugin` |
| 用户选择“直接上板运行”且固件/设备准备好 | `upy-deploy-plugin` |
| 用户只想生成代码不继续执行 | `null`，带 checkpoint |

除了主 `next_phase`，每次 `upy-generate-plugin` full 或 fix 成功后，都应询问用户是否需要调用 `upy-diagram-plugin` 生成图表。这是附加产物路径，不应和 deploy/simulate 主路径互斥。

建议发出：

```json
{
  "type": "approval_request",
  "payload": {
    "approval_id": "generate_diagram_offer",
    "header": "生成架构图和数据流图",
    "question": "代码已生成并通过校验，是否基于当前项目生成架构图、流程图和数据流图？",
    "actions": [
      {"label": "生成图表", "value": "run_diagram", "primary": true},
      {"label": "暂不生成", "value": "skip"}
    ]
  }
}
```

若用户选择 `run_diagram`，应把 `upy-diagram-plugin` 作为 optional follow-up 记录，而不是覆盖主 `next_phase`：

```json
{
  "payload": {
    "next_phase": "upy-deploy-plugin",
    "optional_next_phases": [
      {
        "phase": "upy-diagram-plugin",
        "reason": "user_requested_architecture_and_dataflow_diagrams"
      }
    ]
  }
}
```

`upy-diagram-plugin` 的输入应是 generate 后的最终 `manifest_content`、`file_manifest`、项目代码树和关键文件内容。它不应要求重新跑 analyze/select-hw/scaffold，也不应修改业务代码。若后续 deploy/autofix 修改了代码，diagram 可再次运行，生成新版本图表。

`upy-autofix-plugin` 的位置应是错误编排层，不是 generate 成功后的直接下一阶段。它应在 deploy、device smoke、运行日志或后续测试失败后被触发，然后根据错误类型反向委托：

| 错误类型 | autofix 应委托的阶段 |
|---|---|
| 业务代码异常、驱动 API 调用错误、死循环、内存/看门狗风险 | `upy-generate-plugin` 的 `mode=fix` |
| 引脚冲突、I2C 地址/总线错误、用户接线与 pinout 不一致 | `upy-select-hw-plugin` 或其 fix/incremental 模式 |
| 需求理解缺失、器件选错、冷门驱动路径漏判 | `upy-analyze-plugin` 或 `upy-gen-driver-plugin` |
| 烧录、串口、设备连接、文件上传失败 | `upy-deploy-plugin` 自身重试或设备排查流程 |

所以后续改造时，建议把 `upy-generate-plugin` 的正常完成输出写成可变 next phase。默认设备路径：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "upy-generate-plugin",
    "result": "success",
    "next_phase": "upy-deploy-plugin"
  }
}
```

用户选择先模拟时：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "upy-generate-plugin",
    "result": "success",
    "next_phase": "upy-simulate-plugin",
    "next_phase_reason": "user_requested_business_logic_simulation"
  }
}
```

如果还没有实现 `upy-deploy-plugin` 或 `upy-simulate-plugin`，迁移期可以临时指向旧 `upy-deploy` / `upy-simulate`，但文档和样例中必须标明这是过渡状态。最终插件化目标应是：

```text
默认: upy-generate-plugin -> upy-deploy-plugin -> upy-autofix-plugin(仅失败时)
可选: upy-generate-plugin -> upy-simulate-plugin -> upy-deploy-plugin 或停止
```

---

## 4. 插件化改造的核心原则

### 4.1 不是重写业务逻辑，而是翻译运行形态

旧 `upy-generate` 的业务逻辑仍然有价值。后续改造不是推倒重写，而是把：

```text
直接读文件 / 直接写文件 / 直接跑命令
```

翻译为：

```text
file_operation(read)
file_operation(write)
script_run(...)
status_update(...)
phase_complete(...)
```

也就是把“本地直跑 skill”改成“插件协议 skill”。

### 4.2 服务器端和插件端职责必须分清

目标架构应遵守：

```text
服务器端 LLM / skill:
  - 理解 manifest 和用户需求
  - 读驱动源码并推断 API
  - 设计工厂、Mock、task、测试
  - 判断错误修复策略
  - 生成协议消息

插件端:
  - 渲染 status / approval / diff / artifact
  - 读写本地项目文件
  - 执行白名单脚本
  - 执行 mpremote / serial / 本地工具链命令
  - 把结果按协议回传
```

插件端不应理解 MicroPython 业务语义，不应决定驱动 API，不应自动改 pinout。

### 4.3 所有阶段交接以 `manifest_content` 为准

正式链路中，generate 的输入应优先来自：

```text
phase_complete(upy-scaffold-plugin).payload.manifest_content
```

直测时可从文件读取 `phase_complete.upy_scaffold_plugin.json`，但仍应取其中的 `payload.manifest_content`。不要从旧草稿、日志、对话记忆推断项目状态。

### 4.4 路径必须相对项目根

后续 `file_operation` 路径必须是相对 `project_root` 的 POSIX 风格路径，例如：

```text
firmware/lib/ahtx0.py
firmware/drivers/aht20_driver/__init__.py
firmware/tasks/sensor_task.py
firmware/conf.py
firmware/main.py
test/pc/test_sensor_task.py
test/device/test_smoke.py
project-manifest.json
```

不应在协议消息里写 Windows 绝对路径。绝对路径只应存在于本地 runner 或测试环境变量里。

### 4.5 `upy-generate-plugin` 必须是新目录

后续实施时应：

```text
新增 G:\MicroPython_Skills\upy-generate-plugin
保留 G:\MicroPython_Skills\upy-generate 不变
```

原因：

- 旧 `upy-generate` 仍可作为本地直跑参考。
- 前置插件版阶段已经引用 `upy-generate-plugin`。
- 插件版协议、样例、runner、测试会和旧 skill 形态明显不同。
- 原地改造会破坏旧流水线验证能力。

---

## 5. `upy-generate-plugin` 建议目录结构

后续实施时建议目录：

```text
G:\MicroPython_Skills\upy-generate-plugin\
├── SKILL.md
├── scripts\
│   ├── download_drivers.py
│   ├── check_mpy_imports.py
│   ├── check_dead_config.py
│   └── check_skeleton_compliance.py
├── sample\
│   ├── start_phase.upy_generate_plugin.full.json
│   ├── start_phase.upy_generate_plugin.fix.json
│   ├── phase_complete.upy_generate_plugin.success.json
│   ├── phase_complete.upy_generate_plugin.fix_success.json
│   ├── status_update.generate.sequence.jsonl
│   └── code_diff.fix.sample.json
└── test\
    ├── smoke_tests.py
    ├── mock_plugin.py
    ├── run_local_mock_session.py
    └── generate_runner.py
```

是否把 `scripts/download_drivers.py` 直接复制旧脚本要谨慎。旧脚本会写项目目录和改 manifest，不能原样放进插件版。

---

## 6. full 模式工作流建议

### 6.1 启动输入

建议 full 模式启动消息：

```json
{
  "type": "start_phase",
  "phase": "upy-generate-plugin",
  "payload": {
    "mode": "full",
    "source_phase": "upy-scaffold-plugin",
    "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_scaffold_plugin.json",
    "runtime_context": {
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/<session_id>",
      "project_root": "sessions/<session_id>/project",
      "resource_root": "<runtime-provided>"
    },
    "capabilities": {
      "file_operation": true,
      "script_run": true,
      "approval_request": false
    }
  }
}
```

如果 `payload.manifest_content` 已直接传入，可优先使用；否则追溯 `source_phase_complete_path`。

### 6.2 Step 0: 读取上游与项目骨架

必须确认：

- 上游 `phase_complete.payload.result == "success"`。
- 上游 `next_phase == "upy-generate-plugin"` 或当前显式 start phase 为 generate。
- `manifest_content.phase == "scaffold"` 或包含 scaffold 输出字段。
- `runtime_context.project_root` 存在。
- scaffold 已写入基础文件。

应读取：

```text
firmware/conf.py
firmware/main.py
project-manifest.json
.flake8
```

读取方式应为 `file_operation(read)`，不要让 skill 直接读磁盘。

### 6.3 Step 1: 驱动下载和归一化

目标接口中写的是服务器内部运行 `download_drivers.py`，stdin manifest，stdout JSON。

建议后续实现时支持两种运行方式：

1. 正式云端模式：
   - 后端或 package service 运行驱动解析和下载。
   - 输出 JSON 给 LLM。
   - 由 LLM 发 `file_operation(write)` 写入插件端项目。

2. 本地 mock / 直测模式：
   - `script_run(download_drivers.py)` 可以在本地跑。
   - 但脚本仍只能 stdout JSON，不能直接写项目目录。

脚本输出建议：

```json
{
  "drivers": [
    {
      "device_name": "AHT20",
      "source": "upypi",
      "package_name": "micropython-ahtx0",
      "version": null,
      "files": [
        {
          "path": "firmware/lib/ahtx0.py",
          "content": "...",
          "encoding": "utf-8"
        }
      ],
      "warnings": []
    }
  ],
  "errors": [],
  "summary": "Downloaded 1/1 drivers, 1 files total"
}
```

关键改造点：

- 输入从 `--project-dir` 改为 `--manifest -` 或 `--manifest <path>`。
- stdout 输出结构化 JSON。
- stderr 输出日志。
- 不写项目目录。
- 不修改 `project-manifest.json`。
- 内置 `\r\r\n` 等换行修复。
- 输出的 file path 必须相对项目根。

### 6.4 Step 2: 写入驱动文件

对 Step 1 的 `files[]` 逐个发：

```json
{
  "type": "file_operation",
  "payload": {
    "op": "write",
    "path": "firmware/lib/ahtx0.py",
    "content": "...",
    "encoding": "utf-8"
  }
}
```

写入后，LLM 仍应直接使用 Step 1 JSON 中的源码内容做 API 理解，不需要再读一遍文件。

### 6.5 Step 3: 生成工厂和 Mock

对每个器件生成：

```text
firmware/drivers/<device>_driver/__init__.py
firmware/drivers/<device>_driver/mock.py
```

约束沿用旧 `upy-generate`：

- Mock 方法签名必须来自真实驱动源码。
- I2C 器件要导出 `create_<name>` 和 `scan_<name>_i2c`。
- GPIO-only 器件要生成合理封装，例如 on/off/toggle/value。
- 除 `main.py` 外不 import `machine`。
- 工厂负责硬件实例创建，task 只接收对象。

### 6.6 Step 4: 生成 task

生成路径：

```text
firmware/tasks/*_task.py
```

必须从以下事实生成：

- `manifest.requirements.description`
- `manifest.devices`
- `manifest.pinout`
- `manifest.scaffold_mode`
- scaffold 已选模块，例如 logger / scheduler / time_helper

主要约束：

- task 不 import `machine`。
- task 用 DI。
- 每个传感器或输出动作独立 try/except。
- 关键日志 `print()` 和 logger 双写。
- 阈值和间隔来自 `conf.py`。
- timer 模式和 async 模式生成不同函数形态。

### 6.7 Step 5: 补充 `conf.py`

必须先 `file_operation(read)` 读取 scaffold 生成的 `firmware/conf.py`。

然后发 `file_operation(write)` 覆盖同一文件。

不得写入：

- Wi-Fi 密码
- API Key
- 用户隐私 token

应保留 scaffold 已有配置，再补充业务常量。

### 6.8 Step 6: 补充 `main.py`

必须先 `file_operation(read)` 读取 scaffold 生成的 `firmware/main.py`。

然后生成：

- 启动延时
- logger 初始化
- Pin / I2C / SPI / I2S 初始化
- driver factory 调用
- task 注册
- scheduler / event loop 启动
- I2C scan 双写日志

注意：

- `main.py` 是唯一允许直接 import `machine` 的业务入口。
- 不应破坏 scaffold 选择的调度模式。
- 不应把 pinout 中不存在的 GPIO 写死进代码。

### 6.9 Step 7: 生成测试

生成：

```text
test/pc/test_*.py
test/device/test_smoke.py
```

PC 测试：

- 使用 CPython unittest。
- 使用 Mock。
- 覆盖正常、None、异常三类场景。

设备端冒烟测试：

- 只使用 MicroPython unittest 支持的 assert 子集。
- I2C 器件使用 `scan_<name>_i2c`。
- GPIO / I2S 等器件使用轻量可运行检查，不做破坏性动作。

### 6.10 Step 8: 多层校验

旧 skill 中的本地命令应改成协议工具：

```text
script_run(flake8)
script_run(pylint)
script_run(check_mpy_imports.py)
script_run(check_dead_config.py)
script_run(check_skeleton_compliance.py)
```

新增脚本建议：

1. `check_mpy_imports.py`
   - 扫描 `firmware/`，排除 `firmware/lib/`。
   - 提取 import。
   - 对照 MicroPython 白名单。
   - 输出统一 JSON。

2. `check_dead_config.py`
   - 提取 `conf.py` 常量。
   - 扫描 `firmware/` 和 `test/` 使用情况。
   - 输出 warnings / errors。

3. `check_skeleton_compliance.py`
   - 检查调度模式一致。
   - 检查 board.py 引脚引用。
   - 检查 conf.py 常量引用。
   - 检查 DI 链路。
   - 检查 task 不 import machine。

所有脚本统一输出：

```json
{
  "status": "pass",
  "errors": [],
  "warnings": [],
  "summary": "0 errors, 0 warnings"
}
```

### 6.11 Step 9: phase_complete

成功输出应包含：

- `payload.phase = "upy-generate-plugin"` 或协议统一的 `"generate"`
- `payload.result = "success"`
- `payload.next_phase` 默认是 `"upy-deploy-plugin"`；当用户选择先模拟业务逻辑时是 `"upy-simulate-plugin"`；迁移期未实现插件时才可临时使用旧 `upy-deploy` / `upy-simulate`
- `payload.next_phase_reason`
- `payload.optional_next_phases`，例如用户确认后追加 `upy-diagram-plugin`
- `payload.followup_offers`，记录是否已询问图表生成
- `payload.manifest_content`
- `payload.artifacts`
- `payload.file_manifest`
- `payload.lint`
- `payload.generate`
- `payload.runtime_context`

`manifest_content` 必须：

- 保留 analyze/select-hw/flash/scaffold 的核心字段。
- 更新 `phase` 为 generate。
- 增加 `generate` 段，记录生成文件、驱动状态、校验状态。
- 不丢失 `pinout`、`pin_decisions`、`firmware_flash`、`scaffold` 信息。

generate full 模式的成功只表示“项目代码生成与静态/本地校验通过”，不表示真实设备已经运行成功。因此它不应直接进入 `upy-autofix-plugin`。用户可以选择先进入 `upy-simulate-plugin` 看业务逻辑模拟；也可以选择附加调用 `upy-diagram-plugin` 生成架构图、流程图和数据流图。真实设备失败仍要由 `upy-deploy-plugin` 产生结构化错误后，再交给 `upy-autofix-plugin` 编排。

---

## 7. fix 模式工作流建议

fix 模式由 `upy-autofix` 或未来 `upy-autofix-plugin` 委托触发。它不是 full 模式的自然下一阶段，而是 deploy/测试失败后由 autofix 反向调用的修复入口。

### 7.1 输入

```json
{
  "type": "start_phase",
  "phase": "upy-generate-plugin",
  "payload": {
    "mode": "fix",
    "manifest": {},
    "error_context": {
      "traceback": "...",
      "file_path": "firmware/tasks/sensor_task.py",
      "line_number": 42,
      "driver_name": "AHT20",
      "error_type": "P0_driver_api",
      "attempt_number": 2,
      "previous_attempts": []
    }
  }
}
```

### 7.2 强制规则

- 第一动作必须是 `file_operation(read)`。
- 至少读取 `error_context.file_path`。
- 可按需要读取相关 driver / mock / main / conf 文件，但要控制数量。
- 不发 `approval_request`。
- 只做最小修复。
- 只写被修改文件。
- 必须返回 `code_diff` artifact。
- 必须考虑 `previous_attempts`，不要重复无效策略。

### 7.3 输出

fix 成功的 `phase_complete` 应包含：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "upy-generate-plugin",
    "result": "success",
    "summary": "已修复 firmware/tasks/sensor_task.py 第 42 行",
    "next_phase": null,
    "artifacts": [
      {
        "type": "code_diff",
        "file_path": "firmware/tasks/sensor_task.py",
        "changes": []
      }
    ],
    "warnings": [],
    "errors": []
  }
}
```

fix 模式不应返回完整 `manifest_content`，除非修复确实改变了 manifest 结构。常规代码修复只返回 diff 和摘要即可。

---

## 8. 与旧 `upy-generate` 的差距清单

| 旧 `upy-generate` 现状 | 插件化目标 | 后续改造动作 |
|---|---|---|
| 直接读取 `project-manifest.json` | 从 `phase_complete.payload.manifest_content` 或 start payload 读取 | 新 SKILL 明确输入来源 |
| `download_drivers.py --project-dir` | `--manifest -` / stdout JSON | 重写或改造脚本 |
| 脚本直接写 `firmware/lib` | 发 `file_operation(write)` | 脚本不得写项目目录 |
| 脚本直接改 manifest | `phase_complete.manifest_content` 统一交付 | 删除脚本内 manifest 写回 |
| 内联 Python 修换行 | 脚本内部归一化并输出修复后 content | 合入 download 脚本 |
| LLM 读本地驱动文件 | LLM 从下载 JSON 读源码 | 减少 read 往返 |
| 直接修改 conf/main | 先 `file_operation(read)`，后 `file_operation(write)` | 改 SKILL 流程 |
| Bash 跑 flake8/pylint | `script_run` | 输出统一脚本结果 |
| 手工扫描 import | `check_mpy_imports.py` | 新增确定性脚本 |
| 内联死配置扫描 | `check_dead_config.py` | 新增确定性脚本 |
| 无骨架合规脚本 | `check_skeleton_compliance.py` | 新增确定性脚本 |
| 无 fix 模式 | `mode=fix` + code_diff | 新增 fix 工作流 |
| 结束时本地改 manifest | `phase_complete` 输出完整 payload | 与前置插件一致 |

---

## 9. 后续实施顺序建议

### 第 1 步：只复制骨架，不动旧目录

新增：

```text
G:\MicroPython_Skills\upy-generate-plugin
```

从旧 `upy-generate` 提取业务规则，但不要直接复制旧 `SKILL.md` 后只改名字。建议重写为插件协议结构：

1. 启动消息
2. 输入事实来源
3. runtime_context 和路径口径
4. full 流程
5. fix 流程
6. status_update 枚举
7. file_operation 规范
8. script_run 规范
9. phase_complete 规范
10. 本地测试方式

### 第 2 步：先做脚本输出契约

优先实现：

- `download_drivers.py`
- `check_mpy_imports.py`
- `check_dead_config.py`
- `check_skeleton_compliance.py`

先不追求复杂 LLM 代码生成，先保证这些脚本：

- 输入明确。
- stdout JSON 稳定。
- 不直接写项目目录。
- Windows 路径可用。
- smoke test 能覆盖失败和成功。

### 第 3 步：做 sample 消息

至少提供：

- full start_phase
- fix start_phase
- full phase_complete success
- fix phase_complete success
- status_update 序列
- code_diff artifact

插件工程师可以不跑真实 LLM，仅靠 sample 开发 UI 和协议执行器。

### 第 4 步：做本地 mock runner

参考前置插件版 skill 的习惯，提供：

```text
test/mock_plugin.py
test/run_local_mock_session.py
test/smoke_tests.py
```

本地 runner 目标：

- 读取 scaffold 的 phase_complete 样例。
- 模拟 `file_operation(read/write)`。
- 模拟 `script_run`。
- 生成 `phase_complete.upy_generate_plugin.json`。
- 验证所有 artifact path 和 file_operation path 都相对项目根。

### 第 5 步：接入真实 scaffold 输出

使用 `upy-scaffold-plugin` 的实际输出作为输入，验证：

- `project_root` 解析正确。
- `conf.py` / `main.py` 读取正确。
- 文件写入都落在项目根。
- `.flake8` 在项目根运行。
- 生成的 phase_complete 保留 scaffold 信息。

### 第 6 步：再接入真实 LLM 生成

最后才把复杂的代码生成逻辑接入 LLM。这样可以避免把协议、路径、脚本、代码生成四类问题混在一起。

---

## 10. 验收标准

后续 `upy-generate-plugin` 实施完成后，应至少满足以下标准。

### 10.1 文件和目录标准

- `G:\MicroPython_Skills\upy-generate-plugin` 存在。
- `G:\MicroPython_Skills\upy-generate` 未被覆盖。
- 新目录有 `SKILL.md`、`scripts/`、`sample/`、`test/`。
- 旧 `upy-generate/SKILL.md` 可作为参考但不被插件链路直接调用。

### 10.2 协议标准

- 支持 `start_phase(mode=full)`。
- 支持 `start_phase(mode=fix)`。
- full 成功输出 `phase_complete`。
- fix 成功输出 `phase_complete` + `code_diff`。
- 所有正式消息使用完整 envelope。
- `phase_complete.payload.artifacts` 是数组。
- `file_operation.path` 相对 project root。
- 不把本机 skill 安装路径写入业务 manifest。

### 10.3 full 模式标准

- 消费 scaffold 的 `manifest_content`。
- 读取 scaffold 生成的 `conf.py` 和 `main.py`。
- 生成驱动、工厂、Mock、task、测试。
- 执行 5 项校验。
- 校验失败时能基于结构化 errors 修复并重跑。
- `manifest_content.phase` 更新为 generate。
- `next_phase` 与实际编排命名一致。

### 10.4 fix 模式标准

- 第一步必须 read 当前报错文件。
- 不凭记忆修复。
- 不发 approval_request。
- 只写必要文件。
- 返回 code_diff。
- 重复 fix 时必须读取最新文件并参考 previous_attempts。

### 10.5 脚本标准

- `download_drivers.py` 不直接写项目目录。
- `download_drivers.py` 不直接修改 manifest。
- 所有脚本 stdout JSON 可解析。
- 所有脚本失败时输出结构化 errors。
- smoke tests 覆盖基本成功和失败路径。

---

## 11. 主要风险和注意事项

### 11.1 不要把 `plugin-interface` 当成现状

`plugin-interface/skills/upy-generate.md` 是目标蓝图，不是当前已经落地的 `upy-generate-plugin`。实施时要从当前文件状态出发做差距改造。

### 11.2 不要覆盖旧 `upy-generate`

这是最重要的操作边界。后续任何实现都应新建：

```text
G:\MicroPython_Skills\upy-generate-plugin
```

旧目录保留为：

```text
G:\MicroPython_Skills\upy-generate
```

### 11.3 不要让脚本直接写业务项目

插件化后，写文件必须通过 `file_operation(write)`，这样插件端才能：

- 控制项目根。
- 做 idempotency。
- 展示 files_written。
- 记录 file_manifest。
- 支持重试和恢复。

### 11.4 不要让 generate 重做上游决策

generate 不能重新做：

- 需求分析
- MCU 选择
- 引脚分配
- 固件烧录
- 骨架结构选择

这些分别属于 analyze、select-hw、flash-mpy-firmware、scaffold。

### 11.5 `next_phase` 命名需要统一

目标接口里写的是下游 `upy-simulate` / `upy-deploy`。现有插件化命名有 `upy-*-plugin` 风格。后续实施前需要统一，并且要区分主路径和失败路径：

- `upy-generate-plugin` full 成功后的主路径应是 `upy-deploy-plugin`。
- `upy-generate-plugin` full 成功后也允许按用户选择进入 `upy-simulate-plugin`，用于先看业务逻辑模拟。
- `upy-generate-plugin` full/fix 成功后应询问是否附加调用 `upy-diagram-plugin` 生成架构图、流程图、数据流图；它应写入 `optional_next_phases`，不要覆盖主 `next_phase`。
- `upy-autofix-plugin` 不应作为 generate 成功后的直接 `next_phase`。
- `upy-autofix-plugin` 应由 `upy-deploy-plugin`、设备 smoke、串口日志分析或后续测试失败触发。
- 如果 `upy-deploy-plugin` / `upy-simulate-plugin` 暂未实现，迁移期 `next_phase` 可以临时写旧 `upy-deploy` / `upy-simulate`，但要在样例和 SKILL 中标明这是兼容路径。
- 如果 `upy-diagram-plugin` 暂未实现，迁移期可临时调用旧 `upy-diagram`，但必须标注为附加产物路径。
- 不要在不同样例里混用 `generate`、`upy-generate-plugin`、`deploy`、`upy-deploy`、`simulate`、`upy-simulate`、`diagram`、`upy-diagram` 而不解释。

### 11.6 LLM 代码生成复杂度很高，应分阶段收敛

`upy-generate` 是整条链路里最重的 skill。建议 V0 先支持少数高频场景：

- I2C 温湿度传感器
- GPIO LED / buzzer / button
- 简单 display
- Timer 或 async 二选一

等协议和校验稳定后，再扩展 I2S、WiFi 云 API、复杂音频、冷门驱动。

### 11.7 驱动下载的运行位置要明确

目标接口倾向“服务器内部运行 download_drivers.py”，因为联网和包解析更适合后端。但本地 mock 也可能需要运行脚本。后续文档必须明确：

- 正式模式由后端或 package service 解析驱动。
- 本地模式可以用 `script_run` 模拟。
- 两者输出 JSON schema 必须一致。

### 11.8 敏感信息不能进入生成文件

generate 可能遇到 WiFi、云端 API、ASR/LLM/TTS 配置。V0 应只生成占位配置，不写真实密钥。用户密钥应由插件端安全存储或运行时输入。

---

## 12. 继续深化设计：本轮新增必须考虑的 10 个问题

本节补充 `upy-generate-plugin` 在真正落地前必须补进 SKILL.md、sample、runner 和验收脚本的要求。

### 12.1 generate 运行前允许用户详细描述功能和装置行为

`upy-generate-plugin` 不应该默认“拿到 scaffold manifest 就立刻生成代码”。在代码生成前，应允许用户补充或确认更细的装置行为，尤其是 analyze 阶段没有问清楚的业务细节。

建议新增一个可选审批点：

```text
approval_request(generate_behavior_review)
```

触发条件：

- `requirements.description` 过于宽泛，例如只写“做语音助手”“做植物助手”。
- 存在复杂交互行为，例如 PIR 触发、触摸触发、语音状态机、报警恢复、云端 API、屏幕显示页面切换。
- `devices[]` 已齐全，但缺少装置行为细节，例如采样周期、触发阈值、输出动作持续时间、异常时如何降级。
- 用户在 start_phase 里主动提供 `behavior_notes`、`feature_details`、`interaction_flow`。

审批卡片应让用户补充：

- 触发条件：谁触发、上升沿/下降沿/电平保持、是否防抖。
- 状态机：idle / sensing / speaking / alarm / error 等状态。
- 时间参数：采样周期、超时、冷却时间、报警持续时间。
- 输出行为：串口、蜂鸣器、LED、屏幕、语音、HTTP 请求。
- 异常行为：传感器缺失、网络失败、云 API 失败、设备重启后恢复。

但这不等于回到 analyze 重做需求。generate 阶段只允许补充“业务行为细节”，不能新增大类器件、改 MCU、改引脚。若用户补充内容导致需要新增器件或改 pinout，应输出 partial，并要求回到 analyze/select-hw/scaffold。

建议 start_phase 支持：

```json
{
  "payload": {
    "mode": "full",
    "behavior_notes": "PIR检测到人后进入对话模式，触摸键短按播报温湿度，长按重置网络。",
    "allow_behavior_review": true
  }
}
```

generate 成功后的 `manifest_content.generate.behavior_spec` 应记录最终采用的行为规格，后续 autofix 也应读取它，避免修复时改变原始设计意图。

### 12.2 除电子模块驱动外，还需要中间件库和 `upy-pkg-guide`

当前旧 `upy-generate` 主要关注 `devices[].driver`。但真实装置除了电子模块驱动，还会需要中间件库，例如：

- `uasyncio` 相关调度封装。
- HTTP / MQTT / WebSocket / JSON 处理。
- NTP / 时间同步。
- ring buffer / queue / event bus。
- 音频采样、简单 VAD、WAV/PCM helper。
- OLED / LCD 字体、framebuf helper。
- 配置保存、重试退避、WiFi manager。

这些不一定对应某个 `devices[]`，而是由 `requirements.network`、`requirements.special_requirements`、`scaffold_mode` 和行为规格推导出来。后续 `upy-generate-plugin` 应把依赖分成两类：

| 类型 | 来源 | 处理方式 |
|---|---|---|
| 器件驱动依赖 | `devices[].driver` | 读取 analyze/select-hw 的驱动结果，必要时调用 `upy-pkg-guide` 补全 |
| 中间件/业务库依赖 | 行为规格、网络/音频/显示/调度需求 | 初步版本先用 upypi 全局索引枚举候选库，再调用 `upy-pkg-guide` 获取用法 |

`upy-pkg-guide` 的职责是从 upypi 到 awesome-micropython 查找 MicroPython 驱动/库，输出安装、初始化、核心 API、注意事项。它不应只用于 analyze 阶段。generate 阶段遇到以下情况也应调用或等价复用它：

- `devices[].driver.source` 为空、过期或只有包名没有 API 用法。
- 需要从 README/main.py 提取真实初始化代码。
- 需要中间件库，但 manifest 没有明确包名。
- 旧驱动下载脚本没有找到驱动，想走 awesome-micropython fallback。
- autofix 报 `ImportError` / `AttributeError`，怀疑包名或 API 调用错误。

初步版本建议不要先抽象新的 resolver 服务。更可靠的 V0 做法是：

1. 先读取 upypi 全局索引：

   ```text
   GET https://upypi.net/packages.json
   ```

   当前接口返回形如：

   ```json
   {
     "packages": [
       {"name": "MQTT", "version": "1.0.0"},
       {"name": "aiohttps", "version": "1.1.3"},
       {"name": "async_websocket_client", "version": "1.0.1"},
       {"name": "microflask", "version": "0.0.20260505"}
     ]
   }
   ```

2. 用全量包名建立临时索引 `upypi_package_index`，记录：

   - `name`
   - `version`
   - `normalized_name`
   - `tokens`
   - `category_guess`
   - `is_driver_like`
   - `is_middleware_like`

3. 先从这个全量索引里反推中间件候选，而不是直接凭经验写死搜索词。

4. 对每个候选包，再调用 `upy-pkg-guide` 或等价 adapter 获取 README、main.py、package.json、核心 API、安装方式。

5. 如果 `packages.json` 不可用，再退回 `/api/search?q=<seed>` 的种子词搜索。

实际检索 query 必须使用英文。用户需求可以是中文，但进入 upypi、awesome-micropython、GitHub fallback 前必须先做英文归一化和同义词扩展。原因是 awesome-micropython、GitHub 仓库名、README、package.json 描述大多是英文，中文关键词很难召回候选库。

建议新增 `dependency_query_terms`：

```json
{
  "source_text": "语音对话，MQTT上报，OLED菜单，联网校时",
  "normalized_terms": [
    {"zh": "语音识别", "en": ["speech recognition", "ASR", "voice recognition"]},
    {"zh": "语音合成", "en": ["text to speech", "TTS", "speech synthesis"]},
    {"zh": "MQTT上报", "en": ["MQTT", "mqtt client", "publish subscribe"]},
    {"zh": "OLED菜单", "en": ["OLED menu", "display menu", "ssd1306 menu"]},
    {"zh": "联网校时", "en": ["NTP", "ntptime", "time sync"]}
  ]
}
```

使用规则：

- `packages.json` 索引匹配时用英文 token，例如 `mqtt`、`websocket`、`flask`、`tts`、`asr`、`oled`。
- `/api/search?q=<seed>` 的 `<seed>` 必须是英文或芯片/协议型号，例如 `mqtt`、`ssd1306`、`ntp`、`websocket`。
- awesome-micropython fallback 必须使用英文关键词。
- GitHub fallback 必须使用英文关键词组合，例如 `"MicroPython MQTT"`、`"MicroPython OLED menu"`。
- 中文词只保留在 `reason`、`source_text`、用户展示摘要里，不作为实际搜索 query。

当前从全量索引可以直接观察到的中间件/业务库候选包括：

| 需求线索 | 先从索引筛出的候选包名示例 | 后续 `upy-pkg-guide` 核验点 |
|---|---|---|
| MQTT | `MQTT` | 是否提供 MicroPython 可运行 MQTT client、初始化参数、连接/发布/订阅 API |
| HTTP / HTTPS | `aiohttps` | 是否适合设备端 HTTP client/server，是否依赖 async |
| WebSocket | `async_websocket_client` | 是否与 `scaffold_mode=async` 匹配 |
| Web server / 本地配置页 | `microflask`、`microflask_async`、`microflask_legacy` | 同步/异步版本差异，内存占用和路由 API |
| 模板渲染 | `utemplate` | 是否适合 Web 配置页或 HTML 输出 |
| OpenAI / 云 API | `uopenai` | 是否需要网络、TLS、token 管理，是否适合放入生成代码 |
| 语音 ASR/TTS | `xfyun_asr`、`xfyun_tts`、`volcengine_tts_v1_ws` | WebSocket/HTTP 依赖、密钥处理、音频格式 |
| async 音频 | `async_mic_recorder` | 与 I2S 麦克风和 async 模式是否匹配 |
| 调度/看门狗 | `TimerScheduler`、`TimerWDG` | 是否应复用 scaffold 已有 scheduler，避免重复引入 |
| 菜单/显示 UI | `SimpleOLEDMenu` | 是否与当前屏幕驱动、framebuf/OLED 包兼容 |

每个候选都要记录：

- 来源：`packages.json` 全量索引 / `/api/search` / awesome fallback。
- 触发它的行为需求线索。
- 归类：middleware / device_driver / utility / uncertain。
- `upy-pkg-guide` 返回来源：upypi / awesome-micropython / none。
- 是否采用。
- 不采用原因。
- 若采用，下载哪些文件到 `firmware/lib`，以及代码中如何初始化。

索引分类规则建议：

```text
name endswith "_driver"              -> device_driver_like
name contains sensor/chip model      -> device_driver_like
name contains async/http/mqtt/flask  -> middleware_like
name contains tts/asr/openai/ws      -> middleware_like
name contains scheduler/wdg/menu     -> middleware_or_utility
unknown                              -> uncertain，需要 upy-pkg-guide 核验
```

注意：包名像 `MQTT`、`microflask`、`aiohttps` 这类并不含 `_driver`，如果只按器件驱动搜索会漏掉。先穷举 `packages.json` 的价值就在于能发现这些非驱动中间件。

后续版本可以再把这一步封装成内部能力：

```text
dependency_resolve(device_or_library)
```

但 V0 的验收标准应是：中间件依赖必须先经过 upypi 全量索引筛选，再经过 `upy-pkg-guide` 或等价 adapter 核验，而不是由 LLM 凭记忆编造包名和 API。输出必须结构化进入：

```json
{
  "generate": {
    "upypi_package_index": {
      "source": "https://upypi.net/packages.json",
      "package_count": 211,
      "generated_at": "..."
    },
    "dependency_plan": [
      {
        "name": "MQTT",
        "kind": "middleware",
        "source": "upypi",
        "discovered_by": "packages_json_index",
        "matched_need": "mqtt_publish",
        "install": "mpremote mip install ...",
        "files": [],
        "api_summary": {}
      }
    ]
  }
}
```

### 12.3 必须复用 scaffold 已注入的时间测量、日志和工具库

`upy-scaffold-plugin` 可能已经按用户选择生成了基础库。参考样例：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\firmware\lib
├── time_helper.py
└── logger/
    ├── __init__.py
    ├── logging.py
    └── rotating_logger.py
```

样例 `project-manifest.json` 里有：

```json
{
  "scaffold_mode": "async",
  "scaffold_modules": ["flash_device", "logger", "maintenance", "time_helper"],
  "scaffold": {
    "mode": "async",
    "modules": ["flash_device", "logger", "maintenance", "time_helper"]
  }
}
```

这意味着 generate 不能无视 scaffold 资产。它必须先读取：

- `manifest.scaffold_mode`
- `manifest.scaffold_modules`
- `manifest.scaffold.modules`
- `firmware/lib/time_helper.py` 是否存在
- `firmware/lib/logger/__init__.py` 是否存在
- `.flake8` 是否存在

然后按存在性应用：

| scaffold 资产 | generate 应用方式 |
|---|---|
| `time_helper.py` 存在且模式为 timer/thread | task tick 函数使用 `@timed_function` |
| `time_helper.py` 存在且模式为 async | async task 使用 `@timed_coro` |
| `logger` 存在 | main.py 安装 rotating logger，task 里使用 logger + print 双写 |
| `maintenance` 存在 | main.py 注册维护任务或调用 scaffold 约定入口；不存在则不得 import |
| `flash_device` / tools 存在 | generate 不重复生成烧录工具，只记录 deploy 可用 |

注意：这些库可能是 MicroPython-only 写法，例如 `const`、`time.ticks_ms()`。如果 PC 端测试要 import，generate 需要检查是否已有 CPython fallback；没有则应补兼容层或避免 PC 测试直接导入该文件。

### 12.4 驱动写入位置必须是 `project_root/firmware/lib`

后续所有驱动文件必须写入当前 session 的项目根，例如：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\firmware\lib
```

协议里不能硬编码这个绝对路径，而应使用：

```text
runtime_context.project_root = sessions/<session_id>/project
file_operation.path = firmware/lib/<driver>.py
```

本地宿主负责把相对路径解析为：

```text
<artifact_root>/<project_root>/firmware/lib/<driver>.py
```

因此 `download_drivers.py` 的输出 files 必须写成：

```json
{
  "path": "firmware/lib/ahtx0.py",
  "content": "...",
  "encoding": "utf-8"
}
```

不能写成：

```text
G:\MicroPython_Skills\...
G:\test\test\...
sessions/<id>/project/firmware/lib/ahtx0.py
```

也不能把驱动下载到 skill 目录或 session 根目录。`firmware/lib` 是项目代码的一部分，`session_root` 只存 phase 状态、日志、checkpoint、phase_complete。

### 12.5 必须尊重 scaffold 中用户选定的 timer / async / thread 模式

`upy-scaffold-plugin` 已经让用户选择了调度模式。generate 阶段只能消费这个选择，不应重新选择。

生成策略：

| `scaffold_mode` | task 形态 | main.py 形态 | 时间工具 |
|---|---|---|---|
| `timer` | 同步 `def xxx_tick(...)` | Scheduler tick / 主循环轮询 | `@timed_function` |
| `async` | `async def xxx_task(...)` 或 async tick | `uasyncio.create_task()` + event loop | `@timed_coro` |
| `thread` | 同步 worker 函数 | `_thread.start_new_thread()` + lock/queue | `@timed_function` |

如果 manifest 和 scaffold 文件冲突，例如 `scaffold_mode=async` 但 main.py 是 timer 模板，generate 不应猜测修正，而应输出 structured error：

```json
{
  "code": "scaffold_mode_mismatch",
  "severity": "error",
  "message": "manifest scaffold_mode=async but main.py template appears timer-based",
  "retryable": false,
  "next_action": "rerun_upy_scaffold_plugin"
}
```

### 12.6 MicroPython 与 CPython 语法/模块差异、flake8 配置和官方文档依据

MicroPython 不是完整 CPython。官方文档明确说明 MicroPython 实现的是 Python 3.4 及部分后续特性，标准库是精简且各端口模块集合会变化；`.mpy` 文件还受 MicroPython 版本和架构影响。包安装方面，官方文档推荐用 `mip` 或 `mpremote mip` 安装 MicroPython 包及依赖。

对 `upy-generate-plugin` 的影响：

1. `flake8` 只能检查 CPython 语法风格，不能证明设备可运行。
2. `flake8` 运行环境是 PC，默认不知道 MicroPython 内置名如 `const`。
3. CPython 可 import 的模块，例如 `typing`、`pathlib`、`logging`、`dataclasses`，在 MicroPython 上可能不存在。
4. MicroPython 可用模块因板卡端口不同而不同，不能只用一份静态白名单就宣称完全正确。
5. `.mpy` 预编译文件需要考虑固件版本和架构，generate 阶段不要随意生成或下载不匹配 `.mpy`。

scaffold 样例项目已有 `.flake8`：

```ini
[flake8]
max-line-length = 120
builtins =
    const
extend-ignore =
    W503
per-file-ignores =
    firmware/main_thread.py: F401
    firmware/lib/logger/__init__.py: F401
    firmware/lib/scheduler/__init__.py: F401
```

generate 应遵守：

- 优先使用 scaffold 生成的 `.flake8`，不要覆盖。
- 如需扩展，只能增量修改，必须保留 `builtins = const`。
- 不要全局忽略 `F821/F401`，否则会掩盖真实错误。
- 外部驱动目录 `firmware/lib` 是否排除要分两层：
  - 语法检查可以对下载驱动做 `py_compile` 或 AST parse，及时发现换行/编码错误。
  - 项目风格检查可以排除第三方驱动，避免为外部代码风格背锅。
- 必须增加 `check_mpy_imports.py`，弥补 flake8 不懂 MicroPython 模块集合的问题。
- 必须增加 `check_mpy_syntax_profile.py` 或在 `check_mpy_imports.py` 中记录 firmware board/port，用 manifest 中的 `mcu.firmware_board_name`、`mcu.chip_family` 约束模块白名单。

官方文档应写入后续 SKILL.md 的参考来源：

- `https://docs.micropython.org/en/latest/develop/index.html`
- `https://docs.micropython.org/en/latest/reference/packages.html`
- `https://docs.micropython.org/en/latest/reference/mpyfiles.html`

注意：不要让 LLM 每次生成都联网读文档。应在 SKILL.md 中固化关键规则，只有遇到不确定 API 时再查官方文档或后端缓存。

### 12.7 `upy-autofix-plugin` 会反复调用 generate，generate 必须可修复、可记录状态

`upy-autofix-plugin` 后续很可能反复调用 `upy-generate-plugin mode=fix`。因此 generate 不能只支持“一次性生成”，还要支持“多轮局部修复”。

必须设计：

```json
{
  "generate": {
    "revision": 3,
    "attempts": [
      {
        "attempt": 1,
        "mode": "full",
        "status": "success",
        "commit": "abc123",
        "changed_files": []
      },
      {
        "attempt": 2,
        "mode": "fix",
        "source": "upy-autofix-plugin",
        "error_type": "P0_driver_api",
        "status": "success",
        "commit": "def456",
        "changed_files": ["firmware/tasks/sensor_task.py"]
      }
    ]
  }
}
```

fix 模式每次必须：

- 读取当前最新文件，而不是沿用第一次生成时的记忆。
- 读取 `manifest_content.generate.attempts` 或 session 中的 `generate_fix_history.json`。
- 读取 `error_context.previous_attempts`。
- 生成新的 `attempt_id` 和 `idempotency_key`。
- 输出 `code_diff`。
- 更新 `generate_fix_history.json`。
- 静态检查通过后 git commit。

如果同一错误 3 次修复失败，generate 不应继续乱改，应返回：

```json
{
  "result": "failed",
  "structured_errors": [
    {
      "code": "generate_fix_exhausted",
      "retryable": false,
      "handoff": "user_or_upstream_review"
    }
  ]
}
```

### 12.8 `upy-generate-plugin` 应有可扩充的错误/注意事项知识库

建议新目录下增加知识库子目录：

```text
upy-generate-plugin/
├── knowledge/
│   ├── README.md
│   ├── _template.pitfall.json
│   ├── common_mpy_import_pitfalls.json
│   ├── driver_api_pitfalls.json
│   ├── scheduler_mode_pitfalls.json
│   ├── i2c_spi_gpio_pitfalls.json
│   ├── logging_and_print_rules.json
│   ├── flake8_mpy_rules.json
│   └── autofix_error_patterns.json
```

这些 JSON 不应该是随便写的笔记，而应有稳定 schema，例如：

```json
{
  "id": "mpy_no_typing",
  "category": "mpy_import",
  "applies_to": ["firmware/tasks/*.py", "firmware/drivers/**/*.py"],
  "symptom": "ImportError: no module named 'typing'",
  "bad_pattern": "from typing import ...",
  "recommended_fix": "删除 typing import，避免复杂类型注解，或放到 PC-only test 代码",
  "severity": "error",
  "source": "project_experience"
}
```

模板文件 `knowledge/_template.pitfall.json` 应作为新增注意事项的复制起点，建议内容：

```json
{
  "id": "short_stable_identifier",
  "title": "Human readable pitfall title",
  "category": "mpy_import | driver_api | scheduler_mode | i2c_spi_gpio | logging | flake8 | autofix",
  "applies_to": [
    "firmware/**/*.py"
  ],
  "trigger": {
    "error_code": "",
    "traceback_contains": [],
    "lint_code": "",
    "file_glob": ""
  },
  "symptom": "",
  "bad_pattern": "",
  "recommended_fix": "",
  "avoid": "",
  "severity": "info | warning | error",
  "confidence": "low | medium | high",
  "source": "official_docs | project_experience | hardware_test | user_report",
  "source_refs": [],
  "verified_by": "",
  "last_seen": "YYYY-MM-DD",
  "notes": ""
}
```

要求：

- 新增知识条目必须从模板复制，不允许临时自由发挥字段。
- `id` 必须稳定，后续 `error_context.knowledge_refs[]` 用它引用。
- `source_refs` 可放官方文档 URL、项目 issue、测试日志路径或硬件验证记录。
- `confidence=low` 的条目只能作为提示，不能作为自动改代码的硬规则。

generate full 和 fix 都应该读取相关知识库：

- full 生成前：作为约束避免犯错。
- lint/检查失败后：根据错误码匹配修复策略。
- autofix 委托时：把匹配到的注意事项写入 `error_context.knowledge_refs`。

知识库要可扩充，但要避免把未验证传闻写成硬规则。建议每条都带 `source`、`verified_by`、`last_seen`、`confidence`。

### 12.9 语法检查无误后必须 git commit

原始规划强调 AI x Git 版本控制。`upy-generate-plugin` 应把 git commit 作为成功完成的必要收尾之一。

规则：

- full 模式生成并通过校验后，必须 commit。
- fix 模式每次修改并通过校验后，也必须 commit。
- 如果没有 git 仓库，应先由插件端初始化或输出 permission prompt，让用户确认初始化。
- commit 前必须有 file manifest 和检查结果。
- commit message 应结构化，例如：
  - `feat(generate): add business tasks and driver adapters`
  - `fix(generate): handle AHT20 driver None result`
  - `fix(generate): adjust async task scheduling`

协议上建议用 `script_run(git_status)`、`script_run(git_commit)` 或宿主专用 `git_operation`。如果只有通用 `script_run`，也必须有权限提示和白名单：

```json
{
  "type": "permission_request",
  "payload": {
    "permission_id": "git_commit_generate_v1",
    "operation": "git_commit",
    "files": ["firmware/tasks/sensor_task.py"],
    "message": "feat(generate): add business tasks and driver adapters"
  }
}
```

commit 信息应写入：

```json
{
  "generate": {
    "git": {
      "commit": "abc123...",
      "message": "feat(generate): add business tasks and driver adapters",
      "committed_at": "..."
    }
  }
}
```

如果 git commit 失败，不能假装 phase success。应返回 partial 或 failed，附 structured error：

```json
{
  "code": "git_commit_failed",
  "retryable": true,
  "next_action": "fix_git_or_retry_commit"
}
```

### 12.10 同时兼容插件调用和本地 skill 调用测试，并支持工作流治理能力

`upy-generate-plugin` 必须同时支持：

1. 正式插件协议调用。
2. 本地 Claude Code / mock_plugin 调用测试。

两种模式的差别：

| 能力 | 正式插件模式 | 本地测试模式 |
|---|---|---|
| 文件读写 | `file_operation` | mock_plugin 映射到本地 project_root |
| 脚本执行 | `script_run` | runner 调本地 scripts |
| 用户确认 | WebView approval card | 对话或 sample approval_response |
| git commit | 宿主白名单 git 操作 | 本地临时 repo 或 dry-run |
| phase_complete 保存 | 协议事件 | 写入 session 文件用于断言 |

必须支持以下工作流字段：

- `session_id`
- `checkpoint`
- `resume`
- `cancellation`
- `retry`
- `timeout`
- `idempotency_key`
- `protocol_version`
- `capability negotiation`
- `structured error reporting`
- `artifact/file manifest`
- `permission prompts for file/device/script operations`

建议 start_phase envelope 最低包含：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "uuid",
  "phase": "upy-generate-plugin",
  "timestamp": "2026-06-23T00:00:00Z",
  "type": "start_phase",
  "idempotency_key": "upy-generate-plugin:<session_id>:start:v1",
  "retry_of": null,
  "payload": {
    "mode": "full",
    "runtime_context": {
      "artifact_root": ".",
      "artifact_root_mode": "cwd",
      "session_root": "sessions/<session_id>",
      "project_root": "sessions/<session_id>/project",
      "resource_root": "<runtime-provided>"
    },
    "capabilities": {
      "approval_request": true,
      "file_operation": true,
      "script_run": true,
      "git_operation": false,
      "device_command": false,
      "cancellation": true,
      "checkpoint_resume": true
    },
    "timeouts": {
      "dependency_resolve_ms": 30000,
      "script_run_ms": 15000,
      "git_commit_ms": 10000
    }
  }
}
```

每个大步骤完成后写 checkpoint：

```text
dependency_resolved
drivers_written
factories_generated
tasks_generated
conf_updated
main_updated
tests_generated
lint_passed
git_committed
phase_completed
```

checkpoint 文件建议：

```text
<session_root>/generate_checkpoint.json
<session_root>/generate_file_manifest.json
<session_root>/generate_fix_history.json
<session_root>/phase_complete.upy_generate_plugin.json
```

恢复规则：

- retry 必须沿用同一个 `session_id`。
- idempotency key 相同的文件写入不得重复造成不同结果。
- 如果 checkpoint 显示 `drivers_written` 已完成，恢复时先校验 file_manifest sha256，再决定跳过或重写。
- cancellation 到来时，停止后续写入，输出 partial，带 checkpoint。
- timeout 时输出 structured error，不吞掉异常。
- permission 被拒绝时输出 partial，不能继续执行受限动作。

结构化错误建议统一：

```json
{
  "code": "lint_failed",
  "severity": "error",
  "phase_step": "lint",
  "retryable": true,
  "message": "flake8 failed with 2 errors",
  "details": {},
  "next_action": "fix_and_rerun_lint"
}
```

---

## 13. 最终建议

后续不要直接“把旧 `upy-generate` 改成插件版”。正确路线是：

```text
保留旧 upy-generate
-> 新建 upy-generate-plugin
-> 按 plugin-interface 的目标协议重写 SKILL.md
-> 把旧业务规则迁移进去
-> 把直接执行点改为协议消息
-> 增加 generate 前行为补充确认
-> 接入 upy-pkg-guide / dependency resolver
-> 强制复用 scaffold 已生成的 logger/time_helper/scheduler 资产
-> 支持 timer/async/thread 三种模式分支
-> 增加 MicroPython-aware lint/import/schema 检查
-> 增加错误注意事项知识库
-> 增加 autofix 多轮调用的状态记录
-> 通过校验后 git commit
-> 增加 checkpoint/resume/idempotency/timeout/cancel/permission 机制
-> 先做脚本和 sample
-> 再做 mock runner
-> 最后接入真实 LLM 代码生成
```

这条路线能保持旧 skill 可参考、前置插件链路可继续推进，也能让插件工程师拿到稳定的消息样例和验收标准。

---

## 14. 当前上下游阶段审计：基于 `G:\MicroPython_Skills` 真实状态

本节按当前目录实际存在的 skill 分析 `upy-generate-plugin` 的上下游阶段是否完整、是否有职责错位，以及还缺哪些插件化改造。

### 14.1 当前已插件化和未插件化阶段

当前 `G:\MicroPython_Skills` 中，已经有插件化版本的阶段是：

| 阶段 | 当前插件目录 | 状态 | 与 generate 的关系 |
|---|---|---|---|
| 需求解析 | `upy-analyze-plugin` | 已插件化 | 间接上游，提供需求、器件、驱动搜索结果和冷门驱动标记 |
| 硬件选型/引脚 | `upy-select-hw-plugin` | 已插件化 | 间接上游，提供 MCU、板卡、pinout、BOM |
| MicroPython 固件准备 | `upy-flash-mpy-firmware-plugin` | 已插件化 | 间接上游，确认固件已下载/烧录/用户手动准备 |
| 项目骨架 | `upy-scaffold-plugin` | 已插件化 | 直接上游，输出项目根、骨架文件、调度模式、基础库 |

仍只有旧 skill、尚未看到插件目录的阶段是：

| 阶段 | 当前旧目录 | 建议插件目录 | 与 generate 的关系 |
|---|---|---|---|
| 业务代码生成 | `upy-generate` | `upy-generate-plugin` | 当前分析目标 |
| PC 端业务模拟 | `upy-simulate` | `upy-simulate-plugin` | generate 成功后的用户可选下游 |
| 设备部署运行 | `upy-deploy` | `upy-deploy-plugin` | generate 成功后的默认下游 |
| 错误闭环编排 | `upy-autofix` | `upy-autofix-plugin` | deploy/simulate/测试失败后的编排层，反向调用 generate fix |
| 架构图/数据流图 | `upy-diagram` | `upy-diagram-plugin` | generate 成功后的可选附加产物 |
| 接线图 | `upy-wiring` | `upy-wiring-plugin` | generate 后可选附加产物，也可在 scaffold/select-hw 后生成 |
| 冷门驱动生成 | `upy-gen-driver` | `upy-gen-driver-plugin` | analyze/generate/autofix 发现缺驱动时的旁路 |
| 包使用要点 | `upy-pkg-guide` | 可先作为内部 adapter | generate 的驱动/中间件依赖核验来源 |

结论：`upy-generate-plugin` 的上游链路已经相对完整，真正风险主要在下游和旁路阶段还未插件化。如果 generate 先完成插件化，它需要用兼容策略对接旧 `upy-simulate`、`upy-deploy`、`upy-autofix`、`upy-diagram`、`upy-wiring`、`upy-gen-driver`，否则协议链会断。

### 14.2 上游阶段设计评估

当前设计的上游链路是：

```text
upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
```

这个方向是合理的，原因：

- `analyze` 已把需求、器件、驱动搜索、冷门驱动标记结构化。
- `select-hw` 已把板卡、固件入口、pinout、BOM 结构化。
- `flash-mpy-firmware` 已把固件准备从 generate 前置出来，避免 generate 生成代码后才发现设备没有 MicroPython。
- `scaffold` 已把项目目录、调度模式、基础库和 `.flake8` 准备好，generate 可以专注业务代码。

但仍有不足：

1. `analyze-plugin` 当前 `next_phase` 写的是 `select-hw`，而 `select-hw-plugin` 的 phase 名是 `select-hw` / `upy-select-hw-plugin` 混用，需要在全链路文档中统一命名。
2. `scaffold-plugin` 成功后指向 `upy-generate-plugin`，但 `upy-generate-plugin` 目录尚不存在；因此当前链路只能停在 scaffold。
3. cold-driver 标记后，`upy-gen-driver-plugin` 尚不存在。generate 如果遇到 `driver.status=cold_driver_required`，不能直接硬生成业务代码，应输出 partial 或触发冷门驱动旁路。
4. `upy-pkg-guide` 仍是旧 skill，generate V0 可以作为内部 adapter 使用，但应避免它在插件链路中直接写盘或自由问答。
5. 用户在 generate 前补充行为细节时，必须限制在业务行为层；如果补充导致新增器件/改 pinout，应回退到 analyze/select-hw/scaffold，而不是 generate 自己扩边界。

### 14.3 下游阶段设计评估

当前设计已经把 generate 后分成：

```text
默认路径: upy-generate-plugin -> upy-deploy-plugin
可选模拟: upy-generate-plugin -> upy-simulate-plugin
可选图表: upy-generate-plugin -> upy-diagram-plugin
失败闭环: deploy/simulate/test 失败 -> upy-autofix-plugin -> generate fix
```

这个方向比单一 `next_phase=deploy` 更符合真实产品，因为用户不一定马上上板运行，可能只是先看业务逻辑模拟或文档图。

但还有一个下游不足：`upy-wiring` 当前也应该纳入可选附加产物。

原因：

- `upy-wiring` 旧 skill 的触发点是 `upy-scaffold` 或 `upy-generate` 完成后。
- generate 后代码已经有 `main.py` 的真实硬件初始化，wiring 可以交叉验证 manifest pinout 和 firmware 实际引用。
- 对硬件项目来说，接线图和架构图一样是用户高价值产物。

建议把附加产物扩展为：

```text
generate 成功后询问：
  - 是否调用 upy-diagram-plugin 生成架构图/流程图/数据流图
  - 是否调用 upy-wiring-plugin 生成接线图/引脚交叉引用表
```

这两个都应进入 `optional_next_phases`，不能覆盖主 `next_phase`。

建议样例：

```json
{
  "payload": {
    "next_phase": "upy-deploy-plugin",
    "optional_next_phases": [
      {
        "phase": "upy-diagram-plugin",
        "reason": "user_requested_architecture_and_dataflow_diagrams"
      },
      {
        "phase": "upy-wiring-plugin",
        "reason": "user_requested_wiring_diagram_after_code_generation"
      }
    ]
  }
}
```

### 14.4 `upy-simulate-plugin` 的定位不足

旧 `upy-simulate` 是代码生成 skill：读取 `firmware/` 全部代码，然后生成 `test/pc/sim_main.py` 和辅助模拟脚本。

这对 `upy-generate-plugin` 有几个要求：

- generate 必须产出足够可测试的 task、mock 和 PC 端测试入口。
- generate 的 `file_manifest` 必须列出 `firmware/tasks/*`、`firmware/drivers/*/mock.py`、`firmware/conf.py`、`firmware/main.py`，方便 simulate 读取。
- generate 的 `manifest_content.generate.behavior_spec` 应帮助 simulate 构造数据场景。
- async/thread/timer 模式必须在 manifest 中明确，否则 simulate 无法选调度模型。

当前不足：

- 文档已允许 `next_phase=upy-simulate-plugin`，但还没有定义 simulate plugin 的输入契约。
- generate 需要额外输出 `simulation_hints`，例如场景列表、传感器数据范围、触发条件、预期输出。

建议在 generate 输出中增加：

```json
{
  "generate": {
    "simulation_hints": {
      "scenarios": ["normal", "threshold_crossed", "sensor_failure", "network_failure"],
      "data_generators": [
        {"device": "AHT20", "fields": ["temperature", "humidity"]},
        {"device": "PIR", "fields": ["motion_detected"]}
      ],
      "expected_outputs": ["serial", "alarm", "cloud_http"]
    }
  }
}
```

### 14.5 `upy-deploy-plugin` 的定位不足

旧 `upy-deploy` 负责上传 firmware、软复位、持久会话采集输出、读取设备端日志和初判通过/失败。它明确不做错误修复。

`upy-generate-plugin` 对 deploy 的输出要求：

- `main.py` 必须保留 3 秒启动延时，给 mpremote 重连窗口。
- 关键输出必须 print + logger 双写。
- 设备端日志路径、轮转日志配置必须明确。
- `project_root`、`file_manifest`、部署文件列表必须清晰。
- `firmware_flash.status` 和串口/板卡上下文不能丢失。

当前不足：

- 文档写了 next_phase 默认 deploy，但还没有明确 generate 要输出 deploy 所需的 `deploy_plan`。
- 如果用户选择 simulate 而不是 deploy，后续再 deploy 时仍需要同一份 deploy plan。

建议 generate 输出增加：

```json
{
  "generate": {
    "deploy_plan": {
      "project_root": "sessions/<id>/project",
      "firmware_root": "firmware",
      "entrypoint": "firmware/main.py",
      "upload_include": ["firmware/**/*.py"],
      "upload_exclude": ["test/**", "docs/**", "build/**"],
      "requires_boot_delay_seconds": 3,
      "log_paths": ["/log/run_*.log"]
    }
  }
}
```

### 14.6 `upy-autofix-plugin` 的定位不足

旧 `upy-autofix` 是编排协调层，不是独立修复机。它读取日志、运行 triage、分级决策后委托上游 skill。

当前设计已经把 autofix 放在失败路径，这是对的。但不足是：`upy-autofix-plugin` 尚不存在，且 generate fix 的输入/输出需要更明确。

generate 应为 autofix 准备：

- `generate_fix_history.json`
- `manifest_content.generate.attempts[]`
- 每次 git commit hash
- 每次修改文件列表
- 每次 lint/test 结果
- `knowledge_refs`，指向 generate knowledge 中的易错点

autofix 调 generate fix 时必须带：

- `error_context.traceback`
- `error_context.file_path`
- `error_context.error_type`
- `error_context.previous_attempts`
- `error_context.device_observations`
- `error_context.triage_json`

当前文档已有一部分，但还需要把 `triage_json`、`device_observations` 纳入 fix 输入建议。

### 14.7 `upy-diagram-plugin` 与 `upy-wiring-plugin` 的定位不足

旧 `upy-diagram` 触发点是 generate 完成后；旧 `upy-wiring` 触发点是 scaffold 或 generate 完成后。

当前文档已经补了 `upy-diagram-plugin` 可选询问，但还缺 `upy-wiring-plugin`。

建议规则：

- diagram 关注软件架构、执行流程、数据流。
- wiring 关注硬件接线、总线、引脚、地址、电源和风险提示。
- 两者都应该读取 generate 后代码，不应只信 manifest。
- 两者都不应改业务代码。
- 两者都可以在 deploy/autofix 后重新生成新版本。

因此 generate 成功后可发一个合并确认卡：

```json
{
  "approval_id": "generate_docs_offer",
  "question": "是否生成辅助文档？",
  "items": [
    {"id": "diagram", "name": "架构图 / 数据流图", "phase": "upy-diagram-plugin"},
    {"id": "wiring", "name": "接线图 / 引脚表", "phase": "upy-wiring-plugin"}
  ],
  "item_groups": {
    "doc_outputs": {"multi_select": true}
  }
}
```

这比只问 diagram 更完整。

### 14.8 `upy-gen-driver-plugin` 的旁路不足

旧 `upy-gen-driver` 用于 upypi/GitHub 都没有驱动时，从 PDF、Arduino/C++ 或芯片型号生成 MicroPython 驱动，并要求硬件验证循环。

当前已插件化的 analyze 只负责 cold-driver 打标，不生成驱动。generate 遇到 cold-driver 时有三种选择：

1. 如果业务代码可以用占位 Mock 先生成，应输出 partial，标明真实驱动缺失。
2. 如果该驱动是主流程必需，应触发 `upy-gen-driver-plugin`。
3. 如果用户只是想先模拟，可允许进入 `upy-simulate-plugin`，但必须标明不能 deploy。

不足：

- `upy-gen-driver-plugin` 尚不存在。
- generate 文档还没有把 cold-driver 作为显式阻断条件。

建议增加规则：

```text
若 devices[].driver.status == cold_driver_required:
  - full 生成可生成 Mock 和业务框架
  - 不得输出 deploy-ready success
  - next_phase 应为 upy-gen-driver-plugin 或 upy-simulate-plugin/null
  - phase_complete.result 应为 partial，除非用户明确选择 mock-only simulation
```

### 14.9 `upy-pkg-guide` 的能力边界不足

`upy-pkg-guide` 当前是旧 skill，面向用户询问“某器件怎么用”。generate 需要的是结构化 package resolver，而不是自由文本说明。

当前文档已经建议先 `packages.json` 全量索引，再用 `upy-pkg-guide` 核验。这是合理的 V0。但不足是：

- `upy-pkg-guide` 输出目前偏人类说明，不一定稳定 JSON。
- generate 需要 package.json、README、main.py、驱动源码文件列表、依赖、兼容性等机器可读结果。
- 中间件依赖搜索需要英文 query，这一点已补，但还需要 sample JSON。

建议后续新增：

```text
upy-pkg-guide adapter output schema
```

字段至少包括：

```json
{
  "query": "mqtt",
  "selected_package": "MQTT",
  "source": "upypi",
  "package_url": "https://upypi.net/pkgs/MQTT/1.0.0",
  "version": "1.0.0",
  "files": [],
  "deps": [],
  "readme": "",
  "example": "",
  "api_summary": {},
  "warnings": []
}
```

### 14.10 总体判断

当前 `upy-generate-plugin` 的上下游设计大方向是对的：

```text
已插件化上游:
  analyze-plugin -> select-hw-plugin -> flash-mpy-firmware-plugin -> scaffold-plugin

待插件化核心:
  generate-plugin

待插件化下游:
  simulate-plugin / deploy-plugin / autofix-plugin / diagram-plugin / wiring-plugin

待插件化旁路:
  gen-driver-plugin
```

主要不足不是 generate 本身职责不清，而是它处在“已插件化上游”和“未插件化下游”之间，必须承担一段迁移期兼容工作：

- 输出既要符合未来插件协议，也要能临时对接旧 skill。
- 主 `next_phase` 只能有一个，但 diagram/wiring 这类附加产物要用 `optional_next_phases`。
- simulate 和 deploy 都是合法下游，但语义不同：simulate 看业务逻辑，deploy 看真实设备。
- autofix 不是下游成功路径，而是失败后的编排层。
- gen-driver 是缺驱动旁路，不能被 generate 吞掉。
- pkg-guide 是依赖解析能力，V0 可复用旧 skill，但需要结构化 adapter。

建议后续实施优先级：

1. 先落 `upy-generate-plugin`，但在 sample 中明确兼容旧下游。
2. 第二个改 `upy-deploy-plugin`，因为它是默认主路径和 autofix 的触发源。
3. 第三个改 `upy-autofix-plugin`，形成失败闭环。
4. 同步或随后改 `upy-simulate-plugin`，支持用户先看业务逻辑。
5. 改 `upy-diagram-plugin` 和 `upy-wiring-plugin`，形成文档/可视化产物。
6. 最后补 `upy-gen-driver-plugin`，打通冷门硬件旁路。
