# upy-generate-plugin 当前问题与 Skill 修改建议

日期：2026-06-24

分析对象：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`

参考文件：

- `generate_phase_log.md`
- `phase_complete.upy_generate_plugin.json`
- `project/firmware/tasks/dialog_task.py`
- `project/firmware/tasks/voice_task.py`
- `project/firmware/tasks/network_task.py`
- `project/firmware/main.py`
- `project/test/pc/test_dialog_task.py`
- `project/test/pc/test_voice_task.py`
- `project/test/pc/test_network_task.py`

## 结论

当前问题不是单纯的语法、flake8、pylint 或 py_compile 问题，而是 `upy-generate-plugin` 缺少业务语义门禁。现有生成结果能通过基础质量检查，但仍可能包含状态机失效、async 阻塞、真实数据未使用、manifest 过薄、审查发现未阻断 success 等问题。

因此 Skill 修改重点不应只增加文字提醒，而应把这些问题变成：

- 脚本强门禁
- smoke negative cases
- protocol consistency 校验
- final review 结构化阻断规则
- task/main/driver 生成规则约束

## 当前发现的问题

### 1. success 判定过宽

`phase_complete.upy_generate_plugin.json` 写入：

- `payload.result = success`
- `payload.next_phase = upy-deploy-plugin`
- `structured_errors = []`

但 `generate_phase_log.md` 已经列出 9 个问题，其中包含严重业务 bug。说明当前 generate 阶段的最终审查没有真正阻断 success。

应修改：只要 final review 发现 critical/error 级问题，就必须输出 `partial` 或 `failed`，并设置 `next_phase=null`。

### 2. manifest_content 仍然偏薄

当前 `payload.manifest_content` 只有：

- `schema_version`
- `phase`
- `project_name`
- `updated_at`
- `generate`

这不是完整项目 manifest。缺少上游关键字段，例如：

- `requirements`
- `devices`
- `mcu`
- `pinout`
- `bom`
- `firmware_flash`
- `scaffold` / `scaffold_mode`

虽然 `project/project-manifest.json` 已更新，并且 `file_manifest` 中包含 `project-manifest.json`，但 phase_complete 协议输出本身仍然不完整。

当前 `check_phase_complete_consistency.py` 放过了这个问题，说明校验脚本还不够严格。

### 3. dialog 状态机不持久

`firmware/tasks/dialog_task.py` 中，`dialog_tick()` 每次调用都会重新初始化：

```python
state = DialogState.IDLE
last_trigger = 0
```

后果：

- dialog active 状态不能跨 tick 保持
- timeout 逻辑基本失效
- `main.py` 中的 `dialog_state` 只能观察返回值，不能修复 task 内部状态重置问题

应修改 task 生成规则：状态机必须使用持久对象、外部 state 参数，或闭包/类实例；不能在 tick 函数内部每次初始化状态。

### 4. voice_task 读取真实音频但没有使用

`firmware/tasks/voice_task.py` 读取：

```python
audio_data = mic.read_samples(record_samples)
_ = audio_data
```

但 ASR 请求发送的是：

```python
{"audio": "base64_placeholder"}
```

后果：真实录音被丢弃，业务功能看似完整但实际不可用。

应修改：

- 禁止 runtime 业务代码中出现 `placeholder` / `base64_placeholder`
- 如果不知道 ASR API payload，应生成可配置 encoder/adapter，或输出 partial
- PC 测试必须断言上传 payload 使用真实 audio buffer

### 5. async 模式中调用同步 HTTP

`voice_task.py` 在 async function 中直接调用：

```python
wifi.http_post(...)
```

若底层使用 `urequests`，这是同步阻塞调用，会冻结 `uasyncio` 调度器数秒。

应修改：

- async task 中禁止直接调用同步 HTTP、同步长耗时 I/O
- 若只有同步 `urequests` 可用，应标记 partial，或者生成明确的非阻塞/分步状态机方案
- `check_generated_semantics.py` 应检查 async function 内 `.http_post()` / `urequests.post()` 等阻塞调用

### 6. PC 测试覆盖不足

当前测试只证明“单次调用能返回”，没有覆盖关键业务语义：

- `test_dialog_task.py` 没测跨 tick 状态保持和超时
- `test_voice_task.py` 没测 ASR payload 是否使用真实录音数据
- `test_network_task.py` 没测 `retry_interval_ms` 是否参与节流或重试策略

应修改：PC 测试必须覆盖状态保持、超时、真实数据流、异常、缺设备、驱动异常等核心场景。

### 7. I2S 外设可能冲突

`main.py` 同时创建：

- INMP441 I2S mic
- MAX98357 I2S amp

二者共享 SCK/WS，并可能共享同一个 I2S 外设。若底层 driver 各自实例化 `I2S(0)`，可能在真实设备上冲突。

应修改：

- 生成前必须建立资源计划 `resource_plan`
- 对 I2S/SPI/UART 这类共享外设，不能默认多个 driver 独立占用同一外设
- 无法确认时输出 structured error 或 partial，不能 deploy-ready success

### 8. network_task 参数未使用

`network_tick(wifi, retry_interval_ms=30000)` 中 `retry_interval_ms` 未使用。

这类问题虽然不一定阻断部署，但说明生成代码没有把 conf 里的业务参数接入真实逻辑。

应修改：dead config/semantic check 应能发现“生成参数存在但不参与行为”。

### 9. final review 与 phase_complete 不一致

`generate_phase_log.md` 记录了 9 个问题，但 `phase_complete` 仍然 success 且 `structured_errors=[]`。

应修改：

- final review 必须输出结构化 review findings
- blocking findings 必须进入 `structured_errors`
- success 时 blocking findings 必须为空
- `generate_phase_log.md` 不能成为和 `phase_complete` 脱节的人类日志

## Skill 修改建议

### 一、收紧 check_phase_complete_consistency.py

当前逻辑：

```python
MIN_MANIFEST_KEYS = 5
if len(manifest) < MIN_MANIFEST_KEYS or not any(key in manifest for key in ("devices", "generate", "requirements")):
    ...
