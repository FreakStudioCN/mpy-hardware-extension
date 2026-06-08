# Auth + 每日免费额度 抗薅方案 (spec, 暂不改码)

状态: 待 review。本文件只描述**改什么/在哪/怎么改/怎么验**,不含实现代码。
留空项 `〈待定〉` 需要 Haipeng 拍板。

## 背景与威胁模型

链路: `routes_auth` → `auth.verify_github_token` → `session_token`(HS256 JWT)→
`credit_store`(Postgres 额度)→ `routes_llm`(预留/计费)→ `llm_sessions`(并发槽)。

已确认**做得对、不要动**的部分:
- 额度操作原子无竞态(`reserve` 用 `UPDATE ... WHERE balance>=?` + rowcount;每日发放
  `INSERT ON CONFLICT DO NOTHING` + `FOR UPDATE`;并发槽 `pg_advisory_xact_lock`)。
- 每日发放是"置为 grant、一天一次",单账号内刷不出额度。
- 身份服务端从 GitHub 校验 id 推导,不信客户端;验签常量时间。
- Render 上 `MPYHW_ENV=prod` + `MPYHW_JWT_SECRET: generateValue:true` → JWT 伪造路径关闭。

**核心威胁(重定义):** DeepSeek 控制台侧**已设硬性消费上限**,所以"账单无限增长"已被
兜住。但该硬上限是全局钝刀——**触顶即对所有用户(含真实用户)断服**。于是真正的风险变成:

> 攻击者用脚本批量注册的免费 GitHub 账号(每个 50 credit/天 = 50 万 token/天,
> 无账号年龄/邮箱门槛),廉价地把你当月 DeepSeek 预算烧穿 → 把硬上限**武器化成对真实
> 用户的 DoS**,且攻击者每 credit 还能因"输入无上限 + 断流跳过计费"放大 ~10 倍真实花费。

因此目标不是"再加一道账单天花板",而是: **让免费层有自己的、独立于 DeepSeek 硬上限的
每日预算,并降低单个攻击者的杠杆**,使硬上限永远不被免费流量打到。

---

## 修复项

### #1 全局免费层每日预算熔断 (HIGH — 核心兜底)

**问题:** 全局只有并发上限 30(`llm_sessions.py:14`),限的是"同时几个"不是"今天烧了多少"。
账号数无上限 → 免费流量可独立打穿 DeepSeek 硬上限 → 全员 DoS。

**改法:**
- 新增一张计数表(或复用现有 `credit_ledger` 聚合)记录"当天免费层累计扣减 credit"。
  推荐新表 `daily_global_spend(spend_date TEXT PK, credits_spent INTEGER)`,在
  `credit_store.debit`(`credit_store.py:131`)成功扣减后于**同一事务内** `INSERT ... ON
  CONFLICT(spend_date) DO UPDATE SET credits_spent = credits_spent + ?` 累加。同事务保证
  与扣费一致、不漏不重。
- 在 `routes_llm.llm_messages` 预留前(`routes_llm.py:127` 附近,`ensure_daily_grant` 之后、
  `reserve` 之前)读当天累计,超阈值则 `503 {"error":"daily_free_budget_exhausted"}` 并
  释放 session 槽。放在 reserve 之前,避免触顶时仍 churn reserve/refund。
- 新 env `MPYHW_DAILY_GLOBAL_BUDGET`(credit 数,默认 〈待定:建议 ≈ DeepSeek 月上限 / 30 / 安全系数〉;
  未设或 ≤0 视为不限,保持现状)。

**测试:** ① 累计未到阈值正常放行;② 到阈值后下一请求 503 且 session 槽已释放;
③ 跨 UTC 日自动归零;④ 与 `debit` 同事务(扣费回滚则累计也回滚)。

**工作量:** 约半天。这是**一个就能兜底**的项,优先级最高。

---

### #2 输入体积上限 + 预留按量 (HIGH — 砍掉单账号放大杠杆)

**问题:** `await request.json()`(`routes_llm.py:114`)无 body 大小限制;`reserve(user, 1)`
固定预留 1 credit(`routes_llm.py:164`);计费 `meter()` 在 SSE 生成器内(`routes_llm.py:455`),
客户端在末尾 usage chunk 前断开则 `meter()` 不执行 → 整轮只扣 1 credit。攻击者发塞满
DeepSeek 上下文窗的巨大输入(DeepSeek 一启动就按整输入计费),再在 usage chunk 前断流 →
1 credit 买下整段输入账单。

**改法(两条都做,互补):**
- **输入体积硬上限:** 在 `llm_messages` 读 body 后、调用上游前,估算输入规模(可用
  `len(json.dumps(messages))` 字节近似,或更准的 token 估算),超过 `MPYHW_LLM_MAX_INPUT_TOKENS`
  (默认 〈待定,建议贴近 DeepSeek 上下文窗,如 64000〉)直接 `422` 拒掉——**在付钱给 DeepSeek 之前挡住**。
