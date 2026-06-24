# upy-scaffold-plugin phase_complete 标准输出问题解释

生成时间：2026-06-23

## 一句话结论

当前 session 里的项目代码本身没有明显问题：

- `project/` 已生成。
- 文件清单和实际文件一致。
- 无 UTF-8 BOM。
- `.flake8` 可读。
- `python -m flake8 --jobs=1 firmware tools` 返回 0。

但是 `phase_complete.upy_scaffold_plugin.json` 的结构不是新版 `scripts/apply_scaffold.py --write-phase-complete` 直接生成的标准结构。

也就是说：

- scaffold 产物文件基本合格。
- 阶段完成消息 `phase_complete` 的协议形态还不完全合格。

这类问题不会直接导致当前 `project/` 代码不能运行，但可能影响后续 `upy-generate-plugin`、宿主 UI、恢复/重试、权限审计、阶段链路追踪等流程。

## 基础知识：phase_complete 是什么

插件化工作流通常不是只生成文件，还要输出一个阶段完成消息。

这个消息一般叫：

```text
phase_complete.<phase_name>.json
```

在这里就是：

```text
phase_complete.upy_scaffold_plugin.json
```

它的作用是告诉宿主和下游插件：

- 本阶段是否成功。
- 下一阶段是谁。
- 本阶段用了什么输入。
- 本阶段写了哪些文件。
- 本阶段经过了哪些审批。
- 本阶段执行了哪些脚本。
- 如果失败，错误是什么。
- 如果要恢复/重试，应该从哪里继续。

所以 `phase_complete` 不是普通日志，而是插件之间传递状态的结构化协议。

## 基础知识：envelope 和 payload

一个标准阶段完成消息通常分两层。

### 1. Envelope 外层

外层是消息元信息，例如：

```json
{
  "protocol_version": "1.0",
  "type": "phase_complete",
  "phase": "upy-scaffold-plugin",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "timestamp": "...",
  "idempotency_key": "...",
  "payload": {}
}
```

外层回答的是：

- 这是什么消息？
- 属于哪个 session？
- 属于哪个 phase？
- 是否有幂等键？

### 2. Payload 内层

`payload` 是阶段业务结果，例如：

```json
{
  "payload": {
    "result": "success",
    "next_phase": "upy-generate-plugin",
    "source": {},
    "scaffold": {},
    "file_manifest": {},
    "approval": {},
    "permissions": [],
    "runtime_context": {},
    "lint": {},
    "artifacts": []
  }
}
```

`payload` 回答的是：

- 本阶段到底做了什么？
- 产物在哪里？
- 下游应该读什么？
- 宿主应该怎么恢复和审计？

当前问题主要发生在 `payload` 这一层。

## 当前项目文件为什么算没问题

检查当前 session：

```text
G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2
```

项目目录：

```text
sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/project
```

检查结果：

- 实际项目文件数：45。
- `payload.file_manifest.files` 文件数：45。
- `scaffold_file_manifest.json.files` 文件数：45。
- 三者路径集合一致。
- 项目无 BOM。
- flake8 返回 0。
- `project/project-manifest.json` 保留了 scaffold 和 firmware_flash 信息。

这说明 scaffold 写项目目录这一步是成功的。

## 当前 phase_complete 为什么说“不像新版正式脚本输出”

新版正式脚本是：

```text
C:/Users/Administrator/.claude/skills/upy-scaffold-plugin/scripts/apply_scaffold.py
```

它的职责是：

1. 调用 `init_scaffold.py` 生成 scaffold JSON。
2. 写入 `session/project`。
3. 跑 flake8。
4. 写 `scaffold_file_manifest.json`。
5. 写标准 `phase_complete.upy_scaffold_plugin.json`。

如果直接用新版 `apply_scaffold.py --write-phase-complete`，输出应该具备：

- `payload.source` 是对象。
- `payload.permissions` 是数组。
- `runtime_context.resource_root` 是稳定 skill id，例如 `upy-scaffold-plugin`。
- `artifacts[type=file_manifest]` 带完整 `files`。
- `payload.scaffold.generate_scope=full_project`。

但当前 session 的 `phase_complete` 不是这样。

## 当前发现的具体问题

### 1. payload.source 是 null

当前类似：

```json
"source": null
```

但又有类似这些散落字段：

```json
"source_phase": "upy-flash-mpy-firmware-plugin",
"source_phase_complete_path": "sessions/.../phase_complete.upy_flash_mpy_firmware_plugin.json"
```

标准做法应该是：

```json
"source": {
  "source_phase": "upy-flash-mpy-firmware-plugin",
  "source_phase_complete_path": "sessions/<session_id>/phase_complete.upy_flash_mpy_firmware_plugin.json",
  "source_manifest_kind": "phase_complete_or_manifest_input",
  "manifest_merge_strategy": "renderer_unwrap_manifest"
}
```

