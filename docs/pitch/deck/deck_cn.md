# STATUS: DEPRECATED / DO NOT USE

This CN deck is pre-Phase-3-diligence material and is not synchronized with the
current evidence standard in `deck_en.md` and `docs/research/blockless_diligence_pack.md`.
It still contains unsafe or unverified framing around market proof, closed-loop
claims, app/store distribution, Schematik, Kickstarter, and broad AI-hardware
positioning.

Use `docs/pitch/deck/deck_en.md` as the active pitch source. Before reviving
this CN deck, rewrite it from the current EN deck and re-run the claim scans in
`HANDOFF.md`.

---
# Pitch Deck - 中文比赛版 v22

> 日期：2026-05-30
> 受众：创业比赛 / 路演评委 / 创客教育合作方
> 定位：AI 原生硬件创作入口，FabLab 认证节点路径 × 中国供应链交付

---

## Slide 1 - 封面

# 说一句话，造出能跑的硬件。

软件有 Cursor / Lovable。

硬件也应该有一个同样低门槛的创作入口：用户说出想法，系统完成选型、驱动匹配、代码生成、依赖安装、本地烧录、串口调试，并把可运行项目连接到模块和供应链。

---

## Slide 2 - 时代变化

### AI 已经开始接管数字世界，但物理世界还停在手工拼装阶段。

| 数字世界 | 已发生的变化 |
|---|---|
| 写代码 | 从补全，到 agent 自己改多文件、跑任务、修错误 |
| 做网页 / app | 从手写页面，到一句话生成原型和完整页面 |
| 做图像 / 视频 | 从工具操作，到自然语言生成资产 |
| 做硬件 | 仍然要选型、接线、找库、烧录、看串口 |

下一代创作工具不应该只停在屏幕里。AI 真正进入物理世界，必须能把想法变成可运行的设备。

---

## Slide 3 - 用户痛点

### 创作者不是没有想法，是卡在硬件落地链路。

- **选型难**：ESP32 / Arduino / STM32、传感器、执行器、通信方式，选择太多。
- **接线难**：I2C / SPI / UART / ADC、电压、引脚复用，任何一步错都跑不起来。
- **驱动难**：资料分散在 GitHub、厂商 PDF、论坛、示例代码里，AI 很容易编出不存在的 API。
- **调试难**：硬件错误不是普通编译错误，而是串口日志、供电问题、接线问题、固件版本问题混在一起。

今天的门槛，不在“想象力”，而在“把东西真的跑起来”。

---

## Slide 4 - 为什么 AI 做硬件更难

### 普通软件 agent 到了硬件现场会失效，因为它缺三样东西。

| 缺口 | 具体表现 | 后果 |
|---|---|---|
| 真实驱动知识 | MCU、传感器、库版本、固件能力高度碎片化 | LLM 容易幻觉 API 和安装方式 |
| 本地执行权限 | 烧录、串口、文件上传必须访问用户电脑和开发板 | 纯网页 demo 很难形成闭环 |
| 硬件状态感知 | 模块不会主动告诉系统“我是谁、能做什么、接在哪” | AI 只能猜引脚、猜协议、猜错误原因 |

所以核心不是“让 AI 写一段代码”，而是给 AI 一套能读包、能连板、能看反馈、能识别模块的硬件运行系统。

---

## Slide 5 - 市场与生态证据

### 硬件创作生态足够大，工具链复杂度也在继续上升。

- Arduino 官方 2024 开源报告显示，Library Manager 2024 年新增 **1,198** 个贡献库，总数达 **7,669** 个。
- Arduino 2024 年发布 **3 个 Arduino Lab for MicroPython** 版本，MicroPython 已进入主流创客工具链。
- Schematik 2026 年 4 月宣布完成 **$4.6M pre-seed**，说明“AI 原生硬件创作”已经被资本验证。
- Kickstarter Technology 类项目累计获得 **$1.95B pledges**，说明技术硬件有成熟商业化通道。

生态越大，库和设备越多，新手越需要一个能把链路串起来的入口。

公开资料：Arduino Open Source Report 2024；Schematik 官方公告；Kickstarter Stats。

---

## Slide 6 - 一句话背后的真实数据流

### “一句话造硬件”不是聊天框，而是一条可落地的工程流水线。

