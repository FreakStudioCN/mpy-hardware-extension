# 嵌入式工程师如何编写 Skill 接口文档并交付插件工程师

## 1. 背景和目标

当前产品要解决的是“一句话造硬件”：用户用自然语言描述一个硬件项目，系统自动完成需求解析、器件确认、驱动搜索、项目骨架、代码生成、仿真、烧录、调试修复、接线图、架构图，以及冷门硬件驱动生成和 upypi 发布。

用户现在遇到的问题主要是：

- 生成流程中途断掉，比如分析完器件后没有后续动作，只能从头重启。
- 冷门硬件没有现成驱动时，流程跳过、报错或停止。
- 代码生成后跑不起来，但用户不知道是哪一步错了。
- 用户上传 PDF 数据手册或 Arduino 参考代码后，系统不知道如何利用。
- 驱动写完后缺少打包、README、package.json、发布到 upypi 的收尾步骤。
- 整个流程缺少中间确认点和断点恢复，失败后不知道从哪里继续。

你们新的架构方向是正确的：

```text
服务器端 LLM + 完整 SKILL.md
        负责业务判断、流程决策、代码生成、错误分析

VS Code 插件
        只负责 UI 渲染、本地文件读写、本地脚本执行、mpremote 设备命令透传
```

也就是说，插件工程师不需要懂 MicroPython、驱动、总线协议、寄存器、调试循环；嵌入式工程师不需要懂 VS Code WebView、SSE、前端组件细节。双方通过一层稳定协议协作。

这层协议就是你要交付的核心。

## 2. 先理解几个基础概念

### Skill 是什么

Skill 可以理解为“给服务器端 LLM 的专家操作手册”。它通常由两部分组成：

```text
SKILL.md
    说明 LLM 应该怎么做、按什么步骤做、遇到分支怎么判断、输出什么产物。

scripts/
    放确定性脚本，比如 PDF 文本提取、JSON Schema 校验、项目骨架生成、静态检查、设备运行脚本。
```

嵌入式工程师主要维护 SKILL.md 和 scripts。插件工程师不应该直接阅读 SKILL.md 来猜 UI，而应该看你写好的接口文档。

### Phase 是什么

Phase 是整个硬件生成流水线中的一个阶段。

例如：

```text
analyze      需求解析 + 器件确认 + 驱动搜索
select-hw    MCU 选型 + 引脚分配 + BOM
scaffold     项目骨架生成
generate     业务代码生成
simulate     PC 端模拟验证
deploy       上传和运行
autofix      错误分级和修复
wiring       接线图生成
diagram      架构图生成
gen-driver   冷门硬件驱动生成
publish      驱动打包和发布到 upypi
```

每个 Phase 都应该有明确输入、明确输出、明确 UI 确认点、明确失败处理、明确能否恢复。

### Manifest 是什么

Manifest 是阶段之间传递状态的项目清单，建议统一叫：

```text
project-manifest.json
```

它是流水线的事实来源。上游 Phase 写自己负责的字段，下游 Phase 继续读取并补充。

例如：

```json
{
  "schema_version": "1.0",
  "phase": "analyze",
  "project_name": "温湿度监测报警器",
  "requirements": {
    "description": "定时采集温湿度，超过阈值蜂鸣器报警"
  },
  "devices": [
    {
      "name": "SHT30",
      "type": "temperature_humidity_sensor",
      "interface": "I2C",
      "source": "user_specified",
      "driver": {
        "source": "none",
        "status": "cold_driver_required"
      }
    }
  ]
}
```

Manifest 必须能解释“现在做到哪一步”“哪些器件已经确认”“哪些驱动缺失”“下一步该做什么”。

### 插件协议是什么

插件协议是服务器/Skill 和 VS Code 插件之间交换的结构化消息。

服务器发给插件：

```text
status_update      展示进度
approval_request   请求用户确认
file_operation     读写本地文件
script_run         执行本地脚本
device_command     执行 mpremote/设备命令
stream             实时输出流
phase_complete     阶段完成或部分完成
```

插件发回服务器：

```text
approval_response  用户确认结果
file_result        文件读写结果
script_result      脚本执行结果
device_result      设备命令结果
stream_ack         流式输出确认
user_intervention  用户在排查中途的干预
error_lib_update   错误库更新
start_phase        启动某个 phase
```

