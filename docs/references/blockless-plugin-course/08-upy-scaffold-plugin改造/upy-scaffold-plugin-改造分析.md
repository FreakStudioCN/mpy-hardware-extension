# upy-scaffold-plugin 改造分析

## 任务目标

将“一句话生成硬件”链路中的项目骨架阶段从原始 `upy-scaffold` 分离为插件化 skill：`upy-scaffold-plugin`。原 `G:\MicroPython_Skills\upy-scaffold` 保持原始本地 skill，不再承载插件协议改造；原 `G:\MicroPython_Skills\upy-deploy` 也保持原状，不因为 scaffold 插件引入共享脚本而被污染。插件化版本独立放在 `G:\MicroPython_Skills\upy-scaffold-plugin`。

正式链路：

```text
upy-analyze-plugin
  -> upy-select-hw-plugin
  -> upy-flash-mpy-firmware-plugin
  -> upy-scaffold-plugin
  -> upy-generate-plugin
```

`upy-scaffold-plugin` 的核心职责是读取上游 `select-hw` 的 `manifest_content`，审批调度模式和附加模块，生成项目骨架文件清单和 `file_operation` 消息，不直接写目标项目目录。

## 当前处理原则

- 保护原目录：`upy-scaffold` 和 `upy-deploy` 必须可恢复为原始 skill。
- 插件版本独立：当前改造产物归档并继续演进在 `upy-scaffold-plugin`。
- 先设计再继续实现：先明确协议、恢复机制、权限模型、测试模式，再扩展代码。
- 本地测试可运行：插件化 skill 仍需支持无插件宿主的本地 smoke test。
- 插件宿主可编排：正式执行时由宿主负责权限、文件写入、设备访问、脚本运行、超时和取消。

## 架构 3：插件化编排层

架构 3 将 skill 从“直接操作本地文件和设备”调整为“生成结构化协议消息，由宿主执行副作用”：

```text
Codex skill logic
  1. 读取 start_phase / phase_complete / manifest_content
  2. 输出 approval_request 请求用户确认
  3. 运行本 skill 的确定性脚本生成 stdout JSON
  4. 将 files[] 转为 file_operation[]
  5. 输出 phase_complete_payload

Plugin host
  1. 渲染 approval_request
  2. 管理 permission prompts
  3. 执行 script_run
  4. 执行 file_operation
  5. 管理 session/checkpoint/resume
  6. 处理 cancel/retry/timeout/idempotency
```

这样可以让服务端不直接触碰用户磁盘、串口和设备，同时保留本地测试入口。

## 原 skill 怎么改

原 `upy-scaffold` 不再直接改。后续需要做的是：

- 保留原 `upy-scaffold` 作为本地传统 skill。
- 将插件化内容放入 `upy-scaffold-plugin`。
- `upy-scaffold-plugin/SKILL.md` 使用 `name: upy-scaffold-plugin`。
- `scripts/init_scaffold.py` 只输出 JSON，不写项目目录。
- 生成结果包含 `directories[]`、`files[]`、`file_operations[]`、`status_updates[]`、`artifacts[]`、`manifest_content`、`phase_complete_payload`。
- `.upy/scripts/run_on_device.py` 等插件所需资源应由 `upy-scaffold-plugin` 自带，不能依赖修改后的 `upy-deploy`。
- `upy-deploy` 若未来也插件化，应另建或另行规划，不应被 scaffold 插件隐式改动。

## 双模式兼容

### 插件调用模式

输入为标准消息：

```json
{
  "protocol_version": "1.0",
  "type": "start_phase",
  "phase": "upy-scaffold-plugin",
  "session_id": "uuid",
  "idempotency_key": "upy-scaffold-plugin:<session>:start:v1",
  "payload": {
    "mode": "full",
    "source_phase": "upy-flash-mpy-firmware-plugin",
    "manifest_content": {}
  },
  "capabilities": {
    "approval_request": true,
    "script_run": true,
    "file_operation": true,
    "checkpoint": true
  }
}
```

输出由宿主执行：

- `approval_request(scaffold_config)`
- `script_run(init_scaffold.py)`
- `file_operation(write)` 序列
- `script_run(flake8)` 强制 gate
- `phase_complete`

### 本地 skill 测试模式

本地测试分两层：第一层是 mock 协议测试，不写项目目录；第二层是本地实际调用测试，需要把 `file_operation` 真实应用到临时项目目录或用户指定项目目录。

```bash
python upy-scaffold-plugin/test/smoke_tests.py
python upy-scaffold-plugin/scripts/init_scaffold.py --mode timer --manifest sample.json
```

当前 `smoke_tests.py` 只覆盖协议 payload 和文件内容。后续必须新增 local actual project 测试，验证目录创建、文件写入、flake8 强制 gate、checkpoint/resume 和幂等写入。

## 流程控制机制

### session ID

每次插件链路必须有稳定 `session_id`。所有消息、checkpoint、artifact manifest、file manifest、错误上报都要绑定该 session。

### checkpoint/resume

建议 checkpoint 粒度：

| checkpoint | 完成条件 | resume 行为 |
|---|---|---|
| `input_loaded` | 上游 manifest 已解析 | 跳过输入解析 |
| `approval_confirmed` | 用户已确认 scaffold_config | 复用选择，不重复打扰用户 |
| `render_done` | `init_scaffold.py` stdout JSON 已生成 | 复用文件清单 |
| `files_written` | 所有 file_operation 成功 | 跳过已完成写入 |
| `lint_done` | flake8 或等价校验完成 | 复用校验结果 |
| `phase_completed` | phase_complete 已发出 | 幂等返回已有结果 |

checkpoint 内容至少包含：

- `session_id`
- `phase`
- `checkpoint_name`
- `protocol_version`
- `input_hash`
- `idempotency_key`
- `artifact_manifest`
- `file_manifest`
- `created_at`
- `updated_at`

### cancellation

