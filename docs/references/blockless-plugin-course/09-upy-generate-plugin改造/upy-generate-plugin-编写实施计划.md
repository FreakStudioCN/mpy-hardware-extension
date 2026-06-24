# upy-generate-plugin 编写实施计划

生成时间：2026-06-23

本计划基于 `G:\blockless-plugin-course(1)\upy-generate-plugin-改造前分析与任务总结.md` 制定，用于后续正式编写新的 `G:\MicroPython_Skills\upy-generate-plugin`。本计划只定义实施顺序、优先级、产物和验收标准；不要求原地改造旧目录 `G:\MicroPython_Skills\upy-generate`。

---

## 1. 总目标

`upy-generate-plugin` 的目标是把旧 `upy-generate` 从“本地直跑 skill”改造成“插件协议阶段”：

```text
upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
-> upy-deploy-plugin 或 upy-simulate-plugin
```

同时支持失败闭环：

```text
deploy / simulate / test 失败
-> upy-autofix-plugin
-> upy-generate-plugin(mode=fix)
-> 再次验证
```

generate 成功后还应支持可选附加产物：

```text
optional_next_phases:
  - upy-diagram-plugin
  - upy-wiring-plugin
```

---

## 2. 非目标

第一轮实施不要做这些事：

1. 不覆盖 `G:\MicroPython_Skills\upy-generate`。
2. 不把 deploy、simulate、autofix、diagram、wiring、gen-driver 全部一次性实现完。
3. 不让脚本直接自由写项目目录或修改 manifest。
4. 不在 generate 阶段重新选择 MCU、重新分配引脚或静默修改 pinout。
5. 不把 `upy-autofix-plugin` 当作 generate 成功后的直接下一阶段。

---

## 3. 总体优先级

| 优先级 | 阶段 | 目的 | 是否阻塞可用版本 |
|---|---|---|---|
| P0 | 新目录骨架和边界 | 建立插件目录、样例和协议文档 | 是 |
| P1 | 协议契约 | 固定 start/checkpoint/error/phase_complete 格式 | 是 |
| P2 | 确定性脚本 | 先把可测试、可重复的脚本做稳 | 是 |
| P3 | 本地 mock runner | 兼容本地 skill 调用测试 | 是 |
| P4 | full 模式生成流程 | 完成业务代码生成主路径 | 是 |
| P5 | MicroPython-aware 校验 | flake8、import、死配置、骨架合规 | 是 |
| P6 | git commit 与 manifest | 通过校验后提交并记录产物 | 是 |
| P7 | fix 模式 | 支持 autofix 反复调用 generate 修复 | 高 |
| P8 | 下游选择与可选产物 | deploy/simulate/diagram/wiring 接续 | 高 |
| P9 | 冷门驱动与中间件增强 | gen-driver、pkg-guide、upypi 依赖解析完善 | 中 |

建议先完成 P0-P6，形成可运行的 generate MVP；再做 P7-P9。

---

## 4. P0：创建插件目录骨架

### 4.1 目标

新增目录：

```text
G:\MicroPython_Skills\upy-generate-plugin\
```

保留旧目录：

```text
G:\MicroPython_Skills\upy-generate\
```

### 4.2 建议结构

```text
upy-generate-plugin/
├── SKILL.md
├── knowledge/
│   ├── _template.pitfall.json
│   ├── micropython_imports.pitfall.json
│   ├── scheduler_modes.pitfall.json
│   └── driver_api_usage.pitfall.json
├── scripts/
│   ├── download_drivers.py
│   ├── resolve_upypi_packages.py
│   ├── check_mpy_imports.py
│   ├── check_dead_config.py
│   └── check_skeleton_compliance.py
├── sample/
│   ├── start_phase.upy_generate_plugin.full.json
│   ├── start_phase.upy_generate_plugin.fix.json
│   ├── phase_complete.upy_generate_plugin.success.json
│   ├── phase_complete.upy_generate_plugin.partial.json
│   ├── phase_complete.upy_generate_plugin.fix_success.json
│   ├── status_update.generate.sequence.jsonl
│   └── code_diff.fix.sample.json
└── test/
    ├── mock_plugin.py
    ├── run_local_mock_session.py
    └── smoke_tests.py
```

