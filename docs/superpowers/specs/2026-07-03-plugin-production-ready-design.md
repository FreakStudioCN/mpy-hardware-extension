# 插件生产就绪（Marketplace 上架）设计 — 2026-07-03

## 目标

插件栈（`mpy-hardware-extension` + `mpyhw-api` + 原版 upstream `MicroPython_Skills`）达到 VS Code Marketplace 上架发布就绪。Golden path（一句话 → analyze → select-hw → flash → scaffold → generate → deploy）打通并自证到真板前的最后一步；真板 USB 实测由用户执行（提供一页验收清单）。

两阶段执行：**Phase B（整理）先行，Phase A（上架）在干净地基上进行。**

## 硬约束

1. `third_party/MicroPython_Skills` 是原版 upstream，本项目**不修改**。若发现 skill 文本必须改，单独上报用户走 upstream 流程。
2. 网站两个仓库（新 `blockless-api` / `website-blockless`）完全不碰。新栈 `content/chips/*.json` 仅作只读事实参考。
3. fail-fast 不放松：未提交的"质量门不可用也报 success"diff 不得进 main。
4. v1 假设用户可访问 GitHub/云端（翻墙可用）；API 地址全部走配置（`mpyhw.apiBaseUrl`），为阿里云托管迁移预留。
5. 每步一个 commit；Phase B 完成后过 Codex review 再进 Phase A。

## Phase B — 整理（不改行为）

### B1 工作树清理
- 新分支 `experiment/browser-host-capabilities`：把未提交的 fail-fast 回退 diff（`main.py` CORS 8098 + `routes_llm.py` `_disabled_tool_names`/成功豁免 + 两个未提交测试文件）commit 到该分支封存，commit message 记录封存理由（违反 fail-fast、面向浏览器宿主而非插件、未过 review）。main 恢复干净。
- 盘点其余未提交文件（`.pylintrc`、HANDOFF 文档等），该提交的提交、该归档的归档。
- 验证门：`git status` 干净；backend 测试全绿。

### B2 删死代码
- `agent-backed-loop.ts`（932 行，遗留 27-tool loop）：`DEV_API_BASE_URL` 常量迁至新 `src/core/config.ts`，改 `panel.ts` import，整文件删除，连带仅被它引用的 tool-registry/canonical_tools 部分。
- `src/core/skill-catalog.ts`（调用已删除的 `/v1/phase-profiles`，对 404）：删除。其使用者 `run-live-gen.ts` / `run-golden-path.ts`：先查 package.json scripts 是否仍被引用，无人用则删，有用则改走 V0 协议路径。
- template loop（`pipeline.ts` + `MPYHW_LOOP=template`）：确认除环境开关外无调用后删除，`createLoop` 退化为单路径。
- 验证门：`npm run typecheck` + `npm test` 全绿；esbuild 产物不再包含 agent-backed-loop；`e2e:v0`（shim）通过。

### B3 phase 别名单一事实源
- 以 `contracts/protocol_messages.json` 为唯一来源，TS 侧 `PHASE_ALIASES` 与 Python 侧 `PHASE_BY_SKILL` 各加一个与 contract 逐项比对的一致性测试（不改运行时结构，改动最小）。
- 验证门：任一侧单改一个别名，两个测试均红。

### B4 routes_llm.py 粗粒度拆分（1115 行 → 约 3 个模块）
- 拆出：`billing_breaker.py`（credit 计量 + 熔断）、`prompt_assembly.py`（SLIM_V0_ADAPTER + skill 注入 + phase notes + board/driver grounding）、`sse_translate.py`（DeepSeek SSE → 协议流翻译）。`routes_llm.py` 只留路由与编排。
- 规则：纯搬移，函数体不改；旧模块保留 re-export，外部引用与测试不破。
- 顺手修正：`llm_sessions.py` `DEFAULT_USER_LIMIT=2` 的过期理由（嵌套 codegen 已不存在）→ 重新评估数值并更新注释；`render.yaml` 中"llm_sessions 在进程内"的错误注释改正。
- 验证门：全部 backend 测试**零修改**通过；`git diff` 旧文件仅删除与 re-export。

### B5 webview 最小拆分
- `index.html`（2012 行）拆为 `index.html` + `webview.css` + `webview.js`，逐字节搬移；`panel.ts` 加载逻辑改为拼装/内联三件。不组件化、不改逻辑。
- 验证门：`webview-dom.test.ts` / `webview-panel.test.ts` 全绿；面板视觉无差异（人工开一次）。

### B6 部署解耦
- **第 0 步（先查再动）**：确认线上 `blockless-api.onrender.com` 实际由哪个仓库部署（本仓库 cloud-test skill 指向它，新产品栈也叫 blockless-api）。查清前不做任何改名。
- 查清后：`render.yaml` 服务名 `blockless-api` → `mpyhw-api`（或用户指定名）；CORS 源清单移除与插件无关的新产品域名残留（登录回跳仍需的保留）；同步更新 `.claude/skills/cloud-test`、`publish-extension` 里的后端 URL 引用。
- 确认扩展侧 API 地址全部走 `mpyhw.apiBaseUrl` 设置，无硬编码。
- 仅改仓库文件，**不动线上服务**；线上切换时机由用户决定。

