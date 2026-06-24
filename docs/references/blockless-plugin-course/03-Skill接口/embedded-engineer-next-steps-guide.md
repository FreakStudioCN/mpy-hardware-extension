# 只懂嵌入式时，怎么把 Skill 变成插件可接的形态

这份文档只解决一个问题：

**如果你只懂 MicroPython、驱动、调试流程，不懂 VS Code 插件，也不想一上来就掉进 `plugin-interface/` 的细节里，现在该怎么推进？**

先给结论：

**你不需要先学会插件开发。**

你真正要做的只有三件事：

1. 把每个 Skill 的业务流程梳理清楚
2. 把每一步需要插件帮你做的动作写成结构化消息
3. 用一个很傻的 `mock_plugin.py` 验证这些消息序列是通的

换句话说：

**你先把“我要插件做什么”说清楚，不需要先把“插件内部怎么实现”学会。**

---

## 1. 先把心态摆正：你不是在“学插件开发”

你现在最大的误区，很可能是把事情想成：

```text
我得先懂 VS Code 插件
→ 才能改 skill
```

其实顺序应该反过来：

```text
先把 skill 的业务流程讲清楚
→ 再把需要插件代劳的动作列出来
→ 插件工程师按这份清单去实现
```

你负责的是：

- 流程
- 规则
- 决策
- 输入输出
- 失败路径
- 恢复点

插件工程师负责的是：

- 卡片怎么画
- 文件怎么读写
- 脚本怎么执行
- mpremote 怎么调用
- 流怎么显示

所以你不要把自己代入“插件实现者”。

你应该把自己代入：

**“我是在给插件工程师写一份很清楚的施工图。”**

---

## 2. 你当前手里有哪些靠谱材料

从当前文件状态看，你其实已经不是从零开始。

### 2.1 已经有的总体思路

你认可这份：

- `G:\blockless-plugin-course(1)\embedded-skill-plugin-interface-workflow.md`

这份文档的核心方向是对的：

- server-side LLM 加载完整 `SKILL.md`
- 插件只做 UI + 本地 I/O + 设备命令
- 先本地跑通，再协议化，再 mock，再联调

这个方向可以继续用，不用推翻。

### 2.2 已经有的功能划分

你们对“一句话造硬件”的 skill 划分，已经在：

- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\一句话造硬件-功能规划.md`

里面写得很全了。

这份文件的价值，不是拿来给插件工程师看，而是拿来回答：

- 整条流水线有哪些 phase
- 每个 phase 大概负责什么
- 哪些是主流程
- 哪些是异常路径

### 2.3 已经有的插件接口草案

你现在最应该依赖的是：

- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\01-architecture.md`
- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\02-protocol.md`
- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\03-parallel-dev.md`
- `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\README.md`

但要注意一个关键定位：

**`plugin-interface/` 是“计划修改和预计接口”，不是当前真实运行现状。**

所以它的作用是：

- 给你看未来插件化之后大概会长什么样
- 帮你做“现有 skill -> 目标消息协议”的映射

**不是让你把它当成当前系统事实去继续填充。**

而不是一上来把整个 `plugin-interface/skills/*.md` 全部细读一遍。

原因很简单：

- `01-architecture.md` 讲职责边界
- `02-protocol.md` 讲消息类型
- `03-parallel-dev.md` 讲怎么并行开发
- `skills/README.md` 告诉你哪些 phase 已经写得差不多，哪些还没收尾

这 4 份，已经够你开始干活。

---

## 3. 为什么你会觉得 `plugin-interface` 很复杂

因为你现在看到的不是一份“嵌入式操作手册”，而是一份“跨角色协作文档集”。

它天然会同时面向三类人：

- 插件工程师
- 服务器工程师
- skill 维护者

所以你读它时会有一种感觉：

```text
每段都能看懂一点
但又不像是在直接教我做事
```

这是正常的。

正确用法不是“从头到尾啃完再动手”，而是分层使用。

### 你只需要这样读

第一层，只看方向：

- `01-architecture.md`

目标：

```text
搞清楚插件和 skill 的职责分界
```

第二层，只看消息类型：

- `02-protocol.md`

目标：

```text
搞清楚服务器能让插件做哪几类动作
```

第三层，只看开发方法：

- `03-parallel-dev.md`

目标：

```text
搞清楚为什么要先本地逻辑、再协议化、再 mock
```

第四层，只看你当前要改的那 1~3 个 phase 的“目标接口草案”：

- `skills/upy-analyze.md`
- `skills/upy-gen-driver.md`
- `skills/upy-publish.md`

目标：

```text
不是全看懂，而是把它当“目标对照模板”，看未来插件化后这一段应该怎么表达
```

不要现在就试图同时理解：

- analyze
- select-hw
- scaffold
- generate
- simulate
- deploy
- autofix
- wiring
- diagram
- gen-driver
- publish

这会把自己淹死。

---

## 4. 你该把任务拆成哪两半

对你来说，所有工作只需要拆成两半：

### 4.1 本地 skill 逻辑验证

这是：

```text
我作为嵌入式工程师，先确认这条业务流程本身对不对
```

