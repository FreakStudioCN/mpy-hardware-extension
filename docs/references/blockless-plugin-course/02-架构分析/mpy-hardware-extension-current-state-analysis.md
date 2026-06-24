# `mpy-hardware-extension` 当前现状梳理

这份文档只基于当前代码状态整理，不沿用旧方案文档里的假设。分析范围主要是：

- 插件仓库：`F:\mpy-hardware-extension`
- 扩展子包：`F:\mpy-hardware-extension\mpy-hardware-extension`
- skill 新方案草案：`G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface`

---

## 1. 先说结论

当前项目不是一个“纯 thin plugin + 服务器端全决策”的实现，而是一个**混合架构**：

- 后端负责认证、积分、包目录、LLM 流式调用、部分 skill/profile 内容。
- VS Code 插件不只是 UI 和 I/O 转发，还承担了：
  - session 状态机
  - agent loop 驱动
  - 工具分发
  - plan/deploy/components 三类确认门
  - 本地代码生成后的写盘与设备部署编排
  - 多种终止条件和重试策略
- Python shim 负责设备 I/O 和部分本地工具链脚本执行。

这意味着你们现在遇到的几个核心问题，并不只是“skill 写得不够好”，而是**业务决策、协议生命周期、本地执行边界、恢复机制**混在了插件端和后端两边，导致：

- 流程中断后没有真正稳定的 checkpoint/resume
- 冷门硬件没有进入单独 driver-authoring 闭环
- PDF/Arduino 等外部资料只有零散能力，没有形成完整输入路径
- 失败后的诊断信息不够结构化，用户看不到“哪一步出了问题、下一步怎么排”
- 发布到 upypi 根本还没进入当前真实执行链

---

## 2. 仓库结构

项目根目录 `F:\mpy-hardware-extension` 是一个多包仓库，核心目录如下：

```text
F:\mpy-hardware-extension
├─ mpyhw-api/                  FastAPI 后端
├─ mpy-hardware-extension/     VS Code 扩展
├─ contracts/                  共享工具契约
├─ third_party/                MicroPython_Skills 等子模块
├─ docs/                       说明文档
└─ README.md                   根级开发说明
```

其中扩展真实代码在：

```text
F:\mpy-hardware-extension\mpy-hardware-extension
├─ src/
│  ├─ extension/               VS Code host 侧逻辑
│  ├─ core/                    agent loop / tool dispatch / manifest / audit
│  └─ webview/                 WebView UI
├─ python/shim/                Python JSON-RPC 设备与脚本执行层
├─ scripts/                    打包和 smoke 脚本
├─ test/                       node:test 测试
└─ package.json
```

---

## 3. 核心模块

### 3.1 扩展入口和 UI 宿主

- `src/extension/activate.ts`
  - 注册 `mpyhw.panel` WebView 视图。
  - 只做激活和命令注册，本身很薄。

- `src/webview/panel.ts`
  - 这是实际的宿主总装层。
  - 负责：
    - 读取 WebView HTML
    - 解析 API base URL
    - 创建 `DeviceShim`
    - 创建 GitHub auth
    - 创建 `SessionController`
    - 选择运行模式：默认 `createAgentBackedLoop()`，仅 `MPYHW_LOOP=template` 时走旧模板 pipeline
    - 绑定 WebView 和宿主之间的所有消息

结论：真正的插件入口不是 `activate.ts`，而是 `panel.ts`。

### 3.2 会话控制层

- `src/extension/session-controller.ts`

这是插件内的核心状态机，负责：

- 单 session 排他运行
- `AbortController` 取消
- prompt 等待与回填
- trace/session 记录
- 维护 `state`
- 累积 manifest 和已生成文件
- 将 loop event 转发给 WebView

它已经承担了明显的流程控制职责，不是单纯透传层。

### 3.3 真正的执行大脑

- `src/core/agent-backed-loop.ts`
- `src/core/agent-loop.ts`
- `src/core/session-state.ts`
- `src/core/termination.ts`
- `src/core/tool-dispatch.ts`
- `src/core/tool-registry.ts`

当前默认链路不是“插件收协议消息然后无脑执行”，而是：

1. 插件本地创建 session state
2. 插件本地维护 message history
3. 插件本地向后端 `/v1/llm/messages` 发起流式请求
4. 插件本地消费模型返回的 tool use
5. 插件本地决定把工具路由到：
   - `local`
   - `api`
   - `shim`
   - `ui`
6. 插件本地根据 observation 决定 repair/no-progress/termination

这已经是一个**插件内 agent orchestrator**，而不是纯 HostProtocol executor。