你写接口文档时，不要写“这里问用户一下”“这里执行脚本”。要写成具体消息。

## 3. 当前最重要的架构建议

不要一上来就把所有东西接到远程服务器。

推荐顺序是：

```text
第 1 步：先把 Skill 逻辑在本机跑通
第 2 步：把 Skill 的本地 I/O 改成协议消息
第 3 步：用 mock_plugin.py 模拟插件，本机验证消息序列
第 4 步：把接口文档、mock 消息、测试记录交给插件工程师
第 5 步：插件工程师用 mock 消息独立开发 UI 和本地执行器
第 6 步：双方本地联调
第 7 步：最后再把 PhaseRunner 放到服务器
```

这样能把问题拆开：

```text
Skill 逻辑错了？
    本机 Phase A 就能发现。

Skill 和插件协议不一致？
    mock_plugin.py 和 mock-messages 就能发现。

服务器和客户端通信有问题？
    前两步都通过后再查，不会混在业务逻辑里。
```

## 4. 你作为嵌入式工程师的工作边界

你负责：

- 定义每个 Phase 的业务流程。
- 修改 SKILL.md，使 LLM 知道该怎么做。
- 定义本 Phase 的输入、输出、确认点、失败路径、恢复点。
- 定义需要插件执行的文件操作、脚本、设备命令。
- 提供 mock 消息，供插件工程师不连服务器也能开发。
- 本机验证 Skill 逻辑和协议输出。

你不负责：

- 实现 VS Code WebView。
- 实现前端按钮样式。
- 实现 SSE/HTTP 底层通信。
- 在插件里写 MicroPython 业务判断。
- 让插件解析设备日志含义。

插件工程师负责：

- 收到 `approval_request` 后渲染卡片。
- 收到 `status_update` 后渲染时间线。
- 收到 `file_operation` 后读写本地文件。
- 收到 `script_run` 后执行白名单脚本。
- 收到 `device_command` 后调用 mpremote 或设备 shim。
- 收到 `phase_complete` 后展示结果、触发 next_phase。
- 把用户操作和本地执行结果按协议发回来。

## 5. 每个 Skill 接口文档应该怎么写

建议每个 Phase 都写一个接口文档，例如：

```text
plugin-interface/skills/upy-analyze.md
plugin-interface/skills/upy-gen-driver.md
plugin-interface/skills/upy-publish.md
```

每份文档必须包含以下 8 部分。

### 5.1 Skill 概述

写清楚：

```text
Phase 名称：
上游 Skill：
下游 Skill：
一句话职责：
核心约束：
```

示例：

```markdown
## 一、Skill 概述

| 项目 | 内容 |
|------|------|
| Phase | gen-driver |
| 上游 Skill | analyze / autofix / 用户手动触发 |
| 下游 Skill | generate / publish / 无 |
| 一句话职责 | 从 PDF、Arduino 代码、GitHub URL 或芯片型号生成规范化 MicroPython 驱动 |

核心约束：
- 没有 SELF_TEST_PASS 前，不允许进入生产版驱动。
- 无设备时必须输出 partial checkpoint，不允许直接丢失进度。
- PDF/Arduino 只由脚本提取结构，真正理解由 LLM 完成。
```

### 5.2 插件输入到 Skill

写插件启动这个 Phase 时要传什么。

示例：

```json
{
  "type": "start_phase",
  "phase": "gen-driver",
  "session_id": "uuid-xxx",
  "payload": {
    "manifest": {},
    "source": {
      "type": "pdf",
      "files": [
        {
          "name": "sht30_datasheet.pdf",
          "mime_type": "application/pdf",
          "size": 245760,
          "local_path": "uploads/sht30_datasheet.pdf",
          "content": "extracted text..."
        }
      ],
      "chip_model": "SHT30"
    }
  }
}
```

同时用表格说明字段：

```markdown
| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| manifest | object | 否 | 上游 phase | 已有项目清单 |
| source.type | string | 否 | 文件上传卡片 | pdf / arduino / image / github_url / chip_model |
| source.files[].local_path | string | 否 | 插件本地文件 | 供 script_run 使用 |
| source.files[].content | string | 否 | 预处理脚本 | PDF/Arduino 提取后的文本 |
```

