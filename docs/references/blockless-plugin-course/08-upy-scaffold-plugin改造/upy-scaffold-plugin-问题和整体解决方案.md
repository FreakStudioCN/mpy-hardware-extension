# upy-scaffold-plugin 当前问题和整体解决方案

生成时间：2026-06-23

## 结论

当前 `upy-scaffold-plugin` 的核心生成能力已经基本合格：

- 能从 `phase_complete.upy_flash_mpy_firmware_plugin.json` 读取上游 manifest。
- 能把 scaffold 项目写到 `sessions/<session_id>/project`。
- 生成项目无 UTF-8 BOM。
- `.flake8` 无 BOM，且不再依赖 `firmware/board.py: E122,E128` 放行。
- `python -m flake8 --jobs=1 firmware tools` 返回 0。
- `scaffold_file_manifest.json`、`payload.file_manifest`、实际项目文件三者一致。
- `next_phase` 正确进入 `upy-generate-plugin`。

但是，当前 workflow 还不能算“完全合格的正式插件执行链路”。主要原因不是 `init_scaffold.py` 渲染能力，而是实际调用时仍在手写较长的 `python -c` finalizer 来写 `phase_complete`，导致路径转义、协议字段沉淀、权限记录等行为不稳定。

更准确的评估是：

- 作为 scaffold 渲染器：合格。
- 作为 Claude Code 本地测试 skill：基本合格，但需要统一正式执行入口。
- 作为可长期复用的插件化 workflow 阶段：接近合格，但还应补一个正式 host-side apply/finalize 脚本，替代手写 `python -c`。

## 最近 session 观察

检查目录：

`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`

当前 `upy-scaffold-plugin` 产物表现：

- `project/` 已生成，位置正确。
- `scaffold_phase_log.md` 存在，记录 full scaffold 流程。
- `phase_complete.upy_scaffold_plugin.json` 存在，`payload.result=success`。
- `payload.next_phase=upy-generate-plugin`。
- `scaffold_file_manifest.json` 存在，当前为 43 个文件。
- 实际项目文件数、`payload.file_manifest.files`、`scaffold_file_manifest.json.files` 一致。
- 项目文件 BOM 检查为 0。
- flake8 实际运行返回 0。

43 个文件不是错误。本次模块选择为：

`logger, flash_device, time_helper, maintenance`

没有选择 `log_tools`，因此只有 `tools/flash_device.py`，没有 `tools/read_device_log.py` 和 `tools/log_report.py`。如果审批文案里“部署工具”期望同时包含日志读取工具，则需要调整模块映射或审批说明；否则当前输出与模块选择一致。

## 聊天中 unicodeescape 报错的原因

报错：

```text
SyntaxError: (unicode error) 'unicodeescape' codec can't decode bytes in position 2-3: truncated \UXXXXXXXX escape
```

根因不是 scaffold 产物损坏，而是手写 `python -c` 命令时把 Windows 路径放进普通 Python 字符串，例如：

```python
"C:\Users\Administrator\..."
```

在 Python 字符串里，`\U` 会被识别成 Unicode 转义开头，Python 期望后面跟 8 位十六进制字符。Windows 路径不满足这个格式，所以报 `truncated \UXXXXXXXX escape`。

可临时规避：

```python
r"C:\Users\Administrator\..."
```

或：

```python
"C:/Users/Administrator/..."
```

但根本解决方案不是继续修补 inline 命令，而是去掉手写 `python -c` finalizer。

## 当前仍存在的问题

### 1. 手写 finalizer 不稳定

当前实际调用仍出现：

```bash
python -X utf8 -c "..."
```

它负责写 `scaffold_file_manifest.json` 和 `phase_complete.upy_scaffold_plugin.json`。这会带来几个问题：

- Windows 路径容易触发 `unicodeescape`。
- 逻辑散落在聊天临时代码里，不易复用。
- 协议字段容易和 skill 文档、测试 runner 不一致。
- 不容易稳定覆盖 cancellation/retry/timeout/idempotency。
- 不利于后续插件 host 自动调用。

结论：这是当前最需要解决的问题。

### 2. phase_complete 字段沉淀还不完全统一

当前 session 的 `phase_complete` 核心可用，但还有不够标准的地方：

- `payload.permissions` 字段较简略，缺少完整的 `root/cwd/approved/approved_at` 等结构。
- `payload.scaffold` 为空，模块信息只在 `manifest_content.scaffold` 和 `manifest_content.scaffold_modules` 中。
- `artifacts[type=file_manifest]` 只声明 `path`，没有内嵌 `files`。这不阻塞，因为完整清单在 `payload.file_manifest` 和 `scaffold_file_manifest.json` 中，但协议语义还可以更清晰。

