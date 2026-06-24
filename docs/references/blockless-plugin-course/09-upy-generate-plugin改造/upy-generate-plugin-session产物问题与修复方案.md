# upy-generate-plugin session产物问题与修复方案

## 1. 背景

分析对象：

- Session：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`
- 日志：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\generate_phase_log.md`
- 项目：`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project`
- 当前 project git HEAD：`3a790dbb1d4f806fe0e7e50ead750078d0cde226`

本次只做分析，没有修改 session/project/skill。

## 2. 总体结论

这次生成的业务代码质量比前几轮明显更接近目标：

- `device/tests` 已生成真实设备端 MicroPython unittest。
- `check_device_unittest_subset.py` 通过。
- `check_generate_plan.py --require-plan --check-files` 通过。
- `check_generated_semantics.py` 通过。
- 项目 git 工作树干净。

主要问题不在业务代码本身，而在最终协议产物和验证闭环：

1. `session_state.upy_generate_plugin.json` 仍是旧式简化结构，不能通过当前 skill 的 session_state 校验。
2. `phase_complete` 中嵌入的 `session_state_checkpoint` 与磁盘真实 session_state 不一致。
3. `manifest_hash` 被写成 git commit，而不是 `project-manifest.json` 的文件 hash。
4. 最终 HEAD 与 `phase_complete.generate.git.commit` 记录不一致。
5. `project-manifest.json` 的 `phase/domain_phase/final_status` 不一致。
6. `phase_complete.payload.artifacts` 缺失，但一致性脚本没有拦住。
7. `run_quality_gates.py` 的 `py_compile` 会写 `__pycache__`，在真实 session 中触发权限问题。

## 3. 具体问题

### 3.1 session_state 结构不符合当前协议

当前文件：

`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\session_state.upy_generate_plugin.json`

当前结构类似：

```json
{
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "upy-generate-plugin",
  "manifest_hash": "af506d3958e99f897bc2dc5ba8538c34e528b7a4",
  "git_commit": "af506d3958e99f897bc2dc5ba8538c34e528b7a4",
  "usage": {
    "token_budget_status": "ok",
    "remaining_budget": null
  },
  "last_checkpoint": "phase_completed",
  "status": "completed",
  "updated_at": "2026-06-24T13:30:00Z"
}
```

用当前脚本校验失败：

```powershell
python -X utf8 upy-generate-plugin\scripts\update_session_state.py --session-dir G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2 --check
```

缺失字段：

- `protocol_version`
- `checkpoint`
- `attempt`
- `idempotency_key`

#### 影响

- checkpoint/resume 不能可靠执行。
- 后续 retry/cancel/timeout 无法根据标准状态机恢复。
- `phase_complete.result=success` 可信度下降。

#### 修复方案

生成阶段必须调用 `scripts/update_session_state.py` 写入 session state，不允许手写简化 JSON。

完成态应至少包含：

```json
{
  "protocol_version": "1.0",
  "session_id": "022ad742-3269-42e9-ac20-c14f477ecdf2",
  "phase": "upy-generate-plugin",
  "checkpoint": "phase_completed",
  "step": "phase_complete",
  "status": "completed",
  "attempt": 1,
  "idempotency_key": "upy-generate-plugin:022ad742-3269-42e9-ac20-c14f477ecdf2:phase_complete:v1",
  "manifest_hash": "<project-manifest.json sha256>",
  "git_commit": "<final HEAD commit>",
  "usage": {
    "token_budget_status": "ok",
    "remaining_budget": null
  }
}
```

建议在 skill 中强化：`phase_complete` 写出前必须重新运行 `update_session_state.py --check`，且使用磁盘真实文件结果写入 `payload.checks.session_state_checkpoint`。

### 3.2 phase_complete 没有反映真实 session_state 校验结果

当前 `phase_complete.payload.checks.session_state_checkpoint` 是简化嵌入结构：

