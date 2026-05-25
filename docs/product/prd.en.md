# One-Sentence Hardware — AI Embedded Generation Tool: Feature Plan

> Goal: The user only needs to describe the requirement in natural language, and the system automatically completes the entire flow from selection, code generation, compilation to flashing.

---

## Core User Journey

```
User says one sentence
    ↓
AI understands intent + hardware selection
    ↓
Auto-generate code + wiring diagram
    ↓
Library dependencies auto-resolved and installed
    ↓
One-click compile + flash
    ↓
Serial debugging + automatic error fixing
```

---

## Feature Modules

### 1. Natural Language Understanding (Input Layer)
- The user describes the project requirement in one sentence (Chinese and English both supported)
- The AI decomposes the intent: functional needs / sensors / communication / triggers
- Supports follow-up clarification (multi-turn dialogue to fill in missing info)
- Example: `"Build a temperature & humidity monitor that sends WeChat alerts when thresholds are exceeded"`

### 2. Hardware Selection Recommendation
- Automatically recommends a development board (ESP32 / Arduino Uno / STM32, etc.) based on the requirement
- Lists the required sensors/modules (with model and quantity)
- Provides purchase suggestions (price range, alternatives)
- Considers hardware the user already owns (user can declare existing devices)

### 3. Wiring Diagram Generation
- Auto-generates pin connection diagrams (which pin goes where)
- Visual wiring schematic (Fritzing-style or text table)
- Notes precautions (voltage, current limits, etc.)

### 4. Code Generation
- Multi-language support: Arduino C++ / MicroPython / ESP-IDF
- Generates a complete runnable project (main file + config files)
- Code includes necessary comments, friendly for beginners
- Supports two-way sync between Blockly blocks and code (optional)

### 5. Library Dependency Auto-Management (Key Pain Point)
- Automatically identifies third-party libraries required by the code
- Auto-downloads and installs the correct versions (avoiding conflicts)
- Project-level dependency isolation (no cross-project interference)
- Reference: AutoEmbed's component-aware library resolution

### 6. Compilation and Flashing
- Built-in compiler **or** cloud compilation (to shorten local environment setup)
- Auto-detects serial / COM ports
- One-click flashing to device
- Compile errors get AI explanation + fix suggestions

### 7. Serial Debugging and Feedback
- Real-time serial monitor (log output)
- AI interprets device output (auto-alerts on anomalies)
- Auto-iteration repair loop (generate → test → fix)

### 8. AI × Git Version Control

- On project creation, automatically `git init` — no manual setup needed
- Auto-commits after each AI generation/edit, with conventional messages:
  - `feat: add I2S microphone driver`
  - `fix: resolve display bug`
  - `refactor: improve WiFi reconnect logic`
- After the user manually edits code, the AI identifies the change and writes the commit description
- One-click rollback to the last working version when flashing fails or the device misbehaves
- Hides Git complexity from the user — versions are shown in a **timeline UI** (Figma-style version history)
- Version history = the project development log — easy to share, reproduce, and collaborate on

> **Differentiator**: No competitor offers this. It's the direct solution to the "I broke it and can't go back" pain point that beginner makers face most.

### 9. Project Template Library
- Common-scenario templates (smart home / environmental monitoring / robots / displays / networking)
- One-click reuse + customization
- Community-shared templates

---

## Landscape of Similar Products

### Commercial / Online Platforms

