# upy-select-hw runtime context 修改分析计划

## 背景

本次问题集中在两类协议边界：

1. 时间字段不应由 LLM 手写或复制样例值，尤其是 `timestamp`、`confirmed_at`、`created_at`、`updated_at`。
2. artifact 路径不应绑定某台机器上的绝对目录，也不应由 skill 自己猜根目录；应由 Claude Code / 插件运行时传入当前工作目录和 session 目录口径。

本轮不处理固件 latest version，也不再增加复杂 pin 细分规则。

## 一、公共协议工具

### 1. 新增文件

`G:\MicroPython_Skills\upy-project-gen-toolchain-spec\scripts\workflow_time.py`

用途：统一给所有 workflow / skill 获取 UTC 时间，避免 LLM 手写 `07:00:00Z`、`00:00:00Z` 这类占位时间。

建议功能：

```powershell
python upy-project-gen-toolchain-spec/scripts/workflow_time.py
python upy-project-gen-toolchain-spec/scripts/workflow_time.py --json
python upy-project-gen-toolchain-spec/scripts/workflow_time.py --validate 2026-06-21T14:49:00Z
```

输出：

- 默认：`2026-06-21T14:49:00Z`
- `--json`：`{"utc":"2026-06-21T14:49:00Z"}`
- `--validate`：校验输入是否为合法 UTC ISO 时间

### 2. 可选更新协议文档

文件：

`G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\02-protocol.md`

增加原则：

- `timestamp`、`confirmed_at`、`created_at`、`updated_at` 必须来自运行时统一时间源或 `workflow_time.py`。
- 不允许手写日期零点、样例占位时间或旧 session 时间。

## 二、select-hw skill 修改

### 1. 修改 SKILL.md

文件：

`G:\MicroPython_Skills\upy-select-hw-plugin\SKILL.md`

需要改三处。

#### 时间规则

明确：

- `timestamp`、`confirmed_at`、`updated_at` 必须来自 Claude Code / 插件运行时，或统一脚本 `upy-project-gen-toolchain-spec/scripts/workflow_time.py`。
- 不能手写占位时间。
- `confirmed_at` 必须先写回 `select_hw_draft.json`，再生成 `select_hw_validated.json` 和 `phase_complete.select_hw.json`。
- `select_hw_draft.json` 应作为生成 validated / phase_complete 的单一事实源。

#### artifact root 规则

不能固定为 `G:\test\test` 或任何绝对路径。

运行时必须传入：

```json
{
  "runtime_context": {
    "artifact_root": ".",
    "artifact_root_mode": "cwd",
    "session_root": "sessions/<session_id>",
    "resource_root": "<runtime-provided>"
  }
}
```

含义：

- `artifact_root` 默认是 Claude Code 当前工作目录。
- `artifact_root_mode=cwd` 时，`file_list.files[].path` 必须相对当前工作目录，例如 `sessions/<session_id>/select_hw_draft.json`。
- `artifact_root_mode=session_root` 时，才允许裸文件名，例如 `select_hw_draft.json`。
- 同一个 `phase_complete` 内不能混用两种路径口径。

#### 日志模板规则

`pin_assignment_log.md` 不应使用“未用(空闲)”这种容易误导的名称。

建议改成：

- `已用 GPIO`
- `未用 GPIO`
- `条件/保留 GPIO`
- `禁止 GPIO`

## 三、select_hw_manifest.py 修改

文件：

`G:\MicroPython_Skills\upy-select-hw-plugin\scripts\select_hw_manifest.py`

建议修改：

1. 保留现有 `confirmed_at` 校验。
2. 新增 `runtime_context` 校验：
   - `payload.runtime_context.artifact_root_mode` 枚举：`cwd`、`session_root`
   - `payload.runtime_context.session_root` 必填
   - `payload.runtime_context.artifact_root` 必填，默认可为 `.`
3. 根据 `artifact_root_mode` 校验 artifact path：
   - `cwd`：要求 `sessions/<session_id>/xxx`
   - `session_root`：允许 `xxx`
4. 校验 `file_list.files[].path` 不允许绝对路径、不允许 `..`。
5. 如果 `phase_complete.manifest_content` 与 `select_hw_validated.json` 比较通过，但 `select_hw_draft.json` 中 `pin_review.confirmed_at` 是旧值，应能通过额外检查发现。

