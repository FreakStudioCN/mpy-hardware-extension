# upy-scaffold-plugin 最小修改实施清单

## 目标

本文件用于单独整理 `upy-scaffold-plugin` 后续改造思路：哪些必须改、哪些可以暂缓、哪些需要严格校验、哪些只做提示或弱校验。原则是尽可能少改 `G:\MicroPython_Skills\upy-scaffold-plugin` 当前内容，同时让插件调用和 Claude Code 本地测试调用流程清晰、可验证、可恢复。

不修改对象：

- 不改原 `G:\MicroPython_Skills\upy-scaffold`
- 不改原 `G:\MicroPython_Skills\upy-deploy`
- 不在本轮文档阶段修改 `G:\MicroPython_Skills\upy-scaffold-plugin`

## 最小改造原则

1. 保持 `scripts/init_scaffold.py` 是无副作用 renderer：只读 manifest，只输出 JSON，不直接写项目目录。
2. 插件正式调用时，由宿主执行文件写入、权限提示、flake8、checkpoint。
3. Claude Code 本地实际测试时，用一个本地 actual runner 模拟宿主，把 `file_operations[]` 写入临时或指定项目目录。
4. `templates/firmware` 先不做复杂化改造，业务功能、驱动胶水、任务注册留给 `upy-generate-plugin`。
5. 只修协议链路和必要项目骨架产物，不扩大 scaffold 职责。

## 推荐最终流程

```text
start_phase(upy-scaffold-plugin)
  -> 校验上游 phase_complete / manifest_content
  -> approval_request(scaffold_config)
  -> script_run(init_scaffold.py)
  -> 得到 directories[] / files[] / file_operations[]
  -> file permission prompt
  -> 宿主或本地 runner 应用 file_operations[]
  -> script_run(flake8) 强制 gate
  -> phase_complete(success, next_phase=upy-generate-plugin)
```

失败、取消、超时：

```text
任一关键步骤失败
  -> result=failed/partial/cancelled
  -> next_phase=null
  -> structured_errors[]
  -> checkpoint payload
```

## 必须修改项

| 优先级 | 修改点 | 当前问题 | 最小实现方式 |
|---|---|---|---|
| P0 | `next_phase` | 当前仍有 `upy-generate`，incremental 成功为 `null` | full/incremental 成功统一输出 `upy-generate-plugin` |
| P0 | `project-manifest.json` | 当前只返回 `manifest_content`，项目根没有 manifest 文件 | renderer 在 `files[]` / `file_operations[]` 中加入 `project-manifest.json` |
| P0 | flake8 gate | 只在文档中要求，未在本地 actual 流程闭环 | 插件宿主和本地 actual runner 都必须在落盘后运行 flake8 |
| P1 | 本地 actual runner | 当前 smoke 只校验 JSON，不写真实项目目录 | 新增 `test/run_local_actual_project.py`，应用 `file_operations[]` |
| P1 | `docs/` | 当前插件版未生成 `docs/.gitkeep` | 在 placeholder 列表里加入 `docs/.gitkeep` |
| P1 | `.upy` 资源来源 | 当前硬编码旧 skill 目录 | 增加资源注册表，迁移期 fallback 旧目录，缺失策略明确 |
| P1 | sample/test 同步 | 当前样例和断言仍按旧 next_phase | 更新 sample 和 smoke 断言 |

## 暂不修改项

| 项目 | 暂不修改原因 |
|---|---|
| `templates/firmware/*.tmpl` 业务内容 | scaffold 不应提前写业务代码，复杂生成留给 `upy-generate-plugin` |
| SPI/UART/I2S/ADC/PWM 等复杂 bus 初始化 | 可由 `upy-generate-plugin` 基于 manifest 重写或补全 |
| `templates/pc/flash_device.py` 的 deploy 逻辑 | 它属于后续 `upy-deploy-plugin` 或共享 tooling 的执行工具 |
| `templates/pc/read_device_log.py` 的设备日志逻辑 | scaffold 阶段只复制，不执行设备操作 |
| 完整 checkpoint 存储系统 | skill 只生成 checkpoint 草案，持久化由宿主或本地 runner 模拟 |
| 所有后续插件目录改名 | 当前仓库还没有 `upy-generate-plugin` 等目录，先用协议名，不强行重构目录 |

## 严格校验项

这些失败时不能继续进入 `upy-generate-plugin`。

