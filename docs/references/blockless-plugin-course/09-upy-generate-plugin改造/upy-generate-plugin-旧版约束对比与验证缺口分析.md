# upy-generate-plugin 与旧 upy-generate 约束差异及验证缺口分析

生成时间：2026-06-24

分析对象：

- `G:\MicroPython_Skills\upy-generate\SKILL.md`
- `G:\MicroPython_Skills\upy-generate-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-generate-plugin\scripts`
- `G:\MicroPython_Skills\upy-generate-plugin\test\run_local_mock_session.py`
- `G:\MicroPython_Skills\upy-scaffold-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-scaffold-plugin\scripts\apply_scaffold.py`
- `G:\MicroPython_Skills\upy-scaffold-plugin\scripts\init_scaffold.py`

结论先行：你的判断是对的。当前 `upy-generate-plugin` 已经把插件协议、上下游、依赖解析、checkpoint、manual feedback fix 等新机制立起来了，但相比旧 `upy-generate/SKILL.md`，确实少了不少“生成质量约束、参考模板代码、日志插入点、驱动 API 推断规则、最终审查清单”和 `pylint + PC 测试` gate。它更像一个第一版插件协议骨架，还没有完整承接旧 generate 的工程约束。

---

## 1. 当前新插件已经覆盖的内容

`upy-generate-plugin` 当前已经覆盖了以下新增能力：

1. 插件协议形态：`start_phase`、`phase_complete`、`file_operation`、`script_run`、`approval_request`、`structured_errors`。
2. full/fix 双模式。
3. `upy-autofix-plugin` 未实现时的人工反馈闭环：
   ```text
   deploy -> 用户现象反馈 -> generate mode=fix -> deploy
   ```
4. 默认下游：
   - 默认 `upy-deploy-plugin`
   - 用户可选 `upy-simulate-plugin`
   - 可停止
5. 附加产物：
   - `upy-diagram-plugin`
   - `upy-wiring-plugin`
6. 依赖搜索方向：
   - upypi `packages.json`
   - 英文关键词
   - 中间件库
   - `upy-pkg-guide` adapter
7. 确定性脚本：
   - `resolve_upypi_packages.py`
   - `download_drivers.py`
   - `check_mpy_imports.py`
   - `check_dead_config.py`
   - `check_skeleton_compliance.py`
8. 本地 mock runner 和 smoke tests。

这些是旧 `upy-generate` 没有的插件化治理能力，所以当前新插件不是“没做”，而是“协议治理做得多，旧生成细节迁移不够”。

---

## 2. 旧 upy-generate 中尚未完整迁移的关键约束

### 2.1 单元测试驱动的嵌入式开发哲学被压缩了

旧 `upy-generate` 开头明确强调：

- 硬件与软件解耦。
- 除 `main.py` 外不 `import machine`。
- 驱动通过 factory 注入。
- task 接收驱动对象。
- Mock 与真实驱动保持鸭子类型一致。
- PC 端可模拟全部业务逻辑。
- 传感器正常、缺失、异常三种场景必须覆盖。

新 `upy-generate-plugin` 只保留了简版规则，没有把“以单元测试为核心的嵌入式开发”作为核心哲学展开。这个会影响后续 LLM 生成代码时的优先级：它可能把“能跑起来”放在“可测试、可模拟、可修复”前面。

建议：把旧版“核心哲学”整段迁入新 plugin，位置放在 `代码生成约束` 之前。

### 2.2 驱动 API 解析规则迁移不完整

旧版对驱动解析写得很细：

1. `firmware/lib/<driver>.py` 是 Mock API 的权威来源。
2. 同时读取 README 和 example。
3. 主驱动类选择规则：
   - 多类时优先 I2C/SPI 子类。
   - 没有子类时选第一个非 Exception 类。
4. `__init__` 参数需要区分地址、Pin、配置参数。
5. 所有公开方法都要进入 Mock。
6. 需要判断驱动是否自建 I2C。
7. 自建 I2C 驱动要改成可注入 `i2c=None`。