1. 用户说需求：做一个温湿度监测器，超过阈值亮灯并显示数值。
2. 系统获得硬件画像：绑定设备、I2C 扫描、手动勾选模块，或用自然语言描述硬件。
3. Agent 做能力匹配：判断需要显示、传感、通信、执行器等 `hardware_tags`。
4. 关联 Package Intelligence：读取 `package.json`、README、driver context、依赖、芯片支持和固件要求。
5. 生成 MicroPython 项目：代码、驱动、资源、配置文件一起生成。
6. 打包成 `.mpk`，写入 `MANIFEST.JSON`，可下载、推送设备、在线编辑、保存草稿或发布到 uPyStore。
7. 本地 IDE / VS Code 插件调用 `mpremote`，安装依赖、上传代码、运行、读取串口输出并自动修复。

一句话只是入口，真正的壁垒在后面的硬件画像、驱动检索、应用打包、本地运行和反馈修复。

---

## Slide 7 - 技术栈总览

### 我们不是聊天框，而是一套 AI 原生硬件开发栈。

| 层 | 作用 | 关键实现 |
|---|---|---|
| Agent / Skill 层 | 把自然语言拆成硬件任务和执行步骤 | 项目生成、错误修复、Arduino/PDF 驱动转换、测试生成 |
| 知识与包层 | 让 AI 用真实驱动，不靠瞎猜 | Package Intelligence、uPyPI/GraftSense、driver context、deps、chips/fw 标签 |
| 本地执行层 | 让 AI 能真的碰到开发板 | Thonny 插件、VS Code 插件、`mpremote run/exec/fs`、串口日志 |
| 应用运行层 | 让项目可安装、可升级、可回滚 | uPyOS 0.9.0、LVGL、D-Shell、`.mpk`、`MANIFEST.JSON` |
| 设备画像层 | 让系统知道真实硬件能力 | `device_fingerprint`、`device_profiles`、`hardware_tags`、modules 注册表 |
| 模块交付层 | 让方案从 demo 变成套件 | GraftSense 传感器模块、GraftPort 扩展板、Dev Kit、生产 SOP |

这套栈的价值是把 AI 从“写代码的人”变成“能交付硬件项目的操作员”。

---

## Slide 8 - Package Intelligence / IDE

### Package Intelligence 解决“找包难、找包乱”，IDE 插件把包管理放进真实工作流。

- uPyPI + GraftSense + curated recipes 可索引 **200+ 个 MicroPython 包/驱动**，覆盖传感器驱动、通信模块、人机交互等场景。
- 包详情包含名称、版本、描述、作者、license、芯片支持、固件依赖、文件列表等机器可读信息。
- Thonny 插件支持在 IDE 内搜索、查看元数据、下载缓存，并通过 `mpremote` 安装到开发板 `/lib`。
- 插件处理多文件包、依赖、网络失败、`mpremote` 未配置、开发板未连接等错误场景。

这意味着我们的 AI 不必凭空编驱动，而是可以调用一个结构化、可安装、可验证的 MicroPython 包生态。

---

## Slide 9 - 本地运行闭环

### MicroPython + mpremote 更适合 AI 反复试错。

| 闭环环节 | 传统 Arduino / C 路径 | 我们的 MicroPython 路径 |
|---|---|---|
| 写代码 | `.ino` 隐式规则、多文件拼接、C/C++ 依赖复杂 | Python 结构清晰，AI 更容易生成和修复 |
| 安装依赖 | 手动找库、复制代码、处理版本冲突 | 包搜索 + IDE 内安装 + 依赖自动处理 |
| 运行反馈 | 编译、烧录、串口监视器分散，改一次等一次 | `mpremote run/exec/fs`，上传、运行、读日志在一条链路 |
| 自动修复 | 用户自己看串口和资料 | agent 读取错误输出后改代码、重跑、再验证 |

硬件 AI 的关键差异不是“生成第一版代码”，而是把设备反馈纳入 agent 循环。

---

## Slide 10 - uPyOS / uPyStore 系统架构

### 我们把一次性代码，变成 MCU 上可安装、可推荐、可分发的应用。

| 组件 | 具体设计 | 价值 |
|---|---|---|
| uPyOS 0.9.0 | MicroPython + LVGL，运行于 ESP32 / ESP32-S3 等 MCU | 让单片机具备桌面启动器、应用安装卸载、系统设置、WiFi 管理 |
| D-Shell | 搭载 uPyOS 的硬件终端设备 | 类比 Android 手机，是 uPyOS 的主要运行载体 |
| `.mpk` | uPyOS 应用安装包，本质是固定结构压缩包 | 对标 APK，让硬件应用可以安装、更新、分发 |
| `MANIFEST.JSON` | 声明应用名称、版本、入口、发布者等 | 对标 Android 清单文件，保证应用可被系统识别 |
| `app_index.json` | 设备端商城静态入口文件，字段结构必须稳定 | 出厂设备依赖它拉取应用索引，不能随意破坏兼容 |

