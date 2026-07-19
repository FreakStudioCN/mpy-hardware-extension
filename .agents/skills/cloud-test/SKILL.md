---
name: cloud-test
description: 用本地前端插件连云端后端做端到端测试 / test the local VS Code extension against the deployed cloud backend. 云端 `https://blockless.upypi.net` 本就是扩展默认后端，所以"测云端"＝确保没有本地 `MPYHW_API_BASE` 覆盖（清掉 launch.json 里那行 env），探活云端 /v1/health 与 /v1/tools（顺带挡掉本会话踩过的 "Cannot reach the auth API" 与 "protocol_version_mismatch" 两个坑），再按模式加载扩展。参数 f5(默认) 或 reinstall；restore 一键切回本地。不需要 Docker/Postgres/本地 DeepSeek key。
argument-hint: "[f5|reinstall|restore]"
---

# cloud-test — 本地前端 × 云端后端

跟 [dev-up](../dev-up/SKILL.md) 相反：**不起任何本地后端**（不碰 Docker / Postgres / uvicorn / 本地 DeepSeek key），只把**本地的 VS Code 扩展**指到已经部署在云端的后端 `https://blockless.upypi.net`（这也是扩展的默认地址），然后真用 UI 跑一遍，验证云端这条线端到端通。

为什么单独做这个：扩展的后端地址由 `resolveApiBaseUrl` 决定，优先级是 **setting > env(`MPYHW_API_BASE`) > 默认**，而[默认值本身就是云端](../../../mpy-hardware-extension/src/extension/api-base-url.ts) (`DEFAULT_API_BASE_URL = https://blockless.upypi.net`)。⚠️ `mpyhw.apiBaseUrl` 现在是 **`scope: machine`**（安全加固 P0：挡住恶意工作区用 `.vscode/settings.json` 改后端地址偷 GitHub token / session JWT），**工作区 `.vscode/settings.json` 已不再能覆盖它**——旧的"改 settings.json 切后端"机制已失效。现在唯一的本地开关是 **`MPYHW_API_BASE` 环境变量**，F5 走 [`.vscode/launch.json`](../../../.vscode/launch.json) 的 `env` 注入 dev host。测云端＝不注入（回落默认云端）；测本地＝注入 `http://127.0.0.1:8787`。launch.json 虽进 git，但这行 env 是本地开关、**别 commit**。

> ⚠️ 首次跑本 skill 前请在一次真实 F5 里确认：launch.json 的 `env.MPYHW_API_BASE` 确实透传到了扩展 `process.env`（标准行为，但本机没验过）。验法见 Phase 2 末尾。

## 解析参数（默认 `f5`）

- `f5`（默认）— 走 F5 Extension Development Host，前端实时迭代。
- `reinstall` — 打包 vsix 重装到日常 VS Code。
- `restore` — **不加载扩展**，只把本地开关（launch.json 的 `MPYHW_API_BASE` env）设回 `http://127.0.0.1:8787`（测完云端回到本地开发用）。

云端地址固定 `https://blockless.upypi.net`；要测别的环境，把下文出现的 URL 整体替换。

---

## Phase 0 — 预检（很轻，没有 Docker/Python）

并行查，缺了再补：

1. `node --version`、`code --version` 在 PATH。**不需要** docker / python。
2. `mpy-hardware-extension/node_modules` 在不在；不在就 `npm install`（cwd 在 `mpy-hardware-extension`）。

> 若参数是 `restore`：跳过 Phase 0/2/3/4，直接做 Phase 1 的"切回本地"那半边，然后收尾。

## Phase 1 — 把前端指向云端

云端就是扩展的默认后端，所以"指向云端"＝确保没有本地 `MPYHW_API_BASE` 覆盖：

