# Blockless clarity research memo

Last updated: 2026-06-11

## Core claim

Blockless should not be framed as "AI writes hardware code." That category is
too broad, too easy to copy, and too close to ordinary code assistants.

The sharper category is:

> Blockless is a verified hardware workflow and package system. A user describes
> an intent in one sentence; Blockless turns it into a runnable, repairable,
> reproducible, and distributable hardware recipe.

The moat is the hardware execution context: board profiles, module manifests,
driver contexts, pin capability graphs, package versions, install methods,
known failures, repair hints, serial/run logs, and verified recipes.

Adversarial correction after competitor review:

> The "closed loop" claim is not enough by itself. PleaseDontCode already claims
> board selection, AI wiring, ready firmware, compatible libraries, verified pin
> assignment, compile, automatic compile-fix, USB flashing, OTA deployment,
> dashboards, remote serial console, version history, and public projects.

Therefore Blockless must make a narrower and more defensible claim:

> Blockless wins only if its recipe object is more reproducible, forkable, and
> hardware-context-rich than a generated code project. The proof is not that AI
> can flash a board. The proof is that another user can rerun/fork/publish the
> same hardware package with fewer hidden assumptions and less debugging.

This changes the burden of proof. The deck should not say "others stop at
code" unless that is specifically true for a named competitor. The stronger
line is:

> Competitors increasingly automate generation and flashing. Blockless must own
> the durable artifact after the flash: verified recipes plus the compatibility,
> repair, package, and run-log data that compound across users.

## Live-source refresh: what changed after checking current sources

This refresh treats current public sources as pressure against Blockless, not as
supporting evidence. The goal is to identify which claims survive contact with
existing products.

### PleaseDontCode raises the bar for "closed loop"

Current source evidence: PleaseDontCode's homepage says the product goes from
idea to firmware, selects sensors/actuators, creates wiring, flashes through
USB or Wi-Fi, and provides remote monitoring. Its FAQ says it supports 29+
boards, uses compatible libraries and verified pin assignments, compiles
through Arduino CLI, auto-fixes build errors, flashes from the browser, supports
POTA OTA updates, preserves versions, exposes dashboards, and includes remote
serial logs.

Implication:

- Blockless cannot safely say "competitors stop at code."
- "Closed loop" is not a defensible category by itself.
- The only credible gap to test is whether Blockless produces a richer,
  second-user-rerunnable recipe artifact than PleaseDontCode's project/code/
  firmware/dashboard model.

Tough question:

> If PleaseDontCode already has pin maps, wiring, compile, auto-fix, browser
> flash, OTA, dashboard, version history, public projects, and remote serial
> console, what exactly is the Blockless recipe object that a user values more?

Source: https://www.pleasedontcode.com/

### Cirkit Designer attacks the beginner and classroom wedge

Current source evidence: Cirkit Designer positions itself as AI circuit design
and simulation for Arduino, ESP32, and Raspberry Pi Pico. It claims AI wiring,
code generation, circuit-aware questions, browser firmware simulation, project
sharing, exported diagrams, custom parts with pin definitions, and browser
upload to real Arduino/ESP32/Pico hardware.

Implication:

- A teacher, beginner, or classroom may prefer simulation before real hardware.
- A shareable simulation link may beat a physical recipe when the user's goal
  is learning, not deploying.
- Blockless needs to justify why real-device verification matters more than
  simulation-first speed for the chosen v1 wedge.

Tough question:

> If the buyer is a school, why is "30 real boards working" a better starting
> point than "30 students can simulate immediately and only flash later"?

Source: https://www.cirkitdesigner.com/

### PlatformIO proves board/package abstraction is table stakes

Current source evidence: PlatformIO describes itself as a cross-platform,
cross-architecture, multi-framework tool for embedded engineers. Its docs say
users choose boards in `platformio.ini`; PlatformIO downloads toolchains,
handles dependencies, compiles, and uploads to boards. It also includes
debugging, unit testing, static analysis, remote development, cloud/desktop IDE
integrations, library management, platforms, frameworks, and board registries.

Implication:

- Blockless should not imply that board/package/dependency tooling is new.
- Generic AI plus PlatformIO is a serious baseline, not a strawman.
- Blockless's differentiation must be intent-to-hardware-context-to-recipe, not
  "we install packages."

Tough question:

> If Cursor/ChatGPT can generate a PlatformIO project and PlatformIO handles
> board/toolchain/library complexity, what failure class remains uniquely
> Blockless-owned?

Source: https://docs.platformio.org/en/latest/what-is-platformio.html

### ESPHome proves declarative hardware workflows already work

Current source evidence: ESPHome turns ESP32, ESP8266, RP2040, BK72xx, nRF52,
RTL87xx, Beken, and related boards into smart home devices through YAML
configuration. It emphasizes no C++ coding, OTA updates, hundreds of sensors,
displays, and components, local control, preconfigured projects, device
database, automations, guides, and cookbook patterns.

Implication:

- For smart-home sensor/actuator workflows, "no-code hardware config" is
  already real.
- Blockless must avoid positioning itself as merely "natural language to
  sensor automation" unless it can beat ESPHome on setup, repair, reuse, or
  app distribution.
- ESPHome's component catalog is a concrete comparable for Blockless module
  manifests.

Tough question:

> For "temperature > 30 turns on fan," why is Blockless better than a generated
> ESPHome YAML plus Home Assistant?

Source: https://esphome.io/

### Wokwi proves simulation can be the stronger share artifact

Current source evidence: Wokwi is an online electronics simulator for Arduino,
ESP32, STM32, and many boards/parts/sensors. Its docs emphasize starting
without parts or large downloads, safe mistakes, sharing a project link, Wi-Fi
simulation, virtual logic analyzer, GDB debugging, SD card simulation, custom
chips, and VS Code integration.

Implication:

- Blockless's appstore must be more than a project gallery; Wokwi already makes
  sharing easy.
- Physical verification is the advantage only if users care about real-device
  deployment more than learning speed.
- Simulation may be a required preflight layer, or a deliberate non-goal that
  Blockless must explain clearly.

Tough question:

> If Wokwi can separate software errors from hardware errors before the user
> touches parts, does Blockless need a simulator/static-check stage before
> flash?

Source: https://docs.wokwi.com/

### Schematik owns the broad "Cursor for hardware" media frame

Current source evidence: Schematik's site now presents itself as an AI hardware
IDE for Arduino, ESP32, and Pico and links to a $4.6M pre-seed announcement.
WIRED's April 18, 2026 profile calls it "Cursor for Hardware," says users
describe physical devices, get parts/build guidance and purchase links, and
frames the safety issue around AI understanding electronics deeply enough not
to create dangerous wiring. The article also says Schematik targets low-voltage
three- to five-volt projects for now.

Implication:

- "Cursor for hardware" is already occupied as a public phrase.
- Blockless should either avoid the phrase or define a narrower category:
  verified, rerunnable modular hardware recipes.
- Schematik may be stronger at parts/assembly guidance; Blockless may be
  stronger only if it proves real runtime repair and recipe reproducibility.

Tough question:

> If Schematik helps the user buy and assemble the right parts before coding,
> is Blockless entering too late in the workflow?

Sources:

- https://www.schematik.io/
- https://www.wired.com/story/schematik-is-cursor-for-hardware-anthropic-wants-in-on-it/

### Vibe-coding market analogy is powerful but not portable by default

Current source evidence:

- Cursor's current site frames the product as a coding agent with agents, cloud
  agents, CLI, review, codebase understanding, PR/GitHub/Slack workflows, and
  enterprise usage.
- Lovable's current site frames the product as chat-to-apps/websites with
  real-time prototype generation, one-click deployment, templates, and app
  visits.
- Stack Overflow's 2025 Developer Survey reports high AI-tool usage or planned
  usage, but also says positive sentiment fell and more developers distrust AI
  tool accuracy than trust it.
- The 2025 arXiv/METR RCT on experienced open-source developers found AI tools
  increased completion time by 19% in the studied setting, despite developers
  forecasting and later perceiving time savings.

Implication:

- The software market proves users pay for AI-native workflows, but it does
  not prove hardware users will pay or repeat.
- Cursor/Lovable work because the artifact is instantly inspectable: code,
  branch, PR, preview, deployment, live URL, logs, review, usage.
- Hardware lacks instant artifact inspection unless Blockless creates an
  equivalent: real-device proof, serial/run log, recipe diff, compatibility
  matrix, endpoint manifest, rerun history.
- AI adoption does not imply trust; Blockless's physical domain needs stronger
  verification than a software demo.

Tough question:

> If experienced software developers can feel faster while measured completion
> time gets worse, what will prevent hardware beginners from feeling "AI magic"
> while actually spending more time debugging wiring and packages?

Sources:

- https://cursor.com/features
- https://lovable.dev/
- https://survey.stackoverflow.co/2025/ai
- https://arxiv.org/abs/2507.09089

### Immediate claim downgrades from this refresh

Use these until benchmark evidence says otherwise:

| Old claim | Downgraded claim |
|---|---|
| "Competitors only generate code." | "Competitors increasingly cover wiring, flashing, dashboards, simulation, and sharing; Blockless focuses on verified recipes and run-log-backed reproducibility." |
| "Blockless is the first closed-loop AI hardware workflow." | "Blockless is testing whether verified recipes are the right durable artifact for AI hardware workflows." |
| "Vibe coding proves this market." | "Vibe coding proves appetite for AI-native creation; hardware still needs separate evidence for repeat use, real-device success, trust, and payment." |
| "Hardware appstore is obvious." | "A verified recipe registry is plausible; a marketplace is unproven until reruns, forks, and paid transactions exist." |
| "MicroPython makes hardware easy." | "MicroPython is a narrow v1 wedge; it must beat Arduino/PlatformIO/ESPHome baselines on the chosen tasks." |

## Adjacent incumbent refresh: why the wedge must stay narrow

The direct AI-hardware competitors are not the only threat. Adjacent incumbents
already own pieces of the workflow, distribution, education, and device cloud.
These sources make the broad "AI hardware appstore" story weaker and make the
narrow "verified recipe" story more important.

### Arduino Cloud and Blynk pressure the cloud/app layer

Current source evidence: Arduino Cloud presents one place to connect devices,
visualize data, control devices, trigger automations, share dashboards, and
integrate with IoT and Matter projects. Arduino's documentation covers Things,
variables, dashboards, sketches, OTA uploads for supported boards, and device
templates. Blynk's documentation centers on templates, datastreams, web/mobile
dashboards, events, automations, firmware API, device activation, and fleet
management.

Implication:

- "Send sensor events to my app" and "show dashboard/control device" are not
  unique products.
- Blockless should not claim that endpoint/app/dashboard distribution is new.
- The app value must be tied to recipe reproducibility and context, not just
  cloud IoT screens.

Tough question:

> If Arduino Cloud or Blynk already solves dashboards, app controls, templates,
> events, automations, and device management, why does Blockless need its own
> appstore instead of exporting verified recipes into those ecosystems?

Sources:

- https://docs.arduino.cc/arduino-cloud/
- https://docs.blynk.io/

### Particle pressures firmware lifecycle and fleet operations

Current source evidence: Particle's docs and developer tools cover Particle
Workbench, Device OS, cloud compile/flash flows, OTA firmware updates, device
setup, console/device management, libraries, Web IDE, CLI, and local toolchain
workflows.

Implication:

- Versioned firmware, OTA, cloud/device management, and production-ish IoT
  workflows are mature elsewhere.
- Blockless cannot treat OTA or device cloud as moat.
- A serious IoT buyer will ask whether Blockless is a prototyping layer, a
  production fleet platform, or an export path into production tools.

Tough question:

> If a user graduates from prototype to fleet, does Blockless remain the system
> of record or become a recipe generator that hands off to Particle/Blynk/
> Arduino Cloud?

Source: https://docs.particle.io/getting-started/developer-tools/workbench/

### MakeCode, Tinkercad, and visual tools pressure the education wedge

Current source evidence: Microsoft MakeCode is a free learning platform that
combines blocks, JavaScript, Python, simulators, hardware targets, tutorials,
and classroom-oriented projects. Tinkercad Circuits is Autodesk's browser-based
electronics learning environment for building/simulating circuits and Arduino
projects. Visuino positions itself around visual programming for Arduino,
ESP32, ESP8266, Raspberry Pi, STM32, Teensy, and similar hardware. Mind+ and
Mixly are visual/block programming environments with extensive hardware library
and education use.

Implication:

- "No code for beginners" is already heavily served.
- For classrooms, visual inspectability may beat natural language because the
  teacher can see and grade the logic.
- Blockless must prove that natural language plus verified recipes reduces
  failure time more than blocks/simulation/tutorials.

Tough question:

> For a 12-year-old or classroom teacher, is a natural-language agent more
> trustworthy than visible blocks and simulation?

Sources:

- https://makecode.com/docs
- https://www.tinkercad.com/learn/circuits
- https://www.visuino.com/
- https://mindplus.cc/
- https://mixly.org/

### Arduino Project Hub, Adafruit Learn, Seeed Wiki, and Hackster pressure distribution

Current source evidence: Arduino Project Hub hosts Arduino projects tied to
boards, parts, code, and tutorials. Adafruit Learn hosts thousands of guides
and links them to Adafruit products and libraries. Seeed Studio Wiki documents
boards, sensors, Grove modules, firmware, tutorials, and product-specific
integration paths. Hackster hosts community hardware projects with parts,
story, code, and build instructions.