新插件只写了“读取驱动源码、README、example，Mock 方法签名必须来自驱动源码”，但缺少上述细则和模板代码。

风险：LLM 可能仍然会凭包名猜 API，导致：

- factory 构造参数错误。
- Mock 漏方法。
- task 调用了真实驱动不存在的方法。
- deploy 后才出现 `TypeError` 或 `AttributeError`。

建议：把旧版 Phase 2A/2B 的规则迁入新 `SKILL.md`，并给 `knowledge/driver_api_usage.pitfall.json` 增加更具体的检测和示例。

### 2.3 factory / scan / GPIO / SPI 模板缺失

旧版提供了详细工厂模板：

- `create_<name>(i2c, address=None)`
- `scan_<name>_i2c(i2c, address=None)`
- I2C scan 不创建驱动实例，只检查地址。
- GPIO 器件如 buzzer/led 没有现成驱动时，LLM 要写 on/off/toggle/value 封装。
- SPI 器件 factory 接收 `spi, cs_pin`。

新插件没有保留模板代码，只保留了原则。

风险：后续生成的驱动 adapter 形状不稳定，下游 `deploy`、`wiring`、`simulate` 很难统一读取。

建议：在新插件新增 `references/generation_templates.md` 或直接在 `SKILL.md` 加短模板。由于 Skill Creator 建议 `SKILL.md` 不宜太长，推荐放入 `references/driver_factory_templates.md`，在 `SKILL.md` 中明确“生成 factory/mock 前必须读取”。

### 2.4 async 模式的驱动异步化规则被弱化

旧版 async 模式有明确例外：

- 默认不改驱动，async 化在封装层完成。
- 若驱动里有 `time.sleep()`、`time.sleep_ms()`、忙等待、I2S 阻塞读写，需要查 MicroPython asyncio 文档再改。
- 改为 `async def` 后 Mock 和 task 也要同步改变。

新插件只写了“阻塞 sleep 改为 await asyncio.sleep_ms”，缺少：

- 默认不改驱动的原则。
- I2S / 忙等待 / 轮询等待的处理。
- Mock 方法签名同步。
- 查官方文档确认 API。

风险：async 项目最容易出错。把同步驱动强行改 async，可能破坏库 API；不改阻塞 sleep，又可能卡住事件循环。

建议：把 async 规则升级为单独小节，并把 `scheduler_modes.pitfall.json` 扩展为 async driver pitfalls。

### 2.5 task 生成的日志矩阵缺失

旧版对 task 日志有一个强约束矩阵：

- 传感器读取成功：`debug + print`
- 传感器读取失败：`warning + print`
- 报警触发：`warning + print`
- 报警恢复：`info + print`
- 显示更新：`debug + print`
- 显示失败：`warning + print`
- 未预期异常：`error/exception + print`

新插件只写了“关键状态必须 print + lib.logger 双写”，粒度不足。

风险：后续 deploy/autofix 依赖串口输出和日志定位问题。如果日志点不稳定，用户反馈和自动修复都缺证据。

建议：迁移旧版 task 日志矩阵，并明确日志前缀规范，例如 `[sensor]`、`[display]`、`[alarm]`、`[network]`、`[driver]`。

### 2.6 `conf.py` 约束不够细

旧版要求：

- 阈值不硬编码。
- 日志配置必须包含：
  - `LOG_DIR`
  - `LOG_MAX_FILES`
  - `LOG_LINES_PER_FILE`
- 不放敏感数据。
- 日志消息要可检索、可读、分级、含关键数据。

新插件只写了阈值/周期/重试/日志配置必须在 conf 中，没有明确日志常量和日志消息原则。

风险：生成代码可能绕过 scaffold 的日志系统，也可能把 API key/Wi-Fi 密码写入配置。

建议：在 `conf.py` 小节加入旧版常量要求，同时在 `check_dead_config.py` 中区分：

- scaffold/framework reserved config。
- generate 新增业务配置。
- 业务配置未使用时必须阻断 success。

