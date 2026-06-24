# upy-generate-plugin 整体 Project 架构复杂度与默认策略分析

## 结论

问题不只是 `test/` 目录偏重，而是当前 generate 后的整个 `project/` 架构默认暴露了太多工程化产物。

对“用户用产品快速做中等复杂度原型 demo”的场景来说，测试、mock、`.upy` 工具链、schema、build/docs/host 占位目录、完整驱动包、完整任务拆分、完整 manifest 都一起出现，会让项目显得像一个长期维护型固件工程，而不是一个可以快速理解、修改、部署的原型项目。

这个真实案例本身不简单：PIR、触摸、AHT20、I2S 麦克风、I2S 功放、WiFi、云端 ASR/LLM/TTS、异步调度、I2S 资源复用、密钥配置都在里面。因此架构不能太扁平。但当前默认形态仍然偏重。

## 当前复杂度观察

以 `G:\test\test\sessions\022ad742-3269-42e9-ac20-c14f477ecdf2\project` 的旧 generate 版本为参考，首个 generate 提交约 9000 行新增内容。

主要来源：

- `.upy/scripts` 与 `.upy/schemas`：约 4000 行 Python 工具脚本，且包含 scaffold、wiring、diagram、flash、triage 等完整工具链。
- `firmware/`：约 1400 行左右，包含 board、conf、main、drivers、lib、tasks。
- `test/`：约数百行，包含 PC tests 和 device smoke。
- `project-manifest.json`：体积较大，承载大量 workflow 状态、硬件选择、pinout、BOM、firmware flash、generate 信息。

其中 `.upy` 工具链是最大噪声源。它对流程可复现有价值，但默认直接放到用户项目中，会显著增加认知负担。

## 什么复杂度是必要的

对这个级别的原型，以下复杂度是合理的：

- `firmware/conf.py`：集中配置阈值、周期、云 API URL、音频参数。
- `firmware/board.py`：板卡、引脚、总线能力的固定定义。
- `firmware/main.py`：启动、日志、DI 装配、调度入口。
- `firmware/drivers/`：把硬件访问和业务任务隔离。
- `firmware/tasks/`：把传感器采样、语音交互、WiFi/云交互、维护任务拆开。
- `firmware/lib/`：只放真正要上传到设备的中间件库和下载驱动。
- `firmware/secrets.example.py`：提示用户复制为 `secrets.py`，避免密钥写进 `conf.py` 或 git。
- `project-manifest.json` 或 `.upy/manifest.json`：记录工作流状态，供后续 deploy/autofix/simulate 继续使用。

这些层次有实际价值，尤其能避免 `main.py` 变成所有逻辑混在一起的巨型脚本。

## 什么复杂度默认不应该暴露

### 1. `.upy/scripts` 不应默认完整复制

把 `init_scaffold.py`、`render_diagram_local.py`、`render_wiring_local.py`、`triage.py`、`download_drivers.py` 等完整工具链复制到每个项目里，默认过重。

更合理：

- 默认只保留 `.upy/manifest.json`、`.upy/file_manifest.json`、必要 schema 或指向 toolchain 的引用。
- 工具脚本留在 `G:\MicroPython_Skills` 的 plugin/skill 中执行。
- 只有用户选择“离线自包含项目”时，才复制 `.upy/scripts`。

### 2. `build/`、`docs/`、`host/` 占位目录应按需创建

这些目录对完整工程有用，但原型用户默认看到空目录会困惑。

建议：

- `build/`：首次编译 mpy 或打包时创建。
- `docs/`：用户请求 diagram/wiring/docs 时创建。
- `host/`：生成 PC host 工具或模拟器时创建。

### 3. mock 不应默认放在 firmware/drivers 下

旧结构中每个 driver 包里有 `mock.py`，这会让设备固件目录混入 PC 测试支持代码。

建议：

- 默认把 mock 放到 `test/mocks/` 或 `test/pc/mocks/`。
- `firmware/drivers/` 只保留设备会上传的生产代码。
- 如果为了简单保留在 driver 包内，deploy 阶段必须默认排除 `mock.py`。

### 4. `main.py` 不应过长

旧 `main.py` 约 200 行，里面同时承担 boot、logger、I2C scan、GPIO/I2S 初始化、driver factory、WiFi、DialogueManager、I2S resource plan、async loop。

这对 LLM 生成是可行的，但对用户阅读偏重。

建议默认拆成：

