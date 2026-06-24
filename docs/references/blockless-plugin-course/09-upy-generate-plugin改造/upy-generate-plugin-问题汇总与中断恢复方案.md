# upy-generate-plugin 测试问题汇总与中断恢复方案

## 1. 结论

这次 skill 测试整体已经能跑通，但还剩两类需要继续收敛的问题：

1. `project/test/device` 现在更像 smoke/import 测试，不是完整的设备端 unittest 套件。
2. 生成过程中对断网、429、token/额度耗尽、上下文超长、用户取消的恢复语义还需要继续明确化。

已经处理掉的点包括：stale session 误读、`pylint` 跳过仍标 success、`generate_plan` 落盘校验、git commit 语义、async 阻塞调用检查。

## 2. 这次测试里暴露的问题

### 2.1 stale 旧 generate 记录会误导恢复

- session 根目录里的 `phase_complete.upy_generate_plugin.json` 和 `generate_phase_log.md` 可能还在。
- 但 `project/` 已经被 `git restore` / `git clean` 恢复到 scaffold。
- 这时旧 `phase_complete` 不能再当当前状态使用，只能当审计记录。

### 2.2 `project/test/device` 过弱

当前生成的 `project/test/device/test_*_smoke.py` 主要是：

- import 是否成功
- factory 是否存在
- 基础实例化是否成功

它们更像 smoke tests，不是完整的设备端行为测试。

