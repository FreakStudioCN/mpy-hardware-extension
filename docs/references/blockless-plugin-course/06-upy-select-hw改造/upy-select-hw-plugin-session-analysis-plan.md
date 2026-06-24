# upy-select-hw-plugin session 输出分析与修改计划

## 大白话结论

这次测试结果比之前好：没有再把上游指定的 `ESP32-C3` 静默换成 `ESP32-S3`，最终板卡也确实是 `ESP32-C3-DevKitM-1`。产物路径也基本对了，`artifact_root=G:\test\test`，所以 `phase_complete` 里写 `sessions/<session_id>/xxx` 是合理的。

但是现在还有一个更核心的问题：**流程看起来成功了，但新增的“引脚确认”和“引脚决策证据”没有真正进入最终产物，也没有被脚本强制校验。**

也就是说，当前输出能通过旧 validator，但还没真正满足我们刚加的长期协议要求。最需要改的是 validator 和规范化输出，而不是单纯再改 `SKILL.md` 文案。

## 优先级总览

| 优先级 | 问题 | 重要性 | 为什么重要 | 建议处理 |
| --- | --- | --- | --- | --- |
| P0 | `pin_decisions` / `pin_review` 在规范化后丢失 | 高 | 最终 `phase_complete` 没带引脚确认和决策证据，后续 phase 看不到这些事实 | 必须先改 |
| P0 | `pin_plan_review` 可以被写死成“已确认” | 高 | 没有真实确认证据时也能 success，会让引脚风险被跳过 | 必须先改 |
| P0 | `pin_decisions` 没有脚本校验 | 高 | LLM 写错证据、枚举、deviation，脚本也不会发现 | 必须先改 |
| P1 | 日志里 ADC2/WiFi GPIO 列表和 board JSON 不一致 | 中高 | 日志会误导用户，以为 GPIO7 也是 ADC2 冲突脚 | 应该紧跟着改 |
| P1 | 需要用户确认的 pin decision 被标成 `requires_user_review=false` | 中高 | 高风险引脚没有进入重点确认，`pin_plan_review` 形式化 | 应该紧跟着改 |
| P2 | ESP32-C3 音频能力描述过于确定 | 中 | board JSON 没有给出性能事实，不应直接断言满足 16bit/16kHz | 可以作为能力边界改进 |

## 详细问题说明

### P0-1：`pin_decisions` / `pin_review` 被规范化脚本丢掉

大白话：

`select_hw_draft.json` 里面已经写了引脚为什么这么选、用户有没有确认。但跑完格式化脚本以后，这些信息没进 `select_hw_validated.json`，最终 `phase_complete.select_hw.json` 里也没有。

这会导致一个问题：

- draft 里有证据；
- validated 里没证据；
- phase_complete 里也没证据；
- 下一个 phase 只能看到普通 `pinout`，看不到“为什么这么接”和“用户是否确认”。

原因：

`G:\MicroPython_Skills\upy-select-hw-plugin\scripts\select_hw_manifest.py` 的 `normalize_manifest()` 目前只保留旧字段，例如：

- `pinout`
- `bom`
- `estimated_total_yuan`
- `hardware_selection`

但没有把 `hardware_plan.pin_decisions` 和 `hardware_plan.pin_review` 放进最终 `manifest_content`。

修改方向：

- 在 `normalize_manifest()` 中把 `pin_decisions` 和 `pin_review` 写入最终 manifest。
- 在 `core_manifest()` 对比核心字段时也纳入这两个字段，避免 phase_complete 丢字段还能通过。
- 更新 sample，让 `select_hw_manifest.after.json` 和 `phase_complete.select_hw.success.json` 都保留这两个字段。

### P0-2：`pin_plan_review` 现在可以被写死成“用户已确认”

大白话：

日志里写了“用户确认”，draft 里也写了 `confirmed_by=user`，但这不一定代表真的有一条结构化的 `approval_response`。

如果插件只是在产物里自己写一句“用户已确认”，那这个确认环节就没有约束力。

风险：

- 引脚分配可能有问题；
- 但系统自己写了 `confirmed=true`；
- 然后直接 `phase_complete success`；
- 用户实际没有机会核对原理图、丝印、模块资料。

原因：

当前 validator 只看最终 `phase_complete` 是否格式正确，不检查 `pin_review` 是否真实存在、是否确认、是否对应 `approval_id=pin_plan_review`。

修改方向：

- `phase_complete result=success` 时必须要求 `pin_review.confirmed=true`。
- `pin_review` 需要有明确字段，例如：
  - `approval_id: pin_plan_review`
  - `confirmed: true`
  - `confirmed_by`
  - `confirmed_at`
  - `source: approval_response` 或 `plugin_ui_confirmed`
- 如果没有确认，必须输出 `partial + checkpoint`，不能 success。
- 测试 runner 不能默认写死“用户已确认”，除非 mock 明确传入确认响应。

### P0-3：`pin_decisions` 没有脚本校验

大白话：

我们现在要求 LLM 写“为什么这个引脚这样选”，但脚本没有检查它写得对不对。

例如：

- 它可以说某 GPIO 是板载 LED 占用，但 board JSON 里其实不是；
- 它可以说是 `fixed_power_tie`，但 source 写成普通 `power`；
- 它可以写 `deviation.reason_code=onboard_occupied`，但证据路径不是 `onboard_peripherals[].occupied_pins`；
- 这些现在都可能通过。

原因：

当前 `select_hw_manifest.py` 主要校验 `pinout`，比如 GPIO 是否冲突、是否用到 restricted pin。它还没有专门的 `validate_pin_decisions()`。

