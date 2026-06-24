# upy-generate-plugin 业务数据流契约与元数据一致性修复方案

## 背景

当前测试 session：

`G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2`

现有 `phase_complete.upy_generate_plugin.json` 已能通过强一致性检查，`session_state.upy_generate_plugin.json` 也能通过 `update_session_state.py --check`。但继续审查生成代码和元数据后，仍发现几个更深层问题：

1. 生成代码存在真实业务 bug：录音数据在跨状态流转时被丢弃。
2. 继续堆叠 AST 语义门禁并不是最优解，容易复杂化、误报，也抓不住项目特定业务意图。
3. `project-manifest.json` 内 `generate.git.commit` 与最终 HEAD / phase_complete / session_state 不一致。
4. `session_state` 顶层通过校验，但 `artifacts=[]`、`last_ok_artifact=null`，早期 events 里还有 `manifest_hash="unknown"`，中断恢复信息不足。

本文只给修复方案，不修改当前代码。

## 一、真实业务 bug：录音数据被丢弃

### 现象

`firmware/tasks/voice_dialogue.py` 中：

- `LISTENING` 阶段调用 `_mic_record(...)` 得到 `audio_data`
- 状态切换到 `_STATE_PROCESSING`
- 下一次 tick 进入 `PROCESSING`
- 实际调用是 `cloud_client.process_voice(b"")`

也就是说，真实录音结果没有传给 ASR/LLM/TTS 管线。

### 最小代码修复

状态对象需要保存跨 tick 的录音数据：

```python
class VoiceDialogueState:
    def __init__(self):
        self.state = _STATE_IDLE
        self.last_activity_ticks = 0
        self.tts_audio = bytearray()
        self.recorded_audio = bytearray()
```

录音阶段保存：

```python
_state.recorded_audio = _mic_record(mic, conf.VOICE_RECORD_DURATION_MS)
```

处理阶段消费：

```python
_state.tts_audio = await cloud_client.process_voice(_state.recorded_audio)
```

播放完成、错误恢复或重新进入 idle 时清理：

```python
_state.recorded_audio = bytearray()
```

## 二、不建议无限加强语义门禁

这个 bug 的本质不是通用语法或通用 AST 模式错误，而是项目特定的数据流契约缺失。

如果继续增强 `check_generated_semantics.py`，会出现几个问题：

- 规则越来越复杂，难以维护。
- 容易对正常代码误报。
- 只能抓少数写法，换一种状态机结构就失效。
- 无法可靠理解“某个业务数据必须从哪个阶段流向哪个阶段”。

更合理的方向是：让 generate 阶段显式产出业务数据流契约，并强制生成契约测试。

## 三、推荐方案：data_flow_contract

### 设计目标

在 `generate_plan.json` 中增加 `data_flow_contract`，把关键业务数据流从“隐含实现细节”变成“可审查、可测试的生成契约”。

示例：

```json
{
  "data_flow_contract": [
    {
      "name": "recorded_audio",
      "producer": "voice_dialogue.LISTENING",
      "storage": "_state.recorded_audio",
      "consumer": "cloud_client.process_voice",
      "invariant": "cloud_client receives the exact audio bytes returned by mic.record()"
    }
  ]
}
```

### 适用场景

至少以下场景必须生成 `data_flow_contract`：

- 语音链路：mic -> ASR -> LLM -> TTS -> speaker
- 传感器链路：sensor read -> threshold/filter/state -> output/report
- 云 API 链路：payload build -> request -> response parse -> action
- 多阶段状态机：LISTENING -> PROCESSING -> SPEAKING 这类跨 tick 数据流
- 多模块业务管线：driver -> task -> middleware -> output

### 必须生成的测试

对每条关键数据流，生成 PC contract test，而不是只依赖静态检查。

针对录音 bug，应生成类似测试：

```python
class SpyCloudClient:
    def __init__(self):
        self.received_audio = None

    async def process_voice(self, audio_data):
        self.received_audio = audio_data
        return bytearray(b"tts")


class SentinelMic:
    def start_recording(self):
        pass

    def record(self, duration_ms):
        return b"SENTINEL_AUDIO"

    def stop_recording(self):
        pass
```

测试流程：

1. 重置 voice state。
2. 设置状态为 `LISTENING`。
3. 运行一次 tick，让 mic 返回 `b"SENTINEL_AUDIO"`。
4. 再运行一次 `PROCESSING` tick。
5. 断言 `SpyCloudClient.received_audio == b"SENTINEL_AUDIO"`。

这个测试能直接抓住 `process_voice(b"")` 这类 bug。

## 四、skill 层修改建议

### 1. SKILL.md

加入硬性规则：

- 对状态机、语音、传感器、云 API、跨模块数据流，必须先在 `generate_plan.json` 中声明 `data_flow_contract`。
- 不能只生成 import smoke 或 happy path 测试。
- 对每个关键 `data_flow_contract`，必须生成至少一个 PC contract test。
- 语音/传感器数据不能被读取后丢弃；跨 tick 使用时必须存入 state 或明确的队列/缓冲。

### 2. references/task_generation_rules.md

补充状态机模板：

- 状态对象必须保存跨 tick 数据。
- producer 和 consumer 不在同一 tick 时，必须使用 state 字段或队列。
- 处理阶段禁止用空字节、固定 mock payload 替代真实采集结果，除非 manifest 明确是 mock-only 且测试覆盖。

### 3. references/validation_gates.md

加入门禁说明：

- `generate_plan.json` 缺少必要 `data_flow_contract` 时，不能作为 deploy-ready success。
- contract test 缺失时不能 success。
- `check_generated_semantics.py` 只做有限启发式检查，不能代替数据流契约测试。