参考工程 `G:\MicroPython_Claude_Assistant\device\tests\` 里的测试更接近真正的设备侧 unittest：

- `test_protocol.py`
- `test_rotating_logger.py`
- `test_session_manager.py`
- `test_state.py`

这类测试是可执行、可断言行为的，不只是导入检查。

### 2.3 旧门禁语义曾经偏松

历史上存在过这些风险：

- `.pylintrc` 缺失时，`pylint` 被跳过但仍标 success
- `generate_plan.json` 只做结构检查，没检查实际文件是否生成
- success 没强制要求 `generate_plan.json` 出现在 file manifest
- success 没强制要求 optional next phases 提供 `upy-diagram-plugin` / `upy-wiring-plugin`
- success 没强制要求 git commit 完成

这些已经在 skill/脚本里补上，但后续仍要保持。

### 2.4 async 任务里阻塞调用风险

现在 skill 已经开始拦截，但仍要继续盯：

- `time.sleep_ms`
- `read_samples`
- `play_samples`
- `connect`
- 同步 HTTP/network 调用

这些一旦出现在 `async def` 里，就会把协程卡死。

### 2.5 本地验证残留物

- `__pycache__` 会在 `test/pc`、`test/device` 下出现
- 这类文件不是业务产物，但会污染 git 状态
- 建议由测试脚本或 `.gitignore` 清理/屏蔽

## 3. 文件清单与对应处理方法

| 文件/目录 | 问题 | 处理方法 |
|---|---|---|
| `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\phase_complete.upy_generate_plugin.json` | 旧 success 记录会误导恢复 | 已归档，且用 `scripts/check_session_state.py` 识别 stale |
| `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\generate_phase_log.md` | 旧日志不应驱动新的 generate | 与旧 phase_complete 一起归档，不再作为当前状态 |
| `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\test\device\test_*_smoke.py` | 只是 smoke/import 测试 | 升级为真正的设备端 unittest，或迁移到 `device/tests` |
| `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\test\pc\test_*` | PC 单测方向正确 | 保持 `test/pc`，继续覆盖行为和异常 |
| `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project\test\device\__pycache__` | 测试残留缓存 | 清理或忽略，别让它进入生成产物判断 |
| `G:\MicroPython_Skills\upy-generate-plugin\scripts\check_session_state.py` | 新增 stale 检测 | 已加入，作为恢复前必跑检查 |
| `G:\MicroPython_Skills\upy-generate-plugin\scripts\check_phase_complete_consistency.py` | success 语义需要更严 | 已收紧 pylint / git / file_manifest / optional phases |
| `G:\MicroPython_Skills\upy-generate-plugin\scripts\check_generated_semantics.py` | async 阻塞调用未充分拦截 | 已补充 blocking I/O 检测 |
| `G:\MicroPython_Skills\upy-generate-plugin\test\run_local_mock_session.py` | 本地 runner 以前可能把 dry-run 当 success | 已改成 commit 成功才算 success |
| `G:\MicroPython_Skills\upy-generate-plugin\SKILL.md` | 规则分散 | 已补充 stale、device tests、断网中断、git 语义 |
| `G:\MicroPython_Skills\upy-generate-plugin\references\validation_gates.md` | 门禁顺序不够清晰 | 已补充 `check_session_state.py` 与最终 plan/file gate |
| `G:\MicroPython_Skills\upy-generate-plugin\references\protocol_fields.md` | resume/stale 语义不够明确 | 已补充 stale 与 success consistency 规则 |
| `G:\MicroPython_Skills\upy-generate-plugin\references\task_generation_rules.md` | async 阻塞规则不够具体 | 已补充禁止清单 |

## 4. `project/test/device` 应该怎么定位

我建议把测试分成两层：

1. `test/pc`：CPython 侧单测，测状态机、mock、行为逻辑。
2. `device/tests` 或等价设备侧目录：MicroPython 可运行的设备端 unittest。

如果继续保留 `test/device`，那里面的代码至少应该满足：

- 不是只有 import 检查
- 有真实行为断言
- 不依赖 pytest
- 不使用 CPython-only API
- 结构上接近 `G:\MicroPython_Claude_Assistant\device\tests\*.py`

更激进一点的做法是：

- `test/device` 只保留最小 smoke wrapper
- 真正设备端测试移到 `device/tests`

这样职责会更清楚。

## 5. 断网 / token 耗尽 / 超时 / 取消怎么处理

### 5.1 需要覆盖的失败模式

- 上游断网
- Provider 429 / rate limit
- 额度/Token 耗尽
- 上下文窗口超限
- 单步超时
- 用户取消
- 模型输出被截断

### 5.2 推荐的处理策略

1. 每个大步骤都写 checkpoint。
2. 每个文件写入都保持幂等。
3. 发生中断时，不要补写猜测内容。
4. 能保留的产物先保留，无法保证正确性的阶段直接停在 `partial`。
5. 恢复时读取 `session_state.json` / checkpoint，再接着跑，不从头重来。

### 5.3 建议的 structured error

- `NETWORK_DISCONNECTED`
- `UPSTREAM_TIMEOUT`
- `RATE_LIMITED`
- `TOKEN_BUDGET_EXCEEDED`
- `MODEL_CONTEXT_EXHAUSTED`
- `CANCELLED_BY_USER`

建议语义：

- `retryable=true`：断网、超时、429
- `retryable=false`：token 耗尽、上下文耗尽，除非用户换模型/加额度

### 5.4 建议的恢复状态

建议 session 里固定保留：

- `session_id`
- `checkpoint`
- `idempotency_key`
- `attempt`
- `last_ok_artifact`
- `manifest_hash`
- `git_commit`
- `remaining_budget` 或使用量摘要

### 5.5 用户侧提示

如果是 token/额度问题，skill 应该优先给出：

- provider console 链接
- billing / quota / API key 链接
- 当前阶段已完成的 checkpoint
- 下一步可恢复的位置

## 6. 建议的下一步

1. 先决定设备测试的最终目录：继续用 `test/device`，还是改成 `device/tests`。
2. 给生成流程加“中断模拟”测试：断网、429、token 耗尽、用户取消。
3. 让 device 测试从 smoke 升级到真正的行为测试。
4. 保持 `check_session_state.py` 作为恢复前固定步骤。
5. 如果要继续扩展模型接入场景，把断网/额度耗尽写成标准 structured error，而不是泛化成“生成失败”。
