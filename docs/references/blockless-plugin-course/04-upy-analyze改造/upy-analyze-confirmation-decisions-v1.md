# `upy-analyze` 确认结果与待拍板项 v1

本文整理当前已经确认的 `upy-analyze` 改造约束，以及仍需你最后拍板的小点。

目标对象：

- 新 skill：`G:\MicroPython_Skills\upy-analyze-plugin`
- 原 skill：`G:\MicroPython_Skills\upy-analyze` 完全保留，不覆盖

---

## 1. 已确认的输入边界

新 analyze skill 固定只接受这 5 类输入：

- `user_description`
- `pre_selected_board`
- `preferences.mode`
- `preferences.locale`
- `existing_hardware`

### 已确认规则

1. analyze 不再自己先问“小白/自定义”
2. `pre_selected_board = null` 时，analyze 只记录“未选板卡”
3. 最终板卡推荐交给 `select-hw`
4. `existing_hardware` 只作为器件清单补充信息，不在 analyze 阶段做复杂处理

---

## 2. 已确认的主流程停顿点

### 已确认规则

1. analyze 主流程只保留 1 个主确认点：
   - `器件确认卡片`

2. `custom` 模式最多允许 1 张补充卡片

### 当前建议

你认为 beginner 模式下，场景、供电、性能、输出这些字段仍然需要询问。

这个方向可以保留，但建议不要恢复成旧版多轮问答，而应收敛成：

- beginner 模式也最多只增加 1 张“需求补充卡片”
- 把场景、供电、性能、输出合并在同一张结构化卡片中

### 原因

如果 beginner 模式重新拆成多轮问答：

- analyze 会重新变成重交互入口 phase
- 工作流中断点会变多
- 插件侧卡片设计和恢复逻辑会更复杂

因此建议：

**可以问，但必须收敛成 1 张补充卡片，而不是多轮对话。**

---

## 3. 用户中途补充信息怎么处理

你提出的问题很关键：

> 万一分析完了，用户又有补充怎么办？

### 当前建议

建议把这条定成工作流规则：

1. 只要用户在 analyze 阶段中断对话并补充信息，就视为一次 `user_intervention`
2. analyze 不从中途“局部拼补”
3. analyze 保留当前已提取结果作为上下文
4. 然后重新生成器件确认卡片
5. 再重新进入驱动搜索

### 这条规则的好处

- 工作流清晰
- 不需要在 analyze 内部维护过细的局部修补逻辑
- 插件侧更容易理解“用户补充 = 重新分析”

### 当前建议结论

**补充信息 = 触发 analyze 复算，但复用已有上下文。**

---

## 4. 什么情况下走替代推荐

你已确认：

- 系统推荐器件无驱动时，允许推荐替代器件
- 替代推荐最多给 2 个候选

### 当前建议规则

只有在以下条件同时成立时才走替代推荐：

1. 器件来源是 `system_recommended`
2. 当前器件无现成驱动
3. 能找到同类别、同接口、已有驱动的替代器件

### 关于 `user_specified` 是否也允许替代推荐

这里建议不要默认允许自动替代。

#### 原因

如果对 `user_specified` 也直接给替代推荐，会产生两个问题：

1. 会冲淡“用户明确指定器件”的语义
2. 会让 analyze 在入口阶段承担过多产品替代决策

### 推荐做法

- `system_recommended` 无驱动：
  - 允许弹替代推荐卡片
  - 最多 2 个候选

- `user_specified` 无驱动：
  - 默认不自动替代
  - 直接进入冷门驱动路径标记
  - 但在警告中提示：
    - 可以继续走冷门驱动生成
    - 如果愿意，也可以改用已有驱动的器件后重新分析

### 当前建议结论

**替代推荐只对 `system_recommended` 生效，不对 `user_specified` 自动生效。**

---

## 5. 什么情况下走冷门驱动

你已确认下面两类情况进入冷门驱动：

1. 用户明确指定器件，且无现成驱动
2. 系统推荐器件无驱动，且用户拒绝替代，坚持原器件

### 已确认规则

1. analyze 只负责在 manifest 中打标
2. analyze 不继续承担后续冷门驱动生成动作

### 后续工作流建议

推荐后续工作流是：

```text
analyze 标记 cold-driver
→ 后续进入冷门驱动生成与验证
→ 成功后再回主流程
```

### 当前建议结论

**analyze 只负责“发现并分流”，不负责在本 phase 内解决冷门驱动问题。**

---

## 6. 最终如何把结果交给下游

你已确认：

- analyze 的完成标准改为 `phase_complete`
- `next_phase` 暂时固定为 `select-hw`

### 关于下游是否直接消费 `manifest_content`

当前建议是：可以。

### 优点

1. 下游 phase 不依赖本地文件先落盘
2. phase 之间传递更直接
3. 更适合插件化和远程化
4. 更适合 mock 测试和消息回放
5. 中断恢复时，上下文更清晰

### 缺点

1. manifest 变大后，消息体会更重
2. 如果完全不落盘，人工排查时不如本地文件直观
3. 调试时可能需要同时区分：
   - 消息里的 manifest
   - 项目目录里的 manifest 快照

### 折中建议

建议把规则定成：

1. 工作流标准交接使用 `manifest_content`
2. 是否落盘，由后续 runner / 执行层决定
3. 不把“写本地 manifest 成功”作为 analyze 的完成标准

### 当前建议结论

**phase 与 phase 之间，以 `manifest_content` 作为标准交接物；落盘只是实现细节，不是 analyze 完成条件。**

---

## 7. skill 目录与命名

### 已确认规则

1. 原 skill 完全保留：
   - `G:\MicroPython_Skills\upy-analyze`

2. 新 skill 单独新建：
   - `G:\MicroPython_Skills\upy-analyze-plugin`

3. 新 skill 从一开始就按“插件化工作流版”设计

---

## 8. 当前已基本收敛的结论

如果把当前已确认内容压缩成一组规则，就是：

1. 新 skill 名称为 `upy-analyze-plugin`
2. 原 `upy-analyze` 完全保留
3. analyze 只接受那 5 类输入
4. analyze 不再自己先问“小白/自定义”
5. `pre_selected_board` 为空时，只记录未选板卡，最终推荐交给 `select-hw`
6. `existing_hardware` 只作为器件补充信息
7. analyze 主流程只保留 1 个主确认点
8. `custom` 模式最多允许 1 张补充卡片
9. 用户中途补充信息时，触发 analyze 复算，但复用已有上下文
10. `system_recommended` 无驱动时，可替代推荐，最多 2 个候选
11. `user_specified` 无驱动时，默认不自动替代，直接走冷门驱动标记
12. analyze 只负责 cold-driver 打标，不负责后续生成
13. analyze 以 `phase_complete` 作为完成标准
14. `next_phase` 暂定固定为 `select-hw`
15. 下游 phase 直接消费 `manifest_content`

---

## 9. 还需要你最后拍板的小点

当前只剩 1 个最值得你最终确认的小点：

### beginner 模式下，那张“需求补充卡片”到底问不问？

当前建议：

- 问
- 但最多只允许 1 张卡片
- 把场景、供电、性能、输出合并在同一张结构化卡片里

不建议：

- beginner 模式恢复成多轮命令行式问答

### 建议拍板结论

**beginner 模式可以问，但必须收敛成 1 张补充卡片。**

---

## 10. 一句话结论

当前 `upy-analyze` 改造方向已经基本收敛，真正还没拍板的核心只剩一个：

**beginner 模式下是否保留 1 张“需求补充卡片”，而不是恢复成多轮问答。**
