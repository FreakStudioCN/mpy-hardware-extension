# mpy-hardware-extension

一句话生硬件 · MicroPython 硬件扩展项目工作空间。

通过自然语言生成 MicroPython 硬件代码、对接 uPyPi 包仓库、一键烧录到开发板。

## 快速开始（跑起来当前版本）

当前版本由两部分组成,要一起跑:

- `mpyhw-api/` —— 本地后端服务(FastAPI),提供板子列表、包仓库、LLM agent,监听 `127.0.0.1:8787`
- `mpy-hardware-extension/` —— VS Code 扩展(唯一的用户界面)

**前置**:Python 3.10+、Node.js、VS Code ≥ 1.90。

### 1. 启动后端 API

```sh
cd mpyhw-api
pip install fastapi uvicorn          # 仅有的两个依赖

# 配置密钥:在 mpyhw-api/.env 写入(此文件已被 .gitignore,不会进仓)
#   DEEPSEEK_API_KEY=sk-xxxx
#   MPYHW_LLM_MODEL=deepseek-v4-pro   # 可选,默认 deepseek-v4-pro

pwsh scripts/serve.ps1               # 读取 .env 并启动,监听 127.0.0.1:8787
```

> 没有真实 key 也能跑:设 `MPYHW_LLM_STUB=1` 用桩 LLM。

### 2. 构建并加载扩展

```sh
cd mpy-hardware-extension
npm install
npm run build                        # esbuild 打包到 dist/extension/activate.cjs
```

用 VS Code 打开 `mpy-hardware-extension/` 文件夹,按 `F5` 启动 Extension Development Host(扩展调试窗口)。

### 3. 使用

1. 在活动栏点 **MPY Hardware** 图标打开侧边面板。
2. 确认 API 已在跑——否则设备下拉框显示 “No device — start the API to load boards”,Generate 按钮会一直灰着。
3. 选一块板子(如 ESP32-S3 DevKitC-1),在输入框描述设备要做什么(中英文皆可),点 **Generate**。
4. 在 Activity / Code / Serial / Wiring 四个标签里看生成过程与结果。agent 思考时状态栏会有蓝色转圈动画;出错则变红色静止文字。

**常用环境变量**

| 变量 | 作用 | 默认 |
|------|------|------|
| `MPYHW_API_BASE` | 扩展连接的 API 地址 | `http://127.0.0.1:8787` |
| `MPYHW_LOOP=template` | 用离线确定性流水线代替真实 LLM | 不设=真实 agent |
| `MPYHW_LLM_STUB=1` | 后端用桩 LLM,无需真实 key | 不设=连 DeepSeek |
| `DEEPSEEK_API_KEY` | 后端 DeepSeek 密钥(写在 `.env`) | 必填(stub 模式除外) |

> 注意:`dist/` 不进仓(`src` 为唯一真相),所以克隆后必须先 `npm install && npm run build` 才能跑扩展。

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
