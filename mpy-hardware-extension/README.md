# Blockless

Build MicroPython hardware projects from a sentence. Describe what you want to
build and an AI agent picks a board, selects and wires the parts, generates
deployable MicroPython code, and walks it onto your device — all inside a VS Code
side panel.

## What it does

- **Plain-language to project.** "A temperature display that warns when it's too
  hot" becomes a board choice, a parts list with wiring, and a working project.
- **Real component intelligence.** Parts, drivers, and pinouts come from a curated
  package catalog — not guessed APIs.
- **Wiring you can read.** Every build shows the parts and the wiring diagram,
  derived from the project manifest.
- **Generate, audit, deploy.** Code is generated, audited for unsafe imports, then
  flashed and run on a connected board with a confirmation checkpoint first.
- **Speaks your language.** The UI follows the language you type in.

## Getting started

1. Install the extension and open the **Blockless** view from the activity bar.
2. Sign in with GitHub when prompted (used for your free daily credits).
3. Describe what you want to build and follow the build plan.
4. To deploy to a real board, connect a MicroPython device over USB — the
   extension provisions a small Python helper (the device shim) the first time.

## Requirements

- A Python 3.10+ interpreter on PATH (or set `Blockless: Python Path`) for the
  device shim that talks to your board over serial.
- A GitHub account for sign-in and credits.

## Settings

- `mpyhw.apiBaseUrl` — override the backend API URL (e.g. a self-hosted backend).
  Leave blank to use the default hosted backend.
- `mpyhw.pythonPath` — path to the Python interpreter used for the device shim.
  Leave blank to auto-detect.
- `mpyhw.pipIndexUrl` — custom pip index URL for installing the shim's
  `mpremote`/`pyserial` (e.g. a mirror).

## Privacy

Your prompts and generated code are sent to the Blockless backend, which calls a
large language model to plan and generate the project. Telemetry is sanitized
(prompts and code are hashed, not stored verbatim).