宿主可在任意长耗时节点取消。skill 应将取消视为结构化状态：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "scaffold",
    "result": "cancelled",
    "next_phase": null,
    "errors": [
      {
        "code": "USER_CANCELLED",
        "message": "User cancelled during file write approval",
        "retryable": true
      }
    ]
  }
}
```

### retry

retry 必须基于 checkpoint 和 idempotency key：

- 同一 idempotency key 不重复写同一文件。
- 可重试的失败包括 transient script failure、permission prompt timeout、file lock。
- 不可重试的失败包括 manifest schema invalid、unsafe path、unsupported protocol version。

### timeout

每个副作用消息都应声明 timeout：

- approval timeout：由宿主决定是否取消或继续等待。
- script_run timeout：默认 15s 到 120s，按脚本类型设置。
- file_operation timeout：按文件数量和大小设置。
- device/script 权限 prompt timeout：默认不自动允许。

### idempotency key

建议格式：

```text
<phase>:<session_id>:<operation>:<input_hash>:v<protocol_major>
```

示例：

```text
upy-scaffold-plugin:session-123:file-write:9fd3a2:v1
```

宿主需要记录每个 key 的最终结果，重复收到时返回已有结果。

### protocol versioning

所有消息带 `protocol_version`。兼容策略：

- major 不同：拒绝并返回 `UNSUPPORTED_PROTOCOL_VERSION`。
- minor 更高：只使用已知字段，未知字段保留但不依赖。
- 输出中回显使用的 `protocol_version`。

### capability negotiation

启动时读取宿主能力：

```json
{
  "capabilities": {
    "approval_request": true,
    "script_run": true,
    "file_operation": true,
    "device_command": false,
    "checkpoint": true,
    "artifact_manifest": true,
    "permission_prompt": true
  }
}
```

若缺少必要能力：

- 缺 `approval_request`：不能进入 full 模式，除非 start_phase 已提供确认后的 scaffold_config。
- 缺 `script_run`：不能运行 deterministic renderer，只能返回 blocked/error。
- 缺 `file_operation`：只能输出文件清单，不能要求写入。
- 缺 `checkpoint`：允许运行，但 resume 能力降级。

## structured error reporting

统一错误结构：

```json
{
  "code": "INVALID_MANIFEST",
  "message": "manifest_content is missing devices",
  "phase": "upy-scaffold-plugin",
  "step": "input_loaded",
  "retryable": false,
  "details": {
    "field": "payload.manifest_content.devices"
  },
  "causes": []
}
```

错误分类：

- `INVALID_INPUT`
- `UNSUPPORTED_PROTOCOL_VERSION`
- `CAPABILITY_MISSING`
- `PERMISSION_DENIED`
- `SCRIPT_FAILED`
- `SCRIPT_TIMEOUT`
- `FILE_OPERATION_FAILED`
- `CHECKPOINT_CORRUPT`
- `USER_CANCELLED`

## artifact/file manifest

`phase_complete.payload.artifacts` 至少包含：

- `file_tree`
- `file_list`

建议增加 `artifact_manifest`：

```json
{
  "artifact_manifest": {
    "schema_version": "1.0",
    "files": [
      {
        "path": "firmware/main.py",
        "sha256": "...",
        "encoding": "utf-8",
        "operation": "write",
        "idempotency_key": "..."
      }
    ]
  }
}
```

用途：

- resume 时判断哪些文件已写。
- retry 时避免重复副作用。
- 用户确认时展示变更范围。
- 后续 `upy-generate-plugin` 可以知道骨架来源和版本。

## permission prompts

所有副作用都需要权限边界：

| 操作 | 权限提示 |
|---|---|
| file write | 展示文件数量、目标根目录、是否覆盖 |
| script_run | 展示脚本路径、参数、cwd、timeout |
| device_command | 展示端口、动作、timeout |
| external network | 展示 URL/域名和用途 |
| delete/overwrite | 必须单独确认 |

`upy-scaffold-plugin` 目前不应直接请求 device 权限；设备执行只作为后续 `gen-driver`/`deploy` 资源脚本存在。

## 待确认事项和已更新结论

1. `upy-scaffold-plugin` 是否需要完全保留原 `upy-scaffold` 的本地用户交互文案，还是只保留插件协议文案。
2. 已更新结论：`approval_request.scaffold_config` 的 `item_groups` 是可选增强协议，不是所有插件审批卡片的强制通用 UI 协议。
3. 已更新结论：checkpoint 由 skill 生成业务草案，宿主负责持久化、加锁、去重和 resume 调度。
4. 已更新结论：`flake8` 是 scaffold 阶段强制 gate，失败不得进入下一阶段。
5. 已更新结论：`.upy/scripts/run_on_device.py` 短期由 scaffold 插件复制，长期应抽成共享工具。
6. 已更新结论：`incremental` 模式成功后进入 `upy-generate-plugin`，并携带 `generate_scope="new_devices_only"`。
7. 已更新结论：本地测试样例需要覆盖 cancellation/retry/timeout/idempotency 的 mock protocol。

## 下一步建议

1. 确认本文待确认事项。
2. 在 `upy-scaffold-plugin` 增加 protocol reference 或 samples，覆盖 resume/cancel/retry/timeout/error。
3. 将 `SKILL.md` 精简为执行指令，把长协议细节下沉到 `references/protocol.md`。
4. 增加本地 mock host 测试，模拟 approval、file_operation、checkpoint、resume。
5. 再考虑是否为 `upy-deploy` 单独规划 `upy-deploy-plugin`，不要混入 scaffold 插件。

## 追加分析：双模式、模板、审批协议和测试覆盖

### 1. upy-analyze-plugin 的双模式要求

`upy-analyze-plugin` 现在已经有两类本地测试雏形：

- mock 协议测试：`test/run_local_mock_session.py` 双向桥接 runner 和 `mock_plugin.py`，验证 `approval_request`、`status_update`、`script_run`、`phase_complete` 的消息顺序。
- 本地交互测试：`test/interactive_local_session.py`、`test/terminal_plugin_host.py` 模拟用户输入和审批响应。

但它还没有完全覆盖“本地调用 skill 实际测试需要写项目目录”的场景。建议把 analyze 的双模式明确拆成三层：

| 模式 | 目的 | 是否写项目目录 | 证据/产物 |
|---|---|---:|---|
| protocol mock | 校验插件协议格式、消息顺序和样例 JSON | 否 | stdout JSON、sample JSON、phase_complete |
| local runner | 校验确定性脚本和 runner/mock 桥接 | 可写 session 目录，不写最终项目目录 | `sessions/<session_id>/...`、manifest 草稿、phase log |
| local skill actual | 模拟用户本地完整调用 skill，验证输出文件可被后续阶段消费 | 是 | 项目目录或 session artifact root 下的 manifest、日志、phase_complete |

结论：`upy-analyze-plugin` 不能只做 mock 输出格式测试。需要补一个“本地实际调用”入口，允许传入 `--artifact-root` 或 `--project-dir`，把 manifest、phase log、checkpoint 写到指定目录。这个入口仍然不能绕过插件协议字段：`protocol_version`、`session_id`、`idempotency_key`、`capabilities`、`artifacts` 必须存在。

建议补齐：

- `test/run_local_actual_session.py`
- `--artifact-root <dir>`
- `--write-artifacts`
- `--mock-pkg-guide` 和 `--real-pkg-guide` 两种驱动搜索模式
- `phase_complete.payload.artifacts[]` 必须声明所有写出的本地文件

### 2. upy-scaffold-plugin/templates 现状和真实应用问题

当前 `upy-scaffold-plugin/templates` 更适合“骨架生成”和 smoke test，真实应用中存在以下缺口。

| 模板/模块 | 当前能力 | 真实应用风险 | 建议 |
|---|---|---|---|
| `board.py.tmpl` | I2C pin map、固定 pin、默认配置、原始 pinout 列表 | 只显式建模 I2C；SPI/UART/I2S/ADC/PWM/OneWire/NeoPixel 等接口只留在原始 `PINOUT` 中，后续 generate 解析成本高 | 增加 `INTERFACES` 的多总线结构，至少按 `interface/type/bus` 归类 |
| `conf.py.tmpl` | 项目名、采样周期、日志参数 | 缺网络、云 API、凭据占位策略；不能写真实 secret | 增加 `secrets.example.py` 或 `conf_user.py.example`，正文只引用占位 |
| `boot.py.tmpl` | emergency exception buffer，WDT 注释 | 真实部署可能需要 boot 延时、USB/REPL 保护、WDT 初始化策略 | WDT 仍不默认启用，但要预留 `BOOT_DELAY_MS` 和 deploy 兼容注释 |
| `main_timer.py.tmpl` | I2C/GPIO 初始化，Timer scheduler 框架 | 没有业务 task 注册；没有 I2S/SPI/UART 初始化；无任务清单占位 | 保持不写业务逻辑，但生成明确 task registration TODO 区块和 bus placeholders |
| `main_async.py.tmpl` | uasyncio 主循环 | 没有网络连接生命周期、异常重启策略 | 增加 TODO 区块：network init、task gather、exception handling |
| `main_thread.py.tmpl` | `_thread` 主循环 | `_thread` 在部分板卡/固件上不可用或不稳定 | approval 中需要对 `_thread` 标注“仅确认固件支持后使用” |
| `README.md.tmpl` | BOM、pinout、快速开始 | 快速开始过于泛化；未区分本地生成目录、mpremote 上传顺序、main.py 最后上传 | README 可保留简版，部署细节交给 deploy，但应提示使用 `tools/flash_device.py` |
| `templates/pc/*` | flash/log 工具 | scaffold 复制工具太多会让职责膨胀 | 只复制被审批模块选中的工具，`.upy/scripts` 复制协议工具 |
| `maintenance.py` | GC 空闲维护 | `gc.mem_free()` 只在 MicroPython 可用，本地 py_compile 可以过但 CPython 运行会失败 | 标注 MicroPython-only；本地测试只做 syntax，不直接运行 |

核心判断：scaffold 阶段仍然不应该写业务任务或驱动实现，但模板必须把后续 `upy-generate-plugin` 需要的结构化入口留好。最需要补的是“接口归类”和“本地实际落盘测试”，不是提前写业务逻辑。

建议下一轮模板改造：

1. `init_scaffold.py` 从 `manifest.pinout` 生成 `BUS_DECLARATIONS`，覆盖 I2C/SPI/UART/I2S/ADC/PWM/GPIO。
2. `board.py` 输出按接口分组的 `INTERFACES`，而不是只把非 I2C 留在 `PINOUT`。
3. `main.py` 保留“硬件实例化区”和“业务任务注册区”两个稳定 marker，供 `upy-generate-plugin` 精准插入。
4. 增加 `secrets.example.py` 或 `.env.example`，禁止在 `conf.py` 写 Wi-Fi 密码/API key。
5. 本地 actual 测试把 `files[]` 真正写入临时项目目录，并运行语法检查和文件树校验。

### 3. upy-scaffold-plugin 的双模式要求

`upy-scaffold-plugin` 也必须同时支持：

- 插件调用：只输出协议消息，由宿主执行审批、脚本、文件写入、lint、checkpoint。
- 本地化测试：包含 mock 测试输出格式，以及本地调用 skill 实际测试。实际测试需要写项目目录。

建议定义三个本地入口：

| 入口 | 作用 | 是否写项目目录 |
|---|---|---:|
| `test/smoke_tests.py` | 校验 JSON、协议字段、模板渲染、边界分支 | 否 |
| `test/run_local_mock_session.py` | 模拟插件宿主，跑 approval/script/file_operation/phase_complete | 可写临时 session 目录 |
| `test/run_local_actual_project.py` | 把 `file_operations[]` 应用到真实临时项目目录，模拟用户本地调用 skill | 是 |

本地 actual 测试要验证：

- `directories[]` 先创建。
- `file_operations[]` 逐条写入。
- 相对路径不能越界。
- 写入后 `firmware/board.py`、`conf.py`、`boot.py`、`main.py` 存在。
- `py_compile` 只用于 CPython 可解析的文件；MicroPython-only 文件只做静态语法或跳过运行。
- `flake8` 是强制 gate，失败时不得输出 success。

### 4. `item_groups` 是否应作为所有插件审批卡片通用 UI 协议

参考现有三个插件：

- `upy-analyze-plugin` 的 `approval_request(device_confirm/requirement_supplement/alternative_device)` 使用平铺 `items[]`、`multi_select`、`actions[]`。
- `upy-select-hw-plugin` 的 `approval_request(board_select/board_unavailable/pin_plan_review)` 使用平铺 `items[]`，也有 `known_board_options`、`manual_wiring_schema` 等业务字段。
- `upy-flash-mpy-firmware-plugin` 的 `approval_request(firmware_action_select/esp32_flash_confirm/pico_uf2_drag_drop/manual_firmware_flash_confirm)` 主要使用 `actions[]`、`steps[]`、`links[]`、`summary`，并提醒本地 `AskUserQuestion` 最多 4 个 options。
- `item_groups` 目前只在 `upy-scaffold-plugin` 中出现，用于一个审批卡片里同时表达调度模式单选和模块多选。

结论：`item_groups` 不应直接定义为所有插件审批卡片的通用 UI 协议。它应该定义为 `approval_request.payload.items[]` 的可选增强字段，适用于“同一张卡片中多组 item 且各组选择规则不同”的场景。

建议通用审批协议分层：

| 层级 | 通用字段 | 说明 |
|---|---|---|
| 基础层 | `approval_id/header/question/summary/actions` | 所有 approval_request 都应支持 |
| item 选择层 | `items[]/multi_select/allow_add/allow_remove` | analyze/select-hw/scaffold 常用 |
| 分组增强层 | `item_groups` + `items[].group` | 仅在多组选项混合时使用 |
| 业务扩展层 | `steps/links/manual_wiring_schema/known_board_options` | 不强行归一，按 skill 业务保留 |

`scaffold_config` 可以作为 `item_groups` 的参考样例，但不能要求 firmware/action 类卡片也使用 `item_groups`。

### 5. checkpoint 文件由 skill 生成草案还是宿主维护

现有 `upy-select-hw-plugin` 和 `upy-flash-mpy-firmware-plugin` 已经把 checkpoint 写入 `phase_complete.payload.checkpoint`，并要求 partial/failed 可恢复时必须声明 checkpoint。这个方向说明 skill 至少要生成 checkpoint 草案。

两种方案利弊：

| 方案 | 优点 | 缺点 |
|---|---|---|
| 完全由宿主维护 checkpoint | 宿主统一存储、统一加锁、统一 resume；skill 简化 | 宿主不知道业务 resume_step、输入 hash、哪些中间产物可复用；恢复语义容易变成黑盒 |
| 完全由 skill 写 checkpoint 文件 | skill 最懂业务步骤；本地测试容易复现 | 多 skill 存储格式不统一；并发、权限、清理、加密由 skill 自己处理会失控 |
| skill 生成 checkpoint payload 草案，宿主负责持久化 | 业务语义和存储治理兼顾；插件和本地测试都可用 | 需要定义统一 schema 和 artifact manifest |

建议采用第三种：skill 生成 checkpoint payload 草案，宿主负责持久化、去重、权限和 resume 调度。

`upy-scaffold-plugin` 的 checkpoint 草案至少包含：

- `checkpoint_id`
- `resume_step`
- `reason`
- `input_manifest_hash`
- `approval_response`
- `render_output_artifact`
- `file_manifest`
- `written_files`
- `flake8_result`
- `next_phase_candidate`

本地测试中可以由 mock host 把 checkpoint 写到临时 `sessions/<session_id>/checkpoint.json`；插件正式运行时由宿主决定真实存储位置。

### 6. flake8 是 scaffold 阶段强制 gate

结论：`flake8` 应是 scaffold 阶段强制 gate，而不是 warning artifact。

原因：

- scaffold 生成的是后续 `upy-generate-plugin` 的代码基座。如果基座语法/基础风格有问题，后续阶段会把错误扩大。
- `file_operation` 写入后立即 lint，可以在进入 generate 前发现模板错误。
- 本地 actual 测试也必须覆盖这个 gate，避免只验证 stdout JSON。

建议协议：

```json
{
  "type": "script_run",
  "payload": {
    "script_id": "scaffold_lint",
    "interpreter": "python",
    "script": "flake8",
    "args": ["firmware/", "tools/", "--max-line-length=120"],
    "cwd": "{project_dir}",
    "timeout_ms": 15000,
    "on_timeout": "failed"
  }
}
```

失败处理：

- `result=failed`
- `next_phase=null`
- `structured_errors[].code="SCAFFOLD_LINT_FAILED"`
- `checkpoint.resume_step="lint"`
- 不进入 `upy-generate-plugin`

### 7. `.upy/scripts/run_on_device.py` 的作用、调用方和必要性

作用：`run_on_device.py` 是快速设备执行 helper，用 `mpremote run <file.py>` 把单个本地 Python 文件送到 MicroPython 设备 REPL 执行，捕获 stdout/stderr，并可输出 JSON summary。

谁调用：

- `upy-gen-driver-plugin`：驱动生成后的硬件验证循环。生成 `debug_*.py` 或 `test_{chip}.py` 后，用 `script_run(.upy/scripts/run_on_device.py --file ... --capture --json-summary)` 让设备实际执行。
- `upy-deploy-plugin` 或 deploy 快速检查：完整部署由 `flash_device.py` 负责，快速 REPL 验证可复用 `run_on_device.py`。
- 本地 actual 测试：有真实设备时可手动触发；无设备时只验证 missing-file、timeout、JSON summary 等格式。

为什么需要：

- 插件服务端不能直接接触用户串口；必须通过宿主 `script_run` 在用户本机执行。
- `mpremote run` 和输出捕获逻辑需要稳定封装，否则每个后续 skill 都会重复写一遍。
- gen-driver 的验证循环不是完整部署，不应调用 `flash_device.py` 全量上传。
- JSON summary 让 LLM/插件宿主能结构化判断 `ok/error/timeout/missing mpremote`。

归属建议：

- 短期：由 `upy-scaffold-plugin` 复制到生成项目的 `.upy/scripts/run_on_device.py`，因为 scaffold 是 `.upy` 工具目录的创建者。
- 中期：抽成共享 tool skill 或 `upy-tooling-plugin`，由 scaffold 只复制稳定版本。
- 不建议为了这个脚本直接污染原 `upy-deploy`。`upy-deploy-plugin` 未来可以复用同一份工具源。

### 8. incremental 成功后应进入 `upy-generate-plugin`

结论：`incremental` 模式成功后应该进入 `upy-generate-plugin`，不是停在 `null`，也不是进入旧 `upy-generate`。

原因：

- 用户新增器件后，scaffold 只生成新 driver stub；真正生成/补齐驱动胶水、任务注册、业务逻辑仍然属于 generate 阶段。
- 插件链路应保持插件版本：`upy-scaffold-plugin -> upy-generate-plugin`。
- 若不进入 generate，新增器件只会有空 stub，无法形成可运行变更。

建议规则：

| 模式 | 成功 next_phase | 说明 |
|---|---|---|
| full | `upy-generate-plugin` | 进入业务代码生成 |
| incremental | `upy-generate-plugin` | 只要求 generate 处理新增器件和受影响任务 |
| partial/failed/cancelled | `null` | 等待恢复、重试或用户处理 |

incremental 的 `phase_complete_payload` 还应带：

```json
{
  "incremental": true,
  "changed_files": ["firmware/drivers/dht22_driver/__init__.py"],
  "new_devices": [{"name": "DHT22"}],
  "generate_scope": "new_devices_only"
}
```

### 9. 本地测试样例需要覆盖 cancellation/retry/timeout/idempotency mock protocol

结论：需要覆盖，而且应作为本地 mock host 测试，不只作为静态 sample JSON。

建议新增样例：

| 样例 | 目标 |
|---|---|
| `sample/start_phase.scaffold.resume.json` | 从 checkpoint 恢复 |
| `sample/cancel.approval_response.json` | 用户取消审批 |
| `sample/retry.script_timeout.json` | script_run timeout 后 retry |
| `sample/idempotency.duplicate_file_operation.json` | 重复 file_operation 不重复写 |
| `sample/phase_complete.scaffold.partial.json` | partial + checkpoint |
| `sample/phase_complete.scaffold.failed_lint.json` | flake8 强制 gate 失败 |

建议新增测试：

```text
python upy-scaffold-plugin/test/run_local_mock_session.py --scenario cancel
python upy-scaffold-plugin/test/run_local_mock_session.py --scenario retry-timeout
python upy-scaffold-plugin/test/run_local_mock_session.py --scenario duplicate-idempotency
python upy-scaffold-plugin/test/run_local_actual_project.py --scenario full-timer
python upy-scaffold-plugin/test/run_local_actual_project.py --scenario incremental-new-device
```

mock host 应维护：

- `seen_idempotency_keys`
- `checkpoints`
- `file_manifest`
- `operation_log`
- `timeout_policy`
- `permission_decisions`

本地 actual project 测试必须真实写临时项目目录；但测试结束要清理临时目录，或者把路径输出为 artifact 供人工复查。

## 修订后的明确结论

1. `upy-analyze-plugin` 和 `upy-scaffold-plugin` 都必须同时支持插件协议模式、mock 协议测试、本地实际落盘测试。
2. `approval_request.item_groups` 是可选增强协议，不是所有插件审批卡片的强制通用协议。
3. checkpoint 应由 skill 生成业务草案，由宿主持久化和调度 resume。
4. `flake8` 是 scaffold 阶段强制 gate，失败不得进入下一阶段。
5. `.upy/scripts/run_on_device.py` 是后续 gen-driver/deploy 的快速设备执行 helper，短期由 scaffold 插件复制，长期应抽成共享工具。
6. `incremental` 成功后进入 `upy-generate-plugin`。
7. 本地测试必须增加 cancel/retry/timeout/idempotency 的 mock protocol 覆盖。

## 当前未实现或需要修正的点：基于原 skill 与插件版流程对比

本节只记录当前 `upy-scaffold-plugin` 相对目标工作流还没完成、需要修正或需要确认的点。原始目录 `G:\MicroPython_Skills\upy-scaffold` 和 `G:\MicroPython_Skills\upy-deploy` 不作为本轮改动对象，只作为对比基准。

### 1. 判定基准：插件化 scaffold 应该满足什么

插件化后的 scaffold 不能再像原 `upy-scaffold` 一样直接写用户项目目录。它应该把副作用拆成结构化消息，由宿主负责执行：

| 责任边界 | skill 负责 | 宿主负责 |
|---|---|---|
| 输入事实 | 读取并校验上游 `manifest_content` | 提供 `start_phase`、`session_id`、上游 `phase_complete` |
| 用户确认 | 生成 `approval_request(scaffold_config)` | 渲染审批卡片、处理取消和超时 |
| 文件生成 | 运行确定性 renderer，输出 `files[]` / `file_operations[]` 草案 | 权限提示、创建目录、写文件、处理覆盖冲突 |
| 校验 | 声明必须执行 flake8 gate | 在真实项目目录执行 lint，并把结果回传 |
| 恢复 | 生成 checkpoint payload 草案 | 持久化 checkpoint、去重、resume 调度 |
| 错误 | 输出结构化错误草案 | 统一封装错误、重试、超时、取消、权限拒绝 |

因此当前判断“是否实现完成”不能只看 `scripts/init_scaffold.py` 能否输出 JSON，还要看本地 mock host、真实落盘测试、checkpoint/resume、权限和 phase 衔接是否完整。

### 2. 原 `upy-scaffold` 与当前 `upy-scaffold-plugin` 的关键差异

原 `upy-scaffold` 的流程是本地 skill 流程：

1. 从 `{project_dir}/project-manifest.json` 读取 select-hw 结果。
2. 通过 AskUserQuestion 询问调度模式、附加模块、自定义文件。
3. 执行 `scripts/init_scaffold.py --project-dir {project_dir} --mode {mode}`。
4. 脚本直接创建 `firmware/`、`tools/`、`docs/`、`host/`、`test/`、`build/` 等目录。
5. 直接写入 `firmware/board.py`、`conf.py`、`boot.py`、`main.py`、driver stub、README、LICENSE、`.flake8`。
6. 直接更新 `project-manifest.json` 的 `phase=scaffold` 和 `scaffold_mode`。
7. 最后尝试运行 flake8，但失败只是 warning，不会阻断流程。

当前 `upy-scaffold-plugin` 的流程已经改成插件 renderer：

1. 从 `start_phase` 或上游 `phase_complete` 取 `manifest_content`。
2. `scripts/init_scaffold.py --manifest - --mode ...` 只输出 stdout JSON，不直接写项目目录。
3. JSON 中包含 `directories[]`、`files[]`、`file_operations[]`、`status_updates[]`、`artifacts[]`、`manifest_content`、`phase_complete_payload`。
4. 宿主应把 `file_operations[]` 应用到真实项目目录。
5. 宿主应在落盘后执行 flake8。
6. 支持 `incremental` 只生成新器件 driver stub。

这个方向是正确的，但当前只完成了“渲染器输出 JSON”这一层，完整插件工作流还没闭环。

### 3. 必须修正：`next_phase` 仍是旧链路

当前存在旧链路字段：

| 位置 | 当前问题 | 应修正为 |
|---|---|---|
| `upy-scaffold-plugin/SKILL.md` | 多处写 `next_phase=upy-generate` | `next_phase=upy-generate-plugin` |
| `scripts/init_scaffold.py` | full 模式 `next_phase = "upy-generate"` | full 成功为 `upy-generate-plugin` |
| `scripts/init_scaffold.py` | incremental 成功 `next_phase = None` | incremental 成功也进入 `upy-generate-plugin` |
| `test/smoke_tests.py` | 断言 full 进入 `upy-generate`，incremental 不自动进入下游 | 断言二者成功时进入 `upy-generate-plugin` |

原因：插件化链路已经是：

```text
upy-analyze-plugin
  -> upy-select-hw-plugin
  -> upy-flash-mpy-firmware-plugin
  -> upy-scaffold-plugin
  -> upy-generate-plugin
```

`incremental` 模式也不能停在 scaffold。它只生成新 driver stub，真正补齐驱动胶水、任务注册和业务逻辑仍然属于 `upy-generate-plugin`。建议 incremental 的 `phase_complete_payload` 增加：

```json
{
  "incremental": true,
  "generate_scope": "new_devices_only",
  "new_devices": [],
  "changed_files": ["firmware/drivers/<name>_driver/__init__.py"],
  "next_phase": "upy-generate-plugin"
}
```

### 4. 必须修正：`project-manifest.json` 没有真实落盘策略

原 `upy-scaffold` 会直接改写 `{project_dir}/project-manifest.json`。当前插件版只在 stdout JSON 和 `phase_complete_payload` 中返回 `manifest_content`，但 `files[]` / `file_operations[]` 中没有 `project-manifest.json`。

这会带来直接问题：

- 本地 actual project 测试如果只应用 `file_operations[]`，项目目录里没有更新后的 `project-manifest.json`。
- `templates/pc/flash_device.py` 当前按 `ROOT/project-manifest.json` 读取 manifest，没有这个文件时工具不可用。
- 后续 `upy-generate-plugin` 如果从项目目录读取 manifest，会读不到 scaffold 阶段更新。
- checkpoint/resume 时无法通过文件 hash 判断 manifest 是否已写入。

建议采用明确规则：renderer 同时输出 `project-manifest.json` 的 `file_operation`，内容等于更新后的 `manifest_content`，并在 `phase_complete_payload.manifest_content` 中保留对象副本。这样插件宿主和本地测试都能得到同一份事实。

待确认点：也可以由宿主把 `manifest_content` 写成 `project-manifest.json`，但这种方案会让 renderer 输出与实际落盘产物分离，不利于本地测试和文件 manifest 校验。当前更推荐 renderer 直接声明该文件。

### 5. 必须修正：flake8 gate 还没有在真实流程中闭环

当前状态：

- 原 `upy-scaffold` 会在脚本末尾运行 flake8，但失败只打印 warning。
- 插件版脚本不运行 flake8，这是正确方向，因为脚本不写真实项目目录。
- `SKILL.md` 写了宿主发送 `script_run(flake8)`，但当前没有本地 mock host 或 actual project 测试证明这个 gate 生效。

应补齐的行为：

1. 宿主在 `file_operations[]` 全部成功后，在真实项目目录运行 flake8。
2. flake8 失败时，`phase_complete.result` 必须是 `failed` 或 `partial`，`next_phase=null`。
3. 错误结构中必须包含 `SCAFFOLD_LINT_FAILED`、stdout/stderr、失败文件列表和可恢复 checkpoint。
4. 本地 actual project 测试必须覆盖 lint 失败分支，不能只测 JSON 输出。

这点是强制 gate，不是 warning。原因是 scaffold 是后续 generate 的代码基座，基座语法或基础风格错误会被后续阶段放大。

### 6. 必须补齐：本地测试现在只覆盖 renderer，不覆盖真实宿主行为

当前 `test/smoke_tests.py` 已覆盖：

- full timer/async/thread 输出 JSON。
- 路径安全和 UTF-8 encoding。
- `file_operations[]` 数量与 `files[]` 对齐。
- incremental 只输出新 driver stub。
- `approval_request.scaffold_config` 样例包含 `item_groups`。
- `run_on_device.py` 缺文件时输出 JSON error。

还缺少两类测试：

| 测试层 | 当前缺口 | 应新增 |
|---|---|---|
| mock protocol | 未模拟完整 `approval_request -> script_run -> file_operation -> flake8 -> phase_complete` 消息流 | `test/run_local_mock_session.py` |
| actual project | 未把 `file_operations[]` 真正写入临时项目目录 | `test/run_local_actual_project.py` |

actual project 测试至少要验证：

- 创建 `directories[]`。
- 应用全部 `file_operations[]`。
- 项目目录里存在 `project-manifest.json`、`firmware/main.py`、`.flake8`、`.upy/scripts/init_scaffold.py`。
- 所有写入路径都不能越界。
- full 模式落盘后执行 flake8。
- incremental 模式只新增 driver stub，不重写 `main.py`、`board.py`。
- 重复 idempotency key 不重复写文件。

### 7. 必须补齐：cancellation/retry/timeout/idempotency 的 mock protocol

用户要求的四类控制现在没有系统测试：

| 场景 | 当前缺口 | 应有行为 |
|---|---|---|
| cancellation | 没有样例说明用户取消审批、取消文件写入、取消 lint 时怎么收尾 | 输出 `result=cancelled` 或 `partial`，`next_phase=null`，带 checkpoint |
| retry | 没有 retry 消息和 checkpoint 复用样例 | 同一 `retry_of`/checkpoint 从失败步骤继续 |
| timeout | 没有 approval/script/file/device timeout 样例 | 结构化错误 `SCRIPT_TIMEOUT` / `APPROVAL_TIMEOUT`，可恢复则带 checkpoint |
| idempotency | `file_operation.payload` 只有 `op_id`，没有每步 idempotency key | 重复操作必须返回已有结果，不重复写入 |

建议新增样例：

```text
sample/start_phase.scaffold.resume.json
sample/approval_response.scaffold_config.cancel.json
sample/script_result.scaffold_lint.timeout.json
sample/phase_complete.scaffold.partial_checkpoint.json
sample/phase_complete.scaffold.failed_lint.json
sample/file_operation.duplicate_idempotency.json
```

并新增 mock host 状态：

```text
seen_idempotency_keys
checkpoints
file_manifest
operation_log
timeout_policy
permission_decisions
```

### 8. 必须补齐：checkpoint/resume 只有设计，没有落地 schema 和样例

当前分析文档已有 checkpoint 结论，但 `upy-scaffold-plugin` 内还缺少可执行产物：

- 缺 `sample/checkpoint.scaffold.render_done.json`。
- 缺 `sample/phase_complete.scaffold.partial.json`。
- 缺 `sample/start_phase.scaffold.resume.json`。
- 缺 validator 或 smoke test 校验 checkpoint 字段。
- 缺 mock host 将 checkpoint 写入 `sessions/<session_id>/checkpoint.json` 的测试。

建议 checkpoint payload 至少包含：

```json
{
  "checkpoint_id": "scaffold:<session_id>:render_done:v1",
  "phase": "upy-scaffold-plugin",
  "resume_step": "render_done",
  "input_manifest_hash": "sha256:...",
  "approval_response": {},
  "render_output_artifact": "sessions/<session_id>/scaffold_render_output.json",
  "file_manifest": {},
  "written_files": [],
  "flake8_result": null,
  "next_phase_candidate": "upy-generate-plugin"
}
```

结论仍建议采用“skill 生成 checkpoint 草案，宿主持久化和调度”的混合模式。完全由 skill 写 checkpoint 文件会导致多 skill 存储格式分裂；完全由宿主维护又缺少业务级 resume 语义。

### 9. 必须补齐：artifact/file manifest 还不够

当前 artifacts 只有 `file_tree` 和 `file_list`，不足以支持恢复、审计和幂等。

应新增 `artifact_manifest` 或扩展 `file_list`：

| 字段 | 作用 |
|---|---|
| `path` | 相对项目根路径 |
| `sha256` | 判断文件是否已写、是否被用户改过 |
| `bytes` | 展示和校验 |
| `encoding` | 写入方式 |
| `operation` | `write` / `skip_existing` / `merge` |
| `idempotency_key` | 去重 |
| `permission_scope` | 文件写入权限提示 |

特别是 `project-manifest.json`、`.upy/scripts/*`、`tools/*` 都应该在 manifest 中有 hash。否则 retry/resume 时只能靠路径判断，无法知道内容是否一致。

### 10. 必须补齐：permission prompts 还没有细化到每类副作用

插件版不能默认写文件、跑脚本或碰设备。当前文档有原则，但 `upy-scaffold-plugin` 的样例和测试还没有把权限提示落到字段。

建议拆成三类权限：

| 权限 | scaffold 阶段是否需要 | 说明 |
|---|---:|---|
| file write | 需要 | 写 `firmware/`、`.upy/`、`tools/`、`project-manifest.json` |
| script_run | 需要 | 执行 `init_scaffold.py` 和 flake8 |
| device/script operation | scaffold 本阶段不直接需要 | `run_on_device.py`、`flash_device.py` 只是复制资源，真正调用应在 gen-driver/deploy 阶段申请 |

`file_operation` 应声明覆盖策略，例如：

```json
{
  "op": "write",
  "path": "firmware/main.py",
  "overwrite": "deny_if_user_modified",
  "permission": {
    "kind": "file_write",
    "prompt": true
  }
}
```

### 11. 模板结论：py 文件保持简单是对的，但需要稳定插入点和结构化事实

用户判断是正确的：`templates` 里的固件 `.py` 文件不应该提前写复杂业务逻辑。真实功能点、驱动胶水、网络连接、任务注册应该由 `upy-generate-plugin` 负责。

当前模板基本合格的部分：

- `boot.py.tmpl` 只做 emergency exception buffer，WDT 以注释示例保留，复杂启用策略交给 generate。
- `main_timer.py.tmpl`、`main_async.py.tmpl`、`main_thread.py.tmpl` 只搭调度框架和 TODO。
- driver stub 只写来源和 TODO，不伪造驱动实现。
- logger、scheduler、time_helper、maintenance 属于基础工具模块，不是业务逻辑。

但仍有需要修正或确认的点：

| 模板点 | 问题 | 建议 |
|---|---|---|
| `board.py.tmpl` | `INTERFACES` 目前主要结构化 I2C，SPI/UART/I2S/ADC/PWM/GPIO 更多依赖原始 `PINOUT` | 保持简单，但至少按 `interface/type/bus` 生成分组，供 generate 精准消费 |
| `main_*.py.tmpl` | TODO marker 太普通，后续 generate 插入时可能只能靠字符串定位 | 定义稳定 marker，例如 `# <upy-generate:hardware-init>`、`# <upy-generate:task-registration>` |
| `extract_gpio_inits` | 方向判断存在歧义，`pin_name in {"out","do","data"}` 当前会设成 `Pin.IN`，对某些输出设备可能错误 | 明确 manifest 中 `type/interface/direction` 的语义，无法判断时只生成 TODO，不强行实例化 |
| `board.py.tmpl` | 固定输出 `I2C1 = 1`，即使没有 I2C1 也存在 | 问题不大，但可按实际 bus 生成，减少误导 |
| `conf.py.tmpl` | 没有 secrets 示例 | 不应写真实 Wi-Fi/API key，但可生成 `secrets.example.py` 或 `conf_user.py.example` |
| `templates/pc/*` | PC 工具偏 deploy/log 领域，职责边界偏宽 | 只在审批选中模块时复制到 `tools/`；`.upy/scripts` 中复制可作为共享工具，但要声明不是 scaffold 阶段直接执行 |

总体结论：模板“简单”是合格方向；当前最大的模板问题不是不够复杂，而是给 `upy-generate-plugin` 的结构化入口和稳定插入点还不够明确。

### 12. PC 工具与 `.upy/scripts/run_on_device.py` 的边界需要修正说明

`.upy/scripts/run_on_device.py` 的作用是用宿主本机的 `mpremote run` 把一个短脚本发送到 MicroPython 设备执行，并捕获 stdout/stderr。它适合后续：

- `upy-gen-driver-plugin` 验证新驱动。
- `upy-deploy-plugin` 或 deploy 快速检查设备状态。
- 本地有设备时手工调试。

它不应该在 scaffold 阶段自动执行。scaffold 只负责复制这个工具到 `.upy/scripts/`，真正调用时必须由后续阶段通过 `script_run` 申请设备/串口权限。

当前还需要修正：

- `templates/pc/flash_device.py`、`read_device_log.py` 如果作为插件 `script_run` 使用，应支持结构化 JSON summary。
- 这些工具依赖 `project-manifest.json`，所以 scaffold 必须明确谁写这个文件。
- 权限提示要区分“复制工具文件”和“执行工具碰设备”。复制不需要设备权限，执行需要。

### 13. 上游校验还不完整

`SKILL.md` 要求正式链路从 `phase_complete(upy-flash-mpy-firmware-plugin)` 进入，且上游成功、`next_phase=upy-scaffold-plugin`。当前 renderer 的 `unwrap_manifest()` 很宽松，能接受裸 manifest、payload manifest、source phase complete，但没有强制校验：

- 上游 `type == "phase_complete"`。
- 上游 `payload.result == "success"`。
- 上游 `payload.next_phase == "upy-scaffold-plugin"`。
- 上游 `payload.manifest_content` schema 合法。
- `runtime_context.artifact_root_mode` 路径口径一致。

建议区分两种入口：

| 入口 | 行为 |
|---|---|
| 正式 plugin 模式 | 严格校验上游 phase_complete 和 capability |
| 本地迁移直测模式 | 允许裸 manifest，但必须显式 `--allow-direct-manifest` 或在测试脚本中说明 |

这样可以避免正式链路从日志、旧草稿或对话记忆里猜硬件事实。

### 14. capability negotiation 还没有失败分支

当前启动样例里有 `capabilities`，但缺少缺能力时的行为。

必须定义：

| 缺少能力 | 应返回 |
|---|---|
| `approval_request=false` 且没有预确认 `scaffold_config` | `CAPABILITY_MISSING`，不能进入 full 审批 |
| `script_run=false` | 不能运行 renderer 和 flake8，返回 blocked/failed |
| `file_operation=false` | 只能输出文件清单，不能要求写项目目录 |
| `checkpoint=false` | 可以运行，但 `resume` 能力降级，phase_complete 要声明 |
| `permission_prompt=false` | 不能执行文件写入和设备相关动作 |

这些缺口需要在 sample 和 smoke test 中体现。

### 15. `approval_request.item_groups` 的定位需要写清楚

当前 `scaffold_config` 使用 `item_groups` 是合理的，因为同一张审批卡片中同时有：

- 调度模式单选。
- 附加模块多选。
- 自定义文件输入。

但它不应该升级为所有插件审批卡片的强制 UI 协议。参考前面几个插件：

- `upy-analyze-plugin` 多用平铺 `items[]`、`actions[]`。
- `upy-select-hw-plugin` 有板卡选择、引脚审核、手工接线 schema 等业务字段。
- `upy-flash-mpy-firmware-plugin` 更依赖 `actions[]`、`steps[]`、`links[]`。

建议写法：`item_groups` 是 `approval_request.payload.items[]` 的可选增强字段。`scaffold_config` 可以要求包含它，但共享协议不能强制所有审批卡片都使用它。

### 16. 目录结构与原版相比的缺口

当前插件版相对原版还有目录/文件差异需要确认：

| 原版产物 | 当前插件版状态 | 建议 |
|---|---|---|
| `docs/.gitkeep` | 当前 `add_placeholder_files()` 未生成 | 建议恢复，保留文档产物入口 |
| `project-manifest.json` | 只返回 `manifest_content`，不写文件 | 建议加入 `file_operations[]` |
| `host/.gitkeep` | 已生成 | 保留 |
| `test/device/.gitkeep`、`test/pc/.gitkeep` | 已生成 | 保留 |
| `build/firmware/.gitkeep`、`build/mpy/.gitkeep` | 已生成 | 保留 |
| `firmware/assets/.gitkeep` | 已生成 | 保留 |

如果决定不保留 `docs/`，需要在 `SKILL.md` 明确这是插件版有意缩减，而不是遗漏。

### 17. `.upy` 资源来源需要重新检查

当前 `scripts/init_scaffold.py` 中资源路径仍有旧目录名：

```text
UPY_GENERATE_DIR = REPO_ROOT / "upy-generate"
UPY_WIRING_DIR = REPO_ROOT / "upy-wiring"
UPY_DIAGRAM_DIR = REPO_ROOT / "upy-diagram"
UPY_GEN_DRIVER_DIR = REPO_ROOT / "upy-gen-driver"
UPY_AUTOFIX_DIR = REPO_ROOT / "upy-autofix"
```

如果目标链路已经全面插件化，后续目录可能应该是：

```text
upy-generate-plugin
upy-wiring-plugin
upy-diagram-plugin
upy-gen-driver-plugin
upy-autofix-plugin
```

需要确认这些工具脚本的来源策略：

1. 继续复用原 skill 目录中的工具脚本。
2. 改为复用 plugin 目录中的工具脚本。
3. 抽成共享 `upy-tooling` 或 toolchain resource，由 scaffold 复制稳定版本。

当前如果依赖的旧目录不存在，renderer 会把资源缺失放入 `warnings`，但这不应该在正式链路里静默通过。关键 `.upy` 工具缺失应当是失败或降级策略明确的 partial。

### 18. `structured_errors` 需要统一字段

当前输出中有 `errors: []`，但没有统一结构。建议与前面插件靠拢，错误对象至少包含：

```json
{
  "code": "SCAFFOLD_LINT_FAILED",
  "message": "flake8 failed after file operations",
  "severity": "error",
  "recoverable": true,
  "retryable": true,
  "source": "upy-scaffold-plugin",
  "step": "lint",
  "details": {}
}
```

需要覆盖的错误码：

- `INVALID_MANIFEST`
- `UPSTREAM_PHASE_INVALID`
- `UNSUPPORTED_PROTOCOL_VERSION`
- `CAPABILITY_MISSING`
- `PERMISSION_DENIED`
- `USER_CANCELLED`
- `SCRIPT_FAILED`
- `SCRIPT_TIMEOUT`
- `FILE_OPERATION_FAILED`
- `SCAFFOLD_LINT_FAILED`
- `CHECKPOINT_CORRUPT`
- `UNSAFE_PATH`

### 19. incremental 模式还缺少文件冲突策略

当前 incremental 会对 `new_devices` 生成 `firmware/drivers/<safe_name>_driver/__init__.py`。还需要明确：

- 如果该 driver 文件已存在，是否覆盖、跳过、合并还是报错。
- 如果新器件名经过 `safe_var_name()` 后与已有器件冲突，如何处理。
- 如果 manifest 中已有同名器件，但用户再次添加，是否视为 idempotent 成功。
- 如果用户新增器件需要更新 `board.py` 或 `conf.py`，是否仍只允许 driver stub，还是进入 generate 阶段处理。

建议：scaffold incremental 只写新 stub；已有文件默认不覆盖，返回 `already_exists` 并让 `upy-generate-plugin` 决定是否合并业务逻辑。

### 20. 需要用户确认的点

后续真正改代码前建议确认以下事项：

1. `project-manifest.json` 是否由 renderer 作为 file_operation 输出。当前建议是“是”。
2. 是否恢复 `docs/.gitkeep`。当前建议是“是”。
3. `.upy/scripts/*` 的来源继续用旧 skill 目录，还是迁移到 plugin 目录或共享 tooling。当前建议先保守复用可用脚本，但正式链路要把缺失关键资源视为失败。
4. full 和 incremental 成功后是否都进入 `upy-generate-plugin`。当前建议是“都进入”，incremental 附加 `generate_scope=new_devices_only`。
5. `item_groups` 是否只作为 scaffold_config 的增强协议，而不是所有插件审批 UI 的强制标准。当前建议是“只作为增强协议”。
6. `templates` 是否只补稳定 marker 和结构化 pinout，不增加复杂业务代码。当前建议是“只补结构，不写业务”。

### 21. 建议下一轮实现顺序

1. 修正 `next_phase`：所有成功路径改为 `upy-generate-plugin`，incremental 增加 `generate_scope`。
2. 在 renderer 中输出 `project-manifest.json` 和 `docs/.gitkeep`。
3. 增加 file manifest/hash/idempotency key。
4. 增加本地 actual project 测试，把 `file_operations[]` 写入临时目录并运行 flake8 gate。
5. 增加 mock protocol 测试，覆盖 cancellation/retry/timeout/idempotency。
6. 增加 checkpoint/resume 样例和校验。
7. 给 `main_*.py.tmpl` 增加稳定 marker，给 `board.py` 增加更结构化的 interface grouping。
8. 明确 `.upy` 资源来源和缺失时的失败策略。

## 追加专项评估：8 个待定点的实现方式

本节只评估实现方式，不修改 `upy-scaffold-plugin`、原 `upy-scaffold` 或 `upy-deploy` 内容。结论基于当前目录状态：仓库里目前有旧 `upy-generate`、`upy-wiring`、`upy-diagram`、`upy-gen-driver`、`upy-autofix`，但还没有 `upy-generate-plugin`、`upy-wiring-plugin`、`upy-diagram-plugin`、`upy-gen-driver-plugin`、`upy-autofix-plugin` 目录。

### 1. Claude Code 本地测试调用时，skill 能否操作项目目录并复制文件

结论：可以，但不应该让 `scripts/init_scaffold.py` 直接恢复成写项目目录的脚本。更稳的实现是新增“本地宿主/actual runner”，由它把 renderer 输出的 `file_operations[]` 应用到项目目录。

当前 `upy-scaffold-plugin/scripts/init_scaffold.py` 的正确定位是无副作用 renderer：

```text
manifest_content -> stdout JSON -> files[] / file_operations[]
```

插件正式调用时，真实文件写入由插件宿主完成。Claude Code 本地测试时，也应该模拟这个宿主行为：

```text
run_local_actual_project.py
  1. 读取 manifest 或 phase_complete
  2. 调用 init_scaffold.py 得到 stdout JSON
  3. 校验所有 path 是相对路径，不能有盘符、绝对路径、..
  4. 在 project_dir 下创建 directories[]
  5. 逐条应用 file_operations[]
  6. 写入/校验 project-manifest.json
  7. 运行 flake8 gate
  8. 生成 phase_complete / checkpoint / file_manifest
```

这样能同时满足两种需求：

| 场景 | 写项目目录吗 | 实现方式 |
|---|---:|---|
| 插件调用 | 由宿主写 | skill 输出 `file_operation`，宿主执行 |
| smoke/mock 测试 | 不写最终项目目录 | 只校验消息和 JSON |
| Claude Code 本地 actual 测试 | 写临时或指定项目目录 | 本地 runner 应用 `file_operations[]` |

推荐新增的本地入口是：

```text
python upy-scaffold-plugin/test/run_local_actual_project.py ^
  --manifest <manifest-or-phase-complete.json> ^
  --project-dir <temp-or-user-project-dir> ^
  --mode timer ^
  --apply ^
  --run-flake8
```

注意：如果项目目录在 Claude Code 当前可写根之外，仍需要用户授权。这个限制来自本地执行环境，不是 skill 协议问题。实现上必须先解析 project_dir 的绝对路径，确认写入都落在 project_dir 内，再复制文件。

### 2. `next_phase` 必须改成 `upy-generate-plugin`

结论：必须改。当前 `SKILL.md`、`scripts/init_scaffold.py`、`test/smoke_tests.py` 里仍有旧值 `upy-generate` 或 incremental 成功后 `next_phase=null`，都不符合插件链路目标。

未来实现改动点：

| 文件/位置 | 应改内容 |
|---|---|
| `upy-scaffold-plugin/SKILL.md` | 所有 `upy-generate` 改为 `upy-generate-plugin` |
| `scripts/init_scaffold.py::build_output()` | full 和 incremental 成功都输出 `next_phase="upy-generate-plugin"` |
| `scripts/init_scaffold.py::driver_stub()` | 注释中的 `upy-generate` 改为 `upy-generate-plugin` |
| `test/smoke_tests.py` | full/incremental 断言都改为 `upy-generate-plugin` |
| `sample/*.json` | 所有成功样例同步改 next_phase |

建议逻辑：

```python
next_phase = "upy-generate-plugin"
```

incremental 还应增加上下文，避免下游误以为要全量生成：

```json
{
  "next_phase": "upy-generate-plugin",
  "incremental": true,
  "generate_scope": "new_devices_only",
  "new_devices": [],
  "changed_files": []
}
```

实现时要注意一个现实差异：当前仓库尚未存在 `upy-generate-plugin` 目录，但 `next_phase` 是协议目标，不等同于本地目录必须已经存在。正式调用时如果宿主找不到该 plugin，应由宿主报 `NEXT_PHASE_UNAVAILABLE` 或进入 blocked，而不应让 scaffold 回退到旧 `upy-generate`。

### 3. 改造后是否还需要 `project-manifest.json`

结论：仍然需要。`manifest_content`、`phase_complete.*.json`、`checkpoint.json`、`artifact_manifest.json` 都不能完全替代 `project-manifest.json`。

原因如下：

| JSON | 作用 | 能否替代 `project-manifest.json` |
|---|---|---:|
| `phase_complete.payload.manifest_content` | 阶段消息里的事实快照 | 否，它是会话消息，不一定落在项目根 |
| `phase_complete.upy_scaffold_plugin.json` | 阶段完成记录 | 否，它是 session artifact，不是项目运行事实文件 |
| `checkpoint.json` | 恢复/重试状态 | 否，它描述流程状态，不描述项目事实 |
| `artifact_manifest.json` | 文件清单、hash、写入状态 | 否，它描述产物，不是硬件/需求 manifest |
| `project-manifest.json` | 项目根下的持久事实文件 | 是，需要保留 |

当前旧 `upy-generate` 明确读取 `project-manifest.json`，`templates/pc/flash_device.py` 也读取项目根的 `project-manifest.json`。在 `upy-generate-plugin` 未完成前，本地兼容更离不开它。即使未来所有阶段都插件化，也建议继续保留项目根 `project-manifest.json`，因为它是用户项目可以独立携带、版本管理、离线检查的事实文件。

建议实现方式：

1. renderer 更新 `manifest_content`。
2. renderer 把更新后的 manifest 同时加入 `files[]`：

```json
{
  "path": "project-manifest.json",
  "content": "{...updated manifest...}",
  "encoding": "utf-8"
}
```

3. `phase_complete_payload.manifest_content` 继续保留对象形式，方便插件链路直接传递。
4. `artifact_manifest` 记录 `project-manifest.json` 的 hash。

这不是重复存储，而是两个层级：

```text
project-manifest.json        项目内长期事实文件
phase_complete.manifest_content  插件消息中的阶段传递事实
```

### 4. flake8 gate 在插件调用和 Claude Code 本地调用时都必须运行

结论：必须运行，并且失败不能进入 `upy-generate-plugin`。

插件调用实现：

```text
1. init_scaffold.py 输出 file_operations[]
2. 宿主申请 file write permission
3. 宿主写入项目目录
4. 宿主执行 script_run(flake8)
5. flake8 成功 -> phase_complete success, next_phase=upy-generate-plugin
6. flake8 失败 -> phase_complete failed/partial, next_phase=null
```

Claude Code 本地 actual 测试实现：

```text
1. run_local_actual_project.py 应用 file_operations[]
2. 在 project_dir 下执行：
   python -m flake8 firmware tools
3. 返回码非 0 直接失败
4. 记录 stdout/stderr 到 local artifact
```

建议错误结构：

```json
{
  "code": "SCAFFOLD_LINT_FAILED",
  "message": "flake8 failed after scaffold file operations",
  "step": "lint",
  "retryable": true,
  "recoverable": true,
  "details": {
    "command": "python -m flake8 firmware tools",
    "stdout": "",
    "stderr": ""
  }
}
```

如果本地环境没有 flake8，也应视为 gate 失败，而不是跳过。可以给出安装提示，但不能输出 success。

### 5. `templates` 里的固件相关文件先不用改

结论：当前先不改 `templates/firmware/*.tmpl` 和基础固件模板。业务代码、驱动胶水、网络逻辑、任务注册、复杂 bus 初始化由 `upy-generate-plugin` 负责。

本轮实现只应围绕：

- 协议字段。
- `next_phase`。
- `project-manifest.json` 落盘。
- `docs/` 保留。
- flake8 gate。
- 本地 actual runner。
- `.upy` 资源来源。

不建议现在把 SPI/UART/I2S/ADC/PWM、网络连接、传感器任务、显示任务提前写进 scaffold 模板。scaffold 的职责仍然是“项目骨架”，不是“功能实现”。

如果后续必须让 generate 更容易插入代码，优先由 `upy-generate-plugin` 自己读取现有 `manifest_content` 和 `project-manifest.json` 来重写/补全文件，而不是要求 scaffold 先复杂化模板。

### 6. `templates/pc/flash_device.py`、`read_device_log.py` 是否需要在本 skill 中修改

结论：短期不建议在 `upy-scaffold-plugin` 中修改这两个工具的业务逻辑。它们属于后续 `upy-deploy-plugin` 的执行工具或共享工具，不是 scaffold 阶段要运行的逻辑。

当前这两个文件的问题：

| 文件 | 当前状态 | 对 scaffold 的影响 |
|---|---|---|
| `templates/pc/flash_device.py` | 读取项目根 `project-manifest.json`，交互选择串口，执行 mpy-cross/mpremote/esptool | scaffold 必须保证 `project-manifest.json` 存在；不应在 scaffold 阶段执行 |
| `templates/pc/read_device_log.py` | 通过 mpremote 读/下载/清理设备日志，stdout 文本输出 | scaffold 只复制；真正调用时需要设备权限 |

如果未来 `upy-deploy-plugin` 要直接调用这些脚本，则有两种实现路线：

| 路线 | 做法 | 推荐度 |
|---|---|---:|
| deploy plugin 拥有工具 | 把 JSON summary、非交互参数、权限边界放到 `upy-deploy-plugin` 自己的 scripts/resources | 推荐 |
| scaffold 复制共享工具 | scaffold 从共享 tooling 复制稳定版 `flash_device.py`、`read_device_log.py` 到 `.upy/scripts/` | 可行 |

不推荐让 scaffold 阶段为了 deploy 需求修改这些脚本逻辑。scaffold 应只做三件事：

1. 可选地把它们复制到 `tools/`，供用户人工使用。
2. 把后续阶段需要的稳定工具复制到 `.upy/scripts/`。
3. 在 artifacts 中声明这些文件是“后续 deploy/gen-driver 工具”，不是 scaffold 当前执行产物。

但这里有一个必须配套的点：因为 `flash_device.py` 依赖 `project-manifest.json`，所以第 3 点中保留并落盘 `project-manifest.json` 是必要条件。

### 7. 保留 `docs/`

结论：保留 `docs/`，至少生成 `docs/.gitkeep`。

原 `upy-scaffold` 会创建 `docs/.gitkeep`，当前 `upy-scaffold-plugin/add_placeholder_files()` 没有包含它。建议恢复，原因：

- 后续 wiring/diagram/readme/deploy 可能需要放说明、接线图、报告或人工记录。
- 用户项目目录保留文档入口有价值。
- 与原 skill 的项目结构兼容。
- 成本很低，只是一个 placeholder。

未来实现点：

```python
def add_placeholder_files(files):
    for path in [
        "docs/.gitkeep",
        "host/.gitkeep",
        "test/device/.gitkeep",
        "test/pc/.gitkeep",
        "build/firmware/.gitkeep",
        "build/mpy/.gitkeep",
        "firmware/assets/.gitkeep",
    ]:
        files.append(file_payload(path, ""))
```

测试同步增加断言：

```text
docs/.gitkeep in output files
docs/.gitkeep in actual project
docs/.gitkeep in file_tree/artifact_manifest
```

### 8. `.upy` 资源来源需要修正

结论：需要修正。当前 `add_upy_resources()` 直接从旧 skill 目录取资源，例如 `upy-generate`、`upy-wiring`、`upy-diagram`、`upy-gen-driver`、`upy-autofix`。这在插件化目标下不稳定。

当前现实是：这些 plugin 目录还不存在，所以不能简单把路径全部改成 `*-plugin`。推荐采用“资源注册表 + 优先级 fallback + 明确缺失策略”。

建议资源来源策略：

```text
1. 优先使用 plugin/shared tooling 资源
2. plugin 资源不存在时，迁移期允许 fallback 到旧 skill 目录
3. 每个资源声明 required/optional、owner、用于哪个阶段
4. required 资源缺失 -> 失败或 partial，不再只写 warning
5. optional 下游工具缺失 -> artifact 标记 unavailable，后续阶段自行提供
```

示例资源注册表：

```python
RESOURCE_SOURCES = {
    ".upy/schemas/project-manifest.schema.json": {
        "required": True,
        "candidates": [
            "upy-project-gen-toolchain-spec/project-manifest.schema.json",
        ],
        "owner": "toolchain-spec",
    },
    ".upy/scripts/download_drivers.py": {
        "required": False,
        "candidates": [
            "upy-generate-plugin/scripts/download_drivers.py",
            "upy-generate/scripts/download_drivers.py",
        ],
        "owner": "upy-generate-plugin",
    },
    ".upy/scripts/render_wiring_local.py": {
        "required": False,
        "candidates": [
            "upy-wiring-plugin/scripts/render_wiring_local.py",
            "upy-wiring/scripts/render_wiring_local.py",
        ],
        "owner": "upy-wiring-plugin",
    }
}
```

资源应分级：

| 级别 | 资源 | 缺失处理 |
|---|---|---|
| scaffold 核心 | `project-manifest.schema.json`、`validate_json.py`、`.upy/scripts/init_scaffold.py` | 失败，不进入 success |
| 后续阶段工具 | `download_drivers.py`、`render_wiring_local.py`、`render_diagram_local.py`、`extract_pdf.py`、`convert_arduino.py` | 迁移期可 optional，但 artifacts 要标明 unavailable |
| deploy/device 工具 | `flash_device.py`、`read_device_log.py`、`run_on_device.py` | 复制但不执行，执行权限留给后续阶段 |
| autofix 工具 | `hardware_sanity.py`、`triage.py`、`error_lib.json` | optional 或由 `upy-autofix-plugin` 自带 |

最终更稳的长期方案是抽出共享 tooling，例如：

```text
upy-tooling/
  schemas/
  scripts/
  resource_manifest.json
```

或由 `upy-project-gen-toolchain-spec` 提供稳定 resource manifest。这样 scaffold 不需要直接依赖多个 skill/plugin 目录的内部路径。

### 本轮 8 点的综合实现顺序

推荐后续实现按这个顺序做：

1. 保持 `init_scaffold.py` 无副作用，不恢复直接写项目目录。
2. 新增 Claude Code 本地 actual runner，专门应用 `file_operations[]` 到 project_dir。
3. 修改所有成功路径 `next_phase=upy-generate-plugin`，incremental 增加 `generate_scope=new_devices_only`。
4. renderer 输出 `project-manifest.json` 的 file_operation，并继续在 phase_complete 保留 `manifest_content`。
5. full/incremental 的插件调用和本地 actual 调用都强制运行 flake8 gate。
6. 不改 `templates/firmware` 业务内容。
7. `flash_device.py`、`read_device_log.py` 在 scaffold 中只作为复制资源，不在本阶段改成交互协议工具；真正 JSON 化由 `upy-deploy-plugin` 或共享 tooling 负责。
8. 恢复 `docs/.gitkeep`。
9. 将 `.upy` 资源来源改为注册表机制，优先 plugin/shared，迁移期 fallback 旧 skill，缺失策略明确化。