当前 `check_dead_config.py` 已把部分 scaffold 常量列为 reserved，这是合理方向；但要避免把 generate 新增的 `BUSINESS_*`、`ALARM_*`、`DISPLAY_*` 也误放行。

### 2.7 `main.py` 的 DI、日志初始化和 I2C scan 模板缺失

旧版 `main.py` 有非常具体的约束：

1. import 后第一段业务前必须 3 秒启动延时。
2. `machine.I2C/Pin -> factory -> driver -> task` 必须完整串联。
3. I2C 地址冲突时尝试第二个 I2C 实例。
4. 必须安装 rotating logger：
   - `install_rotating`
   - `setLevel`
   - `getLogger`
5. 固件启动信息 `print + info` 双写。
6. 启动时对每个 I2C 器件调用 `scan_<name>_i2c`。
7. main.py 有明确日志插入点表。

新插件只保留了 boot delay、DI 装配和 print/logger 双写原则，没有模板。

风险：真实设备阶段最关键的启动日志、I2C scan 和日志持久化可能漏掉。这样 deploy 失败时只能看到很少串口信息。

建议：把旧版 `main.py` 模板迁移到新 plugin 的 reference 文件，避免 `SKILL.md` 过长。

### 2.8 PC 测试和 device smoke 测试规则不完整

旧版要求：

- PC 测试使用 CPython `unittest`。
- 至少覆盖正常、传感器缺失 None、传感器异常三种场景。
- 导入 Mock 替换真实驱动。
- `sys.path.insert(0, 'firmware')`。
- device smoke 只测硬件可用性，不测业务逻辑。
- device smoke 只用 MicroPython unittest 子集。

新插件只写了“生成 PC 测试和 device smoke 测试”和 device assert 子集，没写三场景、unittest、Mock 导入、PC 端实际运行。

当前 runner 的 mock 测试文件甚至使用了 pytest 风格 `assert` 函数，而不是旧版要求的 `unittest`。虽然这是 mock runner，不是真实 LLM 产物，但会误导后续实现。

建议：

- 新插件明确 PC 测试必须用 `unittest`。
- 本地 runner 也改成 unittest 风格，保持示例一致。
- phase success 必须至少运行 PC 测试，除非用户选择只生成且明确跳过测试，此时 result 不应是 deploy-ready success。

### 2.9 最终 AI 审查清单缺失

旧版 Phase 8 有最终审查：

- 驱动 API 正确性。
- 需求覆盖。
- GPIO 器件审查。
- 测试覆盖审查。
- MicroPython import 兼容性审查。
- conf.py 死配置终审。
- 发现问题后重新跑 flake8 + pylint + import + dead config + PC 测试。

新插件没有完整迁移这个 review checklist。

风险：即使脚本过了，也可能遗漏需求、Mock 方法、GPIO 封装、日志点等语义问题。

建议：新增 `references/final_review_checklist.md`，并在 `SKILL.md` 中要求 phase_complete success 前必须逐项过审。

---

## 3. flake8 + pylint 验证缺口

### 3.1 旧版要求

旧 `upy-generate/SKILL.md` 明确要求：

```text
生成结束自动 flake8 + pylint 验证 + PC 测试运行，不通过不结束
```

并且给了 `.pylintrc` 模板，核心思想是：

- `firmware/lib` 外部驱动通常不参与严格 pylint。
- 对 MicroPython 模块禁用 `import-error`、`no-member`、`no-name-in-module`、`c-extension-no-member`。
- `ignored-modules` 包含 `machine`、`micropython`、`uasyncio`、`network` 等。

### 3.2 当前新插件实际情况

当前 `upy-generate-plugin/SKILL.md` 只要求：

```text
python -m flake8 firmware test
python scripts/check_mpy_imports.py
python scripts/check_dead_config.py
python scripts/check_skeleton_compliance.py
```

当前 `test/run_local_mock_session.py` 的 `run_checks()` 实际只运行：