### 4.3 验收标准

1. 目录存在且不影响旧 `upy-generate`。
2. `SKILL.md` 明确 generate 只接收 scaffold 后的项目，不负责重新选硬件。
3. `knowledge/_template.pitfall.json` 存在，可扩充错误和注意事项库。
4. sample 中包含 full、fix、success、partial、error 的最小样例。

---

## 5. P1：插件协议契约优先落地

### 5.1 必须支持的 envelope 字段

所有输入输出消息都应支持：

```json
{
  "protocol_version": "1.0",
  "msg_id": "uuid",
  "session_id": "uuid",
  "phase": "upy-generate-plugin",
  "type": "start_phase",
  "idempotency_key": "upy-generate-plugin:<session_id>:full:v1",
  "retry_of": null,
  "timestamp": "2026-06-23T00:00:00Z",
  "payload": {}
}
```

### 5.2 start_phase 必须支持

```json
{
  "payload": {
    "mode": "full",
    "source_phase": "upy-scaffold-plugin",
    "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_scaffold_plugin.json",
    "next_phase_preference": "deploy",
    "runtime_context": {
      "session_root": "sessions/<session_id>",
      "project_root": "sessions/<session_id>/project",
      "artifact_root": "."
    },
    "capabilities": {
      "approval_request": true,
      "file_operation": true,
      "script_run": true,
      "git_operation": false,
      "checkpoint_resume": true,
      "cancellation": true
    }
  }
}
```

### 5.3 用户补充行为描述

generate 运行前必须允许用户补充详细功能和装置行为，例如：

1. 传感器采样周期。
2. 阈值、报警策略、输出动作。
3. 网络重试、离线缓存、日志策略。
4. UI、蜂鸣器、继电器、灯效等行为。
5. 模拟时希望看到的业务场景。

边界规则：

| 用户补充内容 | generate 处理方式 |
|---|---|
| 只补充业务行为、阈值、周期、状态机 | 直接进入 generate |
| 新增电子模块或替换器件 | 回退到 analyze/select-hw |
| 改引脚、总线、电源 | 回退到 select-hw/scaffold |
| 只想先看模拟 | `next_phase_preference=simulate` |
| 暂不继续部署 | `next_phase_preference=stop_after_generate` |

### 5.4 验收标准

1. `SKILL.md` 明确 full/fix 两种模式。
2. 协议样例覆盖 resume、retry、timeout、cancellation。
3. 错误输出统一为 structured error。
4. 能力协商明确哪些动作需要 permission prompt。

---

## 6. P2：先做确定性脚本

确定性脚本优先于 LLM 生成主逻辑，因为它们是后续本地测试和插件执行的稳定边界。

### 6.1 `resolve_upypi_packages.py`

用途：先用 upypi 的全量索引穷举候选包，再做英文关键词搜索。

输入：

```json
{
  "queries": ["aht20", "mqtt", "ssd1306", "async scheduler"],
  "require_english_keywords": true
}
```

规则：

1. 先请求 `https://upypi.net/packages.json`，构建 `upypi_package_index`。
2. 中文需求必须先归一化成英文关键词。
3. 空 query 不应调用搜索接口。
4. `/api/search?q=<keyword>` 只作为索引后的补充。
5. awesome-micropython、GitHub 也必须使用英文关键词。

输出：

```json
{
  "upypi_package_index": {
    "fetched": true,
    "count": 211
  },
  "queries": [
    {
      "query": "mqtt",
      "candidates": [
        {
          "name": "MQTT",
          "source": "upypi",
          "score": 0.93
        }
      ]
    }
  ],
  "warnings": []
}
```

### 6.2 `download_drivers.py`

旧脚本不能原样迁移。插件版必须改成：

```text
stdin manifest 或 --manifest <path>
-> stdout JSON
-> 不直接写 project_root
-> 不直接改 project-manifest.json
```

