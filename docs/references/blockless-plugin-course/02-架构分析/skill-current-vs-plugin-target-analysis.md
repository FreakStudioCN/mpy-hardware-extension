# 现有 Skill 和 `plugin-interface` 的关系：什么是现状，什么是目标

这份文档只做一件事：

**把你脑子里现在混在一起的两套东西拆开。**

因为你刚才纠正得很对：

> `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface`
> 是计划修改和预计接口，不是现状。

所以后面分析必须分成两层：

1. **现状**：`G:\MicroPython_Skills` 里现在真实存在的 skill，今天就能被 Claude Code 直接加载执行
2. **目标**：`plugin-interface/` 这套“预计的插件接口和工作流协议”，它是未来改造方向，不是今天已经落地的东西

如果这两层不分开，你就会一直有一种感觉：

```text
现有 skill 明明还能跑
但 plugin-interface 又看起来像另一套系统
我不知道自己到底该改哪里
```

这个困惑是正常的。根因不是你不懂插件，而是：

**现在手头同时存在“现有可运行版本”和“目标协议改造草案”两套表达。**

---

## 1. 先下结论

你现在不该做的是：

- 把 `plugin-interface/` 当成现状去维护
- 把里面每一份 phase 文档继续填得更细
- 先去学插件实现细节

你现在该做的是：

**用 `plugin-interface/` 当“目标蓝图”，反过来分析现有 `G:\MicroPython_Skills` 里的 skill 到底离这个蓝图差多远。**

换句话说：

```text
现有 skill = 今天能跑的业务逻辑
plugin-interface = 明天要改造成的插件工作流接口
```

你现在要做的是“做差距分析”，不是“继续填接口文档”。

---

## 2. 现状到底是什么

现有 skill 都在：

- `G:\MicroPython_Skills`

从目录看，核心 skill 族是这些：

```text
upy-analyze
upy-select-hw
upy-scaffold
upy-generate
upy-simulate
upy-deploy
upy-autofix
upy-wiring
upy-diagram
upy-gen-driver
upy-pack-driver
upy-gen-readme
upy-gen-pkg
upy-norm-driver
...
```

这些目录里真实存在的东西，通常是：

- `SKILL.md`
- `scripts/`
- `.skillfish.json`

这说明现有体系的真实运行方式还是：

```text
LLM 直接加载 SKILL.md
然后按 skill 里的 Read / Write / Bash / AskUserQuestion 之类动作去做事
```

这就是你说的：

> 当前 skill 基于对话交互式的，直接 Claude Code 加载，似乎是没有问题

这个判断是对的。

### 现有 skill 的本质

现有 skill 的本质是：

**面向“本地 agent 直接执行”的专家操作手册。**

它默认假设：

- 可以直接读文件
- 可以直接写文件
- 可以直接跑 Python
- 可以直接跑 mpremote
- 可以直接问用户问题

也就是说，它默认自己既是：

- 决策者
- 又是执行者

这是现状。

---

## 3. 目标又是什么

你认可的方向在：

- `G:\blockless-plugin-course(1)\embedded-skill-plugin-interface-workflow.md`

而计划中的目标接口草案在：

- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface`

这套东西表达的目标是：

```text
服务器端 LLM 负责加载完整 SKILL.md 并做业务决策
插件只负责：
  UI
  文件读写
  脚本执行
  mpremote / 设备命令