### 基础知识：source 是什么

`source` 表示来源链路。

它告诉下游：

- scaffold 是从哪个上游阶段来的。
- 上游 phase_complete 文件在哪里。
- manifest 是怎么取出来的。

如果 `payload.source` 缺失，下游仍可能从其他字段猜到来源，但这不够规范。

影响：

- 阶段链路追踪不清晰。
- 出错时不容易定位源头。
- 宿主做 resume/retry 时需要绕路找来源。
- 下游如果严格读 `payload.source`，会读不到。

## 2. payload.permissions 是对象，不是标准数组

当前类似：

```json
"permissions": {
  "file_writes": [],
  "script_runs": []
}
```

标准做法建议是数组：

```json
"permissions": [
  {
    "type": "file_operation",
    "root": "sessions/<session_id>/project",
    "operation": "write",
    "file_count": 45,
    "approved": true,
    "approved_at": "...",
    "idempotency_key": "upy-scaffold-plugin:<session_id>:file-write:v1"
  },
  {
    "type": "script_run",
    "name": "flake8",
    "command": "python -m flake8 --jobs=1 firmware tools",
    "cwd": "sessions/<session_id>/project",
    "approved": true,
    "approved_at": "...",
    "idempotency_key": "upy-scaffold-plugin:<session_id>:script:flake8:v1"
  }
]
```

### 基础知识：permissions 是什么

`permissions` 用来记录本阶段做过哪些需要授权的操作。

例如：

- 写文件。
- 运行脚本。
- 访问设备。
- 烧录固件。

它不是单纯日志，而是审计记录。

影响：

- 如果结构不统一，宿主 UI 不容易渲染审批记录。
- 后续审计时不容易知道哪些操作被允许。
- 自动恢复/重试时不好判断哪些操作已经授权。
- 不同插件之间协议风格不一致。

## 3. runtime_context.resource_root 是本机绝对路径

当前类似：

```json
"resource_root": "C:\\Users\\Administrator\\.claude\\skills"
```

新版正式脚本应输出：

```json
"resource_root": "upy-scaffold-plugin"
```

### 基础知识：runtime_context 是什么

`runtime_context` 描述运行上下文，例如：

- artifact root 在哪里。
- session root 在哪里。
- project root 在哪里。
- file operation root 在哪里。
- skill resource root 是什么。

其中 formal payload 最好避免写本机绝对路径。

原因：

- `C:\Users\Administrator\...` 只在当前机器成立。
- 换电脑、换用户、换宿主就失效。
- 绝对路径可能泄漏本机环境信息。
- 不利于复现和跨环境传递。

影响：

- 当前本机测试不一定受影响。
- 但跨环境、日志归档、自动化回放时不够干净。

## 4. artifacts[type=file_manifest] 没带 files

当前 artifact 里只有：

```json
{
  "type": "file_manifest",
  "title": "文件清单",
  "path": "sessions/.../scaffold_file_manifest.json"
}
```

标准脚本会把完整 `file_manifest` 放入 artifacts，因此：

```json
"artifacts": [
  {
    "type": "file_manifest",
    "title": "Scaffold 写入结果",
    "root": "sessions/<session_id>/project",
    "path": "sessions/<session_id>/scaffold_file_manifest.json",
    "files": []
  }
]
```

### 基础知识：artifact 是什么

`artifact` 是阶段产物声明。

它告诉 UI 或下游：

- 本阶段产生了什么。
- 产物在哪里。
- 产物的结构是什么。

`file_manifest` artifact 如果只有 `path` 也不是完全错误，因为完整文件在 `scaffold_file_manifest.json` 里。

但如果同时带 `files`，下游不需要再打开额外文件就能直接看清单。

影响：

- 不阻塞。
- 但 UI 展示和下游读取更麻烦。
- 与新版正式脚本输出不一致。

## 5. payload.scaffold 已有，但字段和新版脚本略不一致

当前 `payload.scaffold` 已经补了很多信息，这是进步。

但有几点不一致：

当前：

```json
"idempotency_key": "upy-scaffold-plugin:<session_id>:scaffold:v1",
"generate_scope": null
```

新版脚本建议：

```json
"idempotency_key": "upy-scaffold-plugin:<session_id>:phase-complete:v1",
"generate_scope": "full_project"
```

### 基础知识：idempotency_key 是什么

`idempotency_key` 是幂等键。

作用是让宿主判断：

- 这次操作是不是已经执行过？
- 如果重复执行，是否应该视为同一次？
- 恢复/重试时是否能避免重复写入或重复操作？

如果同一阶段不同位置使用不同语义的 key，会增加判断成本。

### 基础知识：generate_scope 是什么

`generate_scope` 表示生成范围。

例如：

- `full_project`：完整项目 scaffold。
- `new_devices_only`：只为新增器件生成增量 stub。