| Product | Type | Core Capability | Gaps | Link |
|---|---|---|---|---|
| **PleaseDoNotCode** | Web | AI picks sensors → auto-draws wiring → generates firmware → USB/WiFi flash; supports 100+ boards | Closed-source paid; no library management | [pleasedontcode.com](https://www.pleasedontcode.com/) |
| **Wokwi** | Web simulation | Arduino/ESP32 simulator in the browser, with AI code generation; no real hardware needed | Simulation-focused; no flashing | [wokwi.com](https://wokwi.com) |
| **Cirkit Designer** | Web | In-browser circuit design + AI wiring + code generation + simulation; supports Arduino/ESP32/Pico | Closed-source; limited simulation accuracy | [cirkitdesigner.com](https://cirkitdesigner.com/) |
| **Embedr** | Web | AI workspace: natural language → firmware + KiCad schematic + PCB layout — covers firmware through hardware design | Closed-source; aimed at pros | [embedr.cc](https://www.embedr.cc/) |
| **Tinkercad** | Web simulation | Autodesk's graphical circuit + Arduino simulator, education-oriented | No AI generation; small component library | [tinkercad.com](https://www.tinkercad.com/) |
| **ESP-Claw** | Tool | Chat with the ESP32 to control hardware without writing code | ESP32-only; limited features | [hackster.io](https://www.hackster.io/news/esp-claw-lets-you-build-iot-projects-via-chat-4b7eead1c3ca) |

### Open Source Projects

| Project | Type | Core Capability | Gaps | Link |
|---|---|---|---|---|
| **aily-blockly** | Desktop IDE | Blockly + AI generation + library mgmt (npm) + compile/flash + serial debug; supports ESP32/STM32/NRF5 | Alpha; AI is auxiliary | [GitHub](https://github.com/ailyProject/aily-blockly) |
| **ArduinoGPT** | Desktop tool | Natural language → Arduino code → auto compile/upload; supports Ollama/Groq; includes textual wiring notes | No library mgmt, no simulation | [GitHub](https://github.com/ANBU-304/ArduinoGPT-AI-Based-Arduino-Development-Assistant) |
| **AutoEmbed** | Research platform | Fully automated embedded development: LLM + hardware library knowledge injection + dep resolution + auto deploy (ACM SenSys 2026) | Academic; no GUI | [autoembed.github.io](https://autoembed.github.io/) |
| **AutoIOT** | Research tool | Natural language → AIoT application code, auto-iterates and refines; runs locally for privacy | Academic; only handles sensor data processing | [GitHub](https://github.com/lemingshen/AutoIOT) |
| **LLM4PLC** | Research tool | LLM generates PLC industrial control code with formal verification | PLC-only; not consumer hardware | [GitHub](https://github.com/AICPS/LLM_4_PLC) |
| **ubicomplab/llm-embedded** | Research | UW research on LLM code generation/optimization for embedded systems | Pure research; no tooling | [GitHub](https://github.com/ubicomplab/llm-embedded) |
| **Singular Blockly** | VS Code ext | Blockly + PlatformIO compile, supports Arduino/MicroPython/ESP32; integrates GitHub Copilot MCP | Requires VS Code; no AI project generation | [Marketplace](https://marketplace.visualstudio.com/items?itemName=singular-ray.singular-blockly) |
| **PICMG/iot_builder** | Tool | Generates IoT firmware project structure from config files | No AI; template-driven | [GitHub](https://github.com/PICMG/iot_builder) |
| **project_generator** | Tool | Embedded project generator; supports IAR/uVision/Makefile/Eclipse, etc. | No AI; config-driven | [GitHub](https://github.com/project-generator/project_generator) |
| **Mixly** | Desktop IDE | China's most popular graphical programming for Arduino/MicroPython, widely used in K-12 | No AI generation | [GitHub](https://github.com/mixly/Mixly_Arduino) |
| **Mind+** | Desktop IDE | DFRobot's graphical + code dual-mode tool; supports Arduino/MicroPython/AI modules | No natural-language input | [mindplus.cc](https://mindplus.cc) |
| **KidsBlock** | Desktop IDE | Kid-oriented; drag-and-drop blocks for Arduino/ESP32/Micro:bit | No AI; for young users | [kidsblock.cc](https://www.kidsblock.cc/) |
| **ElectroBlocks** | Web | Blockly + online Arduino simulator | No AI; few simulated parts | [GitHub](https://github.com/ElectroBlocks/ElectroBlocks) |
| **BlocklyDuino v2** | Web | Blockly blocks generating Arduino code | No AI, no compile/flash | [GitHub](https://github.com/BlocklyDuino/BlocklyDuino-v2) |
| **Visuino** | Desktop IDE | Graphical wire-style programming for Arduino/ESP32/STM32; no code | Commercial; no AI | [visuino.com](https://www.visuino.com/) |
| **MakeCode** | Web | Microsoft's Blockly + JavaScript; mainly Micro:bit/Circuit Playground | Limited hardware support | [makecode.com](https://makecode.com) |

---

## Competitive Differentiation

| Feature | PleaseDoNotCode | Cirkit Designer | Embedr | aily-blockly | AutoEmbed | ArduinoGPT | **Our Goal** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Natural-language input | ✅ | ✅ | ✅ | ✅ | partial | ✅ | ✅ |
| Hardware recommendation | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Wiring diagram | ✅ | ✅ | ✅ (PCB) | ✅ | ❌ | text | ✅ |
| Auto library mgmt | ❌ | ❌ | ❌ | ✅ | ✅ (strongest) | ❌ | ✅ |
| One-click compile/flash | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Serial debug | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Simulation | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | optional |
| Visual blocks | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | optional |
| Auto error fix | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Open source | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Chinese support | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Beginner friendliness | high | high | low | high | low | medium | **highest** |

---

## Product Form Choice

### Feature vs. Form Fit

| Feature | Web | Desktop IDE | VS Code Extension |
|---|:---:|:---:|:---:|
| Natural-language input | ✅ | ✅ | ✅ |
| Hardware recommendation | ✅ | ✅ | ✅ |
| Wiring diagram | ✅ | ✅ | limited |
| Auto library mgmt (upypi) | ⚠️ needs backend | ✅ local | ✅ |
| One-click compile/flash | ❌ serial limit | ✅ | ✅ |
| mpremote debug | ❌ | ✅ | ✅ |
| Auto error fix | ✅ | ✅ | ✅ |
| Auto test generation | ✅ | ✅ | ✅ |

**Hard blocker**: Flashing and mpremote debugging require local serial port access, which the web cannot do (Web Serial API is Chrome-only and unstable).

### Conclusion: Desktop IDE as Core, Web + Extension as Funnel

```
Desktop IDE (core, full pipeline)
    ↑ funnel
Web (template gallery + online try + SEO)
    ↑ funnel
VS Code extension (cover existing developer users)
```

---

## User Entry Strategy

**Primary entry: a single text box on the home screen.**
On launch, users see "What do you want to build?" — no board selection, no signup, just speak the requirement. Zero-friction cold start, ChatGPT-like experience.

**Secondary entry: web project library.**
The project gallery on the web is a natural SEO entry. A user searches "ESP32 temperature humidity" → lands on the project page → "Open in IDE" → triggers the download/install.

**Tertiary entry: VS Code extension (lightweight hook).**
Not a full implementation — just AI code generation + jump to desktop IDE for flashing. Covers existing developers, lowering migration cost.

---

## Technology Selection Reference

- **AI core**: LLM (Claude / GPT) + RAG (hardware library knowledge base)
- **Library mgmt**: MicroPython → upypi.net API + mpremote; Arduino → arduino-cli
- **Debugging**: MicroPython → mpremote REPL; Arduino → serial monitor
- **Compile**: arduino-cli / no-compile (MicroPython runs directly)
- **Frontend**: Electron desktop app
- **Serial comms**: serialport (Node.js)

---

## Priority (MVP Suggestion)

1. Natural language → code generation (core value)
2. One-click flash + mpremote debug (closed loop experience)
3. Auto library management (upypi API) (biggest pain point)
4. Auto error fixing (reduce frustration)
5. Hardware selection recommendation (lower the barrier)
6. Wiring diagram generation (nice-to-have)
7. Auto test generation (advanced)

---

*Based on analysis of open-source projects including AutoEmbed, AutoIOT, ArduinoGPT, and aily-blockly.*
*2026-05-18*

---

## VS Code Extension Architecture — Detailed Design

### Overall Architecture

```
User actions (VS Code extension)
    │
    ├── Local execution (extension calls directly)
    │     ├── mpremote → serial flashing/debug (physical serial; server can't reach)
    │     ├── git      → version control (operate local repo)
    │     └── file I/O → project files (VS Code workspace)
    │
    └── Server API calls (everything else)
          ├── /generate    → code generation (LLM)
          ├── /search-lib  → upypi + GitHub driver search
          ├── /hardware    → selection + wiring diagram (pin mapping maintained on server)
          ├── /fix-error   → error fix analysis (LLM)
          ├── /convert     → PDF/Arduino → MicroPython driver conversion
          ├── /gen-test    → test code generation (LLM)
          └── /git-msg     → commit message generation (diff → LLM)
```

**Why server-side pin mapping**: Adding a new board doesn't require an extension update — server-side change is live immediately.

### Feasibility of the VS Code Extension

A VS Code extension is essentially a Node.js process, so it supports the following:

| Capability | API |
|---|---|
| Invoke local mpremote / git | `child_process.spawn` |
| Call server APIs | `fetch` / `axios` |
| Render wiring diagrams, timeline, chat UI | `WebviewPanel` |
| Read/write local project files | `vscode.workspace.fs` |
| Show live mpremote output | `vscode.window.createTerminal` |

**The extension is just a local execution shell + a server API client — lightweight, with business logic living on the server.**

---

### Module 1: Code Generation

**Flow:**
```
User input
  → upy-project skill parses the requirement
  → query upypi (driver packages + docs as RAG corpus)
  → if no upypi hit → GitHub Search API for component drivers
  → apply upy-code-arch skill for a uniform code architecture
```

**`upy-code-arch skill.md` must define:**
- File structure spec (`main.py` / `config.py` / `lib/`)
- Driver wrapping pattern (class shape, init, exception-handling template)
- upypi package reference style vs. local `lib/` placement style

**Execution location:** LLM calls, upypi queries, GitHub searches → server; writing code to files → local

---

### Module 2: mpremote Flash/Debug

Reuse the existing three skills' logic, wrapped as VS Code commands:

| Skill | Scenario |
|---|---|
| `mpremote-device-interaction` | Device connect, port detect, single command |
| `mpremote-file-transfer` | Upload `main.py` + `lib/` to device |
| `mpremote-live-session` | Persistent connection, live output reading |

**Execution location:** All local, zero server dependency

---

### Module 3: Auto Error Fixing

**`upy-error-fix skill.md` defines:**

```
1. Debug-point conventions during code generation
   └─ Wrap every critical op in try/except + print(traceback)
   └─ Add print("OK") after each sensor init as a checkpoint

2. Error capture flow
   └─ mpremote-live-session reads output
   └─ Match known error patterns (ImportError / OSError / AttributeError)
   └─ Common-error knowledge base (embedded in skill.md)

3. Fix loop
   └─ Error text → LLM (with skill.md context) → fix
   └─ Re-upload → re-run → up to 3 attempts
```

**Execution location:** LLM fix analysis → server; mpremote execution → local

---

### Module 4: Hardware Assistant

**Selection logic (`upy-hardware-select skill.md`):**
```
Requirement keywords
  → upypi search (preferred — if a driver exists, it's usable)
  → if none → GitHub search for "<component> MicroPython"
  → output: model + specs + driver-available flag
```

**Wiring diagram generation (`upy-wiring skill.md`):**

Maintain per-board pin mapping files (local JSON), e.g.:
```json
{
  "ESP32":    { "SDA": "GPIO21", "SCL": "GPIO22", "TX": "GPIO1" },
  "ESP32-S3": { "SDA": "GPIO8",  "SCL": "GPIO9"  }
}
```
The AI uses the sensor's required pin types + the board mapping → produces a wiring table.

**Execution location:** upypi/GitHub search, LLM generation → server; mapping lookups → local

---

### Module 5: AI × Git Version Control

**`upy-git-commit skill.md` defines:**
- Trigger points: after AI generation / after successful flash / manual user trigger
- Commit message generation: diff → LLM → conventional commit format
- Rollback triggers: flash failure / explicit user command

**Timeline UI:** VS Code extension WebView + the native Timeline API; renders `git log` with click-to-checkout.

**Execution location:** git commands → local; commit-message generation → LLM server

---

### Module 6: Auto Test Generation

**`upy-test-gen skill.md` defines:**
- Generate `test_main.py` in parallel with the business code
- Mock conventions: `machine.Pin` / `machine.I2C` etc. via `unittest.mock`
- Test structure: one TestCase per sensor driver
- Runnable on PC without real hardware

**Execution location:** LLM generation → server; test files written & executed → local

---

### Local vs. Server — Summary

| Function | Local | Server |
|---|:---:|:---:|
| mpremote flash/debug | ✅ | ❌ |
| File I/O / Git ops | ✅ | ❌ |
| Pin-mapping lookup | ✅ | ❌ |
| Code/test generation | ❌ | ✅ LLM |
| upypi library search | ❌ | ✅ upypi API |
| GitHub driver search | ❌ | ✅ GitHub API |
| Error-fix analysis | ❌ | ✅ LLM |
| Git commit message | ❌ | ✅ LLM |
| Wiring diagram | ❌ | ✅ LLM (server-side mapping) |
| PDF parse → driver gen | ❌ | ✅ Server PDF parsing + LLM |
| Arduino conversion | ❌ | ✅ LLM |

---

### Module 7: Long-Tail Hardware Support

upypi and GitHub cover mainstream sensors, but obscure hardware (Chinese-market modules, industrial sensors, new chips) often comes only with a vendor PDF or Arduino code, and needs special handling.

**Sub-feature A: Reference-code conversion (`upy-convert-driver skill.md`)**
```
Input: Arduino .ino / C++ driver code
  → AI analyzes register ops / I2C-SPI timing / GPIO control logic
  → API mapping:
      digitalWrite     → machine.Pin
      Wire.begin/write → machine.I2C
      SPI.transfer     → machine.SPI
      delay            → utime.sleep_ms
  → Output: standard MicroPython driver class
  → Trigger upy-test-gen for a verification test
```

**Sub-feature B: PDF datasheet → driver (`upy-gen-driver skill.md`)**
```
Input: PDF datasheet
  → Server-side extract: comm protocol / register address table / init sequence / timing
  → LLM generates a driver skeleton (class shape + register constants + usage example)
  → Output dropped into project lib/
  → Auto-trigger upy-test-gen for validation
```

**Full long-tail flow:**
```
User supplies obscure hardware
  → upypi search → none
  → GitHub search → none / only Arduino code
  → User uploads PDF or Arduino code
  → upy-convert-driver / upy-gen-driver (server)
  → MicroPython driver generated → dropped into lib/
  → upy-test-gen → mpremote validates (local)
```

**Execution location:** PDF parsing, code conversion, driver generation → server; driver write, mpremote validation → local

---

### Skill Inventory

| Skill | Status | Purpose |
|---|---|---|
| `upy-project` | existing | Requirement parsing + project generation entry |
| `mpremote-device-interaction` | existing | Device connection |
| `mpremote-file-transfer` | existing | File upload |
| `mpremote-live-session` | existing | Persistent debug session |
| `upy-norm-driver` | existing | Driver normalization |
| `upy-code-arch` | to build | Uniform code architecture |
| `upy-error-fix` | to build | Debug-point spec + error KB + fix loop |
| `upy-hardware-select` | to build | Selection logic (upypi-first → GitHub) |
| `upy-wiring` | to build | Wiring diagram rules (server-side mapping) |
| `upy-test-gen` | to build | Test framework spec |
| `upy-git-commit` | to build | AI commit-message rules |
| `upy-convert-driver` | to build | Arduino/C++ → MicroPython conversion rules |
| `upy-gen-driver` | to build | PDF datasheet → MicroPython driver generation |

5 existing skills are directly reused; 8 new ones to build.

---

## VS Code Reskinning Plan

### Tier 1: Extension WebView Takes Over the UI (Recommended for MVP)

VS Code extensions can render arbitrary HTML/CSS/JS via `WebviewPanel`. Make every user interface a WebView, so the user spends most of their time looking at your brand's UI:

```
Side bar     → WebView (AI chat + project manager)
Bottom panel → WebView (serial output + debug timeline)
Editor       → Monaco (custom theme + icons)
```

Low effort, strong effect — feels like "a dedicated IDE" to the user.

### Tier 2: VS Code Distribution (Polished Product Stage)

VS Code is open source (MIT). Fork and modify:
- `product.json` → app name, logo, splash
- Default theme, icon pack
- Built-in extensions, welcome page, menu bar

Reference: Cursor, Windsurf, VSCodium. About 1–2 weeks of configuration; no VS Code core changes needed.

### Recommended Path

```
MVP stage      → Extension WebView reskin (validate the product first)
Polished stage → VS Code distribution (the user downloads "your IDE")
```

---

## Submodule Management and CI/CD Auto Sync

### Submodule Layout

Bring core dependencies into the project repo as git submodules:

```
project root/
├── submodules/
│   ├── micropython/        # MicroPython upstream
│   ├── upypi/              # upypi library repo (ours)
│   └── mpremote/           # mpremote tool repo
├── scripts/
│   ├── extract_mpy_api.py    # extract MicroPython API changes
│   ├── extract_upypi_pkg.py  # extract new/updated upypi packages
│   └── extract_mpremote_cmd.py # extract mpremote command changes
└── skills/
    ├── upy-code-arch.md
    ├── upy-error-fix.md
    └── ... (other skill.md files)
```

### API Extraction Script Responsibilities

| Script | Watches | Updates skill |
|---|---|---|
| `extract_mpy_api.py` | New MicroPython modules, API changes, deprecations | `upy-code-arch` / `upy-error-fix` |
| `extract_upypi_pkg.py` | New upypi packages, version bumps, package descriptions | `upy-hardware-select` / `upy-code-arch` |
| `extract_mpremote_cmd.py` | New mpremote commands, argument changes | `mpremote-device-interaction` / `mpremote-file-transfer` / `mpremote-live-session` |

### CI/CD Flow

```yaml
trigger: any submodule update (scheduled or webhook)
    ↓
1. git submodule update --remote
    ↓
2. run the matching extract_*.py
   → output: change summary JSON
    ↓
3. LLM reads the change summary → updates the matching skill.md
    ↓
4. auto-commit: update: sync skill.md with micropython@{version}
    ↓
5. server triggers a skill hot reload (no redeploy)
```

### Core Value

- **skill.md stays in sync with the toolchain version**, so AI-generated code doesn't call deprecated APIs
- New upypi driver packages are picked up by hardware recommendation without manual maintenance
- Updated mpremote commands flow into the debug skill — no "command not found" errors

---

## AI Generating Embedded Code: MicroPython vs. Arduino Comparison

> From the AI-assisted-development perspective, which platform is the better target for "one-sentence hardware"?

### Evaluation Dimensions

#### 1. Engineering Debug Loop

**MicroPython wins.**

- REPL interactive debugging: validate single lines directly on the device — no reflash needed
- `mpremote` toolchain: `run`, `exec`, `fs` commands support single-file hot updates
- AI-generated code → `mpremote run main.py` → instant results — very short loop
- Arduino: every change forces a full compile (10s–60s) + flash — long loop

#### 2. Automated Testing Framework

**MicroPython wins.**

- `unittest` runs directly on the device
- AI can generate pin mocks, peripheral stubs — same structure as PC-side Python tests
- Arduino has no standard test framework; `ArduinoUnit` and similar are awkward to integrate
- AI generates Python tests far better than C++ tests (training-data advantage)

#### 3. Developer Perception (Compute / Frame Rate / Peripheral Scheduling)

**Arduino slightly wins, but the gap is closing.**

- Arduino: `micros()`/`millis()` are precise; bare-metal scheduling is transparent; resources can be precisely accounted for
- MicroPython: GC pauses and interpreter overhead are opaque, but:
  - `utime.ticks_us()` can measure frame rate
  - `micropython.mem_info()` can inspect memory
  - The AI can produce standard profiling templates to fill the perception gap

#### 4. Basic Dev Skills (Memory / Watchdog / Reconnect)

| Capability | MicroPython | Arduino |
|---|---|---|
| Memory management | `gc.collect()` — easy for AI to emit | Manual malloc/free — AI prone to errors |
| Watchdog | `machine.WDT()` — one line | Register ops; platform-varied |
| Reconnect | `try/except` — clean structure, high-quality AI output | State machines — AI tends to miss edges |
| Exception safety | Full Python exception system | Hand-coded error codes; AI inconsistent |

The AI generates more reliable exception/reconnect code in MicroPython.

#### 5. Generating Flowcharts / Architecture / Dependency Diagrams

**MicroPython wins.**

- Python module structure (`import`, classes, functions) is static-analysis-friendly
- AI can extract call graphs and dependency graphs straight from `.py` files
- Arduino `.ino` files have implicit function declarations and multi-file concatenation, making dependency analysis hard
- Mermaid/PlantUML generation: Python's linear structure boosts AI's conversion accuracy

### Conclusion

| Dimension | Winner |
|---|---|
| Debug loop | MicroPython |
| Automated testing | MicroPython |
| Runtime perception | Arduino (slightly) |
| Basic dev skills | MicroPython |
| Architecture visualization | MicroPython |

**For AI-assisted embedded development, MicroPython is the more suitable target platform.** The core reason is that Python's structured nature systematically improves the quality and reliability of AI-generated, AI-tested, and AI-analyzed code — it's more than just "how many libraries are available."

*2026-05-18*

---

## Full Project Architecture

### Repo Layout

```
one-sentence-hardware/
├── vscode-extension/          # VS Code extension (local execution layer)
│   ├── src/
│   │   ├── commands/
│   │   │   ├── flash.ts       # flash → call mpremote
│   │   │   ├── debug.ts       # debug → mpremote live session
│   │   │   └── git.ts         # Git commit / rollback
│   │   ├── api/
│   │   │   └── client.ts      # server API wrapper
│   │   └── webview/
│   │       ├── chat/          # AI chat UI
│   │       ├── timeline/      # Git timeline UI
│   │       └── wiring/        # wiring diagram renderer
│   └── package.json
│
├── server/                    # server (AI intelligence layer)
│   ├── api/
│   │   ├── generate.ts        # code generation
│   │   ├── search-lib.ts      # upypi proxy + GitHub fallback
│   │   ├── hardware.ts        # selection + wiring
│   │   ├── fix-error.ts       # error fix loop
│   │   ├── convert.ts         # PDF / Arduino → MicroPython
│   │   ├── gen-test.ts        # test code generation
│   │   └── git-msg.ts         # commit message generation
│   ├── rag/
│   │   ├── board-mapping/     # board pin mapping DB
│   │   └── error-patterns/    # common-error KB
│   └── skills-loader/         # dynamically load skill.md into prompt
│
├── skills/                    # skill.md knowledge base
│   ├── existing (reused)
│   │   ├── upy-project.md
│   │   ├── mpremote-device-interaction.md
│   │   ├── mpremote-file-transfer.md
│   │   ├── mpremote-live-session.md
│   │   └── upy-norm-driver.md
│   └── to build
│       ├── upy-code-arch.md       # uniform code architecture spec
│       ├── upy-error-fix.md       # debug points + error KB + fix loop
│       ├── upy-hardware-select.md # selection logic (upypi-first → GitHub)
│       ├── upy-wiring.md          # wiring diagram rules
│       ├── upy-test-gen.md        # test framework spec
│       ├── upy-git-commit.md      # commit message rules
│       ├── upy-convert-driver.md  # Arduino/C++ → MicroPython
│       └── upy-gen-driver.md      # PDF → driver generation
│
├── submodules/                # toolchain submodules
│   ├── micropython/           # git submodule
│   ├── upypi/                 # git submodule (upypi repo)
│   └── mpremote/              # git submodule
│
├── scripts/                   # API extract + CI/CD scripts
│   ├── extract_mpy_api.py
│   ├── extract_upypi_pkg.py
│   └── extract_mpremote_cmd.py
│
├── .github/workflows/
│   └── sync-skills.yml        # submodule updates → skill.md auto sync
│
└── web/                       # web entries
    ├── landing/               # home page (download + SEO)
    ├── projects/              # template gallery (secondary entry)
    └── docs/                  # docs site
```

---

### upypi API Usage Spec

upypi is a structured driver package repo — call its API directly; no local vector DB needed.

```
# search packages
GET https://upypi.net/api/search?q={keyword}
→ { query, results: [{name, url}] }

# get package details (compatibility + file list)
GET https://upypi.net/pkgs/{name}/{version}/package.json
→ { name, version, chips, fw, urls }

# read driver doc (normalized README)
GET https://upypi.net/pkgs/{name}/{version}/README.md

# install to device
mpremote mip install https://upypi.net/pkgs/{name}/{version}/package.json
```

**Standard driver package layout:**
```
{chip}_driver/
├── code/
│   ├── {chip}.py
│   ├── main.py
│   └── {subpkg}/
├── package.json
├── README.md
└── LICENSE
```

---

### Full Library Search Flow

```
AI parses requirement → identifies needed sensors/modules
    ↓
GET upypi /api/search?q={sensor}
    ↓
hit
  → read package.json (verify chips/fw compatibility)
  → read README.md (get API usage)
  → generate code per README example
  → install: mpremote mip install {url}
    ↓
miss
  → GitHub Search API for "{sensor} MicroPython"
  → if found → read the code, generate an adapter driver
  → if not  → prompt user to upload PDF or Arduino code
              → server /convert generates MicroPython driver
              → place in project lib/
```

---

### Full Data Flow

```
User says one sentence (extension WebView)
    ↓
server /generate
  ├── skills-loader loads upy-project + upy-code-arch
  ├── upypi search API for drivers
  ├── miss → GitHub API fallback
  └── LLM generates business code + tests (in parallel)
    ↓
extension writes local files (main.py / test_main.py / lib/)
    ↓
server /git-msg writes commit message → local git commit
    ↓
mpremote uploads files + runs (local serial)
    ↓
success → serial output appears in WebView timeline
failure → error sent to server /fix-error
       → LLM analyzes + fixes
       → re-upload, re-run (up to 3 attempts)
```

---

### CI/CD Auto-Sync Flow

```
any submodule update (scheduled or webhook)
    ↓
git submodule update --remote
    ↓
run the matching extract_*.py → change summary JSON
    ↓
LLM reads the summary → updates the matching skill.md
    ↓
auto-commit: update: sync skill.md with {module}@{version}
    ↓
server skills-loader hot-reloads (no redeploy)
```

---

### Three-Layer User Entry

```
Web project gallery (SEO acquisition)
  → search "ESP32 temp humidity" → landing page
  → "Open in IDE" → trigger extension install

VS Code extension (core product)
  → full pipeline
  → WebView takes over the UI (branded)

VS Code distribution (late-stage brand product)
  → same extension, fork VS Code, reskin and ship
  → users download "your IDE"
```

---

### User Error Feedback Loop

**Core value:** Real user failures are the most direct signal of knowledge gaps, driving continuous iteration of skill.md, error-patterns, and board-mapping.

```
User error → /fix-error handles it
    ↓
Server logs (opt-in, user-consented):
  ├── error type + raw traceback
  ├── board model + upypi package name/version
  ├── which fix attempt succeeded / final failure
  └── current skill.md version
```

**Analysis cadence (weekly/monthly):**

```
Aggregate error data
    ↓
Bucket by error type:
  ├── ImportError    → upypi missing package / name mismatch
  ├── OSError        → wiring mistake / board-mapping wrong
  ├── AttributeError → API usage diverges from README
  └── 3-attempt fail → skill.md knowledge gap (highest priority)
    ↓
LLM aggregate analysis → improvement-suggestion report
    ↓
Human review
    ↓
Update skill.md / error-patterns / board-mapping
    ↓
Same CI/CD flow commits → server hot reload
```

**Error signal → knowledge-base mapping:**

| Error type | Meaning | Update target |
|---|---|---|
| High `ImportError` | upypi missing a driver category | Notify upypi to add the package / upy-hardware-select |
| `OSError: [Errno 19]` | Pin mapping wrong | board-mapping DB |
| `AttributeError` | README API example diverges from reality | upy-code-arch / upy-norm-driver |
| 3 fixes all failed | Current error-fix skill has a knowledge gap | upy-error-fix.md |
| One board, frequent errors | Bad mapping or compatibility for that board | board-mapping + upy-wiring |

**Privacy principles:**
- Only collect error types and technical context — never user business code
- The extension surfaces a clear notice; data is only uploaded after the user opts into "help improve the product"
- Data is anonymized and not linked to user identity

*2026-05-19*