这一半完全不需要插件。

你只需要关心：

- 顺序对不对
- 分支对不对
- 生成什么文件
- 用什么脚本
- 没板子时怎么办
- 有板子时怎么验证
- 验证失败怎么修

### 4.2 协议化 + mock 验证

这是：

```text
把刚才已经跑通的业务流程，翻译成“服务器对插件的指令序列”
```

这一半也不需要真的插件。

你只需要一个假的 `mock_plugin.py`：

- 看到 `approval_request` 就自动回确认
- 看到 `file_operation` 就本地写文件
- 看到 `script_run` 就执行脚本或回假结果
- 看到 `device_command` 就回设备输出

这一步的目标不是“开发插件”。

而是验证：

```text
如果有个插件按协议做事
这条流程能不能跑通
```

---

## 5. 你现在最该怎么分“本地测试”和“模拟插件”

你提到现在最不直观的地方之一，就是不知道怎么划分：

- 本地测试
- 模拟插件

这两个确实很容易混。

最简单的区分方式是：

### 本地测试 = 测 skill 逻辑

问的问题是：

```text
这条业务流程本身对不对？
```

用的还是本地工具：

- Read
- Write
- Edit
- Bash
- AskUserQuestion

典型例子：

- `upy-analyze` 是否真的能把一句话拆成器件清单
- `upy-gen-driver` 是否真的能从 PDF 走到调试版驱动
- `upy-publish` 是否真的能补齐 README、package.json、LICENSE

这里不关心插件，不关心消息格式。

### 模拟插件 = 测协议序列

问的问题是：

```text
如果 skill 不再直接读文件/跑命令/问用户
而是改成发协议消息
这条消息链能不能走通？
```

这里你关心的是：

- `approval_request` 发得对不对
- `script_run` 参数对不对
- `file_operation` 路径对不对
- `device_command` 什么时候发
- `phase_complete` 有没有把 checkpoint 和 artifacts 带上

这里不关心页面长什么样，不关心 WebView。

---

## 6. 用一句话理解 `mock_plugin.py`

你可以把 `mock_plugin.py` 理解成：

**一个“装作自己是插件”的最小机器人。**

它不需要有任何前端。

它只要会做 4 件事：

1. 收到确认请求，回一个固定选择
2. 收到文件操作，就真在本地目录里执行
3. 收到脚本执行，就真跑脚本或回固定结果
4. 收到设备命令，就回一份预设输出

它的存在意义只有一个：

**证明你的 skill 已经不依赖人工对话，而是能通过协议和一个“插件代理人”跑起来。**

---

## 7. 你第一周最应该做的事情

如果你现在就开始推进，我建议按这个顺序来。

### 第 1 步：不要再扩散，先只盯 3 个 phase

只看：

- `upy-analyze`
- `upy-gen-driver`
- `upy-pack-driver / upy-gen-readme / upy-gen-pkg` 这一组收尾相关真实 skill

原因：

- `analyze` 是入口
- `gen-driver` 直接对应冷门硬件、PDF、断点恢复
- 收尾相关 skill 直接对应你们最缺的打包发布链

这 3 个打通以后，你的主痛点就已经被覆盖了。

### 第 2 步：先别碰插件实现，先把这几段“真实现状业务流程图”画出来

每个 phase 用最朴素的方法写成：

```text
输入是什么
第一步做什么
第二步做什么
哪一步问用户
哪一步跑脚本
哪一步操作设备
失败怎么办
中断怎么办
最后输出什么
```

不要追求格式漂亮，先把逻辑写顺。

### 第 3 步：本地跑 Phase A

也就是：

```text
先用 Claude Code / 本地 agent 直接加载 SKILL.md
继续用 Read/Write/Bash/AskUserQuestion
把逻辑跑顺
```

这一阶段你只看：

- 流程顺不顺
- 产物对不对
- 失败分支是否合理

### 第 4 步：再做协议翻译

逻辑确认后，再把其中每个动作翻译成消息：

```text
AskUserQuestion -> approval_request
Read/Write -> file_operation
Bash(python ...) -> script_run
Bash(mpremote ...) -> device_command
结束 -> phase_complete
```

这是机械翻译，不是重新设计业务。

### 第 5 步：写最小 mock_plugin.py

这个脚本不要追求通用框架。

先能支持你最急的 3 个 phase 就行。

比如最开始只支持：

- `approval_request`
- `file_operation`
- `script_run`
- `device_command`
- `phase_complete`

### 第 6 步：每个 phase 只跑一个 happy path + 一个失败 path

不要一开始就想把全部边界条件全跑完。

建议最小集合：

#### `upy-analyze`

- happy path：
  - 用户一句话
  - 拆出器件
  - 驱动搜索
  - phase_complete

- failure / branch path：
  - 用户指定器件没驱动
  - 标记到冷门路径

#### `upy-gen-driver`

- happy path：
  - 上传 PDF
  - 提取信息
  - 生成调试版
  - 第 3 轮验证通过
  - 生成生产版
  - 进入下一步

- failure / branch path：
  - 无设备
  - 输出 `partial + checkpoint`