- `flake8`
- `check_mpy_imports.py`
- `check_dead_config.py`
- `check_skeleton_compliance.py`

没有运行：

- `python -m py_compile`
- `python -m pylint`
- PC 单元测试
- device smoke 语法检查
- `firmware/lib` 驱动源码编译检查
- `.pylintrc` 生成或校验

环境层面确认：当前机器有 `pylint 3.3.9` 和 `flake8 7.3.0`，所以不是工具不可用，而是新插件实现还没接入。

### 3.3 当前 flake8 命令也需要调整

旧版 flake8 命令是：

```bash
python -m flake8 firmware/ --extend-exclude=firmware/lib --max-line-length=120
```

新 runner 用的是：

```bash
python -m flake8 --jobs=1 firmware test
```

问题：

1. 它没有排除 `firmware/lib`。真实驱动下载后，外部库可能有风格问题，不应因为第三方驱动风格阻断业务生成。
2. 它包含 `test/device`，但 device smoke 是 MicroPython 代码，可能 import `machine`，需要 `.flake8` 精确配置。
3. 它没有单独跑 `py_compile`，flake8 能捕获大部分语法错误，但明确跑 compile 更直接。

建议拆成：

```bash
python -m py_compile <generated non-lib py files>
python -m flake8 firmware test --extend-exclude=firmware/lib --max-line-length=120
python -m pylint firmware --rcfile=.pylintrc
python -m unittest discover -s test/pc
python scripts/check_mpy_imports.py --project-dir <project_root>
python scripts/check_dead_config.py --project-dir <project_root>
python scripts/check_skeleton_compliance.py --project-dir <project_root>
```

### 3.4 pylint 应该怎么放

Pylint 对 MicroPython 项目有价值，但必须配置：

- 它运行在 CPython 环境，对 `machine`、`network`、`uasyncio` 等模块不了解。
- 它会对 MicroPython 动态属性产生很多误报。
- 它能捕获未定义变量、分支错误、未使用变量、重复代码、异常处理不当等 flake8 不一定覆盖的问题。

所以 generate 阶段应把 pylint 当作强 gate，但前提是生成 `.pylintrc` 并屏蔽 MicroPython 噪声。

推荐策略：

| 目录 | pylint 策略 |
|---|---|
| `firmware/tasks` | 强 gate |
| `firmware/drivers/*_driver` | 强 gate |
| `firmware/main.py` | 强 gate，但忽略 MicroPython import 噪声 |
| `firmware/lib` 外部下载驱动 | 默认排除，另做 compile/import 风险扫描 |
| `test/pc` | 可以强 gate或 unittest gate |
| `test/device` | 不建议用 CPython pylint 强 gate，只做 MicroPython 子集规则检查 |
| `tools` | scaffold/deploy 阶段可单独 pylint |

### 3.5 `.pylintrc` 应该由谁生成

旧 `upy-generate` 写的是“项目目录下需存在 `.pylintrc`”。当前 `upy-scaffold-plugin` 只生成 `.flake8`，不生成 `.pylintrc`。

建议分工：

1. `upy-scaffold-plugin` 最好生成基础 `.pylintrc`，因为它负责工程骨架。
2. `upy-generate-plugin` 启动时如果发现 `.pylintrc` 缺失，应生成或要求写入 `.pylintrc`，不能跳过 pylint。
3. `.pylintrc` 应进入 file manifest，并在 phase_complete 的 `lint.pylint.config` 里记录。

---

## 4. scaffold 阶段没有做 pylint 要紧吗？

结论：不算致命，但需要补边界。

### 4.1 为什么 scaffold 不做 pylint 可以接受

`upy-scaffold-plugin` 的职责是生成骨架，不生成业务逻辑。它输出的是：

- `board.py`
- `conf.py`
- `main.py` 骨架
- logger/time_helper/scheduler/maintenance 模板
- tools
- `.flake8`
- manifest

当前 scaffold 已经要求：

```text
python -m flake8 --jobs=1 firmware tools
```

