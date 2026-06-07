---
name: cloud-test
description: 用本地前端插件连云端后端做端到端测试 / test the local VS Code extension against the deployed Render backend. 把扩展的 mpyhw.apiBaseUrl 指到 https://blockless-api.onrender.com（而不是本地 127.0.0.1:8787），探活云端 /v1/health 与 /v1/tools（顺带挡掉本会话踩过的 "Cannot reach the auth API" 与 "tool_registry_mismatch" 两个坑），再按模式加载扩展。参数 f5(默认) 或 reinstall；restore 一键切回本地。不需要 Docker/Postgres/本地 DeepSeek key。
argument-hint: "[f5|reinstall|restore]"
---

# cloud-test — 本地前端 × 云端后端

跟 [dev-up](../dev-up/SKILL.md) 相反：**不起任何本地后端**（不碰 Docker / Postgres / uvicorn / 本地 DeepSeek key），只把**本地的 VS Code 扩展**指到已经部署在 Render 上的后端 `https://blockless-api.onrender.com`，然后真用 UI 跑一遍，验证云端这条线端到端通。

为什么单独做这个：扩展的后端地址由 `resolveApiBaseUrl` 决定，优先级是 **setting > env > 默认**，而[默认值本身就是云端](../../../mpy-hardware-extension/src/extension/api-base-url.ts) (`DEFAULT_API_BASE_URL = https://blockless-api.onrender.com`)。本地 `.vscode/settings.json` 里把 `mpyhw.apiBaseUrl` 钉死成了 `http://127.0.0.1:8787`，它会赢过默认。所以"测云端"=临时把这一个设置切到云端、测完切回来。`.vscode/` 已 gitignore，**改它是纯本地操作，不进 git、不会留 diff**。

## 解析参数（默认 `f5`）

- `f5`（默认）— 走 F5 Extension Development Host，前端实时迭代。
- `reinstall` — 打包 vsix 重装到日常 VS Code。
- `restore` — **不加载扩展**，只把 `mpyhw.apiBaseUrl` 切回本地 `http://127.0.0.1:8787`（测完云端回到本地开发用）。

云端地址固定 `https://blockless-api.onrender.com`；要测别的环境，把下文出现的 URL 整体替换。

---

## Phase 0 — 预检（很轻，没有 Docker/Python）

并行查，缺了再补：

1. `node --version`、`code --version` 在 PATH。**不需要** docker / python。
2. `mpy-hardware-extension/node_modules` 在不在；不在就 `npm install`（cwd 在 `mpy-hardware-extension`）。

> 若参数是 `restore`：跳过 Phase 0/2/3/4，直接做 Phase 1 的"切回本地"那半边，然后收尾。

## Phase 1 — 把前端指向云端

1. 读 `.vscode/settings.json` 里现在的 `mpyhw.apiBaseUrl`（通常是 `http://127.0.0.1:8787`）。
2. **先备份**：把旧值写到 sidecar `.vscode/apibase.bak`（同样 gitignore，方便精确还原）。若文件已存在就别覆盖（避免把上次的云端值当成"本地原值"）。
3. 把 `mpyhw.apiBaseUrl` 改成 `https://blockless-api.onrender.com`。
4. 告诉用户：这是本地改动、不进 git；测完用 `cloud-test restore` 切回。

`restore` 分支：读 `.vscode/apibase.bak`，有就还原成里面的值并删掉 sidecar；没有就直接设回 `http://127.0.0.1:8787`。然后结束（提示用户去新窗口里关掉再打开面板让设置生效）。

## Phase 2 — 探活云端后端（关键，挡掉本会话两个坑）

这一步专门预防本会话真实踩过的两类错误。用**有界重试**（Render starter 付费实例不睡，但部署刚完/久未访问首个请求可能慢几秒）：

```powershell
$base = "https://blockless-api.onrender.com"
$ok=$false
for($i=0;$i -lt 12;$i++){ try{ if((Invoke-RestMethod "$base/v1/health" -TimeoutSec 10).status -eq 'ok'){$ok=$true;break} }catch{}; Start-Sleep 5 }
if(-not $ok){ "云端 60s 内不健康——先去 Render 看服务是否 live，别急着 F5"; return }
$ready = Invoke-RestMethod "$base/v1/health/ready" -TimeoutSec 10      # 期望 {status:ok, db:ok}
$boards = (@((Invoke-RestMethod "$base/v1/boards").builtin)+@((Invoke-RestMethod "$base/v1/boards").community)).Count
"health ok; ready=$($ready.status)/db=$($ready.db); boards=$boards"
```

**坑①（Cannot reach the auth API）**：health 不 ok 就别往下走——这正是上次"扩展连不上后端"的远程版。