这些不是当前运行阻塞问题，但会影响下游插件稳定读取。

### 3. log_tools 与 flash_device 的审批语义需要明确

本次审批日志写了“部署工具”，实际模块为 `flash_device`，只生成：

```text
tools/flash_device.py
```

如果希望同时生成：

```text
tools/read_device_log.py
tools/log_report.py
```

则审批项应选择或自动包含 `log_tools`。

需要明确规则：

- 方案 A：`module_flash` 只代表烧录工具 `flash_device.py`。
- 方案 B：`module_flash` 代表部署工具包，自动包含 `flash_device + log_tools`。
- 方案 C：审批卡片拆成两个选项：部署工具、日志读取工具。

建议采用方案 C，语义最清晰。

### 4. 当前 test runner 与正式脚本职责混用

现在 `test/run_local_actual_project.py` 已经比较完整，能做：

- 写项目目录。
- 跑 flake8。
- 生成 file manifest。
- 生成结构化 phase_complete。
- 记录 source/approval/permissions。

但它位于 `test/`，不适合作为正式插件执行入口。正式 workflow 不应该依赖测试目录中的脚本。

## 推荐整体解决方案

### 总体方向

新增正式 host-side 执行脚本：

```text
upy-scaffold-plugin/scripts/apply_scaffold.py
```

职责划分：

- `scripts/init_scaffold.py`：只做纯渲染，stdout 输出 scaffold JSON，不写项目目录。
- `scripts/apply_scaffold.py`：负责 host-side 实际执行，包括写文件、跑 flake8、生成 file manifest、生成 phase_complete。
- `test/run_local_actual_project.py`：改成测试包装器，调用 `scripts/apply_scaffold.py`，不再保留重复业务逻辑。

### apply_scaffold.py 应支持的输入

建议命令：

```bash
python -X utf8 scripts/apply_scaffold.py \
  --session-dir G:/test/test/sessions/<session_id> \
  --manifest G:/test/test/sessions/<session_id>/phase_complete.upy_flash_mpy_firmware_plugin.json \
  --mode async \
  --modules logger,flash_device,time_helper,maintenance \
  --write-phase-complete
```

必要参数：

- `--session-dir`
- `--manifest`
- `--mode`
- `--modules`
- `--custom-files`
- `--new-devices`
- `--force`
- `--dry-run`
- `--write-phase-complete`

### apply_scaffold.py 应负责的行为

1. 读取上游 phase_complete 或 manifest。
2. 调用 `init_scaffold.py` 生成 scaffold JSON。
3. 将 `file_operations[]` 写入 `<session_root>/project`。
4. 写入时统一 UTF-8 无 BOM。
5. 所有路径做安全校验，禁止 `..`、绝对路径、反斜杠协议路径。
6. 计算每个文件的 `sha256_before`、`sha256_after`、`bytes`。
7. 根据幂等规则标记：
   - `created`
   - `updated`
   - `unchanged`
   - `skipped`
   - `error`
8. 运行 flake8：

```bash
python -m flake8 --jobs=1 firmware tools
```

9. flake8 返回 0 才允许 `next_phase=upy-generate-plugin`。
10. 写 `scaffold_file_manifest.json`。
11. 写 `phase_complete.upy_scaffold_plugin.json`。
12. 生成结构化：
   - `payload.source`
   - `payload.approval`
   - `payload.permissions`
   - `payload.runtime_context`
   - `payload.lint`
   - `payload.file_manifest`
   - `payload.artifacts`
   - `payload.structured_errors`

### phase_complete 推荐结构

核心字段：

```json
{
  "protocol_version": "1.0",
  "type": "phase_complete",
  "phase": "upy-scaffold-plugin",
  "session_id": "<session_id>",
  "idempotency_key": "upy-scaffold-plugin:<session_id>:phase-complete:v1",
  "payload": {
    "phase": "scaffold",
    "domain_phase": "scaffold",
    "result": "success",
    "next_phase": "upy-generate-plugin",
    "source": {
      "source_phase": "upy-flash-mpy-firmware-plugin",
      "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_flash_mpy_firmware_plugin.json",
      "source_manifest_kind": "phase_complete",
      "manifest_merge_strategy": "renderer_unwrap_manifest"
    },
    "approval": {
      "approval_id": "scaffold_config",
      "confirmed": true,
      "mode": "async",
      "modules": ["logger", "flash_device", "time_helper", "maintenance"],
      "custom_files": [],
      "confirmed_at": "<utc>"
    },
    "permissions": [
      {
        "type": "file_operation",
        "root": "sessions/<session_id>/project",
        "operation": "write",
        "file_count": 43,
        "approved": true,
        "approved_at": "<utc>",
        "idempotency_key": "upy-scaffold-plugin:<session_id>:file-write:v1"
      },
      {
        "type": "script_run",
        "name": "flake8",
        "command": "python -m flake8 --jobs=1 firmware tools",
        "cwd": "sessions/<session_id>/project",
        "approved": true,
        "approved_at": "<utc>",
        "idempotency_key": "upy-scaffold-plugin:<session_id>:script:flake8:v1"
      }
    ]
  }
}
```

