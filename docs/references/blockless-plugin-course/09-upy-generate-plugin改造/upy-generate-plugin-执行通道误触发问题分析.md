# upy-generate-plugin 修复过程中的执行通道误触发问题分析

## 背景

本次问题不是 `upy-generate-plugin` 的业务代码缺陷，而是代理在执行修复任务时发生的交互流程事故：在尚未完成验证、尚未形成最终结论的情况下，多次向 `final` 通道发送了空消息或提前结束消息，导致用户看到“误触发”“空 final”“明明没完成却像结束了”的表现。

这类问题会直接影响复杂 skill 改造任务的可靠性。尤其是 `upy-generate-plugin` 这种需要连续完成代码修改、样例同步、文档同步、smoke 测试和后续同步的任务，一旦中途错误进入 final，就会破坏用户对当前状态的判断。

## 现象

本轮修复过程中出现了以下现象：

1. 多次空 `final` 回复。
2. 在尚未跑完 smoke tests 时提前进入最终答复。
3. 已经声明“继续修复”，但实际又在中途收尾。
4. 用户要求“继续修复”后，代理仍然反复解释“误发空 final”，造成噪声。
5. 最后一次继续时，已经开始检查进程和 diff，但又再次进入 final，导致任务再次中断。

这些现象的共同点是：任务状态还处于 `in_progress`，但对话层已经表现成 `complete/finished`。

## 直接根因

### 1. final 通道使用边界失守

正确约束应该是：

- `commentary`：只用于中间进度、工具调用前后说明。
- `final`：只用于所有工作完成后的最终总结。

实际发生的问题是，代理在中间执行阶段错误发出了 `final`。这不是 `apply_patch`、`shell_command` 或 smoke 测试本身导致的，而是执行代理没有严格维护“最终答复只能在闭环完成后出现”的状态机。

### 2. 中间状态没有被硬性建模

当任务是“修复 skill 并验证”时，至少应该维护下面状态：

```text
inspect -> patch -> validate -> fix_regression -> final_summary
```

实际执行中，虽然有 `update_plan`，但代理没有把“是否允许 final”与 plan 状态绑定。例如：

- 仍有 `in_progress` 项时，不应该发 final。
- smoke tests 未完成时，不应该发 final。
- 用户明确要求继续修复时，不应该用 final 表达暂停。

缺少这个硬约束后，模型容易在阶段性说明后误判为可以结束。

### 3. 误触发后没有立即切换到事故处理模式

第一次空 final 出现后，正确做法应该是：

1. 停止所有非必要修改。
2. 检查当前 diff 和进程。
3. 明确当前任务未完成。
4. 只在用户确认后继续。
5. 继续后严格避免 final，直到验证完成。

实际执行中，代理虽然口头说明了“误发”，但又继续进入修改流程，导致同类问题重复发生。

### 4. 任务复杂度较高，输出节奏过密

本次修复涉及：

- `run_quality_gates.py`
- `check_phase_complete_consistency.py`
- `update_session_state.py`
- `run_local_mock_session.py`
- sample success JSON
- `SKILL.md`
- `protocol_fields.md`
- `validation_gates.md`
- `smoke_tests.py`

这类跨脚本、跨协议、跨测试的修改本身需要分阶段验证。代理在不断解释“我会继续”时产生了太多中间自然语言输出，增加了误用 final 的概率。

## 深层根因

### 1. 没有把“工具执行完成”与“任务完成”区分开

一次 `apply_patch` 成功，只代表一个局部编辑完成，不代表任务完成。

一次 `smoke_tests.py` 启动，也不代表验证完成。

本次代理多次在局部动作后进入总结语气，说明它把局部动作完成误判成了阶段完成，进而错误触发 final。

### 2. 对用户中断后的恢复策略不够严格

用户中断 smoke 后，正确恢复流程应该是：

```text
1. 检查是否有残留进程
2. 检查 git diff
3. 检查是否有临时目录或半写文件
4. 重新跑 smoke
5. 根据失败继续修复
6. 全部通过后 final
```

实际执行中虽然开始做了第 1、2 步，但又进入 final，说明恢复策略没有真正锁定执行流程。

### 3. 缺少“final 前检查清单”

复杂代码任务 final 前至少要检查：

- 是否还有 `update_plan` 的 `in_progress` 或 `pending` 项。
- 是否运行了用户要求的验证命令。
- 是否有命令被中断或超时。
- 是否需要说明未完成项。
- 是否回答的是用户最新请求。

本次没有执行这个 final gate。

## 对 upy-generate-plugin 修复任务的影响

### 已产生的实际影响

1. 修复工作被多次打断，验证没有闭环。
2. 用户无法区分哪些改动已经完成，哪些只是计划中。
3. session checkpoint 相关新增约束虽然已部分写入代码和文档，但 smoke 还没有最终确认。
4. 如果此时直接同步到 `.claude/skills`，风险较高，因为可能带着未验证的中间状态。

### 不应该误判为代码缺陷

本问题不应归因于：

