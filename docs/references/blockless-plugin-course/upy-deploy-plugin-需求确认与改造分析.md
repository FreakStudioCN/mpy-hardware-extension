# upy-deploy-plugin 需求确认与改造分析

生成时间：2026-06-25

## 1. 本次需求确认

本次任务当前阶段是“先分析、先确认需求”，不是立即覆盖或重写已有 skill。

我对需求的理解如下：

1. 总目标是把“一句话造硬件”相关 skill 从本地直跑式工作流，逐步改造成适合插件协作的工作流。
2. 原始总体规划参考：
   - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\一句话造硬件-功能规划.md`
3. 已有分析与接口规划参考：
   - `G:\blockless-plugin-course(1)\02-架构分析`
   - `G:\blockless-plugin-course(1)\03-Skill接口`
4. 当前重点不是继续填 `plugin-interface` 草案，而是从真实 skill 现状出发，做差距分析和改造边界确认。
5. 不能覆盖原始 `G:\MicroPython_Skills\upy-deploy`。
6. 后续应在 `G:\MicroPython_Skills` 下新建独立目录：
   - `G:\MicroPython_Skills\upy-deploy-plugin`
7. 新建的 `upy-deploy-plugin` 应承接已有插件化链路，而不是回到旧的本地直跑链路。
8. 当前已完成或正在作为上游参考的前五个插件化步骤是：
   - `G:\MicroPython_Skills\upy-analyze-plugin`
   - `G:\MicroPython_Skills\upy-select-hw-plugin`
   - `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin`
   - `G:\MicroPython_Skills\upy-scaffold-plugin`
   - `G:\MicroPython_Skills\upy-generate-plugin`
9. `G:\MicroPython_Skills\upy-generate-plugin` 已经把默认下游写成 `upy-deploy-plugin`，因此缺口实际已经指向 deploy 插件化阶段。
10. `G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin` 中已有串口扫描、用户确认、脚本白名单、phase_complete、state/checkpoint 等设计，可作为 `upy-deploy-plugin` 的重要参考。
11. `upy-deploy-plugin` 应支持“擦除/清理设备文件系统后再上传”的部署模式，用于避免旧文件、旧 `.mpy`、旧配置或同名模块遮蔽新代码。
12. `mpremote-device-interaction`、`mpremote-file-transfer`、`mpremote-live-session` 三个 skill 对部署阶段有直接启发，需要纳入 `upy-deploy-plugin` 的设计参考。
13. phase 名称已经确认统一：协议消息、`phase_complete.payload.phase`、`manifest_content.phase` 都写 `phase="upy-deploy-plugin"`，不再混用 `deploy`。
14. deploy 完成后需要展示“烧录/部署情况”选项卡和用户说明，读取用户反馈后再分流到重新生成、自动化调试或结束上传项目库。
15. `project/tools/flash_device.py` 必须新增 `--json-summary` 输出，作为 deploy-plugin 消费的稳定脚本结果。
16. `capture_repl.py` 作为 `upy-deploy-plugin` 独立脚本新增，不再只停留在“是否独立”的待确认状态。
17. 串口扫描等可复用 mpremote 脚本应抽到公共脚本目录，避免多个 plugin 复制后重复维护。

## 2. 当前应确认的主链路

插件化后的主链路应理解为：

```text
upy-analyze-plugin
-> upy-select-hw-plugin
-> upy-flash-mpy-firmware-plugin
-> upy-scaffold-plugin
-> upy-generate-plugin
-> upy-deploy-plugin
```

其中需要特别区分两类“烧录”：

| 阶段 | 职责 | 不应混淆的点 |
| --- | --- | --- |
| `upy-flash-mpy-firmware-plugin` | 给 MCU 烧录 MicroPython 解释器固件，例如 ESP32 `.bin`、Pico `.uf2` | 这是“准备 MicroPython 运行环境” |
| `upy-deploy-plugin` | 把 `upy-generate-plugin` 生成的项目 `firmware/` 上传到已具备 MicroPython 的设备，软复位、采集输出、读取日志并初判 PASS/FAIL | 这是“部署用户项目代码并运行验证” |

因此 `upy-deploy-plugin` 不应该重复实现 MicroPython 官方固件下载/烧录逻辑；那部分已属于 `upy-flash-mpy-firmware-plugin`。

## 3. 已读现状结论

### 3.1 原始 `upy-deploy`

原始目录：

```text
G:\MicroPython_Skills\upy-deploy
```

原始 `SKILL.md` 的定位是：

```text
给定 project-manifest.json（phase: generate），将 firmware/ 上传到 MicroPython 设备、运行、采集输出、初判结果。
不做错误修复，错误修复交给 upy-autofix。
```

它包含的关键能力：

- 使用 `tools/flash_device.py --compile --upload --no-reset --port <COM>` 上传项目。
- 若项目工具缺失，可降级用 `mpremote fs cp` 上传。
- 上传顺序必须是依赖优先、入口最后：
  - `lib/`
  - `drivers/`
  - config
  - `tasks/`
  - `main.py`
- `main.py` 必须最后上传。
- `main.py` 需要 3 秒启动延时，给 Windows USB/COM 重枚举和 `mpremote` 重连留窗口。
- 软复位后轮询等待设备恢复。
- 建立持久 REPL 会话采集输出。
- 从设备端 `/log/run_*.log` 补采日志，避免 REPL 断连丢日志。
- 使用本地规则初判：
  - Traceback、WDT reset、Guru Meditation、MemoryError、无输出等判 FAIL。
  - 无明显错误则 PASS。
- FAIL 时把 REPL 输出、结构化日志报告和原始设备日志交给后续 autofix。

这些业务规则应迁移到 `upy-deploy-plugin`，但执行方式要从“直接 Bash/mpremote”改成“协议消息 + 白名单脚本/设备命令”。

### 3.2 `upy-generate-plugin`

当前 `upy-generate-plugin` 已经是插件化形态，并明确写出：

```text
-> upy-deploy-plugin 或 upy-simulate-plugin
```

成功输出默认：

```json
{
  "payload": {
    "phase": "generate",
    "result": "success",
    "next_phase": "upy-deploy-plugin"
  }
}
```

这说明后续缺口不是“是否需要 deploy-plugin”，而是 `upy-deploy-plugin` 尚未落地。

`upy-generate-plugin` 还为 deploy 提供了关键前置条件：

- `firmware/main.py` 必须保留启动延时。
- `main.py` 要有 REPL 可见的 `print()` 输出。
- 关键日志应 `print()` + rotating logger 双写。
- 每个 I2C 驱动工厂应提供 `scan_<name>_i2c(...)`，便于部署/调试阶段做连通性判断。
- success 状态必须通过质量门禁，才可进入 deploy。

### 3.3 `upy-flash-mpy-firmware-plugin`

该目录可作为 `upy-deploy-plugin` 的协议化参考：

```text
G:\MicroPython_Skills\upy-flash-mpy-firmware-plugin
```

可复用的设计模式：

- 独立 `*-plugin` skill，不覆盖旧 skill。
- 明确 `start_phase` 输入契约。
- 使用 `runtime_context` 区分：
  - `artifact_root`
  - `session_root`
  - `resource_root`
- 使用 `capabilities` 声明宿主能力，例如：
  - `approval_request`
  - `script_run`
  - `file_operation`
  - `serial_port_scan`
  - `device_flash`
- 真实运行必须扫描真实串口，不能在 live 模式固定 `COM3`。
- mock/sample 测试才允许固定 `COM3`。
- 所有正式脚本走白名单。
- 产物写到 `sessions/<session_id>/`。
- `state` 文件用于恢复/重试/排错，不能替代 `phase_complete`。
- `phase_complete.payload.artifacts` 必须声明正式产物。
- partial/failed 也要结构化输出，并写 checkpoint。

可直接参考的脚本：

```text
upy-flash-mpy-firmware-plugin\scripts\list_serial_ports.py
```

该脚本的价值：

- live 模式优先使用 `serial.tools.list_ports`。
- Windows 上 pyserial 缺失时，降级调用 PowerShell：
  - `[System.IO.Ports.SerialPort]::GetPortNames()`
- 输出结构化 JSON：
  - `status`
  - `mode`
  - `ports[]`
  - `error`
- mock 模式允许 `--mode mock --mock-port COM3`。
- live 模式禁止 `--mock-port`，防止真实运行误用固定端口。

`upy-deploy-plugin` 应复用这种“真实扫描 + 用户选择 + mock 可测”的端口处理原则。

### 3.4 `upy-scaffold-plugin`

`upy-scaffold-plugin` 已经把项目部署工具作为可选模块注入：

- `tools/flash_device.py`
- `tools/read_device_log.py`
- `tools/log_report.py`

这些工具正好是 `upy-deploy` 原始设计中依赖的部署工具。

因此 `upy-deploy-plugin` 应优先消费项目内工具：

```text
project/tools/flash_device.py
project/tools/read_device_log.py
project/tools/log_report.py
```

如果这些工具缺失，才进入降级路径或输出 partial，而不是在 skill 内随意拼接大量 shell 命令。

### 3.5 `mpremote-device-interaction`

该 skill 说明了 MicroPython 设备交互的基础规则，对 `upy-deploy-plugin` 有以下启示：

- Windows 设备应通过 `mpremote connect list` 或串口扫描得到 `COMn`，不要在真实运行中写死端口。
- macOS 脚本应使用完整 `/dev/tty.usbmodem*` 或 `/dev/tty.usbserial*` 路径。
- Linux 推荐使用 `/dev/serial/by-id/*` 或 `mpy-dev tty <name>`，不要依赖易变的 `/dev/ttyUSB0`。
- `resume` 表示连接但不打断运行程序；不带 `resume` 的连接可能触发软复位。
- `soft-reset` 应明确用于重启应用，不能和普通文件操作混在一起。
- 部署前后可采集设备状态：
  - `sys.version`
  - `os.uname()`
  - `machine.freq()`
  - `machine.reset_cause()`
  - `gc.mem_free()`
  - `os.statvfs('/')`
  - `fs tree`
- 设备文件系统中的 `.py` 文件可能遮蔽 frozen module 或新上传的 `.mpy`，因此 deploy 阶段需要支持清理旧文件。

对 `upy-deploy-plugin` 的建议：

```text
deploy 前应有 device_probe 步骤，记录 device_info。
deploy 可选支持 erase_before_upload / clean_before_upload。
soft-reset、resume exec、fs tree、device_info 采集都应通过 device_command 或白名单脚本表达。
```

### 3.6 `mpremote-file-transfer`

该 skill 对文件上传和设备文件系统管理更直接相关。

关键启示：

- `fs cp` 必须使用 `resume`，否则会先软复位，可能导致应用重启和传输状态不稳定。
- 多文件上传时，每次 `mpremote` 调用之间要有短暂停顿，释放串口。
- 设备路径必须使用 `:` 前缀，区分本地路径和设备路径。
- 目录需要显式创建，删除文件和删除空目录分别用：
  - `fs rm`
  - `fs rmdir`
- 大文件传输会花几秒，不能误判为卡死。
- 写入后如出现内容异常，可重启或调用 `os.sync()`。
- 清理设备文件系统可以用设备端 `os.remove()`/`os.listdir()` 递归执行。

对 `upy-deploy-plugin` 的建议：

```text
部署策略不应只有 upload。
至少应支持：
  upload_only
  clean_then_upload
  erase_then_upload

其中 clean/erase 的范围必须清楚：
  - 删除旧业务目录：lib/ drivers/ tasks/ log/ 或旧 main.py/boot.py/conf.py
  - clean_then_upload 默认清理项目文件
  - erase_then_upload 可清理设备端可列出的全部文件/目录，但必须 dry-run 展示待删除列表并二次确认
  - 不擦除 MicroPython 解释器固件
```

这里的“擦除后上传”应优先理解为“清理 MicroPython 文件系统中的旧项目文件后再上传”，不是重新烧录 MCU 固件。重新烧录解释器固件仍属于 `upy-flash-mpy-firmware-plugin`。

### 3.7 `mpremote-live-session`

该 skill 对部署后的输出采集很关键。

关键启示：

- 不要反复使用 `mpremote resume exec` 做长时间监控；每次 raw REPL 进入可能发送 Ctrl+C，可能打断 asyncio/aiorepl 应用。
- 多命令、长时间监听、设备运行 asyncio/aiorepl、压力测试和串口输出采集时，应使用持久会话。
- Linux/macOS 推荐 PTY 方式驱动 `mpremote connect <device> resume`。
- Windows 可用 `mpremote connect COMn resume repl` + subprocess pipe，但能力有限。
- 需要记录 `last_output_time`，用于判断设备是否停滞。

对 `upy-deploy-plugin` 的建议：

```text
deploy 阶段的 serial_capture 不应由一串 resume exec 拼出来。
应封装为 capture_repl.py 或 device_command(stream/capture)，内部按平台选择：
  - Linux/macOS: PTY
  - Windows: direct pipe / pyserial fallback

部署判定应同时依赖：
  - REPL 持久会话输出
  - 设备端 rotating log 文件
```

## 4. `upy-deploy-plugin` 的目标定位

建议定位：

```text
upy-deploy-plugin 是插件化工作流中的项目部署与运行验证阶段。
它消费 upy-generate-plugin 的 phase_complete.payload.manifest_content 和生成后的项目目录，
负责选择设备端口、上传 firmware、软复位、采集 REPL 输出、读取设备端日志、生成 deploy_result，
并以 phase_complete 输出 PASS/FAIL/partial。
```

它应该负责：

- 校验上游 `upy-generate-plugin` 的 `phase_complete`。
- 确认 `result=success` 且 `next_phase=upy-deploy-plugin`。
- 使用统一 phase 名称：`phase="upy-deploy-plugin"`，包括 `phase_complete.payload.phase` 和 `manifest_content.phase`。
- 读取 `manifest_content`、`project_root`、`firmware/`、`tools/`。
- 扫描串口/COM 口。
- 通过 `approval_request` 让用户选择端口或确认设备连接。
- 支持部署策略选择：
  - `upload_only`
  - `clean_then_upload`
  - `erase_then_upload`
- 运行项目内白名单部署脚本。
- 上传项目 firmware。
- 软复位并等待设备恢复。
- 捕获 REPL 输出。
- 读取设备端日志。
- 用本地规则生成结构化 deploy 判定。
- 输出 `phase_complete`。
- 展示部署结果选项卡，说明端口、清理策略、上传结果、软复位结果、串口输出摘要、日志初判和下一步选择。
- deploy 成功后不立即结束主链路；必须读取用户反馈，然后让用户选择：
  - 重新生成：进入 `upy-generate-plugin(mode=fix)`
  - 自动化调试：进入 `upy-autofix-plugin`
  - 结束并上传到项目库
- FAIL 时把错误上下文交给后续 `upy-autofix-plugin`；在 `upy-autofix-plugin` 未落地前，可选回到 `upy-generate-plugin(mode=fix)`。

它不应该负责：

- 重新分析用户需求。
- 重新选板卡。
- 重新烧录 MicroPython 官方固件。
- 生成业务代码。
- 修改 `firmware/` 代码。
- 做 AI 级错误修复。
- 直接覆盖 `G:\MicroPython_Skills\upy-deploy`。
- 重新烧录 MicroPython 解释器固件，除非显式跳转回 `upy-flash-mpy-firmware-plugin`。

## 5. 建议的协议化执行序列

建议 `upy-deploy-plugin` 的主流程：

```text
Step 0 读取并校验 start_phase / 上游 phase_complete
  -> status_update(deploy_input_loaded)
  phase 命名统一:
    protocol phase = "upy-deploy-plugin"
    phase_complete.payload.phase = "upy-deploy-plugin"
    manifest_content.phase = "upy-deploy-plugin"

Step 1 检查项目产物
  -> file_operation(read project-manifest.json)
  -> file_operation(list firmware/)
  -> file_operation(list tools/)
  -> status_update(project_artifacts_checked)

Step 2 扫描串口
  -> script_run(list_serial_ports.py)
  <- script_result(serial_ports.json)
  -> approval_request(deploy_port_select)

Step 3 选择部署策略
  -> approval_request(deploy_strategy_select)
     actions:
       - upload_only
       - clean_then_upload
       - erase_then_upload
       - save_partial

Step 4 可选清理/擦除设备项目文件
  如果 upload_only:
    -> 跳过
  如果 clean_then_upload:
    -> script_run(clean_device_project.py --mode project_files --dry-run --port <selected_port>)
    -> approval_request(confirm_clean_device_project)
    -> script_run(clean_device_project.py --mode project_files --execute --port <selected_port>)
  如果 erase_then_upload:
    -> script_run(clean_device_project.py --mode erase_all --dry-run --port <selected_port>)
    -> approval_request(confirm_erase_device_fs)
    -> script_run(clean_device_project.py --mode erase_all --execute --port <selected_port>)
  <- script_result(clean_result.json)

Step 5 上传 firmware
  -> status_update(upload_start)
  -> script_run(project/tools/flash_device.py --compile --upload --no-reset --port <selected_port> --json-summary)
  <- script_result(upload_result)

Step 6 软复位并等待恢复
  -> device_command(soft_reset)
  -> device_command(wait_for_resume 或 script_run(wait_for_device.py))
  <- device_result / script_result

Step 7 采集运行输出
  -> device_command(serial_repl_capture 或 script_run(capture_repl.py))
  <- device_result(serial_output)
  -> status_update(serial_capture_done)

Step 8 读取设备日志
  -> script_run(project/tools/read_device_log.py --port <selected_port> --log-dir <LOG_DIR>)
  -> script_run(project/tools/log_report.py --input)
  <- script_result(deploy_log_report.json)

Step 9 本地初判
  -> script_run(deploy_result.py 或内置白名单判定脚本)
  <- script_result(deploy_result.json)

Step 10 输出阶段结果
  PASS:
    -> approval_request(deploy_result_feedback)
       展示部署结果选项卡和烧录/上传情况说明
       actions:
         - regenerate_fix -> upy-generate-plugin(mode=fix)
         - autofix_debug -> upy-autofix-plugin
         - finish_publish_project -> 上传到项目库并结束
    -> phase_complete(result=success, next_phase=<用户选择>)
  FAIL:
    -> approval_request(deploy_fail_next_action)
       actions:
         - autofix_debug -> upy-autofix-plugin
         - regenerate_fix -> upy-generate-plugin(mode=fix)
         - save_partial
    -> phase_complete(result=failed 或 partial, next_phase=<用户选择>)
  设备未连接/用户稍后继续:
    -> phase_complete(result=partial, next_phase=null, checkpoint=...)
```

## 6. 建议目录结构

后续确认后再创建，不在本分析阶段直接创建：

```text
G:\MicroPython_Skills\upy-deploy-plugin\
  .codex-plugin\
    plugin.json
  sample\
    start_phase.upy_deploy_plugin.full.json
    approval_request.deploy_port_select.json
    phase_complete.upy_deploy_plugin.success.json
    phase_complete.upy_deploy_plugin.failed.json
    phase_complete.upy_deploy_plugin.partial_no_device.json
  scripts\
    # 优先从公共脚本目录引用 list_serial_ports.py，避免重复维护
    deploy_manifest.py
    clean_device_project.py
    wait_for_device.py
    capture_repl.py
    deploy_result.py
  test\
    mock_plugin.py
    run_local_mock_session.py
    smoke_tests.py
  SKILL.md
```

说明：

- `list_serial_ports.py`、通用 mpremote 探测/端口枚举能力应抽到公共脚本目录，`upy-flash-mpy-firmware-plugin` 和 `upy-deploy-plugin` 共同引用，避免重复维护。
- `deploy_manifest.py` 负责校验 start/upstream/state/phase_complete，不把校验逻辑散落在 SKILL.md。
- `clean_device_project.py` 负责安全清理设备端旧项目文件，必须提供 `--dry-run`、待删除文件列表、二次确认配合字段和 JSON summary。
- `capture_repl.py` 必须作为独立脚本新增，参考 `mpremote-live-session` 的平台策略实现持久输出采集。
- 项目已有 `tools/flash_device.py`、`tools/read_device_log.py`、`tools/log_report.py` 时，deploy-plugin 不应重复生成这些工具。
- `project/tools/flash_device.py` 必须新增 `--json-summary` 输出，deploy-plugin 只消费结构化结果，不解析人类日志。

## 7. 关键注意事项

### 7.1 不覆盖原始 `upy-deploy`

原始 `upy-deploy` 是现有本地直跑 skill，应该保留为参考和回退依据。

后续只能新建：

```text
G:\MicroPython_Skills\upy-deploy-plugin
```

不要在原目录直接改 `SKILL.md` 来“插件化”。

### 7.2 严格区分“固件烧录”和“项目部署”

`upy-flash-mpy-firmware-plugin` 已经负责 MicroPython 解释器固件。

`upy-deploy-plugin` 只负责生成项目的 `firmware/` 上传和运行验证。

### 7.3 真实运行不能固定 COM3

正式运行必须扫描串口并让用户确认。

固定 `COM3` 只能出现在：

- sample JSON
- mock 测试
- `--mode mock`

不能出现在 live 部署主路径。

### 7.4 所有本地动作走白名单脚本或 device_command

旧 `upy-deploy` 中大量 `mpremote` 命令不能原样搬进插件化 skill，让模型直接执行 shell。

应转换为：

- `script_run(...)`
- `device_command(...)`
- `file_operation(...)`
- `approval_request(...)`
- `status_update(...)`
- `phase_complete(...)`

### 7.5 `phase_complete` 是唯一阶段完成事实

调试日志、state 文件、deploy_result 都不能替代最终 `phase_complete`。

`phase_complete.payload.manifest_content` 必须保留完整上游 manifest，不得只写摘要。

`phase_complete.payload.phase` 和 `manifest_content.phase` 均固定为：

```text
upy-deploy-plugin
```

不要在同一链路中混用 `deploy`、`upy-deploy`、`upy-deploy-plugin`。

### 7.6 FAIL 不是直接崩溃

设备未连接、未选择端口、串口重枚举失败、日志读取失败都应结构化处理。

可恢复问题输出：

```text
result=partial
next_phase=null
checkpoint={...}
```

代码运行失败输出：

```text
result=failed
next_phase=upy-autofix-plugin
deploy_result={...}
error_context={...}
```

如果 `upy-autofix-plugin` 暂未实现，可以临时约定交给：

```text
upy-generate-plugin(mode=fix, source=user_feedback_after_deploy)
```

但这应作为迁移期策略写清楚，不能长期模糊。

### 7.7 不在 deploy 阶段改代码

`upy-deploy-plugin` 只能上传、运行、采集、判定。

它不应该修改 `firmware/`，否则会和 `upy-generate-plugin` / `upy-autofix-plugin` 的职责重叠。

### 7.8 擦除后上传必须有用户确认和保护范围

`upy-deploy-plugin` 应支持擦除/清理后再上传，但必须把含义写清楚：

```text
clean_then_upload:
  删除旧项目文件和旧业务目录，再上传新项目。

erase_then_upload:
  更激进地清理设备端项目区域，再上传新项目。
  需要用户二次确认。
```

不应默认删除：

- MicroPython 解释器固件。

`clean_then_upload` 的常规清理目标：

- `:main.py`
- `:boot.py`，仅当本项目将重新上传 boot.py 时
- `:conf.py`
- `:board.py`
- `:lib/`
- `:drivers/`
- `:tasks/`
- `:log/`，仅当用户选择清理日志
- 旧 `.mpy` 和同名旧 `.py` 文件

`erase_then_upload` 的范围更激进：清理设备端可列出的全部文件/目录后再上传，但仍不等同于重刷 MicroPython 解释器固件。它必须：

- 先运行 `clean_device_project.py --mode erase_all --dry-run`。
- 把待删除文件和目录完整展示给用户。
- 使用 `approval_request(confirm_erase_device_fs)` 二次确认。
- 执行时输出 `clean_result.json`。
- 把执行结果写入 `deploy_result.clean_result` 和 artifacts。

如果设备端存在用户数据目录、校准文件、密钥文件或日志文件，`erase_then_upload` 也可以删除，但必须在 dry-run 列表中明确展示，由用户承担确认。

### 7.9 长时间输出采集优先持久会话

`mpremote-live-session` 已说明反复 `resume exec` 会影响 asyncio/aiorepl 应用。

因此 `upy-deploy-plugin` 的运行输出采集应优先使用持久会话：

- Linux/macOS：PTY。
- Windows：`mpremote connect COMn resume repl` subprocess pipe 或 pyserial fallback。
- 记录 `last_output_time`，用于 stalled 判定。
- REPL 输出和设备端日志必须同时保留。

`resume exec` 只适合短查询，例如设备信息、空闲检测、`print(1)` 连通性探测，不适合持续监听。

### 7.10 部署完成后的用户反馈分流

`upy-deploy-plugin` 部署完成后不应直接静默结束。无论 PASS 还是 FAIL，都应展示一个结果选项卡：

```text
deploy_result_feedback / deploy_fail_next_action
```

选项卡应说明：

- 选择的串口/设备。
- 使用的部署策略：`upload_only`、`clean_then_upload` 或 `erase_then_upload`。
- 是否执行 dry-run 和清理。
- 上传脚本 `--json-summary` 结果。
- soft reset / wait_for_device 结果。
- REPL 输出摘要。
- 设备端日志报告摘要。
- 初判结果：PASS / FAIL / partial。

PASS 后用户仍然要选择下一步：

| 用户选择 | next_phase / 行为 |
| --- | --- |
| 重新生成 | `upy-generate-plugin(mode=fix, source=user_feedback_after_deploy)` |
| 自动化调试 | `upy-autofix-plugin` |
| 结束并上传项目库 | 进入项目库上传/发布流程，主链路结束 |

FAIL 后用户可以选择：

| 用户选择 | next_phase / 行为 |
| --- | --- |
| 自动化调试 | `upy-autofix-plugin` |
| 重新生成 fix | `upy-generate-plugin(mode=fix, source=deploy_fail)` |
| 稍后继续 | `partial` + checkpoint |

`upy-autofix-plugin` 未落地前，FAIL 的可用保底路径是 `upy-generate-plugin(mode=fix)`。

## 8. 已确认决策

以下原待确认项已按用户反馈确定：

| 决策点 | 已确认结论 |
| --- | --- |
| phase 名称 | 完全统一为 `phase="upy-deploy-plugin"`，包括 manifest 阶段 |
| deploy 成功后 | 主链路不直接结束，先展示部署结果选项卡并读取用户反馈 |
| PASS 后分流 | 重新生成 `upy-generate-plugin(mode=fix)`、自动化调试 `upy-autofix-plugin`、结束并上传项目库 |
| FAIL 且 autofix 未落地 | 可选回到 `upy-generate-plugin(mode=fix)` |
| 串口/通用 mpremote 脚本 | 抽到公共脚本目录，避免重复维护 |
| `flash_device.py` | 必须新增 `--json-summary` |
| 串口采集 | 新增独立 `capture_repl.py` |
| 常规清理上传 | 使用 `clean_then_upload` |
| 危险全量清理 | 使用 `erase_then_upload`，必须 dry-run 和二次确认 |
| 清理范围 | `erase_then_upload` 可覆盖全部设备文件系统可列出的文件/目录，但必须先展示待删除列表 |
| dry-run | 必须新增 `clean_device_project.py --dry-run` |

## 9. 建议的下一步

确认以上需求后，下一步可以开始新建 `G:\MicroPython_Skills\upy-deploy-plugin`，建议按以下顺序做：

1. 只创建 `SKILL.md`、`.codex-plugin/plugin.json`、`sample/`、`scripts/`、`test/` 骨架。
2. 先写 `start_phase`，明确所有 phase 字段统一为 `upy-deploy-plugin`。
3. 写 `approval_request.deploy_port_select`、`approval_request.deploy_strategy_select`、`approval_request.confirm_clean_device_project`、`approval_request.confirm_erase_device_fs` 样例。
4. 写 `approval_request.deploy_result_feedback` 和 `approval_request.deploy_fail_next_action`，覆盖 PASS/FAIL 后用户分流。
5. 抽出公共脚本目录，先迁移/复用 `list_serial_ports.py`。
6. 改造 `project/tools/flash_device.py`，新增 `--json-summary`。
7. 写 `deploy_manifest.py`，校验 start/upstream/phase_complete。
8. 写 `clean_device_project.py --dry-run --execute`，覆盖 `clean_then_upload` 和 `erase_then_upload`。
9. 写独立 `capture_repl.py`，按平台实现持久输出采集。
10. 接入 `read_device_log.py`、`log_report.py` 和 `deploy_result.py`。
11. 最后做本地 mock session，证明 no-device、clean dry-run、erase confirm、PASS feedback、FAIL fix fallback 都能跑通。

当前阶段的结论是：

```text
应该新建 upy-deploy-plugin。
不应该覆盖 upy-deploy。
upy-deploy-plugin 的核心工作是把原 upy-deploy 的本地执行动作协议化。
COM 扫描和用户确认应参考 upy-flash-mpy-firmware-plugin。
phase 名称完全统一为 upy-deploy-plugin。
擦除/清理后上传应成为明确部署策略：clean_then_upload 常规清理，erase_then_upload 全量清理且二次确认。
部署完成后必须展示结果选项卡，读取用户反馈后进入 generate fix、autofix 或上传项目库结束。
公共串口/mpremote 脚本应抽到公共目录。
flash_device.py 必须提供 --json-summary。
capture_repl.py 必须独立新增。
mpremote-device-interaction / file-transfer / live-session 可分别提供设备探测、文件清理上传、持久输出采集的设计依据。
项目部署和 MicroPython 固件烧录必须分离。
```
