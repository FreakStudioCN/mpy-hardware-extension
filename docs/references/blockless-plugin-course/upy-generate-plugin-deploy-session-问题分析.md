# upy-generate-plugin 与 deploy session 问题分析

分析时间：2026-06-25  
分析范围：只读分析，不修改代码或 session 文件。

## 相关目录

- 用户指定目录：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`
- 该目录实际只有部署日志：`upy-deploy-plugin_deploy_log.md`
- 日志中真实部署来源 session：`G:\test\test\sessions\9b41c640-99c4-49c8-b267-e0f3ec8ffc89`
- 用户提到的 `session_operations_log.md` 在 `022ad742-3269-42e9-ac20-c14f477ecdf2` 下不存在。

## 现象摘要

部署日志显示：

1. `upy_generate_plugin` 的上游 `phase_complete` 首次校验失败，原因是 `payload.next_phase` 为 `null`，deploy 校验要求 `upy-deploy-plugin`。
2. 后续人工把 `next_phase` 从 `null` 改成 `upy-deploy-plugin` 后，deploy 校验通过。
3. 项目上传首次失败，原因是 `mpremote fs mkdir` 不递归创建父目录。
4. `tools/read_device_log.py` 在 Windows 下出现 GBK 解码错误。
5. `capture_repl.py` 采集为空，`deploy_result.py` 因 `serial_no_output` 判定 FAIL。
6. 设备实际日志显示启动成功、驱动初始化成功、`log_report.error_count=0`。
7. 最终 deploy 被人工判定为 success/checkpoint。

## 初步归因

这不是单一插件问题，至少涉及三层：

- `upy-generate-plugin`：主链路 `next_phase` 输出/校验策略存在问题。
- `upy-scaffold-plugin`：生成的项目工具 `flash_device.py`、`read_device_log.py` 模板能力不足。
- `upy-deploy-plugin`：deploy 结果判定和用户反馈路由需要更稳健。

## P0 必改项

### 1. upy-generate-plugin：成功且 deploy-ready 时不能默认 `next_phase=null`

日志记录原始 `phase_complete.upy_generate_plugin.json` 的 `payload.next_phase` 是 `null`，后续被手动修改为 `upy-deploy-plugin`。

当前仓库中的 `check_phase_complete_consistency.py` 对 success 结果允许：

```text
next_phase in ("upy-deploy-plugin", "upy-simulate-plugin", None)
```

这会导致 generate 成功但主链路中断，deploy 插件需要人工修补。

建议：

- full 生成成功、无 deploy blocker、用户未明确选择“只生成/停止”时，必须输出：

```json
"next_phase": "upy-deploy-plugin"
```

- 如果用户明确选择停止，则允许：

```json
"next_phase": null
```

但必须记录类似：

```json
"next_phase_decision": {
  "value": null,
  "reason": "user_selected_stop_after_generate"
}
```

- `check_phase_complete_consistency.py` 应区分“用户明确停止”和“插件漏写 next_phase”。

### 2. upy-scaffold-plugin：`flash_device.py` 必须递归创建设备目录

session 中首次上传失败：

```text
mpremote: cp: drivers/max98357a_driver/mock.mpy: No such file or directory.
```

根因是设备端不存在 `drivers/` 父目录，而模板只尝试创建最终目录。

建议：

- 在 `upy-scaffold-plugin/templates/pc/flash_device.py` 中增加递归目录创建逻辑，例如：

```text
ensure_remote_dirs("drivers/max98357a_driver")
mkdir :drivers
mkdir :drivers/max98357a_driver
```

- 对已存在目录的错误应忽略。
- 上传命令应使用：

```text
mpremote connect <port> resume fs cp ...
```

避免文件传输前隐式 soft reset。

### 3. upy-scaffold-plugin：`read_device_log.py` 固定 UTF-8 解码

session 中：

```text
UnicodeDecodeError: 'gbk' codec can't decode byte ...
```

Windows 下 `subprocess.run(..., text=True)` 默认使用本地编码，容易因设备日志中的 UTF-8 或二进制字节崩溃。

建议：

- 模板 `_mpremote()` 统一使用：

```python
encoding="utf-8"
errors="replace"
```

- 下载日志时也应使用 bytes 或明确编码，不依赖系统默认 GBK。

### 4. upy-deploy-plugin：`serial_no_output` 不应直接判 FAIL

当前 `deploy_result.py` 把 REPL 采集为空作为 error：

```text
serial_no_output
```

但本 session 中：

- 上传成功。
- wait/probe 成功。
- 设备日志存在。
- `log_report.error_count=0`。
- 设备日志显示 main 和 driver 初始化成功。

因此“REPL 空输出”更适合是 warning，而不是直接 FAIL。

建议：

- 如果 serial 捕获为空，但 `log_report.error_count == 0` 且 upload/clean 成功，则输出：

```text
PASS_WITH_WARNINGS
```

或：

```text
NEEDS_USER_CONFIRMATION
```

- 只有出现 traceback、panic、MemoryError、日志 error_count > 0、upload failed、clean failed 时才硬 FAIL。

## P1 应改项

### 5. upy-deploy-plugin：结果选项卡必须收集用户反馈

deploy 完成后不应只给 PASS/FAIL 按钮，还应收集用户输入，例如：

- 设备实际现象。
- mpremote 连接后看到的输出。
- 串口/REPL 报错。
- 用户手动观察到的问题。
- 设备日志摘要。

然后根据选择路由：

```text
重新生成 fix -> upy-generate-plugin(mode=fix)
自动化调试 -> upy-autofix-plugin
结束 -> 项目库上传或 checkpoint
```

### 6. deploy FAIL 或用户反馈进入 generate fix 时，必须携带 error_context

`upy-generate-plugin` 的 fix 模式已经支持 `error_context`，所以 deploy 插件应把反馈和日志传进去。

建议 payload：

```json
{
  "mode": "fix",
  "source": "user_feedback_after_deploy",
  "error_context": {
    "user_feedback": "<用户输入>",
    "deploy_result_path": "sessions/<session_id>/phase_complete.upy_deploy_plugin.json",
    "serial_excerpt": "<REPL/串口摘要>",
    "device_log_excerpt": "<设备日志摘要>",
    "deploy_errors": [],
    "previous_generate_commit": "<commit>"
  }
}
```

这样 `upy-generate-plugin` 可以基于部署后的真实反馈做最小修复。

### 7. upy-deploy-plugin：`mpremote_runtime.py` CLI 语义要明确

日志里出现了：

```text
python .../mpremote_runtime.py -- connect COM88 fs mkdir :lib
```

当前 `mpremote_runtime.py` 只支持 `--check`，不是 passthrough CLI，所以报错是预期的，但体验差。

建议二选一：

1. 新增稳定 passthrough：

```text
mpremote_runtime.py --run --port COM88 -- resume fs mkdir :lib
```

2. 或文档中明确它只作为内部 adapter，不允许直接代替 `mpremote` 使用。

更推荐新增 `--run`，便于调试和日志复现。

### 8. upy-generate-plugin：deploy-ready gate 应检查项目工具兼容性

如果 `next_phase=upy-deploy-plugin`，generate 阶段应确认项目工具已经满足 deploy 插件需求：

- `tools/flash_device.py` 支持 `--json-summary`。
- `tools/flash_device.py` 能递归创建设备目录。
- `tools/flash_device.py` 上传使用 `resume fs cp`。
- `tools/read_device_log.py` UTF-8 safe。

如果项目来自旧 scaffold 模板，不满足上述条件，则不应直接 deploy-ready success。

可选结果：

```json
{
  "result": "partial",
  "next_phase": null,
  "structured_errors": [
    {
      "code": "DEPLOY_TOOL_INCOMPATIBLE",
      "message": "tools/flash_device.py lacks --json-summary or recursive mkdir support"
    }
  ]
}
```

或者在 generate 阶段修复项目工具后再进入 deploy。

## P2 可改项

### 9. capture_repl.py 空输出需要细分状态

空输出至少有三种可能：

1. 采集器失败。
2. 设备应用没有 stdout。
3. 应用只写 rotating file logger。

建议 deploy 结果中区分：

```text
serial_capture_failed
serial_no_stdout
app_logs_file_only
```

不要把所有空输出都等同于设备失败。

### 10. upy-generate-plugin fix 文档再收紧

当前 fix 模式已支持 `error_context`，但建议明确 deploy 插件传来的字段优先级：

1. `deploy_result.errors[]`
2. `device_log_excerpt`
3. `serial_excerpt`
4. `user_feedback`
5. `previous_generate_commit`

并说明烧录/串口/上传失败不应进入 generate fix，除非用户反馈明确指向业务代码或驱动调用问题。

## 对当前 session 的判断

从 `9b41c640-99c4-49c8-b267-e0f3ec8ffc89` 看：

- 生成的业务代码总体能运行。
- `main.py` 和 task 中有 `print()` 与 logger 输出。
- 设备日志显示初始化成功。
- 真正阻断自动 deploy 的主要不是业务代码，而是工具链和判定逻辑。

因此不要把本次问题简单归咎为“generate 生成代码坏了”。更准确的结论是：

```text
generate 主链路 next_phase 有契约风险；
scaffold 生成的 deploy 工具不满足新 deploy-plugin 稳定接口；
deploy-plugin 的结果判定和反馈路由还不够稳健。
```

## 建议修改顺序

1. 修 `upy-scaffold-plugin/templates/pc/flash_device.py`：
   - 递归 mkdir。
   - `resume fs cp`。
   - `--json-summary` 稳定输出。

2. 修 `upy-scaffold-plugin/templates/pc/read_device_log.py`：
   - UTF-8 + errors replace。

3. 修 `upy-deploy-plugin/scripts/deploy_result.py`：
   - `serial_no_output` 降级为 warning。
   - 引入 `PASS_WITH_WARNINGS` 或 `NEEDS_USER_CONFIRMATION`。

4. 修 `upy-deploy-plugin` 结果反馈协议：
   - PASS/FAIL 后收集用户反馈文本。
   - 进入 `upy-generate-plugin(mode=fix)` 时传完整 `error_context`。

5. 修 `upy-generate-plugin`：
   - 成功 deploy-ready 默认 `next_phase=upy-deploy-plugin`。
   - `next_phase=null` 必须有明确用户选择或 blocker。
   - 增加 deploy 工具兼容 gate。

6. 可选修 `mpremote_runtime.py`：
   - 增加 `--run` passthrough，方便人工调试和日志复现。

