# `upy-analyze` 改造前需要确认的问题

本文只列 `upy-analyze` 进入插件化工作流改造前，最需要先定死的决策项。

建议确认顺序：

1. 先确认输入边界
2. 再确认唯一停顿点
3. 再确认替代推荐和冷门驱动分流
4. 最后确认如何把结果交给下游

---

## 1. 输入是什么

建议新 analyze skill 的固定输入为：

- `user_description`
- `pre_selected_board`
- `preferences.mode`
- `preferences.locale`
- `existing_hardware`

### 需要你确认

1. analyze 是否只接受这 5 类输入，不再自己先问“小白/自定义”？
2. `pre_selected_board` 如果为空，analyze 是否只记录“未选板卡”，把最终推荐交给 `select-hw`？
3. `existing_hardware` 是否只作为器件清单补充信息，不在 analyze 阶段做复杂处理？

---

## 2. 只在哪个确认点停

建议 analyze 主流程只保留 1 个主确认点：

- `器件确认卡片`

`custom` 模式最多只额外增加 1 张补充卡片，不再恢复成多轮问答。

### 需要你确认

1. analyze 是否只保留“器件确认卡片”作为主停顿点？
2. `custom` 模式是否允许最多 1 张补充卡片？
3. 场景、供电、性能、输出这些字段，是否默认不在 beginner 模式追问？

---

## 3. 什么情况下走替代推荐

建议只有在以下条件同时成立时才走替代推荐：

- 器件来源是 `system_recommended`
- 当前器件无现成驱动
- 能找到同类别、同接口、已有驱动的替代器件

### 需要你确认

1. 系统推荐器件无驱动时，是否允许推荐替代器件？
2. 替代推荐是否只允许发生在 `system_recommended`，不允许发生在 `user_specified`？
3. 替代推荐时，是否最多给 2 个候选，避免卡片过重？

---

## 4. 什么情况下走冷门驱动

建议下面两类情况进入冷门驱动路径：

1. 用户明确指定器件，且无现成驱动
2. 系统推荐器件无驱动，且用户拒绝替代，坚持原器件

### 需要你确认

1. `user_specified` 且无驱动时，是否一律不做替代推荐，直接进入冷门驱动路径？
2. `system_recommended` 且无驱动时，如果用户拒绝替代，是否也进入冷门驱动路径？
3. 进入冷门驱动路径时，analyze 是否只负责在 manifest 中打标，不继续承担后续驱动生成动作？

---

## 5. 最终如何把结果交给下游

建议 analyze 不再把“写本地 `project-manifest.json` 成功”当成完成标准，而是统一通过：

- `phase_complete`
- `manifest_content`
- `next_phase`

把结果交给下游。

### 需要你确认

1. analyze 的完成标准是否改为 `phase_complete`，而不是本地 manifest 写盘？
2. 下游 phase 是否直接消费 `manifest_content`？
3. `next_phase` 是否固定为 `select-hw`，除非未来定义了特殊入口？

---

## 6. skill 目录怎么放

你已经明确：

- 保留原 skill：`G:\MicroPython_Skills\upy-analyze`
- 不覆盖原实现
- 新建一个改造版 skill

### 建议命名

- `G:\MicroPython_Skills\upy-analyze-plugin`

### 需要你确认

1. 新 skill 名称是否用 `upy-analyze-plugin`？
2. 原 skill 是否完全保留，不做覆盖式修改？
3. 新 skill 是否从一开始就按“插件化工作流版”来设计？

---

## 7. 最小确认集

如果只先确认最关键的 5 条，建议你先定这几条：

1. analyze 是否只保留“器件确认卡片”这一个主停顿点？
2. `user_specified` 且无驱动时，是否一律直接走冷门驱动？
3. `system_recommended` 且无驱动时，是否先走替代推荐？
4. analyze 是否不再负责最终 MCU 选型，只记录上下文并交给 `select-hw`？
5. analyze 是否统一通过 `phase_complete + manifest_content + next_phase` 把结果交给下游？

---

## 8. 一句话结论

`upy-analyze` 改造前，最重要的不是先改代码，而是先把下面 5 件事定死：

- 输入是什么
- 只在哪个确认点停
- 什么情况下走替代推荐
- 什么情况下走冷门驱动
- 最终如何把结果交给下游
