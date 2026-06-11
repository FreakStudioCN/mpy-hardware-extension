# Blockless Competitor Exhaustion Map

Date: 2026-06-11

Purpose: force the Blockless pitch to survive every adjacent category an
investor or skeptical builder can reasonably compare it against.

This is not a list of companies to fear equally. It is a map of which battle
each competitor class is fighting, what it can invalidate, and what evidence
Blockless needs before making a stronger claim.

## Core Question

If the user says:

> Temperature over 30 C turns on the fan.

Which system can go from that sentence to a real device that runs, logs,
repairs, and produces a rerunnable artifact?

Blockless should only claim the categories where it can win that exact loop.

## Competitor Classes

| Class | Examples | What they already own | What they do not prove | Blockless risk |
|---|---|---|---|---|
| Direct AI hardware workflow | PleaseDontCode, Schematik, Cirkit, Embedr | Prompt-to-hardware positioning; some claim wiring, code, flashing, logs, dashboards, projects | Same-task reliability and recipe reproducibility | They can invalidate "first," "only," and "competitors only generate code" |
| AI ECAD / PCB automation | Flux, Quilter, Diode, SnapMagic, tscircuit, SchGen, pcbGPT | AI for schematics, PCB layout, BOM, fabrication, CAD review, hardware-as-code | Devkit firmware loop, serial repair, real module wiring, second-user recipe rerun | They can steal the broad "AI hardware builder" narrative |
| Embedded workflow incumbents | PlatformIO, Arduino Cloud, Particle Workbench, Arduino CLI | Board/toolchain/library/deploy abstraction; cloud device workflows; OTA in some stacks | Natural-language intent, wiring, repair, recipe registry | Generic AI plus mature tooling may solve enough of v1 |
| Declarative IoT firmware | ESPHome, Tasmota | YAML/rules/templates for sensor/actuator automation; logs; Home Assistant integration; supported devices | General maker prototyping outside their ecosystem; NL recipe generation | They may beat Blockless on the first IoT wedge |
| IoT app/cloud platforms | Blynk, Arduino Cloud, Adafruit IO, Ubidots, Node-RED, Home Assistant | Dashboards, events, automations, APIs, mobile/web UI, device management | Choosing board/module/pins and creating firmware from intent | "Send sensor events to my app" is not unique |
| Edge AI and no-code AIoT platforms | Edge Impulse, SenseCraft | Dataset/model/deploy loop, no-code AI vision/sound/anomaly workflows, edge-device/fleet surfaces | General physical recipe generation and second-user hardware rerun | They can own "AI on hardware" or "vibe-coding for hardware" tasks when the model/app is the real job |
| Connected-product and fleet platforms | Blues Notehub, ThingsBoard, Hologram, Particle, Blynk | Connectivity, telemetry, device management, dashboards, rule chains, support, OTA/fleet operations | Intent-to-compatible bench recipe | They may own the recurring value after Blockless creates the first demo |
| Robotics lifecycle platforms | Viam | Hardware APIs, driver/model registry, remote control, fleet monitoring, OTA, cloud-managed machines | Devkit recipe generation, wiring/pin/package repair, second-user recipe rerun | They can punish broad "physical-world programmable" positioning |
| Industrial IoT app-enablement / AI copilots | Losant, Zerynth, Golioth | Device-cloud services, low-code workflows, dashboards, industrial analytics, OTA/logs/settings/RPC, factory AI copilots, integrations, services | Maker bench recipe generation and reusable verified recipes | They own many production/industrial claims that Blockless should not borrow |
| Platform/vendor up-stack | Arduino/App Lab/UNO Q, Qualcomm/Arduino, Espressif tooling, ESP-Claw, Espressif MCP, Espressif Docs AI, Adafruit/Seeed/SparkFun docs, PlatformIO | Boards, IDEs, docs, module ecosystems, official examples, libraries, distribution, support forums, vendor AI/MCP surfaces | Verified execution history and second-user recipe rerun | Vendors may own static hardware truth, agent context, and device-cloud surfaces |
| Simulation and education | Wokwi, Tinkercad Circuits, MakeCode, Visuino, Mind+, Mixly, Cirkit | Low-friction learning, visual inspectability, classroom safety, simulation | Physical wiring, flash, serial logs, real module variability | Beginners may prefer simulation to physical-first |
| Hardware vendor/tutorial flywheels | Adafruit Learn, Seeed Wiki, SparkFun, Arduino Project Hub, Hackster, Instructables | Parts trust, product-specific guides, community distribution, SEO | Rerunnable machine-readable recipes and auto-repair | Vendors can add AI to the docs/catalog layer |
| Code-to-device runtimes | DeviceScript, Johnny-Five, Firmata, MicroPython, CircuitPython | Friendlier languages, drivers, packages, simulation/testing in some stacks | Intent-to-compatible-recipe and verified rerun | MicroPython is not automatically the winning runtime |
| Software vibe-coding tools | Cursor, Lovable, Replit Agent, Bolt, v0, Copilot agent, Base44, Windsurf | Artifact loop, agentic iteration, templates, publish/deploy expectations | Physical inventory, wiring, flash, logs, second-user hardware reproduction | The analogy can overstate market size and adoption speed |