## Phase A — 上架

### A1 锁工具链
- `esptool`、`mpremote`、`pyserial`、`flake8`、`pylint`、`jsonschema`、`pypdf` 全部精确 pin（以当前实测通过版本锁定）；device-shim venv 安装命令带版本。
- 验证门：全新 venv 从零安装 → 16 个质量门对基准项目输出与锁定前一致。

### A2 板子目录扩充（3 → ~12-15 块完整 profile）
- 拟定清单（用户可增删）：ESP32-WROOM DevKitC、ESP32-S2、ESP32-S3（已有）、ESP32-C3（已有）、ESP32-C6、Pico、Pico W（已有）、Pico 2、Pico 2 W + 国内热门 2-3 块（合宙 ESP32-C3 核心板、微雪 Pico 系）。
- Profile 按现有 3 块板的 JSON schema 手写：引脚布局、官方固件 slug、烧录方式（esptool/UF2）、串口芯片提示。新栈 chip-fact 表只读核对引脚。
- 两层语义保持：完整 profile = `builtin_pin_layout`；其余官方板 = `official_firmware_only`，选中时明确告知能力受限。修掉 `_resolve_board` 未命中时静默返回 `{board_id}` stub 的降级（改为显式 `official_firmware_only` 语义或明确报错）。
- 验证门：每块新板过一次 select-hw shim 运行、pin 分配合法；profile 数据过 Codex 审。

### A3 挂账 bug 修复
- generate 收尾 flake 结构性修复：subprocess import 触发 `mpy_imports` / `generate_plan.json` 白名单 / turn-0 空项目幻觉，从 prompt-note 改为 validator 侧防护（白名单放宽到确认安全集合；turn-0 空项目检测拒绝该 turn 并重试）。
- 审批卡灰屏 race：shim 模式写复现脚本（快速连点"修改器件清单"）；复现→修 webview 消息时序；不能复现→消息分发处加状态机守卫 + 遥测日志。
- `terminal=awaiting_user` 语义拆分：真实用户等待 vs 协议 stall 在 UI 分开呈现，stall 显示"构建卡住了 + 重试"。
- 验证门：e2e:v0 连跑 5 次 golden path 无 flake；灰屏复现脚本（若复现）转绿。

### A4 轻量监控计费（明确不追求严密）
- 每用户日 credit 上限（env 可调），超限返回明确错误卡。
- `/v1/admin/usage` 只读端点（复用现有 admin token 模式），按天/用户汇总 tokens 与成本估算；DeepSeek 缓存命中率假设在代码旁注释。
- 不做面板、不做告警。
- 验证门：超限被拒且提示清晰；usage 数字与 llm_turns 记录一致。

### A5 打包与上架材料
- 发布机制已存在（`.claude/skills/publish-extension`：publisher=blockless、Marketplace ID=blockless.mpy-hardware-extension、GitHub Actions v* tag + VSCE_PAT 自动发布）——本项目**验证并复用**该链，不重建；预检（探活/typecheck/test/打包）走该 skill 的 check 模式。
- `prepare-vsce` 链验证：VSIX 仅含 6 个 `-plugin` skill + shared scripts（submodule 守卫测试保持）；干净 VS Code 安装实测激活。
- Marketplace 最小集：README（诚实列出前提：Python 3.10+、串口驱动、支持板清单、需可访问 GitHub 的网络）、icon、categories、CHANGELOG。新手指南两个〔待填〕：网络 → "需要能访问 GitHub 的网络"；反馈渠道 → GitHub Issues。
- 发布动作（publisher token）由用户执行；本项目备齐一切材料。
- 验证门：`vsce package` 无警告；干净 Windows 环境装 VSIX → Doctor 四项体检可跑。

### A6 Golden path 自证
- 本地栈启动与扩展加载复用 `.claude/skills/dev-up`（Postgres + mpyhw-api:8787 + 扩展）；shim 模式端到端：idea → 6 phase 全绿 → 产出项目。
- 代码形状断言脚本（进 repo 成为回归测试）：`firmware/` 树结构、调度器 API 用法（`add_task`，禁 `register`）、import 全在 MicroPython 白名单、16 质量门全过、manifest 与文件一致。
- 覆盖 3 类 idea（传感器/显示/执行器各一）× 连跑 5 次全绿。
- 交付用户一页真板验收清单：板型、命令序列、每步预期现象、失败时需回传的信息。

## 明确不做（本版）

- webview 组件化重写；多 LLM 供应商抽象（DeepSeek 模型名仅收敛为单一常量）；课程内容对齐（上架材料不引用课程）；告警/监控面板；阿里云实际部署（仅保证可配置可迁移）。

## 遗留已知问题（上架时如实带着）

- 审批卡 race 若不能复现，以守卫+日志状态上架。
- 真板端到端由用户完成最后验收；此前所有验证基于 shim + 代码形状断言。
