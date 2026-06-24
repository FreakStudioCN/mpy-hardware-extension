# upy-select-hw-plugin 测试目录问题说明

## 结论

`G:\MicroPython_Skills\upy-select-hw-plugin` 的修改位置是正确的。当前异常来自 `G:\test\test` 测试 workspace 中存在一份临时复制的旧脚本副本，CC 测试实际读取了这份副本，而不是最新的主 skill。

## 发现的问题

1. `G:\test\test` 下存在测试副本目录：
   - `G:\test\test\upy-select-hw-plugin`
   - `G:\test\test\upy-analyze-plugin`

2. `G:\test\test\upy-select-hw-plugin` 不是完整 skill，只包含：
   - `scripts\select_hw_manifest.py`

3. 该脚本与最新版本不一致：
   - `G:\MicroPython_Skills\upy-select-hw-plugin\scripts\select_hw_manifest.py` 是新版本
   - `C:\Users\Administrator\.claude\skills\upy-select-hw-plugin\scripts\select_hw_manifest.py` 与主 skill 一致
   - `G:\test\test\upy-select-hw-plugin\scripts\select_hw_manifest.py` hash 不一致，是旧副本

4. `G:\test\test\.claude\settings.local.json` 记录了测试时允许复制脚本到测试目录：
   - 创建 `G:/test/test/upy-select-hw-plugin/scripts`
   - 从 `.claude/skills/upy-select-hw-plugin/scripts/select_hw_manifest.py` 复制 `select_hw_manifest.py`

5. 最新 CC 测试又重新生成了 select-hw 产物，因此之前清理过的 session 文件再次出现：
   - `select_hw_draft.json`
   - `select_hw_validated.json`
   - `phase_complete.select_hw.json`
   - `pin_assignment_log.md`
   - `select_hw_phase_log.md`
   - `session_log.md`

6. `session_log.md` 显示测试执行时使用的是相对路径：
   - `upy-select-hw-plugin/scripts/select_hw_manifest.py`

   在 `G:\test\test` 作为工作目录时，这会解析到：
   - `G:\test\test\upy-select-hw-plugin\scripts\select_hw_manifest.py`

   因此测试跑到的是测试 workspace 里的旧副本，而不是 `G:\MicroPython_Skills` 下的源 skill。

## 影响

- 会误以为 `G:\MicroPython_Skills` 下的 skill 修改没有生效。
- 实际上是测试目录优先命中了旧脚本副本。
- 即使主 skill 和 `.claude\skills` 已同步，只要 `G:\test\test\upy-select-hw-plugin` 没更新，CC 在该测试目录下仍可能使用旧逻辑。

## 建议处理

1. 删除或重新同步测试 workspace 中的插件副本：
   - `G:\test\test\upy-select-hw-plugin`
   - 必要时也同步 `G:\test\test\upy-analyze-plugin\boards`

2. 不要长期保留只包含 `scripts` 的半截 skill 副本。测试时应二选一：
   - 直接使用 `.claude\skills\upy-select-hw-plugin` 中的最新 skill
   - 或每次测试前从最新 skill 完整同步到 `G:\test\test`

3. 重新跑 CC 测试前，先清理 session 下 select-hw 生成物，避免旧产物混淆：
   - `select_hw_draft.json`
   - `select_hw_validated.json`
   - `phase_complete.select_hw.json`
   - `pin_assignment_log.md`
   - `select_hw_phase_log.md`
   - `session_log.md` 如只用于本次测试，也可清理

4. 后续验证时确认脚本来源：
   - 源 skill：`G:\MicroPython_Skills\upy-select-hw-plugin`
   - 安装 skill：`C:\Users\Administrator\.claude\skills\upy-select-hw-plugin`
   - 测试 workspace 副本：`G:\test\test\upy-select-hw-plugin`

   三者如果都存在，必须确认 hash 或直接避免测试 workspace 副本覆盖行为。
