# Skill 协议本地测试指南

这份文档给改 MicroPython 项目生成 skill / phase recipe 的人看。它专门解决
`MicroPython_Skills#1 skill不适配啊哥` 里指出的问题：原始 `SKILL.md`
是写给本地 agent 的，云端 LLM 不能照字面跑本地命令，必须通过插件协议发消息。

## 先说结论

**fixture 测试不能单独证明 skill 已经适配。**

正确验收分两层：

```text
第一层：recipe / prompt 适配测试
  证明真实 LLM 在 ADAPTER_PREAMBLE + 原始 SKILL.md + PROTOCOL RECIPE 下
  会发出正确协议工具，而不是照抄本地 agent 步骤。

第二层：插件协议执行测试
  给定一段正确协议工具调用，证明插件能接住、渲染、写文件、推进 phase。
```

我新增的 `protocol:fixture` 属于第二层。它能证明插件协议执行链路没断，不能证明
DeepSeek 一定会按 recipe 输出这些消息。

## issue #1 到底在测什么

issue #1 的核心是：

```text
原始 SKILL.md 是给本地 agent 的
  -> 里面有 python --version、python -c、AskUserQuestion、mpremote、G:/... 脚本路径
  -> 云端 LLM 只有协议工具，没有本地 Bash/Read/AskUserQuestion/mpremote
  -> 只加通用 adapter 不够，模型会照字面发 script_run 或写散文
  -> 所以每个 phase 需要一段我们维护的 PROTOCOL RECIPE
```

因此，skill 作者的第一责任不是先跑插件 fixture，而是先确认：

- 这个 phase 有没有对应 `PROTOCOL RECIPE`
- recipe 是否明确覆盖原始 skill 里的本地步骤
- 真实模型 smoke 是否证明模型会听 recipe

## 分工

```text
skill / recipe 作者
  -> 写或维护 PROTOCOL RECIPE
  -> 跑真实模型 smoke/e2e，证明模型会发协议工具
  -> 产出或更新 fixture，作为“正确协议输出样例”

插件作者
  -> 用同一份 fixture，证明插件能执行这些协议消息

后端作者
  -> 维护 adapter、recipe、payload validation、server-side codegen

硬件测试
  -> 最后验证真实板子、驱动、接线和串口结果
```

## 第一层：recipe / prompt 适配测试

这一层直接回答 issue #1：模型还会不会把本地 agent 步骤照字面跑？

### analyze phase

在 `mpyhw-api/` 目录下运行：

```powershell
python scripts/smoke_analyze_protocol.py "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警"
```

这个测试需要 `DEEPSEEK_API_KEY`，会调用真实模型。

通过标准：