#### 收尾相关真实 skill（`upy-pack-driver / upy-gen-readme / upy-gen-pkg`）

- happy path：
  - 读取生产版驱动
  - 生成 README / package.json
  - 识别还缺什么脚本和目录组织动作

- failure / branch path：
  - 某个脚本其实不存在
  - 某个收尾能力只写在设想里、还没真实落地

---

## 8. 你到底应该看哪些文件，不该看哪些文件

### 现在就该看的

按顺序：

1. `G:\blockless-plugin-course(1)\embedded-skill-plugin-interface-workflow.md`
2. `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\01-architecture.md`
3. `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\02-protocol.md`
4. `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\03-parallel-dev.md`
5. `G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\README.md`
6. `...skills\upy-analyze.md`
7. `...skills\upy-gen-driver.md`
8. 收尾相关真实 skill 的 `SKILL.md`
9. 再看 `...skills\upy-publish.md`，只把它当目标接口草案

### 现在先别深挖的

先不要花太多时间在：

- 真正的 VS Code extension 代码实现
- WebView 样式
- SSE/HTTP 长连接细节
- 插件内状态管理
- 所有 phase 的完整文档

原因很现实：

这些不是你当前的瓶颈。

你当前瓶颈是：

**怎么把嵌入式流程讲清楚，并协议化。**

---

## 9. 你现在最容易犯的 4 个错误

### 9.1 一上来想把 10 个 phase 全部搞完

这会直接把自己做崩。

你真正该做的是先收缩到：

- analyze
- gen-driver
- publish

### 9.2 一边改业务逻辑，一边改协议

这会导致你根本不知道 bug 是逻辑错了，还是协议翻译错了。

正确顺序永远是：

```text
先本地逻辑
后协议翻译
```

### 9.3 把 mock 插件做得太重

`mock_plugin.py` 不是产品，也不是框架。

它只是一个测试替身。

能回消息就够了。

### 9.4 总觉得“我不懂插件，所以我还不能开始”

这是最浪费时间的想法。

你完全可以在不懂插件实现细节的前提下，先把：

- skill 业务流程
- phase 输入输出
- 错误路径
- checkpoint 语义
- mock 消息

全部做出来。

这部分本来就应该由你懂嵌入式的人主导。

---

## 10. 一份你可以直接照着做的最小路线图

下面这条路线，是给“只懂嵌入式”的你准备的。

### 第一天

- 只读 4 份总览文档
- 确定只做 `analyze / gen-driver / publish`
- 不写插件代码

### 第二天

- 画 `upy-analyze` 的业务流程
- 本地跑通 `upy-analyze` 逻辑
- 修顺器件确认和无驱动分支

### 第三天

- 把 `upy-analyze` 翻译成协议消息序列
- 补 `mock-messages`
- 写最小 `mock_plugin.py`

### 第四天

- 画 `upy-gen-driver` 的业务流程
- 本地跑通 PDF → 调试版 → 验证循环 → 生产版

### 第五天

- 把 `upy-gen-driver` 翻译成协议消息
- 重点补：
  - 无设备
  - `partial`
  - `checkpoint`
  - 独立测试脚本
  - 下一步选择

### 第六天

- 画 `upy-publish` 的业务流程
- 明确：
  - README
  - package.json
  - LICENSE
  - 本地包目录
  - 是否上传

### 第七天

- 用同一个 `mock_plugin.py` 跑这 3 个 phase
- 验证：
  - happy path
  - 关键失败 path

到这一步，你就已经把最核心的“嵌入式侧交付物”做出来了。

---

## 11. 你接下来应该怎么和插件工程师协作

你不要把完整 `SKILL.md` 丢给插件工程师。

你应该交付的是 4 样东西：

### 11.1 phase 接口文档 / 目标接口草案

比如：

- `upy-analyze.md`
- `upy-gen-driver.md`
- `upy-publish.md`（注意：这是目标草案，不等于现状已落地）

### 11.2 mock 消息

比如：

- 输入请求卡片
- 无设备 partial
- 硬件验证通过
- 下一步 publish

### 11.3 白名单脚本说明

比如：

- `extract_pdf.py`
- `convert_arduino.py`
- `run_on_device.py`
- `pack_driver.py`

### 11.4 本地测试记录

比如：

- happy path 通过
- no-device partial 通过
- PDF 输入通过
- 独立测试脚本生成通过

插件工程师拿到这些，就可以独立开发。

你不需要等他实现好 UI 才能推进。

---

## 12. 最后一句：你现在该怎么办

如果把上面所有内容压缩成一句行动建议，那就是：

**先别学插件开发，先把 `analyze / gen-driver / 收尾相关真实 skill` 的业务流程、本地验证、协议消息序列、mock 插件测试跑通；`upy-publish.md` 先只当目标接口草案，不当现状。**

因为对你来说，最重要的不是“会不会写 VS Code extension”，而是：

**你能不能把嵌入式流程变成一份任何插件工程师都能照着实现的、清楚可靠的施工图。**

你现在已经有足够的文档基础了。

接下来缺的不是概念，而是按顺序收缩范围、动手拆这 3 个 phase。