并且 smoke tests 里对渲染出的 Python 文件做过 `py_compile` 检查。对 scaffold 阶段来说，主要风险是语法错误、路径错误、模板引用错误、`.flake8` 配置错误。flake8 + py_compile 基本能覆盖第一层问题。

### 4.2 为什么 scaffold 长期还是应该补 `.pylintrc`

虽然 scaffold 不一定要运行 pylint，但它应该生成 `.pylintrc`：

1. generate 阶段需要它。
2. 项目一旦进入业务代码生成，pylint 需要 MicroPython ignore 配置。
3. `.pylintrc` 是项目级质量配置，应属于骨架资产。

### 4.3 scaffold 是否应阻断式运行 pylint

建议不要在 scaffold 第一版中把 pylint 作为强阻断 gate，原因：

- scaffold 代码大量是模板、placeholder、MicroPython import，pylint 噪声会比较高。
- scaffold 还没有业务逻辑，pylint 收益小于 generate 阶段。
- 如果 `.pylintrc` 不够精准，可能误阻断整个流水线。

更合理的策略：

| 阶段 | pylint 策略 |
|---|---|
| scaffold | 生成 `.pylintrc`，可选 warn-only 运行；不建议强 gate |
| generate | 必须运行 pylint，失败阻断 success |
| fix | 必须运行 pylint，失败不得 commit |
| deploy/autofix | 可读取 pylint 结果作为诊断上下文 |

---

## 5. MicroPython 基础事实对 lint 设计的影响

MicroPython 官方文档说明：

- MicroPython 的标准库是“micro-ified”的子集。
- 不同 port 和固件版本可能不包含全部模块或全部函数。
- 官方 latest 文档是开发分支，可能包含尚未进入已发布固件的特性。
- 可在设备 REPL 中用 `help('modules')` 查看实际固件模块。

这意味着：

1. CPython `py_compile` 通过，不代表板端可运行。
2. flake8 通过，不代表 MicroPython 模块存在。
3. pylint 的 `import-error` 对 MicroPython 项目容易误报，所以要配置。
4. `check_mpy_imports.py` 是必要的，但它也只是静态白名单，不等价于目标板验证。
5. generate 阶段最好把 `firmware_flash.latest_version` 或 board firmware version 写入 lint/check 上下文，避免只按 latest 文档生成新 API。

建议后续增加：

```text
check_mpy_target_modules.py
```

若设备可用，则通过 deploy 或 device command 获取：

```python
help('modules')
```

然后把实际模块列表写入 manifest，作为 `check_mpy_imports.py` 的目标板白名单。

---

## 6. 当前 upy-generate-plugin 脚本层面的缺口

### 6.1 `download_drivers.py`

优点：

- 已改为 stdout JSON。
- 不直接写项目目录。
- 已做换行规范化。
- 输出 `firmware/lib/...` 相对路径。

缺口：

- 没有对下载到的 `.py` 内容执行 compile 检查。
- 没有标记 `compile_ok` / `compile_error`。
- 没有区分 driver、middleware、reference 的不同验证策略。
- offline 模式下 cold driver 不报错，可能掩盖真实缺驱动问题。

建议：

- 增加 `validate_python_source()`。
- 每个文件记录：
  ```json
  {
    "path": "firmware/lib/ahtx0.py",
    "role": "driver",
    "compile": {"ok": true, "error": null}
  }
  ```

### 6.2 `check_mpy_imports.py`

优点：

- 能拦截 `typing`、`dataclasses`、`pathlib`、`logging`、`asyncio` 等高风险模块。
- 默认排除 `firmware/lib`，避免第三方库风格阻断。

缺口：

- 旧版最终审查要求重点检查 `firmware/lib` 下外部驱动是否有 CPython 特有 import。当前默认不扫 `firmware/lib`，只有 `--include-lib` 选项。
- 未区分 firmware runtime、PC test、tools 的不同 import 规则。
- 白名单是固定表，未结合目标板实际 `help('modules')`。

