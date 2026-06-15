# Blockless

<a id="en"></a>
**English** · [中文](#zh)

Blockless turns a one-sentence natural-language hardware idea into a MicroPython project. You describe what you want to build, and the AI agent inside the VS Code extension selects components, generates a project manifest, derives the wiring, generates firmware, audits the code, and — after you confirm — deploys it to a connected MicroPython board.

This repo contains both halves of the product:

- `mpyhw-api/`: the FastAPI backend — auth, credits, package/catalog content, skill loading, telemetry, and streaming LLM generation.
- `mpy-hardware-extension/`: the VS Code extension and its webview UI.

## Current status

- The local end-to-end dev workflow is working.
- The backend is deployed on Render (+ hosted Postgres, see `mpyhw-api/DEPLOY.md`); you can also keep running it locally (below).
- The extension is packaged with `@vscode/vsce`.
- Real on-device flashing is still a separate verification track; the current automated tests use a mocked/shimmed device flow.

## Prerequisites

- Python 3.10+
- Node.js 22+
- Docker Desktop
- VS Code 1.90+
- Windows PowerShell

## Get the code and install dependencies

This repo pulls the source of truth for skills and drivers via git submodules (`third_party/MicroPython_Skills`, `third_party/GraftSense-Drivers-MicroPython`) — both backend skill loading and extension packaging depend on them, and things fail outright if they are missing. Always clone with submodules:

```powershell
git clone --recurse-submodules <repo-url>
# Already cloned without submodules?
git submodule update --init --recursive
```

Backend Python dependencies (a venv is recommended):

```powershell
cd mpyhw-api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
```

Extension dependencies:

```powershell
cd mpy-hardware-extension
npm install
cd ..
```

## Run the local stack

Copy the template `mpyhw-api/.env.example` to `mpyhw-api/.env`, then fill in values as needed:

```powershell
Copy-Item mpyhw-api/.env.example mpyhw-api/.env
```

The template ships with working local defaults; you only need to replace `DEEPSEEK_API_KEY` with your own real key (no key? use stub mode below and leave it blank). A typical `.env` looks like:

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mpyhw
MPYHW_JWT_SECRET=dev-local-secret-change-me
MPYHW_ADMIN_TOKEN=dev-admin-token
DEEPSEEK_API_KEY=sk-...
MPYHW_LLM_MODEL=deepseek-chat
```

Start the local backend (real LLM):

```powershell
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/dev-up.ps1
```

With no real LLM key, use stub mode (a stub LLM, no key needed):

```powershell
$env:MPYHW_LLM_STUB = "1"
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/dev-up.ps1
```

`dev-up.ps1` reads `mpyhw-api/.env`, starts or reuses a `postgres:16` Docker container, waits for Postgres to be ready, then brings the API up as a **detached background daemon** (bound to `127.0.0.1:8787`, logs at `mpyhw-api/tmp/api.log`). The daemon is launched via WMI and is not attached to the VS Code process tree, so **fully quitting VS Code will not kill it**; the script returns as soon as it is up and does not hold the terminal.

Afterwards, manage the backend with `api-daemon.ps1` (you must restart after changing backend Python code — uvicorn has no `--reload`):

```powershell
# actions: start | stop | restart | status | logs
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/api-daemon.ps1 restart
```

> The Postgres container `mpyhw-pg` lives independently of the daemon; after a full machine reboot, run `docker start mpyhw-pg` first (or re-run `dev-up.ps1`).

Health checks:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/health
Invoke-RestMethod http://127.0.0.1:8787/v1/health/ready
```

Expected responses:

```json
{"status":"ok"}
{"status":"ok","db":"ok"}
```

## Run the tests

Backend tests need a real Postgres URL. If your local dev server (uvicorn) is connected to the same database, the `TRUNCATE` the tests use to clear tables will deadlock against it — point the tests at a separate database, kept apart from the dev one:

```powershell
docker exec mpyhw-pg createdb -U postgres mpyhw_test   # first time only; ignore the error if it already exists
$env:MPYHW_TEST_DATABASE_URL = "postgresql://postgres:<password from DATABASE_URL>@127.0.0.1:55432/mpyhw_test"
```

Do not inherit a real `DEEPSEEK_API_KEY` into the test process, and do not set `MPYHW_LLM_STUB`: one test specifically verifies that an unconfigured upstream returns 503, and either of those would make it fail.

```powershell
cd mpyhw-api
python -m pytest -q
```

All tests should pass.

Extension tests:

```powershell
cd mpy-hardware-extension
npm test
```

All tests should pass (a few that spawn a Python subprocess are skipped in a restricted sandbox — see below).

Some extension tests start a Python subprocess. If you see `spawn EPERM`, the current sandbox is blocking subprocess launch; re-run in a normal terminal or with approved permissions.

## Run the extension in VS Code (dev mode, recommended)

Day-to-day extension iteration does not need a VSIX every time. The repo root is set up for F5 debugging:

1. First bring up the local backend with `dev-up.ps1` as above.
2. Open the repo **root** in VS Code and press `F5` (the "Run Blockless Extension (dev)" debug config) to launch the Extension Development Host.
3. The webview frontend is read at runtime directly from `mpy-hardware-extension/src/webview/index.html`; edit it and reopen the Host to see changes — no packaging involved.

Only when you need to verify the "installed artifact" or distribute externally do you need the VSIX flow below.

## Test against the cloud backend (no local backend)

When you only want to verify the "local extension × deployed cloud backend" path, you do not need Docker/Postgres/a local backend. The extension's backend address is set by the `mpyhw.apiBaseUrl` setting (then the `MPYHW_API_BASE` env var), and defaults to the hosted address `https://blockless-api.onrender.com`.

With Claude Code, just run `/cloud-test` (defined in `.claude/skills/cloud-test/`):

```text
/cloud-test            # switch to cloud + health check + load the extension (F5, default)
/cloud-test reinstall  # same, but package a VSIX and install it into your everyday VS Code
/cloud-test restore    # switch back to local 127.0.0.1:8787 when you are done
```

Manual equivalent: point the VS Code setting `mpyhw.apiBaseUrl` at the cloud address (`.vscode/settings.json` is gitignored, so editing it is a purely local change that does not enter git), then F5 or reinstall the extension.

`/cloud-test` probes the cloud `/v1/health` before starting a session and diffs the cloud `/v1/tools` against the local `contracts/canonical_tools.json`, heading off two common errors: an unreachable backend ("Cannot reach the auth API") and tool-contract drift ("tool_registry_mismatch").

> The cloud is a real backend: it requires GitHub sign-in, consumes credits, and calls real DeepSeek. To return to local full-stack dev, switch back with `/cloud-test restore` and bring up the local backend with `dev-up.ps1` (or `/dev-up`).

## Build and package the extension

```powershell
cd mpy-hardware-extension
npm install
npm run build
npm run package
```

`npm run package` runs `scripts/prepare-vsce.mjs`, which:

- bundles `src/extension/activate.ts` into `dist/extension/activate.cjs`;
- vendors the subset of the `third_party/MicroPython_Skills` toolchain the VSIX needs at runtime into the extension package;
- writes the VSIX to `mpy-hardware-extension/build/`.

The hosted backend the extension connects to by default is:

```text
https://blockless-api.onrender.com
```

> This hosted backend is live (see `mpyhw-api/DEPLOY.md`); after installing the VSIX it connects there by default, and you can verify "local extension × cloud backend" in one step with `/cloud-test`. To point it at a locally-run backend instead, override the VS Code setting `mpyhw.apiBaseUrl`, or set an env var:

```powershell
$env:MPYHW_API_BASE = "http://127.0.0.1:8787"
```

## Install the local VSIX

```powershell
cd mpy-hardware-extension
code --install-extension build/mpy-hardware-extension-0.3.9.vsix --force
```

> The version number follows `version` in `mpy-hardware-extension/package.json`; the packaged filename changes with it.

After reinstalling a freshly built VSIX, a full quit and restart of VS Code is recommended. A `Reload Window` alone is often not enough to pick up extension-host/module changes.

## Backend deployment

The full deployment doc is in `mpyhw-api/DEPLOY.md`.

Short version:

```sh
git submodule update --init --recursive
# In Render, create a Blueprint from the repo-root render.yaml.
# Fill DEEPSEEK_API_KEY and MPYHW_ADMIN_TOKEN when Render prompts for secrets.
# Render creates blockless-api and blockless-db, then injects DATABASE_URL.
```

On production startup the backend validates the required secrets. If any are missing or still set to dev defaults, the backend fails to start, preventing a misconfigured deploy from going live.

## Directory layout

```text
.
|-- mpyhw-api/                  FastAPI backend
|   |-- app/                    routes, auth, credits, DB, LLM, telemetry
|   |-- content/                boards, packages, driver context catalog
|   |-- scripts/                dev-up, ingestion, catalog tools
|   |-- tests/                  backend pytest tests
|   |-- Dockerfile
|   `-- DEPLOY.md
|-- mpy-hardware-extension/     VS Code extension
|   |-- src/                    extension host, core loop, webview
|   |-- python/shim/            mpremote/serial device helper process
|   |-- scripts/                build and VSIX preparation scripts
|   |-- test/                   node:test tests
|   `-- package.json
|-- third_party/
|   |-- MicroPython_Skills/     served skills and packaging-time toolchain scripts
|   `-- GraftSense-Drivers-MicroPython/
|-- content/                    package catalog mirror (generated; a fresh checkout may not have it)
|-- docs/                       product, research, pitch, legal docs
|-- contracts/                  shared tool contract
`-- dev/                        raw research material and extracted reference docs
```

## Contributing notes

- Keep changes surgical; this repo often has a large dirty worktree during active development.
- Do not commit the secrets in `mpyhw-api/.env`.
- `dist/` is a build artifact; the source of truth lives in `mpy-hardware-extension/src/`.
- The list of skills the backend actually serves is controlled by `mpyhw-api/app/skill_catalog.py`.
- If a served skill references a host-side script, make sure that script is either exposed through a canonical tool or bundled into the VSIX by `prepare-vsce.mjs`.

---

<a id="zh"></a>
# Blockless · 中文

[English](#en) · **中文**

Blockless 可以把一句自然语言硬件想法变成一个 MicroPython 项目。你描述想做什么，VS Code 扩展里的 AI agent 会选择器件、生成项目 manifest、推导接线、生成固件、审计代码，并在你确认后部署到连接的 MicroPython 开发板。

本仓库包含产品的两部分：

- `mpyhw-api/`：FastAPI 后端，负责认证、积分、包/目录内容、skill 加载、遥测和 LLM 流式生成。
- `mpy-hardware-extension/`：VS Code 扩展和 webview 用户界面。

## 当前状态

- 本地端到端开发流程已可用。
- 后端已部署在 Render（+ 托管 Postgres，见 `mpyhw-api/DEPLOY.md`）；也可继续本地自起后端（见下文）。
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

## 连云端后端测试（不起本地后端）

只想验证「本地扩展 × 已部署的云端后端」这条线时，不必起 Docker/Postgres/本地后端。扩展的后端地址由 `mpyhw.apiBaseUrl` 设置（其次是 `MPYHW_API_BASE` 环境变量）决定，默认就是托管地址 `https://blockless-api.onrender.com`。

用 Claude Code 时直接调 `/cloud-test`（定义在 `.claude/skills/cloud-test/`）：

```text
/cloud-test            # 切到云端 + 探活 + 加载扩展（F5，默认）
/cloud-test reinstall  # 同上，但打 VSIX 装到日常 VS Code
/cloud-test restore    # 测完一键切回本地 127.0.0.1:8787
```

手动等价操作：把 VS Code 设置 `mpyhw.apiBaseUrl` 指向云端地址即可（`.vscode/settings.json` 已 gitignore，改它是纯本地操作，不进 git），然后 F5 或重装扩展。

`/cloud-test` 会在开会话前先探活云端 `/v1/health`、并比对云端 `/v1/tools` 与本地 `contracts/canonical_tools.json`，提前挡掉两个常见错误：后端不可达（“Cannot reach the auth API”）和工具契约漂移（“tool_registry_mismatch”）。

> 云端是真后端：需要 GitHub 登录、消耗 credits、走真实 DeepSeek。要回到本地全栈开发，用 `/cloud-test restore` 切回，再配合 `dev-up.ps1`（或 `/dev-up`）起本地后端。

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

> 该托管后端已部署上线（见 `mpyhw-api/DEPLOY.md`）；安装 VSIX 后默认即连它，也可用 `/cloud-test` 一键验证「本地扩展 × 云端后端」。如果想改连本地自起的后端，用 VS Code 设置 `mpyhw.apiBaseUrl` 覆盖，或设置环境变量：

```powershell
$env:MPYHW_API_BASE = "http://127.0.0.1:8787"
```

## 安装本地 VSIX

```powershell
cd mpy-hardware-extension
code --install-extension build/mpy-hardware-extension-0.3.9.vsix --force
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
