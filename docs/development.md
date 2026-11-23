# Local development

[English README](../README.md) | [中文 README](../README.zh-CN.md)

## Source layout and dependencies

The repository root is a monorepo. The VS Code package is in `mpy-hardware-extension/`; the backend is in `mpyhw-api/`. Clone with submodules or initialize them before packaging:

```sh
git submodule update --init --recursive
```

Use Python 3.10+, Node.js 22+, and VS Code 1.90+. The Windows backend convenience launcher also uses Docker Desktop, PostgreSQL 16, and PowerShell. Install backend dependencies in a virtual environment and extension dependencies with `npm ci` from the extension directory.

## Backend configuration

Copy `mpyhw-api/.env.example` to ignored `mpyhw-api/.env`. Configure local database/authentication values and an appropriate model provider key. Do not copy real secrets into documentation or commits.

The Windows launcher is `mpyhw-api/scripts/dev-up.ps1`. It starts/reuses the local PostgreSQL container and launches the API daemon on `127.0.0.1:8787`. Set `MPYHW_LLM_STUB=1` for deterministic stub responses; this mode cannot demonstrate real model generation.

Health endpoints:

- `http://127.0.0.1:8787/v1/health`
- `http://127.0.0.1:8787/v1/health/ready`

The daemon does not automatically reload backend source changes. Use the maintained helper to inspect/restart it:

```powershell
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/api-daemon.ps1 status
powershell -ExecutionPolicy Bypass -File mpyhw-api/scripts/api-daemon.ps1 restart
```

See [backend operations](../mpyhw-api/deploy/README.md) for the deployment-specific workflow. Point VS Code **User/Remote** `mpyhw.apiBaseUrl` to your local API; this setting is intentionally not workspace-controlled.

## Focused validation

For extension code, from `mpy-hardware-extension/`:

```sh
npm test
npm run typecheck
npm run package
```

The package output is `build/mpy-hardware-extension.vsix`. Distribution instructions are in [the packaging guide](vscode-extension-publish-flow.md).

Backend tests must use a separate PostgreSQL test database through `MPYHW_TEST_DATABASE_URL`. Do not point tests at a developer or production database: tests clear their tables. Do not inherit a real provider key or `MPYHW_LLM_STUB` into a test suite that checks unconfigured-provider behavior.

From `mpyhw-api/`, with the isolated database and test environment configured:

```sh
python -m pytest -q
```

Documentation/license-only changes need path checks, valid metadata, license consistency, and `git diff --check`; they do not require launching the stack or operating devices.

## Real-board evidence

Use [the acceptance checklist](real-board-acceptance.md). Record board identity, firmware, actual connections, expected behavior, serial output, and physical observations. Mark mocked/shimmed tests as such. Remove credentials and personal paths from shared logs.

## 中文说明

仓库根目录同时包含扩展和后端，命令应在对应目录执行；两个子模块都不能省略。环境和密钥使用被忽略的 `.env`，VS Code 后端地址在用户/远程设置中配置。后端修改后需要重启守护进程。

测试数据库必须与日常开发和生产数据库分离。文档/许可证修改只做路径、元数据、许可证一致性和差异检查；设备部署结果按实机验收清单独立记录，不能用模拟测试替代真实观察。