Implication:

- The incumbent "hardware appstore" is the tutorial plus hardware-store
  flywheel.
- Blockless recipes must beat tutorials on reproducibility, not merely look
  cleaner.
- If Adafruit/Arduino/Seeed add AI help on top of their catalogs, they already
  have demand, inventory, trust, and content.

Tough question:

> If the user wants to buy real parts, why won't they trust Adafruit, Arduino,
> Seeed, or SparkFun more than a new recipe marketplace?

Sources:

- https://projecthub.arduino.cc/
- https://learn.adafruit.com/
- https://wiki.seeedstudio.com/
- https://www.hackster.io/

### Academic LLM-for-hardware systems pressure the "context injection" moat

Current source evidence: recent papers around embedded/circuit generation and
LLM hardware workflows explore context retrieval, benchmark tasks, circuit or
schematic generation, code generation, and hardware-aware evaluation. The
important lesson is not that papers are commercial products. The lesson is that
"give the model board/module/context and evaluate it on tasks" is already an
obvious research direction.

Implication:

- Context injection is not enough to be a moat.
- The moat has to be proprietary verified execution data and the workflow that
  produces it repeatedly.
- Benchmarks must be external enough that they cannot be dismissed as a demo
  script.

Tough question:

> If research labs can reproduce the context-injection technique, what data does
> Blockless uniquely collect from real users and real failures?

Example sources:

- https://arxiv.org/abs/2412.09058
- https://arxiv.org/abs/2605.30345

### Consequence: four markets, four different proof gates

Blockless should not pitch one generic market. Each wedge has a different
incumbent and a different evidence requirement.

| Wedge | Main incumbents | What Blockless must prove |
|---|---|---|
| Maker prototyping | Arduino/Adafruit/Seeed tutorials, PleaseDontCode, PlatformIO | Faster real-device success and fewer hidden failures |
| Education | MakeCode, Tinkercad, Wokwi, Cirkit, visual tools | Better classroom completion without higher teacher support |
| IoT app/control | Arduino Cloud, Blynk, Particle, ESPHome | Recipes produce reusable device-app workflows, not just dashboards |
| Recipe marketplace | Hackster, Instructables, Adafruit Learn, Project Hub | Rerun/fork/payment behavior beats tutorials and project galleries |

If Blockless cannot win one wedge by measurement, the broad "hardware appstore"
claim should not be used.

## What clarity requires

To reach the same kind of clarity as the early UberCab deck, Blockless needs
less "vision language" and more concrete operating evidence.

### 1. The user job must be obvious

The buyer does not wake up wanting an "AI embedded agent." The buyer wants:

- "I have an idea and a board; make it run."
- "I do not know which module, pin, driver, package, or firmware version works."
- "When it fails, tell me whether the problem is code, wiring, driver, package,
  board, flashing, or runtime."
- "Once it works, make it reusable by me or someone else."

The clean phrase is:

> Say one sentence. Get a real device running. Publish the working recipe.

### 2. The workflow must be a closed loop

The product story should always show the full loop:

1. User intent.
2. Hardware intent parsing.
3. Board/module/driver/package selection.
4. Wiring and pin assignment.
5. Code generation grounded in driver context.
6. Dependency install.
7. Flash/run on real hardware.
8. Serial/run log observation.
9. Automatic repair.
10. Verified recipe output.
11. Fork/rerun/publish through the appstore.

The distinction is that Blockless observes reality. A normal coding assistant
stops after code. Blockless should stop only after a verified run artifact.

### 3. The asset graph must be explicit

Blockless needs to show the graph it owns:

```text
intent
  -> capability
  -> board profile
  -> pin capabilities
  -> module manifest
  -> driver context
  -> package version
  -> install method
  -> generated code
  -> wiring profile
  -> run/serial log
  -> failure classification
  -> repair hint
  -> verified recipe
  -> compatibility matrix
```

This graph is the product. The LLM is only one executor inside it.

### 4. The appstore object must be machine-rerunnable

Blockless appstore is not a tutorial community. It distributes verified hardware
recipes:

- `.mpk` package
- endpoint manifest
- `app_index.json`
- board/module compatibility matrix
- device profile
- wiring profile
- driver/package config
- package version and install method
- known failures and repair hints
- run log proving the recipe worked

A recipe should answer: "Can another user reproduce this on compatible hardware
without rediscovering all the hidden hardware decisions?"

### 5. The wedge must be narrow

The v1 wedge should deliberately limit the matrix. Too many boards/modules
increase failure rate and support cost.

Recommended v1 proof surface:

- 1-2 boards: ESP32-S3 and/or ESP32-C3.
- 8-12 modules: temperature, button, fan/relay, OLED display, RGB LED, simple
  sensor event, buzzer, Wi-Fi endpoint.
- 20-30 verified recipes.
- A repair database built from real failed runs, not imagined failure modes.

### 6. Market behavior must be measured

The biggest unverified risk is not whether the system can generate code. The
risk is whether users behave like this is a workflow, not a toy.

Required metrics:

- First-run success rate.
- Time from sentence to working device.
- Number of repair loops per successful run.
- Second and third project rate.
- Recipe fork/rerun rate.
- Kit purchase or module purchase attach rate.
- Workspace subscription conversion.
- Paid recipe/package purchase rate.
- Percentage of failures classified from serial/run logs.

## Comparable research map

This section should be read as competitive pressure, not validation theater.
For every comparable product, ask: what does it already prove, what part of
Blockless does it weaken, and what evidence would still let Blockless win?

### PleaseDontCode: direct overlap with the full loop

PleaseDontCode is the most dangerous direct comparable found so far. Its public
site says users describe an automation idea, the AI writes code, draws wiring,
generates firmware, flashes by USB or Wi-Fi, monitors devices remotely, and
supports ESP32/RP2040/ESP8266. It claims 29+ boards, verified pin assignment,
compatible libraries, Arduino CLI compilation, automatic compile fixing,
browser USB flashing, POTA OTA updates, dashboards, remote serial console,
version history, and public community projects.

What this teaches Blockless:

- "AI wiring + code + flash" is already a live category.
- "Generic LLMs cannot reason about GPIO/pins/libraries" is not unique; this is
  already how PleaseDontCode positions itself.
- "Community projects" also exists, so Blockless appstore must be more than
  a gallery of generated code.

Hard questions:

- If PleaseDontCode already knows pin maps, voltage, board cores, libraries,
  compiles, auto-fixes, flashes, and monitors, what exact data object does
  Blockless own that they do not?
- Does Blockless's MicroPython loop actually beat their Arduino CLI loop in
  measured time-to-working-device, or is that only assumed?
- Are `.mpk` and verified recipes meaningful to users, or are they internal
  packaging language that users will not value?
- If a PleaseDontCode finalized binary can be reflashed for free and updated
  over Wi-Fi, why would a user switch?
- Does Blockless have a clearer distribution wedge, or is PleaseDontCode's
  public project feed already enough for reuse?

Evidence needed:

- Side-by-side benchmark on the same 10 tasks: PleaseDontCode vs. Blockless.
- Compare first-run success rate, median time to working device, number of
  repair loops, and whether a second user can reproduce the project.
- Show at least 10 cases where Blockless's driver context or recipe metadata
  prevents a failure that a compile-only auto-fix cannot catch.

Source: https://www.pleasedontcode.com/

### Schematik: category validation and category threat

Schematik is a direct narrative threat because it is publicly described as
"Cursor for Hardware" and has been reported as raising $4.6M from Lightspeed.
WIRED describes it as a tool where users describe physical devices and receive
design/assembly guidance, with planned shopping-list integration. The same
article frames the core problem as AI needing to understand electronics deeply
enough to avoid physical mistakes.

What this teaches Blockless:

- The "Cursor for hardware" phrase is no longer a white-space position.
- Investors and media understand the category through vibe-coding analogy.
- Safety and component compatibility are the obvious first questions.

Hard questions:

- If Schematik owns the broad media phrase, should Blockless avoid the phrase
  or deliberately narrow it to "verified recipes for modular hardware"?
- Does Blockless compete with Schematik on the same user, or only after the
  user chooses a modular/MicroPython path?
- Is "MicroPython vs. Arduino/C" a real user-visible advantage, or a founder
  preference? What data proves it?
- If Schematik integrates parts purchasing and assembly guidance faster, does
  Blockless lose the beginner wedge even with better runtime repair?

Evidence needed:

- Confirm Schematik's real output surface by using it or inspecting user-built
  public projects, not just press coverage.
- Build the same device with both tools and record all hidden manual steps.
- Measure whether Blockless users understand "recipe" faster than Schematik
  users understand "guide/parts/build instructions."

Sources:

- https://www.schematik.io/
- https://www.wired.com/story/schematik-is-cursor-for-hardware-anthropic-wants-in-on-it

### Cirkit Designer: simulation-first circuit workspace

Cirkit Designer publicly positions around AI circuit design, browser
simulation, wiring, code generation, circuit-aware questions, firmware running
in the browser, project sharing, custom parts, and browser flashing to Arduino,
ESP32, or Raspberry Pi Pico.

What this teaches Blockless:

- Simulation is a credible way to reduce setup and hardware fragility.
- Education/classroom workflows may prefer simulation before real hardware.
- Sharing a link to a simulated project may be easier than sharing a hardware
  recipe that requires physical parts.

Hard questions:

- Should Blockless add simulation, or explicitly reject it and own physical
  verification?
- If a teacher wants 30 students to learn sensors, is Blockless better than
  Cirkit before every student has a working kit?
- Does Blockless need a "dry run" verifier before flashing, or will real
  hardware repair loops be too slow/fragile for beginners?

Evidence needed:

- Compare classroom setup time: Cirkit simulation vs. Blockless physical kits.
- Identify which v1 recipes genuinely need physical verification and which
  could be simulated well enough.

Source: https://www.cirkitdesigner.com/

### Embedr: AI-native Arduino IDE

Embedr calls itself an agentic IDE for embedded developers. It claims
board-level and pin-aware context, Arduino/ESP32/ESP8266 support, write/compile
/upload, serial monitor, terminal/output, library manager, board options,
automatic checkpoints, Git, hardware/datasheet context, model-agnostic AI, and
visual circuit preview.

What this teaches Blockless:

- "AI IDE for embedded developers" is already crowded.
- Git checkpoints, serial monitor, library manager, and pin-aware context are
  table stakes for developer-facing positioning.
- Blockless cannot win by sounding like a better Arduino IDE unless it proves
  a different artifact and audience.

Hard questions:

- Is Blockless for embedded developers, makers, schools, small businesses, or
  nontechnical creators? Each group will compare against different tools.
- If Embedr goes deeper into Arduino/PlatformIO, does Blockless's MicroPython
  focus look like simplification or limitation?
- Are board profiles and driver contexts enough of a moat if competitors also
  claim board/pin/datasheet context?

Evidence needed:

- Interview users after showing both product pages. Ask what they think each
  product does and which one they would trust with a real board.
- Prove Blockless's context is structured and reusable, not just prompt context.

Source: https://www.embedr.app/

### Aily Blockly: open-source AI hardware IDE

Aily Blockly is an open-source hardware IDE with AI-assisted programming,
project management, per-project board/library management via npm, 200+ common
libraries, serial debugging, AI project generation, board/module/library
recommendations, architecture and pin diagrams, AI code generation, AI library
conversion, AI board configuration generation, and planned simulation. It is
alpha and not recommended for mass-production firmware, but it is a serious
open-source comparable.

What this teaches Blockless:

- Per-project board/library isolation is a known pain and already implemented
  elsewhere.
- AI project generation can include board, module, library, architecture, and
  wiring suggestions.
- MicroPython support alone is not a durable moat if others add it.

Hard questions:

- Is Blockless's package intelligence better than Aily's library conversion and
  board configuration generation, or just different?
- What would prevent Aily from adding recipe publishing?
- Does Blockless have any data advantage that compounds faster than an
  open-source community can collect libraries and boards?

Evidence needed:

- Compare driver/package schema quality against Aily's library metadata.
- Track how much manual work is required to add a new module in each system.

Source: https://github.com/ailyProject/aily-blockly

### ArduinoGPT and small open-source clones: commoditization pressure

ArduinoGPT-style projects are usually smaller than PleaseDontCode, Embedr, or
Aily Blockly, but they matter because they show how easy the first layer is to
clone: natural language prompt, Arduino code generation, compile/upload wrapper,
and serial feedback. Even if many are incomplete or brittle, they compress the
perceived distance between Blockless and a weekend prototype.

What this teaches Blockless:

- "Prompt to Arduino code" is already commoditized.
- A demo that generates code and uploads once will not look defensible.
- Blockless must show structured context, verified recipes, and cumulative
  repair knowledge, not just chat-to-firmware.

Hard questions:

- Which part of Blockless cannot be reproduced by a motivated open-source
  project in a month?
- If the answer is "driver contexts and verified recipes," how many are needed
  before that is credible?
- Does Blockless have a repeatable ingestion/validation pipeline, or is the
  moat manual curation?
- Can a generic coding agent plus PlatformIO plus a good prompt replicate 80%
  of the v1 demo?

Evidence needed:

