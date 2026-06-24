# `upy-analyze` 工作流导向改造建议

## 1. 目的与边界

本文只做一件事：

基于以下材料，站在**工作流**而不是单纯 UI 消息格式的角度，说明 `G:\MicroPython_Skills\upy-analyze` 应该怎么改：

- 当前真实 skill：
  - `G:\MicroPython_Skills\upy-analyze\SKILL.md`
  - `G:\MicroPython_Skills\upy-analyze\scripts\init_manifest.py`
- 目标接口蓝图：
  - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\01-architecture.md`
  - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\02-protocol.md`
  - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\03-parallel-dev.md`
  - `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\upy-analyze.md`
- 约束与分析文档：
  - `G:\blockless-plugin-course(1)\embedded-engineer-next-steps-guide.md`
  - `G:\blockless-plugin-course(1)\embedded-skill-plugin-interface-workflow.md`
  - `G:\blockless-plugin-course(1)\external-engineer-advice-analysis.md`
  - `G:\blockless-plugin-course(1)\skill-current-vs-plugin-target-analysis.md`

本文**不修改 skill 文件**，只给后续改造提供施工图。

---

## 2. 先讲结论

`upy-analyze` 不是先去改成“能发卡片的 skill”，而是先改成“能稳定驱动整个入口工作流的 phase”。

对它的改造顺序应该是：

1. 先收紧现有业务流程，去掉不属于 analyze 的决策
2. 再把用户交互点、脚本点、输出点改成协议友好的结构
3. 再做本机 `mock_plugin.py` 模拟插件测试
4. 最后再把这套消息序列交给插件工程师

`upy-analyze` 的真正职责应该固定为：

```text
用户自然语言
→ 意图拆解
→ 器件清单确认
→ 驱动搜索
→ 替代推荐或冷门路径标记
→ 输出 manifest 快照
→ 自动进入下一阶段
```

它不应该继续承担这些职责：

- 反复追问模式选择
- 追问 MCU 最终选型
- 直接写本地 `project-manifest.json`
- 以本地命令行文本形式输出替代推荐

---

## 3. 当前真实现状

从 `G:\MicroPython_Skills\upy-analyze\SKILL.md` 看，当前 `upy-analyze` 是一个**本地直跑型 skill**，它默认自己既负责决策，也负责执行。

当前工作流大致是：

```text
Step 1 意图拆解
→ Step 2A 问用户选“小白/自定义”
→ Step 2B 问 MCU / 器件确认
→ Step 2C 再问场景、供电、性能、输出
→ Step 3 搜驱动
→ Step 3B 纯文本方式给替代推荐
→ Step 4 调 init_manifest.py 直接写盘
```

当前实现的几个明显特点：

1. `SKILL.md` 里仍有本地环境前置检查
   - `python --version`
   - `python -c "import requests"`

2. 用户交互还是 `AskUserQuestion` 思维
   - 关注的是“对话怎么问”
   - 不是“工作流里在哪个确认点停下、拿到什么结构化结果再继续”

3. 输出是“本地文件写入成功”
   - 当前 `init_manifest.py` 负责校验并直接写 `project-manifest.json`
   - 这更像本地 agent 工作流，不是插件化工作流

4. 替代推荐是命令行文本表达
   - 不适合插件端稳定渲染
   - 也不利于后续自动恢复和消息回放

5. analyze 边界偏大
   - 模式、小白/自定义、MCU、场景、供电、性能、输出都在这个 phase 里处理
   - 这会导致入口 phase 过重，交互多，中断点多

---

## 4. 目标不是“前端卡片化”，而是“工作流化”

根据 `external-engineer-advice-analysis.md` 的观点，协议不能只理解成“给前端画卡片的消息格式”，而应该理解成：

**系统如何知道自己做到哪一步、下一步找谁执行、失败后如何继续。**

所以 `upy-analyze` 的目标不只是把：

```text
AskUserQuestion
```

改成：

```text
approval_request
```

更关键的是把 analyze 变成一个完整入口工单：

- 有明确输入
- 有明确步骤
- 有明确确认点
- 有明确结果
- 有明确下游 phase
- 有明确“哪些器件进入冷门路径”

---

## 5. `upy-analyze` 未来应该长成什么工作流

### 5.1 输入

插件以 `start_phase` 启动 analyze，并把入口上下文直接带进来：

- `user_description`
- `pre_selected_board`
- `preferences.mode`
- `preferences.locale`
- `existing_hardware`

这一步的工作流意义是：

- 插件负责收集用户偏好
- analyze 负责消费这些偏好
- analyze 不再把“模式选择”当成自己的第一段对话任务

### 5.2 Step 1: 意图拆解

目标：

- 从自然语言中提取功能目标
- 提取器件候选
- 提取接口类型
- 补充系统推荐器件

这里应立即发送进度消息，而不是静默执行：

- `status_update(intent_extraction)`
- `status_update(intent_done)`

工作流价值：

- 用户知道系统没有卡死
- 插件时间线有了第一段稳定进度

### 5.3 Step 2: 器件确认

目标：

- 把 LLM 拆出来的器件清单，变成**唯一的第一张确认卡片**
- 板卡如果已经在插件里预选，就只显示，不在 analyze 阶段再次追问

这一步不应该再保留现在的：

- Step 2A 分流问答
- Step 2B 多轮问 MCU
- Step 2C 再问场景/供电/性能/输出

推荐做法：

1. `preferences.mode = beginner`
   - analyze 不再追问场景、供电、性能、输出
   - 直接使用默认值

2. `preferences.mode = custom`
   - analyze 最多允许补一张结构化卡片
   - 只补会影响 driver 搜索和后续选型的关键字段
   - 不要把整个 phase 再拖回多轮对话模式

工作流上，analyze 应只有一个核心停顿点：

```text
器件确认卡片
```

而不是多个零散问答。

### 5.4 Step 3: 驱动搜索

目标：

- 对每个器件执行驱动搜索
- 给出三类结果：
  - 有现成驱动
  - 无需驱动
  - 无驱动

这一步必须结构化表达“器件来源”：

- `user_specified`
- `system_recommended`

这是后续替代推荐和冷门路径分流的关键。

推荐工作流：

```text
每个器件搜索完成
→ 发一条 status_update
→ 累积 driver 状态
```

而不是全部搜索完再一次性总结。

### 5.5 Step 3B: 替代推荐或冷门路径

这里必须明确两条不同分支：

1. 用户明确指定的器件没驱动
   - 不弹替代卡片
   - 直接标记 cold-driver
   - 在 `warnings` 里说明

2. 系统推荐的器件没驱动
   - 允许弹替代推荐卡片
   - 用户可以接受替代
   - 用户也可以坚持走冷门路径

这个分流是 analyze 工作流里最重要的“异常路径判定”。

### 5.6 Step 4: 输出阶段结果

目标：

- 不再以“写本地文件成功”作为 analyze 的收尾
- 而是以 `phase_complete` 作为 analyze 的唯一完成出口

`phase_complete` 里至少要带：

- `result`
- `summary`
- `next_phase`
- `artifacts`
- `warnings`
- `errors`
- `manifest_content`

其中 `manifest_content` 是工作流的关键，不是 UI 附件。

它的意义是：

```text
analyze 已经把后续 phase 所需的项目事实状态整理好了
下游 phase 直接继续消费
```

---

## 6. 现状与目标之间的核心差距

### 差距 1：现有 analyze 太像对话脚本，不像 phase 工作流

现状：

- 问题很多
- 对话分叉很多
- 流程状态不够集中

目标：

- 少量关键确认点
- 明确阶段输入输出
- 明确下游流转

### 差距 2：现有 analyze 把“用户偏好输入”和“phase 内交互”混在了一起

现状：

- 小白/自定义在 skill 内部现问
- 板卡也在 skill 内部问

目标：

- 插件把偏好作为入口上下文给进来
- analyze 只消费，不重复追问

### 差距 3：现有 analyze 的输出是“写文件”，目标是“交接工单”

现状：

- `init_manifest.py` 负责写盘

目标：

- `init_manifest.py` 负责校验
- `phase_complete.manifest_content` 负责交接下游

### 差距 4：现有 analyze 的替代推荐是文本，目标是可回放的结构化分支

现状：

- 命令行表格

目标：

- `approval_request`
- 结构化选项
- 用户选择可稳定回传

---

## 7. 建议的实际改造顺序

不要直接从“改协议字段”开始。`upy-analyze` 应按下面顺序改。

### Phase A：先改业务工作流，不改插件实现

先在 `SKILL.md` 层面把真实 analyze 收紧成目标工作流：

1. 删除前置环境检查
2. 删除 Step 2A 的模式提问
3. 删除 analyze 内部的 MCU 追问主逻辑
4. 把用户确认点收缩为“器件确认卡片”为主
5. custom 模式最多保留一张补充卡片
6. 明确器件来源字段
7. 明确冷门路径分流条件

这一阶段只验证：

- analyze 的业务顺序是否正确
- 入口是否足够轻
- 分支是否清楚

### Phase B：再改输出契约

在业务顺序稳定后，再做协议导向改造：

1. 每个关键步骤补 `status_update`
2. 把器件确认改写为 `approval_request`
3. 把替代推荐改写为 `approval_request`
4. 把 manifest 输出改成：
   - 插件端执行校验脚本
   - analyze 端输出 `manifest_content`
5. 用 `phase_complete` 收尾

### Phase C：最后补本机 mock 插件测试

这一步不是联调前端，而是验证：

```text
如果插件按协议做事
analyze 这条消息链能不能走通
```

---

## 8. `init_manifest.py` 应该怎么调整

当前 `init_manifest.py` 的定位是：

- 读 JSON
- 校验
- 填默认值
- 写 `project-manifest.json`

这更适合本地 agent 直接执行，不适合插件化 workflow。

建议未来调整成：

1. 支持从 stdin 读取 JSON
2. 校验成功时输出结构化结果到 stdout
3. 校验失败时输出结构化错误到 stdout/stderr
4. 不再负责最终写入项目目录

也就是把它从：

```text
写盘脚本
```

改成：

```text
校验器 / 规范化器
```

这样工作流会变成：

```text
LLM 生成 manifest 草稿
→ script_run(init_manifest.py)
→ script_result 返回校验结果
→ analyze 根据结果生成最终 manifest_content
→ phase_complete 输出给下游
```

这才符合插件化工作流。

---

## 9. 本机怎么模拟插件测试

这里要严格区分两件事：

### 9.1 本地逻辑测试

问题是：

```text
analyze 这条业务流程本身顺不顺
```

这个阶段继续用现有本地工具思维即可。

### 9.2 mock 插件测试

问题是：

```text
如果 analyze 不再直接问用户、写文件、跑脚本
而是发消息让插件执行
这条协议链顺不顺
```

这一步需要一个最小 `mock_plugin.py`。

---

## 10. `upy-analyze` 的本机 mock 插件测试建议

### 10.1 测试目标

验证 4 件事：

1. `start_phase` 输入能驱动 analyze 开始
2. `approval_request` 序列是否合理
3. `status_update` 是否足以支撑时间线
4. `phase_complete.manifest_content` 是否完整可传下游

### 10.2 最小 mock_plugin.py 需要支持的消息

对 analyze 来说，最小集合就够了：

- `approval_request`
- `status_update`
- `script_run`
- `phase_complete`

如果 analyze 阶段暂时还不真的做 `file_operation`，那本机 mock 可以先不接这条。

### 10.3 推荐的 mock 行为

#### 行为 1：收到器件确认卡片

自动返回：

- `action = "confirm"`
- 默认选中当前 items

这样可以先跑通 happy path。

#### 行为 2：收到替代推荐卡片

准备两种固定策略，分别跑两组测试：

1. 接受替代器件
2. 保留原器件，走 cold-driver

这样可以把 analyze 最关键的异常分支跑出来。

#### 行为 3：收到 `script_run(init_manifest.py)`

如果改造后 analyze 用脚本来校验 manifest，则 mock 插件要：

- 真执行本地 `.upy/scripts/init_manifest.py`
- 把 stdout/stderr 包装成 `script_result`

#### 行为 4：收到 `phase_complete`

打印并保存：

- `result`
- `summary`
- `warnings`
- `manifest_content`

用于人工检查 analyze 的最终交接质量。

---

## 11. 推荐的本机测试场景

### 场景 A：happy path

输入：

- 用户一句话描述
- `preferences.mode = beginner`
- `pre_selected_board = null`

期待：

- 意图拆解成功
- 器件确认卡片出现
- 驱动搜索有状态更新
- 输出 `phase_complete(result=success)`
- `next_phase = select-hw`

### 场景 B：用户指定器件无驱动

输入：

- 用户明确写出冷门器件型号

期待：

- 不弹替代卡片
- 直接标记 `driver.source = none` 或冷门路径状态
- `warnings` 提示将进入冷门驱动路径

### 场景 C：系统推荐器件无驱动

输入：

- 用户只描述功能，不指定具体器件

期待：

- 弹出替代推荐卡片
- 接受替代后，manifest 中器件被替换为可用器件

### 场景 D：custom 模式

输入：

- `preferences.mode = custom`

期待：

- analyze 不会重新退化成多轮命令行问答
- 最多多一张结构化补充卡片
- 最终输出字段仍完整

### 场景 E：manifest 校验失败

输入：

- 故意构造非法枚举值

期待：

- `init_manifest.py` 返回结构化失败结果
- analyze 不直接进入 `phase_complete(success)`
- 能明确告诉后续应该修哪类字段

---

## 12. 推荐交付给插件工程师的 analyze 包

当 `upy-analyze` 改完后，建议交付以下材料，而不是只给 `SKILL.md`：

1. 接口文档
   - `plugin-interface/skills/upy-analyze.md`

2. mock 消息样本
   - `start_phase.analyze.json`
   - `approval_request.device_confirm.json`
   - `approval_request.alternative_device.json`
   - `phase_complete.analyze.success.json`
   - `phase_complete.analyze.cold-driver.json`

3. 本机测试记录
   - happy path 通过
   - user_specified 无驱动通过
   - system_recommended 无驱动通过
   - custom 模式通过
   - manifest 校验失败路径通过

4. 白名单脚本说明
   - `init_manifest.py`

---

## 13. 最终建议

如果只压缩成一句话，`upy-analyze` 的改造重点就是：

**把它从“本地多轮问答式 skill”改成“入口工作流 phase”，让它负责稳定地产生器件事实、驱动状态和 manifest 快照，而不是继续承担模式提问、MCU 追问和本地写盘。**

对你这个阶段最重要的，不是先把卡片画出来，而是先把 analyze 的工作流边界固定住：

- 输入是什么
- 只在哪个确认点停
- 什么情况下走替代推荐
- 什么情况下走冷门驱动
- 最终如何把结果交给下游

只要这 5 件事定住，插件化改造就不会跑偏。
