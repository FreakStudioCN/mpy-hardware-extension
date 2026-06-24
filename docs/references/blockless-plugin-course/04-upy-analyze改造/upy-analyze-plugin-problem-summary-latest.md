# `upy-analyze-plugin` 当前问题总结

## 1. 现在卡在哪里

`upy-analyze-plugin` 目前不是“分析逻辑没写完”，也不是“因为下游 skill 还没做所以不能用”。

现在卡点很具体：

- `analyze_runner.py` 已经能发起分析流程
- `mock_plugin.py` 已经能模拟插件侧收发消息
- `init_manifest.py` 也已经能正常执行
- 但脚本执行完后，`script_result` 回传给 runner 的结果格式还不够稳

大白话就是：

分析员已经把活干完了，质检员也出结果了，但“质检结果回传单”写乱了，导致 `analyze_runner.py` 不能稳定读懂。

---

## 2. 哪些部分其实已经没大问题了

目前这些已经基本成立：

- 新 skill 已单独建在 `G:\MicroPython_Skills\upy-analyze-plugin`
- 原 skill `G:\MicroPython_Skills\upy-analyze` 没有被覆盖
- 输入边界、确认点、替代推荐、冷门驱动分流、`phase_complete` 这些工作流规则已经梳理过
- 本机演练链路已经打通大半：
  - runner 可以发 `status_update`
  - runner 可以发 `approval_request`
  - mock plugin 可以回 `approval_response`
  - runner 可以发 `script_run`
  - mock plugin 可以真的执行 `init_manifest.py`

所以，当前不是“整个 skill 不行”，而是“最后一小段结果回传还没收稳”。

---

## 3. 当前不是哪些问题

为了避免误判，这里明确一下：

- 不是没有用户需求输入
- 不是 analyze 前半段流程跑不动
- 不是 `init_manifest.py` 自己坏了
- 不是因为 `select-hw` 还没做

也就是说，`upy-analyze-plugin` 当前问题仍然属于 **analyze 自己的收尾问题**，不是下一个 phase 的问题。

---

## 4. 现在最可能的根因

当前更像是消息封装方式不稳，而不是业务逻辑错误。

现在容易出问题的形式类似这样：

```json
{
  "type": "script_result",
  "payload": {
    "stdout": "{ ...一大段 JSON 字符串... }"
  }
}
```

问题在于：

- `stdout` 里又套了一层很长的 JSON 字符串
- 再经过消息转发、编码、转义后，runner 端解析容易失败

更稳的方式应该是直接回结构化对象，例如：

```json
{
  "type": "script_result",
  "payload": {
    "result_json": {
      "status": "ok",
      "errors": [],
      "manifest": {}
    }
  }
}
```

这样 runner 就不需要再去硬解析一长串嵌套字符串。

---

## 5. 应该怎么改

当前最值得做的不是扩 scope，而是只做这一件事：

- 修改 `mock_plugin.py`
  - 脚本执行成功后，先尝试 `json.loads(proc.stdout)`
  - 成功就把结果放到 `payload.result_json`
- 修改 `analyze_runner.py`
  - 优先读取 `script_result.payload.result_json`
  - 只有在没有 `result_json` 时，才回退解析 `stdout`

这一步的目标不是“增加新功能”，而是：

**先让 `upy-analyze-plugin` 的最小 happy path 真正稳定跑到 `phase_complete(success)`。**

---

## 6. 一句话结论

`upy-analyze-plugin` 现在已经不是“大方向没想清楚”，而是只差最后一个很小但关键的技术收尾：

**把 `init_manifest.py` 的结果回传格式，从脆弱的字符串方案，改成稳定的结构化 JSON 方案。**
