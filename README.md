# mpy-hardware-extension

一句话生硬件 · MicroPython 硬件扩展项目工作空间。

通过自然语言生成 MicroPython 硬件代码、对接 uPyPi 包仓库、一键烧录到开发板。

## 快速开始（从零跑起来当前版本）

当前版本由两部分组成，要一起跑：

- `mpyhw-api/` —— 本地后端服务（FastAPI），提供板子列表、包仓库、LLM agent，监听 `127.0.0.1:8787`；数据落在本地 Postgres
- `mpy-hardware-extension/` —— VS Code 扩展（唯一的用户界面）

**前置**：Python 3.10+、Node.js、VS Code ≥ 1.90、**Docker Desktop**（后端用容器跑 Postgres）。

### 1. 启动后端 API（含 Postgres）

```sh
cd mpyhw-api
pip install -r requirements.txt        # fastapi / uvicorn / psycopg / pydantic …

# 配置 mpyhw-api/.env（此文件已被 .gitignore，不会进仓）：
#   DATABASE_URL=postgresql://USER:PASS@127.0.0.1:55432/mpyhw   # 必填，必须是 postgres:// 或 postgresql://
#   DEEPSEEK_API_KEY=sk-xxxx                                    # 真实 LLM 必填（stub 模式除外）
#   MPYHW_JWT_SECRET=...                                        # 会话/计量 token 签名密钥
#   MPYHW_LLM_MODEL=deepseek-v4-pro                             # 可选，默认 deepseek-v4-pro

pwsh scripts/dev-up.ps1                 # 确保 Docker 就绪 → 起/复用容器 mpyhw-pg(postgres:16) → 起 uvicorn
```

> `dev-up.ps1` 读取 `.env`，把 `DATABASE_URL` 指向的 Postgres 带起来再启动 API。
> 没有真实 LLM key 也能跑：`$env:MPYHW_LLM_STUB=1; pwsh scripts/dev-up.ps1` 用桩 LLM。
> 注意：后端**强制 Postgres**——`DATABASE_URL` 缺失或是 SQLite 会直接拒绝启动（不再有 SQLite 回退）。

探活（返回 `ok` 即就绪）：

```powershell
(Invoke-RestMethod http://127.0.0.1:8787/v1/health).status
```

### 2. 构建并加载扩展

```sh
cd mpy-hardware-extension
npm install
npm run build                        # esbuild 打包到 dist/extension/activate.cjs
```

两种加载方式，任选其一：

**方式 A — F5 调试（开发迭代用）**：用 VS Code 打开**仓库根目录**（不是 `mpy-hardware-extension/` 子文件夹，否则 `.vscode/launch.json` 的 F5 配置不生效），按 `F5` 启动 Extension Development Host。会新开一个标题带 `[Extension Development Host]` 的窗口，Blockless 图标在那个新窗口里。前端 `src/webview/index.html` 在此模式下实时读取，改完直接重开面板即可。

**方式 B — 打包安装到你日常的 VS Code（自测用）**：

```sh
npm run package                      # 生成 build/mpy-hardware-extension-<version>.vsix
code --install-extension build/mpy-hardware-extension-<version>.vsix --force
```

> 重装注意：每次重新打包前先 bump `package.json` 的 `version`，否则 VS Code 认为版本未变、不会真正更新；安装后要**完全退出并重启 VS Code**（`Reload Window` 不够）。vsix 是打包那一刻的冻结快照——前端改动必须重新 `package` 才会进安装版。

### 3. 使用

1. 在活动栏点 **Blockless** 图标打开侧边面板。
2. 确认 API 已在跑；否则板卡列表、配额和生成流程无法加载。
3. 在输入框描述设备要做什么（中英文皆可），点 **Generate**。如果需求或板卡选择不明确，agent 会在 Activity 里用可回答的问题让你确认。
4. 在 Activity / Code / Serial / Wiring 四个标签里看生成过程与结果。Activity 默认只展示用户可理解的阶段、问题和确认项；`generate_code` / `ask_user` 这类内部 tool 名称只进入日志和开发者 trace，不直接展示给普通用户。