### 3.4 本地设备与工具链执行层

- `src/extension/device-shim.ts`
- `src/extension/shim-process.ts`
- `python/shim/serve.py`

这部分是当前实现里最接近“thin plugin 透传层”的一块：

- 通过 JSON-RPC 调 Python 子进程
- Python 再调：
  - `mpremote`
  - `serial`
  - `pypdf`
  - `flake8`
  - `pylint`
  - `pytest`
  - vendored MicroPython_Skills 脚本

当前已支持的 host/shim 工具包括：

- 设备侧
  - `scan_device`
  - `install_package`
  - `write_main_py`
  - `flash_and_run`
  - `read_serial_until`
  - `run_flash_device`

- 工具链脚本侧
  - `run_validate`
  - `run_scaffold`
  - `run_download_drivers`
  - `run_static_check`
  - `run_simulate`
  - `run_triage`
  - `run_hardware_sanity`
  - `run_extract_pdf`
  - `render_wiring`
  - `render_diagram`

### 3.5 本地业务辅助模块

`src/core/` 下还有不少仍在插件端的业务逻辑：

- `manifest-builder.ts`
- `manifest-schema.ts`
- `audit-code.ts`
- `codegen.ts`
- `diagram-derive.ts`
- `wiring-derive.ts`
- `error-classification.ts`
- `skill-catalog.ts`

这说明当前插件仍保留了：

- manifest 结构理解
- code audit 规则
- wiring/diagram 派生
- 错误分类
- phase profile 拉取与使用

与目标的“插件不做嵌入式相关决策”还有明显距离。

---

## 4. 当前真实运行方式

### 4.1 开发运行

根仓库 README 给出的主路径是：

1. 启动本地后端 `mpyhw-api`
2. 在 VS Code 中 F5 启动扩展
3. 扩展默认连接：
   - 本地 `http://127.0.0.1:8787`
   - 或默认托管后端

扩展子包常用命令：

```text
npm test
npm run typecheck
npm run build
npm run package
```

### 4.2 运行时主链路

用户在 WebView 输入需求后，真实链路大致是：

```text
WebView
  -> panel.ts
  -> SessionController.start()
  -> createAgentBackedLoop()
  -> /v1/llm/messages (流式)
  -> 插件本地分发 canonical tools
      -> local
      -> api
      -> shim
      -> ui
  -> event 回流到 SessionController
  -> WebView 更新时间线 / 代码 / manifest / diagram
```

### 4.3 当前 canonical tool 契约

共享契约在：

- `F:\mpy-hardware-extension\contracts\canonical_tools.json`

当前工具是以“本地 agent + 工具调用”设计的，不是你们新方案中的“服务器向插件发 7 类协议消息”。两者有重叠，但不是同一个层次。

当前 canonical tools 更像：

- `query_board_profile`
- `search_packages`
- `get_package_context`
- `propose_manifest`
- `generate_code`
- `audit_code`
- `read_workspace_file`
- `write_project_file`
- `run_extract_pdf`
- `run_flash_device`
- `ask_user`
等

这套契约默认假设：

- 插件内存在 agent loop
- 插件内理解 manifest / phase / codegen / audit
- 工具是直接给 agent 用的，而不是给服务器 PhaseRunner 用的

---

## 5. 与你们目标新架构的差异

你们目标是：

```text
服务器端 LLM 加载完整 SKILL.md 做全部业务决策
插件只负责：
  1. UI
  2. 文件读写
  3. mpremote/设备命令透传
```

而当前实现并不是这样。

### 5.1 当前插件仍在做的“业务决策/流程决策”

当前插件端仍在承担：

- session 生命周期与终止条件
- stall retry / no-progress / repair round 策略
- plan gate / deploy gate / component confirmation gate
- phase profile 获取与使用
- rich manifest 校验门
- 本地 code audit
- 写文件和部署时机控制
- deploy decline 后如何结束会话

这意味着插件并不只是 HostProtocol renderer/executor。

### 5.2 当前后端和插件的协议层也不是目标协议

你们新方案里的协议草案是：

- `approval_request`
- `status_update`
- `file_operation`
- `script_run`
- `device_command`
- `stream`
- `phase_complete`

这是“服务器 -> 插件”的 workflow message protocol。

但当前真实系统里，后端主要还是给插件本地 agent 提供：

- LLM stream
- package / board / phase profile 内容

插件消费的是 tool use，不是你们草案里那套统一 phase workflow envelope。

### 5.3 旧文档已经有漂移