### 路径规范

正式 payload 中尽量避免本机绝对路径。

允许：

```text
sessions/<session_id>/project
sessions/<session_id>/scaffold_file_manifest.json
upy-flash-mpy-firmware-plugin/sample/xxx.json
```

不建议写入 formal payload：

```text
G:/test/test/...
C:/Users/Administrator/...
C:\Users\Administrator\...
```

例外：调试日志可以出现本机路径，但 formal JSON 的 `artifacts`、`warnings`、`source`、`permissions` 应尽量使用 artifact-relative 或 repo-relative 路径。

## 最小修改顺序

### 第一步：新增 scripts/apply_scaffold.py

从 `test/run_local_actual_project.py` 迁移核心逻辑，作为正式入口。

保留现有能力：

- `--session-dir`
- `--manifest`
- `--mode`
- `--modules`
- `--custom-files`
- `--new-devices`
- `--force`
- `--dry-run`
- `--write-phase-complete`

### 第二步：让 test runner 调用正式脚本

`test/run_local_actual_project.py` 可以变成 thin wrapper，或者 smoke tests 直接调用 `scripts/apply_scaffold.py`。

目标：避免测试脚本和正式脚本各维护一套写文件/finalize 逻辑。

### 第三步：更新 SKILL.md

把本地实际测试和 Claude Code 调用流程改成：

```bash
python -X utf8 <resource_root>/upy-scaffold-plugin/scripts/apply_scaffold.py ...
```

并明确禁止用长 inline `python -c` 拼 final phase_complete。

### 第四步：补 smoke tests

测试必须覆盖：

- `apply_scaffold.py --write-phase-complete` 成功。
- 项目写到 `<session_root>/project`。
- 无 BOM。
- flake8 返回 0。
- `payload.source` 完整。
- `payload.approval` 完整。
- `payload.permissions` 完整。
- `permissions.root/cwd` 是 artifact-relative。
- formal payload 不出现 `C:/`、`G:/` 或 `C:\`、`G:\`。
- 第二次运行相同输入时文件状态为 `unchanged`。
- 文件冲突时输出 `result=partial`、`next_phase=null`、`structured_errors[].code=FILE_CONFLICT`。

## 是否必须现在修改

建议分级：

### 必须改

1. 新增正式 `scripts/apply_scaffold.py`，替代手写 `python -c` finalizer。
2. `SKILL.md` 改成调用 `apply_scaffold.py`。
3. 测试覆盖 `apply_scaffold.py` 的 phase_complete 输出。

原因：这是解决 unicodeescape、协议字段不一致、本地测试和插件调用不一致的根问题。

### 建议改

1. `payload.scaffold` 补一份摘要。
2. `artifacts[type=file_manifest]` 明确是外部引用，或同步带 `files`。
3. 审批项拆清楚 `flash_device` 与 `log_tools`。

### 可暂缓

1. templates 业务代码继续保持简单，由 `upy-generate-plugin` 填充。
2. `tools/flash_device.py`、`read_device_log.py` 暂不扩展，等 deploy/generate 阶段再联动。
3. 更完整的 cancellation/timeout 协议可以在 apply 脚本稳定后再补。

## 当前 skill 是否合格

### 合格部分

当前 skill 在以下方面合格：

- scaffold 渲染能力合格。
- session/project 输出路径合格。
- BOM 问题已解决。
- flake8 gate 合格。
- MicroPython-aware flake8 配置合格。
- `next_phase=upy-generate-plugin` 合格。
- file manifest 基本合格。
- 上游 `firmware_flash` 事实保留合格。

### 未完全合格部分

作为完整插件化 workflow 阶段，还差一个正式 apply/finalize 入口。只要实际调用仍然手写 `python -c`，就会继续出现：

- Windows path escaping 错误。
- phase_complete 字段不一致。
- 权限记录不完整。
- 本地测试与插件调用不完全一致。

### 最终评估

当前 `upy-scaffold-plugin` 可以认为是“核心功能合格、正式链路待收敛”。

如果新增 `scripts/apply_scaffold.py` 并让 `SKILL.md` 和测试统一使用它，则可以升级为“插件化 scaffold 阶段合格”。