---
name: diagnose-cloud-session
description: 用户报告 Blockless 扩展在云端实测时出问题（卡死/灰屏/跳步/构建失败），但本地复现不了、日志不在本地文件里时，用这个从云端托管数据库拉真实 session 定位症状与根因 / Use when a user reports an in-product Blockless bug from live cloud-backend testing and the real session data lives in the hosted Postgres (telemetry_events / llm_turns / sessions), not in local files. Triggers — "查数据库找症状", "去看真实log", session 卡死/awaiting_user, 搜索驱动卡住, 审批卡片灰屏, repair_exhausted, 只能靠 trace_id / admin 接口排障.
argument-hint: "[N most-recent | trace-id]"
---

# diagnose-cloud-session — 从云端库给实测 session 验尸

线上实测（扩展连 `https://blockless.upypi.net`）的 session 事件经 `CloudTelemetryRecorder` 进了**云端托管 Postgres（`blockless-db`）**，不在本地。排障入口是这个库的 `sessions` / `telemetry_events` / `llm_turns` 三张表（schema 见 [mpyhw-api/app/db.py](../../../mpyhw-api/app/db.py)）。

## 凭据（只读，绝不写生产库）

生产库连接串是线上密钥，**不在仓库**（也不在任何提交进 git 的部署配置里）。本地 `mpyhw-api/.env` 的 `DATABASE_URL` 是本地 docker 库（127.0.0.1:55432），**不是这个**。从托管数据库控制台复制生产库的 External Connection String，写进 `mpyhw-api/.env` 一行 `PROD_DATABASE_URL=...`（`.env` 已 gitignore，别贴进聊天、别 echo 连接串）。只跑 `SELECT`，永不 INSERT/UPDATE/DELETE 生产。

## 步骤

脚本在本 skill 目录（用 `python` 3 + `psycopg`，仓库已装）：

```bash
cd mpyhw-api
# 1) 列最近 session，按 started_at 倒序；用时间/terminal/board 锁定那几条实测
python <skill>/db_query.py .env PROD_DATABASE_URL
# 2) 拉指定 session 的有序事件流 + llm_turns
python <skill>/db_events.py .env PROD_DATABASE_URL <trace_id> [<trace_id> ...]
```

按 trace_id 取整条也可用 admin 接口（无需直连库，但**没有"列出 session"的接口**，必须先有 trace_id）：
`curl -H "X-Admin-Token: $MPYHW_ADMIN_TOKEN" https://blockless.upypi.net/v1/admin/sessions/<trace_id>`（token 在 `.env`；与生产不一致就找维护者要生产值）。

## 判读语义（踩过的坑，最值钱的部分）

| 现象 | 真实含义 |
|---|---|
| `sessions.terminal = awaiting_user` | **协议 stall/incomplete**，不是"真在等用户"。runProtocolBuild 没跑到 phase_complete 就被 [protocol-build.ts:141-144](../../../mpy-hardware-extension/src/core/protocol-build.ts#L141-L144) 映射成 awaiting_user。**"卡死"通常长这样**。 |
| `terminal = cancelled` | 用户主动取消 / retry。 |
| `terminal = session_error / repair_exhausted / max_turns` | 真失败，看 llm_turns 与 runtime_error 事件。 |
| `sessions.turn_count = 0` 但有很多 llm_turns | turn_count 不可信（只在客户端发 `llm_turn_finished` 时加，协议 loop 不发）。**以 llm_turns 行数为准**。 |
| llm_turns 全 success、只有 ~10 行后就停 | 模型没挂；阶段在某个 turn **没带 tool**就 stall（[protocol-loop.ts:102](../../../mpy-hardware-extension/src/core/protocol-loop.ts#L102) 收到 0 个 tool_use 立即 stalled）。 |

## ⚠️ 覆盖缺口：数据库对 UI/阶段 bug 是瞎的

云端 `telemetry_events` 每条 session **只有 `session_started` / `intent_submitted` / `session_finished`**。协议 loop 的 `status_update` / `phase_start` 是 **postMessage-only 根本不 record**；`phase_complete` / `approval_requested` / `components_proposed` 虽 record 进**本地 jsonl**，但 [telemetry.ts `mapSessionEvent`](../../../mpy-hardware-extension/src/core/telemetry.ts#L66) 只认旧 agent-backed-loop 词汇 → 协议事件全 `return null` 被丢。

后果：
- **能从库里定位**：后端/LLM/卡死(stall)/构建终态、模型延迟、repair 次数。
- **库里看不到**：审批卡片灰屏/跳步、阶段进度、哪个 tool/script 跑了。这类 UI/阶段 bug 要读本地 `<工作区>/.mpyhw/sessions/<traceId>/session.jsonl`（有 approval_requested/phase_complete），或先把 mapSessionEvent 补成协议词汇再让云端可观测。

## Common mistakes

- 去本地文件 / 本地 docker 库找云端实测数据 → 连超时或只有旧数据。云端实测就连 `PROD_DATABASE_URL`。
- 把 `awaiting_user` 当成"正常在等用户" → 其实是 stall，要继续追为什么阶段没完成。
- 想从数据库定位灰屏/跳步 → 库里没这些事件（见覆盖缺口），白找。