建议：

- generate 成功 gate 跑两次：
  ```bash
  check_mpy_imports.py --project-dir <project_root>
  check_mpy_imports.py --project-dir <project_root> --include-lib --warn-only
  ```
  第一次阻断业务代码，第二次把外部驱动风险写入 warnings 或 partial。

### 6.3 `check_dead_config.py`

优点：

- 能发现 generate 新增配置没被使用。
- 已支持 reserved scaffold config。

缺口：

- 当前 runner 用了 `--warn-only`，因此死配置不会阻断 success。
- 真实 generate 阶段不应对业务配置 warn-only。

建议：

- 对 `LOG_*`、`BOARD_*`、`FW_VERSION` 等 framework config 放行。
- 对 generate 新增业务配置强 gate。
- phase_complete 里记录 dead config 决策：`used` / `reserved_unused` / `dead_business_config`。

### 6.4 `check_skeleton_compliance.py`

优点：

- 检查 boot delay。
- 检查 scheduler mode。
- 检查 `board.py` 不实例化硬件。
- 检查 logger/time_helper 是否接入。

缺口：

- 没检查 `main.py` 是否安装 rotating logger。
- 没检查 I2C scan。
- 没检查 `machine` 只出现在允许文件。
- 没检查 `board.py` pinout 是否被静默改写。
- 没检查 `optional_next_phases` 和 `next_phase` 语义。

建议：

- 增加 scaffold baseline hash：读取上游 file_manifest 的 `board.py` hash，generate 后对比。
- 增加 `main.py` 日志初始化检查。
- 增加 task 不 import machine 检查。

### 6.5 `run_local_mock_session.py`

优点：

- 能跑通本地协议链路。
- 会调用 scaffold runner。
- 会输出 phase_complete。
- 会记录 file_manifest。

缺口：

- 它是 mock runner，不是完整 generate runner。
- 生成代码非常简化，不能代表真实业务代码生成。
- 不跑 pylint。
- 不跑 PC 单元测试。
- 默认不 git commit，只返回 `permission_required_or_dry_run`。
- PC 测试模板不是旧版要求的 unittest 风格。

建议：

- 保留 mock runner 用于协议测试。
- 另增 `scripts/apply_generate.py` 或 `test/run_local_actual_project.py` 作为真正 host-side apply/finalize runner。
- actual runner 必须执行完整 quality gate。

---

## 7. 建议的 generate 质量门禁顺序

建议把 generate success 的门禁写成以下顺序：

```text
1. py_compile generated firmware/test/tools files
2. flake8 firmware test tools --extend-exclude=firmware/lib
3. ensure .pylintrc exists or write it
4. pylint firmware --rcfile=.pylintrc
5. python -m unittest discover -s test/pc
6. check_mpy_imports.py --project-dir <project_root>
7. check_mpy_imports.py --project-dir <project_root> --include-lib --warn-only
8. check_dead_config.py --project-dir <project_root>
9. check_skeleton_compliance.py --project-dir <project_root>
10. final LLM review checklist
11. git commit
12. phase_complete success
```

注意：

- `firmware/lib` 外部驱动不应被 flake8/pylint 强制风格化。
- 但 `firmware/lib` 必须做语法/导入风险检查。
- PC 测试必须在 git commit 前跑。
- 任何强 gate 失败都不能输出 deploy-ready success。

---

## 8. 建议新增或迁移的文件

建议后续改造 `upy-generate-plugin` 时新增：

```text
references/
├── legacy_constraints.md
├── driver_factory_templates.md
├── task_generation_rules.md
├── main_generation_rules.md
├── validation_gates.md
└── final_review_checklist.md
```

建议新增脚本：

```text
scripts/
├── ensure_pylintrc.py
├── run_quality_gates.py
├── check_device_unittest_subset.py
├── check_task_no_machine_import.py
└── check_driver_source_compile.py
```

其中 `run_quality_gates.py` 负责统一输出 JSON：