| 校验项 | 严格原因 | 失败处理 |
|---|---|---|
| 上游 `phase_complete.result == success` | 防止从失败阶段继续生成项目 | `UPSTREAM_PHASE_INVALID`，`next_phase=null` |
| 正式链路上游 `next_phase == upy-scaffold-plugin` | 防止误接旧链路或错误阶段 | `UPSTREAM_PHASE_INVALID` |
| `manifest_content` 必须是对象 | 没有 manifest 无法生成骨架 | `INVALID_MANIFEST` |
| 生成路径必须是相对 POSIX 路径 | 防止越界写文件 | `UNSAFE_PATH` |
| 路径不得包含盘符、绝对路径、`..` | 本地安全边界 | `UNSAFE_PATH` |
| `file_operations[]` 与 `files[]` 一致 | 防止预览和实际写入不一致 | `FILE_MANIFEST_MISMATCH` |
| `project-manifest.json` 必须落盘 | 后续 generate/deploy/local tool 都依赖它 | `MANIFEST_WRITE_MISSING` |
| flake8 必须可运行且返回 0 | scaffold 是后续代码基座 | `SCAFFOLD_LINT_FAILED` |
| full/incremental 成功 `next_phase == upy-generate-plugin` | 插件链路一致性 | 测试失败 |
| `docs/.gitkeep`、基础目录占位 | 项目结构兼容 | 测试失败或 warning，按是否纳入 P1 决定 |
| 必需 `.upy` 核心资源存在 | 本地工具链需要 | `RESOURCE_MISSING` |

建议严格校验的必需 `.upy` 核心资源：

```text
.upy/schemas/project-manifest.schema.json
.upy/scripts/validate_json.py
.upy/scripts/init_scaffold.py
```

## 非必须严格校验项

这些不应阻断 scaffold 成功，最多进入 warnings 或 artifact 标记。

| 项目 | 原因 | 处理方式 |
|---|---|---|
| 后续 wiring/diagram/gen-driver/autofix 工具缺失 | 当前阶段不直接执行这些工具 | warning + artifact 标记 unavailable |
| `flash_device.py`、`read_device_log.py` 是否支持 JSON summary | 这是 deploy 阶段能力，不是 scaffold 必须能力 | 留给 `upy-deploy-plugin` |
| `templates/firmware` 是否覆盖所有硬件接口 | 真实代码由 generate 阶段补齐 | 不阻断，只保持 TODO/骨架 |
| README 文案完整度 | 不影响下游协议 | warning 或不校验 |
| `item_groups` 是否成为全局 UI 标准 | 只对 scaffold_config 有意义 | 不做全局强制 |
| `_thread` 是否被具体固件支持 | 需要实际板卡/固件确认 | approval 中提示风险，不在 scaffold 阶段阻断 |
| optional custom files | 用户自定义输入，可能为空 | 只校验路径安全 |
| deploy/device 操作权限 | scaffold 不执行设备操作 | 后续阶段再严格校验 |

## `.upy` 资源来源的最小实现方案

当前不要一次性迁移所有旧 skill 目录。建议新增一个小型资源注册表，保持最小改动：

```text
目标路径 -> required/optional -> 候选源路径列表
```

示例：

```text
.upy/schemas/project-manifest.schema.json
  required: true
  candidates:
    - upy-project-gen-toolchain-spec/project-manifest.schema.json

.upy/scripts/download_drivers.py
  required: false
  candidates:
    - upy-generate-plugin/scripts/download_drivers.py
    - upy-generate/scripts/download_drivers.py

.upy/scripts/render_wiring_local.py
  required: false
  candidates:
    - upy-wiring-plugin/scripts/render_wiring_local.py
    - upy-wiring/scripts/render_wiring_local.py
```

迁移期规则：

1. plugin/shared 路径存在则优先用。
2. plugin/shared 不存在时允许 fallback 到旧 skill 目录。
3. required 资源缺失直接失败。
4. optional 资源缺失只写 warning，不阻断 scaffold。
5. 所有复制进 `.upy` 的文件都进入 file manifest。

## `project-manifest.json` 的保留策略

必须保留项目根 `project-manifest.json`。

理由：

- 当前旧 `upy-generate` 读取它。
- `templates/pc/flash_device.py` 读取它。
- Claude Code 本地测试需要一个稳定项目事实文件。
- 用户项目需要可版本管理、可离线查看的 manifest。
- `phase_complete.manifest_content` 是消息事实，不等于项目根持久文件。

