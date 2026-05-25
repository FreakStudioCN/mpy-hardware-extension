# mpy-hardware-extension

一句话生硬件 · MicroPython 硬件扩展项目工作空间。

通过自然语言生成 MicroPython 硬件代码、对接 uPyPi 包仓库、一键烧录到开发板。

## 目录结构

```
.
├── dev/                          MicroPython 硬件扩展核心技术资料
│   ├── prd.md                    一句话生硬件 完整 PRD
│   ├── *.pdf                     5 份原始资料（Thonny 插件、uPyPi、应用商城、SOP …）
│   └── extracted/                PDF 转 Markdown 后的可检索版本
│       ├── INDEX.md              索引 + 13 个 GitHub 仓库 + 27 个外链汇总
│       ├── thonny-upypi-需求规格.md
│       ├── thonny-mpy-安装使用.md
│       ├── upystore-应用商城.md
│       ├── 一句话生硬件-资料汇总.md
│       ├── 开发生产宣传SOP.md
│       └── *_images/             每篇配套的图片 + OCR 文本
│
├── docs/
│   ├── product/                  产品文档：core / idea / prd / appstore（中英）
│   ├── research/                 调研与设计笔记
│   │   ├── project_*.md          各子主题分析（商业模式、定位、护城河 …）
│   │   ├── feedback_*.md         用户/市场反馈笔记
│   │   ├── phase2/               二阶段调研材料
│   │   └── pitch-archive/        早期 pitch 调研归档
│   ├── pitch/                    对外材料
│   │   ├── NVSC Coaching Presentation.md
│   │   └── deck/                 中英文 pitch deck
│   └── legal/                    法务（联合创始人协议等）
│
└── assets/                       图片等静态资源
```

## 快速入口

- 想了解项目背景与目标 → `docs/product/core.md`、`dev/prd.md`
- 想了解 Thonny + uPyPi 插件方案 → `dev/extracted/INDEX.md`
- 想了解商业/融资视角 → `docs/research/research-INDEX.md`

## 相关上游仓库

- https://github.com/FreakStudioCN/upypi —— uPyPi 包仓库后端
- https://github.com/FreakStudioCN/thonny-upypi-manager —— Thonny 包管理插件
- https://github.com/FreakStudioCN/MicroPython_Skills —— MicroPython 技能库
- https://github.com/MicroPythonOS/MicroPythonOS
- https://github.com/thonny/thonny

完整链接见 `dev/extracted/INDEX.md`。