### 5.3 Skill 输出到插件的消息序列

这是最关键的部分。要按步骤写清楚会发哪些消息。

示例：

```text
Step 0 输入材料判断
  -> approval_request(gen_driver_input)

Step 1 PDF 预处理
  -> status_update(extract_pdf)
  -> script_run(extract_pdf.py)
  <- script_result
  -> file_operation(read docs/driver_extracted.json)
  <- file_result
  -> status_update(analyze_chip)

Step 2 生成调试版驱动
  -> file_operation(write firmware/drivers/sht30_driver/sht30_debug.py)
  -> status_update(gen_debug_done)

Step 3 硬件验证循环
  -> device_command(devs)
  <- device_result
  -> script_run(run_on_device.py)
  <- script_result
  -> file_operation(read logs/driver_verify_round1.log)
  <- file_result
  -> status_update(hw_result_pass 或 hw_result_fail)

Step 4 阶段完成
  -> phase_complete(result=success 或 partial)
```

插件工程师最需要看的就是这部分。

### 5.4 approval_request 卡片设计

凡是需要用户确认的地方，都写成结构化卡片。

不要只写：

```text
询问用户是否继续。
```

要写：

```json
{
  "type": "approval_request",
  "payload": {
    "approval_id": "gen_driver_no_device",
    "header": "未检测到 MicroPython 设备",
    "question": "硬件验证需要连接设备，请选择：",
    "items": [
      {
        "id": "retry",
        "name": "重新检测",
        "subtitle": "我已连接设备",
        "selected": true
      },
      {
        "id": "skip",
        "name": "跳过硬件验证",
        "subtitle": "生成未经测试的驱动",
        "meta": "不推荐，最终输出会标注未经硬件验证"
      },
      {
        "id": "save",
        "name": "稍后继续",
        "subtitle": "保存当前进度，稍后从此处恢复"
      }
    ],
    "multi_select": false,
    "actions": [
      { "label": "确认", "value": "confirm", "primary": true }
    ]
  }
}
```

同时说明每个选项对流程的影响：

```markdown
| 用户选择 | Skill 行为 |
|----------|------------|
| retry | 回到 device_command(devs) |
| skip | 继续生成生产版，但 warnings 标注未硬件验证 |
| save | phase_complete(result=partial, checkpoint_id=...) |
```

### 5.5 status_update 列表

插件要靠它显示进度。你必须列出所有进度消息。

示例：

```markdown
| step_id | level | message | 触发时机 |
|---------|-------|---------|----------|
| extract_pdf | info | 正在提取 PDF 文本... | PDF 预处理开始 |
| extract_done | success | 已提取 42 页文本 | PDF 预处理完成 |
| gen_debug | info | 正在生成调试版驱动... | 生成前 |
| hw_run | info | 正在设备上运行验证，第 1/10 轮... | 每轮验证 |
| hw_result_fail | warn | 第 1 轮失败：I2C 读回 0xFF，正在修复... | 每轮失败 |
| hw_result_pass | success | 第 3 轮通过：SELF_TEST_PASS | 验证通过 |
```

注意：`level` 建议只用：

```text
info / warn / error / success
```

不要一会儿写 `danger`，一会儿写 `failed`。否则插件工程师要写兼容逻辑。

### 5.6 文件、脚本、设备命令

凡是需要本地执行的动作，都要写清楚消息格式。

文件写入示例：

```json
{
  "type": "file_operation",
  "payload": {
    "op_id": "write_debug_driver",
    "op": "write",
    "path": "firmware/drivers/sht30_driver/sht30_debug.py",
    "content": "...",
    "encoding": "utf-8"
  }
}
```

脚本执行示例：

```json
{
  "type": "script_run",
  "payload": {
    "script_id": "extract_pdf",
    "interpreter": "python",
    "script": ".upy/scripts/extract_pdf.py",
    "args": [
      "--input",
      "uploads/sht30_datasheet.pdf",
      "--output",
      "docs/driver_extracted.json",
      "--json-summary"
    ],
    "cwd": "{project_dir}",
    "timeout_ms": 30000
  }
}
```