最小实现：

```text
updated_manifest = manifest_content + scaffold 字段
files.append({
  "path": "project-manifest.json",
  "content": json.dumps(updated_manifest, ensure_ascii=False, indent=2),
  "encoding": "utf-8"
})
```

## `templates/pc` 的处理策略

当前不在 scaffold 中修改 `flash_device.py`、`read_device_log.py` 的行为。

scaffold 阶段只负责：

1. 根据用户模块选择，复制到 `tools/`。
2. 根据 `.upy` 资源策略，复制到 `.upy/scripts/`。
3. 在 artifact/file manifest 中声明它们。
4. 不执行它们，不申请设备权限。

后续如果 `upy-deploy-plugin` 要自动调用，应在 deploy plugin 或共享 tooling 中补：

- 非交互参数
- JSON summary
- timeout
- device permission prompt
- structured errors

## 本地 actual runner 的最小职责

建议新增 `test/run_local_actual_project.py`，不要改 renderer。

最小职责：

```text
1. 调用 init_scaffold.py
2. 读取 stdout JSON
3. 校验 paths 安全
4. 创建 project_dir
5. 应用 file_operations[]
6. 校验 project-manifest.json 存在
7. 运行 flake8
8. 输出本地 phase_complete 和 file_manifest
```

它是测试工具，不是正式插件协议的一部分，但行为要尽量贴近宿主。

## 最小实施顺序

1. 改 `next_phase` 和相关样例/测试。
2. 输出 `project-manifest.json`。
3. 恢复 `docs/.gitkeep`。
4. 增加本地 actual runner，应用文件写入。
5. 在插件文档和本地 runner 中明确 flake8 gate。
6. 增加 `.upy` 资源注册表和 required/optional 策略。
7. 增加少量严格校验：路径安全、file/files 一致、manifest 落盘、flake8 结果。
8. 暂缓 firmware templates 和 deploy tools 的复杂改造。

## 最终判断

当前最小可行改法不是重写 `upy-scaffold-plugin`，而是把现有 renderer 周围的协议和测试闭环补齐：

```text
少改 renderer
补 project-manifest.json / docs
改 next_phase
新增本地 actual runner
强制 flake8
明确 .upy 资源来源
```

这样既能保持 scaffold 职责单一，又能让插件调用和本地调用都可落盘、可校验、可进入下一阶段。

## 修订补充：结合总目标、改造分析后半段与当前实现状态

本补充是在已有清单基础上的收敛版判断。目标不是扩大 `upy-scaffold-plugin` 的职责，而是把“还没实现或需要修正的点”按当前最小改动重新分层：哪些必须现在改，哪些只需要在文档/样例中说清楚，哪些应该留给宿主或后续 plugin。

### 总目标对齐

总目标是把“一句话生成硬件相关 skill”的链路改成插件化工作流：

```text
upy-analyze-plugin
  -> upy-select-hw-plugin
  -> upy-flash-mpy-firmware-plugin
  -> upy-scaffold-plugin
  -> upy-generate-plugin
```

`upy-scaffold-plugin` 在这个链路中的职责只应是：

```text
读取硬件/需求 manifest
  -> 让用户确认 scaffold 配置
  -> 渲染项目骨架文件清单
  -> 交给宿主或本地 runner 写入项目目录
  -> flake8 gate
  -> 把更新后的 manifest 传给 upy-generate-plugin
```

它不应该提前承担：

- 真实业务功能生成
- 驱动实现
- 设备烧录
- 设备日志读取
- 完整恢复存储系统
- 全局插件 UI 协议定义

### 当前 `upy-scaffold-plugin` 实现现状

根据当前 `G:\MicroPython_Skills\upy-scaffold-plugin` 文件状态，已经有：

| 当前已有 | 说明 |
|---|---|
| `scripts/init_scaffold.py` | 已是无副作用 renderer，输出 JSON，不直接写项目目录 |
| `files[]` / `file_operations[]` | 已能生成待写文件和 file_operation |
| `phase_complete_payload` | 已有 payload 草案 |
| `templates/firmware/*` | 已有简单骨架模板 |
| `.upy/scripts/run_on_device.py` | 已存在并会被复制 |
| `test/smoke_tests.py` | 已覆盖 renderer 输出、路径、编译、incremental、item_groups |
| `sample/approval_request.scaffold_config.json` | 已有 scaffold 审批样例 |