1. 打开 [`.vscode/launch.json`](../../../.vscode/launch.json)，看 "Run Blockless Extension (dev)" 配置里有没有 `env.MPYHW_API_BASE`。
2. 有就删掉这个 `env`（或把 `MPYHW_API_BASE` 值设为空串——`resolveApiBaseUrl` 对空/纯空白值也会回落到默认云端）。没有就什么都不用改。
3. 顺带确认用户 **User 级** settings 里没有 `mpyhw.apiBaseUrl`（machine-scope 允许 User 级，会赢过 env）——正常是没有的。
4. 告诉用户：这是本地开关、别 commit 这行 env；测完用 `cloud-test restore` 切回本地。

`restore` 分支：往 launch.json 的 "Run Blockless Extension (dev)" 配置写
`"env": { "MPYHW_API_BASE": "http://127.0.0.1:8787" }`，然后结束（提示用户回原窗口重按 F5，让新起的 dev host 带上这个 env）。

## Phase 2 — 探活云端后端（关键，挡掉本会话两个坑）

这一步专门预防本会话真实踩过的两类错误。用**有界重试**（托管实例不睡，但部署刚完/久未访问首个请求可能慢几秒）：

```powershell
$base = "https://blockless.upypi.net"
$ok=$false
for($i=0;$i -lt 12;$i++){ try{ if((Invoke-RestMethod "$base/v1/health" -TimeoutSec 10).status -eq 'ok'){$ok=$true;break} }catch{}; Start-Sleep 5 }
if(-not $ok){ "云端 60s 内不健康——先去托管平台看服务是否 live，别急着 F5"; return }
$ready = Invoke-RestMethod "$base/v1/health/ready" -TimeoutSec 10      # 期望 {status:ok, db:ok}
$boards = (@((Invoke-RestMethod "$base/v1/boards").builtin)+@((Invoke-RestMethod "$base/v1/boards").community)).Count
"health ok; ready=$($ready.status)/db=$($ready.db); boards=$boards"
```

**坑①（Cannot reach the auth API）**：health 不 ok 就别往下走——这正是上次"扩展连不上后端"的远程版。

**坑②（protocol_version_mismatch / protocol tools drift）**：当前协议路径不再对比旧的 27-tool `contracts/canonical_tools.json`。云端 `/v1/tools` 应服务 `contracts/protocol_messages.json` 里的 6 个 `llm_tools`，扩展启动会用 `protocol_version` 判断前后端协议是否一致。**开会话前先比对**：

```powershell
$remoteBody = Invoke-RestMethod "$base/v1/tools" -TimeoutSec 10
$remote = @($remoteBody.tools).name | Sort-Object
$contract = Get-Content "contracts\protocol_messages.json" -Raw | ConvertFrom-Json
$local = @($contract.llm_tools) | Sort-Object
"remote protocol=$($remoteBody.protocol_version)  local protocol=$($contract.protocol_version)"
"remote tools=$($remote.Count)  local protocol tools=$($local.Count)"
$diff = Compare-Object $remote $local
if($remoteBody.protocol_version -ne $contract.protocol_version){ "⚠ 协议版本不一致 → 开会话会报 protocol_version_mismatch" }
elseif($diff){ "⚠ 协议工具名不一致："; $diff | Format-Table -AutoSize }
else { "✓ 协议一致，不会触发 protocol/tool mismatch" }
```

不一致时**别用 rebuild 去硬凑**——要么把本地协议改动 commit+push 让云端重新部署（云端跟上本地），要么本地 checkout 回云端那版协议（本地跟上云端）。把差异和这两个方向报给用户让他选，不要擅自改契约。

> **验 env 透传**（首跑一次即可）：在 dev host 里开 Blockless 面板，看它请求打到哪个 base（面板报错里的 host，或后端 access log）。指到 `blockless.upypi.net`＝env 空、走默认，对；若你在 launch.json 放了本地 env 却仍打云端，说明 `env` 没透传，改用"启动 VS Code 前设 `$env:MPYHW_API_BASE`"的兜底路子。

## Phase 3 — 加载扩展（同 dev-up，但后端是云端）

