---
name: publish-extension
description: 发布 Blockless VS Code 扩展到 Visual Studio Marketplace（含发布前测试）/ ship the Blockless extension to the VS Code Marketplace. 先跑预检（Render 后端探活 + api-base-url 指向线上 + 子模块完整 + typecheck + npm test + 打包 VSIX），再二选一发布：GitHub Actions 打 v* tag 自动发（仓库 secret VSCE_PAT），或本地 vsce login blockless + npm run publish。publisher=blockless，Marketplace ID=blockless.mpy-hardware-extension。**默认只预检、不发布**；真正发布要用户在本次调用里显式确认。参数 check(默认)/local/tag。
argument-hint: "[check|local|tag]"
---

# publish-extension — 发布到 VS Code Marketplace

把 `mpy-hardware-extension` 打包并发布到 Visual Studio Marketplace。发布走 **PAT**（不是 Azure workload identity——那条试过又弃，完整步骤留在 git 历史 commit `0ed0383`）。两种发布方式：

- **GitHub Actions（推荐）**：推 `v*` tag → [.github/workflows/ci.yml](../../../.github/workflows/ci.yml) 的 `publish-extension` job 跑测试后 `vsce publish -p $VSCE_PAT` 自动发布。
- **本地手动**：`vsce login blockless` + `npm run publish`。

一次性账号/PAT 准备（建 PAT、加 GitHub secret）见 [docs/vscode-extension-publish-flow.md](../../../docs/vscode-extension-publish-flow.md)，本 skill 不重复。

固定事实：publisher=`blockless`、扩展名=`mpy-hardware-extension`、线上后端=`https://blockless-api.onrender.com`。

## 解析参数（默认 `check`）

- `check`（默认）— **只跑预检，绝不发布**。报告结果后停下，让用户决定。
- `local` — 先跑预检，再引导本地 `vsce login` + `npm run publish`（PAT 由用户现场粘贴，**不要让用户把 PAT 贴进聊天**）。
- `tag` — 先跑预检，再走 GitHub Actions：bump version → commit → 打匹配的 `v<version>` tag → push。

> **发布护栏**：不论参数，**先预检**。预检不全绿不发布。`local`/`tag` 真正执行发布动作（push tag / vsce publish）前，必须在本次对话里拿到用户明确"发"的确认——不要因为参数是 `tag` 就默默推 tag。

## Phase 1 — 预检（程序面，全绿才发）

按顺序跑，任何一项红就停下报告。

**① 子模块完整**（打包要从子模块 vendor 工具链）：
```powershell
git submodule status        # 行首是空格=已初始化；是 - 则先 git submodule update --init --recursive
```

**② Render 后端活着 + 指向线上**（有界重试，Render 首调可能热身慢）：
```powershell
$base = "https://blockless-api.onrender.com"
$ok=$false
for($i=0;$i -lt 12;$i++){ try{ if((Invoke-RestMethod "$base/v1/health" -TimeoutSec 10).status -eq 'ok'){$ok=$true;break} }catch{}; Start-Sleep 5 }
if(-not $ok){ "后端 60s 内不健康——别发，先去 Render 看服务"; return }
$r=Invoke-RestMethod "$base/v1/health/ready" -TimeoutSec 10   # 期望 {status:ok, db:ok}
$b=(@((Invoke-RestMethod "$base/v1/boards").builtin)).Count
"health ok; ready=$($r.status)/db=$($r.db); boards=$b"
```
再确认默认后端就是线上（**不能是 127.0.0.1**，否则用户装上连不到后端）：`DEFAULT_API_BASE_URL` 在 [api-base-url.ts](../../../mpy-hardware-extension/src/extension/api-base-url.ts) 应为 `https://blockless-api.onrender.com`。