当前明确未实现或待修正：

| 缺口 | 当前表现 |
|---|---|
| `next_phase` | `SKILL.md`、`init_scaffold.py`、测试仍使用旧 `upy-generate` 或 incremental `null` |
| `project-manifest.json` | 只返回 `manifest_content`，没有加入 `files[]` / `file_operations[]` |
| `docs/.gitkeep` | 当前 placeholder 列表没有 `docs/.gitkeep` |
| flake8 gate 闭环 | renderer 不执行 flake8 是对的，但本地 actual runner 还没有 |
| 本地 actual runner | 还没有把 `file_operations[]` 真实写入临时项目目录的测试入口 |
| `.upy` 资源来源 | 当前硬编码旧 skill 目录，如 `upy-generate`、`upy-wiring` |
| artifact/file manifest | 当前只有 `file_tree` 和 `file_list`，没有 hash/idempotency |
| checkpoint/resume | 目前是设计结论，没有样例和本地 mock host |
| cancellation/retry/timeout/idempotency | 当前 smoke 未覆盖协议韧性 |
| capability negotiation | 样例中有 capabilities，但缺失败分支 |
| structured errors | 当前只有 `errors: []`，还没有统一错误对象 |
| incremental 冲突策略 | 还没定义已有 driver stub 时如何处理 |

### 最小修改分层

#### P0：必须先改，且改动很小

这些是链路正确性和项目可用性的最低要求。

| 项 | 最小修改 | 严格性 |
|---|---|---|
| `next_phase` | full/incremental 成功统一为 `upy-generate-plugin` | 严格 |
| `project-manifest.json` | renderer 把更新后的 manifest 加入 `files[]` / `file_operations[]` | 严格 |
| flake8 gate | 不放进 renderer，放进插件宿主和本地 actual runner | 严格 |
| `docs/.gitkeep` | 加入 placeholder 输出 | 推荐严格，至少测试覆盖 |

P0 的特点：不需要重写架构，不需要改固件模板业务内容，不需要实现完整 checkpoint 系统。

#### P1：为了本地测试和迁移稳定，应尽快补

| 项 | 最小实现 | 严格性 |
|---|---|---|
| 本地 actual runner | 新增 `test/run_local_actual_project.py`，应用 `file_operations[]` 到临时目录 | 对本地实际测试严格 |
| 路径安全 | runner 和 smoke 都校验相对路径、无盘符、无 `..` | 严格 |
| `files[]` 与 `file_operations[]` 一致 | 已有 smoke 基础，actual runner 再验证 | 严格 |
| `.upy` 资源注册表 | 先做小表，plugin/shared 优先，旧 skill fallback | 核心资源严格，后续工具非严格 |
| sample/test 同步 | 更新 next_phase、manifest、docs、flake8 预期 | 严格 |
| incremental 基本上下文 | 增加 `incremental=true`、`generate_scope=new_devices_only` | 严格 |

P1 的重点是让“Claude Code 本地测试调用”真的能模拟宿主写项目目录，而不是只验证 stdout JSON。

#### P2：协议韧性，先设计清楚，不必一次全改

这些在完整插件平台中重要，但不应该一次性塞进当前 renderer。

| 项 | 推荐归属 | 当前处理 |
|---|---|---|
| checkpoint/resume 持久化 | 宿主或本地 mock host | skill 只生成 checkpoint 草案 |
| cancellation/retry/timeout/idempotency 全覆盖 | mock host / protocol tests | 先补样例和测试，不改核心 renderer |
| permission prompts | 插件宿主 | skill/file_operation 可声明意图，但不执行权限系统 |
| artifact hash/idempotency manifest | actual runner / host | P2 补强，不阻塞 P0 |
| capability negotiation 失败分支 | skill orchestration / host | 先在文档和样例定义 |
| structured error 完整 taxonomy | protocol helper / host | P0 只需要关键错误码 |
| incremental 文件冲突策略 | host / actual runner | 先禁止覆盖用户修改，后续再合并 |

### 严格校验重新收敛

为了减少当前代码改动，严格校验只放在会直接影响安全、链路或可运行性的地方。

#### 应严格校验