设备命令示例：

```json
{
  "type": "device_command",
  "payload": {
    "cmd_id": "scan_i2c",
    "action": "exec",
    "code": "from machine import I2C, Pin\ni2c=I2C(0)\nprint(i2c.scan())",
    "timeout_ms": 5000,
    "expect_output": true
  }
}
```

安全建议：不要让服务器随便发任意 shell 命令。插件侧应只执行白名单脚本，例如：

```text
extract_pdf.py
convert_arduino.py
init_manifest.py
run_on_device.py
pack_driver.py
flash_device.py
render_wiring_local.py
render_diagram_local.py
```

### 5.7 phase_complete

每个 Phase 都必须以 `phase_complete` 收尾，即使是失败或部分完成。

成功示例：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "gen-driver",
    "result": "success",
    "summary": "SHT30 驱动生成完成，硬件验证第 3 轮通过，独立测试脚本已生成",
    "next_phase": "publish",
    "manifest_content": {},
    "artifacts": [
      {
        "type": "file_list",
        "title": "生成文件",
        "files": [
          {
            "path": "firmware/drivers/sht30_driver/sht30.py",
            "size": 4096,
            "status": "new",
            "description": "生产版驱动"
          }
        ]
      }
    ],
    "warnings": [],
    "errors": []
  }
}
```

中断可恢复示例：

```json
{
  "type": "phase_complete",
  "payload": {
    "phase": "gen-driver",
    "result": "partial",
    "summary": "调试版驱动已生成，但未检测到设备，已保存进度",
    "next_phase": null,
    "checkpoint": {
      "checkpoint_id": "gen-driver:sht30:after-debug-driver",
      "resume_phase": "gen-driver",
      "resume_step": "hardware_verify",
      "resume_label": "继续 SHT30 硬件验证"
    },
    "artifacts": [
      {
        "type": "file_list",
        "title": "已生成文件",
        "files": [
          {
            "path": "firmware/drivers/sht30_driver/sht30_debug.py",
            "status": "new"
          }
        ]
      }
    ],
    "warnings": [
      "未进行硬件验证，不能发布为已验证驱动"
    ],
    "errors": []
  }
}
```

重点：失败也要有结构化输出，不能只抛异常。

### 5.8 独立测试场景

每个接口文档最后都要写测试场景。

插件端测试：

```markdown
1. 发送 approval_request(gen_driver_input)，验证文件上传卡片。
2. 发送 status_update 序列，验证进度时间线。
3. 发送 script_run(extract_pdf.py)，验证插件能执行并回传 script_result。
4. 发送 phase_complete(result=partial)，验证出现“继续验证”按钮。
5. 发送 phase_complete(next_phase="publish")，验证自动进入 publish。
```

Skill 端测试：

```markdown
1. mock source.type=pdf，验证能生成 understanding.json。
2. mock device_command(devs) 返回空，验证输出 partial checkpoint。
3. mock 第 3 轮 SELF_TEST_PASS，验证进入生产版驱动。
4. mock 10 轮全部失败，验证 result=partial 且 errors 有排查方向。
5. 检查所有消息符合协议 schema。
```

## 6. 修改 SKILL.md 的推荐方法

不要把“业务逻辑改动”和“插件通信改动”混在一起。

### Phase A：先改业务逻辑，本机直接跑

目标：确认嵌入式流程本身是对的。

这一步可以继续使用本地工具：

```text
Read
Write
Edit
Bash
AskUserQuestion
```

你要验证：

- 步骤顺序是否正确。
- 冷门硬件是否进入 gen-driver，而不是直接失败。
- PDF/Arduino 是否能提取出有用信息。
- 生成的驱动是否有调试版、生产版、独立测试脚本、接线参考。
- deploy 失败后是否有错误分级和排查建议。
- publish 是否生成 README、package.json、LICENSE、标准目录结构。

本机跑通后再进入 Phase B。

### Phase B：把本地 I/O 机械翻译成协议消息

把 SKILL.md 里的本地动作替换成协议动作。

映射表：

```text
Read(file)
    -> file_operation(read)

Write(file, content)
    -> file_operation(write)

Edit(file)
    -> file_operation(read) + LLM 修改 + file_operation(write)

