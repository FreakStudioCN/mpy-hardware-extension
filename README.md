# Blockless

Blockless 可以把一句自然语言硬件想法变成一个 MicroPython 项目。你描述想做什么，VS Code 扩展里的 AI agent 会选择器件、生成项目 manifest、推导接线、生成固件、审计代码，并在你确认后部署到连接的 MicroPython 开发板。

本仓库包含产品的两部分：

- `mpyhw-api/`：FastAPI 后端，负责认证、积分、包/目录内容、skill 加载、遥测和 LLM 流式生成。
- `mpy-hardware-extension/`：VS Code 扩展和 webview 用户界面。

## 当前状态

- 本地端到端开发流程已可用。
- 后端已准备 Fly.io + 托管 Postgres 部署配置。
- 扩展使用 `@vscode/vsce` 打包。
- 真板烧录验证仍是独立验证线；当前自动化测试使用 mock/shim 的设备流程。

## 前置要求

- Python 3.10+
- Node.js 22+
- Docker Desktop
- VS Code 1.90+
- Windows PowerShell

## 启动本地服务

创建 `mpyhw-api/.env`：

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mpyhw
MPYHW_JWT_SECRET=dev-local-secret-change-me
MPYHW_ADMIN_TOKEN=dev-admin-token
DEEPSEEK_API_KEY=sk-...
MPYHW_LLM_MODEL=deepseek-chat
```

如果本地开发时没有真实 LLM key，可以用 stub 模式启动：

```powershell
$env:MPYHW_LLM_STUB = "1"
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/dev-up.ps1
```

`dev-up.ps1` 会读取 `mpyhw-api/.env`，启动或复用 Docker 里的 `postgres:16` 容器，等待 Postgres 就绪，然后运行：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

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

后端测试需要真实 Postgres URL。不要把真实 `DEEPSEEK_API_KEY` 继承进后端测试进程，除非你明确要测真实上游调用；测试里有一个用例专门验证“未配置上游时返回错误”的路径。

```powershell
cd mpyhw-api
python -m pytest -q
```

最近一次全量结果：

```text
145 passed
```

扩展测试：

```powershell
cd mpy-hardware-extension
npm test
```

最近一次全量结果：

```text
254 passed, 0 failed, 0 skipped
```

部分扩展测试会启动 Python 子进程。如果看到 `spawn EPERM`，说明当前沙箱阻止了子进程启动，请在普通终端或批准权限下重跑。

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

扩展默认连接托管后端：

```text
https://blockless-api.fly.dev
```

本地开发时可以用 VS Code 设置 `mpyhw.apiBaseUrl` 覆盖，或设置环境变量：

```powershell
$env:MPYHW_API_BASE = "http://127.0.0.1:8787"
```

## 安装本地 VSIX

```powershell
cd mpy-hardware-extension
code --install-extension build/mpy-hardware-extension-0.3.0.vsix --force
```

重新安装构建后的 VSIX 后，建议完全退出并重启 VS Code。仅 `Reload Window` 往往不足以刷新 extension host/module 变更。

## 后端部署

完整部署文档在 `mpyhw-api/DEPLOY.md`。

简版流程：

```sh
git submodule update --init --recursive
fly launch --no-deploy --config mpyhw-api/fly.toml --name blockless-api
fly postgres create --name blockless-db --region iad
fly postgres attach blockless-db --app blockless-api
fly secrets set --app blockless-api \
  MPYHW_JWT_SECRET="$(openssl rand -hex 32)" \
  DEEPSEEK_API_KEY="sk-..." \
  MPYHW_ADMIN_TOKEN="$(openssl rand -hex 24)"
fly deploy --config mpyhw-api/fly.toml --dockerfile mpyhw-api/Dockerfile
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
|-- content/                    根目录生成的 package catalog mirror
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