所有驱动和中间件文件的目标路径必须是：

```text
firmware/lib/<name>.py
firmware/lib/<package>/<file>.py
```

例如真实本地路径由插件端映射到：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\firmware\lib
```

但协议消息中只能出现相对路径：

```text
firmware/lib/ahtx0.py
```

### 6.3 `check_mpy_imports.py`

用途：检查 CPython lint 过了但 MicroPython 不能用的 import。

必须拦截：

1. `typing`、`dataclasses`、`pathlib`、`logging` 等不适合固件端的依赖。
2. CPython 专属 API。
3. 固件端错误使用 `asyncio` 而不是 `uasyncio` 的情况。
4. 驱动源码里的隐性依赖缺失。

### 6.4 `check_dead_config.py`

用途：检查 `conf.py` 中声明但业务代码未引用，或业务代码引用但配置缺失的项。

### 6.5 `check_skeleton_compliance.py`

用途：确认 generate 没破坏 scaffold 骨架。

必须检查：

1. `firmware/main.py` 仍保留启动延时。
2. `firmware/board.py` 不被 generate 静默改 pinout。
3. scheduler 模式与 scaffold 选择一致。
4. logger/time_helper/maintenance 等已有库被正确复用。

### 6.6 验收标准

1. 每个脚本 stdout 都是稳定 JSON。
2. stderr 只放人类日志。
3. 出错时返回 `errors[]`，不吞异常。
4. 本地 mock runner 可以直接断言脚本输出。

---

## 7. P3：本地 mock runner 与双模式兼容

`upy-generate-plugin` 必须兼容两种调用方式：

| 模式 | 文件读写 | 脚本运行 | 用户确认 | phase_complete |
|---|---|---|---|---|
| 正式插件模式 | `file_operation` | `script_run` | approval card | 协议事件 |
| 本地测试模式 | mock 映射到 project_root | 本地 scripts | sample response | 写 session 文件 |

### 7.1 必须支持的治理能力

1. session ID。
2. checkpoint/resume。
3. cancellation。
4. retry。
5. timeout。
6. idempotency key。
7. protocol versioning。
8. capability negotiation。
9. structured error reporting。
10. artifact/file manifest。
11. file/device/script/git permission prompts。

### 7.2 checkpoint 顺序

```text
started
behavior_confirmed
dependency_resolved
drivers_written
middleware_written
driver_api_analyzed
factories_generated
tasks_generated
conf_updated
main_updated
tests_generated
lint_passed
git_committed
optional_outputs_offered
phase_completed
```

### 7.3 验收标准

1. 中断后可以从最近 checkpoint 恢复。
2. 重试同一个 idempotency key 不产生重复或冲突文件。
3. timeout/cancel/permission denied 都能输出 partial 和原因。
4. 本地测试不依赖真实设备。

---

## 8. P4：full 模式代码生成主流程

### 8.1 输入前提

full 模式必须确认：

1. 上游来自 `upy-scaffold-plugin`。
2. `project_root` 指向当前 session 项目根。
3. `firmware/conf.py`、`firmware/main.py`、`firmware/board.py`、`.flake8` 已存在。
4. manifest 中的板卡、pinout、调度模式、基础库信息完整。

### 8.2 生成顺序

1. 读取 `manifest_content` 和 scaffold 文件。
2. 询问或接收用户补充的业务行为。
3. 解析电子模块驱动和中间件依赖。
4. 调用 upypi 索引和 `upy-pkg-guide` adapter 搜索驱动/库。
5. 下载驱动到 `firmware/lib`。
6. 读取驱动源码、README、package metadata，推断 API。
7. 生成驱动 factory 和 mock。
8. 按 scaffold 的 scheduler 模式生成 task。
9. 更新 `firmware/conf.py`。
10. 更新 `firmware/main.py` 进行 DI 装配。
11. 生成 PC 测试和 device smoke 测试。
12. 运行 MicroPython-aware 静态检查。
13. 通过后 git commit。
14. 输出 phase_complete。

### 8.3 scheduler 模式分支

generate 必须尊重 `upy-scaffold-plugin` 选择的模式：

| scaffold 模式 | generate 应生成 |
|---|---|
| timer | 周期 callback、轻量状态更新、避免阻塞 |
| async | `uasyncio` task、await sleep、网络/IO 异步处理 |
| thread | `_thread` worker、共享状态保护、主循环心跳 |

不能在用户已选择 async 时生成 timer 主流程，也不能把 thread 模式误写成普通 while loop。

### 8.4 scaffold 资产复用

如果 scaffold 已提供这些库，generate 应优先复用：

```text
firmware/lib/logger/
firmware/lib/time_helper/
firmware/lib/maintenance/
firmware/lib/scheduler/
```

要求：

1. 不重复造日志系统。
2. 时间测量装饰器或工具可用于关键采样、网络发送、任务耗时统计。
3. 日志输出应兼顾 serial print 和持久日志。
4. maintenance/watchdog/health-check 若存在，应在 main/task 中接入。

### 8.5 验收标准

1. 生成文件路径全部相对项目根。
2. 驱动和中间件都落到 `firmware/lib`。
3. 业务 task、factory、mock、测试文件完整。
4. `main.py` 能表达真实装置行为，不只是空循环。
5. manifest 中记录 `generate.behavior_spec`、`deploy_plan`、`simulation_hints`。

---

## 9. P5：MicroPython-aware lint 与校验

### 9.1 为什么不能只跑普通 flake8

MicroPython 和 CPython 语法、模块、标准库能力不同。generate 必须在编写前阅读并吸收 MicroPython 官方开发文档：

```text
https://docs.micropython.org/en/latest/develop/index.html
```

后续实现时应把这些差异落实到 `.flake8` 和自定义检查脚本中。

### 9.2 `.flake8` 策略

优先复用 `upy-scaffold-plugin` 生成的 `.flake8`。如果需要补充，应只补充项目级规则，不要覆盖 scaffold 已有配置。

建议分层：

1. `firmware/`：MicroPython 约束更严格。
2. `test/pc/`：允许 CPython 测试依赖。
3. `tools/`：允许本地工具依赖。

### 9.3 必须检查

1. `python -m py_compile` 或等价语法检查。
2. `flake8`。
3. `check_mpy_imports.py`。
4. `check_dead_config.py`。
5. `check_skeleton_compliance.py`。
6. 可选：PC 单测。

### 9.4 验收标准

1. full 模式不通过校验不得输出 success。
2. fix 模式不通过校验不得 git commit。
3. lint 结果进入 manifest 和 phase_complete。
4. MicroPython 不支持的 import 必须阻断 deploy-ready。

---

## 10. P6：git commit、artifact manifest 与 phase_complete

### 10.1 git commit 规则

每次生成语法检查无误的代码后都必须 git commit：

| 模式 | commit message 建议 |
|---|---|
| full | `feat(generate): add business firmware code` |
| fix | `fix(generate): repair firmware generation issue` |
| dependency only | `chore(generate): add firmware dependencies` |

如果当前项目不是 git 仓库，应通过 permission prompt 让用户确认初始化或返回 partial，不能假装 success。

### 10.2 file manifest

phase_complete 必须包含所有产物：

```json
{
  "file_manifest": [
    {
      "path": "firmware/tasks/sensor_task.py",
      "sha256": "...",
      "role": "business_task"
    },
    {
      "path": "firmware/lib/ahtx0.py",
      "sha256": "...",
      "role": "driver"
    }
  ]
}
```

### 10.3 phase_complete 主路径

默认：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "upy-generate-plugin",
    "result": "success",
    "next_phase": "upy-deploy-plugin",
    "optional_next_phases": []
  }
}
```