Bash(python xxx.py ...)
    -> script_run(interpreter="python", script="xxx.py", args=[...])

Bash(mpremote ...)
    -> device_command(...)

AskUserQuestion(...)
    -> approval_request(...)

最终输出
    -> phase_complete(...)
```

这一步不应该再改变业务流程，只改 I/O 表达方式。

## 7. 本机测试怎么做

建议为每个 Phase 准备一个 `mock_plugin.py`，模拟插件行为。

它做的事情很简单：

```text
收到 approval_request
    自动返回 approval_response

收到 file_operation
    在本地临时目录读写文件，然后返回 file_result

收到 script_run
    执行白名单脚本或返回预设结果

收到 device_command
    返回预设设备输出，例如 I2C scan = [68]

收到 phase_complete
    打印结果并结束
```

示例伪代码：

```python
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    msg_type = msg["type"]
    payload = msg.get("payload", {})

    if msg_type == "approval_request":
        print(json.dumps({
            "type": "approval_response",
            "payload": {
                "approval_id": payload["approval_id"],
                "action": "confirm",
                "selected_ids": [item["id"] for item in payload.get("items", []) if item.get("selected")]
            }
        }, ensure_ascii=False))

    elif msg_type == "device_command":
        print(json.dumps({
            "type": "device_result",
            "payload": {
                "cmd_id": payload["cmd_id"],
                "success": True,
                "stdout": "[68]\n",
                "stderr": "",
                "exit_code": 0
            }
        }, ensure_ascii=False))

    elif msg_type == "script_run":
        print(json.dumps({
            "type": "script_result",
            "payload": {
                "script_id": payload["script_id"],
                "success": True,
                "stdout": "{\"status\":\"ok\"}",
                "stderr": "",
                "exit_code": 0
            }
        }, ensure_ascii=False))

    elif msg_type == "phase_complete":
        print("[PHASE COMPLETE]", payload.get("result"), payload.get("summary"))
```

本机验收标准：

```text
1. 完整 happy path 能走通。
2. 无设备路径能输出 partial，而不是崩溃。
3. 冷门硬件路径能进入 gen-driver。
4. PDF/Arduino 输入能产生中间文件和驱动草稿。
5. 每个 phase_complete 都有 result、summary、artifacts、warnings、errors。
6. 所有消息都能被 JSON schema 校验。
7. 所有本地脚本都有 --json-summary，方便插件回传结构化结果。
```

## 8. 交付给插件工程师时应该给什么

不要只把 SKILL.md 丢给插件工程师。

每个 Phase 交付一个包：

```text
1. 接口文档
   plugin-interface/skills/upy-gen-driver.md

2. mock 消息
   mock-messages/gen-driver/input-request.json
   mock-messages/gen-driver/no-device-partial.json
   mock-messages/gen-driver/hardware-pass.json
   mock-messages/gen-driver/next-step-publish.json

3. 白名单脚本说明
   scripts/extract_pdf.py
   scripts/convert_arduino.py
   scripts/run_on_device.py

4. 输入输出样例
   sample/start_phase.json
   sample/project-manifest.before.json
   sample/project-manifest.after.json

5. 本机测试记录
   happy path 通过
   no device partial 通过
   PDF 输入通过
   10 轮失败 partial 通过

6. 对插件工程师的验收清单
   UI 卡片是否正确
   本地文件是否写入
   脚本执行是否回传
   next_phase 是否能自动触发