- Run the same golden-path tasks using ChatGPT/Cursor + PlatformIO/Arduino CLI
  and compare against Blockless.
- Show failures where generic code generation passes compile but fails physical
  behavior, then show Blockless catching or repairing it from structured
  context/logs.
- Track content-maintenance cost per supported module.

Status:

- Treat these as commoditization pressure until individually verified. Do not
  use them as proof that a commercial full-loop competitor exists.

### Academic systems: the hard problem is known

Recent research reinforces Blockless's core intuition but also raises the bar.
EmbedGenius reports component-aware library resolution, library knowledge
injection, auto-programming, and hardware-in-the-loop development across 71
modules, four platforms, and 350+ tasks. IoT-SkillsBench reports that real
hardware execution is necessary because compiling is not enough; concise
human-expert skills with structured knowledge can drive near-perfect success in
hardware-validated experiments. CircuitLM and SchGen both attack schematic
generation by grounding generation in component databases or better schematic
representations.

What this teaches Blockless:

- The research community agrees: hardware context and representation matter.
- "LLM + context" is not unique. The question is whether Blockless has a
  productized data flywheel.
- Benchmarks will matter. Without measured success rates, Blockless's claims
  will sound like the papers' abstracts without the evidence.

Hard questions:

- Can Blockless publish its own benchmark, or would it expose weak coverage?
- What is Blockless's equivalent of "71 modules / 350 tasks / hardware
  execution"?
- Are human-written skills/driver contexts a scalable advantage or an expensive
  content operation?

Evidence needed:

- A public Blockless benchmark with real hardware runs.
- A failure taxonomy tied to serial logs and repair hints.
- A cost model for adding and maintaining each supported module.

Sources:

- https://arxiv.org/abs/2412.09058
- https://arxiv.org/abs/2603.19583
- https://arxiv.org/abs/2601.04505
- https://arxiv.org/abs/2605.30345

### PlatformIO: embedded dependency and board abstraction

PlatformIO proves that embedded developers value cross-platform board,
framework, library, and toolchain management. Its docs position it as a
cross-platform, cross-architecture, multi-framework tool and explicitly name
the pain: setting up board-specific toolchains, IDEs, libraries, and examples.
It also automates downloading required toolchains and uploading to boards.

What this teaches Blockless:

- Board and package context is a real category, not a nice-to-have.
- Dependency automation is core infrastructure.
- The missing layer is natural-language intent, hardware selection, wiring,
  serial-log repair, and recipe distribution.

Source: https://docs.platformio.org/en/latest/what-is-platformio.html

### ESPHome: declarative hardware-to-firmware workflow

ESPHome proves that a constrained hardware configuration can compile, upload,
log, and later update devices over the air. Its docs show YAML configuration,
component catalogs, GPIO pin schema, validation, compile/upload, and dashboard
management.

What this teaches Blockless:

- A component catalog plus pin schema is powerful.
- Validation before upload matters.
- The missing layer is generalized project intent, recipe packaging, broader
  module/package intelligence, and appstore-style reuse.

Source: https://esphome.io/guides/getting_started_command_line/

### Arduino Cloud and Blynk: cloud IoT product surface

Arduino Cloud proves the value of one platform for configuring, programming,
connecting, deploying, and monitoring devices. Its docs expose things,
variables, dashboards, triggers, OTA, webhooks, templates, and device status.

Blynk proves the cloud/app side: dashboards, mobile apps, automations,
notifications, device templates, provisioning, auth tokens, OTA, device data,
and remote control.

What this teaches Blockless:

- Users understand dashboards, triggers, mobile control, and device status.
- The cloud/device/app surface is already validated.
- The missing layer is getting from raw hardware intent to verified firmware
  and wiring without manual setup.

Sources:

- https://docs.arduino.cc/arduino-cloud/
- https://docs.blynk.io/en

### Wokwi: reproducible hardware simulation and shareable projects

Wokwi proves that browser-based electronics simulation reduces setup cost and
helps separate hardware and software issues. Its docs emphasize Arduino/ESP32
simulation, shareable links, logic analyzer, debugging, Wi-Fi simulation, and
community sharing.

What this teaches Blockless:

- Reproducibility and shareability matter.
- Debugging hardware/software boundaries is a known pain.
- The missing layer is real hardware flashing, wiring reality, serial log
  repair, and verified physical recipes.

Source: https://docs.wokwi.com/

### Hackster: tutorial community and distribution demand

Hackster proves that hardware developers already share projects at large scale.
Its about page claims millions of members and tens of thousands of open-source
projects.

What this teaches Blockless:

- There is appetite for learning from and reusing hardware projects.
- But tutorials are human-readable, not machine-rerunnable.
- Blockless should position recipes as the next unit after tutorials.

Source: https://www.hackster.io/about

### IFTTT: trigger-action mental model

IFTTT proves that users understand "if this, then that" automation. Its docs
describe applets made from triggers and actions across many services.

What this teaches Blockless:

- "Temperature exceeds 30 degrees -> turn on fan" is already a mainstream
  mental model.
- The missing layer is grounding that intent into real boards, pins, drivers,
  packages, wiring, and run logs.

Source: https://ifttt.com/explore/new_to_ifttt

### Particle: device OS, version, cloud/local flash

Particle Workbench proves that serious IoT workflows care about target device,
device OS version, local/cloud compile, local/OTA flash, USB flashing edge
cases, and known-state device restore.

What this teaches Blockless:

- Firmware version and flash method are first-class product state.
- Known failure and repair hints belong in the platform, not just support docs.
- Blockless should capture these as recipe metadata.

Source: https://docs.particle.io/getting-started/developer-tools/workbench/

### Tinkercad Circuits and MakeCode: education owns the beginner wedge

Tinkercad Circuits and Microsoft MakeCode are not direct AI competitors, but
they are serious threats to any claim that Blockless uniquely lowers the
hardware barrier. Tinkercad Circuits is a browser-based electronics simulator.
MakeCode is a free Microsoft learning platform with blocks, JavaScript/Python,
simulators, tutorials, device support, and physical-device download paths.

What this teaches Blockless:

- Beginners and schools already have safe, low-setup paths into electronics.
- Simulation and blocks are easier to trust in classrooms than free-form AI.
- "No code" and "no setup" are old promises. Blockless must prove "less
  failure on real devices," not merely "easier to start."

Hard questions:

- For a beginner, is natural language better than blocks, or does it hide the
  system state until something fails?
- For a school, is real hardware repair a feature or an operational burden?
- Does Blockless need a curriculum path, or is education a distraction from
  higher-value prototyping and automation users?
- Can Blockless beat simulation on learning outcomes, or only on final physical
  deployment?

Evidence needed:

- Classroom trial: 20 students with MakeCode/Tinkercad vs. 20 with Blockless.
- Measure setup time, successful completion, help requests, and retention.
- Identify which Blockless recipes are bad fits for beginners and should be
  excluded from v1.

Sources:

- https://www.tinkercad.com/circuits
- https://makecode.com/
- https://github.com/microsoft/pxt

### Visuino, MindPlus, Mixly: visual programming is the old no-code hardware

Visuino positions itself as visual programming for Arduino, ESP32, ESP8266,
M5Stack, Seeeduino, PLC, and Raspberry Pi, using drag-and-drop components and
direct compile/upload. MindPlus describes a zero-barrier creation tool with
block and code programming, AI model training, interface design, many boards,
hardware modules, real-time interaction, offline execution, and 300+ extension
libraries. Mixly is a long-running Chinese graphical programming environment
for Arduino/MicroPython-style education and maker workflows.

What this teaches Blockless:

- The "non-programmer can build hardware" promise has existed for years.
- Visual component graphs can be more inspectable than natural language.
- Libraries/modules are already a product surface in education tools.

Hard questions:

- What does text intent do better than drag-and-drop components?
- Does Blockless have a better debugging story, or just a more magical front
  door?
- If visual tools already generate code and upload, is Blockless's advantage
  only in package/driver context and repair?
- Should Blockless expose the recipe as a visual graph to make hidden decisions
  auditable?

Evidence needed:

- Same-project comparison: visual tool vs. Blockless on a nontrivial sensor +
  actuator + cloud endpoint recipe.
- Measure whether users trust AI-selected pins/modules more or less than
  visually selected components.
- Count how many Blockless repairs require showing the user a graph/table, not
  natural language.

Sources:

- https://www.visuino.com/
- https://mindplus.cc/
- https://mixly.org/

### Arduino Project Hub, Adafruit Learn, Seeed Wiki, Instructables: tutorials
are the incumbent appstore

The incumbent "appstore" for hardware is not an appstore. It is a large body of
tutorials, guides, wikis, and community projects. Arduino Project Hub currently
lists thousands of projects. Adafruit Learn lists thousands of tutorials and
connects learning content to Adafruit hardware/products. Seeed Studio Wiki is
a vendor-maintained hardware knowledge platform with product docs, topics,
forums, Discord, GitHub contribution paths, and technical support channels.
Instructables is a long-running DIY step-by-step project community.

What this teaches Blockless:

- Discovery demand already exists.
- The dominant artifact is still human-readable instruction, not machine
  reproducible package.
- Vendors already own trust through official docs, product pages, and support.

Hard questions:

- Why would users publish to Blockless instead of Arduino Project Hub,
  Hackster, Instructables, or Adafruit Playground?
- What does Blockless give a module vendor that a wiki page and sample code do
  not?
- Can Blockless convert tutorials into verified recipes at scale, or does each
  conversion require manual lab validation?
- Does a verified recipe reduce support cost enough that vendors will fund the
  ecosystem?
- If tutorials are free, who pays for recipe verification and maintenance?

Evidence needed:

- Convert 20 high-traffic tutorials into Blockless recipes and measure how much
  manual work is needed.
- Ask module vendors whether they would pay per verified recipe, per support
  deflection, or per kit sale.
- Measure recipe rerun success across clone parts and hardware revisions.

Sources:

- https://projecthub.arduino.cc/
- https://learn.adafruit.com/
- https://wiki.seeedstudio.com/
- https://www.instructables.com/circuits/

### v0, Base44, Windsurf/Devin, GitHub Copilot: the analogy bar is higher

The software-side analogy has moved beyond code completion. v0 combines AI
generation with templates, design mode, database/API planning, and one-click
deployment to Vercel. Base44 says it turns words into working apps, with
generated backend, auth, data storage, permissions, hosting, analytics, custom
domains, integrations, and app templates. Devin Desktop/Windsurf frames the
IDE as a command center for fleets of agents. GitHub Copilot cloud agent can
research a repo, plan, change code on a branch, run tests/linters in a GitHub
Actions-powered environment, and open pull requests.

What this teaches Blockless:

- The successful analogy is "agent + runtime + deployment + review artifact,"
  not "chat UI + generation."
- Software agents increasingly expose logs, branches, tests, PRs, metrics, and
  collaboration. Blockless needs hardware equivalents.
- GitHub's own framing attacks the weakness of synchronous IDE chat: decisions
  are lost unless committed. Blockless should say the same about hardware:
  pin/package/repair decisions are lost unless captured as recipe metadata.

Hard questions:

- What is Blockless's equivalent of a pull request? A recipe revision? A run
  certificate? A hardware compatibility diff?
- What is the equivalent of CI? Re-running on physical device pools? Simulator
  plus sample hardware? Community run attestations?
- What is the equivalent of "deploy to Vercel"? Flash to device + endpoint live
  + appstore listing?
- Can Blockless show the same collaboration loop: plan, run, review logs,
  accept/reject, publish?
- If vibe-coding users expect instant hosted artifacts, will hardware shipping
  latency break the analogy unless Blockless sells standardized kits?

Evidence needed:

- Define Blockless-native artifacts: recipe revision, run certificate, device
  compatibility diff, repair patch, publish event.
- Build metrics analogous to PR metrics: recipes created, recipes rerun,
  successful reruns, median time to verified run, median time to repair,
  recipe publish-to-fork conversion.
- Show a demo where the user reviews a hardware diff as clearly as a code diff.

Sources:

- https://v0.dev/
- https://base44.com/
- https://windsurf.com/
- https://docs.github.com/en/copilot/concepts/about-copilot-coding-agent

## Blockless category definition

Blockless combines six existing categories into one closed loop:

1. Code assistant: understands user intent and edits code.
2. Embedded package manager: resolves board, package, driver, and version.
3. Hardware configurator: chooses modules, pins, wiring, and capabilities.
4. Device runner: installs dependencies, flashes/runs, reads serial logs.
5. Repair system: classifies failure and retries from observed evidence.
6. Recipe registry: distributes verified, forkable, rerunnable hardware apps.

The category name should be:

> AI hardware workflow platform

The sharper internal name is:

> verified recipe system for real-world hardware

## Vibe-coding analogy under pressure

The strongest pitch analogy is not "hardware is big" or "Kickstarter hardware
sells." It is the software creation-platform arc:

- Cursor: AI-native code editing and codebase work.
- Replit Agent: plain language to apps/artifacts, with project setup, testing,
  fixing, checkpoints, and publishing.
- Lovable: natural language to full-stack web apps with frontend, backend,
  database, authentication, integrations, GitHub sync, collaboration, security,
  and deployment.
- Bolt: prompt to websites/web/mobile apps, in-browser environment, GitHub,
  Stripe, Supabase, hosting, databases, domains, and publishing.

The lesson is not that "AI generates code." The lesson is:

