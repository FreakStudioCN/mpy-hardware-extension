# 02 — mpyhw-api Spec

> 仓库：`mpyhw-api`（FastAPI 后端，**LLM 薄代理 + content 仓库 + Package Intelligence + 配额 + 防滥用**）
> 适用版本：v0.2.0
> 读者：后端开发；建议先读 [`00-architecture-overview.md`](00-architecture-overview.md)

---

## 1. 服务定位

**薄代理 + content 仓库**。后端不跑 agent 逻辑——agent loop 全在 VS Code 扩展 TS 端（详 [`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md) §5 和 [`04-coding-harness-design.md`](04-coding-harness-design.md) §3）。

具体职责：
- **LLM 代理**：透传 Anthropic Messages API + SSE 流式 + middleware 强制注入 intent gate + tool 白名单校验
- **Content 静态托管**：skill markdown 文件、board profile JSON、canonical tool registry JSON、package index、driver context
- **Package Intelligence**：聚合 uPyPi / GraftSense package metadata、README、examples、源码线索，提供包搜索、候选解析、驱动用法上下文（缓存 + analytics）。这是 package search / resolve / driver-context 的 canonical 实现；客户端只调用 `/v1/packages/*`，不重写排序、归一化或 driver-context extraction。
- **配额 + 防滥用 + 观察性**
- **Telemetry 接收**：client 推 trace event → Sentry breadcrumb

不做的：
- 不跑 ReAct agent loop
- 不持有 manifest schema / validator（搬到客户端 TS zod）
- 不存储用户代码（仅 hash 日志用于调试）
- 不直接和开发板/串口打交道（那是 `mpyhw-vscode` 内嵌的 `python/shim/` 在用户机器上做的事）
- 不在请求路径里实时爬外部 package source；uPyPi/GraftSense 通过 ingestion 或缓存进入 normalized package store，请求 handler 只查本地 store/cache

**架构契约**：endpoint 设计 IDE-agnostic（HTTP + JSON + SSE）。v0.2 只有 VS Code 一个客户端实现，但 API 不假设客户端身份。

---

## 2. Endpoint 概览

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/v1/llm/messages` | **核心 endpoint**：透传 Anthropic Messages API + SSE 流式响应；middleware 强制注入 intent gate + tool 白名单校验 |
| `GET`  | `/v1/skills` | 返回 skill catalog 总览（含每个 skill 的 name / description / when_to_use frontmatter） |
| `GET`  | `/v1/skills/{name}` | 返回单个 skill 的完整 body（markdown） |
| `GET`  | `/v1/boards` | 返回内置 board 列表 |
| `GET`  | `/v1/boards/{board_id}` | 返回单个 board profile JSON |
| `GET`  | `/v1/tools` | 返回 canonical tool registry（client 校对自己副本一致性） |
| `GET`  | `/v1/packages/index` | 返回 package index 摘要和版本（uPyPi + GraftSense 聚合） |
| `POST` | `/v1/packages/search` | 按关键词/能力/芯片/总线搜索 MicroPython 包（Redis 缓存） |
| `POST` | `/v1/packages/resolve` | 从用户 intent + capabilities + board 解析候选包并排序 |
| `GET`  | `/v1/packages/{name}/{version}` | 返回标准化 package metadata |
| `GET`  | `/v1/packages/{name}/{version}/readme` | 返回 README / examples 摘要（用于人类 UI 和 LLM context） |
| `GET`  | `/v1/packages/{name}/{version}/driver-context` | 返回机器可读驱动用法上下文（import、API、bus、deps、known issues、support level） |
| `POST` | `/v1/telemetry` | 客户端推 trace event（转 Sentry breadcrumb） |
| `GET`  | `/v1/quota` | 查 session 剩余额度 |
| `GET`  | `/v1/health` | 健康检查（供 monitoring） |

**已删除的 endpoint**（与 V2 spec 的差异）：
- `~~POST /v1/agent/turn~~`：agent loop 搬客户端，不需要服务端 turn endpoint
- `~~POST /v1/agent/classify_intent~~`：intent 判断通过 middleware 注入 system prompt，无独立 endpoint

---

## 3. 请求/响应 Schema

### 3.1 `POST /v1/llm/messages`（核心）

**透传 Anthropic Messages API**——request 体几乎是 Anthropic SDK `messages.create()` 参数的 mirror，加少量自定义字段。

```python
class LLMMessagesRequest(BaseModel):
    # === Anthropic 透传字段 ===
    model: str | None = None          # 默认 server 端覆盖为 LLM_MODEL_ID
    messages: list[Message]
    system: list[SystemBlock]         # cache_control markers 客户端来加
    tools: list[ToolSchema]           # 必须全部命中 canonical whitelist
    temperature: float = 0.1
    max_tokens: int = 4096
    stream: Literal[True] = True      # v0.2 强制流式

    # === 自定义字段 ===
    session_id: str                   # client 生成的 UUID，用于配额 + telemetry 关联
    byok_key: str | None = None
    # 注：trace_id 走 HTTP header X-Trace-Id

class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str | list[ContentBlock]

class SystemBlock(BaseModel):
    type: Literal["text"]
    text: str
    cache_control: CacheControl | None = None

class CacheControl(BaseModel):
    type: Literal["ephemeral"]
```

**响应**：`text/event-stream`，事件格式与 Anthropic SDK streaming 完全一致：

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_...", "type": "message", "role": "assistant", ...}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "我先查"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "板子配置"}}

...

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: content_block_start
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_...", "name": "query_board_profile", "input": {}}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"board"}}

...

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "tool_use", ...}}

event: message_stop
data: {"type": "message_stop"}
```

**错误响应**（非 200，无 SSE）：
- `403` ：`tools` 字段含非白名单条目 → `{"error": "tool_not_whitelisted", "rejected": [...]}`
- `403` ：fast-path 命中硬负向匹配 → `{"error": "abuse_detected", "suggested_response": "..."}`
- `413` ：request body > 100KB
- `429` ：配额或限流
- `5xx` ：透传 Anthropic 错误

### 3.2 `GET /v1/skills`

返回 catalog 总览：

```python
class SkillCatalogResponse(BaseModel):
    version: str                          # ETag 等价；客户端缓存比对
    foundational: list[SkillSummary]      # 始终注入的（agent_identity / safety_boundaries / tool_use_protocol）
    task: list[SkillSummary]              # 按需 load 的 task skills
    recovery: list[SkillSummary]          # 按需 load 的 recovery skills

class SkillSummary(BaseModel):
    name: str                             # 例如 "manifest-resolution-guide"
    description: str
    when_to_use: str
    body_url: str                         # /v1/skills/{name}
    body_sha256: str                      # 客户端可单独缓存 body 并校验
```

### 3.3 `GET /v1/skills/{name}`

返回 markdown body（去掉 frontmatter）：`Content-Type: text/markdown; charset=utf-8`。

支持 `If-None-Match: <body_sha256>` → 命中返回 304。

### 3.4 `GET /v1/boards` / `GET /v1/boards/{board_id}`

```python
class BoardIndexResponse(BaseModel):
    version: str
    builtin: list[BoardSummary]
    community: list[BoardSummary]  # v0.3 才有，v0.2 空数组

class BoardSummary(BaseModel):
    board_id: str
    display_name: str
    manufacturer: str
    detail_url: str                 # /v1/boards/{board_id}
    detail_sha256: str
```

`GET /v1/boards/{board_id}` 返回完整 board profile JSON。支持 `If-None-Match` → 304。

完整 board profile schema（V3.1.2 含 `pin_recommendations` + `pin_capabilities` Q5 守门）：

```jsonc
{
  "$schema": "../board_profile.schema.json",
  "board_id": "esp32-s3-devkitc-1",
  "display_name": "ESP32-S3 DevKitC-1",
  "manufacturer": "Espressif",
  "vid_pid": [{"vid": "0x303A", "pid": "0x1001"}],
  "micropython_versions_supported": ["1.21", "1.22", "1.23"],

  "pin_map": {
    "GPIO0": {"notes": "boot strap"},
    "GPIO1": {},
    "GPIO2": {},
    "GPIO5": {},
    "GPIO6": {}
  },

  // V3.1.2 Q5 守门：每个 pin 支持的角色白名单
  // manifest_validator 强制 manifest 里 pins[].role 必须在对应 pin 的 capabilities 数组里
  "pin_capabilities": {
    "GPIO1": ["gpio_in", "gpio_out", "adc"],
    "GPIO2": ["gpio_in", "gpio_out", "led_anode", "pwm", "adc"],
    "GPIO5": ["gpio_in", "gpio_out", "i2c_sda", "adc"],
    "GPIO6": ["gpio_in", "gpio_out", "i2c_scl"],
    "GPIO43": ["gpio_in", "gpio_out", "uart_tx"],
    "GPIO44": ["gpio_in", "gpio_out", "uart_rx"]
  },

  // V3.1.2 B2 接线表：每个常用角色推荐的引脚
  // code_generation_guide 用这个生成接线表写在 final_answer 末尾
  "pin_recommendations": {
    "i2c_sda": "GPIO5",
    "i2c_scl": "GPIO6",
    "led_default": "GPIO2",
    "led_alternatives": ["GPIO4", "GPIO10"],
    "button_default": "GPIO0",
    "uart_tx_default": "GPIO43",
    "uart_rx_default": "GPIO44"
  },

  "strap_pins": ["GPIO0", "GPIO3", "GPIO45", "GPIO46"],
  "forbidden_pins": ["GPIO19", "GPIO20"],
  "safe_voltage_pins": ["GPIO1", "GPIO2", "GPIO5", "GPIO6"],
  "available_modules": ["machine", "time", "math", "json", "neopixel", "_thread"],
  "supported_peripherals": ["aht20", "ds18b20", "led", "button"],
  "source": "builtin"
}
```

**v0.2 三个内置 board profile**（`esp32-s3-devkitc-1` / `raspberry-pi-pico-w` / `esp32-c3-devkitc`）都按这个 schema 填齐。社区贡献 board profile（v0.3）走同一 schema。

### 3.5 `GET /v1/tools`

返回 canonical tool registry（client 启动时拉一次缓存，发 `/v1/llm/messages` 时确保 `tools` 字段是这一套）：

```python
class ToolRegistryResponse(BaseModel):
    version: str                          # v0.2 14 个 tool 的 schema hash
    tools: list[CanonicalTool]

class CanonicalTool(BaseModel):
    name: str                             # 例如 "query_board_profile"
    description: str
    input_schema: dict                    # JSON Schema
    executor_hint: Literal["local", "api-proxy", "shim", "ui-prompt"]  # 给 client 看的，server 不依赖
    requires_user_confirm: bool           # 客户端按这个决定要不要弹窗
```

`tools` 字段中的 schema 跟 Anthropic Messages API 完全兼容。Client 把这些 tool 的 schema 透传到 `/v1/llm/messages` 的 `tools` 字段。

### 3.6 Package endpoints

```python
class PackageIndexResponse(BaseModel):
    version: str                          # package index hash / build id
    generated_at: datetime
    sources: list[PackageSourceSummary]   # upypi / graftsense / curated
    total_packages: int
    support_level_counts: dict[str, int]  # discoverable/installable/generatable/verified/experimental
    cached: bool

class PackageSourceSummary(BaseModel):
    source: Literal["upypi", "graftsense", "curated"]
    package_count: int
    last_synced_at: datetime

class PackageSearchRequest(BaseModel):
    query: str
    capabilities: list[str] = []          # e.g. ["temperature_sensing", "display_text"]
    board_id: str | None = None
    bus: Literal["i2c", "spi", "onewire", "uart", "gpio", "pwm"] | None = None
    limit: int = 10

class PackageSearchResponse(BaseModel):
    results: list[PackageHit]
    cached: bool

class PackageHit(BaseModel):
    name: str
    version: str
    source: Literal["upypi", "graftsense", "curated"]
    package_json_url: str
    description: str | None
    capabilities: list[str]
    chips: str
    fw: str
    support_level: Literal["discoverable", "installable", "generatable", "verified", "experimental"]
    score: float
    reason: str

class PackageRecord(BaseModel):
    name: str
    version: str
    source: Literal["upypi", "graftsense", "curated"]
    description: str
    author: str
    license: str
    chips: str                                  # 字符串值（"all" 或具体型号），不是 list
    fw: str                                     # 字符串值，不是 list
    deps: list[str]                             # 总在；空数组可能；不 optional
    urls: list[tuple[str, str]]                 # [[filename, path], ...]
    package_json_url: str
    readme_url: str | None
    repository_url: str | None
    capabilities: list[str]
    support_level: Literal["discoverable", "installable", "generatable", "verified", "experimental"]
    cached: bool

class DriverContextResponse(BaseModel):
    package: PackageRecord
    import_names: list[str]
    constructors: list[str]                     # e.g. ["AHT20(i2c)"]
    read_methods: list[str]                     # e.g. ["read_temperature()", "read_humidity()"]
    read_properties: list[str]                   # e.g. ["temperature", "relative_humidity"] when driver uses properties
    bus: list[Literal["i2c", "spi", "onewire", "uart", "gpio", "pwm"]]
    pin_roles: list[str]                        # e.g. ["i2c_sda", "i2c_scl"]
    install: dict                               # {method:"mpremote mip install", url:"...package.json"}
    examples: list[str]                         # short snippets, not full source dumps
    known_issues: list[str]
    evidence_refs: list[dict]                    # [{type:"package_json"|"readme"|"example"|"source"|"hardware_smoke", url/path/hash, excerpt_hash}]
    confidence: float

class PackageResolveRequest(BaseModel):
    intent: str
    capabilities: list[str]
    board_id: str
    constraints: dict = {}                      # bus/pins/chip/vendor/user preference

class PackageResolveResponse(BaseModel):
    candidates: list[PackageHit]
    selected: PackageHit | None
    needs_user_choice: bool
    questions: list[str]
```

Redis 缓存：search/resolve TTL 1 小时；metadata/readme/driver-context TTL 24 小时。失败时不缓存负结果。Package endpoints 的外部来源是 uPyPi API、GraftSense package.json/README/examples、以及少量 curated verified recipes；client 不直接依赖某一个上游站点的字段形状。请求 handler 读取 normalized package store/cache，不在用户请求中同步爬外部源。

### 3.7 `POST /v1/telemetry`

```python
class TelemetryEvent(BaseModel):
    trace_id: UUID
    event_type: Literal["session_started", "tool_dispatch", "shim_call",
                        "skill_loaded", "terminal", "error", "not_hardware_detected"]
    timestamp: datetime
    payload: dict                          # event-specific，server 不严格 validate

class TelemetryRequest(BaseModel):
    events: list[TelemetryEvent]           # 批量推
```

Response: `204 No Content`。Server 转 Sentry breadcrumb，**不存** payload 内容（隐私），仅记元数据。

### 3.8 `GET /v1/quota`

```python
# Header: X-Session-Id: <uuid>
class QuotaResponse(BaseModel):
    daily_session_used: int
    daily_session_limit: int               # 5 for anon, 20 for registered, -1 for byok
    byok_enabled: bool
    reset_at: datetime                     # 当日 UTC 0 点
```

注意：v0.2 不再有"每 session turn 上限"——agent loop 在客户端，server 不知道 turn 数。配额只算"启动 session 次数"——即当日某 IP **首次**见到某个 root session_id（`session_id.split("/sub")[0]`，剥掉 `/sub-*` 后缀）时扣 1；同 session 的续轮和所有嵌套子流（`generate_code` / git commit msg，session_id 带 `/sub-` 后缀）都不扣（详 §6.3）。

---

## 4. 模块清单（FastAPI 项目结构）

```
mpyhw-api/
  app.py                              # FastAPI 入口
  routes/
    llm_messages.py                   # POST /v1/llm/messages (SSE)        ~150 行
    skills.py                         # GET /v1/skills, /v1/skills/{name}  ~80 行
    boards.py                         # GET /v1/boards, /v1/boards/{id}    ~60 行
    tools.py                          # GET /v1/tools                       ~30 行
    packages.py                       # GET/POST /v1/packages/*             ~160 行
    telemetry.py                      # POST /v1/telemetry                  ~40 行
    quota.py                          # GET /v1/quota                       ~30 行
    health.py                         # GET /v1/health                      ~10 行
  middleware/
    intent_gate.py                    # 第一轮注入 intent gate 到 system   ~50 行
    tool_whitelist.py                 # 校验 tools 字段全部命中 canonical  ~40 行
    abuse_counter.py                  # 解析 SSE 第一 chunk 检 not_hardware ~50 行
    quota.py                          # 配额检查 + 扣减                     ~40 行
    rate_limit.py                     # slowapi 配置                        ~20 行
  content/
    skills/
      foundational/
        agent_identity.md
        safety_boundaries.md
        tool_use_protocol.md
      task/
        manifest_resolution_guide.md       # 含依赖解析（V3.1.2 合并自 dependency_resolution）
        code_generation_guide.md           # 含调试点规范 + 接线表指令 + install_package 顺序提示
        serial_diagnosis_guide.md
        git_commit_guide.md                # V3.1.2 新增：嵌套 SSE 生成 conventional commit msg
      recovery/
        import_error_recovery.md
        pin_error_recovery.md
        i2c_not_found_recovery.md
        device_disconnected_recovery.md
        watchdog_reset_recovery.md
    boards/
      esp32-s3-devkitc-1.json
      raspberry-pi-pico-w.json
      esp32-c3-devkitc.json
    packages/
      package_index.json              # uPyPi + GraftSense 聚合索引快照
      driver_context/
        aht20_driver-1.0.0.json       # 机器可读驱动用法上下文；非完整源码
    canonical_tools.json              # canonical tool registry (single source of truth)
  config.py                           # env vars, settings
  storage.py                          # Redis client + quota counters       ~80 行
```

总后端代码量预算：约 **700 行**（不含 content 文件 + 测试）。比 V2 的 1900 行后端代码大幅缩水；增加的部分只做 package content 聚合，不跑 agent。

---

## 5. LLM Proxy 流程（核心 endpoint 细节）

### 5.1 完整请求处理链

```
client POST /v1/llm/messages
   │ body: LLMMessagesRequest
   ▼
fastapi 路由 routes.llm_messages
   │
   ├─ middleware.rate_limit       # slowapi 30/min/IP
   ├─ middleware.body_size_check  # < 100KB
   ├─ middleware.user_tier        # IP / BYOK identify
   ├─ middleware.quota            # root_session = session_id.split("/sub")[0]
   │                                当日该 IP 首次见到此 root_session → 扣 1 session 配额
   │                                续轮 (messages.length > 1) / 嵌套子流 (session_id 带 /sub-) → 不扣
   ├─ middleware.tool_whitelist:
   │      校验 request.tools 全部 .name in canonical_registry
   │      不匹配 → return 403 tool_not_whitelisted
   ├─ middleware.intent_gate:
   │      若是 first turn (messages.length == 1):
   │          request.system = [
   │              SystemBlock(text=INTENT_GATE_PROMPT, cache_control=None),
   │              *request.system,
   │          ]
   │      （client 完全不见 INTENT_GATE_PROMPT）
   ├─ middleware.fast_path（可选）：
   │      若 request.messages[0].content 命中硬负向匹配 → return 403 abuse_detected
   ├─ 调 Anthropic Messages API (stream=true):
   │      async with anthropic.messages.stream(**request.model_dump()) as stream:
   │          async for event in stream:
   │              yield f"event: {event.type}\ndata: {json.dumps(event.model_dump())}\n\n"
   ├─ middleware.abuse_counter:
   │      偷看流的第一个 content_block_delta：
   │          若 text 以 "<not_hardware>" 开头 → 当日 IP abuse counter += 1
   │          当 counter >= 3 → 触发当日配额清零
   │      流继续转发不打断
   └─ 流结束（client 见到 message_stop 或断开）
```

### 5.2 Intent Gate Prompt 文本（server 端常量）

```python
INTENT_GATE_PROMPT = """
INTENT GATE (only applies on this first turn):

You are about to help a user with a MicroPython hardware project. Before
proceeding, you must verify their intent is in scope.

In scope: MicroPython on a physical microcontroller board (ESP32 family,
RP2040, STM32, etc.) involving sensors, LEDs, motors, buttons, or similar
peripherals. Code generation, wiring guidance, debugging.

Out of scope: general web development, scraping, email automation, SQL,
translation, writing prose, data analysis, anything not involving a
physical microcontroller.

If the user's intent is OUT OF SCOPE, your FIRST output token must be
the literal string "<not_hardware>" followed by a brief reason in the
user's language, then "</not_hardware>", then STOP. Do not call any tool.

If the user's intent is IN SCOPE, proceed normally — do not mention this
gate, just begin your normal agent reasoning.
"""
```

**嵌套 SSE 调用的处理**（V3.1.2 澄清）：

`/v1/llm/messages` middleware **在 intent gate 上**不区分主流和嵌套子流。**任何 `messages.length == 1` 的请求**都会注入 intent gate。这意味着 client 在嵌套调用（如 `generate_code` 子流、git commit msg 子流）里发的 user message 必须用**明显硬件措辞**让 LLM 一眼判断是硬件 context，否则 LLM 会拒绝。

**为什么 intent gate 对子流也注入（不按 root session 跳过）**：intent gate 是不可绕的安全边界。若让 `/sub-` 后缀跳过 gate，攻击者只需把主流请求的 `session_id` 伪造成 `xxx/sub-evil` 就能绕过滥用拦截、借我们的 token 干非硬件活。所以 gate 认 `messages.length == 1`（子流照样注入），用"硬件措辞"对冲子流自我拒绝。

**与配额的区别**：配额**按 root session 去重**（见 §6.3），子流**不扣**费；intent gate **不去重**，每个 `messages.length == 1`（含子流）都注入。两者用不同的判定，互不影响。

正确写法示例（client 端）：

```typescript
// generate_code 嵌套
{role: "user", content: "Generate MicroPython main.py for ESP32-S3 with this manifest:\n..."}

// git commit msg 嵌套
{role: "user", content: "Generate a conventional commit message for this MicroPython project change:\n<diff>"}
```

**不**要写"please write some code"或"summarize this"这种 ambiguous 措辞——会触发 intent gate self-reject。

**这段文本只存在 server 端 Python 常量**。Client 永远不会见到，无法 reverse engineer 删除（即使把扩展整个反编译）。

### 5.3 Tool 白名单校验细节

```python
# canonical_tools.json 列 14 个 tool 的 name
CANONICAL_TOOL_NAMES = {
    "query_board_profile", "search_packages", "resolve_package_candidates",
    "get_package_context",
    "propose_manifest", "generate_code", "audit_code", "load_skill",
    "ask_user", "scan_device", "install_package", "flash_and_run",
    "read_serial_until", "write_main_py",
}
# v0.2 = 14 个；v0.3 计划加 generate_test
# git_commit 不在白名单 —— git 是 ext-internal hook，不让 LLM 主动调

async def tool_whitelist_middleware(req: LLMMessagesRequest):
    if not req.tools:
        return  # 没传就不管
    bad = [t.name for t in req.tools if t.name not in CANONICAL_TOOL_NAMES]
    if bad:
        raise HTTPException(403, {"error": "tool_not_whitelisted", "rejected": bad})
```

校验**只看 name**（不校验 schema body，避免误伤合法 schema 微调），但这已经足够防"客户端塞 `web_search` 让 LLM 帮我爬网页"这种攻击。

### 5.4 Abuse Counter 处理 SSE 边偷看边转发

挑战：`abuse_counter` 要看 SSE 第一个文本 token，但又不能阻塞流。

实现：用 `anyio.create_task_group` 或类似，在转发流的同时 fork 一份给 counter peeker。Peeker 仅消费前 N（比如 50）个字节判断是否 `<not_hardware>`，命中则触发 counter 增加，**不打断**主流（即使是 not_hardware，也让 client 看完它再决定）。

```python
async def stream_with_abuse_peek(anthropic_stream, ip_hash: str):
    peeked = ""
    async for event in anthropic_stream:
        if event.type == "content_block_delta" and event.delta.type == "text_delta":
            if len(peeked) < 50:
                peeked += event.delta.text
                if peeked.startswith("<not_hardware>"):
                    await abuse_counter.increment(ip_hash)
        yield event
```

---

## 6. 用户配额机制

### 6.1 用户层级

| 层级 | 识别方式 | 每日 session 上限 |
|---|---|---|
| 匿名 | IP 哈希 | 5 |
| 注册（v0.3） | GitHub OAuth + JWT | 20 |
| BYOK | 请求带 `byok_key` 且非空 | 无限 |

### 6.2 存储

- v0.2：Redis（Fly Redis addon）
- v0.3：迁 SQLite 或 PostgreSQL（如果上注册系统）

### 6.3 配额扣减规则

- 配额按 **root session** 去重：`root_session = session_id.split("/sub")[0]`
- 当日某 IP **首次**见到一个 root_session → 扣 1 个 session 配额（Redis 实现：`SADD quota:seen:{ip}:{date} {root_session}` 返回 1 才 `INCR` 计数）
- 同 session 的后续轮（`messages.length > 1`，同 root_session）→ 不扣
- **嵌套子流**（`generate_code` 子流、git commit msg 子流，session_id 带 `/sub-` 后缀）→ root_session 已计过 → **不扣**
- BYOK 不扣（但仍走 middleware）
- abuse counter 触发当日配额清零

> **修正（vs 旧设计）**：旧版按 `messages.length == 1` 扣费，但嵌套子流的 `messages` 也是全新数组（length==1），会被误判成新 session——单次完整 demo（主流首轮 + generate_code 子流 + git commit 子流）会被扣 **3 次**配额，匿名用户日限 5 跑一次就掉 3。改为按 root session 去重后，一次 demo 只扣 1 次。intent gate 不受此影响（见 §5.2：它仍对每个 `messages.length == 1` 注入，含子流，是不可绕的安全边界）。

### 6.4 滥用惩罚

| 触发 | 行动 |
|---|---|
| 当日 IP 触发 abuse_counter ≥ 3 次（即 LLM 输出 `<not_hardware>` ≥ 3 次） | 当日剩余额度清零；返回 429 |
| 单 request 体 > 100KB | 返回 413（防止把巨型 context 灌进来撑爆） |
| 1 分钟内 > 30 次请求 | rate limit 返回 429（slowapi 配置） |

---

## 7. Skill 库与 Content 托管

### 7.1 Skill 文件管理

Server 端 `content/skills/` 目录是单一来源。每次部署时 server 计算所有 skill 文件的 sha256，构造 `SkillCatalogResponse.version`。Client 启动时拉 `/v1/skills`，存到 workspace state；后续每次会话开始前发 `If-None-Match: <version>` → 304 直接用 cache，否则重拉。

### 7.2 Foundational skill 例外

为了离线降级 + 减少首次启动延迟，**Foundational skill 的 body 直接打包到扩展**（VS Code 扩展资产）。这意味着 server 改 foundational skill 需要发新扩展版本。**这是有意的权衡**：
- Foundational skill（agent_identity / safety_boundaries / tool_use_protocol）改动频率极低（~1 次/季度）
- 客户端启动就能用 agent，不依赖网络
- v0.3 评估改为在线拉取 + override 机制

Task / Recovery skill 始终在线拉取 + 缓存（这些迭代快）。

### 7.3 Tool registry 同步问题

Client 启动 → `GET /v1/tools` → 比对客户端打包的 schema → 如果版本不同，**警告用户但仍允许使用**（避免 server 加新 tool 时旧客户端完全失效）。

具体：发 `/v1/llm/messages` 时，client 只用自己打包的 tool schema（不会用从 server 拉的新 schema 调老的 handler）。Server 的 `GET /v1/tools` 主要给客户端做"我是不是该升级"的提示。

### 7.4 Package Intelligence 细节

- HTTP client：`httpx`
- 上游来源：uPyPi search/package.json、GraftSense driver repo 的 `package.json` / README / examples、curated verified recipes
- canonical ownership：`mpyhw-api/app/package_store.py` 是 search/resolve/driver-context 的唯一运行时实现；客户端只保留 thin HTTP client 和 typed response parsing
- ingestion model：外部来源先归一化成 package index + driver-context records，再供 endpoint 查询；请求 handler 不直接访问外部网络
- 缓存：Redis（key = `pkg:search:{sha256(query)}` / `pkg:meta:{name}:{version}` / `pkg:ctx:{name}:{version}`）
- TTL：search/resolve 1 小时；metadata/readme/driver-context 24 小时
- 失败时不缓存（不存负结果）
- 上游错误不直接泄露给 LLM；统一成 `{status:"error", error_kind:"upstream_unavailable" | "package_not_found" | "driver_context_missing"}`
- v0.2 要求：
  - package index 能覆盖 uPyPi + GraftSense 已公开包，而不是只列 demo 硬件
  - 每个包至少有 `discoverable` support level；metadata/mip URL 完整则升到 `installable`
  - README/examples 能抽取 import/API/bus/pin_roles 则升到 `generatable`
  - `verified` 必须同时满足：driver context 有 evidence_refs，contract test 证明 import/constructor/read method 或 property 与真实包一致，且 golden path 真机/可靠 CI 跑通过
  - driver context 不足时，agent 必须 ask_user 或降级为 experimental，不允许凭空编驱动 API

Driver-context contract tests 是 Package Intelligence 的发布门禁：任何记录若标为 `verified`，必须能追溯到 package.json、README/example/source 或 hardware smoke evidence；否则只能是 `generatable` 或更低等级。

---

## 8. LLM 调用细节

- **Provider**：Anthropic Claude Sonnet 4.6（`claude-sonnet-4-6`）
- **Model 升级策略**：服务端环境变量 `LLM_MODEL_ID`，可灰度切版本；客户端发的 `model` 字段被 server 覆盖
- **Prompt cache**：客户端在 `system` 数组里加 `cache_control: ephemeral`，server 透传。Anthropic 自动 cache hit 计费
- **Streaming**：v0.2 强制 `stream=true`（删除 V2 的"v0.2 不流式"决策）
- **Temperature**：默认 0.1（hardware 场景要稳定）；客户端可覆盖
- **Max tokens**：默认 4096

---

## 9. 部署

### 9.1 平台

- v0.2：**Fly.io** single region（hkg / sin / nrt 选离亚太用户最近的）
- 备选：Railway / Render
- SSE 在 Fly.io / Cloudflare / Render 都默认支持，无需特殊配置
- 不选 AWS / GCP（小项目过度配置成本）

### 9.2 Secrets

- `ANTHROPIC_API_KEY` —— 平台 Secret Manager
- `SENTRY_DSN` —— 同上
- `REDIS_URL` —— Fly Redis addon

### 9.3 监控

- **Sentry**：所有 5xx + 关键业务事件（not_hardware_detected、quota_exceeded、tool_not_whitelisted_attempts）
- **自建 dashboard**（v0.2 用 fly metrics）：
  - 每日总 `/v1/llm/messages` 请求数（首轮 + 续轮分开）
  - SSE 流平均时长 p50 / p99
  - 平均 tokens / request（input、output、cache_read）
  - not_hardware 拒绝比例
  - 模型成本估算
  - 各 content endpoint 缓存命中率

---

## 10. 安全

| 项 | 配置 |
|---|---|
| CORS | `Access-Control-Allow-Origin` 限定到 VS Code Extension 的 origin（`vscode-webview://*`）+ 开发环境 `localhost:*` |
| TLS | Fly 自动 LetsEncrypt |
| Rate limit | slowapi: 30/min/IP, 200/hour/IP |
| 请求体大小 | 100KB 上限（防 context 注入大数据） |
| User-Agent 检查 | 必须含 `mpyhw-vscode/x.y.z`；其他 client 默认拒绝（v0.3 出 SDK 后开放） |
| 日志 | 仅 log `session_id` + `trace_id` + 元数据；**不 log** 用户代码、不 log 完整 messages（仅 sha256） |
| Intent gate 文本不下发 | 仅在 server 端 Python 常量；client 永不见 |
| Tool 白名单不可绕 | middleware 校验在 LLM call 之前；schema 不在 canonical 直接 403 |

---

## 11. 数据流（一次完整 session，含嵌套 generate_code）

```
=== 用户输入 "超过 30 度亮红灯" ===

[client] context_builder 组装 system + tools
[client] POST /v1/llm/messages stream=true
   │ body: {model, messages:[{role:"user",content:"..."}], system:[...], tools:[14 项]}
   ▼
[api middleware chain] tool whitelist OK → intent_gate inject → fast_path miss
[api → anthropic] stream
[anthropic → api → client] SSE 事件流：
   message_start
   content_block_start {type:"text"}
   content_block_delta "我先查"
   content_block_delta "板子配置"
   content_block_stop
   content_block_start {type:"tool_use", name:"query_board_profile"}
   content_block_delta input_json
   content_block_stop
   message_delta stop_reason="tool_use"
   message_stop

[client] 看到 tool_use → 本地 dispatch query_board_profile（查 cached board profile）→ obs
[client] messages 加 [assistant, tool result]
[client] POST /v1/llm/messages stream=true（同一 session，继续）
   ▼
[api] middleware tool whitelist OK → 不再注入 intent gate（messages.length > 1）
[anthropic → api → client] SSE 继续

... 几轮后 ...

[client] 收到 tool_use: generate_code
[client] === 嵌套 SSE 子流 ===
[client] POST /v1/llm/messages stream=true
   │ body: {messages:[{role:"user", content:"<生成 main.py 的指令>"}],
   │        system:[code_generation_guide skill body], tools:[]}
   ▼
[api] middleware 仍然校验 tool 白名单（这里 tools 空, 通过）
[api] 仍然注入 intent gate（这是新 session 视角，messages.length == 1）
       — 但 LLM 收到的是「我在生成代码」的明显硬件 intent，不会触发 not_hardware
[anthropic → api → client] SSE 流出 main.py 代码 token
[client] 拼接完整代码 → 子流结束 → 主流继续

[client] 本地 audit_code → passed
[client] 主流继续；tool_use: scan_device → 本地调 python/shim/ → obs
[client] tool_use: flash_and_run → 弹 confirm → 调 shim → obs
[client] tool_use: read_serial_until → shim 读串口 → obs

... 最终 LLM 输出 final_answer (没有 tool_use, stop_reason="end_turn") ...

[client] session_done; UI 显示 ✓ 完成
[client] POST /v1/telemetry 推全 trace
```

---

## 12. 验收语句

- `POST /v1/llm/messages`（合法 hardware intent，messages.length=1）→ 200 SSE 流，第一个 text block 不以 `<not_hardware>` 开头
- `POST /v1/llm/messages`（"帮我写爬虫" intent）→ 200 SSE 流，第一个 text block 以 `<not_hardware>` 开头；abuse counter +1
- 同 IP 一日 3 次 not_hardware 触发 → 第 4 次 `/v1/llm/messages` 返回 429
- `POST /v1/llm/messages` tools 含 `{name: "web_search"}` → 返回 403 `tool_not_whitelisted`
- 同 IP 一日启动 6 个不同 session（6 个不同 root session_id 各自首轮）→ 第 6 个返回 429 quota_exceeded
- 一次 session 内的 `generate_code` / git commit 嵌套子流（session_id 带 `/sub-`）→ **不**额外扣配额；一次完整 demo（含两个子流）只扣 1 次 session 配额
- BYOK 用户跑 100 个 session → 全部成功，无 429
- 请求 body 200KB → 返回 413
- 1 分钟内 31 次请求同 IP → 第 31 次返回 429 rate_limit
- `GET /v1/skills` → 返回完整 catalog；If-None-Match 命中 → 304
- `GET /v1/boards/esp32-s3-devkitc-1` → 返回完整 board profile JSON
- `GET /v1/tools` → 返回 14 个 canonical tool 的 schema
- `GET /v1/packages/index` → 返回 uPyPi + GraftSense 聚合索引版本、来源计数、support_level_counts
- `POST /v1/packages/search query="temperature humidity i2c"` → 返回候选包 results（含 `support_level`、`score`、`reason`）；二次同请求 `cached: true`
- `POST /v1/packages/resolve`（intent + capabilities + board）→ 返回排序候选；无高置信候选时 `needs_user_choice: true`
- `GET /v1/packages/ds18b20_driver/1.0.0` → 返回的 JSON 含 `license`、`author`、`chips`（字符串）、`fw`（字符串）、`deps`（数组，可空）、`urls`（双元素数组）、`support_level`
- `GET /v1/packages/ds18b20_driver/1.0.0/driver-context` → 返回 import/API/bus/install/known_issues/confidence；缺失时返回 `driver_context_missing`
- `POST /v1/telemetry` 推 10 个 event → 204
- `GET /v1/quota` → 返回当前用户层级 + 已用 + 上限
- Client 完全 patch 掉打包的扩展代码（reverse engineer）后仍然**无法**让 mpyhw-api 跳过 intent gate（因为是 server 注入）
- Client 把 `tools` 改成 `[{name:"exec_arbitrary"}]` 发到 `/v1/llm/messages` → 403（无法借我们 token 跑非硬件 LLM call）
- 嵌套 SSE 调用（用户 message 含明显硬件措辞如 "Generate MicroPython main.py..."）→ 不触发 not_hardware 自我拒绝
- 嵌套 SSE 调用 system 含 skill body + cache_control → Anthropic prompt cache hit 在 `usage.cache_read_input_tokens` 显示

---

## 13. 不做的事

- 不存代码 / 不存完整 messages（仅 sha256 hash 用于去重）
- 不做 LLM 响应缓存（每轮独立，避免缓存导致旧错误持续）
- 不在 v0.2 做用户注册（v0.3 加 GitHub OAuth）
- 不在 v0.2 做多模型切换（服务端固定 Sonnet 4.6）
- 不暴露内部 Anthropic API key 给任何 client
- 不跑任何 agent 逻辑（agent loop 全在客户端 TS）
- 不持有 manifest schema / validator（搬客户端）
- 不直接连用户硬件（蜘蛛网模型：mpyhw-api ↔ mpyhw-vscode ↔ python/shim ↔ 板子，每跳明确）
- 不实现 WebSocket（SSE 够用）

---

## 14. 文档导航

- 整体架构：[`00-architecture-overview.md`](00-architecture-overview.md)
- VS Code + Agent loop + Shim 详细实现：[`03-mpyhw-vscode-spec.md`](03-mpyhw-vscode-spec.md)
- Agent 怎么思考、tool 怎么调、context 怎么管：[`04-coding-harness-design.md`](04-coding-harness-design.md)