```

插件工程师拿到这些后，可以不等服务器端完成，直接用 mock 消息开发和测试。

## 9. 建议优先打通的三个 Phase

### 第一优先级：upy-analyze

原因：它是入口，决定后面是否能正确进入正常路径或冷门硬件路径。

必须验证：

- 用户输入能拆成器件清单。
- 器件确认卡片能修改、增加、删除器件。
- 用户指定器件无驱动时，不推荐替代直接覆盖，而是标记 cold-driver。
- 系统推荐器件无驱动时，可以推荐替代。
- phase_complete 输出 manifest_content。

### 第二优先级：upy-gen-driver

原因：它直接解决冷门硬件、PDF/Arduino 资料利用、硬件验证、断点恢复。

必须验证：

- source=null 时弹文件上传卡片。
- PDF/Arduino 能走预处理脚本。
- 调试版驱动和生产版驱动分开。
- 无设备时输出 partial checkpoint。
- 验证失败能多轮修复，最多 10 轮。
- 生成独立测试脚本和接线参考。
- 最后能选择 publish / integrate / done。

### 第三优先级：upy-publish

原因：它解决“驱动写完还要手动整理”的收尾问题。

必须验证：

- 读取生产版驱动。
- 生成 README。
- 生成 package.json。
- 生成 LICENSE。
- 打包成 upypi 标准目录。
- 上传 upypi 前必须用户确认。
- 不上传时也能完整交付本地包目录。

## 10. 容易踩坑的地方

### 10.1 phase 名称必须统一

不要混用：

```text
cold-driver
gen-driver
upy-gen-driver
```

建议协议里统一用：

```text
gen-driver
```

文档标题可以叫 `upy-gen-driver`，但消息里的 `phase` 保持 `gen-driver`。

### 10.2 manifest_content 必须统一为 object

不要一会儿是 JSON 字符串，一会儿是对象。

建议统一：

```json
"manifest_content": {
  "schema_version": "1.0",
  "phase": "analyze"
}
```

不要：

```json
"manifest_content": "{完整 JSON 文本}"
```

### 10.3 失败不能只报错，必须可恢复

不推荐：

```json
{
  "result": "failed",
  "errors": ["未检测到设备"]
}
```

推荐：

```json
{
  "result": "partial",
  "summary": "未检测到设备，已保存调试版驱动，可稍后继续硬件验证",
  "checkpoint": {
    "resume_phase": "gen-driver",
    "resume_step": "hardware_verify"
  },
  "warnings": ["当前驱动未经硬件验证，不能标记为可发布"]
}
```

### 10.4 插件不要执行任意 shell

协议里虽然有 `script_run`，但实际执行应限制为白名单脚本。不要让服务器发：

```json
{
  "interpreter": "shell",
  "script": "curl"
}
```

更稳的做法是定义成：

```json
{
  "script_id": "upypi_query",
  "interpreter": "python",
  "script": ".upy/scripts/upypi_query.py",
  "args": ["--name", "sht30_driver"]
}
```

### 10.5 status_update 不等于真正完成

进度消息只是 UI 展示。真正的阶段状态以 `phase_complete` 为准。

### 10.6 用户确认点要少但关键

建议保留这些确认点：

- 器件清单确认。
- 生成计划确认。
- 设备连接和接线确认。
- 冷门驱动输入材料确认。
- 独立上电测试确认。
- 发布 upypi 确认。

不要每个小问题都问用户，否则流程会变慢。

## 11. 一份接口文档的最小完成标准

你写完一个 Phase 接口文档后，至少检查：

```text
[ ] Phase 名称统一
[ ] start_phase 输入完整
[ ] 消息序列按步骤列清楚
[ ] 每个 approval_request 有完整 JSON
[ ] 每个 script_run 有脚本名、参数、cwd、timeout
[ ] 每个 file_operation 有路径和操作类型
[ ] 每个 device_command 有 action、参数、timeout
[ ] status_update 全部列出
[ ] phase_complete 包含 success / partial / failed 至少两类情况
[ ] 明确 next_phase
[ ] 明确 checkpoint / resume 语义
[ ] mock 消息已创建
[ ] 本机 mock_plugin.py 能跑通
[ ] 插件端验收清单已写
```

## 12. 推荐的下一步

建议你接下来按这个顺序工作：

```text
1. 选 upy-analyze，补齐并校验接口文档。
2. 写 analyze 的 mock-messages。
3. 修改 upy-analyze/SKILL.md，先本机跑通 Phase A。
4. 把 I/O 翻译成协议消息，跑 Phase B。
5. 把 upy-analyze.md + mock 消息 + 测试记录交给插件工程师。
6. 同样方式做 upy-gen-driver。
7. 同样方式做 upy-publish。
8. 三个 Phase 本地联调后，再推进服务器端远程执行。
```

先不要试图一次性改完所有 10 个 Phase。入口、冷门驱动、发布收尾这三条打通后，架构风险会下降很多。

