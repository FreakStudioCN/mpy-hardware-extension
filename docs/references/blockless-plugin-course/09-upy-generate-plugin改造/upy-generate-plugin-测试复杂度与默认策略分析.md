# upy-generate-plugin 测试复杂度与默认策略分析

## 结论

当前这个真实案例不属于特别简单的 demo，而是中高复杂度原型。

它包含 PIR、触摸、AHT20、I2S 麦克风、I2S 功放、WiFi、云端 ASR/LLM/TTS、异步调度、I2S 资源复用、配置占位、部署前密钥处理。对这种原型，完全不生成测试是不稳的，LLM 很容易生成“看起来完整但跑不起来”的代码。

但旧版 `project/test` 那种规模，作为默认生成产物偏重。

## 旧版测试规模观察

旧 generate 产物中曾包含：

- `test/pc/test_sensor_tick.py`
- `test/pc/test_dialogue_manager.py`
- `test/pc/test_voice_task.py`
- `test/device/test_smoke.py`

合计约 37 个 PC 测试，其中 `test_voice_task.py` 单文件约 169 行。

这个规模对“产品用户做原型 demo”来说有价值，但体验成本明显：

- 目录结构变复杂，用户会觉得项目膨胀。
- 测试代码和 mock 可能比业务代码更难理解。
- LLM 可能为了通过测试写出“服务测试”的结构，而不是最直接的原型代码。
- 质量门禁失败面变大，用户会感觉流程总卡住。
- MicroPython 设备侧 `unittest` 能力有限，复杂 device test 容易变成形式主义。

## 是否有必要生成 test 目录

有必要，但默认不应过重。

如果产品主要服务“不是特别简单的原型 demo”，`test` 目录应该作为“轻量验证资产”存在，用于验证生成代码是否具备基本可运行性、配置一致性和关键状态逻辑，而不是一开始就生成完整工程化测试套件。

默认目标应该是：

- 帮用户尽快看到固件能跑。
- 及时拦住明显会部署失败的问题。
- 保留少量可读的测试作为后续迭代保护。
- 不让测试代码压过业务代码。

## 推荐默认测试策略

### 1. 默认使用 prototype-light 档位

默认生成轻量测试，而不是完整严格测试。

建议默认包含：

- 每个核心任务 2-4 个 PC 测试场景。
- 一个设备侧 smoke 测试。
- 简单 mock，只覆盖接口，不模拟复杂业务。

核心场景：

- 正常路径。
- 缺设备或传入 `None`。
- 驱动异常。
- 状态是否跨 tick 保持。

### 2. device test 只做 smoke

设备侧默认只检查：

- `board` 能导入。
- `conf` 能导入。
- 关键 driver factory 能导入。
- 关键 I2C scan 能跑。
- 必要时检查固定地址设备是否存在。

不要默认在 MicroPython 设备上跑复杂业务单测。

### 3. 完整测试应作为可选 strict 档位

建议把测试分成三个档位：

| 档位 | 适用场景 | 默认行为 |
|---|---|---|
| `minimal` | 用户只想快速看 demo | 只生成 import/smoke 检查 |
| `prototype-light` | 默认推荐 | 轻量 PC 测试 + device smoke |
| `strict` | 用户要长期维护或复杂交付 | 完整 mock、状态机、异常路径、云接口模拟测试 |

旧版 37 个测试更适合 `strict` 或开发者模式，不适合作为大部分用户的默认体验。

## 质量门禁应优先检查什么

对原型 demo 来说，质量门禁应该优先拦住“会直接跑不起来/部署失败”的问题，而不是追求完整测试覆盖率。

建议强制保留：

- `py_compile`
- `flake8`
- `pylint` 的 fatal/error/usage
- `conf_contract`
- `mpy_imports`
- `skeleton_compliance`
- `generated_semantics`
- `cloud_integrations`
- `phase_complete_consistency`

这些门禁比大量单测更能直接提高生成成功率。

## 对 upy-generate-plugin 的修改建议

### 1. 增加测试档位参数

在 generate 阶段引入类似字段：

```json
{
  "generate": {
    "test_level": "prototype-light"
  }
}
```

可选值：

- `minimal`
- `prototype-light`
- `strict`

如果用户没有指定，默认使用 `prototype-light`。

### 2. SKILL.md 中明确默认测试边界

应明确要求：

- 默认不要生成大体量测试套件。
- 默认不要让测试代码比业务代码更复杂。
- 默认测试只覆盖核心失败面。
- 当用户明确选择 strict 或项目风险高时，才扩展测试。

### 3. phase_complete 中记录测试档位

建议在 `manifest_content.generate` 中记录：

```json
{
  "test_strategy": {
    "level": "prototype-light",
    "pc_tests": "core_task_paths",
    "device_tests": "smoke_only"
  }
}
```

这样后续 `upy-autofix-plugin`、`upy-deploy-plugin`、`upy-simulate-plugin` 都能知道当前测试深度。

### 4. quality gate 区分测试失败严重度

建议：

- `minimal`：没有 PC 测试不应失败。
- `prototype-light`：核心 PC 测试失败才阻塞。
- `strict`：所有生成测试失败都阻塞。

这样能避免“为了测试完整性牺牲原型体验”。

## 最终判断

`test` 目录有必要，但默认应该轻量化。

对大多数真实原型用户，最合理的是：

- 生成少量 PC 测试，证明任务函数和状态机没有明显错误。
- 生成一个设备 smoke，证明导入和基础硬件检查没有明显错误。
- 把完整 mock 和复杂异常路径测试放到 strict 档位。

这比完全不生成测试更可靠，也比默认生成 37 个测试更适合产品体验。