> The winners attach generation to the runtime, deployment surface, iteration
> loop, and durable project artifact.

For Blockless, the equivalent stack is:

```text
prompt
  -> hardware intent
  -> board/module/driver/package context
  -> wiring/code
  -> physical run
  -> logs/repair
  -> recipe/package
  -> rerun/fork/publish
```

If Blockless cannot show the physical equivalent of "live URL in minutes," the
vibe-coding analogy breaks. The physical equivalent is not a generated code
folder. It is a device doing the requested thing, plus a recipe another user can
rerun.

### Where the analogy works

- Software app builders prove users will pay for idea-to-artifact compression.
- Replit/Bolt/Lovable prove end-to-end platforms are stickier than prompt-only
  code generation.
- Checkpoints, testing, deployment, hosting, databases, auth, and payments are
  analogous to Blockless's run logs, repair hints, flash method, package
  versions, device profiles, endpoint manifests, and appstore distribution.
- "No setup required" is the right user promise; Blockless must translate it
  into "no board/package/pin/debug setup required."

### Where the analogy may fail

Hardware has structural friction that web apps do not:

- Physical parts must be purchased, shipped, wired, powered, and sometimes
  replaced.
- Users can wire things wrong in ways software tools cannot observe.
- A successful compile does not prove the sensor works.
- A recipe can be correct and still fail because of clone boards, bad cables,
  wrong voltage, loose wires, counterfeit modules, or different firmware.
- The artifact is harder to share: a URL works for everyone; a hardware recipe
  requires compatible physical inventory.
- Support cost can scale with the hardware matrix faster than revenue.

Hard questions:

- Does Blockless reduce the cost of the physical gap enough for users to build
  more than one project?
- What is the repeat-use habit? Weekly tinkering, school labs, small business
  automation, product prototyping, or module vendor support?
- Is the buyer paying for AI, recipes, kits, workspace, support, or marketplace
  access? These are different businesses.
- Can Blockless create a "publishable artifact" as quickly as Lovable/Bolt
  create a live URL?
- Does the appstore compound from user-generated recipes, or will quality
  control force Blockless to curate every recipe manually?
- Are recipe reruns frequent enough to create a data flywheel, or will most
  recipes be one-off demos?

Evidence needed:

- Time-to-first-running-device benchmark against tutorial, ChatGPT, and at
  least two direct competitors.
- Repeat-project cohort data: day-7 and day-30 second-project rate.
- Recipe reproducibility rate across different users and hardware batches.
- Attach rate from recipe preview to kit/module purchase.
- Support tickets per successful recipe rerun.

Sources:

- https://docs.replit.com/references/agent/overview
- https://docs.lovable.dev/introduction/welcome
- https://support.bolt.new/building/intro-bolt
- https://cursor.com/

## Vibe-coding market evidence: what transfers and what does not

The software-side market signal is real, but it is easy to overread.

Current public reporting and product evidence show:

- Cursor/Anysphere has been reported by the Financial Times as reaching about
  a $9B valuation and roughly $200M ARR in 2025; TechCrunch/other reporting
  later described even larger funding/ARR numbers. Treat these as market
  signals, not product-performance proof.
- Lovable publicly represents the "idea to full-stack app" category and
  TechCrunch reported a $200M Series A at unicorn scale in 2025. Treat this as
  evidence of investor/user appetite for software app generation, not hardware
  demand.
- Replit Agent, Bolt, v0, Base44, Devin/Windsurf, and GitHub Copilot coding
  agent all push the same broader shift: AI moves from autocomplete toward
  planning, running, testing, deploying, and producing reviewable artifacts.

But this supports only one claim:

> Users and investors have accepted AI-native creation workflows when the tool
> produces a working, reviewable, deployable artifact.

It does **not** prove:

- hardware users will pay at the same rate;
- hardware projects have the same iteration frequency as web apps;
- physical parts, shipping, wiring, and device variance can be compressed like
  software dependencies;
- AI output will reduce total work once debugging, safety, and support are
  counted;
- an appstore/marketplace will emerge without measured rerun/fork/payment
  behavior.

### Software market analogy stress test

| Software-side observation | Tempting Blockless inference | Tough question |
|---|---|---|
| Cursor monetized AI-native coding | Hardware will monetize as "Cursor for hardware" | Are hardware builders as frequent and subscription-ready as software developers? |
| Lovable/Bolt create live apps quickly | Blockless can create live devices quickly | Does physical inventory break instant gratification? |
| Replit/v0 handle deployment | Blockless can handle flash/appstore deploy | Is flashing a device equivalent to a globally accessible hosted URL? |
| Copilot agent creates PRs | Blockless can create recipe revisions | Can reviewers inspect wiring/package/compatibility as easily as code diffs? |
| Software templates compound | Hardware recipes will compound | Do recipes rerun across clone boards, module revisions, and wiring variation? |
| AI coding market grew fast | AI hardware market will grow fast | Is hardware creation constrained by desire, or by parts/logistics/support? |

### Negative evidence from software AI also matters

The software AI market is not pure proof of productivity. Developer surveys and
empirical studies continue to report trust, correctness, security, and review
friction around AI-generated code. That matters more in hardware, because a
wrong answer can waste parts, damage hardware, or create unsafe behavior.

Examples:

- Stack Overflow's 2025 survey reports broad adoption/planned adoption of AI
  tools, but also reports that more developers distrust AI tool accuracy than
  trust it, with only a small minority highly trusting output.
- METR's July 2025 RCT found experienced open-source developers took 19% longer
  with AI tools in that studied setting; METR also warns the result is a
  snapshot and not a universal claim.

Hard questions:

- If experienced software developers still distrust AI-generated code, why
  should beginners trust AI-generated wiring and firmware?
- If AI-generated software requires review, what is the hardware equivalent of
  review before power is applied?
- If AI tools sometimes increase time on complex tasks, could Blockless
  increase total time by generating plausible but physically wrong projects?
- If AI code has security/correctness issues, what is the equivalent hardware
  safety audit for voltage, current, pins, heat, motors, relays, batteries, and
  network endpoints?

Evidence needed:

- Track trust: how often users accept Blockless wiring/code without edits.
- Track reversal: how often users override Blockless selections.
- Track safety: any unsafe pin/electrical/current recommendation should be a
  red-line failure.
- Track review: whether users can understand recipe diffs before deploy.

Sources to treat as market/logic inputs, not direct proof for Blockless:

- https://www.ft.com/content/a7b34d53-a844-4e69-a55c-b9dee9a97dd2
- https://techcrunch.com/2025/07/17/lovable-becomes-a-unicorn-with-200m-series-a-just-8-months-after-launch/
- https://docs.github.com/en/copilot/concepts/about-copilot-coding-agent
- https://survey.stackoverflow.co/2025/ai
- https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- https://www.sonarsource.com/resources/white-papers/the-state-of-ai-code-quality/

## Assumption stack

This is the causal chain the pitch is implicitly asking people to believe.
Every step can break.

```text
Software AI tools created a new creation behavior
  -> hardware has a similar blocked-creation problem
  -> users want to create hardware often enough
  -> natural language is a better front door than tutorials/blocks/simulation
  -> Blockless can run real devices more reliably than generic AI + tooling
  -> verified recipes are reusable across users and hardware variation
  -> reruns/forks/payments create a data and distribution flywheel
  -> the flywheel becomes a moat and business model
```

### Breakpoints

| Assumption | What could break it | Evidence needed |
|---|---|---|
| Software AI behavior transfers to hardware | Hardware projects are less frequent, slower, and more logistics-bound | Repeat project rate, time-to-running-device, kit attach rate |
| Hardware creation is blocked enough to pay for | Users tolerate tutorials/forums or only build once | Willingness-to-pay event, second project behavior |
| Natural language beats old interfaces | Blocks/simulation/tutorials are clearer and safer | Same-task beginner/classroom benchmark |
| Blockless beats generic AI + tooling | Cursor/ChatGPT + PlatformIO solves v1 tasks well enough | Baseline benchmark |
| Blockless beats direct competitors | PleaseDontCode/Embedr/Cirkit already provide enough loop/reuse | Hands-on competitor benchmark |
| Verified recipes rerun | Hardware clones, wiring, firmware, and package drift break reproducibility | Second-user rerun success rate |
| Repair data compounds | Failures are too physical/ambiguous to classify | Failure taxonomy coverage and repair success |
| Appstore emerges | Users browse but do not rerun/fork/pay | Rerun/fork/publish/payment funnel |
| Hardware context graph is a moat | Competitors collect equivalent data or data does not improve outcomes | Improvement over time and module-add cost curve |

### Analogies under pressure

| Analogy | What transfers | What does not transfer | Decision evidence |
|---|---|---|---|
| Cursor | Context-aware creation inside a professional workflow | Software developers work daily; hardware makers may not | Repeat use and workspace willingness to pay |
| Lovable/Bolt/v0 | Prompt to working artifact | Live URL has no shipping/wiring/parts friction | Time to physical working device and kit availability |
| GitHub Copilot agent | Reviewable artifact, branch, tests, logs | Hardware review needs wiring/safety/run evidence | Recipe diff, run certificate, safety audit |
| Shopify | Tooling can unlock small creators/sellers | Hardware supply/support is heavier than software storefronts | Creator sells/reruns recipes or kits |
| Roblox | User-generated ecosystem can compound | Hardware UGC can be unsafe, incompatible, expensive | Community recipe acceptance and rerun success |
| LEGO | Modular substrate reduces complexity | LEGO pieces are physically standardized; electronics are not | Controlled module compatibility and low support cost |
| App Store | Distribution/reuse can create platform power | Apps do not require rewiring sensors | Install/rerun/update compatibility behavior |
| 3D printing | Physical creation got democratized by tooling | Many users printed novelties, not repeated workflows | Repeat project and paid use beyond novelty |
| Arduino/Raspberry Pi | Large maker base exists | Existing base may prefer open tutorials and control | Migration from tutorials to recipes |

### Hardest single question

> Is Blockless creating a repeated workflow, or just making a better first demo?

If the answer is "better first demo," the company should not be pitched like
Cursor/Lovable. It should be pitched as kits, education, vendor support, or
prototyping services until repeat workflow data exists.

## Market logic to attack before pitching

### Is "vibecode hardware" a workflow or a demo?

The most dangerous failure mode is novelty. A user may love the first demo and
never return. That is not a workflow market.

Questions:

- What job recurs often enough to create retention?
- Which user has a backlog of hardware ideas and urgency to finish them?
- What frequency is required for a subscription to make sense?
- If most users build one project per quarter, is the business really kits and
  recipe sales instead of workspace subscription?

### Who is the first economic buyer?

Possible first buyers:

- Beginner makers who want successful projects.
- Schools/maker spaces that need reliable lab setups.
- Hardware module sellers who want lower support burden and higher conversion.
- Small businesses that want simple automations without hiring developers.
- Product prototypers who want fast demos before PCB design.

Each buyer needs different proof:

- Beginner: "I can finish without knowing pins/drivers."
- School: "30 students can run this in a class period."
- Module seller: "Support tickets and returns fall."
- Small business: "This solves a real operational problem."
- Product prototyper: "I can iterate faster before custom hardware."

Question:

> Which buyer has the shortest path to repeated paid use?

### What business is this if the Cursor analogy fails?

If repeated individual creation is strong, Blockless can look like a Cursor /
Lovable-style workspace subscription. If repeated individual creation is weak,
the business must shift.

Possible business-model forks:

| Observed behavior | Better business model | Deck implication |
|---|---|---|
| Users build weekly/monthly projects | Workspace subscription | Cursor/Lovable analogy is viable |
| Users build one project after buying parts | Kit + recipe bundle | Position around successful kits, not IDE subscription |
| Schools run standardized labs | Seat/license + curriculum + support | Education wedge, but needs low support cost |
| Module vendors want fewer support tickets | Vendor-sponsored verified recipes | Sell support deflection and module conversion |
| Makers browse but rarely rerun | Free community + paid pro tooling | Do not pitch appstore monetization yet |
| Prototypers need demos before PCB | Paid prototyping workflow | Position as pre-PCB iteration, not beginner toy |
| Recipes rerun/fork/pay frequently | Recipe marketplace | Appstore language becomes defensible |

Hard questions:

- What is the first paid behavior we can observe without building the whole
  platform?
- Would a module vendor pay for a verified recipe if it reduces support load?
- Would a school pay if Blockless reduces lab setup failures?
- Would a maker pay monthly, or only when buying a kit?
- Which model has the lowest support burden per dollar?

### Is MicroPython a strategic wedge or a ceiling?

MicroPython is central to Blockless because it enables faster runtime iteration
and easier LLM generation. But the claim must be tested, not assumed.

Questions:

- For which tasks is MicroPython clearly good enough?
- Where does it fail on timing, memory, driver coverage, library maturity, or
  industrial reliability?
- Does the target user care about language/runtime, or only whether the device
  works?
- Can Arduino/C competitors add enough auto-fix and cloud compile to erase the
  iteration advantage?
- Does MicroPython make module support easier, or does it require Blockless to
  maintain more custom drivers?

Evidence needed:

- Same-task benchmark: MicroPython Blockless vs. Arduino CLI competitor.
- Driver coverage map by module category.
- Failure-rate comparison: Python runtime errors vs. C compile/flash/runtime
  failures.