**③ typecheck + 测试 + 打包**（这三条从仓库根用 `--prefix` 跑，免 cd）：
```powershell
npm --prefix mpy-hardware-extension install
npm --prefix mpy-hardware-extension run typecheck
npm --prefix mpy-hardware-extension test
npm --prefix mpy-hardware-extension run package
```
- `npm test` 预期 **0 fail**；本机会有 **1 个 skip**（跨进程 e2e 烟雾测试需要本地 Postgres+Python，没起就跳过，CI 里才真跑）——这是正常的，不是失败。test 有时会偶发挂 deploy 相关几条（已知 flaky），重跑一次回绿即可。
- `package` 成功的标志是打出 `build/mpy-hardware-extension-<version>.vsix`，日志里能看到 vendor 了一批 `third_party/MicroPython_Skills` 文件 + `dist/extension/activate.cjs`。

## Phase 2 — 人肉内测（首版上公网前强烈建议）

程序绿不等于扩展好用。装刚打的 VSIX 点一遍（这步只能人做）：
```powershell
$v=(Get-Content mpy-hardware-extension/package.json -Raw | ConvertFrom-Json).version
code --install-extension "mpy-hardware-extension/build/mpy-hardware-extension-$v.vsix"
```
检查：Activity Bar 有 Blockless 图标、面板能开、boards 加载、GitHub 登录弹出、登录后 credits 显示、能跑生成、连板子时 shim 不缺文件。

## Phase 3 — 发布（`local` / `tag`，需用户确认）

先看版本号。Marketplace **不允许重复版本**：
```powershell
(Get-Content mpy-hardware-extension/package.json -Raw | ConvertFrom-Json).version
```
- 该版本**没发过**（如首发 0.3.3，publisher 还是空的）→ 可直接发，不用 bump。
- 已发过 → 必须先 bump（patch/minor），见 [docs](../../../docs/vscode-extension-publish-flow.md) 第 3 节。

### 模式 tag（GitHub Actions 自动发）

前提：仓库 secret `VSCE_PAT` 已配（GitHub → Settings → Secrets and variables → Actions）。**没配会发布失败**——配置见 docs 第 1.2/6.1 节。

```powershell
# cwd: mpy-hardware-extension（仅当要 bump 时）
npm version patch --no-git-tag-version   # 首发可跳过这条
# 回仓库根：
git commit -am "release v<version>"
git push
git tag v<version>                        # tag 必须 = package.json 的 version（v0.3.4 ↔ 0.3.4）
git push origin v<version>
```
推 `v*` tag 触发 CI；它 `needs: [extension]`，测试过了才发。去仓库 **Actions** 页看 `publish-extension` job。

### 模式 local（本地手动）

```powershell
# cwd: mpy-hardware-extension
npx vsce login blockless     # 提示时让用户粘贴 PAT（别贴进聊天）
npm run publish              # = vsce publish
```

## Phase 4 — 验证已上架

```text
https://marketplace.visualstudio.com/items?itemName=blockless.mpy-hardware-extension
```
用一个干净 VS Code profile 从 Marketplace 搜索安装，确认不是只在本地 VSIX 下可用。

## 排错速查

| 症状 | 多半原因 | 处理 |
|------|----------|------|
| 后端 60s 不健康 | Render 没 live / 热身 / 网络 | 重跑 Phase 1②；去 Render 看服务；**别发** |
| `npm test` 挂 deploy 几条 | 已知跨模块全局态 flaky | 重跑一次；单跑 `agent-backed-loop.test.ts` 验证 |
| 1 个 test skip | e2e 需本地 Postgres+Python，没起 | 正常，不是失败；CI 里才真跑 |
| package 报缺工具链/schema | 子模块没拉全 | `git submodule update --init --recursive` 再打包 |
| 发布报 publisher 不存在/无权限 | package.json publisher ≠ `blockless`，或 PAT scope/org 不对 | 查 publisher=blockless；PAT scope=Marketplace:Manage、org=all accessible |
| 发布报版本重复 | 该 version 已发过 | bump `package.json` version 再发 |
| tag 推了但 CI 没发 | secret `VSCE_PAT` 没配 / 测试 job 挂了 / tag≠version | 配 secret；看 Actions 里 extension job；tag 名对齐 version |
| PAT 过期 | token 到期 | 重新生成（docs 1.2），更新 `VSCE_PAT` secret 或重新 `vsce login` |
| 想要"云端零 secret" CI | 这是 workload identity 路线 | 不在本 skill；完整步骤在 git 历史 commit `0ed0383` |
