# 硬件 skill 修改总规则速览

## 一句话总规则

`upy-analyze-plugin` 的改造原则是：先把用户需求拆成“实现族 + 器件清单”，只在 1 个主确认点停住确认，然后按“内置运行时能力”和“具体器件驱动”两层搜索，具体驱动优先查 `upypi`，最后输出可交给 `select-hw` 的 `phase_complete + manifest_content`。

## 硬件 skill 修改规则

1. 输入固定为 5 类：
- `user_description`
- `pre_selected_board`
- `preferences.mode`
- `preferences.locale`
- `existing_hardware`

2. analyze 不再先问“小白/自定义”，直接吃输入上下文。

3. 主流程只保留 1 个必经确认点：
- `device_confirm`

4. `beginner/custom` 允许最多 1 张补充卡片：
- 只在确实缺 `scene/power/output/sample_rate/precision/response_time` 时触发

5. 用户中途补充需求时：
- 不做局部修补
- 直接按“重新分析”处理

6. 驱动搜索必须分两层：
- 第一层：`builtin_runtime`
- 第二层：具体器件驱动来源

7. `builtin_runtime` 只表示底层 API 可用：
- `machine.ADC`
- `machine.Pin`
- `machine.I2C`
- `machine.SPI`
- `machine.UART`
- `machine.I2S`
- `network`
- `bluetooth`

8. 具体器件驱动优先级固定为：
- `upypi`
- `awesome-micropython`
- `github`
- 其他可信 MicroPython 来源

9. `micropython_lib` 只用于官方生态通用库/中间件：
- 典型如 `aioble`
- 不是默认传感器驱动来源

10. 大类器件必须先拆实现族：
- 例如土壤类先区分 `ADC / RS485 Modbus / I2C/SPI / 组合方案`

11. `driver.source = "none"` 只能在以下情况使用：
- 不是明显内置运行时能力
- 且 `upypi / awesome-micropython / github / micropython_lib` 都没结果

12. `system_recommended` 无驱动：
- 可以给最多 2 个替代器件

13. `user_specified` 无驱动，或用户拒绝替代坚持原器件：
- 直接打 `cold-driver`
- analyze 不负责后续驱动生成

14. analyze 完成标准：
- `phase_complete`
- `manifest_content`
- `next_phase = select-hw`

## 参考文件

核心参考：
- [SKILL.md](G:\MicroPython_Skills\upy-analyze-plugin\SKILL.md)
- [llm_analyze.py](G:\MicroPython_Skills\upy-analyze-plugin\llm_analyze.py)
- [analyze_runner.py](G:\MicroPython_Skills\upy-analyze-plugin\analyze_runner.py)
- [init_manifest.py](G:\MicroPython_Skills\upy-analyze-plugin\scripts\init_manifest.py)

原始/目标参考：
- [SKILL.md](G:\MicroPython_Skills\upy-analyze\SKILL.md)
- [upy-analyze.md](G:\MicroPython_Skills\upy-project-gen-toolchain-spec\plugin-interface\skills\upy-analyze.md)

分析参考：
- `G:\blockless-plugin-course(1)\embedded-engineer-next-steps-guide.md`
- `G:\blockless-plugin-course(1)\embedded-skill-plugin-interface-workflow.md`
- `G:\blockless-plugin-course(1)\external-engineer-advice-analysis.md`
- `G:\blockless-plugin-course(1)\skill-current-vs-plugin-target-analysis.md`

MicroPython 生态参考：
- `micropython-lib`: `https://github.com/micropython/micropython-lib`
- 内置库/API: `https://docs.micropython.org/en/latest/library/index.html`

## 对话框输出口径

1. 器件确认卡片里要说清：
- 这是“器件方案确认”
- 土壤类器件可改成 `ADC / Modbus / I2C` 实现族
- 板卡若未选，只写“待下游 select-hw 选型”

2. 驱动搜索状态要分开表达：
- `底层能力 OK ... -> builtin_runtime (...)`
- `具体器件驱动 OK ... -> upypi/github/...`
- 不能混成一句“有驱动了”

3. 对 `I2C / SPI / UART` 具体器件要提示：
- 即使总线有内置 API
- 仍应继续优先检查 `upypi`

4. 替代推荐卡片只在 `system_recommended` 无驱动时出现。

5. 冷门驱动路径只打标，不在 analyze 阶段展开后续生成。

## 一句话版对话框文案模板

- `正在分析需求，先拆实现族和器件清单。`
- `请确认器件方案；像土壤类器件，可在这里改成 ADC / RS485 Modbus / I2C 方案。`
- `正在搜索驱动：先确认底层运行时能力，再优先检查 upypi 的具体器件驱动。`
- `分析完成，结果已整理为 manifest_content，下一阶段为 select-hw。`