### Is the appstore a marketplace or a metadata registry?

Calling it an appstore creates a high bar. A real appstore has discovery,
trust, installation, compatibility, updates, monetization, reviews, and repeat
use. Blockless may initially have only a verified recipe registry.

Questions:

- What does a user install: code, `.mpk`, endpoint, wiring, driver, or full
  recipe?
- What is paid: the recipe, the package, the kit, the workspace, support, or
  publishing?
- Who guarantees compatibility after board firmware/package versions change?
- Can users publish recipes safely, or must Blockless certify them?
- What prevents the appstore from becoming a nicer tutorial index?

Evidence needed:

- Rerun/fork/publish funnel metrics.
- Compatibility breakage rate after package/firmware updates.
- Ratio of community recipes accepted vs. rejected.
- Revenue per recipe category.

### Is the hardware context graph defensible?

The context graph is the proposed moat, but a moat needs accumulation and
exclusive learning.

Questions:

- Which fields are hard for competitors to copy?
- Does every run generate new structured data, or just logs no one labels?
- Can the system learn from failed runs automatically, or does a human need to
  write repair hints?
- Does vendor/module data create exclusive partnerships?
- Is the graph valuable without high recipe rerun volume?

Evidence needed:

- Data model showing how each run updates compatibility, failure, and repair
  knowledge.
- Measured improvement over time: fewer repair loops after N runs.
- Module addition cost trend: does adding the 50th module cost less than the
  5th?

## Competitor exhaustion checklist

This is the working list to exhaust before making a strong deck claim.

Direct AI hardware generation:

- PleaseDontCode
- Schematik
- Cirkit Designer
- Embedr
- Aily Blockly
- ArduinoGPT
- AutoEmbed / EmbedGenius
- IoT-SkillsBench-style academic systems
- CircuitLM / SchGen schematic-generation systems

Adjacent embedded workflow:

- PlatformIO
- ESPHome
- Arduino Cloud
- Blynk
- Particle Workbench
- Wokwi
- Tinkercad Circuits
- MakeCode
- Visuino
- Mind+
- Mixly

Distribution/community:

- Hackster
- Instructables
- Adafruit Learn
- Arduino Project Hub
- Seeed Studio Wiki / Project Hub
- GitHub template repos

Vibe-coding analogy set:

- Cursor
- Replit Agent
- Lovable
- Bolt
- v0
- Base44
- Windsurf
- GitHub Copilot Workspace / coding agent

For each competitor, answer:

1. What exact workflow do they already cover?
2. Do they touch real hardware, simulation, or only code/design?
3. What is their durable artifact?
4. Do they have package/dependency intelligence?
5. Do they have pin/electrical compatibility intelligence?
6. Do they flash/run/read logs?
7. Do they auto-repair from observed errors?
8. Do they distribute reusable projects/recipes?
9. What user do they serve first?
10. What would make Blockless obviously better for that user?

## Competitor scoring matrix

Scoring is intentionally harsh:

- `High`: the source claims or docs show this as a first-class product feature.
- `Medium`: feature exists but is partial, secondary, narrow, or not clearly
  tied to the full workflow.
- `Low`: weak support, mostly manual, or present only as examples/tutorials.
- `None`: not part of the product's core workflow.
- `Unknown`: not verified enough to use in a deck claim.

Do not read this as final truth. It is a current-evidence map that should be
updated after hands-on testing.

| Product/category | Real hardware | Simulation | Pin/electrical context | Package/dependency context | Flash/run/log | Auto repair | Durable artifact | Pressure on Blockless |
|---|---|---|---|---|---|---|---|---|
| PleaseDontCode | High | Low/Unknown | High claimed | High claimed | High claimed | High claimed for compile errors | Public projects, firmware, dashboards | Directly weakens "we are the only closed loop" |
| Schematik | Medium/Unknown | Unknown | High claimed through hardware design framing | Medium/Unknown | Unknown | Unknown | Build/design guide, parts path | Owns "Cursor for hardware" narrative; real output needs testing |
| Cirkit Designer | Medium | High | High claimed | Medium | Medium | Medium/Unknown | Shareable simulated project | Weakens beginner/setup story; pushes Blockless to physical verification |
| Embedr | High | Medium visual preview | High claimed | High claimed | High | Medium/Unknown | IDE project/checkpoints/Git | Weakens "AI embedded IDE" positioning |
| Aily Blockly | High | Planned/Unknown | Medium | High via npm/library system | High | Medium | Open-source project | Shows much of v1 can be cloned in open source |
| ArduinoGPT-style clones | Medium | None | Low | Low | Medium | Low | Local code/project | Shows prompt-to-firmware is commoditized |
| Academic AutoEmbed/EmbedGenius | High in experiments | Low/None | Medium/High | High | High in benchmark setting | Medium | Research benchmark/tasks | Raises benchmark bar; proves context injection is known |
| PlatformIO | High | None | Board-level, not project-intent | High | High | None | Project config | Board/package tooling is table stakes |
| ESPHome | High | None | High within supported components | High within component catalog | High | Medium validation/logs | YAML config/device firmware | Declarative hardware config already works for IoT wedge |
| Arduino Cloud/Blynk | High | None | Low/Medium | Medium | Medium/High cloud/device | Medium | Things/templates/dashboards | Cloud/app/dashboard layer is not unique |
| Particle Workbench | High | None | Board/device OS context | High | High | Medium docs/restore flows | Device firmware/project | Firmware version and OTA are first-class elsewhere |
| Wokwi | Low physical, High simulated | High | Medium in simulation | Medium | High simulated | Medium debug tools | Shareable simulation | Simulation may beat physical-first for education |
| Tinkercad/MakeCode | Medium physical, High learning | High | Medium for supported devices | Medium | Medium | Low/Medium learning feedback | Blocks/projects/tutorials | Beginner education wedge is already served |
| Visuino/MindPlus/Mixly | High | Medium/varies | Medium visual components | Medium/High libraries | High | Low/Medium | Visual project | Natural language must beat visual inspectability |
| Arduino Project Hub/Adafruit/Seeed/Instructables | High via tutorials | Low/Medium | Medium manual docs | Medium manual docs/code | Manual | Manual | Human-readable tutorial | Incumbent distribution is tutorials, not appstores |
| Cursor | None | None | None | Software deps only | Tests/commands, not hardware | High for code | Codebase edits/commits | Analogy only: codebase context and iteration |
| Replit Agent | None | None | None | Software deps/runtime | App runtime | High for app errors | Running app/deployment | Analogy: prompt to live artifact |
| Lovable/Base44/Bolt/v0 | None | None | None | Software backend/deps | Hosted app/deploy | High for software errors | Live app, project, PR/deploy | Sets user expectation for instant artifact |
| GitHub Copilot cloud agent | None | None | None | Software repo/tooling | Tests/linters in Actions | Medium/High for code tasks | Branch, commits, PR, logs, metrics | Hardware needs equivalents of PR, CI, deploy, metrics |

### Matrix consequences

1. The broad category is crowded. "AI hardware builder" is too weak.
2. The closed loop is contested. PleaseDontCode and Embedr already claim large
   chunks of it.
3. The beginner wedge is contested. MakeCode, Tinkercad, Visuino, MindPlus, and
   Mixly already reduce setup and coding difficulty.
4. The distribution layer is contested. Tutorial communities are the incumbent
   appstore.
5. The software analogy is stricter than it looks. v0/GitHub Copilot cloud
   agent show that durable artifacts, review, deployment, and metrics are what
   make AI workflows credible.

### Claims that survive the matrix

These are still plausible, but require evidence:

- "Blockless is a verified recipe system for real-world modular hardware."
- "Blockless's durable artifact is richer than generated firmware: recipe +
  wiring + driver/package versions + install method + run logs + repair hints +
  compatibility matrix."
- "MicroPython is a strong v1 wedge for fast sensor/actuator iteration, not a
  universal embedded replacement."
- "The appstore starts as a verified recipe registry; marketplace claims come
  only after rerun/fork/payment behavior."
- "The context graph is a moat only if every run improves future success rates."

### Claims that should be removed or weakened

- Remove: "Competitors only generate code."
- Remove: "Blockless is the first closed-loop AI hardware workflow."
- Weaken: "MicroPython is always better than Arduino/C."
- Weaken: "Appstore is the business model."
- Weaken: "Beginner makers are obviously the first market."
- Weaken: "Hardware context data is automatically a moat."

## Hardware equivalents of software agent artifacts

The vibe-coding analogy becomes useful only when every software artifact has a
hardware equivalent.

| Software AI workflow | Why it matters | Blockless equivalent to prove |
|---|---|---|
| Live URL | User sees the app working immediately | Real device performs requested behavior |
| Pull request | Reviewable diff before merge | Recipe revision with code, wiring, package, and compatibility diff |
| CI tests | Objective pass/fail gate | Physical run certificate plus optional simulator/static checks |
| Logs | Debug and accountability | Serial log, flash log, run log, repair trace |
| Deployment | Durable hosted artifact | Flashed device + endpoint manifest + appstore listing |
| Rollback/checkpoint | Safe iteration | Known-good recipe revision and previous firmware/package set |
| Package lockfile | Reproducible dependency state | Driver/package version, install method, firmware version, board profile |
| Review comments | Human governance | User confirmation for wiring, risky pins, and publish readiness |
| Usage metrics | Adoption proof | Recipe runs, reruns, forks, successful reproductions, repair success |
| Marketplace/template gallery | Discovery and reuse | Verified recipe registry with compatibility filtering |

Hard question:

> If Blockless cannot show these artifacts in the product, is it really a
> vibe-coding platform for hardware, or just a chat-driven firmware generator?

## Claim falsification table

Use this table before putting any claim into a deck, landing page, or investor
memo. If the falsifying evidence appears, the claim must be weakened or
rewritten.

| Claim | What would falsify it | Stronger version if weak |
|---|---|---|
| "Blockless is the first AI hardware workflow" | PleaseDontCode, Embedr, Cirkit, or another tool demonstrates prompt -> wiring -> code -> flash -> logs -> reuse | "Blockless focuses on verified, rerunnable hardware recipes, not just generated firmware" |
| "Competitors only generate code" | Competitor supports wiring, pin checks, compile, flash, OTA, serial monitor, auto-fix, or community projects | Name the specific gap: recipe metadata, run-log attestation, compatibility graph, `.mpk`, package registry |
| "MicroPython gives a 10x iteration advantage" | Arduino/C competitor auto-compiles/flashes fast enough that users do not care, or MicroPython driver/runtime failures dominate | "MicroPython is best for the v1 modular/sensor orchestration wedge; C remains better for hard real-time/performance" |
| "The appstore is a marketplace" | Users mostly browse once, do not rerun/fork, and no one pays for recipes/packages | "Start as a verified recipe registry; become a marketplace only after rerun/fork/payment behavior appears" |
| "Hardware context graph is a moat" | Competitors collect equivalent board/pin/package/run data or Blockless data does not improve success over time | "Moat requires measured learning: fewer repair loops and lower module-add cost as runs accumulate" |
| "Vibe-coding analogy proves demand" | Users like demos but do not build second/third projects or pay for workspace/kit/recipe | "Vibe-coding analogy is only valid if Blockless produces repeat hardware creation behavior" |
| "Beginners are the first market" | Beginners need too much support, break hardware, or churn after one demo | "Start with schools, maker spaces, module vendors, or prototypers if they show stronger repeat use" |
| "Recipes are better than tutorials" | Recipe conversion is expensive, rerun success is low, or users prefer free tutorial edits | "Recipes win only for standardized kits/modules where compatibility can be controlled" |
| "Blockless can support broad hardware" | Failure/support cost grows faster than recipe/rerun revenue | "V1 must stay narrow; expansion is earned by measured module economics" |
| "Repair can be automated from logs" | Serial/run logs do not distinguish wiring/package/driver/code failures reliably | "Repair hints need structured probes, user confirmations, and known-failure capture, not logs alone" |

## Minimum evidence package before a strong pitch

To make the story credible, collect a small but hard evidence package:

1. **Competitor benchmark**: 10 identical tasks against Blockless, ChatGPT +
   PlatformIO/Arduino CLI, PleaseDontCode, and one simulation/visual tool.
2. **Real hardware run set**: 20-30 verified recipes on the v1 board/module
   matrix, with stored run logs and repair attempts.
3. **Reproducibility test**: each recipe rerun by at least one second user on
   compatible hardware.
4. **Failure taxonomy**: every failed run classified into code, package,
   driver, pin, wiring, board, firmware, flash, power, or unknown.
5. **Repeat behavior**: day-7 and day-30 second-project rates from real users.
6. **Economic signal**: at least one paid behavior tested: kit purchase,
   workspace subscription, paid recipe, vendor sponsorship, school pilot, or
   support-deflection deal.

Without these, the honest position is:

> Blockless has a plausible thesis and technical wedge, but the market and
> defensibility claims are not yet proven.

## Benchmark protocol

The benchmark should be designed to embarrass weak claims, not confirm the
story. If Blockless wins only on cherry-picked tasks, the positioning is not
ready.

### Systems to compare

Minimum comparison set:

1. Blockless current VS Code extension and backend.
2. ChatGPT/Cursor + PlatformIO or Arduino CLI baseline.
3. PleaseDontCode, because it is the closest full-loop public comparable.
4. One simulation/visual baseline: Wokwi, Cirkit Designer, Tinkercad, MakeCode,
   Visuino, MindPlus, or Mixly depending on task fit.
