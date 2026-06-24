# `upy-analyze-plugin` 当前问题总结

## 1. 当前目标

当前不是在继续扩展新 skill，也不是在做下一个 phase。

当前只做一件事：

**把 `G:\MicroPython_Skills\upy-analyze-plugin` 收成一个可以本机演练最小 happy path 的插件化 analyze skill。**

---

## 2. 目前已经完成的部分

### 2.1 新 skill 已独立建好

已创建：

- `G:\MicroPython_Skills\upy-analyze-plugin\SKILL.md`
- `G:\MicroPython_Skills\upy-analyze-plugin\scripts\init_manifest.py`
- `G:\MicroPython_Skills\upy-analyze-plugin\mock_plugin.py`
- `G:\MicroPython_Skills\upy-analyze-plugin\analyze_runner.py`
- `G:\MicroPython_Skills\upy-analyze-plugin\run_local_mock_session.py`
- `G:\MicroPython_Skills\upy-analyze-plugin\sample\*.json`
- `G:\MicroPython_Skills\upy-analyze-plugin\LOCAL_TEST.md`
- `G:\MicroPython_Skills\upy-analyze-plugin\RUNNER_TEST.md`

原 skill `G:\MicroPython_Skills\upy-analyze` 没有被覆盖。

### 2.2 工作流骨架已经立住

新 skill 已明确：

- 输入边界
- 主确认点
- `requirement_supplement`
- 替代推荐
- 冷门驱动分流
- `phase_complete + manifest_content + next_phase`

### 2.3 mock 插件链路已经打通

当前本机已经可以完成这些动作：

- runner 发 `status_update`
- runner 发 `approval_request`
- mock 插件回 `approval_response`
- runner 发 `script_run`
- mock 插件真实执行 `init_manifest.py`

这说明：

**协议链路已经基本通了。**

---

## 3. 当前不是哪里有问题

先明确，当前问题**不是**这些：

### 3.1 不是没有用户需求输入

`sample/start_phase.analyze.json` 里已经有 `user_description`，runner 也确实读到了。

### 3.2 不是 analyze 前半段逻辑没通

当前这些步骤都已经能走：

- 分析需求
- 提取器件
- 器件确认
- 驱动搜索
- 调用 manifest 校验脚本

### 3.3 不是因为下一个 skill 没做

当前卡点仍然在 analyze 自己的收尾链路里，不是 `select-hw` 或别的 phase 导致的。

### 3.4 不是 `init_manifest.py` 完全不能跑

单独测试时，`init_manifest.py --stdin` 已经能返回结构化 JSON。

---

## 4. 当前真正卡住的点

现在问题已经收缩到很小：

**`script_run(init_manifest.py)` 执行完成后，脚本结果回传给 runner 的消息格式还不稳。**

也就是说：

```text
analyze_runner.py
  → 发 script_run
mock_plugin.py
  → 真跑 init_manifest.py
  → 拿到脚本结果
  → 回 script_result
analyze_runner.py
  → 读取 script_result
  → 这里解析失败
```

当前失败不是出在“脚本没跑”，而是出在：

**脚本结果被包装成 `script_result` 时，外层 JSON 里嵌了一大段内层 JSON 字符串，编码/转义过于脆弱。**

---

## 5. 大白话解释当前问题

可以把现状理解成：

1. analyze 已经把“卷子”做得差不多了
2. `init_manifest.py` 这个“质检员”也已经看完卷子了
3. 质检结果也写出来了
4. 但是“质检结果回传给 analyze 的纸条”写乱了
5. 所以 analyze 看不懂这张回执

重点：

- 不是卷子没做
- 不是质检员没工作
- 是**回执格式还差最后一点收尾**

---

## 6. 当前 runner / mock 演练的真实状态

### 已经成功的部分

- 双向桥接已经有了：`run_local_mock_session.py`
- runner 和 mock 可以真正来回交换消息
- 以前的单向管道问题已经解决
- Python 版本兼容性问题已经解决
- 基础 UTF-8 链路已经做过修补

### 还没成功的部分

- `script_result` 的结果包装仍不稳定
- runner 还不能稳定从 `script_result` 中拿到脚本结构化结果

---

## 7. 当前最合理的修改方向

当前不建议再去大改：

- `SKILL.md`
- analyze 主流程
- 冷门驱动分流逻辑
- 下一个 skill

当前最值得改的只有一件事：

### 把脚本结果回传从“字符串 stdout”改成“结构化对象”

当前容易出问题的形式是：

```json
{
  "type": "script_result",
  "payload": {
    "stdout": "{ ...一大段 JSON 字符串... }"
  }
}
```

更稳的方向是：

```json
{
  "type": "script_result",
  "payload": {
    "result_json": {
      "status": "ok",
      "errors": [],
      "manifest": { ... }
    }
  }
}
```

也就是：

- `mock_plugin.py` 先 `json.loads(proc.stdout)`
- 解析成功后，直接把对象放进 `result_json`
- `analyze_runner.py` 优先读取 `result_json`
- 不再依赖“长 JSON 字符串套在 stdout 里”

---

## 8. 当前建议的下一步

如果继续推进，最小、最稳、最值得做的下一步是：

1. 只改 `mock_plugin.py`
2. 只改 `analyze_runner.py`
3. 把 `script_result.stdout` 方案改成 `script_result.result_json`
4. 再跑一遍 `run_local_mock_session.py`

目标不是扩功能，而是：

**先把 `upy-analyze-plugin` 的最小 happy path 真正跑到 `phase_complete(success)`。**

---

## 9. 一句话结论

当前 `upy-analyze-plugin` 已经完成了大部分工作：

- skill 骨架有了
- runner 有了
- mock 插件有了
- 脚本也能跑

现在只剩最后一个很小但关键的问题：

**`init_manifest.py` 的结果回传消息格式还要收一下。**