```json
{
  "returncode": 0,
  "ok": true,
  "state": {
    "manifest_hash": "af506d3958e99f897bc2dc5ba8538c34e528b7a4",
    "git_commit": "af506d3958e99f897bc2dc5ba8538c34e528b7a4",
    "usage": {
      "token_budget_status": "ok",
      "remaining_budget": null
    }
  }
}
```

但磁盘真实 `session_state.upy_generate_plugin.json` 用当前脚本校验是失败的。

#### 影响

- `phase_complete` 声称 session checkpoint 通过，但真实 checkpoint 文件不通过。
- `check_phase_complete_consistency.py` 目前没有发现这个矛盾。

#### 修复方案

修改 `scripts/check_phase_complete_consistency.py`：

1. 如果传入 `--project-dir`，推导 session 根目录或增加显式 `--session-dir`。
2. 对 `session_state.upy_generate_plugin.json` 调用 `update_session_state.py --check` 或复用其校验函数。
3. 比较磁盘校验结果与 `payload.checks.session_state_checkpoint`：
   - `ok` 必须一致。
   - `state.session_id/checkpoint/status/idempotency_key/manifest_hash/git_commit/usage` 必须存在。
   - completed success 必须拒绝缺字段或简化 state。

建议新增错误码：

- `SESSION_STATE_DISK_CHECK_FAILED`
- `SESSION_STATE_CHECKPOINT_STATE_INCOMPLETE`
- `SESSION_STATE_PHASE_COMPLETE_MISMATCH`

### 3.3 manifest_hash 写成了 git commit

当前 session_state：

```text
manifest_hash = af506d3958e99f897bc2dc5ba8538c34e528b7a4
```

这实际是一个 git commit，不是 manifest 文件 hash。

当前 `project-manifest.json` 的 SHA256 是：

```text
5C2861F0ED6E9C562428E53D3B1FADD2BE841B2C24FBEE05BEE7EA10D304FA87
```

#### 影响

- 恢复时无法判断 manifest 是否发生变化。
- retry/idempotency 的关键输入摘要失真。
- 后续阶段无法根据 manifest_hash 做一致性比对。

#### 修复方案

修改 generate 流程：

- `manifest_hash` 必须取 `project/project-manifest.json` 文件内容 SHA256。
- `git_commit` 才记录 git commit。
- 不允许二者相同，除非有极小概率 hash 碰撞；脚本可直接加规则：如果 `manifest_hash == git_commit` 且长度为 40，则报警。

建议修改 `update_session_state.py --check`：

- completed success 下，若 `manifest_hash` 看起来像 40 位 git SHA 且等于 `git_commit`，输出 warning 或 error。
- 更严格方案：在有 `--project-dir` 时直接计算 manifest SHA256 比对。

### 3.4 git commit 记录不是最终 HEAD

当前 project HEAD：

```text
3a790dbb1d4f806fe0e7e50ead750078d0cde226
```

但 `phase_complete.payload.generate.git.commit` 和 `session_state.git_commit` 记录：

```text
af506d3958e99f897bc2dc5ba8538c34e528b7a4
```

日志显示：

- Commit 1：`af506d3 generate: voice conversation assistant firmware (Alibaba Cloud Bailian mock mode)`
- Commit 2：`3a790db generate: update project manifest with git commit hash`

最终 phase_complete/session_state 没有更新到 Commit 2。

#### 影响

- 下游 deploy/simulate 拿到的 commit 不是最终产物 commit。
- 修复历史和回滚点不准确。
- 如果 autofix 根据 commit 开始，会基于旧版本定位。

#### 修复方案

不要做“commit 后再修改 manifest 再 commit”的循环式写法。

推荐流程：

1. 所有代码、manifest、session_state 草稿、phase_complete 草稿都先写完。
2. 跑全部质量门禁。
3. git add + git commit。
4. 获取最终 HEAD。
5. 更新 `session_state.git_commit`、`manifest.generate.git.commit`、`phase_complete.payload.generate.git.commit`。
6. 再 commit 一次会产生循环，所以更合理的是：
   - 方案 A：git commit 字段记录为当前 HEAD，但不把 commit hash 回写到被 commit 的文件里，只写到 phase_complete/session_state 这类 session artifact。
   - 方案 B：允许第二个 metadata commit，但最终 phase_complete/session_state 必须记录第二个 commit。

