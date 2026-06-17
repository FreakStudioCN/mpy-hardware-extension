# Skill 协议本地测试指南

这份文档给改 MicroPython 项目生成 skill 的人看。目的不是讲完整架构，而是说明：
改完 skill 后，先怎么在本机验证它能不能和插件协议配合，避免一上来就测云端、DeepSeek、VS Code、真实硬件，把问题混在一起。

## 核心结论

先由写 skill 的人测试。

写 skill 的人先证明：这个 skill 想做的事情，能被表达成插件协议消息。也就是：

- 需要用户确认或选择：用 `approval_request`
- 展示进度：用 `status_update`
- 读写项目文件：用 `file_operation`
- 跑本地工具链脚本：用 `script_run`
- 操作开发板、串口、mpremote：用 `device_command`
- 每个阶段结束：用 `phase_complete`

这一步过了以后，插件开发者再拿同一份 fixture 测 UI、本地文件写入、脚本执行、设备执行器和 phase 推进。

这样可以把问题拆开：

- fixture 跑不过：优先看 skill 输出或协议适配。
- fixture 跑过，但 VS Code 不行：优先看插件 UI / SessionController / executor。
- 本地插件跑过，云端不行：优先看后端 prompt、鉴权、credits、部署版本。
- 云端跑过，硬件不行：优先看接线、驱动、shim、mpremote、串口输出。

## 本地快速测试

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

它只验证一件事：插件协议执行层能不能接住一段模拟出来的协议消息。

## fixture 是什么

fixture 是一个 JSON 文件，模拟“模型按照 skill 运行时会发出来的协议工具调用”。

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

每个 phase 最后都应该发 `phase_complete`。如果没有，协议循环会认为这个 phase 卡住，结果通常是 `terminal=stalled`。

## skill 作者应该怎么测

改完某个 skill 或 phase recipe 后，按这个顺序做：

1. 写一份 fixture，描述这个 phase 的 happy path。
2. 运行：

   ```powershell
   cd mpy-hardware-extension
   npm run protocol:fixture -- <你的-fixture.json>
   ```

3. 确认 `terminal=complete`。
4. 确认 `phases=...` 和你设计的阶段流一致。
5. 确认该写文件的阶段，`files=...` 里有目标文件。
6. 确认需要用户确认的阶段，`approvals=...` 数量不为 0。
7. 确认不该碰硬件的阶段，`device_calls=(none)`。
8. 确认不该跑脚本的阶段，`script_runs=(none)`。

然后跑插件侧的 focused check：

```powershell
node --no-warnings --experimental-strip-types --test test/protocol-fixture.test.ts test/protocol-loop.test.ts
npm run typecheck
```

这些过了，再去测后端、云端和真实硬件。

## 常见失败怎么看

`terminal=stalled`

某个 phase 没有发 `phase_complete`，或者 fixture 的 turns 用完了。先看 skill/recipe 有没有明确要求阶段结束时发 `phase_complete`。

`unknown_tool`

模型或适配层还在发旧工具名，比如旧的 27-tool 名称。应该改成 6 个协议工具之一。

`protocol_payload_invalid`

工具名对了，但 `input` 不符合 `contracts/protocol_messages.json`。先看 required 字段、enum 值和嵌套结构。

`files=(none)`

生成阶段没有通过 `file_operation` 写文件。比如 `generate` phase 应该至少写 `firmware/main.py`。

`approvals=0`

需要用户确认、选择、补充信息，但没有发 `approval_request`。不要用普通 assistant text 问用户，因为插件协议循环不会把普通文本当成可交互问题。

`device_calls` 出现在不该碰硬件的阶段

说明 skill/recipe 太早让模型操作设备。比如 analyze/select/generate 通常不应该直接碰硬件。

`script_runs` 出现在不该跑脚本的阶段

说明模型还在照搬本地 agent 版 skill 的脚本步骤，而不是按协议模式走。需要加强 phase recipe 或改 skill 表述。

## 什么时候再测云端

只有本地 fixture 过了，才往外扩：

1. 后端 prompt/contract 测试。
2. 真实模型 protocol smoke。
3. headless E2E。
4. VS Code F5 手工测试。
5. 云端 Render 测试。
6. 真实硬件测试。

不要第一步就测云端或硬件。那会同时引入 skill、协议、后端、鉴权、credits、部署版本、插件 UI、shim、驱动和接线问题，定位成本太高。

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
- `third_party/MicroPython_Skills/*/SKILL.md`

## 分工逻辑

这套测试的分工是：

```text
skill 作者
  -> 写 fixture，证明 skill 的动作能表达成协议消息

插件作者
  -> 用同一份 fixture，证明插件能执行这些协议消息

后端作者
  -> 证明真实 LLM 在真实 prompt 下会发出同样合规的协议消息

硬件测试
  -> 最后验证真实板子、驱动、接线和串口结果
```

这样改 skill 的人不需要等插件完整调好，插件的人也不需要懂每个硬件 skill 的细节。双方通过 fixture 对齐边界。