| 校验 | 原因 |
|---|---|
| 上游正式链路必须是成功的 `phase_complete` | 防止从失败阶段继续 |
| 正式链路 `next_phase == upy-scaffold-plugin` | 防止误接旧链路 |
| `manifest_content` 是对象，且至少包含项目生成所需基本字段 | 没有事实输入不能生成 |
| 所有输出路径是相对 POSIX 路径 | 防止越界写文件 |
| 路径不得包含盘符、绝对路径、`..` | 本地安全边界 |
| `files[]` 与 `file_operations[]` 数量和路径一致 | 防止预览和实际写入不一致 |
| `project-manifest.json` 必须在输出文件列表中 | 后续 generate/deploy/local tool 依赖 |
| flake8 必须执行且返回 0 | scaffold 是后续代码基座 |
| 成功时 `next_phase == upy-generate-plugin` | 插件链路正确性 |
| `.upy` 核心资源存在 | 项目本地工具链最低可用 |

`.upy` 核心资源建议只包括：

```text
.upy/schemas/project-manifest.schema.json
.upy/scripts/validate_json.py
.upy/scripts/init_scaffold.py
```

#### 不应严格校验

| 不严格项 | 原因 |
|---|---|
| wiring/diagram/gen-driver/autofix 的后续工具是否都存在 | 当前 scaffold 阶段不执行它们 |
| `flash_device.py`、`read_device_log.py` 是否已经 JSON 化 | 属于 `upy-deploy-plugin` 或共享 tooling |
| `templates/firmware` 是否覆盖所有硬件接口 | 由 `upy-generate-plugin` 修正/重写 |
| `item_groups` 是否是所有插件通用 UI 标准 | 只作为 scaffold_config 增强字段 |
| README 文案完整度 | 不影响协议链路 |
| `_thread` 是否被具体固件支持 | 需要板卡/固件确认，审批时提示即可 |
| optional custom files 是否为空 | 用户配置项，路径安全即可 |
| artifact hash 是否完整 | 对 resume 有帮助，但不是 P0 |
| checkpoint 是否已持久化 | 宿主职责，不应阻断 renderer 最小可用 |

### 对改造分析后半段的取舍

| 分析后半段问题 | 当前最小清单取舍 |
|---|---|
| artifact/file manifest | P2。先保证 `files[]`/`file_operations[]` 一致，hash/idempotency 后补 |
| permission prompts | 放宿主。当前只在协议文档说明 file/script/device 权限边界 |
| templates 稳定 marker 和 interface grouping | 暂缓。用户已明确 templates 先不用改，交给 `upy-generate-plugin` |
| `run_on_device.py` 边界 | 保留复制，不执行；执行权限留给 gen-driver/deploy |
| 上游严格校验 | 正式 plugin 模式严格；本地迁移直测允许裸 manifest |
| capability negotiation | P2。先文档定义失败分支，不改 renderer 核心 |
| `item_groups` 定位 | 只作为 scaffold_config 可选增强，不做全局标准 |
| `docs/.gitkeep` | P0/P1 小改，恢复 |
| `.upy` 资源来源 | P1。注册表 + fallback + required/optional |
| structured errors | P2。P0 只需要 lint/path/manifest/phase 几类错误 |
| incremental 冲突策略 | P1。actual runner 默认不覆盖用户修改，合并交给 generate |

### 当前文件应如何最少改

后续真正动代码时，建议只碰这些位置：

| 文件 | 最小修改 |
|---|---|
| `SKILL.md` | 改 next_phase 文案；说明 `project-manifest.json`、docs、flake8、本地 actual runner、`.upy` 资源策略 |
| `scripts/init_scaffold.py` | 改 next_phase；输出 `project-manifest.json`；输出 `docs/.gitkeep`；资源来源改注册表 |
| `test/smoke_tests.py` | 更新 next_phase 断言；增加 `project-manifest.json`、`docs/.gitkeep`、资源策略断言 |
| `test/run_local_actual_project.py` | 新增；负责真实落盘、路径安全、flake8 |
| `sample/*.json` | 同步 next_phase 和 manifest/file artifact 预期 |

暂时不要碰：

```text
templates/firmware/*.tmpl
templates/lib/**
templates/tasks/**
templates/pc/*.py 的业务逻辑
原 upy-scaffold
原 upy-deploy
```

### 清晰流程版本

#### 插件正式调用

