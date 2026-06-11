# Blockless Source Ledger

Date: 2026-06-11

Purpose: record what each source can and cannot prove for the Blockless pitch.
This prevents marketing pages, press, docs, papers, and benchmark evidence from
being treated as equivalent.

## Evidence Hierarchy

| Evidence type | Confidence | Can prove | Cannot prove |
|---|---:|---|---|
| Hands-on same-task benchmark | Highest | Workflow friction, success/failure, repair quality | Broad market demand |
| User cohort / payment data | Highest for market | Repeat use, willingness to pay, retention | Technical superiority unless task-linked |
| Official product docs | High for feature existence | Documented workflow, APIs, supported surfaces | Reliability, adoption, moat |
| Product marketing page | Medium | Positioning and claimed capabilities | That the capability works consistently |
| GitHub README/source | Medium | Open-source scope and architecture | Product-market fit or production quality |
| Research paper | Medium/High for method | Technical feasibility, benchmark framing | Commercial moat or user behavior |
| Press article | Medium | Funding, narrative, public positioning | Exact feature reliability |
| Analyst/blog/secondary source | Low/Medium | Discovery and framing | Deck-grade proof without primary support |

Rule:

> A source can only support the kind of claim it is strong enough to prove.

## Direct AI-Hardware Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [PleaseDontCode](https://www.pleasedontcode.com/) | Direct competitor claims idea-to-firmware, wiring schematic, compatible libraries, verified pins, compile/auto-fix, USB/Wi-Fi flash, OTA/POTA, dashboards, public projects, remote serial logs, and browser-based flashing | Reliability, task success rate, recipe depth, whether public projects are rerunnable | Remove "competitors only generate code"; benchmark against PleaseDontCode before claiming closed-loop superiority |
| [PleaseDontCode pricing](https://www.pleasedontcode.com/pricing/) | Public paid tiers by credits/devices/private projects/OTA, with free plan | Actual paid conversion or retention | A direct competitor already has a monetization shape; Blockless payment claims still need user data |
| [Schematik](https://www.schematik.io/) | Schematik positions as AI hardware IDE for Arduino/ESP32/Pico and category claimant | Whether product fails or succeeds; whether Blockless beats it | Do not say "they tried and failed"; say it validates category and exposes stack questions |
| [WIRED on Schematik](https://www.wired.com/story/schematik-is-cursor-for-hardware-anthropic-wants-in-on-it/) | Public/media framing: "Cursor for Hardware," funding, low-voltage project framing, safety/parts guidance issues | Exact technical performance; definitive failure | Treat Schematik as narrative pressure, not proof Blockless wins |
| [Schematik build guides](https://www.schematik.io/guides) | Public guides include wiring diagrams, component lists, ready-to-deploy code, ESP32/Arduino project examples | Interactive workflow reliability or rerunnable recipe depth | Schematik is at least a guide/parts/code distribution threat |
| [Cirkit Designer](https://www.cirkitdesigner.com/) | AI circuit design, simulation, code, sharing, custom parts, browser upload claims | Physical reliability or classroom outcomes | Simulation is a real wedge; Blockless must justify physical-first verification |
| [Cirkit Designer docs](https://www.cirkitdesigner.com/docs/) | Docs claim browser design/simulation/prototyping, AI suggestions, integrated Arduino IDE, many components, sharing/community | Classroom completion or physical flash reliability | For education, simulation may beat real-hardware-first workflows |
| [Embedr](https://www.embedr.app/) | AI workspace for firmware, board bring-up, KiCad-native schematics/PCB layouts, build/flash/monitor, serial/output/terminal, targets/dependencies, checkpoints/Git | Actual feature reliability without hands-on test | Do not ignore AI embedded IDE positioning; Embedr is a pro-workflow threat |
| [Embedr pricing](https://www.embedr.app/pricing) | Public free/hobby/pro/team pricing, model access, monthly AI credits, PCB auto place/layout on pro | Paid conversion or embedded-user retention | Direct substitute monetization exists, but adoption remains unproven |
| [Aily Blockly GitHub](https://github.com/ailyProject/aily-blockly) | Open-source/blockly hardware AI workflow with AI project generation, board/library version management, serial tool, AI code/library/config generation, wiring diagrams, 2.2k stars, latest release in June 2026 | Adoption, production quality, install stability | Natural language/blocks hardware workflows are not proprietary by default |

Source hygiene note:

- `embedr.app` is the AI embedded workspace source. `embedr.ai` is a different
  private-knowledge/RAG product and must not be cited for embedded hardware
  workflow claims.
- PleaseDontCode pricing counters are self-reported marketing data unless
  independently verified. Use them as adoption-like signals to question, not as
  deck-grade adoption proof.

## Embedded Workflow Incumbents

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [PlatformIO docs](https://docs.platformio.org/en/latest/what-is-platformio.html) | Board, framework, library, toolchain, build/upload abstraction is mature | That generic AI+PlatformIO beats Blockless | Board/package/dependency tooling is table stakes |
| [ESPHome](https://esphome.io/) | Declarative hardware config, component catalog, device firmware, OTA/logs for IoT workflows | That ESPHome covers all maker/prototype jobs | Sensor/actuator IoT tasks need ESPHome baseline |
| [Home Assistant ESPHome integration](https://www.home-assistant.io/integrations/esphome/) | ESPHome devices expose entities, actions, events, logs, replacement flows, and Home Assistant integration | That ESPHome can create arbitrary maker recipes from one sentence | Home automation tasks may have a stronger incumbent than generic Arduino tooling |
| [Tasmota](https://tasmota.github.io/docs/) | Open-source ESP firmware with Web UI, MQTT/HTTP/serial control, rules/scripts, peripherals, and smart-home integrations | That Tasmota handles arbitrary custom hardware intent | Many ESP automation projects do not need generated firmware |
| [Arduino Cloud docs](https://docs.arduino.cc/arduino-cloud/) | Things, variables, dashboards, device setup, OTA for supported boards, IoT workflows | That Arduino Cloud handles Blockless's recipe/reproducibility goal | Endpoint/dashboard layer is not unique |
| [Arduino software](https://www.arduino.cc/en/software) | Arduino now surfaces IDE, Cloud Editor, App Lab, Flasher CLI, Linux images, CLI, Lab for MicroPython, Chromebook cloud upload, and IoT Remote from one official software page | That Arduino has Blockless's verified recipe artifact | Arduino's official tool surface can absorb many workflow steps Blockless wants to own |
| [Arduino App Lab docs](https://docs.arduino.cc/software/app-lab/) | Official App Lab docs describe a unified environment for Arduino Apps, ready-to-use Bricks, setup/config/update, run/monitor, CLI, IoT Remote integration, and custom AI models | That App Lab generates physical recipes from one sentence | Vendor IDEs are moving toward app/module composition and AI workflows |
| [Arduino UNO Q](https://www.arduino.cc/product-uno-q) | UNO Q combines Linux-capable Qualcomm Dragonwing QRB2210, STM32U585 real-time control, App Lab, sketches, Python, containerized AI models, examples/templates, Bricks, Qwiic/Modulino expansion, and Arduino ecosystem compatibility | That UNO Q is the right v1 board for Blockless or beats ESP32 recipes | Platform vendors can combine board, IDE, module ecosystem, AI models, and distribution |
| [Qualcomm Arduino acquisition release](https://www.qualcomm.com/news/releases/2025/10/qualcomm-to-acquire-arduino-accelerating-developers--access-to-i) | Qualcomm official page exists but requires JavaScript in this capture; media quoting it reports acquisition, Arduino independence, and edge AI/developer-access framing | Final deal status, terms, or exact current integration plan without official text access | Treat as platform-consolidation pressure, not proof Arduino already replaces Blockless |
| [Espressif GitHub organization](https://github.com/espressif) | Espressif-verified GitHub organization lists official ESP software, Developer Portal, ESP-IDF docs, Docs AI chatbot, ESP-Claw, ESP private agents, ESP-DL/ESP-NN, and MCP servers | That ESP-Claw/MCP solves Blockless's recipe/rerun workflow | Espressif is a source-backed vendor AI/platform baseline, not a stale rumor |
| [ESP-Claw](https://github.com/espressif/esp-claw) | Espressif chat-coding AI agent framework for IoT devices, with local sensing/decision/execution, dynamic Lua loading, MCP communication, one-click flashing, and ESP32-series support | Same-task reliability, physical build success, recipe completeness, or Blockless superiority | Add ESP-Claw as a Gate 5/6 baseline for ESP32 AI-agent/IoT behavior tasks |
| [Espressif MCP Servers](https://mcp.espressif.com/) | Official MCP servers for Espressif documentation search and RainMaker device interaction, with Cursor, VS Code, Claude Code, OpenAI Codex, Gemini CLI, and other setup paths | That MCP docs/device-control interactions create rerunnable physical recipes | Generic agent context access is commoditizing; benchmark against official vendor MCP where task fit exists |
| [Espressif Docs AI](https://chat.espressif.com/) | Espressif-hosted Docs AI chatbot for support around Espressif products/docs | That Docs AI produces working hardware or repairs failures | Vendor docs are AI-queryable; Blockless needs execution evidence beyond docs answers |
| [Blynk docs](https://docs.blynk.io/) | Templates, datastreams, web/mobile dashboards, automations, device/fleet concepts | That Blynk replaces hardware recipe creation | "Send sensor events to app" is not unique |
| [Blynk pricing](https://www.blynk.io/pricing) | Pricing around devices, users, messages, retention, dashboards, AI workflows, RBAC, SLA, support, enterprise white-label/private infrastructure | Blockless recipe demand or device-creation superiority | IoT/app monetization is device/fleet/platform oriented, not recipe-market proof |
| [Particle Workbench docs](https://docs.particle.io/getting-started/developer-tools/workbench/) | Device OS, cloud/local tools, compile/flash, OTA/device lifecycle | That Particle is a beginner recipe platform | OTA and fleet/dev lifecycle are not moats |
| [Particle pricing](https://www.particle.io/pricing/) | Pricing around devices, data operations, support, connectivity, retention, implementation services, certification, and enterprise procurement | Maker recipe subscriptions | Serious IoT buyers pay for fleet/data/support, not necessarily recipe artifacts |
| [DeviceScript](https://microsoft.github.io/devicescript/) | TypeScript for tiny IoT devices, VS Code debugging, simulation/testing, packages, ESP32/RP2040 support | That TypeScript runtime beats MicroPython or Blockless recipes | Friendlier embedded runtimes are real; MicroPython needs measured advantage |
| [Johnny-Five](https://johnny-five.io/) | JavaScript robotics/IoT framework with board/platform support and examples | That it solves deployment, wiring, recipe, or beginner failures | Language accessibility is an old theme, not a new moat |

## AI ECAD and PCB Automation Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Flux](https://www.flux.ai/) | AI-assisted PCB design across planning, schematic, layout, manufacture, live parts data, explainable AI, templates, and paid plans | Devkit firmware recipe loop or real-module rerun behavior | Broad "AI hardware builder" positioning will be compared against AI PCB tools |
| [Flux pricing](https://www.flux.ai/pricing) | Pricing around AI credits, seats/editors, private projects, imports, team workspace, enterprise security/SOC2/SLA/invoicing | Maker recipe marketplace demand | Pro hardware AI pricing exists, but its buyer and artifact differ from Blockless recipes |
| [Quilter](https://www.quilter.ai/) | Physics-driven AI for PCB placement/routing, multiple candidates, physical validation, existing CAD workflow handoff | Maker bench workflow, firmware repair, serial logs, app endpoints | Shows serious AI hardware automation already exists; Blockless must narrow category |
| [Diode](https://www.diode.computer/) | AI-designed and manufactured custom circuit boards, code-backed schematics, human-in-loop review, BOM/DFM, priced service packages | Subscription maker demand or verified recipe appstore behavior | High-ticket AI hardware service demand does not prove Blockless marketplace demand |
| [SnapMagic](https://www.snapmagic.com/) | AI copilot for electronics design, CAD-model database, circuit autocomplete, BOM cost/power optimization, supply-chain alternatives | Physical prototype firmware loop or recipe rerun | Component/CAD/supply-chain context is an adjacent hardware data moat |
| [tscircuit](https://tscircuit.com/) | Electronics-as-code, TypeScript/React circuits, browser previews, registry, AI-agent skill, GitHub visual diffs, fabrication exports | Sensor/actuator firmware deployment and repair | Hardware-as-code can own reusable packages in PCB land; Blockless must own device recipes |
| [KiCad](https://www.kicad.org/) | Mature open-source schematic capture, PCB layout, SPICE, 3D viewer, package ecosystem | AI workflow or physical devkit recipe loop | Open ECAD plus AI agents is a credible substrate |

## Simulation, Education, and Visual Programming Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Wokwi docs](https://docs.wokwi.com/) | Browser simulation, sharing, debugging, Wi-Fi/logic analyzer/custom chip workflows | Physical deployment success | Education/beginner wedge may prefer simulation |
| [Wokwi pricing](https://wokwi.com/pricing) | Pricing around build minutes, unlisted projects, custom libraries, private IoT gateway, VS Code/offline plugin, CI minutes, classroom licenses | Real hardware recipe value | Simulation/classroom workflows can monetize without physical-first hardware |
| [MakeCode docs](https://makecode.com/docs) | Blocks, JavaScript/Python, simulator, hardware learning ecosystem | That MakeCode covers Blockless's module matrix | "No-code hardware for beginners" already exists |
| [Tinkercad Circuits](https://www.tinkercad.com/learn/circuits) | Browser circuit learning/simulation around electronics/Arduino | Real-device recipe reproducibility | Classroom claims need block/simulation baseline |
| [Visuino](https://www.visuino.com/) | Visual programming for Arduino/ESP32/RPi/STM32-class hardware | AI or recipe depth | Visual inspectability is a serious alternative to natural language |
| [Mind+](https://mindplus.cc/) | Visual/block educational hardware programming ecosystem | Western market adoption or Blockless task fit | Education/no-code wedge is already occupied |
| [Mixly](https://mixly.org/) | Long-running visual/block hardware programming ecosystem | Commercial moat or US wedge | Blocks are not new; NL must prove better outcomes |

## Distribution and Tutorial Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Arduino Project Hub](https://projecthub.arduino.cc/) | Large project/tutorial community tied to Arduino hardware | That tutorials are reproducible or faster | Incumbent appstore is tutorial/community |
| [Adafruit Learn](https://learn.adafruit.com/) | Thousands of product-linked guides and libraries | That Blockless cannot beat tutorials | Hardware-store plus guide flywheel is a distribution threat |
| [Seeed Wiki](https://wiki.seeedstudio.com/) | Product-specific docs for boards/modules/Grove ecosystem | That Seeed will add AI | Vendor catalogs already own hardware trust |
| [Hackster](https://www.hackster.io/) | Hardware project community with parts/code/story | Rerun reliability or paid recipe behavior | Blockless must beat project galleries on rerun success |
| [Instructables Circuits](https://www.instructables.com/circuits/) | Broad maker tutorial/community behavior | Professional recipe demand | Tutorials remain the default distribution object |
| [IFTTT](https://ifttt.com/explore/new_to_ifttt) | Trigger/action automation mental model | Hardware recipe workflow | "If this then that" is a familiar analogy, not a moat |

## IoT App, Automation, and Edge AI Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Node-RED](https://nodered.org/) | Low-code event-driven apps, data collection/transform/visualization, edge/cloud deployment, 5,000+ community nodes/flows | Board/module/pin selection or firmware generation from hardware intent | Trigger/action workflows are mature; Blockless must own device creation |
| [Adafruit IO](https://learn.adafruit.com/adafruit-io) | Product-linked IoT cloud/tutorial layer for feeds, dashboards, and hardware guides | General recipe registry or hardware compatibility graph | Vendor cloud plus guides can absorb simple sensor-to-app jobs |
| [Ubidots docs](https://ubidots.com/docs/) | IoT APIs, device catalog, firmware libraries/examples, dashboards/platform docs | Hardware intent-to-flash workflow | Sensor events to dashboards/apps are commodity in IoT platforms |
| [Edge Impulse](https://www.edgeimpulse.com/) | Dataset, train, optimize, and deploy loop for edge AI on MCUs/gateways/sensors/cameras | General physical recipe generation | "AI on hardware" is a separate mature workflow; do not conflate with Blockless |
| [SenseCraft](https://sensecraft.seeed.cc/) | Seeed's no-code AIoT platform claims no-code AI vision/sound/vibration workflows, 400+ pre-trained models, one-click deployment, HMI templates, fleet deployment, and coming "AI vibe-coding for hardware" | Same-task recipe reliability or Blockless superiority | Hardware-vibe-coding language is already contested by vendor AIoT platforms |
| [Blues Developer Center](https://dev.blues.io/) | Connected-product workflow with Notecard, SDKs, Notehub routing, monitoring, fleet management, remote firmware updates, and cellular/satellite/LoRa/Wi-Fi positioning | Blockless recipe generation or maker demand | Connected-product recurring value may belong to connectivity/fleet infrastructure |
| [ThingsBoard](https://thingsboard.io/) | Open-source IoT platform for device management, telemetry collection, visualization, rule chains, SCADA, edge, gateways, MQTT broker, and mobile apps | Physical recipe creation or board/module compatibility | Production IoT system-of-record claims need ThingsBoard-style baseline |
| [Hologram](https://www.hologram.io/) | Cellular IoT connectivity, SIM management, outage protection, global coverage, pre-deployment testing, and premium support | Firmware recipe workflow | In production IoT, connectivity reliability/support can be the pain users pay for |
| [Viam](https://www.viam.com/) | Robotics software platform with hardware APIs, driver/ML model registry, remote access/control, fleet monitoring, and OTA for software/ML models | Intent-to-devkit recipe generation, wiring/pin/package repair, or second-user recipe rerun | Broad "physical-world programmable" claims need robotics lifecycle baselines or narrower recipe language |
| [Golioth docs](https://docs.golioth.io/) | IoT cloud services for embedded devices: secure connectivity, OTA, device management, logs, settings, RPC, data routing, SDK support for Zephyr, nRF Connect SDK, ESP-IDF, and ModusToolbox | Natural-language hardware creation or reusable recipe artifacts | Zephyr/ESP-IDF fleet/device-cloud claims require Golioth-style baseline |
| [Losant](https://www.losant.com/) | Enterprise IoT app-enablement with low-code workflows, dashboards, provisioning, digital twins, multi-tenancy, edge agent, and industrial IoT positioning | Board/module/pin selection, firmware repair, or maker recipe demand | Low-code IoT app/platform claims require app-enablement baselines |
| [Zerynth](https://zerynth.com/) | Industrial AI copilot/IoT core for factories with edge devices, dashboards, anomaly detection, machine control, ERP/MES integrations, and services | Maker recipe superiority or Blockless demand | Industrial AI/IoT claims are different-buyer claims, not maker recipe TAM |

## Live / Visual Physical-Computing Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [MicroBlocks](https://microblocks.fun/) | Blocks programming language for physical computing, live execution on microcontrollers, real-time sensor values/graphs, portability across supported boards, no compile/download wait | Natural-language recipes, wiring repair, or marketplace demand | Do not claim live hardware iteration or no compile wait is unique |
| [XOD docs](https://xod.io/docs/) | Visual/dataflow hardware programming with browser/desktop IDE, hardware nodes/libraries, XOD Cloud, supported hardware, and project showcase | AI intent-to-hardware or verified recipe quality | No-code physical computing is an old category; Blockless must prove NL plus verified recipes wins |

## Software Vibe-Coding Analogy Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Cursor](https://cursor.com/features) | Agentic code editing, codebase context, review/CLI/cloud agent surfaces | Hardware users will pay or repeat | Use artifact-loop analogy only |
| [Lovable](https://lovable.dev/) | Prompt-to-app, deployment/templates/live app positioning | Hardware market demand | Live URL analogy must become real-device proof |
| [Replit Agent docs](https://docs.replit.com/references/agent/overview) | Prompt-to-running software app workflow | Physical deployment/reproduction | Hardware needs deploy/log/rerun equivalents |
| [Bolt docs](https://support.bolt.new/building/intro-bolt) | Browser prompt-to-app workflow | Hardware creation demand | Sets user expectation for instant artifact |
| [v0](https://v0.dev/) | Prompt-to-UI/app generation category | Hardware viability | Shows artifact expectations, not hardware proof |
| [Base44](https://base44.com/) | Prompt-to-app/product category | Hardware user behavior | Analogy source only |
| [Windsurf](https://windsurf.com/) | Agentic IDE positioning | Hardware task performance | Analogy source only |
| [GitHub Copilot coding agent docs](https://docs.github.com/en/copilot/concepts/about-copilot-coding-agent) | PR/branch/test/review oriented coding-agent workflow | Hardware workflow success | Blockless needs equivalents of PR, CI, deploy, logs |

## Market and Trust Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [Yole Status of the Microcontroller Industry 2024](https://www.yolegroup.com/product/report/status-of-the-microcontroller-industry-2024/) | Historical notes cite this class of source for MCU shipment/market scale, but the current pass did not capture a usable primary page/report | Blockless TAM, creator workflow frequency, paid recipe demand | Do not use MCU shipment volume as core market proof unless the report is restored and the claim is narrowed to industry background |
| [Arduino UNO Q / Qualcomm-Arduino coverage](https://www.theverge.com/news/794452/qualcomm-arduino-acquisition-uno-q) | Media coverage reports Arduino/Qualcomm acquisition context and more than 33M Arduino community/users; Arduino official pages support the App Lab/UNO Q platform surface | Monthly active hardware builders, Blockless conversion, paid recipe demand | Arduino scale is ecosystem/distribution pressure, not Blockless TAM |
| [Raspberry Pi Holdings reporting context](https://investors.raspberrypi.com/) | Raspberry Pi is now a public-company hardware ecosystem with very large cumulative unit sales and significant industrial/embedded demand in public reporting | Maker recipe buyers or Blockless active users | Cumulative board sales are not monthly active creator demand |
| [Kickstarter about/statistics](https://www.kickstarter.com/about) | Kickstarter platform scale and crowdfunding behavior can show launch-channel demand for creative/product campaigns | Recurring workflow demand, appstore liquidity, or subscription behavior | Kickstarter is a launch-channel comp, not ARR proof |
| [Anthropic Model Context Protocol announcement](https://www.anthropic.com/news/model-context-protocol) | MCP standardizes connections between AI assistants and data sources, tools, and development environments | Hardware execution, recipe quality, or Blockless moat | Do not claim "tool access/context access" is unique; moat must be verified hardware outcomes |
| [Model Context Protocol documentation](https://modelcontextprotocol.io/introduction) | MCP is a general open-source standard for connecting AI applications to external systems, tools, and workflows | That MCP solves hardware compatibility or physical debugging | Treat agent plumbing as commodity pressure |
| [GitHub Copilot MCP docs](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide) | Mainstream IDE agents can use MCP to connect to outside systems and share context | That Copilot solves hardware tasks | Benchmark against agentic IDE/CLI workflows, not only chat |
| [OpenAI agent tools announcement](https://openai.com/index/new-tools-for-building-agents/) | General agent infrastructure includes tool use, SDK orchestration, computer use, and tracing/observability | Hardware-specific run/repair/reproducibility | Blockless must show hardware-specific workflow state, not generic agent capability |
| [Stack Overflow 2025 AI survey](https://survey.stackoverflow.co/2025/ai) | AI tool adoption can coexist with trust concerns | Hardware users will adopt/pay | Do not infer trust from adoption |
| [DORA 2025 AI-assisted software development report](https://dora.dev/research/2025/dora-report/) | AI is an amplifier of organizational strengths and weaknesses; ROI depends on underlying systems | Hardware productivity gains from adding AI alone | Blockless must improve the whole hardware workflow, not only generation |
| [GitHub Octoverse 2024](https://github.blog/news-insights/octoverse/octoverse-2024/) | AI correlates with growing developer/AI activity; GitHub frames AI as a broad ecosystem force | That AI alone caused developer growth or that hardware will follow | Use as ecosystem context, not TAM proof |
| [Agentic Much? arXiv 2601.18341](https://arxiv.org/abs/2601.18341) | Coding-agent adoption can be measured through GitHub traces and appears rapid in software projects | Hardware-agent adoption or recipe-market formation | Blockless needs equivalent trace data: reruns, forks, repairs, publish events |
| [METR 2025 AI experienced OSS developer study](https://arxiv.org/abs/2507.09089) | AI can feel faster while measured productivity worsens in a studied software setting | That all AI coding is slower; hardware outcome | Benchmark actual time; perception is not enough |
| [AI-assisted programming maintenance-burden paper](https://arxiv.org/abs/2510.10165) | AI-generated code may increase rework/review burden on experienced maintainers | Direct hardware support burden | Measure whether Blockless reduces support or shifts debugging to experts |
| [METR blog](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | Plain-language study framing and caveats | Direct hardware conclusion | Use as caution against vibe-coding overreach |
| [Sonar AI code quality report](https://www.sonarsource.com/resources/white-papers/the-state-of-ai-code-quality/) | AI code quality/trust framing | Hardware product demand | Use only for caution around generated code quality |
| [TechCrunch Cursor/Anysphere June 2025](https://techcrunch.com/2025/06/05/cursors-anysphere-nabs-9-9b-valuation-soars-past-500m-arr/) | Reported Cursor funding/valuation/ARR and individual-plus-enterprise monetization | Blockless subscription behavior | Cursor proves software willingness to pay, not hardware repeat frequency |
| [TechCrunch Lovable July 2025](https://techcrunch.com/2025/07/17/lovable-becomes-a-unicorn-with-200m-series-a-just-8-months-after-launch/) | Reported Lovable growth, users, paying subscribers, project creation, and nontechnical traction | Durable user monetization or hardware-market behavior | Project creation does not equal reproducible hardware or paid recipes |
| [Business Insider Lovable user report June 2026](https://www.businessinsider.com/lovable-arr-hit-500-million-surprising-facts-about-its-users-2026-6) | Reported Lovable user composition and monetization lag among builders | That Blockless users will monetize hardware recipes | Use as warning: creation volume can precede monetization |
| [FT Cursor/Anysphere article](https://www.ft.com/content/a7b34d53-a844-4e69-a55c-b9dee9a97dd2) | Reported market signal for AI coding if accessible/source-valid | Hardware market behavior | Do not use software ARR as hardware ARR proof |

## Pricing and Monetization Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [PleaseDontCode pricing](https://www.pleasedontcode.com/pricing/) | Direct AI firmware workflow charges by credits/devices/private projects/OTA tiers | Paid conversion, retention, recipe willingness-to-pay | Competitor pricing exists; Blockless must test its own paid unit |
| [Embedr pricing](https://www.embedr.app/pricing) | Embedded AI workspace charges by model access, AI credits, pro PCB automation, and team/enterprise path | Blockless buyer demand | Pro users may expect seat/workspace pricing, not recipe marketplace |
| [Blynk pricing](https://www.blynk.io/pricing) | IoT cloud charges by devices/users/messages/retention/SLA/support | Hardware creation workflow | Device/app recurring value may belong to IoT platforms |
| [Particle pricing](https://www.particle.io/pricing/) | IoT deployments charge by device/data-operation blocks and enterprise services | Maker or recipe monetization | Fleet monetization is not recipe monetization |
| [Wokwi pricing](https://wokwi.com/pricing) | Simulation charges by build minutes, privacy, VS Code/offline plugin, CI, classroom | Physical recipe demand | Education may pay for simulation instead of physical-first |
| [Flux pricing](https://www.flux.ai/pricing) | AI hardware design charges by seats/editors, AI credits, private projects, imports, workspace, enterprise controls | Blockless appstore demand | AI hardware SaaS pricing exists in adjacent ECAD, but not as recipe proof |

## Research Paper Sources

| Source | What it supports | What it does not prove | Deck consequence |
|---|---|---|---|
| [arXiv 2412.09058](https://arxiv.org/abs/2412.09058) | LLM/hardware workflow research direction and benchmark framing | Commercial product superiority | Context injection is known; moat must be verified run data |
| [arXiv 2603.19583](https://arxiv.org/abs/2603.19583) | Academic pressure around LLMs for embedded/IoT/circuit tasks | Market demand | Research makes "first/only" claims harder |
| [arXiv 2601.04505](https://arxiv.org/abs/2601.04505) | Academic benchmark/generation pressure | Product adoption | Benchmarks, not slogans, decide technical claims |
| [arXiv 2605.30345](https://arxiv.org/abs/2605.30345) | Academic pressure around schematic/circuit generation | Blockless recipe superiority | Must specify recipe/run-log gap |
| [arXiv 2606.01188](https://arxiv.org/abs/2606.01188) | Natural-language to editable KiCad schematics with component search, datasheet grounding, checks, and benchmark results | Physical devkit run/repair/reuse workflow | Schematic generation is moving quickly; Blockless must avoid "LLM hardware context is unique" |
| [arXiv 2602.00510](https://arxiv.org/abs/2602.00510) | Constraint-guided LLM schematic design for PCB tasks | Commercial adoption or recipe-market demand | Academic work will keep eroding broad first/only claims |
| [arXiv 2604.00270](https://arxiv.org/abs/2604.00270) | Multimodal schematic understanding benchmark and current LMM gaps | Blockless superiority | Supports caution: hardware diagrams/context remain brittle |
| [arXiv 2603.03605 Inline hardware-log paper](https://arxiv.org/abs/2603.03605) | Embedded debugging is hard because software and hardware issues intertwine; real-time hardware log visualization is an active product/research surface | That Blockless repairs failures better | Serial/run logs must be first-class product evidence, not just LLM input |
| [arXiv 2506.13538 MCP server study](https://arxiv.org/abs/2506.13538) | MCP is emerging as a de facto standard and introduces specific security/maintainability risks | Hardware workflow success | Agent-tool plumbing is both commoditizing and risky; Blockless needs controlled tool governance |

## Claim-to-Source Rules

### Allowed with current sources

- "Existing tools solve pieces of AI hardware creation."
- "PleaseDontCode publicly claims much of the closed loop."
- "AI PCB/ECAD automation is a serious adjacent category."
- "Simulation and blocks are serious alternatives for education."
- "PlatformIO/ESPHome/Arduino Cloud/Blynk/Particle make board, package, IoT,
  and device workflows mature enough to be baselines."
- "IoT dashboard, endpoint, automation, OTA, and device-management layers are
  not unique to Blockless."
- "Edge AI/no-code AIoT and connected-product platforms are separate baselines
  before using AI-on-hardware, hardware vibe-coding, fleet, or production IoT
  language."
- "Robotics lifecycle and industrial IoT platforms are separate baselines
  before using physical-world-programming, factory AI, app-enablement, or
  fleet/OTA/device-cloud language."
- "Live/visual physical-computing tools already challenge no-code, live
  iteration, and no-compile claims."
- "Vibe-coding software tools show a useful artifact-loop analogy."
- "AI adoption does not automatically imply trust or measured productivity."
- "Agent tool plumbing is becoming standardized; Blockless's moat must be
  verified hardware execution data, not generic tool access."

### Not allowed with current sources

- "Blockless is first."
- "Competitors only generate code."
- "AI hardware is empty."
- "Blockless beats PleaseDontCode."
- "Blockless is the leading AI hardware builder" without narrowing the category.
- "MicroPython is 10x better for embedded hardware."
- "The Hardware App Store will work."
- "Users will pay because Cursor/Lovable users pay."
- "Hardware sales will be 70 percent of revenue."
- "$100M ARR is a realistic scenario" without bottom-up behavior assumptions.
- "Generic AI cannot compete because it lacks hardware context."

### Requires benchmark evidence

- "Blockless is faster."
- "Blockless has higher first-run success."
- "Blockless repairs hardware failures better."
- "Blockless recipes are more reproducible than tutorials or competitor
  projects."
- "MicroPython hot reload matters more than Arduino/PlatformIO compile/upload."
- "Blockless beats ESPHome/Tasmota on home-automation-style sensor/actuator
  workflows."
- "Blockless beats Viam/Golioth/Losant/Zerynth on robotics, production IoT,
  industrial app-enablement, or device-cloud workflows."
- "Blockless beats MicroBlocks/XOD on live or visual physical-computing
  workflows."
- "Blockless produces a better reusable artifact than tscircuit/Flux in its own
  artifact category."
- "Blockless beats an agentic IDE/CLI with docs retrieval, command execution,
  flash tooling, and serial-log inspection."

### Requires market behavior evidence

- "Users build second and third projects."
- "Recipe reruns/forks happen."
- "Users pay for recipes/packages."
- "Users buy kits after recipe preview."
- "Schools or vendors pay for curated recipe libraries."

## Diligence Rule For Future Deck Edits

Before adding a strong sentence to the deck, classify its source:

1. Is it from official docs/marketing/press/paper/benchmark/user data?
2. Does that source type support the exact sentence?
3. What would falsify it?
4. Is the sentence safe today, benchmark-gated, market-gated, or forbidden?

If the answer is unclear, use the weaker sentence.