### 4. check_generate_plan.py

增强结构检查：

- 对 voice/sensor/cloud/state_machine 任务，要求 `data_flow_contract` 非空。
- 每条 data flow 至少包含：
  - `name`
  - `producer`
  - `consumer`
  - `invariant`
  - `test_path` 或 `covered_by_tests`
- 如果 `producer` 和 `consumer` 跨状态/跨 tick，要求声明 `storage`。

### 5. 测试模板

在 references 或 sample 中增加：

- `SpyCloudClient`
- `SentinelMic`
- sensor sentinel value 测试模板
- cloud payload spy 测试模板

## 五、manifest git commit 一致性问题

### 当前问题

当前项目中：

- `git rev-parse HEAD` 是 `8dc42d1006be81bcf7cd81ceadd7a81e9752440c`
- `phase_complete.payload.generate.git.commit` 是 `8dc42d1006be81bcf7cd81ceadd7a81e9752440c`
- `session_state.git_commit` 是 `8dc42d1006be81bcf7cd81ceadd7a81e9752440c`
- 但 `project-manifest.json.generate.git.commit` 仍是 `f49750690fce7f0aad6a16d87537738f7165f415`

现有一致性脚本没有拦住这个差异。

### 注意：不要强制 manifest 自引用最终 HEAD

如果 `project-manifest.json` 被 git 跟踪，强制它写入最终 HEAD 会产生自引用问题：

1. 写入 commit hash。
2. 文件内容变化。
3. 新 commit hash 变化。
4. manifest 里的 hash 又过期。

因此不建议要求：

```text
project-manifest.json.generate.git.commit == final HEAD
```

### 推荐字段拆分

建议把含义拆清楚：

```json
{
  "generate": {
    "git": {
      "code_commit": "f49750690fce7f0aad6a16d87537738f7165f415",
      "commit_role": "code_generation_commit"
    }
  }
}
```

最终交付 HEAD 只放在：

- `phase_complete.payload.generate.git.commit`
- `session_state.git_commit`

并由一致性脚本强制：

```text
phase_complete.payload.generate.git.commit == git rev-parse HEAD
session_state.git_commit == git rev-parse HEAD
```

如果 manifest 仍保留 `generate.git.commit`，必须要求：

- 字段语义明确为 `code_commit`，或
- 同时有 `commit_role`，说明不是 final HEAD。

## 六、session_state 修复建议

### 当前问题

虽然 `session_state` 顶层通过了校验，但存在：

- `artifacts=[]`
- `last_ok_artifact=null`
- 早期 events 里 `manifest_hash="unknown"`
- 早期 events 里 `git_commit=null`

这会影响 checkpoint/resume：

- 不知道上一个可信产物是什么。
- 中断后难判断从哪个阶段恢复。
- 只能依赖人工读日志。

### update_session_state.py 建议

1. `--project-dir` 存在时，默认自动计算 `project-manifest.json` SHA256。

   不要要求调用者手动传 `--manifest-hash`，减少 `unknown`。

2. final `phase_completed` 时强制：

   - `artifacts` 非空
   - `last_ok_artifact` 非空
   - `git_commit` 非空
   - `manifest_hash` 非 `unknown`

3. final artifacts 至少包含：

```json
[
  {"type": "project_manifest", "path": "project/project-manifest.json"},
  {"type": "generate_plan", "path": "project/generate_plan.json"},
  {"type": "phase_complete", "path": "phase_complete.upy_generate_plugin.json"},
  {"type": "file_manifest", "path": "generate_file_manifest.json"}
]
```

4. 对历史 events 中的 `manifest_hash="unknown"`：

   - 不建议直接 hard fail，因为早期阶段可能还没写 manifest。
   - 但如果对应 event 是 `quality_gates_passed`、`git_committed`、`phase_completed`，应该至少 warning。
   - 最新 event 和顶层 state 必须 hard fail。

## 七、实施顺序建议

推荐按以下顺序修 skill：

1. 修改 `SKILL.md` 和 references，加入 `data_flow_contract` 规则。
2. 修改 `check_generate_plan.py`，要求复杂业务流声明数据流契约。
3. 增加 PC contract test 模板，覆盖 mic/audio/sensor/cloud payload 这类跨阶段数据。
4. 修改 `check_phase_complete_consistency.py`：
   - 强制 phase_complete final git commit 等于 HEAD。
   - 强制 session_state final git commit 等于 HEAD。
   - 对 manifest 中旧 `generate.git.commit` 要求 `commit_role` 或改名为 `code_commit`。
5. 修改 `update_session_state.py`：
   - 自动计算 manifest hash。
   - final checkpoint 强制 artifacts 和 last_ok_artifact。
   - 对晚期 checkpoint 的 `unknown` hash 给出错误或强警告。
6. 补 smoke tests：
   - 缺少 data_flow_contract 的复杂语音项目应失败。
   - 录音 sentinel 没传给 cloud 的 contract test 应失败。
   - manifest commit 语义不清应失败。
   - phase_complete/session_state final commit 与 HEAD 不一致应失败。
   - final session_state artifacts 为空应失败。

## 八、结论

真实业务 bug 的修复重点不应是继续堆复杂静态语义门禁，而应把业务数据流显式化：

```text
generate_plan.data_flow_contract -> 生成 contract test -> 质量门禁运行测试
```

这样才能让 LLM 生成的项目级业务逻辑可验证，而不是依赖静态规则猜测业务意图。

元数据方面，应明确区分：

- code generation commit
- final deliverable HEAD
- phase_complete final commit
- session_state final commit

并增强 `session_state` 的 artifacts/checkpoint 信息，让中断恢复真正可用。