**坑②（tool_registry_mismatch）**：扩展启动会比对**本地编译进 bundle 的工具名集合**和**后端 `/v1/tools`**，不一致就拒绝开会话。云端服务的是部署那一刻 commit 里的契约；本地扩展 rebuild 时打包的是工作区的 [contracts/canonical_tools.json](../../../contracts/canonical_tools.json)。两者会因为"本地有未提交/未部署的契约改动"而漂移。**开会话前先比对**：

```powershell
$remote = @((Invoke-RestMethod "$base/v1/tools").tools).name | Sort-Object
$local  = (Get-Content "contracts\canonical_tools.json" -Raw | ConvertFrom-Json).name | Sort-Object
"remote tools=$($remote.Count)  local contract=$($local.Count)"
$diff = Compare-Object $remote $local
if($diff){ "⚠ 契约不一致 → 开会话必报 tool_registry_mismatch："; $diff | Format-Table -AutoSize } else { "✓ 契约一致，不会触发 mismatch" }
```

不一致时**别用 rebuild 去硬凑**——要么把本地契约改动 commit+push 让 Render 重新部署（云端跟上本地），要么本地 checkout 回云端那版契约（本地跟上云端）。把差异和这两个方向报给用户让他选，不要擅自改契约。

## Phase 3 — 加载扩展（同 dev-up，但后端是云端）

### 模式 A：f5（默认）

1. 先确保能 build（F5 的 preLaunchTask 就是它，提前暴露 TS/依赖错）：
   ```powershell
   npm run build   # cwd: mpy-hardware-extension
   ```
2. 把这几步**原样交给用户**：
   - 用 VS Code 打开**仓库根目录**，按 **F5**（"Run Blockless Extension (dev)"）。
   - **重要**：[launch.json](../../../.vscode/launch.json) 没给 dev host 指定打开的文件夹，dev host 会沿用它上次打开的工作区。**确保那个 [Extension Development Host] 窗口打开的是本仓库根**——这样 `.vscode/settings.json` 里刚切的云端地址才生效。（即便它开成空窗口，`apiBaseUrl` 也会回落到默认值=同一个云端地址，所以一般也没事；但开着本仓库最稳。）
   - 面板在带 **[Extension Development Host]** 的新窗口里。

### 模式 B：reinstall

```powershell
# cwd: mpy-hardware-extension
npm version patch --no-git-tag-version
npm run package
$v=(Get-Content package.json -Raw | ConvertFrom-Json).version
code --install-extension "build/mpy-hardware-extension-$v.vsix" --force
```
装完让用户**完全退出 VS Code 再重开**，并打开本仓库根（让云端设置生效）。

## Phase 4 — 真跑一遍云端

云端是**真后端**：要 GitHub 登录、扣 credits、跑真 DeepSeek。提示用户在面板里:

1. **登录**：首次开会话会拉 GitHub 登录（VS Code 自带 auth）。登录后底部 credits 余额应能加载出来——加载出来=云端 auth + 计量这条线通了。
2. **出一张卡**：随便给个意图（如 "esp32 读个 DS18B20 温度，OLED 显示"），看它从云端流式生成、写出文件。
3. 看右上角 server 标记应是 **live**（不是 stub）。

⚠ **会真实花钱/额度**：云端这台连真 DeepSeek，且 credits 是真计量。压测/反复跑注意消耗。

## Phase 5 — 汇报 + 怎么切回本地

收尾给一张小结：apiBaseUrl 现在指向哪、云端 health/ready/boards/tools 比对结果、用哪种模式加载、credits 是否正常、下一步。

**切回本地**：`cloud-test restore`（读 `.vscode/apibase.bak` 精确还原；没有就设回 `http://127.0.0.1:8787`），然后在 dev host 里关掉面板重开 / 或重启扩展让设置生效。要继续本地全栈开发就跑 [dev-up](../dev-up/SKILL.md)。

## 排错速查

| 症状 | 多半原因 | 处理 |
|------|----------|------|
| 面板报 "Cannot reach the auth API" | 云端没 live / 刚部署在热身 / 网络 | 重跑 Phase 2 探活；去 Render 看服务状态；确认 `apiBaseUrl` 确实是云端 |
| 开会话报 "tool_registry_mismatch" | 本地扩展打包的契约 ≠ 云端 `/v1/tools` | 跑 Phase 2 的契约比对；commit+push 让云端跟上，或本地 checkout 回云端那版 |
| 面板还连本地 8787 | dev host 开的不是本仓库根 / 设置没生效 | 在 dev host 里打开仓库根；关掉面板重开；f5 重启 |
| 首个请求很慢 | Render 实例热身（starter 不睡但首调可能 lag） | 等一下重试；Phase 2 已有有界重试 |
| GitHub 登录失败 / credits 不加载 | 云端 auth 环境没配好 | 看面板报的真实 HTTP 状态码；确认 Render 上 `MPYHW_JWT_SECRET` 等已注入 |
| credits 扣得肉疼 | 这是真后端真 DeepSeek | 正常；少跑或回本地 stub（`dev-up f5 stub`） |