```json
{
  "checks": {
    "py_compile": {"returncode": 0},
    "flake8": {"returncode": 0},
    "pylint": {"returncode": 0},
    "pc_unittest": {"returncode": 0},
    "mpy_imports": {"returncode": 0},
    "dead_config": {"returncode": 0},
    "skeleton_compliance": {"returncode": 0}
  },
  "ok": true,
  "structured_errors": []
}
```

---

## 9. 优先级建议

### P0：立即补文档约束

先不动复杂脚本，先把旧 `upy-generate/SKILL.md` 的约束迁移到 `upy-generate-plugin` 的 references 中：

1. 驱动 API 解析。
2. factory/mock 模板。
3. task 日志矩阵。
4. conf.py 规则。
5. main.py rotating logger 和 I2C scan。
6. PC/device 测试规则。
7. final review checklist。

### P1：补 pylint 和 PC 测试 gate

1. 新增 `.pylintrc` 模板。
2. `run_local_mock_session.py` 或后续 actual runner 加：
   - `python -m pylint firmware --rcfile=.pylintrc`
   - `python -m unittest discover -s test/pc`
3. phase_complete 中记录 `lint.pylint` 和 `tests.pc_unittest`。

### P2：补 compile 和驱动源码验证

1. `download_drivers.py` 对 `.py` 内容执行 compile。
2. `check_mpy_imports.py --include-lib` 作为 warn-only driver risk scan。
3. 增加 device unittest assert 子集检查。

### P3：决定 scaffold 是否生成 `.pylintrc`

建议：

- scaffold 生成 `.pylintrc`。
- scaffold 可 warn-only 运行 pylint。
- generate 必须强 gate 运行 pylint。

---

## 10. 对“scaffold 没做 pylint 要紧吗”的最终判断

短结论：

```text
scaffold 没做 pylint：短期不致命。
generate 没做 pylint：要紧。
scaffold 不生成 .pylintrc：会影响 generate 的质量门禁。
```

理由：

1. scaffold 阶段主要生成骨架，flake8 + py_compile 足够覆盖第一层模板错误。
2. scaffold 还没有复杂业务逻辑，pylint 收益有限。
3. generate 阶段会生成 task、factory、mock、main 装配、测试，复杂度高，pylint 能发现更多静态问题。
4. MicroPython 项目跑 pylint 必须有 `.pylintrc`，否则 `machine`、`uasyncio`、`network` 等会产生大量噪声。
5. 因此 `.pylintrc` 最好由 scaffold 作为项目骨架生成；即便 scaffold 不跑 pylint，generate 也必须使用它。

---

## 11. 推荐修正结论

当前 `upy-generate-plugin` 下一步不应该继续扩下游，而应该先补“生成质量契约”：

```text
迁移旧 generate 约束
-> 补 references 模板
-> 补 .pylintrc
-> 补 pylint gate
-> 补 PC unittest gate
-> 补 py_compile 和 driver compile
-> 补 final review checklist
-> 再考虑更复杂的 autofix/simulate/deploy 联动
```

否则后续即使 `deploy-plugin`、`simulate-plugin` 做好了，也会把大量本该在 generate 阶段发现的问题推迟到设备运行阶段，增加 autofix 负担。

---

## 12. 参考依据

- MicroPython Internals 文档说明 latest 是开发分支，可能包含尚未进入发布版的特性，因此生成代码不能只按 latest 文档假设目标板可用：`https://docs.micropython.org/en/latest/develop/index.html`
- MicroPython libraries 文档说明标准库是精简子集，不同 port/固件可能只包含部分库和函数，因此需要 MicroPython-aware import 检查和目标板模块探测：`https://docs.micropython.org/en/latest/library/index.html`
- MicroPython differences from CPython：`https://docs.micropython.org/en/latest/genrst/index.html`
- Flake8 配置文档：`https://flake8.pycqa.org/en/latest/user/configuration.html`
- Pylint 配置文档：`https://pylint.readthedocs.io/en/latest/user_guide/configuration/index.html`