### 模式 A：f5（默认）

1. 先确保能 build（F5 的 preLaunchTask 就是它，提前暴露 TS/依赖错）：
   ```powershell
   npm run build   # cwd: mpy-hardware-extension
   ```
2. 把这几步**原样交给用户**：
   - 用 VS Code 打开**仓库根目录**，按 **F5**（"Run Blockless Extension (dev)"）。
   - 后端地址现在由 launch.json 的 `env.MPYHW_API_BASE` 决定（Phase 1 已确保测云端时它是空/不存在），跟 dev host 打开哪个文件夹无关——即便开成空窗口也会回落到默认云端地址。开着本仓库根最稳（面板其它相对路径依赖它）。
   - 面板在带 **[Extension Development Host]** 的新窗口里。

### 模式 B：reinstall

```powershell
# cwd: mpy-hardware-extension
npm version patch --no-git-tag-version
npm run package
$v=(Get-Content package.json -Raw | ConvertFrom-Json).version
code --install-extension "build/mpy-hardware-extension-$v.vsix" --force
```

装完让用户**完全退出 VS Code 再重开**（打开本仓库根）。装机版走的是**默认云端地址**，不需要任何覆盖；若要让装机版连本地，得在启动 VS Code **之前**设 `$env:MPYHW_API_BASE`（launch.json 的 `env` 只对 F5 dev host 生效，对装机版无效）。

## Phase 4 — 真跑一遍云端

云端是**真后端**：要 GitHub 登录、扣 credits、跑真 DeepSeek。提示用户在面板里:

1. **登录**：首次开会话会拉 GitHub 登录（VS Code 自带 auth）。登录后底部 credits 余额应能加载出来——加载出来=云端 auth + 计量这条线通了。
2. **出一张卡**：随便给个意图（如 "esp32 读个 DS18B20 温度，OLED 显示"），看它从云端流式生成、写出文件。
3. 看右上角 server 标记应是 **live**（不是 stub）。

⚠ **会真实花钱/额度**：云端这台连真 DeepSeek，且 credits 是真计量。压测/反复跑注意消耗。

## Phase 5 — 汇报 + 怎么切回本地

收尾给一张小结：现在指向哪个后端（launch.json env 状态）、云端 health/ready/boards/tools 比对结果、用哪种模式加载、credits 是否正常、下一步。

**切回本地**：`cloud-test restore`（往 launch.json 写 `env.MPYHW_API_BASE=http://127.0.0.1:8787`），然后回原窗口重按 F5 让新 dev host 带上这个 env。要继续本地全栈开发就跑 [dev-up](../dev-up/SKILL.md)。

## 排错速查

| 症状 | 多半原因 | 处理 |
|------|----------|------|
| 面板报 "Cannot reach the auth API" | 云端没 live / 刚部署在热身 / 网络 | 重跑 Phase 2 探活；去托管平台看服务状态；确认 launch.json 里没有指向本地的 `MPYHW_API_BASE` |
| 开会话报 "protocol_version_mismatch" | 本地扩展打包的契约 ≠ 云端 `/v1/tools` | 跑 Phase 2 的契约比对；commit+push 让云端跟上，或本地 checkout 回云端那版 |
| 面板还连本地 8787 | launch.json 的 `env.MPYHW_API_BASE` 还指着本地 / dev host 没重启 | 删掉那行 env（或跑 `cloud-test` 的 Phase 1）；回原窗口重按 F5 |
| 首个请求很慢 | 托管实例热身（首调可能 lag） | 等一下重试；Phase 2 已有有界重试 |
| GitHub 登录失败 / credits 不加载 | 云端 auth 环境没配好 | 看面板报的真实 HTTP 状态码；确认托管平台上 `MPYHW_JWT_SECRET` 等已注入 |
| credits 扣得肉疼 | 这是真后端真 DeepSeek | 正常；少跑或回本地 stub（`dev-up f5 stub`） |
