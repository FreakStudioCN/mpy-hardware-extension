# Blockless

<a id="en"></a>
**English** · [中文](#zh)

Build MicroPython hardware projects from a single sentence. Describe what you
want to build — Blockless picks a board, selects and wires the parts, generates
deployable MicroPython code, and walks it onto your device, all inside a VS Code
side panel.

> **You type:** *"A temperature display that warns when it's too hot."*
>
> **Blockless gives you:** a matched board, a parts list with a wiring diagram
> you can read, and audited MicroPython code ready to flash.

## What it does

- **Plain language to a real project.** A sentence becomes a board choice, a
  wired parts list, and a working MicroPython project.
- **Real component intelligence.** Parts, drivers, and pinouts come from a
  curated package catalog — not APIs guessed by a model.
- **Wiring you can read.** Every build shows the parts and a wiring diagram
  derived from the project manifest.
- **Generate, audit, deploy.** Code is audited for unsafe imports, then flashed
  and run on a connected board — with a confirmation checkpoint before anything
  touches hardware.
- **Speaks your language.** The UI follows the language you type in.

## How it works

1. **Describe** what you want to build, in plain language.
2. **Review the plan** — board, parts, and wiring, laid out before any code.
3. **Generate** deployable MicroPython, audited for unsafe imports.
4. **Deploy** to a connected device over USB, with a confirmation checkpoint
   first.

## Getting started

1. Install the extension and open the **Blockless** view from the activity bar.
2. Sign in with GitHub when prompted (used for your free daily credits).
3. Describe what you want to build and follow the build plan.
4. To deploy to a real board, connect a MicroPython device over USB — the
   extension runs the local device helper for you.

## Requirements

- A GitHub account for sign-in and credits.
- For deployment: a MicroPython-capable board (e.g. ESP32) connected over USB.

## Settings

- `mpyhw.apiBaseUrl` — override the backend API URL (e.g. a self-hosted
  backend). Leave blank to use the default hosted backend.
- `mpyhw.pythonPath` — developer override for the fallback local runner.
- `mpyhw.pipIndexUrl` — developer override for fallback runner dependency setup.

## Privacy

Your prompts and generated code are sent to the Blockless backend, which calls a
large language model to plan and generate your project. Telemetry is sanitized —
prompts and code are hashed, not stored verbatim.

---

<a id="zh"></a>
# Blockless · 中文

[English](#en) · **中文**

一句话造出 MicroPython 硬件项目。描述你想做什么，Blockless 会选板子、挑选并接好
元件、生成可部署的 MicroPython 代码，并把它烧录到你的设备上——整个过程都在 VS Code
侧边栏里完成。

> **你输入：** *“一个过热时会报警的温度显示器。”*
>
> **Blockless 给你：** 一块匹配的开发板、一份带接线图的元件清单，以及一份经过安全
> 审计、可直接烧录的 MicroPython 代码。

## 它能做什么

- **一句话变成真实项目。** 一句话生成板子选型、接好线的元件清单，和一个能跑的
  MicroPython 项目。
- **真实的元件知识。** 元件、驱动和引脚来自精选的封装目录——不是模型瞎猜的 API。
- **看得懂的接线。** 每次构建都会根据项目清单给出元件清单和接线图。
- **生成、审计、部署。** 代码会先审计不安全的导入，再烧录并运行到已连接的开发板
  上——动硬件之前会有一次确认。
- **跟随你的语言。** 界面会跟随你输入的语言。

## 工作流程

1. **描述** 你想做的东西，用大白话就行。
2. **审阅方案**——板子、元件、接线，在写任何代码之前先摆清楚。
3. **生成** 可部署的 MicroPython 代码，并审计不安全的导入。
4. **部署** 到通过 USB 连接的设备，动硬件之前先确认。

## 快速开始

1. 安装扩展，从活动栏打开 **Blockless** 视图。
2. 按提示用 GitHub 登录（用于发放每日免费额度）。
3. 描述你想构建的内容，并跟随构建方案。
4. 要部署到真实开发板，用 USB 连接一块 MicroPython 设备——扩展会帮你运行本地设备
   助手。

## 环境要求

- 一个用于登录和获取额度的 GitHub 账号。
- 如需部署：一块通过 USB 连接、支持 MicroPython 的开发板（如 ESP32）。

## 设置项

- `mpyhw.apiBaseUrl` — 覆盖后端 API 地址（例如自托管后端）。留空则使用默认托管
  后端。
- `mpyhw.pythonPath` — 备用本地运行器的开发者覆盖项。
- `mpyhw.pipIndexUrl` — 备用本地运行器依赖安装的开发者覆盖项。

## 隐私

你的提示词和生成的代码会发送到 Blockless 后端，由后端调用大语言模型来规划和生成
项目。遥测数据已脱敏——提示词和代码以哈希形式记录，不会原文存储。
