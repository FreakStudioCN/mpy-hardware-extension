# upy-scaffold-plugin payload.scaffold 缺失分析

生成时间：2026-06-23

## 问题

当前 `phase_complete.upy_scaffold_plugin.json` 中：

```json
{
  "payload": {
    "scaffold": null
  }
}
```

或者说 `payload.scaffold` 字段不存在/为空。

但当前 `manifest_content` 中已经有：

```json
{
  "manifest_content": {
    "scaffold": {
      "mode": "async",
      "modules": ["flash_device", "logger", "maintenance", "time_helper"],
      "custom_files": []
    },
    "scaffold_modules": ["flash_device", "logger", "maintenance", "time_helper"],
    "scaffold_mode": "async"
  }
}
```

## payload.scaffold 应该是什么

`payload.scaffold` 不是项目运行所必需的代码文件，也不是硬件 manifest 的唯一来源。它更像是“scaffold 阶段自身的结构化结果摘要”。

一个完整的阶段完成消息通常可以理解为：

```json
{
  "type": "phase_complete",
  "phase": "upy-scaffold-plugin",
  "payload": {
    "result": "success",
    "next_phase": "upy-generate-plugin",
    "manifest_content": {},
    "file_manifest": {},
    "approval": {},
    "permissions": [],
    "scaffold": {}
  }
}
```

字段职责：

- `manifest_content`：项目级状态，给后续 skill 继续使用。
- `file_manifest`：本阶段实际写入了哪些文件。
- `approval`：用户当时批准了什么配置。
- `permissions`：本阶段做过哪些文件/脚本操作授权。
- `payload.scaffold`：本阶段 scaffold 自己的摘要，方便下游或 UI 直接读取。

建议的 `payload.scaffold` 形态：

```json
{
  "scaffold": {
    "mode": "async",
    "modules": ["logger", "flash_device", "time_helper", "maintenance"],
    "custom_files": [],
    "project_root": "sessions/<session_id>/project",
    "file_count": 43
  }
}
```

其中最核心的是：

- `mode`
- `modules`
- `custom_files`

`project_root` 和 `file_count` 属于增强摘要，不是必须。

## 缺失的是什么信息

缺失的是阶段级摘要，而不是事实来源本身。

具体包括：

1. 本次 scaffold 使用的调度模式

例如：

```json
"mode": "async"
```

这表示 `firmware/main.py` 是按 `uasyncio` 框架生成的，而不是 timer 或 thread 框架。

2. 本次注入的模块

例如：

```json
"modules": ["logger", "flash_device", "time_helper", "maintenance"]
```

这表示 scaffold 阶段已经写入日志模块、烧录工具、时间工具、维护任务等基础结构。

3. 自定义文件

例如：

```json
"custom_files": []
```

如果用户请求了额外文件，应该能在这里直接看到。

4. 可选的执行摘要

例如：

```json
"project_root": "sessions/<session_id>/project",
"file_count": 43
```

这些不是必需，但对 UI、调试和下游检查有帮助。

## 会影响什么

### 1. 对核心运行流程的影响

当前不阻塞。

因为 `manifest_content.scaffold`、`manifest_content.scaffold_modules` 和 `project/project-manifest.json` 已经能提供核心信息。

只要下游 `upy-generate-plugin` 按这些字段读取，就可以继续工作。

### 2. 对下游插件读取的影响

如果下游插件严格读取：

```json
payload.scaffold.mode
payload.scaffold.modules
```

那么当前会读不到。

可能影响：

- `upy-generate-plugin` 判断应该生成 async、timer 还是 thread 风格业务代码。
- 下游判断哪些基础模块已经存在。
- 下游判断是否可复用 `logger`、`time_helper`、`maintenance`。
- 下游判断是否需要创建缺失目录或补文件。

但如果下游读取 `manifest_content.scaffold`，则不受影响。

### 3. 对 UI 展示的影响

UI 如果想直接展示阶段摘要，例如：

```text
Scaffold: async mode, modules: logger, flash_device, time_helper, maintenance
```

读取 `payload.scaffold` 会更直接。

如果没有这个字段，UI 需要从 `manifest_content.scaffold`、`approval`、`file_manifest` 多处拼接。

### 4. 对调试和日志分析的影响

没有 `payload.scaffold` 时，分析阶段结果要绕路：

- 从 `manifest_content.scaffold` 看最终项目状态。
- 从 `approval` 看用户选择。
- 从 `file_manifest` 看实际写入结果。

这不是不能用，但协议可读性较差。

### 5. 对 resume/retry/checkpoint 的影响

严格来说，resume/retry 最关键的是：

- `idempotency_key`
- `file_manifest`
- `runtime_context`
- `structured_errors`
- `permissions`

`payload.scaffold` 不是恢复机制的必要字段。

但有它可以更快判断“本次 scaffold 配置是否和上次一致”。

例如：

```json
"scaffold": {
  "mode": "async",
  "modules": ["logger", "flash_device"]
}
```

可以辅助判断是否需要重新生成或是否存在配置漂移。

## 当前有没有其他文件或字段可以替代

有。当前有多个替代来源。

### 1. payload.manifest_content.scaffold

这是最重要的替代来源。

当前已有类似结构：