- `upy-generate-plugin` 架构太复杂。
- session/checkpoint 机制设计错误。
- smoke tests 本身导致 final。
- PowerShell 或 Windows 路径问题。

它是代理执行协议层的问题：最终答复通道被错误使用。

## 当前 upy-generate-plugin 工作状态评估

根据中断前的操作，当前大概率处于“部分修复、未验证完成”的状态：

已完成或部分完成：

- `run_quality_gates.py` 增加 `--session-dir`。
- `check_phase_complete_consistency.py` 增加 `session_state_checkpoint` 强校验。
- `run_local_mock_session.py` 增加 `update_session_state.py` 调用。
- success sample JSON 增加 session state 记录。
- `SKILL.md`、`protocol_fields.md`、`validation_gates.md` 增加 session checkpoint 说明。
- `smoke_tests.py` 增加 session checkpoint 正负测试。

未完成：

- 未重新跑完 `python -X utf8 upy-generate-plugin\test\smoke_tests.py`。
- 未根据 smoke 失败修正细节。
- 未检查 local runner 在真实临时 session 下是否成功。
- 未确认 sample success JSON 是否通过 `check_phase_complete_consistency.py`。
- 未同步到 `C:\Users\Administrator\.claude\skills`。

## 建议修复流程

下一次继续修复时，建议严格按下面流程执行。

### 阶段 1：恢复现场

```powershell
Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Select-Object ProcessId,CommandLine,CreationDate
git status --short upy-generate-plugin
git diff --stat -- upy-generate-plugin
```

如果有疑似残留 smoke 进程，先确认命令行；不要直接 kill，除非明确是上次中断残留。

### 阶段 2：单点验证新增脚本

优先跑小验证，不直接跑全量 smoke：

```powershell
python -X utf8 upy-generate-plugin\scripts\check_phase_complete_consistency.py --phase-complete upy-generate-plugin\sample\phase_complete.upy_generate_plugin.success.json
```

再验证 session state helper：

```powershell
python -X utf8 upy-generate-plugin\scripts\update_session_state.py --session-dir <temp-session> --checkpoint started --step start_phase --status running --idempotency-key test:v1
python -X utf8 upy-generate-plugin\scripts\update_session_state.py --session-dir <temp-session> --check
```

### 阶段 3：跑 local runner

```powershell
python -X utf8 upy-generate-plugin\test\run_local_mock_session.py --session-dir <temp-session> --mode async --next-phase simulate --force --allow-git-commit --write-phase-complete
```

检查：

- `session_state.upy_generate_plugin.json` 是否存在。
- `phase_complete.payload.checks.session_state_checkpoint.ok` 是否为 true。
- `file_manifest.files` 是否包含状态文件。
- `artifacts[]` 是否包含 `type=session_state`。

### 阶段 4：跑全量 smoke

```powershell
python -X utf8 upy-generate-plugin\test\smoke_tests.py
```

只有全量 smoke 通过后，才能进入最终总结或同步阶段。

## 代理侧防复发规则

### 规则 1：final 只能在验证完成后发送

当任务类型是“修改/修复/同步/验证”时，final 前必须满足：

- 没有待执行工具调用。
- 没有未完成计划项。
- 验证命令已运行，或明确说明为什么无法运行。
- 用户最新请求已回答。

### 规则 2：中间说明只能用 commentary

修复过程中只允许使用短 `commentary` 更新，例如：

```text
我已经补了 runner 的 session checkpoint 写入，现在跑 sample consistency，看新增强约束是否过紧。
```

不要在中间阶段使用总结性措辞。

### 规则 3：一旦出现空 final，立即进入暂停模式

出现空 final 后，不应继续修改。必须先输出状态分析，并等待用户确认是否继续。

### 规则 4：复杂任务必须维护显式 plan

每次进入修复时都应维护：

```text
1. 恢复现场
2. 修补代码/文档/测试
3. 单点验证
4. 全量 smoke
5. 总结或同步
```

只要第 3、4 步没完成，禁止 final。

## 对 upy-generate-plugin skill 的启示

这个问题也反过来说明，`upy-generate-plugin` 自身设计 session/checkpoint 是必要的。因为真实插件运行也会遇到：

- LLM 输出中断。
- 网络断开。
- token 或额度耗尽。
- 用户取消。
- 工具调用超时。
- 质量门禁跑到一半失败。

因此 skill 里要求 `session_state.upy_generate_plugin.json`、checkpoint/resume、structured error、idempotency key 是合理的。但这些机制必须由脚本和测试验证，不能只写在文档里。

## 结论

本次“误触发 final”问题的根因是代理执行流程没有把 final 通道作为严格的最终状态，而是在中间阶段多次错误收尾。它不是 `upy-generate-plugin` 代码设计问题，但它暴露了复杂 skill 改造时必须有更硬的执行状态机和 final 前检查清单。

后续继续修复时，应先恢复现场，再按单点验证到全量 smoke 的顺序推进。全量验证未通过前，不应同步到 `.claude/skills`，也不应输出最终完成结论。