```text
1. 宿主传 start_phase + 上游 phase_complete
2. skill 校验上游成功且 next_phase=upy-scaffold-plugin
3. skill 发 approval_request(scaffold_config)
4. 用户确认
5. 宿主 script_run(init_scaffold.py)
6. renderer 输出 files[] / file_operations[]，其中包含 project-manifest.json、docs/.gitkeep
7. 宿主申请 file write permission
8. 宿主写入项目目录
9. 宿主 script_run(flake8)
10. flake8 成功 -> phase_complete success, next_phase=upy-generate-plugin
11. flake8 失败 -> phase_complete failed/partial, next_phase=null
```

#### Claude Code 本地 actual 测试

```text
1. test/run_local_actual_project.py 读取 manifest 或 phase_complete
2. 调用 scripts/init_scaffold.py
3. 校验输出路径安全
4. 创建临时 project_dir
5. 应用 file_operations[]
6. 校验 project-manifest.json、docs/.gitkeep、核心 .upy 资源存在
7. 运行 python -m flake8 firmware tools
8. 输出本地 phase_complete / file_manifest
```

### 最终收敛结论

当前最合理的路线是：

```text
不重写 scaffold
不复杂化 templates
不把 deploy/gen-driver/autofix 能力塞进 scaffold

只补：
  next_phase
  project-manifest.json
  docs/.gitkeep
  flake8 gate
  本地 actual runner
  .upy 资源来源策略
  必要 smoke/sample 更新
```

这条路线改动少，职责边界清楚，也能覆盖插件调用和 Claude Code 本地调用两种情况。

## 修订补充：MicroPython-aware flake8 gate 设计

之前清单里写“flake8 必须可运行且返回 0”方向是对的，但需要补充一个关键条件：必须使用适配 MicroPython 的 `.flake8` 配置后返回 0，不能按纯 CPython 项目默认规则机械判断。

### 官方文档依据

MicroPython 官方 latest 文档显示：

- `machine` 是 MicroPython 硬件相关模块，直接访问 CPU、timer、bus、Pin、I2C、SPI、UART、I2S、WDT 等硬件能力。
- `micropython` 是 MicroPython 内部控制模块，包含 `const()`、`alloc_emergency_exception_buf()` 等 CPython 常规环境没有的能力。
- MicroPython 的 asyncio、time、machine、micropython 等模块/API 与标准 CPython 不完全相同，且不同 port/firmware 的可用能力会有差异。
- Flake8 官方支持 `extend-ignore`、`per-file-ignores`、`builtins`、`max-line-length` 等配置项，适合把 MicroPython 特有符号和特定文件的合理例外收敛到配置里。

因此 flake8 gate 的目标不是证明代码能在 CPython 上运行，而是：

```text
确认 scaffold 输出的 MicroPython 项目没有明显语法错误、未定义变量、缩进/格式破坏、导入重导出误报以外的问题。
```

### 当前实测结果

用当前 `upy-scaffold-plugin/scripts/init_scaffold.py` 渲染 timer 项目到临时目录，并执行：

```text
python -m flake8 firmware tools
```

结果不是 0，主要失败在：

```text
firmware/board.py: E122/E128
```

原因是当前 `board.py` 把 manifest 的 `PINOUT` 大列表用 `pprint.pformat()` 直接嵌入字典，pycodestyle 把这类多行字面量缩进判为 continuation indentation 问题。这个不是 MicroPython 运行语义错误，而是生成格式与 pycodestyle 视觉缩进规则冲突。

另外，当前生成配置全局忽略：

```ini
extend-ignore =
    F821,
    F401,
```

这个过宽。`F821` 是 undefined name，真实代码里如果有变量拼错，应该被 gate 拦住；`F401` 是 imported but unused，只有 re-export 包或 scaffold 占位导入才应该局部忽略。

### 推荐原则

1. flake8 gate 仍然必须运行，且返回 0 才能进入 `upy-generate-plugin`。
2. 返回 0 的前提是使用项目生成的 `.flake8`，这个配置必须适配 MicroPython。
3. 不要全局忽略 `F821`。
4. 不要全局忽略 `F401`。
5. MicroPython 专有 builtin 或 parser 特性应通过 `builtins = const` 处理。
6. re-export 包和 scaffold 占位导入用 `per-file-ignores` 精确处理。
7. 当前如果暂不改 `board.py` 生成格式，可以对 `firmware/board.py` 精确忽略 `E122,E128`；长期更好是把 `PINOUT` 格式化成 pycodestyle 接受的缩进。

### 建议 `.flake8` 最小配置

如果当前暂不修改模板和 `board.py` 渲染格式，建议 `.flake8` 改成：