用户选择先模拟：

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

只生成不继续：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "upy-generate-plugin",
    "result": "success",
    "next_phase": null,
    "checkpoint": "generate_completed_user_stopped"
  }
}
```

### 10.4 验收标准

1. success 一定有 git commit。
2. phase_complete 带 manifest、lint、commit、file_manifest。
3. partial/failed 带 structured error 和 checkpoint。
4. 主 `next_phase` 只放 deploy/simulate/null，diagram/wiring 放 optional。

---

## 11. P7：fix 模式与 autofix 闭环

### 11.1 fix 模式输入

`upy-autofix-plugin` 调 generate fix 时应带：

```json
{
  "payload": {
    "mode": "fix",
    "error_context": {
      "traceback": "...",
      "file_path": "firmware/tasks/sensor_task.py",
      "error_type": "runtime_exception",
      "device_observations": [],
      "triage_json": {},
      "previous_attempts": []
    }
  }
}
```

### 11.2 fix 规则

1. 最小修改，不重写整个项目。
2. 每次修改写入 `generate_fix_history.json`。
3. 每次通过 lint 后 git commit。
4. 记录 `attempts[]`、`knowledge_refs[]`、`changed_files[]`。
5. 多次失败要输出 retryable structured error。

### 11.3 验收标准

1. 能根据错误上下文定位文件。
2. code_diff 可读。
3. 不破坏 scaffold 资产和 pinout。
4. 支持被 `upy-autofix-plugin` 反复调用。

---

## 12. P8：下游和可选产物接续

### 12.1 deploy 默认路径

`next_phase` 默认应为：

```text
upy-deploy-plugin
```

并输出：

```json
{
  "generate": {
    "deploy_plan": {
      "firmware_root": "firmware",
      "entrypoint": "firmware/main.py",
      "upload_include": ["firmware/**/*.py"],
      "upload_exclude": ["test/**", "docs/**", "build/**"],
      "requires_boot_delay_seconds": 3
    }
  }
}
```

迁移期如果 `upy-deploy-plugin` 尚未实现，可在文档中说明临时兼容旧 `upy-deploy`，但协议目标仍应是 plugin。

### 12.2 autofix 未实现时的人工反馈闭环

原则：`upy-autofix-plugin` 不应作为 generate 成功后的直接下一阶段。generate 成功后默认仍进入 `upy-deploy-plugin`。但如果 `upy-autofix-plugin` 暂未实现，部署完成后的问题反馈不能断链，应支持用户直接描述现象，再次调用 `upy-generate-plugin` 做人工反馈修复。

临时闭环建议：

```text
upy-generate-plugin(full)
-> upy-deploy-plugin
-> 用户输入现象/反馈问题
-> upy-generate-plugin(mode=fix, source=user_feedback_after_deploy)
-> lint/check/git commit
-> upy-deploy-plugin
```

用户反馈可以包括：

1. 串口输出异常。
2. 设备无响应、重启、卡死。
3. 传感器读数不合理。
4. 继电器、蜂鸣器、OLED、网络上报等行为不符合预期。
5. 用户观察到的真实接线、I2C 地址、灯光、声音、动作现象。

此时 `upy-generate-plugin` 的 fix 输入应允许：

```json
{
  "payload": {
    "mode": "fix",
    "source": "user_feedback_after_deploy",
    "error_context": {
      "user_feedback": "设备上电后 OLED 没显示，串口只打印 boot ok，没有温湿度数据",
      "deploy_result_path": "sessions/<session_id>/phase_complete.upy_deploy_plugin.json",
      "serial_excerpt": "...",
      "previous_generate_commit": "abc123"
    }
  }
}
```

边界规则：

| 用户反馈类型 | generate fix 处理方式 |
|---|---|
| 业务逻辑、阈值、重试、日志、驱动 API 调用问题 | generate fix 可直接修改代码 |
| 引脚接错、I2C 地址变更、总线冲突 | generate 输出 structured error，建议回到 select-hw 或人工确认后再改 |
| 新增/替换硬件模块 | 回退到 analyze/select-hw/scaffold |
| 固件烧录、串口连接、文件上传失败 | 交给 deploy 重试或设备排查 |
| 驱动根本不存在 | partial，触发 gen-driver 旁路或只允许 simulate |

迁移期可以把这个能力命名为：

```text
generate manual feedback fix
```

它不是完整 `upy-autofix-plugin`，因为它不负责自动 triage、不自动分类所有设备日志，也不编排多个上游阶段。它只是让 deploy 之后的用户反馈能回到 generate，完成代码层面的最小修复。

### 12.3 simulate 可选路径

用户可能只想先看业务逻辑模拟。因此 full 成功后应允许：

```text
next_phase = upy-simulate-plugin
```

generate 必须输出：

```json
{
  "generate": {
    "simulation_hints": {
      "scenarios": ["normal", "threshold_crossed", "sensor_failure", "network_failure"],
      "data_generators": [],
      "expected_outputs": []
    }
  }
}
```

### 12.4 diagram/wiring 可选附加产物

generate 完成后应询问用户是否需要：

1. `upy-diagram-plugin`：架构图、流程图、数据流图。
2. `upy-wiring-plugin`：接线图、引脚交叉引用表、总线和电源提示。

它们都应写入：

```json
{
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
```

不能用 diagram/wiring 覆盖主 `next_phase`。

### 12.5 验收标准

1. 用户能选择 deploy、simulate 或 stop。
2. diagram/wiring 是多选附加产物。
3. optional 产物不修改业务代码。
4. file_manifest 足够支持 diagram/wiring 读取代码和 manifest。
5. 在 `upy-autofix-plugin` 暂未实现时，deploy 后用户反馈可再次触发 `upy-generate-plugin(mode=fix)`。

---

## 13. P9：冷门驱动、中间件和 upy-pkg-guide 增强

### 13.1 中间件库搜索

除电子模块驱动外，generate 还要考虑中间件库，例如：

1. MQTT。
2. HTTP client。
3. NTP/time sync。
4. OLED/UI helper。
5. ring buffer。
6. retry/backoff。
7. async queue。
8. data encoding。

V0 建议先通过 `upy-pkg-guide` 搜索可能需要的中间件库，但必须包装成结构化 adapter。

### 13.2 英文关键词规则

搜索关键词务必使用英文。中文需求需要先归一化，例如：

| 中文意图 | 英文关键词 |
|---|---|
| 温湿度 | temperature humidity sensor |
| 人体感应 | PIR motion sensor |
| 蜂鸣器报警 | buzzer alarm |
| MQTT 上报 | mqtt publish client |
| OLED 显示 | ssd1306 oled display |
| 网络重试 | retry backoff |
| 异步任务 | uasyncio async task |

这样才能在 upypi、awesome-micropython、GitHub 上检索到结果。

### 13.3 cold driver 规则

如果 manifest 中存在：

```text
devices[].driver.status == cold_driver_required
```

规则：

1. 可生成 Mock 和业务框架。
2. 不得输出 deploy-ready success。
3. 如果真实驱动是主流程必需，应触发 `upy-gen-driver-plugin`。
4. 如果用户只想模拟，可允许进入 `upy-simulate-plugin`，但 phase_complete 必须说明真实驱动缺失。

### 13.4 验收标准

1. upypi 全量索引和英文关键词搜索可复现。
2. `upy-pkg-guide` 输出被转成机器可读 JSON。
3. 中间件与驱动都记录来源、版本、文件、API 摘要和 warnings。
4. cold driver 不被 generate 静默吞掉。

---

## 14. 推荐实施顺序

### 14.1 第一轮：MVP，可本地跑通

目标：生成插件骨架并能在 mock session 里完整跑一遍 full。

顺序：

1. P0：创建 `upy-generate-plugin` 目录、`SKILL.md`、sample、knowledge 模板。
2. P1：写 start/full/fix/phase_complete/error 协议样例。
3. P2：改造 `download_drivers.py`，新增 `resolve_upypi_packages.py` 和三类检查脚本。
4. P3：写 mock runner，映射 `file_operation` 到本地 project root。
5. P4：实现最小 full 生成流程。
6. P5：接入 lint/check 脚本。
7. P6：通过后 git commit，输出 phase_complete。

第一轮验收：

1. 能读取 scaffold 产物。
2. 能生成业务 task、factory、mock、test。
3. 驱动落入 `firmware/lib`。
4. flake8 和 MicroPython-aware 检查通过。
5. 生成后 commit。
6. 输出 `next_phase=upy-deploy-plugin` 或用户选择的 simulate/null。

### 14.2 第二轮：失败修复闭环

目标：让后续 `upy-autofix-plugin` 可以反复调用 generate。

顺序：

1. P7：实现 fix start_phase。
2. 记录 `generate_fix_history.json`。
3. 输出 code_diff。
4. fix 后重新跑 lint/check。
5. fix 后 git commit。
6. sample 中加入 runtime error、import error、driver API error 三类案例。

第二轮验收：

1. 同一个错误可以 retry。
2. 每次 fix 有 checkpoint 和 commit。
3. 多次失败有结构化错误，不无限循环。

### 14.3 第三轮：下游插件衔接

目标：把 generate 放进完整链路。

顺序：

1. P8：完善 deploy_plan。
2. P8：完善 simulation_hints。
3. P8：实现 diagram/wiring 多选 approval。
4. sample 中加入 deploy、simulate、stop 三种 next_phase。
5. 文档中标明旧 skill 兼容期和最终 plugin 目标。

第三轮验收：

1. deploy/simulate/null 可切换。
2. diagram/wiring 不覆盖主 next_phase。
3. downstream 能根据 file_manifest 找到全部输入。

### 14.4 第四轮：依赖解析和冷门驱动增强

目标：提升真实硬件覆盖率。

顺序：

1. P9：完善 `resolve_upypi_packages.py`。
2. P9：把 `upy-pkg-guide` 包装成 JSON adapter。
3. P9：扩充英文关键词词库。
4. P9：定义 `upy-gen-driver-plugin` 旁路协议样例。
5. P9：加入 cold-driver partial 案例。

第四轮验收：

1. 中间件搜索和驱动搜索都可追踪。
2. upypi packages index 有缓存和超时。
3. cold driver 不会被错误标记为 deploy-ready。

---

## 15. 每阶段交付物清单

| 阶段 | 必交付物 |
|---|---|
| P0 | 目录骨架、`SKILL.md`、knowledge 模板、sample 初版 |
| P1 | 协议 schema、full/fix/error 样例、permission 样例 |
| P2 | 5 个确定性脚本和脚本输出 JSON 样例 |
| P3 | mock runner、本地 smoke test、session/checkpoint 文件 |
| P4 | full 生成流程、task/factory/mock/test 产物 |
| P5 | `.flake8` 策略、MicroPython-aware 检查报告 |
| P6 | git commit 流程、file_manifest、phase_complete |
| P7 | fix 模式、code_diff、fix_history、attempts |
| P8 | deploy_plan、simulation_hints、diagram/wiring approval |
| P9 | upypi resolver、pkg-guide adapter、cold-driver partial |

---

## 16. 风险和控制点

| 风险 | 控制方式 |
|---|---|
| 旧脚本直接写盘，破坏插件边界 | 所有脚本只 stdout JSON |
| 中文关键词搜不到库 | 强制英文关键词归一化 |
| 普通 flake8 通过但板端失败 | 增加 MicroPython-aware import 检查 |
| 生成代码不尊重 scaffold 模式 | 骨架合规检查阻断 |
| 驱动缺失仍进入 deploy | cold-driver 输出 partial |
| fix 多轮修改失控 | checkpoint、attempts、git commit、idempotency |
| diagram/wiring 抢占主流程 | 只放 optional_next_phases |
| 下游插件尚未完成 | sample 中标明迁移期兼容旧 skill |

---

## 17. 最终建议

实施时不要先追求“完整智能生成”，应先把插件工程边界做稳：

```text
协议样例
-> 确定性脚本
-> 本地 mock runner
-> 最小 full 生成
-> MicroPython-aware 校验
-> git commit
-> fix 闭环
-> 下游可选阶段
-> 依赖和冷门驱动增强
```

这个顺序能保证 `upy-generate-plugin` 先成为可靠的流水线节点，再逐步扩大代码生成、依赖解析和自动修复能力。