- **预留按量:** 把固定 `reserve(user, 1)` 改为
  `reserve(user, ceil((估算输入 + max_tokens) / CREDIT_TOKENS))`;末尾 `meter()` 用实际
  billable token 与预留做 reconcile,多退少补(沿用现有 refund/debit 逻辑,
  `routes_llm.py:174-197`)。这样即使断流跳过 `meter()`,也已按估算预扣,断流不再"白嫖"。

**测试:** ① 超大 body → 422,不触达上游、不扣费;② 预留额 = ceil((输入+max_tokens)/1万);
③ 正常完成时 reconcile 后净扣 = 实际 billable 对应 credit;④ 断流(不发 usage)时净扣 =
预留额(不退回);⑤ 现有 stub 路径不回归。

**工作量:** 约半天到一天(reconcile 改动要小心,配齐 golden)。

---

### #3 `/v1/auth/github` 速率限制 (MEDIUM)

**问题:** `routes_auth.py:9` 每次调用外呼 GitHub,无节流 → 便于快速批量铸 JWT,也可能打爆
你的 GitHub API 配额。

**改法:** 加按 IP 的简单限流(进程内令牌桶即可,prod 单 worker `WEB_CONCURRENCY=1`,
不必引 Redis)。`MPYHW_AUTH_RATE_PER_MIN`(默认 〈待定,建议 10〉)。超限 `429`。
注意取真实 IP 用 `X-Forwarded-For` 首段(Render 在反代后)。

**测试:** ① 限内放行;② 超限 429;③ 跨窗口恢复;④ XFF 解析正确。

**工作量:** 约 2-3 小时。

---

### #4 无条件拒绝默认 JWT 密钥 (LOW — 卸脚枪)

**问题:** `_jwt_secret()`(`auth.py:30`)只在 `MPYHW_ENV=prod` 时拒绝默认密钥。今天 Render 走
`render.yaml` 安全,但任何"第二环境 / 手建未带 env 的服务"会静默用默认密钥 → 任意 JWT 伪造 →
credit 系统整体失效。

**改法:** 把拒绝默认密钥改为**与 env 无关**:只要 `MPYHW_JWT_SECRET` 缺失或等于
`DEFAULT_JWT_SECRET`,一律拒绝(测试态用 conftest 注入的 `test-secret`,不受影响)。
即把 `auth.py:30` 的 `if os.getenv("MPYHW_ENV")=="prod" and secret==DEFAULT...` 条件里的
env 判断去掉。

**测试:** 已有 `test_validate_config_requires_jwt_secret_in_prod` 扩展为"任意 env 下默认密钥都拒绝"。

**工作量:** ~30 分钟。

---

### #5 GitHub 账号年龄门槛 (MEDIUM — 降 Sybil 概率,需产品确认)

**问题:** `verify_github_token`(`auth.py:79`)接受任意有效 GitHub 账号,机器人新号零成本。

**改法:** `/user` 响应含 `created_at`;在 `verify_github_token` 返回前校验账号年龄 ≥
`MPYHW_MIN_GH_ACCOUNT_AGE_DAYS`(默认 〈待定,建议 30;设 0 关闭〉),不足则
`403 {"error":"github_account_too_new"}`。

**取舍(需你定):** 会误伤"刚注册 GitHub 的真实新用户"。若你的早期用户里这类占比高,
可先设 0(关闭)或较小值,配合 #1 的全局熔断兜底再观察。

**测试:** ① 老号通过;② 新号 403;③ env=0 时不校验。

**工作量:** ~2 小时。

---

## 建议执行顺序

1. **#1 全局每日预算熔断** — 一个项就把"DoS 打穿硬上限"封死,最高优先。
2. **#2 输入上限 + 按量预留** — 砍掉单账号放大杠杆。
3. **#4 无条件拒绝默认密钥** — 极便宜,顺手做。
4. **#3 auth 限流**、**#5 账号年龄门槛** — 视上线节奏与早期用户画像决定。

## 不在本次范围(知会,暂不做)
- JWT 24h TTL / 吊销:可接受,泄露 token 只值一个账号的 50 credit/天。
- 邮箱去重 / captcha / 付费墙:免费层固有取舍,后置。

## 需 Haipeng 拍板的留空项
- `MPYHW_DAILY_GLOBAL_BUDGET` = 〈待定〉credit/天
- `MPYHW_LLM_MAX_INPUT_TOKENS` = 〈待定〉
- `MPYHW_AUTH_RATE_PER_MIN` = 〈待定,建议 10〉
- `MPYHW_MIN_GH_ACCOUNT_AGE_DAYS` = 〈待定,建议 30 或 0〉
- 是否下调 `DAILY_GRANT`(当前 50)= 〈待定〉