5. One tutorial baseline: Arduino Project Hub, Adafruit Learn, Seeed Wiki, or
   Instructables.

Optional comparison set:

- Embedr if access is available.
- Aily Blockly if installation is stable enough.
- Schematik only after confirming it can produce comparable firmware/hardware
  output for the task; otherwise score it as narrative/category pressure, not a
  same-workflow benchmark.

### Hardware constraint

Use a deliberately narrow matrix first:

- Boards: ESP32-S3 devkit and ESP32-C3 devkit.
- Modules: temperature/humidity, button, relay or fan, SSD1306 OLED, RGB LED,
  buzzer, light sensor, motion sensor, Wi-Fi endpoint.
- Cables, power supplies, breadboards, and modules should be identical across
  runs.

The goal is not broad support. The goal is proving that Blockless can dominate
inside a controlled wedge before expanding.

### Ten benchmark tasks

Each task should be run from the same natural-language prompt.

| # | Task | Why it tests the thesis | Pass condition |
|---|---|---|---|
| 1 | "Temperature over 30 C turns on a fan." | Sensor + threshold + actuator + pin choice | Fan/relay switches on/off from measured sensor value |
| 2 | "Button press triggers my AI workflow." | Physical trigger + endpoint/event semantics | Button press emits a visible event to configured endpoint/log |
| 3 | "Show my agent status on a small display." | Display driver + text rendering + state updates | OLED shows at least three changing states |
| 4 | "Send sensor events to my app." | Wi-Fi/network + endpoint manifest | Device sends structured event to app/backend |
| 5 | "Blink RGB LED red when Wi-Fi disconnects." | Runtime state + status indicator | LED behavior changes when Wi-Fi is removed/restored |
| 6 | "Log light level and beep if it gets dark." | Sensor + actuator + serial observability | Serial log shows readings; buzzer triggers below threshold |
| 7 | "Motion detected -> display alert and send event." | Multi-module composition | Motion event updates display and endpoint |
| 8 | "Publish this as a reusable recipe for the same board." | Durable artifact, not just code | Recipe contains board, wiring, package versions, logs, manifest |
| 9 | "Rerun someone else's recipe on my board." | Reproducibility | Second user/device reproduces behavior without hidden steps |
| 10 | "Fix the project after I move the sensor to a bad pin." | Repair + pin capability graph | System identifies pin incompatibility or asks for wiring correction |

### What to measure

For every system and task:

- Time from prompt/tutorial open to first attempted run.
- Time from prompt/tutorial open to verified working behavior.
- Number of manual steps.
- Number of times user leaves the product to search docs/forums.
- Number of generated code edits by the user.
- Number of dependency/package interventions.
- Number of wiring corrections.
- Number of flash/upload failures.
- Number of runtime failures.
- Whether the system classifies the failure correctly.
- Whether the system produces a reusable artifact.
- Whether a second user can reproduce the artifact.
- Whether logs are captured and tied to the artifact.

### Failure taxonomy

Every failure should be assigned one primary label:

- `intent_misread`: wrong interpretation of the user's sentence.
- `board_mismatch`: selected board cannot support required capability.
- `module_mismatch`: selected module cannot support required behavior.
- `pin_invalid`: selected pin cannot support role or electrical requirement.
- `wiring_unknown`: system cannot know the physical wiring without user input.
- `wiring_wrong`: user wiring differs from manifest or diagram.
- `driver_missing`: package/driver unavailable.
- `driver_api_wrong`: generated code uses wrong import/API/constructor.
- `package_version`: wrong package or firmware version.
- `install_failure`: package install, file write, or upload failed.
- `flash_failure`: board flashing/run start failed.
- `runtime_exception`: code runs but raises an exception.
- `behavior_wrong`: code runs but physical behavior is wrong.
- `log_unhelpful`: log does not identify the failing layer.
- `repair_wrong`: repair loop makes the project worse or changes the task.
- `unknown`: cannot classify from available evidence.

### Scorecard

Score each task on 100 points:

- 25: physical behavior works.
- 15: correct board/module/package selection.
- 10: safe and correct wiring/pin assignment.
- 10: dependencies installed without manual search.
- 10: flash/run succeeds.
- 10: logs captured and interpretable.
- 10: repair succeeds when there is a controlled failure.
- 10: artifact is reproducible by a second user.

Penalties:

- -20 for any unsafe electrical recommendation.
- -15 for hallucinated package, import, pin, or API.
- -15 for claiming success without observing the device/log.
- -10 for requiring undocumented manual steps.
- -10 for changing the user task during repair.

### Decision thresholds

Use these thresholds to decide what the pitch can honestly claim.

| Result | Pitch consequence |
|---|---|
| Blockless wins 8/10 tasks on verified behavior and reproducibility | Can claim "verified recipe workflow" inside the v1 wedge |
| Blockless wins behavior but loses reproducibility | Do not pitch appstore/recipe moat yet |
| Blockless ties competitors on time-to-run but wins repair classification | Pitch repair/diagnostic layer, not speed |
| Blockless wins simple tasks but loses multi-module tasks | Keep wedge narrow; do not pitch broad hardware creation |
| Blockless loses to tutorial baseline for beginners | Do not lead with beginner market |
| Blockless loses to visual/simulation tools in classroom setup | Do not lead with education without kits/curriculum |
| Blockless loses to PleaseDontCode on most tasks | Rewrite category around MicroPython package/recipe registry or choose a narrower wedge |
| Second-user rerun success below 70% | Do not use "appstore" or "marketplace" language |
| Repair success below 50% | Do not claim automatic repair; claim assisted diagnosis |
| Unknown/unclassified failures above 20% | Hardware context graph is not yet strong enough |

### Benchmark artifacts to preserve

Every run should produce a folder:

```text
benchmark_runs/
  {date}-{system}-{task-id}/
    prompt.txt
    hardware_inventory.json
    board_profile.json
    module_manifest.json
    wiring_manifest.json
    package_lock.json
    generated_code/
    flash_log.txt
    serial_log.txt
    repair_trace.md
    result.json
    photos_or_video/
```

`result.json` should include:

```json
{
  "system": "blockless",
  "task_id": "task-01-temperature-fan",
  "passed": true,
  "time_to_first_run_sec": 420,
  "time_to_verified_behavior_sec": 760,
  "manual_steps": 5,
  "external_searches": 0,
  "failure_labels": ["runtime_exception", "repair_success"],
  "unsafe_recommendation": false,
  "hallucinated_api": false,
  "reproducible_by_second_user": true
}
```

Hard question:

> If Blockless cannot produce these benchmark artifacts for itself, why should
> investors believe it can produce verified recipes for users?

## Source confidence rules

Current research mixes official docs, product marketing pages, GitHub READMEs,
press coverage, research papers, and untested competitor claims. They are not
equivalent.

| Source type | Use it for | Do not use it for |
|---|---|---|
| Official docs | Product workflow, APIs, concrete feature behavior | Market traction or success rate |
| Product marketing page | Positioning, claimed capabilities, target user | Proof that the capability works reliably |
| GitHub README | Open-source scope, architecture hints, install/test surface | Proof of production quality or adoption |
| Press coverage | Funding, narrative, investor/media framing | Exact product capability unless independently verified |
| Research paper | Benchmark framing, failure modes, technical feasibility | Product adoption or commercial moat |
| Hands-on benchmark | Actual workflow friction and success/failure evidence | Broad market demand unless sample is large enough |
| User cohort data | Retention, repeat use, willingness to pay | Technical superiority unless tied to task data |

Rules:

1. Competitor self-claims should be written as "claims" until tested.
2. Press language should not be copied into deck claims without independent
   product verification.
3. Any claim about "first," "only," or "unique" requires exhaustive current
   competitor testing, not search results.
4. Any claim about "faster," "higher success," or "less debugging" requires a
   benchmark with the same tasks, boards, modules, and users.
5. Any claim about "marketplace" requires behavior data: rerun, fork, publish,
   payment, and repeat use.

This means the current matrix is a hypothesis map, not proof. Its main value is
showing which claims are unsafe until tested.

## Current deck red-team audit

This audit references `docs/pitch/deck/deck_en.md` v12. It should be used before
rewriting the deck. The goal is not to make the deck timid; it is to remove
claims that collapse under a basic investor diligence pass.

| Deck claim | Risk | Tough question | Required evidence or safer rewrite |
|---|---|---|---|
| "The physical world has no agent" / "Hardware is still empty" | False by omission: PleaseDontCode, Embedr, Cirkit, Aily, Schematik, and academic systems all attack parts of this space | What does "agent" mean that excludes these products without sounding semantic? | Safer: "No dominant agent has become the standard workflow for verified real-world hardware recipes." |
| "Nothing democratizes physical things yet" | Too broad; MakeCode, Tinkercad, Visuino, MindPlus, Mixly, Arduino Project Hub, Adafruit Learn all lower barriers | Are we ignoring 15 years of education/no-code/simulation tools? | Safer: "Tools help people learn hardware, but real-device build/run/repair/reuse remains fragmented." |
| "Someone already tried Cursor for hardware. It didn't work." | Overclaim based on competitor narrative; may sound unserious or defamatory | Did Schematik fail commercially, technically, or only in one demo? | Safer: "Early 'Cursor for hardware' attempts show the category is real, but also expose stack-level risks." |
| "Even the founder can't run it" | High-risk claim unless backed by primary video/source and context | Was this a one-off failure, staged demo, or repeatable product limitation? | Remove unless primary source is explicit and legally safe. |
| "~20% packages don't exist" | Needs source and exact scope; may not apply to Schematik specifically | Is this from a paper about LLM package hallucination generally or Schematik data? | Safer: "Package hallucination is a documented LLM failure mode; Blockless must prove its package resolver prevents it." |
| "C / Arduino compile-flash loop dies" | Overgeneralizes; competitors can automate compile/flash and cloud toolchains | Is the loop really slow enough to decide user success? | Benchmark same tasks vs Arduino CLI/PleaseDontCode before claiming speed advantage. |
| "LLMs write Python 10x more accurately than C" | Needs exact study, task type, and whether embedded/MicroPython applies | Does this paper measure embedded firmware or general code? | Safer: "Python/MicroPython may be more LLM-friendly; benchmark on our hardware tasks." |
| "First time possible" for BLE + ESP32-C3 + MicroPython REPL | Very likely too absolute | Have no-code/REPL/OTA/BLE module systems existed before? | Safer: "This combination makes our narrow modular workflow practical now." |
| "Not replicable 1:1" | Strong moat claim without proof | Which assets are exclusive: uPyPI, driver contexts, verified recipes, run logs, modules, distribution? | Rewrite only after showing data flywheel or exclusive package/module assets. |
| "Hardware App Store — fork & install someone else's working build" | Appstore/marketplace behavior not proven | Has anyone forked/rerun/published/paid yet? | Safer: "Verified recipe registry first; appstore after rerun/fork/payment behavior." |
| "BLE self-describe" | Product/architecture promise may exceed current MVP | Do current modules self-describe today, or is this roadmap? | Mark as roadmap unless shipping hardware demonstrates it. |
| "No compile, no flash" | MicroPython still needs file transfer/run; firmware/bootstrap may still need flash | What exact setup remains for a new board? | Safer: "Fast hot-reload after firmware setup." |
| "Hardware sales ~70%" | Business model assumption without observed attach rate | Do users want to buy modules from Blockless vs Adafruit/Seeed/Amazon? | Test kit purchase attach rate before using a revenue-share table. |
| "Best: $100M+ ARR" | Scenario not tied to retention/price/customer count | What active creator count, ARPU, churn, and hardware margin produce this? | Show bottom-up model or remove from early no-traction deck. |
| "Kickstarter Hardware Top-5 target" | GTM optimism, not evidence of demand | Why would this product perform like top hardware campaigns? | Use as tactical launch option, not validation of company-scale demand. |
| "US K-12 + post-secondary STEM enrollment: ~50M" | Huge top-down adjacent number; may look like TAM theater | What fraction can buy hardware kits or software? Who is buyer? | Replace with pilotable buyer segments: schools, maker spaces, module vendors. |

### Deck claims that are safer today

- "Hardware creation remains fragmented across datasheets, drivers, pins,
  packages, flashing, and debugging."
- "AI code generation alone is insufficient for hardware."
- "A verified recipe artifact could be more reusable than a tutorial."
- "MicroPython is a plausible narrow-stack wedge for sensor/actuator workflows."
- "The current MVP should be judged by real-device run and repair success, not
  by code generation quality alone."

### Deck diligence questions to rehearse

Investors or serious operators will ask:

1. Why won't PleaseDontCode, Embedr, Cirkit, or Aily add recipes/appstore?
2. Why won't Arduino/Adafruit/Seeed add AI on top of existing tutorials and
   hardware distribution?
3. Why is MicroPython enough for the first market, and where does it break?
4. What proof says users do a second and third project?
5. What proof says recipe reruns work across real hardware variation?
6. What is the first paid behavior: software, kit, recipe, vendor support, or
   education?
7. What is the support cost per successful build?
8. How many modules can you support before QA/support collapses?
9. What data does every failed run add to the moat?
10. If the answer is "we need curated verified recipes," who pays for curation?

