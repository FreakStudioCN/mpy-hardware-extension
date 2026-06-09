# Handoff — "Cannot reach the auth API" 排障 + 清理 Fly 残留

## Goal

定位并修复:部署后用户用 Blockless VS Code 扩展报 **"无法连接鉴权 API / Cannot reach the auth API" → "会话结束:出错 / Session ended: Error"**;并按用户要求**删光仓库里所有 Fly.io 残留**(后端已迁 Render)。

## Current Progress（已完成）

**后端健康已坐实**（Render `https://blockless-api.onrender.com`，plan=`starter` 不休眠）:
- `/v1/health` → `{"status":"ok","mode":"live"}` 0.4s
- `/v1/health/ready` → `{"status":"ok","db":"ok"}`（DB 也好）
- `POST /v1/auth/github` 假 token → 401 0.4s;**真 token → 200 铸出 JWT**（`MPYHW_JWT_SECRET` 在 prod 确实配好）。
- 结论:后端三条路径全绿，URL/配置都对。**病不在后端。**

**错误语义已钉死**:
- 报错 key `github_token_exchange_unreachable` = [github-auth.ts:59](mpy-hardware-extension/src/extension/github-auth.ts#L59) 的 catch，**只在客户端 fetch 完全收不到响应（连接层抛异常）时触发**;服务端只要回任何状态码（含 500）走的是 `_failed`。
- 生产用全局 `fetch` = Node/undici（[panel.ts:53](mpy-hardware-extension/src/webview/panel.ts#L53)），**不是浏览器**。
- 一次 `getToken` 失败就**致命中止整段会话**（[panel.ts:166-169](mpy-hardware-extension/src/webview/panel.ts#L166-L169)）。fetch **无超时、无重试**。

**找到本机真凶（仅限本机/旧 sideload）**:
- dev 机器上有个**孤儿旧包** `mpyhw.mpy-hardware-extension-0.3.3`，其 dist 烤死了**废弃域名 `blockless-api.fly.dev`**（`curl` 实测 `Could not resolve host`）。默认 URL 在 commit `1cda212` 从 fly.dev 改成 onrender，但**没 bump 版本号**，靠版本号区分不了。
- **但 Marketplace 发布的 `blockless` 包是对的**：拉下 vspackage 解包 grep，0.3.3 与 0.3.4 都烤 `onrender`、无 fly.dev。→ **外部商店用户的 URL 不是病因。**
- 本仓库 [.vscode/settings.json:5](.vscode/settings.json#L5) 已把 `mpyhw.apiBaseUrl` 钉成 onrender → 开着本仓库时即使旧包也被 override 拉到 onrender;**fly.dev 只在 VS Code 没开本工作区时才咬人**（落回烤死默认）。

**已执行的修改**:
- 删光 Fly:删除 `mpyhw-api/fly.toml`;清掉 [README.md](README.md)、[mpyhw-api/DEPLOY.md](mpyhw-api/DEPLOY.md)、[mpyhw-api/Dockerfile](mpyhw-api/Dockerfile) 三处 fly 引用。全仓库 grep 已无 fly 残留。
- 本机配成普通用户:`rm` 掉孤儿 `mpyhw.*-0.3.3` 目录;`code --install-extension blockless.mpy-hardware-extension` 装上 **`blockless.mpy-hardware-extension@0.3.4`**（验证烤 onrender）。`code --list-extensions` 现仅此一个。

## What Worked

- 直接探后端真实 endpoint（health + 假/真 token 两条 auth 路径）证明后端健康，而不是猜。
- 抠错误语义:`unreachable`(fetch 抛异常) ≠ `_failed`(收到非 200)，把范围锁死到客户端连接层。
- **直接 grep 真正发布的 VSIX 与已安装包里烤入的 URL**——正是这一步抓出了我之前的过度断言。

## What Did NOT Work（别重蹈）

1. 假设"国内/GFW 连不上 Render" → **被证伪**:出问题那台机器的**浏览器**能正常打开 `onrender.com/v1/health`。
2. 假设"TLS 拦截，Node vs 浏览器证书库不同" → 合理但**未确认**，被后续证据取代。
3. 一度断言"**100% 全是 fly.dev**" → **错**:那是本机一个 stale sideload;商店发布版是 onrender。教训:**永远 grep 真正发出去的 VSIX，别拿本机残留当发布版**。
4. 用**浏览器 / curl / PowerShell Invoke-WebRequest 做诊断 → 会误导**:它们走 Windows 系统证书库(会信任拦截证书)。扩展走 Node/undici 自带 CA。**要用 `node` 或读「Blockless」输出通道**。

## Next Steps

1. **先验证当前修复**:在出错机器**完全重启 VS Code**(新装扩展要重启，reload 不够)→ 开 Blockless 面板 → 发个需求(如 "blink an LED")。
   - **通了** = 之前就是旧 fly.dev 包 / 窗口没开本工作区。结案。
   - **仍报 "Cannot reach the auth API"** = 跟 fly/旧包无关,是这台机器到 onrender 的**网络/代理/TLS**。下一步 →
2. **若仍失败,取真实异常**:VS Code → 查看/Output → 右上下拉选 **`Blockless`** → 读 `[github-auth] GitHub token exchange request failed: <X>`。`<X>`(undici cause)直接定位:
   - `unable to get local issuer certificate` / `self-signed certificate in certificate chain` → **TLS 拦截**(杀软/代理)。
   - `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` → 连接超时。 `ECONNRESET` → 被重置。 `ENOTFOUND` → DNS。
3. **健壮性硬化（不管根因都该做）**:[github-auth.ts](mpy-hardware-extension/src/extension/github-auth.ts) 的 fetch 加 `AbortController` 超时 + 退避重试;鉴权失败**别一次就杀整段会话**;改掉误导文案"无法连接鉴权 API"(让它能区分"你的网络连不上我们服务器")。
4. **发布防复发守卫**:`publish-extension` 预检加一条——grep 打好的 VSIX/dist，**断言烤入 onrender 且不含 fly.dev**，否则禁发(本次本机 0.3.3 就是 dist 与源码漂移、发出死地址)。
5. **可观测性**:`github_token_exchange_unreachable` 目前只写本地输出通道，服务端看不到。加轻量客户端上报，让这类失败可见。

## 关键文件

- [mpy-hardware-extension/src/extension/github-auth.ts](mpy-hardware-extension/src/extension/github-auth.ts) — auth 流程，catch 在 :59
- [mpy-hardware-extension/src/webview/panel.ts](mpy-hardware-extension/src/webview/panel.ts) — :53 用全局 fetch；:166-169 一次失败致命中止
- [mpy-hardware-extension/src/extension/api-base-url.ts](mpy-hardware-extension/src/extension/api-base-url.ts) — :12 默认 URL(=onrender)，解析优先级 setting > env > default
- [render.yaml](render.yaml) — plan=starter、env(MPYHW_JWT_SECRET generateValue 等)