修改方向：

新增 `validate_pin_decisions()`，至少检查：

- `device`、`pin_name`、`assigned_gpio`、`decision_type`、`source`、`evidence`、`requires_user_review` 必填。
- `decision_type` 必须在枚举里。
- `source` 必须在枚举里。
- `fixed_power_tie` 必须配 `source=fixed_power`。
- `deviation.reason_code` 必须合法。
- `reason_code=onboard_occupied` 时，`evidence_path` 必须指向 `onboard_peripherals[].occupied_pins`，且 `evidence_value` 必须等于 `from_gpio`。
- `pin_decisions` 必须能和最终 `pinout` 对得上，不能凭空多一个或少一个关键引脚。

### P1-1：日志里的 ADC2/WiFi GPIO 列表和 board JSON 不一致

大白话：

board JSON 说 `adc2_wifi_conflict` 是 `[0,1,2,3,4,5]`。

脚本 warning 也只列出了实际用到的 `GPIO3/4/5`。

但 `select_hw_phase_log.md` 写成了 `GPIO 3/4/5/7`，把 GPIO7 也算进去了。

这说明日志有一部分还是 LLM 手写或推断出来的，不是完全从 board JSON 和 validator 结果生成的。

风险：

用户会被日志误导，以为 GPIO7 有 ADC2/WiFi 风险。

修改方向：

- 日志里的 `adc2_wifi_conflict` 列表必须来自 board JSON。
- 日志里的 “实际使用了哪些 ADC2 数字脚” 必须来自最终 `pinout` 和 validator warning。
- 不允许手写静态列表。
- smoke test 增加检查：日志不能把 board JSON 以外的 GPIO 写进 ADC2/WiFi conflict。

### P1-2：高风险 pin decision 没有进入重点确认

大白话：

有些引脚虽然可以用，但应该提醒用户重点确认。例如：

- ADC2/WiFi 条件可用 GPIO；
- GPIO20 默认是 UART0 RX，现在拿去做 I2S DIN；
- MAX98357 的 `SD` 直接接 3V3，意味着功放常开，软件不能关断；
- INMP441 / MAX98357 的固定电源或接地配置脚。

现在很多 `pin_decisions` 的 `requires_user_review=false`，这会让 `pin_plan_review` 变成“走过场”。

修改方向：

规则上应改成：

- 默认总线正常使用：可以 `requires_user_review=false`。
- 条件可用 GPIO、UART/REPL/USB 复用、strapping、onboard 释放、fixed_power_tie：应 `requires_user_review=true`。
- `pin_plan_review` payload 里要把这些重点项展示给用户确认。

### P2：ESP32-C3 音频能力说明过于确定

大白话：

日志里写了 “RMT 模拟 I2S，满足 16bit/16kHz 语音”。这个说法太确定了。

问题不是一定错，而是 board JSON 没有给出这个事实。select-hw 阶段不应该只靠 LLM 常识断言性能满足。

风险：

后续用户按这个硬件方案做语音项目，才发现性能、库支持或 MicroPython 实现不稳定。

修改方向：

- 如果 board JSON 没有明确 `i2s` / `audio_capability`，select-hw 只能输出 warning，不能直接写“满足”。
- 对语音/音频类需求，如果 MCU 能力不确定，应提示：需要用户确认 MicroPython 固件能力、库支持、采样率、内存和云端 API 方案。
- 更长期的做法是在 board JSON 里补充 `capabilities.audio`，让 select-hw 有事实来源。

## 建议修改顺序

### 第一步：先改 validator 和 manifest 输出

优先处理 P0：

1. `normalize_manifest()` 保留 `pin_decisions` / `pin_review`。
2. `validate_phase_complete()` 成功前检查 `pin_review`。
3. 新增 `validate_pin_decisions()`。

原因：

这一步能防止“看起来成功，但关键证据没进入最终产物”的问题。

### 第二步：改样例和测试 runner

1. 更新 sample JSON。
2. 更新 mock runner，不要默认伪造用户确认。
3. smoke tests 覆盖新增协议字段。

原因：

否则当前 sample 仍然会鼓励旧行为，后续测试也测不出问题。

### 第三步：改日志生成规则

1. 日志中的 restricted/ADC2/unused_safe GPIO 从 board JSON 和最终 pinout 计算。
2. 修复 GPIO7 被误列入 ADC2/WiFi conflict。
3. 日志只记录事实来源，不写无法验证的断言。

原因：

日志是给用户看的，错误日志会直接影响接线判断。

### 第四步：补 board capability 或降级表达

1. ESP32-C3 音频能力先改成 warning。
2. 后续在 board JSON 增加 `capabilities.audio` 后，再让 select-hw 做确定判断。

原因：

这不是当前协议阻塞点，但会影响硬件推荐质量。

## 修改目标文件

主要需要修改：

- `G:\MicroPython_Skills\upy-select-hw-plugin\scripts\select_hw_manifest.py`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\select_hw_draft.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\select_hw_manifest.after.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\phase_complete.select_hw.success.json`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\pin_assignment_log.md`
- `G:\MicroPython_Skills\upy-select-hw-plugin\sample\select_hw_phase_log.md`
- `G:\MicroPython_Skills\upy-select-hw-plugin\test\select_hw_runner.py`
- `G:\MicroPython_Skills\upy-select-hw-plugin\test\smoke_tests.py`

## 一句话总结

现在不是“板卡选错”的问题，而是“新增协议字段没有被最终产物保留，也没有被脚本强制校验”的问题。先把 `pin_review` 和 `pin_decisions` 做成真正的协议事实，再修日志和能力描述。