## Newly Added Pressure Sources

These sources widen the pressure beyond the earlier direct competitor list:

| Source | Why it matters | Correct Blockless interpretation |
|---|---|---|
| [Flux](https://www.flux.ai/) | Claims AI-assisted PCB design from plan to schematic/layout/manufacture, live parts data, explainable AI, templates, and paid plans | Not a devkit recipe competitor, but a narrative competitor for "AI hardware builder" |
| [Quilter](https://www.quilter.ai/) | Claims physics-driven AI that automates PCB placement/routing and returns files to existing CAD workflows | Shows serious AI hardware automation exists outside firmware |
| [Diode](https://www.diode.computer/) | Claims custom circuit boards designed/manufactured with AI, code-backed schematics, human review, BOM/DFM, and priced design packages | Proves buyers may pay high-ticket AI hardware services, but not maker recipe subscriptions |
| [SnapMagic](https://www.snapmagic.com/) | AI copilot for electronics design, CAD data, circuit autocomplete, BOM optimization, supply-chain suggestions | Component/CAD data can be a moat in adjacent hardware workflows |
| [tscircuit](https://tscircuit.com/) | TypeScript/React electronics framework, AI-agent-friendly hardware-as-code, registry, PR-style review | Forces Blockless to distinguish device recipe artifacts from PCB-as-code artifacts |
| [DeviceScript](https://microsoft.github.io/devicescript/) | TypeScript for tiny IoT devices, VS Code debugging, simulation/testing, packages, ESP32/RP2040 support | Friendly embedded language/runtime exists; MicroPython choice needs benchmark proof |
| [Node-RED](https://nodered.org/) | Low-code event-driven applications, data collection/transform/visualization, 5,000+ nodes/flows, edge/cloud use | Trigger/action and app workflow are mature; Blockless must own device creation |
| [Tasmota](https://tasmota.github.io/docs/) | Open-source ESP firmware with Web UI, MQTT/HTTP/serial control, rules/scripts, many peripherals and integrations | ESP device automation can avoid custom firmware for many tasks |
| [Home Assistant ESPHome integration](https://www.home-assistant.io/integrations/esphome/) | ESPHome devices connect to Home Assistant, expose entities/events/actions, and support logs and device replacement flows | For home automation, ESPHome may already be the strongest baseline |
| [Edge Impulse](https://www.edgeimpulse.com/) | Dataset/train/optimize/deploy loop for edge AI across MCUs and gateways | Edge AI workflows are separate from recipe generation but compete for "AI on hardware" mindshare |
| [SenseCraft](https://sensecraft.seeed.cc/) | Seeed's no-code AIoT platform claims no-code edge AI, 400+ pre-trained vision models, one-click deployment, sound/vibration workflows, HMI templates, fleet deployment, and coming "AI vibe-coding for hardware" | Vendor no-code AIoT can absorb AI-on-hardware and hardware-vibe-coding narratives before Blockless proves recipe superiority |
| [Blues Developer Center](https://dev.blues.io/) | Connected-product workflow across cellular, satellite, LoRa, and Wi-Fi using Notecard, Notehub, SDKs, routing, monitoring, fleets, and remote firmware update | If the user wants a connected product, recurring value may belong to connectivity/fleet infrastructure |
| [ThingsBoard](https://thingsboard.io/) | Open-source IoT platform for device management, telemetry, visualization, rule chains, SCADA, edge, gateways, MQTT broker, and mobile apps | Production IoT platforms can own the system-of-record layer after the prototype |
| [Hologram](https://www.hologram.io/) | Cellular IoT connectivity, outage protection, SIM management, global coverage, pre-deployment testing, and premium support | Connectivity and reliability pain may dwarf recipe creation in production IoT |
| [Viam](https://www.viam.com/) | Robotics platform claims hardware APIs, driver/model registry, remote control, fleet monitoring, and OTA for software/ML models | Broad physical-world-programming language must be narrowed to bench verified recipes |
| [Golioth docs](https://docs.golioth.io/) | IoT cloud services for embedded devices including secure connectivity, OTA, device management, logs, settings, RPC, data routing, and SDK support across Zephyr, ESP-IDF, and other frameworks | Zephyr/ESP-IDF fleet workflows can own recurring value after firmware exists |
| [Losant](https://www.losant.com/) | Enterprise IoT app-enablement with low-code workflows, dashboards, provisioning, digital twins, edge agent, multi-tenancy, and MCP/AI telemetry/config pressure | Low-code IoT app/platform language is not empty; Blockless must stay recipe-scoped unless measured |
| [Zerynth](https://zerynth.com/) | Industrial AI copilot/IoT core with edge devices, dashboards, anomaly detection, machine control, ERP/MES integrations, and services | Industrial AI and factory ROI claims are a different buyer and cannot be used as maker recipe TAM |
| [Arduino App Lab / UNO Q](https://www.arduino.cc/product-uno-q) | Official Arduino surface now combines Linux-capable board, real-time MCU, App Lab, sketches, Python, containerized AI models, examples/templates, Bricks, Qwiic/Modulino expansion, and ecosystem compatibility | Vendor/platform stacks can own board, IDE, module, example, and distribution layers |
| [ESP-Claw](https://github.com/espressif/esp-claw) | Espressif's chat-coding AI agent framework for IoT devices claims local sensing/decision/execution, dynamic Lua loading, MCP communication, one-click flashing, and ESP32-series support | Chip vendors can move above docs/IDEs into AI-agent runtime and flashing workflows; Blockless must prove recipe/rerun superiority |
| [Espressif MCP Servers](https://mcp.espressif.com/) | Official MCP servers expose Espressif documentation search and RainMaker device interaction to Cursor, VS Code, Claude Code, OpenAI Codex, Gemini CLI, and others | Official vendor context and device-cloud control can be available inside generic agents; Blockless must own verified execution outcomes |
| [pcbGPT](https://arxiv.org/abs/2606.01188) | Natural-language to editable KiCad schematics with component search, datasheet-grounding, checks, and benchmark results | Academic schematic generation is advancing fast; "hardware context" is not unique by itself |
| [SchGen](https://arxiv.org/abs/2605.30345) | Natural-language to editable PCB schematics using a semantic code representation and dataset | Representation design is a known research path, not a secret moat |
| [MicroBlocks](https://microblocks.fun/) | Blocks programming for physical computing with live board execution, real-time sensor graphs, supported microcontroller boards, portability, and no compile/download wait | Live physical-computing iteration is not unique; Blockless must prove recipe/rerun value beyond blocks |
| [XOD docs](https://xod.io/docs/) | Visual/dataflow hardware programming, browser/desktop IDE, hardware nodes/libraries, cloud, supported hardware, and project showcase | Visual inspectability is an incumbent no-code workflow; natural language must prove better outcomes |

## Logic Tests

### Test 1: Are We Comparing The Same Artifact?

Blockless artifact:

> board + module + wiring + driver + code + package versions + flash/run method
> + logs + known failures + repair hints + endpoint manifest + compatibility
> matrix.

If a competitor produces a schematic, PCB, dashboard, simulation, tutorial, or
firmware file, it is adjacent but not identical. If it produces the full above
artifact and a second user can rerun it, it is a direct substitute.

### Test 2: Is The Claimed User The Same?

Maker/prototyper:

- wants one physical project working quickly;
- tolerates some rough edges;
- may not pay repeatedly.

Embedded engineer:

- wants control, reviewability, testability, and compatibility;
- may prefer PlatformIO, KiCad, Flux, DeviceScript, or ESPHome.

School/maker-space:

- values lower support burden and repeatable labs;
- may prefer blocks/simulation if physical failure interrupts teaching.

Hardware startup:

- may pay for PCB layout/service, not maker recipes;
- likely compares against Flux, Quilter, Diode, KiCad, Altium, and contractors.

Do not mix these buyers in the same TAM line.

### Test 3: Can Generic AI Plus Mature Tools Cover V1?

The strongest null hypothesis is:

> A user with ChatGPT/Cursor plus PlatformIO/Arduino Cloud/ESPHome can solve
> most ESP32 sensor/actuator tasks well enough, so Blockless is convenience,
> not a company.

The benchmark must falsify this by showing lower time, fewer interventions,
better repair, or better second-user rerun.

### Test 4: Does The Appstore Object Exist?

A marketplace is not proven by publishing projects.

Evidence needed:

- users rerun someone else's recipe;
- users fork or combine recipes;
- recipes survive board/module variants;
- run logs and repair hints reduce future failures;
- at least one paid or committed behavior appears.

Without this, call it a verified recipe registry, not an appstore.

### Test 5: Is The Vibe-Coding Analogy Translating Or Smuggling?

Software vibe coding transfers:

- prompt-to-artifact;
- agentic iteration;
- project context;
- logs/tests;
- deploy/publish;
- templates.

It does not transfer:

- instant live URL;
- zero inventory;
- cheap reproduction;
- low-risk generated output;
- software-like subscription frequency;
- marketplace liquidity.

Therefore the analogy should be:

> Cursor/Lovable show the workflow shape. Blockless must prove the hardware
> version with real-device run and rerun evidence.

Not:

> Cursor/Lovable worked, therefore Blockless will.

## Exhaustion Criteria By Class

| Class | Desk research status | Still required |
|---|---|---|
| Direct AI hardware workflow | Enough to ban "first/only" claims | Hands-on same-task benchmark |
| AI ECAD / PCB automation | Enough to narrow Blockless away from PCB/fab claims | No hands-on needed unless deck claims "AI hardware builder" broadly |
| Embedded workflow incumbents | Enough to set baselines | Generic AI + PlatformIO/Arduino/ESPHome benchmark |
| Declarative IoT firmware | Enough to challenge IoT wedge | ESPHome/Tasmota task comparison where applicable |
| IoT app/cloud platforms | Enough to ban "sensor events to app is unique" | Endpoint/app workflow comparison for tasks 2, 4, 7 |
| Edge AI and no-code AIoT platforms | Enough to ban broad "AI on hardware" and "hardware vibe-coding" claims | Edge Impulse/SenseCraft task comparison when model, vision, sound, anomaly, HMI, or fleet workflow is claimed |
| Connected-product and fleet platforms | Enough to keep production IoT claims out of the core wedge | Blues/ThingsBoard/Hologram comparison when connectivity, telemetry, fleet, or production operations are claimed |
| Robotics lifecycle platforms | Enough to avoid broad physical-world-programming claims | Viam comparison when robotics lifecycle, remote control, fleet, driver registry, or ML model deployment is claimed |
| Industrial IoT app-enablement / AI copilots | Enough to avoid industrial IoT and factory AI transfer claims | Golioth/Losant/Zerynth comparison when OTA/logs/settings/RPC, low-code industrial workflows, dashboards, factory analytics, or AI-copilot-over-telemetry is claimed |
| Platform/vendor up-stack | Enough to ban broad "vendors lack hardware context" claims | Arduino/App Lab, PlatformIO, ESP-IDF/vendor-doc-plus-AI baselines |
| Simulation and education | Enough to challenge beginner wedge | Classroom/beginner completion study |
| Vendor/tutorial flywheels | Enough to challenge distribution | Tutorial-to-recipe rerun comparison |
| Code-to-device runtimes and live visual tools | Enough to weaken MicroPython/live-iteration/no-code absolutism | Runtime and visual/no-code benchmark by task type, including MicroBlocks/XOD where fit exists |
| Software vibe-coding tools | Enough to define analogy limits | Hardware repeat-use/payment evidence |

## Stronger Deck Position After Exhaustion

The most defensible positioning is:

> Blockless is not trying to automate all hardware design. It starts at the
> bench: a verified recipe workflow for ESP32-class physical prototypes, where
> the hard part is not only generating code but selecting compatible hardware,
> wiring it, flashing it, reading logs, repairing failures, and producing an
> artifact another user can rerun.

The category line to avoid:

> AI hardware builder.

The safer category line:

> Verified hardware recipe workflow.