工作区里的旧梳理文档 `plugin-architecture-and-skill-acceptance.md` 提到的是 `protocol-loop.ts` / `protocol-build.ts` 主链路，但当前扩展子包并不存在这一套实现文件，真实默认链路已经是 `agent-backed-loop.ts`。

所以后续讨论必须区分：

- 历史文档中的理想/过渡方案
- 当前仓库真实运行代码

否则会出现“按文档讨论的是 A，实际线上跑的是 B”。

---

## 6. 六个痛点对应到当前实现的真实问题

### 6.1 生成流程经常中断，分析完器件后没反应

当前代码确实对“卡住”做了若干补丁：

- LLM 请求有 `requestTimeoutMs`
- SSE 中断会有限次 retry
- `agent-loop.ts` 有 stall nudge
- `termination.ts` 有 `manifest_unresolved` / `repair_exhausted` / `max_turns`

但这些主要是“避免无限挂死”，不是“真正可恢复的流程设计”。

真实缺口在于：

- 没有统一 `checkpoint` 数据结构
- 没有 phase 级持久化 resume 语义
- `SessionController` 的核心状态只在内存里
- reset 或宿主重启后，不存在标准化“从上次某一步继续”

所以它能做到“失败后尽量停下来”，做不到“失败后稳定从断点继续”。

### 6.2 冷门硬件几乎没法处理

当前系统的主路径仍然强依赖：

- package resolve
- driver context
- curated catalog

一旦进入：

- `package_not_found`
- `driver_context_missing`

当前扩展和 canonical tools 里并没有一条已经打通的：

```text
analyze -> gen-driver -> publish
```

闭环。

虽然 skill 草案在讨论 `gen-driver` / `publish`，但当前真实扩展链路里：

- 没有 `publish` phase 的宿主执行器
- 没有 upypi 打包/发布工具
- 没有 Arduino 转换工具
- 没有“无现成驱动时转入冷门驱动生成”的稳定 phase 流

所以“冷门芯片无法处理”不是单点 bug，而是当前主链路根本没有完整产品闭环。

### 6.3 代码偶尔跑不起来，但不知道哪一步出错

当前已有一些排查能力：

- `audit_code`
- `run_static_check`
- `run_simulate`
- `run_triage`
- `run_hardware_sanity`
- `error-classification.ts`

但问题在于：

- 它们还没有被统一包装成用户可理解的 phase diagnosis 结果
- error structure 不够稳定，不是完整的 workflow error schema
- 缺少“本轮失败发生在哪个 step、依赖哪个 artifact、下一步建议是什么”的统一输出
- 缺少 `partial + checkpoint + suggested_actions` 这种可恢复终态

所以工程师能看代码追出来一些原因，用户不能直接通过产品界面定位问题。

### 6.4 上传 PDF 或 Arduino 参考代码，插件不会利用

当前真实代码里只有：

- `run_extract_pdf`

也就是“本地抽 PDF 文本到 JSON”的底层能力。

目前缺的不是 PDF 解析能力本身，而是完整链路：

- WebView 文件上传输入
- 上传后的 artifact 管理
- PDF/Arduino source 到 phase 输入的统一协议
- 解析结果回灌到 driver-generation / analyze 流程
- Arduino 代码转换工具

换句话说，当前只有“底层一把锤子”，没有“用户真的能把资料送进流程并被利用”的产品路径。

### 6.5 缺少打包发布到 upypi 的收尾步骤

这个问题在当前实现里基本是**未覆盖**：

- canonical tools 中没有 upypi publish 闭环
- extension shim 中没有 publish 能力
- 当前 session phase 默认也没有 publish 终态闭环
- workspace allowlist 虽然允许写项目树，但没有面向 driver package 的 README / LICENSE / package metadata 发布路径

所以这不是“差最后一步”，而是当前真实执行链里还没有这条 phase。

### 6.6 没有中间确认点，出错后只能重来

当前其实已经有 3 类确认点：

- plan confirmation
- deploy confirmation
- component confirmation

但这不是你们要的“phase checkpoint/recovery”。

当前缺的是：

- phase 级 `partial`
- 标准化 checkpoint artifact
- resume token / resume_from
- 幂等执行 key
- 消息相关性字段
- 能力协商
- 统一权限/重试/超时 envelope

所以现在的确认点更像“生成前/烧录前问一下用户”，不是“整个工作流可断点恢复”。

---

## 7. 主要风险

### 7.1 架构风险：插件仍然太重

当前插件仍承载 agent orchestration 和部分业务逻辑，风险是：

- 前后端职责不清
- skill 改动容易牵连插件 loop 行为
- 后端 prompt、tool contract、插件 local logic 三处容易漂移
- 重构到 thin plugin 时迁移成本高

