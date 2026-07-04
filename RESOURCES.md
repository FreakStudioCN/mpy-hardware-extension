# Blockless 插件开发资料

## Knowledge

- [VS Code Extension API Overview](https://code.visualstudio.com/api)
  VS Code 官方扩展开发入口。用于理解扩展能做什么、如何构建、测试、发布，以及扩展宿主模型。
- [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
  `package.json` 清单字段官方说明。用于理解 `main`、`engines`、`contributes`、`activationEvents`、`configuration`。
- [VS Code Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
  `contributes` 下各种声明入口。用于理解本插件如何贡献 activity bar、views、commands、settings。
- [VS Code Activation Events](https://code.visualstudio.com/api/references/activation-events)
  扩展何时被激活的官方说明。本插件当前 `activationEvents` 为空，主要依赖贡献视图/命令触发。
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
  Webview 的生命周期、消息通信和安全模型。用于理解 `src/webview/index.html` 与 `panel.ts` 的边界。
- [VS Code Commands Guide](https://code.visualstudio.com/api/extension-guides/command)
  命令注册和调用模型。用于理解 `mpyhw.openPanel` 与 `mpyhw.panel.focus`。
- [VS Code Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
  扩展测试的官方参考。结合本仓库 `mpy-hardware-extension/test/*.test.ts` 使用。
- [VS Code Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
  发布到 Marketplace 的官方参考。结合本仓库 `docs/vscode-extension-publish-flow.md` 和 `publish-extension` skill 使用。
- Local: `docs/specs/CURRENT-DECISIONS.md`
  当前 MVP 的单一活跃决策文档。用于判断架构边界：agent loop 在插件内，API 做 auth/credits/LLM/content/telemetry，Python shim 只做本地设备 IO。
- Local: `mpy-hardware-extension/package.json`
  插件清单和 npm 脚本入口。用于理解 VS Code 贡献点、设置项、构建和测试命令。
- Local: `contracts/protocol_messages.json`
  插件接口协议契约。用于理解 6 个协议工具及 schema。
- Local: `mpy-hardware-extension/src/extension/activate.ts`
  VS Code 扩展激活入口。用于理解宿主如何挂载 sidebar webview。
- Local: `mpy-hardware-extension/src/webview/panel.ts`
  扩展宿主侧总线。用于理解 Webview 消息、认证、会话控制、设备 shim、文件写入如何串起来。
- Local: `mpy-hardware-extension/src/extension/session-controller.ts`
  会话状态机。用于理解 start/retry/cancel/reset、UI prompt、artifact 写入和事件转发。
- Local: `mpy-hardware-extension/src/core/protocol-loop.ts`
  协议执行器。用于理解云端 LLM 通过 6 个工具驱动本地插件执行。
- Local: `mpyhw-api/app/routes_llm.py`
  后端 LLM SSE、阶段 prompt、协议工具白名单、credit 计费、server-side codegen 的核心实现。
- Local: `docs/plugin-architecture-and-skill-acceptance.md`
  面向接手开发者的工程文档。用于理解完整链路、关键文件和 skill/协议/执行器改动后的验收门槛。

## Wisdom (Communities)

- [VS Code Discussions](https://github.com/microsoft/vscode-discussions)
  VS Code 扩展平台问题的官方社区入口。
- [Microsoft/vscode issues](https://github.com/microsoft/vscode/issues)
  VS Code API 和扩展宿主行为问题的最终上游入口。
- [Stack Overflow: vscode-extensions](https://stackoverflow.com/questions/tagged/vscode-extensions)
  适合搜索具体 API 用法和常见报错。使用时优先交叉核对官方文档。

## Gaps

- 还没有一份专门描述 Blockless 协议 phase 与上游 MicroPython skills 如何对应的长文档。当前课程先覆盖插件视角，后续可单独做“phase recipe 与工具链”课程。