更推荐方案 A：`project-manifest.json` 不强制内嵌最终 commit hash，避免自引用循环。

### 3.5 project-manifest 阶段字段不一致

当前：

```text
phase=generate
domain_phase=scaffold
final_status=scaffolded
```

#### 影响

- 下游可能根据 `domain_phase/final_status` 误判还在 scaffold 阶段。
- `phase_complete.manifest_content` 不是完整一致的 generate 状态。

#### 修复方案

成功生成后统一写入：

```json
{
  "phase": "generate",
  "domain_phase": "generate",
  "final_status": "generated"
}
```

修改 `check_phase_complete_consistency.py`：

- success 下要求 `payload.manifest_content.domain_phase == "generate"`。
- 如果 `final_status` 存在，必须是 `generated` 或明确的 generate 成功状态。
- 如果传入 `--project-dir`，磁盘 `project-manifest.json` 也必须满足同样规则。

### 3.6 phase_complete.payload.artifacts 缺失

当前 `phase_complete.payload` 没有 `artifacts` 字段。

但 success 应该包含至少：

```json
{
  "artifacts": [
    {"type": "file_manifest", "path": "generate_file_manifest.json"},
    {"type": "session_state", "path": "session_state.upy_generate_plugin.json"}
  ]
}
```

#### 影响

- 下游插件无法稳定发现 session_state 和 file manifest。
- UI/本地测试无法统一展示产物。

#### 修复方案

修改 `check_phase_complete_consistency.py`：

- success 下 `payload.artifacts` 必须存在且为 list。
- 必须包含 `type=session_state`。
- 必须包含 `type=file_manifest`。

当前脚本只在 artifacts 是 list 时检查缺少 session_state；如果 artifacts 为 null 或缺失，没有报错。应修复为：缺失 artifacts 直接 error。

建议错误码：

- `ARTIFACTS_MISSING`
- `SESSION_STATE_ARTIFACT_MISSING`
- `FILE_MANIFEST_ARTIFACT_MISSING`

### 3.7 run_quality_gates.py 的 py_compile 会写 __pycache__ 并触发权限问题

执行：

```powershell
python -X utf8 upy-generate-plugin\scripts\run_quality_gates.py --project-dir ... --session-dir ...
```

失败：

```text
PermissionError: [WinError 5] 拒绝访问: '...\project\device\tests\__pycache__'
```

#### 影响

- 质量门禁在真实 session 上可能不稳定。
- 即使代码没问题，也可能因为缓存目录权限失败。
- 运行检查可能污染项目目录。

#### 修复方案

修改 `run_quality_gates.py`：

- 在脚本入口设置：

```python
sys.dont_write_bytecode = True
```

- 不要用会默认写 `__pycache__` 的 `py_compile.compile(str(path), doraise=True)`。
- 可改成临时 cfile：

```python
with tempfile.TemporaryDirectory() as tmp:
    cfile = Path(tmp) / (path.stem + ".pyc")
    py_compile.compile(str(path), cfile=str(cfile), doraise=True)
```

或者用 AST parse 做语法检查，但 py_compile 更接近当前语义。

同时建议：

- `py_compile` 检查不应向 project 写任何文件。
- smoke tests 增加“只读/受限目录下 py_compile 不写 __pycache__”用例。

## 4. 当前业务代码观察

这次业务代码方向整体是合理的：

- `device/tests` 下有 4 个设备端 contract tests。
- `test/device` 下还有兼容 smoke tests。
- PC tests 覆盖较多，日志记录 36/36 pass。
- `generate_plan.json` 声明了 cloud integrations、resource_plan、scheduler_mode。
- 阿里云百炼 mock_only 时 `next_phase=null` 是合理的，避免未配置 API Key 时直接 deploy。