## 四、测试 runner 修改

文件：

`G:\MicroPython_Skills\upy-select-hw-plugin\test\select_hw_runner.py`

建议修改：

1. 不再直接用本文件里的 `utc_now()` 模拟正式行为。
2. 新增 `workflow_time()`，调用公共脚本：

```text
upy-project-gen-toolchain-spec/scripts/workflow_time.py
```

3. `phase_complete.payload` 增加 `runtime_context`。
4. `file_list_artifact()` 根据 `artifact_root_mode` 生成路径。
5. 默认模拟：

```json
{
  "artifact_root": ".",
  "artifact_root_mode": "cwd",
  "session_root": "sessions/<session_id>",
  "resource_root": "<runtime-provided>"
}
```

6. 默认 file_list path 使用：

```text
sessions/<session_id>/select_hw_draft.json
sessions/<session_id>/select_hw_validated.json
sessions/<session_id>/phase_complete.select_hw.json
sessions/<session_id>/pin_assignment_log.md
sessions/<session_id>/select_hw_phase_log.md
```

## 五、mock plugin 修改

文件：

`G:\MicroPython_Skills\upy-select-hw-plugin\test\mock_plugin.py`

建议修改：

1. 校验 `payload.runtime_context.artifact_root_mode`。
2. 不再只找裸文件名。
3. 优先校验：

```text
sessions/<session_id>/pin_assignment_log.md
sessions/<session_id>/select_hw_phase_log.md
```

4. 如果 `artifact_root_mode=session_root`，才接受裸文件名。

## 六、smoke tests 修改

文件：

`G:\MicroPython_Skills\upy-select-hw-plugin\test\smoke_tests.py`

新增或调整测试：

1. `runtime_context` 缺失应失败。
2. `artifact_root_mode=cwd` 时裸文件名应失败。
3. `artifact_root_mode=cwd` 时 `sessions/<session_id>/xxx` 应通过。
4. `artifact_root_mode=session_root` 时裸文件名可通过。
5. `confirmed_at` 旧占位时间仍然失败。
6. `SKILL.md` 必须包含：
   - `workflow_time.py`
   - `runtime_context`
   - `artifact_root_mode`
   - `artifact_root_mode=cwd`
   - `artifact_root_mode=session_root`

## 七、sample 文件修改

需要修改：

- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\phase_complete.select_hw.success.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\phase_complete.select_hw.partial.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\start_phase.select_hw.json`
- 可能同步修改 `select_hw_draft.json` 和 `select_hw_manifest.after.json` 中的时间字段

`phase_complete.payload` 增加：

```json
"runtime_context": {
  "artifact_root": ".",
  "artifact_root_mode": "cwd",
  "session_root": "sessions/022ad742-3269-42e9-ac20-c14f477ecdf2",
  "resource_root": "<runtime-provided>"
}
```

file_list path 改为：

```text
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/select_hw_draft.json
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/select_hw_validated.json
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/phase_complete.select_hw.json
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/pin_assignment_log.md
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/select_hw_phase_log.md
```

## 八、sample 日志修改

需要修改：

- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\pin_assignment_log.md`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\select_hw_phase_log.md`

目标：

- 不写“未用(空闲)”
- 改为“未用 GPIO”
- 单独列出“条件/保留 GPIO”
- 单独列出“禁止 GPIO”

## 不修改范围

本轮不处理：

- 固件 latest version
- 更复杂的 pin 细分规则
- 任何固定绝对路径，例如 `G:\test\test`
- 把 skill/resource 复制进 artifact workspace 的行为

## 推荐执行顺序

1. 新增 `workflow_time.py`。
2. 更新 `SKILL.md`。
3. 更新 `select_hw_manifest.py` runtime_context 和 artifact path 校验。
4. 更新 sample JSON / sample 日志。
5. 更新 `select_hw_runner.py`、`mock_plugin.py`。
6. 更新 `smoke_tests.py`。
7. 跑本地 smoke tests 和 quick_validate。
8. 同步到 `C:\Users\Administrator\.claude\skills` 后再跑 `.claude` 副本测试。