```

所以目标体系的本质不是“新的业务逻辑”，而是：

**把原来 skill 里那些“直接执行”的动作，拆成“发消息让插件执行”。**

比如原来 skill 里是：

```text
Bash("python extract_pdf.py ...")
```

目标里就会变成：

```json
{
  "type": "script_run",
  "payload": { ... }
}
```

原来 skill 里是：

```text
AskUserQuestion("确认器件清单")
```

目标里就会变成：

```json
{
  "type": "approval_request",
  "payload": { ... }
}
```

这就是目标。

---

## 4. 所以你现在面对的是“同一套业务，两种运行形态”

这句话最重要。

你现在不是在做两套完全不同的产品逻辑。

你是在面对：

### 形态 A：现有本地交互式 skill

特点：

- 可以直接跑
- 适合本地验证业务逻辑
- 适合你这种懂嵌入式的人先把流程跑顺

### 形态 B：目标插件化 skill

特点：

- 不直接执行本地动作
- 所有本地动作都改成“消息”
- 适合以后接 VS Code 插件

所以，最重要的理解应该是：

**你不是要重写业务流程。**

**你是要把现有业务流程，从“本地直跑形态”翻译成“插件消息形态”。**

---

## 5. 为什么你会觉得 `plugin-interface` 复杂、不直观

因为它不是写给“只懂嵌入式”的你一个人看的。

它同时服务于：

- 插件工程师
- 服务器工程师
- skill 维护者

所以它天然会包含：

- 架构边界
- 协议字段
- UI 卡片形态
- 并行开发策略
- 每个 phase 的消息流

对插件工程师来说，这是“实现说明书”。

对你来说，它现在更适合当：

**对照表**。

也就是：

```text
看看现有 skill 中哪一步
未来应该对应成什么消息
```

而不是：

```text
我现在就要完全照着它去填满所有 phase 文档
```

后者会让你很快迷失。

---

## 6. 现有 skill 和目标插件接口，差在哪里

下面我只做分析，不做填充。

### 6.1 `upy-analyze`

#### 现状

从 `G:\MicroPython_Skills\upy-analyze\SKILL.md` 看，现有 skill：

- 先做前置环境检查
- 直接解析用户描述
- 直接用 `AskUserQuestion` 分流“小白/自定义”
- 直接问主控
- 直接确认器件
- 直接调用包搜索
- 直接写 manifest

也就是说，现状是一个**面向本地交互会话的 skill**。

#### 目标形态

在 `plugin-interface/skills/upy-analyze.md` 草案里，预计它会被改造成：

- 插件先发 `start_phase`
- 用户偏好和预选板卡直接在输入 payload 里给进来
- 器件确认改成 `approval_request`
- 替代推荐改成 `approval_request`
- manifest 不直接写本地，而是进入 `phase_complete.manifest_content`

#### 差距的本质

不是 analyze 逻辑要推翻。

而是这些动作要“消息化”：

- `AskUserQuestion` → `approval_request`
- 本地环境检查 → 从 skill 中删除或下沉
- 本地写 manifest → 变成结构化输出

### 6.2 `upy-gen-driver`

#### 现状

从 `G:\MicroPython_Skills\upy-gen-driver\SKILL.md` 看，现有 skill：

- 直接判断输入类型（PDF / Arduino / GitHub / chip model）
- 直接 `python extract_pdf.py`
- 直接 `python convert_arduino.py`
- 直接 `mpremote devs`
- 直接 `mpremote connect ... run ...`
- 直接循环修驱动

这是一个非常典型的：

**业务上已经很完整，但执行上还是“本地直跑”的 skill。**

#### 目标形态

在 `plugin-interface/skills/upy-gen-driver.md` 草案里，预计它会被改造成：

- 输入材料通过插件文件上传给进来
- 预处理脚本改成 `script_run`
- 无设备时通过 `approval_request` 停下来
- 设备命令改成 `device_command`
- 输出必须以 `phase_complete` 收尾
- 中断要支持 `partial + checkpoint`

#### 差距的本质

这不是“驱动生成逻辑不行”。

而是：

- 现有 skill 会自己动手干所有事
- 目标形态要求它只负责决策，让插件代劳执行

这正是你们需要改造的地方。

### 6.3 `upy-publish`

#### 现状

这里要特别小心。

`plugin-interface/skills/upy-publish.md` 里已经写了一个“目标接口草案”，但从 `G:\MicroPython_Skills` 真实目录看：

- `upy-pack-driver/` 目录只有 `SKILL.md`，没有 `scripts/pack_driver.py`
- `upy-deploy/` 目录也没有你们草案里提到的 `run_on_device.py`
- 全局也没有 `publish_to_upypi.py`
- 全局也没有 `upypi_query.py`

也就是说：

**现有 publish 收尾能力在真实 skill 层还没有落成完整脚本闭环。**

#### 目标形态

`plugin-interface/skills/upy-publish.md` 描述的是未来理想状态：

- 读生产版驱动
- 生成 README
- 生成 package.json
- 组织标准目录
- 可选上传 upypi

#### 差距的本质

这里不是“把本地交互改成插件消息”这么简单。

这里还有一层更基础的问题：

**现有真实 skill 侧本身就还没把 publish 路径做实。**

所以对你来说，publish 现在应该被视为：

- 业务目标已明确
- 目标接口草案已写
- 真实收尾脚本和运行闭环还没补齐

这也解释了为什么你会觉得“收尾步骤缺少、插件也不直观”。

---

## 7. 你接下来到底该怎么用 `plugin-interface`

这里最重要的一点是：

**不要把 `plugin-interface/` 当“我要继续填满的文档目录”。**

你现在更应该把它当：

### 7.1 目标蓝图

用来回答：

- 未来插件接口大概长什么样
- 哪些消息类型已经想清楚了
- 哪些 phase 的目标流已经设计过了

### 7.2 对照模板

用来回答：

- 现有 skill 的哪一步，将来应该对应哪种消息

### 7.3 差距清单来源

用来回答：

- 哪些东西现有 skill 已经具备
- 哪些东西只是目标草案里写了，但真实 skill 还没有

所以你接下来的工作重点不应该是：

```text
继续把 plugin-interface 写得更完整
```

而应该是：

```text
用 plugin-interface 去反推：
现有 skill 哪些地方要改
哪些地方先别改
哪些地方缺脚本
哪些地方只是接口想法还没实体
```

---

## 8. 你现在最应该怎么分“现状工作”和“目标工作”

这是最关键的操作层分法。

### 8.1 现状工作：先把现有 skill 跑顺

这部分完全围绕真实 skill：

- `upy-analyze/SKILL.md`
- `upy-gen-driver/SKILL.md`
- `upy-pack-driver/SKILL.md`
- 相关真实 `scripts/`

你要回答的是：

- 今天这个 skill 本地直跑，流程是否顺
- 哪些脚本真实存在
- 哪些步骤只是写在 SKILL.md 里，但其实没脚本支撑
- 哪些 phase 逻辑已经成熟

### 8.2 目标工作：再标出未来怎么协议化

这部分围绕 `plugin-interface/` 草案：

- 不是填充
- 是映射

你要回答的是：

- 现有的 `AskUserQuestion` 将来改成什么
- 现有的 `Bash(mpremote ...)` 将来改成什么
- 现有的 `Write` 将来改成什么
- 这一步未来是否应该支持 `partial`
- 这一步未来是否应该有 `checkpoint`

---

## 9. 对你最实用的一条路线

如果只讲“你明天开始怎么干”，我建议这样。

### 第一步：只看真实 skill，不看插件实现

先只看：

- `G:\MicroPython_Skills\upy-analyze`
- `G:\MicroPython_Skills\upy-gen-driver`
- `G:\MicroPython_Skills\upy-pack-driver`
- `G:\MicroPython_Skills\upy-gen-readme`
- `G:\MicroPython_Skills\upy-gen-pkg`

目的：

```text
把现有真实能力盘清楚
```

### 第二步：给每个关键 phase 做“现状卡片”

比如 analyze / gen-driver / publish 各写一页：

```text
这个 phase 现在真实输入是什么
这个 phase 现在真实会调用哪些脚本
这个 phase 现在真实会直接执行哪些命令
这个 phase 现在有哪些地方会问用户
这个 phase 缺什么脚本/能力
```

### 第三步：再拿 plugin-interface 对照

然后只回答一个问题：

```text
如果以后要插件化
这些动作分别要变成什么消息
```

这样你就不会掉进“先补接口文档”这个坑。

---

## 10. 最后一句

你现在最该做的，不是“继续完善 `plugin-interface/` 文档”。

你最该做的是：

**把 `plugin-interface/` 从“我要去填的东西”，改成“我拿来对照现有 skill、做插件化差距分析的蓝图”。**

因为对你这种只懂嵌入式的人来说，最重要的第一步不是学插件，而是先把下面这句话彻底想清楚：

**现有 skill 今天是怎么跑的，明天要变成插件形式时，哪些动作要从“自己执行”改成“发消息让插件执行”。**