```json
{
  "manifest_content": {
    "scaffold": {
      "mode": "async",
      "modules": ["flash_device", "logger", "maintenance", "time_helper"],
      "custom_files": []
    }
  }
}
```

它表示项目级最终状态，后续 `upy-generate-plugin` 可以直接读它。

优点：

- 结构清晰。
- 表示最终写入项目 manifest 的状态。
- 会同步写入 `project-manifest.json`。

缺点：

- 它属于项目 manifest，不是阶段 payload 的直接摘要。
- 下游如果只看 `payload.scaffold` 会读不到。

### 2. payload.manifest_content.scaffold_modules

当前也有：

```json
"scaffold_modules": ["flash_device", "logger", "maintenance", "time_helper"]
```

优点：

- 读取模块列表方便。

缺点：

- 只能表示模块列表。
- 不包含 `mode`、`custom_files` 等完整配置。

### 3. payload.manifest_content.scaffold_mode

当前也有：

```json
"scaffold_mode": "async"
```

优点：

- 读取调度模式方便。

缺点：

- 只能表示 mode。
- 需要和 `scaffold_modules` 拼起来才能还原完整配置。

### 4. project/project-manifest.json

这是 `manifest_content` 的落盘版本。

位置：

```text
sessions/<session_id>/project/project-manifest.json
```

它可以作为后续项目级事实来源。

优点：

- 项目目录内自包含。
- 后续本地脚本、生成阶段、部署阶段都可以读取。

缺点：

- 下游需要读项目文件，而不是只读 phase_complete。
- 如果只分析阶段消息，不够直接。

### 5. payload.approval

当前 `payload.approval` 记录了用户选择，例如：

```json
{
  "approval_id": "scaffold_config",
  "confirmed": true,
  "mode": "async",
  "modules": "logger,flash_device,time_helper,maintenance",
  "custom_files": "[]",
  "source": "apply_scaffold.py"
}
```

优点：

- 可以追溯用户批准了什么。
- 对审计有用。

缺点：

- 它表示“输入/审批结果”，不是“最终实际生成结果”。
- 如果执行脚本做了默认补齐、模块排序、模块规范化或冲突处理，`approval` 不一定等于最终状态。

### 6. payload.file_manifest

它能说明实际写入了哪些文件。

例如可以通过文件清单推断：

- 有 `firmware/tasks/maintenance.py`，说明 maintenance 被注入。
- 有 `tools/flash_device.py`，说明 flash_device 被注入。
- 有 `firmware/lib/time_helper.py`，说明 time_helper 被注入。

优点：

- 反映实际写入结果。

缺点：

- 需要从文件路径反推模块，比较间接。
- 不适合表达调度模式和用户配置。

### 7. scaffold_phase_log.md

人可以读日志了解本次选择。

优点：

- 对人工排查友好。

缺点：

- 不适合机器稳定读取。
- 文本格式可能变化。

## 当前是否够用

当前够用，但不是最清晰。

如果 `upy-generate-plugin` 读取的是：

```json
payload.manifest_content.scaffold
```

或：

```json
project/project-manifest.json
```

那么当前不会阻塞。

如果 `upy-generate-plugin` 或宿主 UI 读取的是：

```json
payload.scaffold
```

那么当前会缺字段。

因此：

- 当前流程：可继续。
- 协议完整性：建议补。
- 修改优先级：中等，不如 `apply_scaffold.py` 和 flake8/BOM 这些问题紧急。

## 建议修改

最小修改是在 `scripts/apply_scaffold.py` 构造 `phase_complete.payload` 时加入：

```python
"scaffold": deepcopy(output["manifest_content"].get("scaffold", {})),
```

或更稳一点：

```python
scaffold_summary = deepcopy(output["manifest_content"].get("scaffold", {}))
scaffold_summary.setdefault("mode", args.mode)
scaffold_summary.setdefault("modules", args.modules)
scaffold_summary.setdefault("custom_files", args.custom_files)
scaffold_summary["project_root"] = project_artifact_path
scaffold_summary["file_count"] = len(file_manifest["files"])
```

然后放入：

```python
payload = {
    ...,
    "scaffold": scaffold_summary,
    ...
}
```

推荐输出：

```json
{
  "payload": {
    "scaffold": {
      "mode": "async",
      "modules": ["flash_device", "logger", "maintenance", "time_helper"],
      "custom_files": [],
      "project_root": "sessions/<session_id>/project",
      "file_count": 43
    }
  }
}
```

## 是否必须现在改

不是必须，但建议改。

理由：

- 当前已有 `manifest_content.scaffold` 和 `project-manifest.json` 可替代。
- 不会阻塞 `upy-generate-plugin`，前提是下游读取 manifest_content。
- 但补上 `payload.scaffold` 改动很小，能提升协议可读性和下游兼容性。

## 最终结论

`payload.scaffold` 缺失的是“阶段级 scaffold 摘要”，不是项目事实本身。

当前可以通过以下字段替代：

- `payload.manifest_content.scaffold`
- `payload.manifest_content.scaffold_modules`
- `payload.manifest_content.scaffold_mode`
- `project/project-manifest.json`
- `payload.approval`
- `payload.file_manifest`

其中最推荐的替代来源是：

```json
payload.manifest_content.scaffold
```

但为了让协议更清晰、更利于下游直接读取，建议后续在 `payload` 中补充：

```json
payload.scaffold
```