## Red-team question bank

Use this as the live grilling script. Do not answer with vision language; answer
with evidence, a benchmark plan, or a narrower claim.

### Category questions

1. Are we inventing a category, or entering a category already defined by
   PleaseDontCode, Schematik, Embedr, Cirkit, Aily, and academic systems?
   - Good answer: name the exact category boundary Blockless owns, such as
     "verified rerunnable hardware recipes for modular MicroPython devices."
   - Bad answer: "Nobody is doing this."

2. If an investor searches "AI hardware builder," what stops them from seeing
   the same category already crowded?
   - Good answer: a matrix showing direct competitors and the one dimension
     where Blockless is measurably different.
   - Bad answer: "They are not real competitors."

3. Is "Cursor for hardware" still useful if Schematik already owns the phrase
   in media?
   - Good answer: use it only as a shorthand, then immediately narrow to
     recipe/run-log/package artifacts.
   - Bad answer: fight over slogan ownership.

### Product questions

1. What is the durable artifact after a successful run?
   - Good answer: recipe revision containing code, wiring, driver/package
     versions, board profile, install method, run log, repair trace, endpoint
     manifest, and compatibility matrix.
   - Bad answer: generated code folder.

2. What can a second user rerun without asking the original creator?
   - Good answer: the recipe on a known compatible board/module set, with
     explicit failure conditions.
   - Bad answer: "They can copy the code."

3. What does Blockless observe that a code assistant cannot?
   - Good answer: board profile, pin capability, package context, install log,
     flash log, serial/run log, user wiring confirmation, and repair outcome.
   - Bad answer: "Hardware context."

4. How does the agent know whether a failure is code, wiring, driver, package,
   board, firmware, flash, power, or user setup?
   - Good answer: structured probes and failure taxonomy tied to logs and
     known-failure hints.
   - Bad answer: "The LLM reads the logs."

### Competitor questions

1. If PleaseDontCode already compiles, flashes, auto-fixes, monitors, and shares
   projects, why does Blockless exist?
   - Good answer: show a task where Blockless recipe metadata/reproducibility
     wins, or narrow the claim.
   - Bad answer: ignore PleaseDontCode.

2. If Embedr/Aily add recipe publishing, what remains defensible?
   - Good answer: proprietary package/driver contexts, verified run data, and
     module compatibility graph improve with each run.
   - Bad answer: "We have better UX."

3. If Arduino/Adafruit/Seeed add AI to their tutorials and hardware stores,
   what is Blockless's channel advantage?
   - Good answer: partner as recipe infrastructure or prove faster independent
     recipe conversion.
   - Bad answer: assume vendors will not respond.

4. If Wokwi/Cirkit/Tinkercad solve education through simulation, why is real
   hardware first?
   - Good answer: physical output is the end artifact, but education may need
     simulation or standardized kits.
   - Bad answer: "Simulation is not real."

### Market questions

1. What is the repeated behavior?
   - Good answer: second/third project rates, recipe reruns, forks, or recurring
     classroom/vendor workflows.
   - Bad answer: demo excitement.

2. Who pays first?
   - Good answer: choose one first buyer and evidence path: maker kit buyer,
     school, module vendor, prototyper, or workspace subscriber.
   - Bad answer: "Everyone who wants to build hardware."

3. If users build only one project, what is the business?
   - Good answer: kit + verified recipe bundle, vendor support deflection, or
     paid prototyping service.
   - Bad answer: subscription.

4. If users build weekly, what is the workflow lock-in?
   - Good answer: recipe history, known-good hardware inventory, package lock,
     repair memory, endpoint integrations, and publish/reuse.
   - Bad answer: "AI chat is convenient."

### Technical moat questions

1. Which asset gets better after every failed run?
   - Good answer: failure labels, repair hints, compatibility graph, package
     constraints, pin/wiring constraints, and module metadata.
   - Bad answer: "More data."

2. What is hard for competitors to copy?
   - Good answer: verified run corpus linked to actual hardware/module/package
     versions plus distribution/recipe behavior.
   - Bad answer: prompts or LLM choice.

3. What is the module-add cost curve?
   - Good answer: show the time and human work to add module 1, 10, 50, 100.
   - Bad answer: "We can ingest datasheets."

4. Where does MicroPython lose?
   - Good answer: hard real-time, memory-constrained, industrial reliability,
     mature Arduino library categories, and high-performance IO.
   - Bad answer: "It does not matter for our users."

### Evidence standards

Do not count as sufficient:

- a demo video without logs;
- a generated project that was not run;
- one founder-run example;
- competitor marketing pages used as proof of reliability;
- press claims used as product evidence;
- top-down market numbers used as buyer proof.

Count as stronger evidence:

- same-task benchmark;
- second-user rerun;
- stored serial/flash/run logs;
- failure classification;
- cohort repeat behavior;
- willingness-to-pay event;
- vendor/school pilot with support-cost measurement.

## What research is still needed

### Hands-on competitor backlog

Do these in order. Stop after each batch and update the claim table; do not
wait until all research is done.

| Priority | Target | Why first | Test |
|---|---|---|---|
| P0 | PleaseDontCode | Closest public full-loop competitor; directly attacks closed-loop claim | Run tasks 1, 2, 3, 8, 9 if access allows |
| P0 | ChatGPT/Cursor + PlatformIO/Arduino CLI | Baseline for "generic AI + existing tooling" | Run tasks 1, 3, 4, 10 |
| P0 | Blockless current MVP | Need honest self-measurement before competitor claims | Run all 10 benchmark tasks where hardware exists |
| P1 | Wokwi or Cirkit Designer | Tests simulation/education alternative | Run tasks 1, 3, 6 in simulation; compare setup/debug speed |
| P1 | Embedr | Direct AI embedded IDE pressure | Run same tasks if accessible |
| P1 | Aily Blockly | Open-source clone pressure | Install, run simple board/module/code/upload path |
| P1 | Arduino/Adafruit/Seeed tutorial baseline | Tests whether tutorials remain better for beginners | Run task 1 from a tutorial and measure hidden steps |
| P2 | Schematik | Narrative pressure, but may not be comparable workflow | Verify real output surface before using as attack slide |
| P2 | MakeCode/Tinkercad/Visuino/MindPlus/Mixly | Education/no-code pressure | Classroom-style setup comparison |
| P2 | GitHub Copilot/v0/Bolt/Lovable/Base44 | Analogy, not direct competitor | Extract artifact/review/deploy patterns for Blockless UX |

For every hands-on test, record:

- link/account/version/date;
- exact prompt or tutorial;
- hardware used;
- screenshots/photos/video;
- logs;
- manual steps;
- failure labels;
- whether any claim in the deck must change.

### Benchmark run sheet

Copy this for each run.

```markdown
## Run ID

- Date:
- Tester:
- System:
- Version / URL:
- Task ID:
- Prompt or tutorial:
- Hardware:
- Starting condition:

## Timeline

- Start:
- First generated output:
- First attempted run:
- First observed failure:
- First repair attempt:
- Verified working behavior:
- Stop:

## Step count

- Manual clicks/commands:
- User code edits:
- Wiring changes:
- External searches:
- Docs/forum pages opened:
- Package/dependency interventions:

## Evidence

- Generated code saved:
- Wiring/diagram saved:
- Package lock/install method saved:
- Flash/upload log saved:
- Serial/run log saved:
- Photo/video saved:
- Repair trace saved:

## Result

- Physical behavior passed:
- Reusable artifact produced:
- Second-user rerun attempted:
- Second-user rerun passed:
- Failure labels:
- Unsafe recommendation:
- Hallucinated package/import/API/pin:
- Hidden manual steps:

## Claim impact

- Which Blockless claim got stronger?
- Which Blockless claim got weaker?
- Which deck sentence must change?
```

### Customer interview script

Use after a benchmark or demo. Ask behavior questions, not compliments.

1. What were you trying to build before using this?
2. What would you have done without Blockless?
3. Which step felt most confusing or risky?
4. Did you trust the wiring recommendation? Why?
5. Did you trust the generated code? Why?
6. If it failed, did the explanation help you act?
7. Would you rerun someone else's recipe?
8. Would you publish your own recipe?
9. Would you buy a kit if the recipe guaranteed compatibility?
10. Would you pay for the workspace, the recipe, the kit, or support?
11. What would make you build a second project next week?
12. What would make you stop using it after one demo?

Do not ask "would you use this?" Ask for the next concrete action:

- buy a kit;
- invite a student/team member;
- rerun a recipe;
- publish a recipe;
- pay for a workspace;
- ask for a vendor/school pilot;
- replace an existing tutorial workflow.

### Red-line findings

If any of these happen, update positioning immediately:

- PleaseDontCode produces a rerunnable project artifact with logs and public
  reuse. Then Blockless cannot claim recipe uniqueness without a narrower
  distinction.
- Generic ChatGPT/Cursor + PlatformIO solves most v1 tasks with little friction.
  Then Blockless must shift to verified packages/modules/appstore, not codegen.
- Tutorial baseline beats Blockless on task completion for beginners. Then
  "democratizes hardware" must be narrowed.
- Visual/simulation tools beat Blockless for schools. Then education GTM needs
  kits/curriculum/support proof before pitching.
- Blockless cannot classify more than 80% of its own failed runs. Then the
  repair/data-flywheel claim is premature.
- Second-user rerun success is below 70%. Then appstore/marketplace language is
  premature.

## Positioning decision tree

Do not choose the final narrative by preference. Choose it by evidence.

### Narrative A: "Verified recipe system for real-world hardware"

Use this if:

- Blockless beats generic ChatGPT/Cursor + PlatformIO on reproducibility.
- Second-user rerun success is above 70% in the v1 matrix.
- Recipes include logs, package versions, wiring, board profile, and repair
  trace.
- Users understand "recipe" as more useful than a tutorial or generated code.

Pitch:

> Blockless turns hardware intent into verified, rerunnable recipes.

Kill it if:

- Recipes cannot be rerun reliably by a second user.
- Recipe metadata does not reduce debugging or support.
- Competitors already produce equivalent rerunnable artifacts.

### Narrative B: "AI-native modular hardware kit"

Use this if:

- Users buy modules/kits after recipe preview.
- Hardware attach rate is stronger than software subscription intent.
- V1 works best only on a tightly controlled module set.
- Support cost is acceptable because Blockless controls hardware inventory.

Pitch:

> Blockless is the fastest way to turn an idea into a working modular device.

Kill it if:

- Users prefer buying parts from Adafruit/Seeed/Amazon.
- Kit margins are too low after support/replacement cost.
- The AI layer does not materially increase kit conversion.

### Narrative C: "Package intelligence and repair layer for MicroPython"

Use this if:

- Blockless does not dominate full workflow UX, but its package/driver/context
  layer prevents failures competitors hit.
- Vendor/school/developer users value verified drivers and repair hints more
  than end-user chat.
- MicroPython coverage and driver contexts are the strongest defensible asset.

Pitch:

> Blockless is the verified package and repair layer for MicroPython hardware.

Kill it if:

- Package/driver errors are not the main failure source.
- Competitors can match package context quickly.
- The market is too small without full workflow ownership.

### Narrative D: "School/maker-space lab reliability platform"

Use this if:

- Classroom trials show fewer setup failures than tutorials/simulation-only
  workflows.
- Teachers/maker spaces pay for standardized kits, recipes, and support.
- Repeat use happens through cohorts/classes, not individual hobbyists.

Pitch:

> Blockless makes real hardware labs reproducible.

Kill it if:

- Support burden per class is high.
- Simulation tools meet the educational need more cheaply.
- Procurement cycles are too slow for seed-stage GTM.

### Narrative E: "Pre-PCB prototyping workflow"

Use this if:

- Product builders use Blockless to test sensor/actuator ideas before PCB work.
- The value is speed to demo, not beginner friendliness.
- Users pay per project, prototype, or workspace.

Pitch:

> Blockless is the AI prototyping loop before custom hardware.

Kill it if:

- Prototypers need C/PCB/schematic output earlier than Blockless supports.
- Schematik/Embedr/Cirkit own this workflow more naturally.
- MicroPython/module constraints feel too toy-like to pros.

### Narrative selection rule

If evidence is mixed, choose the narrowest narrative that survives:

1. Verified recipe system.
2. Modular hardware kit.
3. Package/repair layer.
4. School/maker-space reliability platform.
5. Pre-PCB prototyping workflow.

Do not combine all five in the deck. That will read as lack of focus.

## Competitor evidence ledger

This ledger separates what we know from what competitors claim.

| Target | Current evidence class | What is still unverified | Next action |
|---|---|---|---|
| PleaseDontCode | Product marketing claims full loop | Actual reliability, rerunnable artifact depth, log/recipe quality | Hands-on tasks 1/2/3/8/9 |
| Schematik | Website + press/category narrative | Real product output, whether failure claims are fair, firmware/run support | Verify primary demos and product access before using attack slide |
| Cirkit Designer | Product site/docs claims AI circuit + simulation | Real physical flash/run quality and repair depth | Run simulation tasks 1/3/6 |
| Embedr | Product site claims AI embedded IDE | Actual package/pin/log/repair behavior | Access and run same tasks |
| Aily Blockly | GitHub README/open-source repo | Install stability, real upload path, AI quality | Install and run one ESP32 task |
| PlatformIO baseline | Mature docs/tooling | How far generic AI + PlatformIO can go with good prompts | Run ChatGPT/Cursor baseline |
| Wokwi/Tinkercad/MakeCode | Mature education/simulation products | Whether they beat Blockless for classroom/beginner goals | Compare setup/debug speed |
| Arduino/Adafruit/Seeed tutorials | Incumbent tutorial/distribution layer | Whether recipes beat tutorials in real completion time | Convert/run a known tutorial |
| v0/Lovable/Bolt/Base44/Replit | Software analogy and market signal | Whether hardware users have comparable repeat behavior | Use only as analogy until cohort data exists |
| GitHub Copilot coding agent | Software artifact/review model | Hardware equivalent of PR/CI/deploy/metrics | Map product UX artifacts |