当前是 full scaffold，所以建议是：

```json
"generate_scope": "full_project"
```

而不是 `null`。

## 为什么会出现这种情况

从日志看，流程中确实运行了：

```text
scripts/apply_scaffold.py
```

但当前 `phase_complete` 的结构不像新版 `apply_scaffold.py --write-phase-complete` 直接生成。

这通常说明：

1. 项目文件可能是 `apply_scaffold.py` 或类似逻辑生成的。
2. 但最终 `phase_complete` 可能又被外部/手写 finalizer 重新组装过。
3. 手写 finalizer 模仿了部分字段，但没有完全遵守新版脚本结构。

所以问题不是项目写入失败，而是最终阶段完成消息没有完全收敛到正式脚本。

## 会影响什么

### 不太影响当前项目代码

因为：

- 文件已经写入。
- flake8 通过。
- manifest 文件存在。
- file manifest 和实际文件一致。

所以当前 `project/` 作为 scaffold 项目可以继续给 `upy-generate-plugin` 使用。

### 可能影响下游协议读取

如果 `upy-generate-plugin` 严格读取：

```json
payload.source
payload.permissions[]
payload.scaffold.generate_scope
artifacts[type=file_manifest].files
```

那么当前 session 的 `phase_complete` 可能不够标准。

### 可能影响 UI 和审计

因为：

- source 链路不在统一位置。
- permissions 结构不是统一数组。
- resource_root 泄漏本机路径。
- artifact manifest 不完整。

UI 和审计程序需要做兼容分支。

### 可能影响恢复和重试

恢复/重试通常依赖：

- `idempotency_key`
- `file_manifest`
- `runtime_context`
- `structured_errors`
- `permissions`

当前多数信息存在，但结构不够统一。

这不会必然失败，但会增加恢复逻辑复杂度。

## 当前有没有替代字段

有。

### source 替代

当前虽然 `payload.source=null`，但有：

```json
payload.source_phase
payload.source_phase_complete_path
payload.source_manifest_kind
payload.manifest_merge_strategy
```

可以替代一部分作用。

### permissions 替代

当前 `payload.permissions.file_writes` 和 `payload.permissions.script_runs` 有部分授权信息。

但它不是标准数组结构。

### scaffold 替代

当前 `payload.scaffold` 已经存在，另外还有：

```json
payload.manifest_content.scaffold
payload.manifest_content.scaffold_modules
project/project-manifest.json
```

### file_manifest artifact 替代

当前 artifact 没带 files，但以下位置有完整清单：

```json
payload.file_manifest.files
```

以及：

```text
scaffold_file_manifest.json
```

## 应该怎么解决

推荐不要再手写或外部组装 `phase_complete`。

应直接使用正式脚本写最终文件：

```bash
python -X utf8 C:/Users/Administrator/.claude/skills/upy-scaffold-plugin/scripts/apply_scaffold.py ^
  --session-dir G:/test/test/sessions/022ad742-3269-42e9-ac20-c14f477ecdf2 ^
  --manifest G:/test/test/sessions/022ad742-3269-42e9-ac20-c14f477ecdf2/phase_complete.upy_flash_mpy_firmware_plugin.json ^
  --mode async ^
  --modules logger,flash_device,log_tools,time_helper,maintenance ^
  --write-phase-complete
```

如果目录里已有同名文件且内容一致，脚本会用幂等状态处理。

如果希望覆盖已有不同内容，可以加：

```bash
--force
```

但正式测试前更推荐先清理旧 scaffold 产物，再重新跑。

## 判断标准

一次标准的 `upy-scaffold-plugin` 输出应该满足：

```json
payload.result == "success"
payload.next_phase == "upy-generate-plugin"
payload.source 是对象
payload.permissions 是数组
payload.runtime_context.resource_root == "upy-scaffold-plugin"
payload.scaffold.generate_scope == "full_project"
artifacts[type=file_manifest].files 数量 == payload.file_manifest.files 数量
payload.file_manifest.files 与 scaffold_file_manifest.json.files 一致
payload.file_manifest.files 与 project 实际文件一致
flake8.returncode == 0
```

当前 session 满足项目文件和 flake8 部分，但不完全满足 `phase_complete` 标准结构。

## 最终结论

当前问题的本质是：

```text
项目 scaffold 产物合格，但 phase_complete 协议消息不是新版正式 apply_scaffold.py 的标准输出。
```

这说明工作流还存在“执行脚本”和“最终消息生成”没有完全收敛的问题。

正确方向是：

```text
让 apply_scaffold.py 成为唯一负责写 project、file_manifest、phase_complete 的正式入口。
```

不要再由聊天里的临时代码、手写 finalizer 或外部拼装逻辑单独生成 `phase_complete.upy_scaffold_plugin.json`。