V2 能力继续往前走：`device_fingerprint` 做匿名设备识别，`device_profiles` 保存硬件画像，`hardware_tags` 声明应用依赖，modules 注册表记录芯片、接口、能力、关联 package candidates 和蓝牙广播信息。

---

## Slide 11 - 竞品与路线差异

### 赛道被验证，但谁能跑通真实设备还没有定型。

| 维度 | Schematik / 网页类 AI 硬件工具 | 我们 |
|---|---|---|
| 输出物 | 代码、接线图、物料清单、教程 | 可运行 MicroPython 项目 + 模块组合 + 本地烧录调试 |
| 驱动来源 | 依赖模型生成或公开示例 | Package Intelligence、真实包、README、`package.json`、driver context |
| 执行闭环 | 多数停在生成和说明 | `mpremote` 连接开发板，读取串口，自动修复 |
| 硬件抽象 | AI 选择元器件和引脚 | 主动模块自描述，系统读取能力后再生成方案 |
| 交付路径 | 用户仍要采购、焊接、调试 | 模块、套件、小批量生产 SOP 接上供应链 |

我们的判断是：AI 硬件不只需要“设计工具”，还需要“运行时、模块生态和交付链路”。

---

## Slide 12 - FabLab 认证节点路径 × 中国供应链

### FabLab 不是一句“国际资源”，而是一条材料里已经写清楚的落地路径。

| 资源 | 材料支持的事实 | 对项目的意义 |
|---|---|---|
| FabLab 国际体系 | FabLab 由 MIT 比特与原子研究中心发起，是全球创客教育与数字制造网络 | 可引入课程体系、技术文档、国际项目和创客社区资源 |
| 申请运营资质 | 材料写明核心成员已完成 FabLab 官方认证课程，具备申请并运营 FabLab 节点的资质 | 不是泛泛合作想象，而是具备节点申报和运营能力 |
| 联合高校落地 | 材料提出可依托中北大学，联合申请设立 FabLab 认证节点 | 可以把“一句话造硬件”放进高校新工科、实训、竞赛和创客空间 |
| 中国供应链 | ESP32、传感器模块、PCB、SMT、小批量制造响应快 | FabLab 做教育和原型验证，中国供应链做套件与产品交付 |

公开资料可说明 FabLab 的全球影响力；我们自己的材料则说明“怎么接入”：完成认证课程、具备申请运营资质、以高校为依托联合申请节点。

---

## Slide 13 - GraftSense/Port/Dev Kit 交付体系

### 我们不是只有软件栈，也有模块、扩展板、套件和小批量生产 SOP。

| 交付层 | 材料里的具体内容 | 说明什么能力 |
|---|---|---|---|
| GraftSense | 系列传感器模块，硬件设计规范基于 Grove；已有 RCWL-9623 收发一体式超声波模块模板 | 有真实模块产品线，不是只做软件 demo |
| GraftPort | 扩展板设计规范、成本和采购单 | 能把多个模块标准化接入开发板和教学场景 |
| Dev Kit | GraftSense/Port Dev Kit 套件盒子、成本采购表、定价表、宣传单 | 能面向教育、比赛、课程做成套交付 |
| 生产 SOP | 设计、验证、驱动、文档、小批量生产、商品页、推广、进度管理 | 从原型到商品页和小批量生产都有流程 |

所以商业闭环不是“卖一个 AI 软件”：IDE / Skill 生成项目，uPyStore 分发应用，GraftSense/Port/Dev Kit 让项目买得到、拼得上、交付得出去。

---

## Slide 14 - 愿景

### 未来每个智能设备，都可以被“说”出来。

我们要做的不是又一个代码生成器，而是下一代硬件创作入口：

- AI 理解意图，把想法拆成硬件任务。
- Package Intelligence 和 uPyOS 提供可检索、可安装、可复用的软件生态。
- 主动模块让硬件能被系统识别，而不是让 AI 盲猜。
- 本地 IDE 和 `mpremote` 让 agent 真实运行、读取反馈、自动修复。
- 中国供应链把 demo 变成套件、课程和小批量产品。

一句话，从想法到能跑、能复用、能交付的硬件。