- 输出 `GATE: PASS`
- 所有 tool call 都在 6 个协议工具内
- payload 全部符合 `contracts/protocol_messages.json`
- 能到达 `approval_request`
- 不以无关的环境预检 `script_run` 开头
- 普通文本里没有 `mpremote`、```bash、`pip install` 等 raw shell smell

如果这个不过，问题优先在 `routes_llm.py` 的 adapter / recipe，或者对应
`SKILL.md` 的表达太容易诱导模型照字面执行。

### 多 phase

在 `mpyhw-api/` 目录下运行：

```powershell
python scripts/e2e_protocol.py "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数"
```

这个测试也需要真实模型。它模拟“薄插件”：自动确认 approval、写临时项目目录、
mock device/script，但走真实 prompt、真实 DeepSeek、真实 codegen interception、
真实 payload validation。

通过标准：

- 输出 `E2E: PASS`
- 没有 off-protocol tool
- payload validity 至少 95%
- 至少跑到 generate
- 写出 `firmware/main.py`
- `firmware/main.py` 包含 `MPYHW_READY`

## 第二层：插件协议执行测试

这一层不测模型，只测插件能不能执行一段已经正确的协议消息。

在 `mpy-hardware-extension/` 目录下运行：

```powershell
npm run protocol:fixture -- test/fixtures/protocol-smoke.json
```

期望输出类似：

```text
terminal=complete
phases=analyze:success -> generate:success
files=firmware/main.py
approvals=1
device_calls=(none)
script_runs=(none)
```

这条命令不需要：

- 本地 `mpyhw-api`
- 数据库
- DeepSeek key
- Render
- VS Code
- 真实开发板

它只验证：插件协议执行层能不能接住一段模拟出来的协议消息。

## fixture 是什么

fixture 是一个 JSON 文件，模拟“模型按照 recipe 正确运行时会发出来的协议工具调用”。

最小结构：

```json
{
  "intent": "make an ESP32 temperature alarm",
  "script": {
    "analyze": [
      [
        {
          "name": "approval_request",
          "input": {
            "approval_id": "device_confirm",
            "question": "Confirm parts?",
            "items": [{ "id": "sensor", "name": "Temperature sensor" }],
            "actions": [{ "label": "Confirm", "value": "confirm", "primary": true }]
          }
        }
      ],
      [
        {
          "name": "phase_complete",
          "input": {
            "result": "success",
            "summary": "Analysis complete",
            "next_phase": "generate",
            "manifest_content": { "phase": "analyze" }
          }
        }
      ]
    ]
  }
}
```

解释：

- `intent`：用户输入的一句话。
- `script`：按 phase 分组。
- `analyze`、`generate` 等 key：对应当前 pipeline phase。
- 每个 phase 里是多个 turn。
- 每个 turn 里是这个 turn 模型会发出的工具调用。
- 每个工具调用必须有 `name` 和 `input`。
- 每个 phase 最后都应该发 `phase_complete`。

## 推荐验收顺序

改 skill 或 recipe 后，按这个顺序：

1. 静态检查：确认 `routes_llm.py` 里对应 phase 有 `PROTOCOL RECIPE`。
2. 真实模型 smoke：analyze 改动跑 `smoke_analyze_protocol.py`。
3. 多 phase 改动跑 `e2e_protocol.py`。
4. 把通过 smoke/e2e 的目标协议输出整理成 fixture。
5. 跑插件 fixture：

   ```powershell
   cd mpy-hardware-extension
   npm run protocol:fixture -- <你的-fixture.json>
   ```

6. 跑插件 focused check：

   ```powershell
   node --no-warnings --experimental-strip-types --test test/protocol-fixture.test.ts test/protocol-loop.test.ts
   npm run typecheck
   ```

7. 最后再测 VS Code、云端、真实硬件。

## 常见失败怎么看

`smoke_analyze_protocol.py` 不是 `GATE: PASS`

recipe 没压住原始 `SKILL.md`，或者模型仍在照字面执行本地步骤。优先改
`mpyhw-api/app/routes_llm.py` 的 `PROTOCOL RECIPE`。

真实模型第一步发 `script_run`

典型 issue #1。说明模型还在跑本地环境预检。analyze recipe 必须明确写：
协议模式没有环境预检，不要发 `script_run` 查 python/requests。

真实模型只输出散文/Markdown 表格

也是 issue #1。recipe 必须明确写：不要把分析写成散文或表格，第一步发
`approval_request`。

`terminal=stalled`

插件 fixture 里的某个 phase 没有发 `phase_complete`，或者 turns 用完了。

`unknown_tool`

模型或 fixture 还在用旧 27-tool 名称。应该改成 6 个协议工具之一。

`protocol_payload_invalid`

工具名对了，但 `input` 不符合 `contracts/protocol_messages.json`。看 required
字段、enum 值和嵌套结构。

`files=(none)`

生成阶段没有通过 `file_operation` 写文件。比如 `generate` phase 应该至少写
`firmware/main.py`。

`approvals=0`

需要用户确认、选择、补充信息，但没有发 `approval_request`。不要用普通
assistant text 问用户。

## 要不要补代码

短期必须补的是文档和测试流程，不是大改插件。

如果继续加代码，优先级是：

1. 把 `smoke_analyze_protocol.py` 泛化成可测任意 phase 的 `smoke_phase_protocol.py`。
2. 给每个 phase 加一份 golden fixture，作为插件协议执行样例。
3. 给后端加 DB-free 的 recipe 静态检查，确保 served phase 都有 recipe，且关键禁令存在。

但 issue #1 的根本修复仍然是：每个 phase 维护清楚的 `PROTOCOL RECIPE`，并用真实模型 smoke/e2e 验证。

## 相关文件

协议合同：

- `contracts/protocol_messages.json`

插件协议执行：

- `mpy-hardware-extension/src/core/protocol-loop.ts`
- `mpy-hardware-extension/src/core/protocol-build.ts`
- `mpy-hardware-extension/src/core/protocol-fixture.ts`
- `mpy-hardware-extension/src/cli/run-protocol-fixture.ts`

测试和示例：

- `mpy-hardware-extension/test/protocol-fixture.test.ts`
- `mpy-hardware-extension/test/protocol-loop.test.ts`
- `mpy-hardware-extension/test/fixtures/protocol-smoke.json`

后端 skill/prompt 入口：

- `mpyhw-api/app/routes_llm.py`
- `mpyhw-api/app/skill_catalog.py`
- `mpyhw-api/scripts/smoke_analyze_protocol.py`
- `mpyhw-api/scripts/e2e_protocol.py`
- `third_party/MicroPython_Skills/*/SKILL.md`