```ini
[flake8]
max-line-length = 120
builtins =
    const
extend-ignore =
    W503
per-file-ignores =
    firmware/board.py: E122,E128
    firmware/main_thread.py: F401
    firmware/lib/logger/__init__.py: F401
    firmware/lib/scheduler/__init__.py: F401

[pycodestyle]
max-line-length = 120
ignore = W503
```

说明：

| 配置 | 原因 | 严格性 |
|---|---|---|
| `builtins = const` | MicroPython `const()` 常用于常量声明，当前 logger/scheduler 模板直接使用它 | 必须 |
| 不全局忽略 `F821` | 未定义变量是真错误，必须拦截 | 必须 |
| 不全局忽略 `F401` | 未使用导入通常应清理，只允许少数文件例外 | 必须 |
| `firmware/lib/*/__init__.py: F401` | `__init__.py` 里 re-export 属于合理模式 | 必须 |
| `firmware/main_thread.py: F401` | scaffold 只搭 `_thread` 框架，当前 `_thread` 可能先作为模式信号保留 | 可接受 |
| `firmware/board.py: E122,E128` | 当前 `PINOUT` 大字面量格式触发 pycodestyle 误报 | 临时接受 |
| `W503` | 行断开风格争议项，保持兼容即可 | 可接受 |

### 更好的长期方案

长期更好的做法不是永久忽略 `board.py: E122,E128`，而是改 `init_scaffold.py` 的 `py_literal()` 或 `board.py.tmpl`，让生成的 `PINOUT` 多行字面量天然符合 pycodestyle。

但根据当前“尽可能少改 `upy-scaffold-plugin`”原则，短期可以先：

```text
P0/P1：用 per-file-ignores 精确压住 board.py 的格式误报
P2：后续再调整 PINOUT 渲染格式，移除 board.py 的 E122/E128 忽略
```

### 严格与非严格校验更新

#### 应严格

| 项 | 处理 |
|---|---|
| flake8 命令存在 | 不存在则 gate 失败，不能进入下一阶段 |
| flake8 使用项目 `.flake8` | 不能裸跑默认配置 |
| flake8 返回码 | 使用 MicroPython-aware 配置后必须为 0 |
| `F821` | 除 `const` 通过 builtins 处理外，不应全局忽略 |
| `F401` | 不应全局忽略，只能 per-file |
| `E999` / 语法错误 | 必须失败 |
| 路径安全、manifest 落盘、next_phase | 仍按原清单严格 |

#### 不应严格

| 项 | 原因 |
|---|---|
| CPython 能否 import `machine` / `micropython` / `uasyncio` | 这些是 MicroPython 运行环境能力，flake8 不应通过 CPython import 验证 |
| MicroPython port 是否支持 `_thread` | 需要具体固件确认，scaffold 只能提示 |
| `time.sleep_ms`、`gc.mem_free` 这类 MicroPython API 是否能在 CPython 运行 | flake8 只做静态 gate，不做 CPython 运行测试 |
| `board.py` 当前 `PINOUT` 字面量缩进 | 短期可作为生成格式误报处理，长期再修 |

### 对当前最小实施清单的修正

原清单中的：

```text
flake8 必须可运行且返回 0
```

应改成：

```text
flake8 必须可运行，并且在项目生成的 MicroPython-aware .flake8 配置下返回 0。
```

实际命令建议：

```text
python -m flake8 firmware tools
```

运行目录必须是项目根，确保 `.flake8` 生效。插件宿主和 Claude Code 本地 actual runner 都要记录：

```json
{
  "command": "python -m flake8 firmware tools",
  "cwd": "<project_dir>",
  "config": ".flake8",
  "returncode": 0,
  "stdout": "",
  "stderr": ""
}
```

失败时仍然：

```text
result=failed 或 partial
next_phase=null
structured_errors[].code=SCAFFOLD_LINT_FAILED
checkpoint.resume_step=lint
```

### 最小改动影响

后续真正改代码时，flak8 相关最小改动只需要：

1. 修改 `generate_flake8()` 输出，不再全局 ignore `F821,F401`。
2. 增加 `builtins = const`。
3. 增加精确 `per-file-ignores`。
4. 本地 actual runner 使用项目根运行 `python -m flake8 firmware tools`。
5. smoke/actual 测试断言 flake8 返回 0。

不需要现在修改 `templates/firmware` 业务逻辑，也不需要让 CPython 真正 import/run MicroPython 设备端代码。
