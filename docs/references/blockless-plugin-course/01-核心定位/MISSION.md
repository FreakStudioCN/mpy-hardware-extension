# Mission: 学会维护 Blockless VS Code 插件

## Why
你要能按当前代码理解 Blockless 插件从“一句话硬件需求”到“生成、写入、部署 MicroPython 项目”的完整链路。目标不是泛泛学习 VS Code 插件，而是能快速定位这个仓库里的架构边界、关键文件、常见问题和开发入口。

## Success looks like
- 能解释 `package.json`、`activate.ts`、`panel.ts`、`SessionController`、`protocol-loop.ts`、`routes_llm.py` 各自负责什么。
- 能判断一个改动应该落在 Webview UI、扩展宿主、云端 API、协议契约、Python shim 还是内容目录。
- 能按问题类型选择要读的代码、文档和测试，并知道最小验证命令。

## Constraints
- 教学内容必须以当前仓库代码为准。
- 课程用中文写，偏实战维护和插件开发导览。
- 不引入无关重构，只产出教学文件。

## Out of scope
- 不讲通用前端框架课程。
- 不讲 MicroPython 驱动开发的全部细节，只讲插件如何调用相关能力。
- 不覆盖商业、融资、pitch deck 文档。
