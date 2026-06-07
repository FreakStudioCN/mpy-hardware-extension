# Blockless

Blockless 可以把一句自然语言硬件想法变成一个 MicroPython 项目。你描述想做什么，VS Code 扩展里的 AI agent 会选择器件、生成项目 manifest、推导接线、生成固件、审计代码，并在你确认后部署到连接的 MicroPython 开发板。

本仓库包含产品的两部分：

- `mpyhw-api/`：FastAPI 后端，负责认证、积分、包/目录内容、skill 加载、遥测和 LLM 流式生成。
- `mpy-hardware-extension/`：VS Code 扩展和 webview 用户界面。

## 当前状态

- 本地端到端开发流程已可用。
- 后端已准备 Render + 托管 Postgres 的部署配置；正式上线前可继续本地自起后端（见下文）。
- 扩展使用 `@vscode/vsce` 打包。
- 真板烧录验证仍是独立验证线；当前自动化测试使用 mock/shim 的设备流程。

## 前置要求

- Python 3.10+
- Node.js 22+
- Docker Desktop
- VS Code 1.90+
- Windows PowerShell

## 获取代码与安装依赖

本仓库通过 git submodule 引入 skill 与驱动的真相源（`third_party/MicroPython_Skills`、`third_party/GraftSense-Drivers-MicroPython`）——后端的 skill 加载和扩展打包都依赖它们，缺了会直接失败。克隆时务必带上 submodule：

```powershell
git clone --recurse-submodules <repo-url>
# 已经克隆过、忘了带 submodule：
git submodule update --init --recursive
```

后端 Python 依赖（建议放在 venv 里）：

```powershell
cd mpyhw-api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
```

扩展依赖：

```powershell
cd mpy-hardware-extension
npm install
cd ..
```

## 启动本地服务

复制模板 `mpyhw-api/.env.example` 为 `mpyhw-api/.env`，再按需填值：

```powershell
Copy-Item mpyhw-api/.env.example mpyhw-api/.env
```

模板已带可用的本地默认值，只需把 `DEEPSEEK_API_KEY` 换成你自己的真实 key（没有 key 就用下面的 stub 模式，可不填）。`.env` 大致长这样：

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mpyhw
MPYHW_JWT_SECRET=dev-local-secret-change-me
MPYHW_ADMIN_TOKEN=dev-admin-token
DEEPSEEK_API_KEY=sk-...
MPYHW_LLM_MODEL=deepseek-chat
```

起本地后端（真实 LLM）：

```powershell
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/dev-up.ps1
```

没有真实 LLM key 时用 stub 模式（桩 LLM，不需要 key）：

```powershell
$env:MPYHW_LLM_STUB = "1"
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/dev-up.ps1
```

`dev-up.ps1` 会读取 `mpyhw-api/.env`，启动或复用 Docker 里的 `postgres:16` 容器，等待 Postgres 就绪，然后把 API 作为**脱离进程的后台守护**起起来（绑定 `127.0.0.1:8787`，日志写 `mpyhw-api/tmp/api.log`）。守护通过 WMI 启动、不挂在 VS Code 进程树下，**完全退出 VS Code 也不会被杀**；脚本起完即返回，不占终端。

之后用 `api-daemon.ps1` 管理后端（改了后端 Python 代码后必须重启——uvicorn 没有 `--reload`）：

```powershell
# 动作：start | stop | restart | status | logs
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/api-daemon.ps1 restart
```

> Postgres 容器 `mpyhw-pg` 独立于守护存活；整机重启后先 `docker start mpyhw-pg`（或重跑 `dev-up.ps1`）。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/health
Invoke-RestMethod http://127.0.0.1:8787/v1/health/ready
```

预期返回：

```json
{"status":"ok"}
{"status":"ok","db":"ok"}
```

## 运行测试

后端测试需要真实 Postgres URL。如果本地 dev 服务（uvicorn）正连着同一个库，测试清表用的 `TRUNCATE` 会和它死锁——给测试单独指一个库，和 dev 库分开：

```powershell
docker exec mpyhw-pg createdb -U postgres mpyhw_test   # 仅首次；如果已存在可忽略报错
$env:MPYHW_TEST_DATABASE_URL = "postgresql://postgres:<DATABASE_URL 里的密码>@127.0.0.1:55432/mpyhw_test"
```

不要把真实 `DEEPSEEK_API_KEY` 继承进测试进程，也不要设 `MPYHW_LLM_STUB`：测试里有一个用例专门验证“未配置上游时返回 503”，这两者都会让它失败。

```powershell
cd mpyhw-api
python -m pytest -q
```

全部用例应通过。

