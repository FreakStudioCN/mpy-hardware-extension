# `upy-analyze-plugin` LLM Analyze 接口层与 Claude Code 测试方案

## 1. 目标

当前 `upy-analyze-plugin` 已经具备：

- 插件化输入边界
- 确认卡片协议
- `manifest_content` 交付约束
- 本机 mock 演练链路
- 第一层结构校验
- 轻量第二层语义校验

下一阶段的目标不是继续堆规则，而是：

**把“需求分析引擎”从规则模拟器，升级成真正的 LLM analyze 接口层。**

---

## 2. 当前状态和下一阶段的分工

目前可以把 `upy-analyze-plugin` 分成两层看：

### 2.1 插件工作流壳子

这一层已经基本成形，负责：

- 接收 `start_phase`
- 发 `status_update`
- 发 `approval_request`
- 接收 `approval_response`
- 调 `init_manifest.py`
- 发 `phase_complete`

### 2.2 分析引擎

这一层当前还是模拟实现，主要在：

- `analyze_runner.py`

它现在还是：

- 关键词推断器件
- 规则补默认值
- 规则分流替代推荐 / 冷门驱动

下一阶段要替换的核心就是这一层。

---

## 3. 推荐的 LLM Analyze 接口层结构

建议不要直接把 LLM 调用逻辑硬塞进现有 `analyze_runner.py`，而是单独拆出一个接口层，例如：

```text
upy-analyze-plugin/
  llm_analyze.py
  analyze_runner.py
  scripts/init_manifest.py
```

推荐职责划分如下：

### `llm_analyze.py`

负责：

- 读取标准 analyze 输入
- 构造 prompt
- 调用 LLM
- 解析 LLM 输出
- 返回结构化中间结果

输出目标：

```json
{
  "project_name": "...",
  "requirements": {
    "description": "..."
  },
  "devices": [
    {
      "name": "...",
      "type": "...",
      "interface": "...",
      "source": "user_specified | system_recommended",
      "driver": {
        "source": "builtin_runtime | micropython_lib | upypi | awesome-micropython | github | none | cold-driver"
      }
    }
  ]
}
```

### `analyze_runner.py`

负责：

- 读取 `start_phase`
- 调用 `llm_analyze.py`
- 发器件确认卡片
- 接收用户修改
- 走补充卡片
- 走驱动搜索和分流
- 调 `init_manifest.py`
- 发 `phase_complete`

也就是说：

**`analyze_runner.py` 管工作流，`llm_analyze.py` 管理解用户需求。**

---

## 4. LLM 输入建议

LLM 输入至少应包含：

- `user_description`
- `pre_selected_board`
- `preferences.mode`
- `preferences.locale`
- `existing_hardware`

并明确告诉模型：

- 只做 analyze
- 不做板卡最终选型
- 不做代码生成
- 不做引脚分配
- 器件来源必须区分：
  - `user_specified`
  - `system_recommended`
- 输出必须是 JSON

建议提示词里直接给出约束：

```text
你是 upy-analyze-plugin 的 analyze 引擎。

你的任务是把用户需求解析为结构化结果：
- project_name
- requirements.description
- devices[]

要求：
- 不选最终板卡
- 不生成代码
- 不分配引脚
- 用户明确提到的器件标记为 user_specified
- 你补出来的器件标记为 system_recommended
- interface 只能使用:
  I2C, SPI, UART, GPIO, PWM, ADC, I2S, 1-Wire, CAN, USB, WiFi, BLE
- 输出必须是 JSON，不要输出解释文字
```

---

## 5. LLM 输出建议

LLM 输出不要一步就试图把最终完整 manifest 全做完。

更稳的做法是：

### 第一阶段输出

只输出 analyze 中间草稿：

- `project_name`
- `requirements.description`
- `devices[]`

不要强迫模型一次填满所有 requirements 字段。

因为：

- `scene`
- `power`
- `sample_rate`
- `output`

这些还要经过补充卡片和默认值逻辑。

### 第二阶段

再由现有流程：

- 用户确认
- 补充卡片
- 驱动搜索
- `init_manifest.py`

逐步补齐最终 manifest。

这样比让 LLM 一步到位生成最终 manifest 稳得多。

---

## 6. 为什么不要太早让 LLM 直接输出最终 manifest