> 生成产物（`firmware/`、`project-manifest.json` 等）会写进你**当前打开的工作区文件夹**。开发本仓库时，建议另开一个空文件夹做生成测试，别在本仓库根目录直接跑生成。

**常用环境变量**

| 变量 | 作用 | 默认 |
|------|------|------|
| `DATABASE_URL` | 后端 Postgres 连接串（写在 `.env`），必须是 `postgres://`/`postgresql://` | 必填 |
| `DEEPSEEK_API_KEY` | 后端 DeepSeek 密钥（写在 `.env`） | 必填（stub 模式除外） |
| `MPYHW_JWT_SECRET` | 会话/计量 token 的签名密钥（写在 `.env`） | 必填 |
| `MPYHW_LLM_STUB=1` | 后端用桩 LLM，无需真实 key | 不设=连 DeepSeek |
| `MPYHW_API_BASE` | 扩展连接的 API 地址 | `http://127.0.0.1:8787` |
| `MPYHW_LOOP=template` | 用离线确定性流水线代替真实 LLM | 不设=真实 agent |
| `MPYHW_ADMIN_TOKEN` | 运维指标接口 `/v1/admin/metrics` 的访问密钥，请求带 `X-Admin-Token` 头 | 不设=该接口对外关闭 |

> 注意：`dist/` 不进仓（`src` 为唯一真相），所以克隆后必须先 `npm install && npm run build` 才能跑扩展。

## 目录结构

```
.
├── mpyhw-api/                    本地后端服务（FastAPI）：板子/包仓库/LLM agent
├── mpy-hardware-extension/       VS Code 扩展（用户界面，src 为唯一真相）
│
├── dev/                          MicroPython 硬件扩展核心技术资料
│   ├── prd.md                    一句话生硬件 完整 PRD
│   ├── *.pdf                     5 份原始资料（Thonny 插件、uPyPi、应用商城、SOP …）
│   └── extracted/                PDF 转 Markdown 后的可检索版本
│       ├── INDEX.md              索引 + 13 个 GitHub 仓库 + 27 个外链汇总
│       ├── thonny-upypi-需求规格.md
│       ├── thonny-mpy-安装使用.md
│       ├── upystore-应用商城.md
│       ├── 一句话生硬件-资料汇总.md
│       ├── 开发生产宣传SOP.md
│       └── *_images/             每篇配套的图片 + OCR 文本
│
├── docs/
│   ├── product/                  产品文档：core / idea / prd / appstore（中英）
│   ├── research/                 调研与设计笔记
│   │   ├── project_*.md          各子主题分析（商业模式、定位、护城河 …）
│   │   ├── feedback_*.md         用户/市场反馈笔记
│   │   ├── phase2/               二阶段调研材料
│   │   └── pitch-archive/        早期 pitch 调研归档
│   ├── pitch/                    对外材料
│   │   ├── NVSC Coaching Presentation.md
│   │   └── deck/                 中英文 pitch deck
│   └── legal/                    法务（联合创始人协议等）
│
└── assets/                       图片等静态资源
```

## 快速入口

- 想了解项目背景与目标 → `docs/product/core.md`、`dev/prd.md`
- 想了解 Thonny + uPyPi 插件方案 → `dev/extracted/INDEX.md`
- 想了解商业/融资视角 → `docs/research/research-INDEX.md`

## 相关上游仓库

- https://github.com/FreakStudioCN/upypi —— uPyPi 包仓库后端
- https://github.com/FreakStudioCN/thonny-upypi-manager —— Thonny 包管理插件
- https://github.com/FreakStudioCN/MicroPython_Skills —— MicroPython 技能库
- https://github.com/MicroPythonOS/MicroPythonOS
- https://github.com/thonny/thonny

完整链接见 `dev/extracted/INDEX.md`。