扩展测试：

```powershell
cd mpy-hardware-extension
npm test
```

全部用例应通过（个别需要启动 Python 子进程的用例，在受限沙箱里会被跳过——见下）。

部分扩展测试会启动 Python 子进程。如果看到 `spawn EPERM`，说明当前沙箱阻止了子进程启动，请在普通终端或批准权限下重跑。

## 在 VS Code 里运行扩展（开发模式，推荐）

日常迭代扩展不必每次打 VSIX。仓库根目录已配好 F5 调试：

1. 先按上文用 `dev-up.ps1` 起好本地后端。
2. 在仓库**根目录**用 VS Code 打开，按 `F5`（调试配置 “Run Blockless Extension (dev)”）启动 Extension Development Host。
3. webview 前端在运行时直接读 `mpy-hardware-extension/src/webview/index.html`，改完重开 Host 即可看到，不经过打包。

只有要验证“安装后的产物”或对外分发时，才需要下面的打 VSIX 流程。

## 构建和打包扩展

```powershell
cd mpy-hardware-extension
npm install
npm run build
npm run package
```

`npm run package` 会运行 `scripts/prepare-vsce.mjs`，它会：

- 将 `src/extension/activate.ts` 打包为 `dist/extension/activate.cjs`；
- 将 VSIX 运行时需要的 `third_party/MicroPython_Skills` toolchain 子集 vendoring 进扩展包；
- 将 VSIX 写入 `mpy-hardware-extension/build/`。

扩展代码里默认连接的托管后端地址是：

```text
https://blockless-api.onrender.com
```

> **注意：该托管后端目前尚未部署上线。** 在它上线前，仅安装 VSIX 无法连到可用后端——必须按上文「启动本地服务」自起后端，再把扩展指向它：用 VS Code 设置 `mpyhw.apiBaseUrl` 覆盖，或设置环境变量：

```powershell
$env:MPYHW_API_BASE = "http://127.0.0.1:8787"
```

## 安装本地 VSIX

```powershell
cd mpy-hardware-extension
code --install-extension build/mpy-hardware-extension-0.3.2.vsix --force
```

> 版本号以 `mpy-hardware-extension/package.json` 的 `version` 为准；打包产物文件名会随之变化。

重新安装构建后的 VSIX 后，建议完全退出并重启 VS Code。仅 `Reload Window` 往往不足以刷新 extension host/module 变更。

## 后端部署

完整部署文档在 `mpyhw-api/DEPLOY.md`。

简版流程：

```sh
git submodule update --init --recursive
# In Render, create a Blueprint from the repo-root render.yaml.
# Fill DEEPSEEK_API_KEY and MPYHW_ADMIN_TOKEN when Render prompts for secrets.
# Render creates blockless-api and blockless-db, then injects DATABASE_URL.
```

生产环境启动时会校验必需 secret。如果缺失或仍使用 dev 默认值，后端会直接启动失败，避免错误配置上线。

## 目录结构

```text
.
|-- mpyhw-api/                  FastAPI 后端
|   |-- app/                    routes、auth、credits、DB、LLM、telemetry
|   |-- content/                boards、packages、driver context catalog
|   |-- scripts/                dev-up、ingestion、catalog 工具
|   |-- tests/                  后端 pytest 测试
|   |-- Dockerfile
|   |-- fly.toml
|   `-- DEPLOY.md
|-- mpy-hardware-extension/     VS Code 扩展
|   |-- src/                    extension host、core loop、webview
|   |-- python/shim/            mpremote/serial 设备辅助进程
|   |-- scripts/                构建和 VSIX 准备脚本
|   |-- test/                   node:test 测试
|   `-- package.json
|-- third_party/
|   |-- MicroPython_Skills/     已服务的 skills 和打包用 toolchain 脚本
|   `-- GraftSense-Drivers-MicroPython/
|-- content/                    package catalog mirror（生成产物，全新检出可能没有）
|-- docs/                       产品、调研、pitch、法务文档
|-- contracts/                  共享 tool contract
`-- dev/                        原始调研资料和提取后的参考文档
```

## 贡献注意事项

- 保持改动外科手术式；这个仓库在活跃开发时经常有较大的 dirty worktree。
- 不要提交 `mpyhw-api/.env` 里的 secret。
- `dist/` 是生成产物；源码真相在 `mpy-hardware-extension/src/`。
- 后端实际服务的 skill 列表由 `mpyhw-api/app/skill_catalog.py` 控制。
- 如果某个 served skill 引用了 host-side 脚本，必须确认该脚本要么通过 canonical tool 暴露，要么由 `prepare-vsce.mjs` 打包进 VSIX。