If a target remains unverified, do not use it as proof. Use it as pressure.

## Claim maturity ladder

Use this ladder when drafting any deck, landing page, investor email, or demo
script. The wording should match the evidence level.

### Level 1: Safe today

These claims are defensible from current product direction and competitor
research:

- Hardware creation remains fragmented across intent, parts, pins, drivers,
  packages, flashing, logs, and debugging.
- AI code generation alone is not enough for real hardware workflows.
- Existing tools solve pieces of the problem: simulation, visual programming,
  IDEs, package management, tutorials, cloud dashboards, and AI generation.
- Blockless's current thesis is that verified recipes can be more reusable than
  human tutorials or generated code alone.
- V1 should be narrow because hardware matrix expansion increases failure and
  support cost.

Allowed wording:

- "We are building..."
- "Our thesis is..."
- "The current workflow is fragmented..."
- "The missing artifact is a verified recipe..."
- "This must be proven through rerun and repair data..."

### Level 2: Hypothesis, allowed if labeled

These can be said only as hypotheses:

- MicroPython may be a better v1 stack for LLM-generated sensor/actuator
  workflows.
- Verified recipes may become the hardware equivalent of software templates.
- Package intelligence may be a defensible asset if run data improves it.
- Modular hardware may make AI hardware more reliable than open-ended board
  selection.
- A recipe registry may become an appstore if rerun/fork/payment behavior
  appears.

Allowed wording:

- "We believe..."
- "The wedge appears to be..."
- "Our bet is..."
- "If rerun data holds, this becomes..."

### Level 3: Benchmark-gated

These require same-task benchmark data:

- Blockless is faster than tutorial or generic AI workflows.
- Blockless reduces debugging time.
- Blockless repairs failures better than competitors.
- MicroPython gives a decisive iteration advantage.
- The package/driver context prevents failures competitors hit.
- The recipe artifact is more reproducible than a tutorial.

Allowed wording only after data:

- "In our benchmark..."
- "Across N tasks..."
- "With N users..."
- "Second-user rerun succeeded X% of the time..."

### Level 4: Market-gated

These require real user behavior:

- Users will pay for vibecode hardware.
- Users will build second and third projects.
- Schools/maker spaces will adopt Blockless.
- Vendors will sponsor verified recipes.
- Appstore/marketplace behavior exists.
- Workspace subscription is the right business model.

Allowed wording only after data:

- "In our pilot..."
- "X% bought..."
- "Y% returned for a second project..."
- "Vendor/school paid for..."

### Level 5: Prohibited until proven

Do not use these claims now:

- "Hardware is still empty."
- "Nobody is doing this."
- "Competitors only generate code."
- "Blockless is the first closed-loop AI hardware workflow."
- "MicroPython is always better than Arduino/C."
- "The appstore is already the business model."
- "Hardware context data is automatically a moat."
- "Schematik failed."
- "Even the founder cannot run it."
- "Blockless can support broad hardware."

If the deck needs punch, use narrower punch:

> AI can write code. Hardware needs verified recipes.

> The hard part is not the prompt. It is making the second run work.

> The moat is not the model. It is the run-tested hardware context graph.

## One-page synthesis

What we should believe today:

1. The category is real and crowded enough to validate demand, but too crowded
   for "first/only" language.
2. The strongest defensible Blockless thesis is not AI codegen. It is
   verified, rerunnable hardware recipes backed by structured context.
3. The closest threat is PleaseDontCode because it claims much of the same
   closed loop. It must be tested first.
4. The strongest analogy is software app builders, but only at the artifact
   level: live app maps to running device; PR maps to recipe revision; CI maps
   to run certificate; package lock maps to driver/package/firmware profile.
5. The analogy breaks if users do not build repeatedly or if physical inventory
   makes iteration too slow.
6. The first business model is not known. It depends on observed paid behavior:
   subscription, kit, recipe, vendor support, school lab, or prototyping.
7. The current deck should be softened before serious diligence: remove empty,
   first, only, failed, and appstore-as-proven claims.
8. The next evidence gate is the 10-task benchmark plus second-user reruns.

What would make me more bullish:

- Blockless wins 8/10 benchmark tasks on verified behavior and reproducibility.
- Second-user rerun success exceeds 70%.
- Repair classification succeeds on more than 80% of failed runs.
- Users build a second project within 7 or 30 days.
- A vendor, school, or maker pays for a verified recipe/kit/workspace.
- Module-add cost decreases as the context graph grows.

What would make me less bullish:

- Generic ChatGPT/Cursor + PlatformIO solves the same tasks with similar effort.
- PleaseDontCode produces equivalent rerunnable artifacts.
- Tutorials beat Blockless for beginners.
- Simulation/visual tools beat Blockless for classrooms.
- Most failures are wiring/power/clone-hardware issues Blockless cannot
  diagnose.
- Users enjoy the demo but do not rerun, fork, pay, or build a second project.

## Exhaustion criteria

This memo has largely exhausted desk-research reasoning. More speculative
analysis has diminishing returns unless it changes a test, a deck claim, or a
positioning decision.

### Exhausted enough for now

These questions have enough desk-research coverage to guide the deck:

- Is "AI writes hardware code" too broad? Yes.
- Is "first/only closed loop" unsafe? Yes.
- Is the vibe-coding analogy useful but limited? Yes.
- Are tutorials, visual tools, simulation tools, and embedded IDEs real
  alternatives? Yes.
- Is PleaseDontCode the closest immediate full-loop pressure? Yes, from public
  claims.
- Is the appstore claim premature without rerun/fork/payment behavior? Yes.
- Is MicroPython a plausible wedge but not a universal win? Yes.
- Should the current deck remove empty/first/failed/proven-marketplace claims?
  Yes.

Do not spend more time re-arguing these unless new evidence appears.

### Not exhausted because evidence is missing

These cannot be settled by more narrative:

- Does Blockless beat PleaseDontCode on the same tasks?
- Does Blockless beat generic ChatGPT/Cursor + PlatformIO/Arduino CLI?
- Does Blockless beat tutorials for beginners?
- Does Blockless beat simulation/visual tools for classroom setup?
- Do second users actually rerun recipes successfully?
- Do users build a second or third project?
- Does anyone pay: kit, workspace, recipe, school pilot, vendor support, or
  prototype workflow?
- Does the context graph reduce repair loops over time?
- Does module-add cost decrease as the package/driver corpus grows?

These require benchmark runs, user tests, or payment experiments.

### Low-value next work

These are lower-value until hands-on data exists:

- Adding more generic "AI hardware" competitors without testing them.
- Adding more software AI market numbers.
- Re-litigating whether the market is "big."
- Writing stronger deck language before the claims are gated.
- Extending appstore strategy without rerun/fork evidence.
- Debating all possible users instead of testing one buyer segment.

### High-value next work

Do these next:

1. Run Blockless on the 10 benchmark tasks where hardware exists.
2. Run PleaseDontCode on tasks 1, 2, 3, 8, and 9.
3. Run ChatGPT/Cursor + PlatformIO/Arduino CLI on tasks 1, 3, 4, and 10.
4. Run one tutorial baseline for task 1.
5. Run one simulation/visual baseline for tasks 1, 3, and 6.
6. Ask five users the customer interview script after a real run.
7. Try one paid behavior: kit preorder, school pilot, vendor recipe, or paid
   workspace.

### Stop condition for this research phase

This phase can be considered complete when:

- the memo contains the competitor map, red-team questions, claim gates,
  benchmark protocol, and deck rewrite checklist;
- no remaining desk-research question is likely to change the positioning
  without hands-on data;
- the next work is clearly empirical.

By that standard, desk research is close to complete. The larger strategy is
not proven until benchmark and market behavior data exists.

### Customer research

- Watch 10 beginners attempt the same ESP32 project from a tutorial.
- Measure where they fail: board setup, package install, pin wiring, flashing,
  serial interpretation, or code.
- Ask whether they would pay after the first successful run.
- Track whether they build a second project within 7 days.

### Technical evidence

- Build a public compatibility matrix for the v1 board/module set.
- Record every failed flash/run and classify it.
- Create a known-failure database with repair hints.
- Show before/after: normal tutorial time vs. Blockless time.

### Marketplace evidence

- Publish 20 verified recipes.
- Measure reruns, forks, edits, and successful reproductions.
- Measure whether users combine recipes into new projects.
- Measure whether recipe metadata reduces support questions.

### Economic evidence

- Test kit purchase after recipe preview.
- Test paid workspace after first successful run.
- Test paid recipe/package for higher-value modules.
- Test whether schools, maker spaces, and hardware sellers want curated recipe
  libraries.

## Deck rewrite checklist

Before rewriting any slide, classify each sentence.

| Slide theme | Allowed today | Requires proof | Forbidden until proven |
|---|---|---|---|
| Category | "AI codegen is not enough for hardware" | "Blockless is the standard AI hardware workflow" | "Hardware is empty" |
| Competitors | "Existing tools solve pieces" | "Blockless beats PleaseDontCode/Embedr/Cirkit" | "Competitors only generate code" |
| Schematik | "Schematik validates category interest" | "Schematik chose the wrong stack" | "Schematik failed" |
| Stack | "MicroPython is our v1 wedge" | "MicroPython is faster/better on our tasks" | "MicroPython is always better than C" |
| Package intelligence | "Generated code must be grounded in real package context" | "Our package layer prevents X% failures" | "Not replicable" |
| Repair | "Logs and structured context make repair possible" | "Blockless repairs X% failures" | "Automatic repair works" |
| Appstore | "Verified recipe registry" | "Appstore/marketplace" | "Users will pay for recipes" |
| Market | "US maker/education/vendor channels are plausible entry points" | "$100M ARR / top Kickstarter / recurring subscription" | TAM by giant adjacent populations |
| Business model | "Business model depends on observed paid behavior" | "70% hardware sales / SaaS split" | Any revenue mix without attach-rate evidence |
| Moat | "Context graph could compound" | "Context graph improves success over time" | "Data is automatically a moat" |

### Deck sentence substitutions

Use these replacements:

- Replace "The physical world has no agent" with "No dominant workflow has made
  real hardware builds reproducible from intent to rerun."
- Replace "Hardware is still empty" with "AI hardware tools exist, but the
  durable artifact is still unsettled."
- Replace "Nothing democratizes physical things yet" with "Learning tools help
  people start; the build-run-debug-reuse loop remains fragmented."
- Replace "Someone already tried Cursor for hardware. It didn't work" with
  "Early Cursor-for-hardware attempts validate the category and expose the
  stack risk."
- Replace "Hardware App Store" with "verified recipe registry" until rerun and
  payment behavior exists.
- Replace "No compile, no flash" with "fast hot-reload after firmware setup."
- Replace "LLMs write Python 10x more accurately than C" with "MicroPython is
  a plausible LLM-friendly v1 stack; we will benchmark it on hardware tasks."
- Replace "$100M+ ARR" with a bottom-up scenario tied to active users, ARPU,
  attach rate, margin, and churn.

### One sentence to keep

> AI can write code. Hardware needs verified recipes.

## Suggested deck-level clarity

The deck should not lead with "LLM for hardware." It should lead with the
broken workflow:

1. Hardware ideas fail in the gap between tutorial and real device.
2. Code assistants cannot see pins, packages, drivers, wiring, firmware, or
   serial logs.
3. Blockless closes the loop from sentence to verified run.
4. The moat is the hardware context graph.
5. Verified recipes become the distribution unit.
6. The appstore compounds through rerun/fork/repair data.
7. V1 is narrow by design to keep success rate high.
8. The key validation is repeated project behavior, not demo excitement.

The investor/user takeaway should be:

> Blockless makes hardware creation behave like software package reuse: build,
> run, repair, package, fork, rerun, publish.

## Execution appendix: benchmark files

The research memo now has a runnable benchmark scaffold in
`docs/research/blockless-benchmark/`.

- `README.md`: benchmark purpose, P0/P1/P2 systems, evidence standard, and stop
  conditions.
- `tasks.json`: the 10 same-task prompts, required hardware, thesis being
  tested, pass conditions, and controlled failure for bad-pin repair.
- `result.schema.json`: structured result format for time, interventions,
  failure labels, evidence artifacts, scoring, and claim impact.
- `run-sheet.md`: human-run template for recording prompts, logs, wiring,
  repair attempts, and reproducibility.
- `../blockless_research_exhaustion_audit.md`: completion audit separating
  desk-research conclusions from benchmark- and market-gated claims.

This is the boundary between research and proof. The memo can support a clearer
deck, but the strongest claims remain benchmark-gated until these runs exist.