### 7.2 协议风险：现有 canonical tools 与目标 workflow protocol 不是一层东西

现在的契约更偏 agent tool contract，不是 phase workflow protocol。

如果直接在现有扩展上继续叠 UI message protocol，很容易出现双层协议并存：

- 一层是 agent tools
- 一层是 phase messages

不先收敛，后面会越来越乱。

### 7.3 恢复性风险：没有真正持久化 checkpoint

现状最多是：

- 内存中保留 state
- 出错后返回某个 terminal reason

但没有产品级 resume 机制，这直接对应当前用户痛点。

### 7.4 冷门硬件风险：主链路仍以 catalog/driver-context 为中心

这对常见器件有效，但对：

- 无 upypi 驱动
- 只有 PDF
- 只有 Arduino 样例
- 需要 LLM 辅助理解寄存器

的场景，当前闭环明显不完整。

### 7.5 诊断风险：失败结果还不够“面向用户”

已有很多局部检测能力，但没有统一映射成：

- 哪一步失败
- 哪类失败
- 有哪些 artifact 可看
- 下一步怎么恢复

所以调试价值主要还停留在开发者内部。

### 7.6 文档漂移风险：现有说明文档已和真实代码不完全一致

当前工作区已有文档里，至少有一份明显描述的是旧链路或中间方案。继续按漂移文档推进设计，会导致：

- 讨论和实现不对应
- 评审对象不明确
- 插件工程师和 skill 工程师对接失真

### 7.7 宿主阻塞风险：shim 依赖初始化仍有同步阻塞段

`device-shim.ts` 里首次 `ensureVenv()` 仍会调用同步 `spawnSync`：

- 建 venv
- pip install 依赖

这在真实 VS Code extension host 中有卡 UI/卡会话的风险，尤其首次部署或依赖不齐时体验会很差。

---

## 8. 对新架构落地的判断

你们现在提出的方向是对的，而且和当前代码现状相比，必要性很强：

```text
服务器端 LLM + 完整 SKILL.md
  负责所有业务判断和 phase 决策

插件
  只负责 UI / 文件 / 脚本 / 设备能力执行
```

这个方向能直接解决当前最核心的结构问题：

- 把业务决策从插件中剥离
- 让冷门硬件、PDF、发布、恢复这些复杂逻辑都进入服务器端 phase runner
- 插件只实现稳定、可测试、可 mock 的本地能力边界

但从当前代码出发，迁移不是“改几个接口”就行，而是要明确承认：

- 当前 `agent-backed-loop.ts` 这条主链，未来要么被降级为 legacy path，要么被整体替换
- 当前 canonical tool contract 不能直接当作最终 workflow protocol
- 当前 WebView 和 SessionController 需要从“对接本地 agent”改成“对接服务器 workflow message”

---

## 9. 建议的近期落点

基于当前现状，最合理的近期落点不是直接改完整仓库，而是先把“目标协议层”和“当前插件能力层”拆开。

建议顺序：

1. 先把插件能力边界定死
   - UI
   - file operation
   - script run
   - device command
   - stream

2. 先定义 workflow protocol v1
   - `protocol_version`
   - `session_id`
   - `correlation_id`
   - `checkpoint`
   - `timeout`
   - `retry`
   - `permission`
   - `artifacts`
   - `structured errors`

3. 只打通 3 个 phase
   - `analyze`
   - `gen-driver`
   - `publish`

4. 用 mock message 驱动插件 UI，不先接真实后端

5. 等 mock flow 跑通，再把服务器端 PhaseRunner 接上

这也和你们已有的两份分析文档结论一致，但这里补充了一个重要前提：

**必须承认当前真实扩展不是 thin plugin，因此迁移要按“替换主链”来设计，不能假设现在已经只差协议字段。**

---

## 10. 最终判断

如果目标是“梳理当前项目结构、核心模块、运行方式和主要风险”，那么当前最重要的事实是：

- 这个项目已经不是纯原型，而是有真实后端、真实扩展、真实 shim、真实工具契约的混合系统。
- 但它还没有完成你们想要的 workflow protocol 和 thin plugin 收敛。
- 你们列出的六个问题，大部分都不是 isolated bug，而是当前混合架构下的自然结果。

因此，后续最有价值的工作不是继续在现有 agent loop 上打补丁，而是：

- 把插件收敛为稳定执行层
- 把完整 SKILL.md 决策迁到服务器端
- 用 phase/checkpoint/workflow 协议重建 `analyze -> gen-driver -> publish` 主闭环