因为那样会把太多责任一次性压给模型：

- 需求理解
- 器件识别
- requirement 填充
- 驱动来源判断
- 枚举值选择
- 冷门驱动打标

这会导致两个风险：

1. 出错时不容易定位
2. 一旦协议变动，prompt 返工量很大

所以建议顺序是：

1. LLM 先只负责“理解用户需求 + 产出器件草稿”
2. 协议层继续负责确认、补充、校验、分流

---

## 7. 与 `init_manifest.py` 的关系

引入 LLM 后，`init_manifest.py` 仍然必须保留。

它的定位不是替代 LLM，而是作为：

- 第一层结构校验
- 第二层轻量语义边界检查
- 最终交给下游前的守门器

理想链路：

```text
LLM 输出 analyze 草稿
→ 协议流程补齐信息
→ init_manifest.py 校验
→ phase_complete
```

---

## 8. Claude Code 真 Skill 测试方式

你提到的这个方式是对的：

```text
复制 skill 到 C:\Users\Administrator\.claude\skills\
→ 重新开启一个新的 Claude Code 会话
→ 使用 /upy-analyze-plugin
→ 真测 skill
```

这个流程非常适合验证：

- 真正的 LLM analyze 是否按 skill 约束工作
- `SKILL.md` 是否足够清楚
- 样例和协议定义是否能约束住模型

---

## 9. Claude Code 测试步骤建议

### Step 1: 复制 skill

目标路径：

```text
C:\Users\Administrator\.claude\skills\upy-analyze-plugin
```

建议复制内容包括：

- `SKILL.md`
- `boards/`
- `sample/`
- `scripts/`
- 需要时再带上本地测试辅助脚本

### Step 2: 每次改 skill 后，重新开启 Claude Code

这是关键约束：

**每次修改了 skill 内容后，都重新开启一个新的 Claude Code 会话。**

原因：

- 避免旧 skill 缓存
- 避免旧上下文污染
- 避免误以为新改动已经生效

### Step 3: 在新会话里显式调用

例如：

```text
/upy-analyze-plugin
```

然后喂真实用户需求。

### Step 4: 重点观察的内容

重点不是只看“模型聪不聪明”，而是看：

- 是否遵守 skill 边界
- 是否按要求只做 analyze
- 是否区分 `user_specified / system_recommended`
- 是否在需要时停在确认点
- 是否能产出可校验的结构化结果

---

## 10. 建议的测试用例

建议至少准备 4 组测试：

### 用例 A：普通监测类

例如：

```text
做一个温湿度监测仪，超过阈值蜂鸣器报警，并在 OLED 上显示数据
```

看点：

- 是否识别温湿度传感器
- 是否补显示器和蜂鸣器

### 用例 B：交互类

例如：

```text
做一个能对话的植物助手，能读取土壤温湿度，摸这个装置可以发出语音，可以和他对话
```

看点：

- 是否补土壤湿度 / 语音输入 / 语音输出 / 触摸
- 是否不会只回固定三件套

### 用例 C：用户指定器件类

例如：

```text
我要用 SHT30、SSD1306 和一个蜂鸣器做报警装置
```

看点：

- `SHT30/SSD1306` 是否被标成 `user_specified`
- 蜂鸣器是否可能是 `system_recommended`

### 用例 D：器件不明确类

例如：

```text
做一个室外监测设备，要采集环境数据并上传
```

看点：

- 是否只补通用器件草案
- 是否不会假装已经锁定过细型号

---

## 11. 当前推荐顺序

当前最合理的推进顺序是：

1. 保持现有插件工作流壳子稳定
2. 设计 `llm_analyze.py` 的输入输出接口
3. 用 Claude Code 真 skill 调用验证 `SKILL.md`
4. 再决定是否把 runner 的规则提取彻底替换成 LLM 输出

不建议现在马上删掉现有 runner 规则层。

更好的做法是：

- 先并存
- 先验证
- 再替换

---

## 12. 一句话结论

如果目标是“尽量接近真实插件情况”，那么：

**先保留现在的插件工作流壳子，把 LLM 接成独立 analyze 引擎层，再通过复制到 `.claude\skills` + 每次改完重开 Claude Code 的方式做真 skill 测试，是最稳的路线。**
