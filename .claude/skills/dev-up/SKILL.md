---
name: dev-up
description: 启动 Blockless 本地开发栈 / bring up the local dev stack. 起 Postgres + mpyhw-api(127.0.0.1:8787)、探活 /v1/health 与 /v1/boards，再按模式加载 VS Code 扩展。参数 f5(默认，Extension Development Host) 或 reinstall(打包 vsix 重装)，可加 stub 用桩 LLM。开始在本仓库干活、或 API/扩展需要重启时用。
argument-hint: "[f5|reinstall] [stub]"
---

# dev-up — 一键起本地开发栈

把 Blockless 本地三件套带起来：**Postgres → mpyhw-api(8787) → VS Code 扩展**。
健康只做**端点探活**（不跑测试套件）。扩展加载分两种模式。

## 解析参数

调用时的参数（默认 `f5`）：

- `f5`（默认）— 走 **F5 Extension Development Host**，日常迭代用，不重装。
- `reinstall` — 走**打包 vsix 重装**：bump version → package → install → 让用户完全重启 VS Code。
- 任意位置可加 `stub` — 后端用桩 LLM（`MPYHW_LLM_STUB=1`），不需要真实 DeepSeek key。

仓库根固定为本工作区根目录。以下路径都相对它。

## Phase 0 — 预检（报一张表，缺什么先补）

并行查这些，缺了就停下告诉用户怎么补：

1. `node --version`、`python --version`、`docker --version`、`code --version` 是否都在 PATH。
2. `mpyhw-api/.env` 是否存在，且含 `DATABASE_URL`（带密码的 postgres URL）；非 stub 模式还需 `DEEPSEEK_API_KEY`。
   - **只检查 key 是否存在，绝不把值打印出来**（.env 已 gitignore，是真实密钥）。
3. `mpy-hardware-extension/node_modules` 是否存在；不存在就 `npm install`（cwd 在 `mpy-hardware-extension`）。

## Phase 1 — 后端（探活优先，必要才起）

**先探活，已在跑就别重起**（`dev-up.ps1` 只检查 Postgres 端口，不检查 8787，重复起 uvicorn 会撞端口）：

```powershell
try { (Invoke-RestMethod http://127.0.0.1:8787/v1/health -TimeoutSec 2).status } catch { "down" }
```

返回 `ok` → 直接跳 Phase 2。否则用 **run_in_background** 起后端（脚本最后是前台 uvicorn，必须后台跑，否则会一直占住）：

```powershell
# 真实 LLM：
& .\mpyhw-api\scripts\dev-up.ps1
# stub 模式（参数带 stub 时）：
$env:MPYHW_LLM_STUB = '1'; & .\mpyhw-api\scripts\dev-up.ps1
```

`dev-up.ps1` 会：确保 Docker Desktop 就绪 → 起/复用容器 `mpyhw-pg`(postgres:16) → 等 PG 端口 → 起 uvicorn。
若 Docker 没装/没起，它会抛错；按提示让用户手动开 Docker Desktop 再重跑本 skill。

## Phase 2 — 健康探活（快）

后台起完后，用一个**有界重试循环**等到健康，再确认板卡能拉到（面板加载就靠 `/v1/boards`）：

```powershell
$ok=$false
for($i=0;$i -lt 30;$i++){ try{ if((Invoke-RestMethod http://127.0.0.1:8787/v1/health -TimeoutSec 2).status -eq 'ok'){$ok=$true;break} }catch{}; Start-Sleep 1 }
if($ok){ $b=Invoke-RestMethod http://127.0.0.1:8787/v1/boards; "health ok; boards=" + (@($b.builtin)+@($b.community)).Count } else { "API 30s 内未健康——抓后台进程输出看 uvicorn/DB 报错" }
```

`health ok` 且 boards 数 > 0 → 后端就绪。否则查后台进程日志（多半是 `.env` 的 `DATABASE_URL` 连不上 PG、或缺 DeepSeek key）。

## Phase 3 — 加载扩展

### 模式 A：f5（默认）

F5 是用户的 GUI 动作，我做不了——但我先把会让 F5 失败的东西排掉，再给精确步骤。

1. 先验证能 build（F5 的 `preLaunchTask: build-extension` 跑的就是这条；先跑一遍能提前暴露缺依赖/TS 错）：
   ```powershell
   npm run build   # cwd: mpy-hardware-extension
   ```
2. build 通过后，把以下步骤**原样交给用户**（这几条正是常见踩坑点）：
   - 用 VS Code 打开**仓库根目录**（不是 `mpy-hardware-extension/` 子文件夹）。F5 配置 `.vscode/launch.json` 在根，打开子文件夹会让 F5 静默没反应——**这是最常见的"dev 模式起不来"原因**。
   - 按 **F5**（或 Run → Start Debugging → "Run Blockless Extension (dev)"）。
   - 会**新开一个标题带 [Extension Development Host] 的窗口**——Blockless 图标在**那个新窗口**的活动栏里，不在原窗口。
   - 前端 `src/webview/index.html` 在此模式**实时读取**：改完前端只需关掉再重开面板，不用重 build。改了扩展 TS（`src/extension/**`、`src/core/**`）要重 build 并重启 dev host（dev host 里按 Ctrl+Shift+F5，或回原窗口重按 F5）。
   - 确认 Phase 2 的 API 在跑，否则面板里板卡/配额/生成都加载不出来。

### 模式 B：reinstall

打包安装到日常 VS Code。**version 不 bump，VS Code 会认为没变、装了也不更新**——所以先 bump：

```powershell
# cwd: mpy-hardware-extension
npm version patch --no-git-tag-version       # 写回 package.json，必须做
npm run package                               # 生成 build/mpy-hardware-extension-<version>.vsix
$v=(Get-Content package.json -Raw | ConvertFrom-Json).version
code --install-extension "build/mpy-hardware-extension-$v.vsix" --force
```

装完**告诉用户：完全退出 VS Code 再重开**（`Reload Window` 不够）。vsix 是打包那一刻的冻结快照——之后再改前端/扩展都得重新 `package` 才会进安装版。

## Phase 4 — 汇报

收尾给一张状态小结：Postgres 起没起、API health 是否 ok、boards 数、用的哪种模式、用户下一步该做什么（F5 模式 → 提示去新窗口找 Blockless；reinstall 模式 → 提示重启 VS Code）。

## 排错速查

| 症状 | 多半原因 | 处理 |
|------|----------|------|
| F5 没反应/没开新窗口 | 打开的是子文件夹，不是仓库根 | 用根目录重开，再 F5 |
| 新窗口里找不到 Blockless | 看错窗口了 | 看标题带 [Extension Development Host] 的那个 |
| 面板板卡/配额加载不出 | API 没起或没健康 | 重跑 Phase 1–2，确认 health=ok |
| 重装后扩展还是旧版 | 没 bump version，或只 Reload 没全退 | bump→package→install→**完全重启** VS Code |
| 前端改了没生效（已装版） | vsix 是冻结快照 | 重新 `npm run package` 再装；或改用 f5 模式实时迭代 |
| API health 30s 不 ok | DATABASE_URL 连不上 PG / 缺 DeepSeek key | 抓后台 uvicorn 输出；或加 stub 参数先桩跑 |
| 改了后端代码不生效 | serve/dev-up 无 --reload | 停掉后台 API 进程，重跑 Phase 1 |

## 停止

停后端：杀掉 Phase 1 的后台进程即可。Postgres 容器 `mpyhw-pg` 会留着（下次 `docker start` 复用），要彻底停用 `docker stop mpyhw-pg`。