```

这个条件太宽，因为只要包含 `generate` 且顶层 5 个 key 就能通过。

建议改成：

- success 时必须有 `requirements`
- success 时必须有非空 `devices`
- success 时必须有 `mcu`
- success 时必须有 `pinout` 或明确 `pinout_not_required` 理由
- success 时必须有 `scaffold` 或 `scaffold_mode`
- success 时 `generate.deploy_plan`、`generate.behavior_spec`、`generate.simulation_hints` 必须存在
- `payload.manifest_content` 应与 `project/project-manifest.json` 在关键字段上一致
- `generate` 只能追加，不能替代完整上游 manifest

新增错误码建议：

- `MANIFEST_REQUIRED_FIELD_MISSING`
- `MANIFEST_DEVICES_MISSING`
- `MANIFEST_REQUIREMENTS_MISSING`
- `MANIFEST_PROJECT_MISMATCH`
- `MANIFEST_GENERATE_SUMMARY_ONLY`

### 二、新增 scripts/check_generated_semantics.py

这个脚本应作为强门禁接入 `run_quality_gates.py`。

初版检查项：

1. runtime 代码禁止 placeholder：

```text
firmware/main.py
firmware/tasks/**/*.py
firmware/drivers/**/*.py
```

禁止：

- `base64_placeholder`
- `placeholder`
- `TODO: implement`
- `pass  # generated placeholder`

2. async function 中禁止同步网络调用：

- `.http_post(`
- `urequests.post(`
- `requests.post(`
- `socket` 长阻塞调用，除非有显式 timeout/yield 设计

3. 状态机不能在 tick 函数内部每次重置：

检查类似：

```python
async def xxx_tick(...):
    state = IDLE
    last_trigger = 0
```

4. 读取的数据必须进入后续 payload 或输出：

检查类似：

```python
audio_data = mic.read_samples(...)
_ = audio_data
```

同时后续发送固定 placeholder。

5. 生成参数不能完全未使用：

例如函数参数 `retry_interval_ms` 声明后没有参与任何表达式。

6. 共享外设资源风险：

初版可做静态 warning/error：