```text
firmware/main.py       # boot delay, logger setup, app.run()
firmware/app.py        # DI assembly and scheduler
firmware/conf.py       # config
firmware/board.py      # board/pin constants
firmware/drivers/      # hardware adapters
firmware/tasks/        # business tasks
```

如果项目很简单，可以不生成 `app.py`，直接用 `main.py`。

### 5. `project-manifest.json` 不应成为用户主要阅读入口

manifest 很重要，但它是机器协议和流程状态，不是用户文档。

建议：

- 根目录保留 `project-manifest.json` 可以接受，但 README 应只展示用户关心的摘要。
- 更理想是把大体量 workflow 状态放到 `.upy/project-manifest.json`，根目录只保留 `README.md` 和固件入口。
- 后续插件通过 manifest 继续工作，不要求用户手动理解全部字段。

## 推荐默认项目架构

### 默认：prototype-light

适合大多数非简单原型 demo。

```text
project/
  README.md
  project-manifest.json
  firmware/
    boot.py
    main.py
    app.py                 # 仅中等复杂度以上生成
    conf.py
    board.py
    secrets.example.py
    drivers/
      aht20_driver/
        __init__.py
      hc_sr501_driver/
        __init__.py
      ...
    tasks/
      sensor_task.py
      voice_task.py
      wifi_task.py
      maintenance.py
    lib/
      logger/
      time_helper.py
      ahtx0.py             # 只有真实需要时下载/生成
  test/
    pc/
      test_core_flow.py    # 少量核心测试
      mocks/
    device/
      test_smoke.py
  .upy/
    file_manifest.json
    checkpoints.json
```

默认不生成：

- 完整 `.upy/scripts` 工具链。
- 空 `build/`、`docs/`、`host/`。
- 大量 per-driver 测试。
- 大量 device unittest。
- 设备固件目录下的测试 mock。

### minimal

适合用户只想快速看效果。

```text
project/
  README.md
  project-manifest.json
  firmware/
    boot.py
    main.py
    conf.py
    board.py
    secrets.example.py
    drivers/
    tasks/
    lib/
```

测试只做内部质量门禁，不一定写入项目。

### strict / developer

适合复杂交付、长期维护、需要可复现工具链的项目。

可以生成：

- 完整 `.upy/scripts`
- 完整 schemas
- `build/`
- `docs/`
- `host/`
- `test/pc` 完整 mock 和单测
- `test/device` smoke + 选定硬件检查
- `.pylintrc`
- 本地 runner 脚本

旧版大项目结构更适合这个档位。

## 推荐的架构档位

建议 upy-generate-plugin 增加 `project_profile` 或 `architecture_level`：

```json
{
  "generate": {
    "project_profile": "prototype-light"
  }
}
```

可选值：

| 档位 | 目标用户 | 默认产物 |
|---|---|---|
| `minimal-demo` | 只想快速部署看效果 | 最少 firmware 文件，不写测试，不复制工具链 |
| `prototype-light` | 默认推荐 | 清晰 firmware 分层，少量测试，轻量 `.upy` 状态 |
| `developer` | 会二次开发 | 更多测试、mock、README、lint 配置 |
| `strict-self-contained` | 离线可复现/交付 | 完整 `.upy/scripts`、schemas、build/docs/host、完整测试 |

## 对质量门禁的影响

质量门禁应继续强，但不等于所有门禁产物都要暴露给用户。

建议：

- `py_compile`、`flake8`、`pylint`、`conf_contract`、`mpy_imports`、`generated_semantics`、`cloud_integrations` 必须作为内部门禁。
- `test/` 是否写入项目，由 `project_profile` 决定。
- `.upy/scripts` 是否复制，由 `project_profile` 决定。
- `phase_complete` 中记录产物档位，方便 deploy/autofix/simulate 判断当前项目期望复杂度。

## 最终判断

当前 generate 后的完整 project 架构，对“多数原型 demo 用户”默认偏复杂。

复杂度并非全错。这个案例确实需要驱动层、任务层、配置层、密钥策略、云 API 计划、I2S resource plan 和质量门禁。但默认不应把所有工程化支持文件都展示给用户。

更好的方向是：

1. 用户看到的是轻量、可读、可部署的 firmware 项目。
2. 插件内部保留严格质量门禁。
3. workflow 状态隐藏到 `.upy`，而不是让项目根目录变成工具链仓库。
4. 测试、mock、schemas、tools 按档位生成。
5. 默认 `prototype-light`，而不是默认 strict/self-contained。

这样既能服务真实中等复杂度原型，也不会让产品用户一打开项目就被工程化结构劝退。
