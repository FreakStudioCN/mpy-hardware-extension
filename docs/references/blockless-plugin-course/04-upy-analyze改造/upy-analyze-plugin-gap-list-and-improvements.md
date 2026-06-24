# `upy-analyze-plugin` 缺项清单与改进建议

## 1. 当前判断

`upy-analyze-plugin` 目前已经完成了插件化工作流骨架，也已经能本机跑通最小 happy path。

现在的主要问题不是“大方向错了”，而是：

- 协议细节还没完全写死
- 资源目录还没补齐
- 校验脚本目前只能做结构校验，不能判断分析结果是否真的合理

换句话说，当前状态更接近：

**工作流通了，但还没有完全产品化。**

---

## 2. 本次对照范围

这次主要对照了以下内容：

- `G:\MicroPython_Skills\upy-analyze\SKILL.md`
- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\upy-analyze.md`
- `G:\MicroPython_Skills\upy-analyze-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-analyze\boards\*.json`
- `G:\MicroPython_Skills\upy-analyze-plugin\boards\*`
- `G:\MicroPython_Skills\upy-analyze-plugin\scripts\init_manifest.py`

---

## 3. 当前已经具备的部分

`upy-analyze-plugin` 现在已经具备：

- 插件化输入边界
- 单主确认点工作流
- 可选补充卡片
- 替代推荐 / 冷门驱动分流规则
- `phase_complete + manifest_content + next_phase`
- `init_manifest.py` 结构化校验入口
- `mock_plugin.py + analyze_runner.py + run_local_mock_session.py` 本机演练链路

因此，当前不是从零开始补，而是补“漏掉的约束和资产”。

---

## 4. 主要缺项

### 4.1 `SKILL.md` 还缺协议级细节

当前 `upy-analyze-plugin\SKILL.md` 已经把主流程写出来了，但和目标规范相比，还缺这些更细的内容：

- `approval_request(device_confirm)` 的字段级规范还不完整
- `approval_request(requirement_supplement)` 的字段范围还不完整
- `approval_request(alternative_device)` 的候选项字段约束还不完整
- `approval_response` 如何表达：
  - 删除器件
  - 新增器件
  - 修改系统推荐器件
  - 用户中途补充说明
- `manifest_content` 最终最少必须包含哪些字段，还没写成严格清单
- 驱动搜索结果回填时，哪些 driver 元数据是必须的，还没固定

这会导致后面如果换一个人接着实现，很容易出现：

- 消息结构各写各的
- runner / 插件 / LLM 三方理解不一致

### 4.2 “用户补充后重新分析”规则还不够协议化

现在已经定了原则：

- 用户中途补充时，按“重新分析”处理
- 不能只做字符串拼补

但还没定清楚：

- 插件侧是重新发 `start_phase`
- 还是在 `approval_response` 里附带补充文本
- 重新分析时，哪些旧上下文保留，哪些重算

这个点如果不提前写清楚，后面非常容易出状态混乱。

### 4.3 驱动搜索和替代推荐策略还没完全落地

原版 `upy-analyze\SKILL.md` 在“怎么搜替代器件”上写得更细：

- 前缀搜索
- 类别关键词兜底
- 搜到几个就停
- 如何排序 Top 2

而插件版目前只有工作流规则，没有把：

- 搜索输入格式
- 搜索结果结构
- 替代推荐排序依据
- 停止条件

固化下来。

这意味着当前更像“流程上允许替代推荐”，还不是“搜索策略已经可复用”。

### 4.4 `boards` 目录明显不完整

当前目录差异：

- `G:\MicroPython_Skills\upy-analyze\boards` 下已有完整板卡 JSON
- `G:\MicroPython_Skills\upy-analyze-plugin\boards` 目前只有 `README.md`

而插件目标规范里，`pre_selected_board` 明确依赖板卡元数据，例如：

- `id`
- `display_name`
- `mcu`
- `chip_family`
- `firmware_url`

所以当前 `upy-analyze-plugin` 虽然逻辑上支持 `pre_selected_board`，但资源上并没有自带这套板卡数据。

这会带来两个问题：

- 插件版 skill 边界不完整，隐式依赖原 skill 的 boards
- 后续如果插件版板卡字段扩展，会很难独立维护

### 4.5 `init_manifest.py` 只做了结构校验，没做语义校验

当前校验脚本已经能做：

- 顶层字段检查
- `requirements` 字段检查
- `devices` 字段检查
- 枚举值检查
- 默认值补齐
- `devices[].source` / `devices[].driver.source` 合法性检查

但它还不能判断这些更关键的问题：

- LLM 提取的器件是否真的符合用户描述
- `type` 和 `interface` 是否合理匹配
- `user_specified` / `system_recommended` 标记是否正确
- 替代器件是否真的是同类别同接口
- `driver.source=upypi` 时是否真的补全了驱动关键信息
- `pre_selected_board` 与 manifest 中相关字段是否一致

也就是说，现在只能验证：

**“格式对不对”**

还不能验证：

**“分析理解得对不对”**

---

## 5. 关于 `boards` 是否应该迁移到 `upy-analyze-plugin`

结论：

**应该迁移。**

建议做法：

1. 先把 `G:\MicroPython_Skills\upy-analyze\boards\*.json` 整体复制到 `G:\MicroPython_Skills\upy-analyze-plugin\boards\`
2. 初期保持字段结构不变
3. 后续如果插件侧板卡选择器需要额外字段，只在 plugin 版继续演进

理由：

- `upy-analyze-plugin` 应该能独立表达自己的输入契约
- `pre_selected_board` 已经和板卡 JSON 强绑定
- 继续借用原版 boards，会让 plugin 版 skill 边界不清

这里的重点不是“analyze 现在就要用 boards 做复杂推理”，而是：

**插件版 skill 自己应该拥有这套板卡资产。**

---

## 6. 当前“LLM 生成结果怎么验证”

### 6.1 已经做到的验证

当前 `init_manifest.py` 已能验证：

- `project_name` 是否存在
- `requirements` 是否存在且为对象
- `devices` 是否存在且为非空数组
- `requirements.description` 是否存在
- requirements 枚举值是否合法
- `output` / `special_requirements` / `existing_hardware` 类型是否合法
- `devices[].name/type/interface` 是否存在
- `devices[].interface` 是否合法
- `devices[].source` 是否合法
- `devices[].driver.source` 是否合法
- 缺省字段是否能自动补齐

### 6.2 还没做到的验证

当前还没做到：

- 用户意图与器件清单的一致性校验
- 器件类别与接口组合合理性校验
- 驱动元信息完整度校验
- 替代器件的“同类同接口”校验
- `pre_selected_board` 和输出 manifest 的一致性校验
- 冷门驱动触发条件是否正确的校验

### 6.3 当前阶段的准确定位

所以现在 `init_manifest.py` 的定位更准确应该是：

- 第一层：结构校验器
- 第一层：枚举约束器
- 第一层：默认值填充器

它还不是：

- 第二层：分析质量审计器
- 第二层：语义正确性判定器

---

## 7. 建议优先级

### 第一优先级

这些建议最值得先做：

1. 补齐 `upy-analyze-plugin\boards\*.json`
2. 把 `SKILL.md` 里的消息协议细节写完整
3. 明确“用户补充后重新分析”的协议入口
4. 把 `manifest_content` 最小必备字段写成硬约束

原因：

- 这几项决定的是 skill 边界是否完整
- 不补的话，后面接 `select-hw` 时容易反复返工

### 第二优先级

然后再补：

1. 驱动搜索输入/输出格式
2. 替代推荐排序依据
3. 本机 runner/mock 测试方式写回 `SKILL.md`

原因：

- 这几项决定的是工作流能不能被别人稳定复现

### 第三优先级

最后再考虑：

1. `init_manifest.py` 的二层语义校验
2. 更细的 analyze 结果质量规则

原因：

- 这部分更像质量增强，不是当前跑通工作流的前置条件

---

## 8. 推荐下一步

如果继续推进，最合理的顺序建议是：

1. 先补 `boards` 目录
2. 再补 `SKILL.md` 协议细节
3. 再增强 `init_manifest.py` 的二层校验规则草案

不建议马上扩到下一个 phase。

当前最重要的是先把：

**`upy-analyze-plugin` 变成一个边界清楚、协议清楚、资源完整的独立 skill。**

---

## 9. 一句话结论

`upy-analyze-plugin` 现在已经不是“能不能跑”的问题，而是：

**还差协议细化、boards 资产补齐、以及校验能力从“结构正确”走向“结果合理”。**