- 同时出现 `create_inmp441(...)` 和 `create_max98357(...)`
- 两者参数共享同一 I2S bus/pins
- 没有 `resource_plan` 或 `shared_i2s` 管理说明

### 三、接入 run_quality_gates.py

在现有质量门禁中新增：

```text
semantic_checks
```

推荐顺序：

```text
py_compile
flake8
pylint
pc_unittest
mpy_imports
dead_config
task_no_machine_import
device_unittest_subset
skeleton_compliance
generated_semantics
phase_complete_consistency
```

`generated_semantics` 应是强门禁。失败时不得 success。

### 四、新增 final review consistency 检查

建议新增：

```text
scripts/check_final_review_consistency.py
```

它可以检查 `phase_complete` 中是否包含：

```json
"review_findings": {
  "blocking": [],
  "warnings": []
}
```

规则：

- success 时 `review_findings.blocking` 必须为空
- 如果 `generate_phase_log.md` 或 review artifact 中出现 `严重` / `critical` / `blocking`，phase_complete 不能 success
- blocking finding 必须转入 `structured_errors`

### 五、修改 references/task_generation_rules.md

新增硬规则：

- 状态机 task 必须持久化状态，使用 class/context/state dict，不得在每次 tick 内重置状态。
- async task 必须 cooperative，不得直接执行同步 HTTP 或长耗时 I/O。
- 语音/网络任务不得生成 fake payload、placeholder payload。
- 真实输入数据必须进入后续处理链路；若 API 格式未知，必须 partial 并提示用户补充协议。
- PC 测试必须覆盖跨 tick 状态、超时、真实 payload、异常和缺设备。

### 六、修改 references/main_conf_rules.md

新增硬规则：

- 对 I2S/SPI/UART 等共享外设必须生成 `resource_plan`。
- 多个 driver 共享同一外设时，必须有统一 owner/manager。
- 无法确认共享外设可行时，输出 structured error 或 partial。
- main.py 不得隐式创建冲突外设实例。

### 七、修改 references/validation_gates.md

把新增脚本写入强门禁：

```text
check_generated_semantics.py --project-dir <project_root> --manifest <project-manifest.json>
check_final_review_consistency.py --phase-complete <phase_complete> --log <generate_phase_log.md>
check_phase_complete_consistency.py --phase-complete <phase_complete> --project-dir <project_root>
```

并说明这些失败必须阻断 deploy-ready success。

### 八、修改 SKILL.md

在 full 流程中补充：

- 生成代码后必须运行 semantic gate
- final review 不能只写日志，必须输出结构化 blocking findings
- 有 blocking finding 时必须 partial/failed
- `phase_complete.manifest_content` 必须是完整 manifest，不是摘要
- async 模式发现同步网络依赖时，不允许 deploy-ready success

### 九、补 smoke tests

新增 negative smoke cases：

1. thin manifest 但 result=success，必须失败。
2. `dialog_tick()` 内重置 `state/last_trigger`，必须失败。
3. `voice_task.py` 包含 `base64_placeholder`，必须失败。
4. async function 内调用 `wifi.http_post()`，必须失败。
5. final review 有 critical finding 但 phase_complete success，必须失败。
6. `payload.manifest_content` 和 `project-manifest.json` 关键字段不一致，必须失败。

## 推荐实施顺序

1. 先改 `check_phase_complete_consistency.py`，堵住 thin manifest。
2. 新增 `check_generated_semantics.py`，覆盖 placeholder、async blocking、状态机重置、关键数据未使用。
3. 接入 `run_quality_gates.py`。
4. 更新 `validation_gates.md`、`task_generation_rules.md`、`main_conf_rules.md`、`SKILL.md`。
5. 补 smoke negative cases。
6. 跑 smoke tests、skill validate、plugin validate。
7. 同步到 `C:\Users\Administrator\.claude\skills`。

## 总体判断

当前 `upy-generate-plugin` 最大不足是：基础代码门禁已经有了，但业务语义门禁不足。必须把“状态机是否真的持久”“async 是否阻塞”“真实数据是否进入链路”“manifest 是否完整”“final review 是否能阻断 success”这些要求变成自动检查，否则同类问题会反复出现。