但还有一个轻微问题：

`generate_plan.main_assembly` 缺少显式 `imports/drivers/tasks` 字段，只是 warning。建议后续补齐，因为这能让 plan 更适合审查和下游图生成。

## 5. 建议修改清单

### 5.1 scripts/update_session_state.py

建议增强：

- 支持 `--project-dir`，用于计算并校验 `project-manifest.json` SHA256。
- completed success 下强制：
  - `protocol_version`
  - `checkpoint`
  - `attempt`
  - `idempotency_key`
  - `manifest_hash`
  - `git_commit`
  - `usage`
- 拒绝旧字段 `last_checkpoint` 替代 `checkpoint`。
- 检测 `manifest_hash == git_commit` 这种明显误用。

### 5.2 scripts/check_phase_complete_consistency.py

建议增强：

- success 下 `payload.artifacts` 必须存在。
- success 下 artifacts 必须包含 `session_state` 和 `file_manifest`。
- success 下 `checks.session_state_checkpoint.state` 必须是完整 session_state，不是简化 state。
- 如果有 `--project-dir` 或新增 `--session-dir`，必须校验磁盘真实 `session_state.upy_generate_plugin.json`。
- 校验 `payload.generate.git.commit` 与当前 HEAD 一致，或者明确记录为什么不是 HEAD。
- 校验 manifest_content 与 project-manifest 的 `domain_phase/final_status`。

### 5.3 scripts/run_quality_gates.py

建议增强：

- `py_compile` 不写项目 `__pycache__`。
- 脚本入口设置 `sys.dont_write_bytecode = True`。
- 对 PermissionError 输出结构化错误，而不是 traceback 崩溃。

### 5.4 SKILL.md / references/validation_gates.md

建议补充硬规则：

- `session_state` 必须由 `update_session_state.py` 写出，不允许手写简化 JSON。
- `manifest_hash` 是 manifest 文件 hash，不是 git commit。
- 最终 `git_commit` 必须是最终可交付 HEAD，或者明确记录 metadata commit 策略。
- `phase_complete.payload.artifacts` 是 success 必填。
- `project-manifest.json` 的 `phase/domain_phase/final_status` 必须一致进入 generate。

### 5.5 test/smoke_tests.py

建议新增负例：

1. `phase_complete` 内 `session_state_checkpoint.ok=true`，但磁盘 session_state 缺字段，应失败。
2. `payload.artifacts` 缺失，应失败。
3. `manifest_hash == git_commit` 且是 40 位 SHA，应失败或 warning。
4. `project-manifest.json phase=generate` 但 `domain_phase=scaffold`，应失败。
5. `run_quality_gates.py` 在只读/受限 `__pycache__` 场景下不能 traceback。

## 6. 推荐修复优先级

### P0

1. 修复 `session_state` 写出流程，禁止手写简化 JSON。
2. 修复 `check_phase_complete_consistency.py` 对 artifacts/session_state 磁盘校验的缺口。
3. 修复 `manifest_hash` 与 `git_commit` 混用。
4. 修复 `project-manifest.json` 的 `domain_phase/final_status`。

### P1

1. 修复 `run_quality_gates.py` 的 py_compile 缓存写入问题。
2. 统一最终 commit 记录策略。
3. 补齐 `generate_plan.main_assembly.imports/drivers/tasks`。

### P2

1. 优化日志编码显示问题。
2. 把 final_review warnings 中的 scaffold helper 使用情况变成更清晰的 advisory。

## 7. 建议下一步

下一步可以直接修改 `upy-generate-plugin`：

1. 先修验证脚本，让当前 session 的问题能被稳定拦住。
2. 再修 SKILL.md，让下一次 generate 不再手写简化 session_state。
3. 最后同步到 `C:\Users\Administrator\.claude\skills` 后重新跑一次该 session。

当前不建议先改业务生成代码，因为业务代码的核心门禁大多已过，真正风险在协议一致性和验证闭环。
