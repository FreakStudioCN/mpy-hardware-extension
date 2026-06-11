# Wedge Gates

These gates decide which market Blockless is actually allowed to pitch.
Do not use one wedge's evidence to prove another wedge.

## Gate 1: Maker Prototyping

Question:

> Does Blockless make a real device work faster and with fewer hidden failures
> than tutorials, generic AI plus PlatformIO/Arduino CLI, and PleaseDontCode?

Baselines:

- ChatGPT/Cursor + PlatformIO or Arduino CLI
- PleaseDontCode
- Arduino/Adafruit/Seeed tutorial

Required tasks:

- `task-01-temperature-fan`
- `task-03-agent-status-display`
- `task-04-sensor-events-app`
- `task-10-bad-pin-repair`

Pass threshold:

- Blockless wins median time-to-working-device.
- Blockless has fewer manual docs searches and manual code edits.
- Blockless correctly diagnoses at least one wiring/pin/package failure.
- A second user can rerun at least one generated recipe.

Kill condition:

- Generic AI + PlatformIO solves most v1 tasks with similar effort.
- PleaseDontCode produces an equivalent rerunnable artifact.
- PleaseDontCode ties Blockless on task success, artifact completeness, and
  second-user rerun; a tie means closed-loop differentiation is not proven.
- The user's main friction is buying/assembling parts, not code/package/repair.

## Gate 2: Education

Question:

> Does Blockless improve classroom completion, or do simulation and blocks win?

Baselines:

- Wokwi or Cirkit Designer
- MakeCode or Tinkercad Circuits
- A known beginner tutorial

Required tasks:

- `task-01-temperature-fan`
- `task-03-agent-status-display`
- `task-06-dark-beep-log`

Pass threshold:

- 20-student or 10-pair classroom test.
- Higher completion rate than visual/simulation baseline.
- Equal or lower teacher intervention count.
- Students can explain the wiring and logic, not only paste prompts.

Kill condition:

- Students complete more reliably with blocks/simulation.
- Teacher support increases because agent output is opaque.
- Physical-kit setup dominates the session.

## Gate 3: IoT App/Control

Question:

> Does Blockless create reusable device-app workflows, or only duplicate
> Arduino Cloud, Blynk, Particle, and ESPHome dashboards?

Baselines:

- Arduino Cloud
- Blynk
- ESPHome + Home Assistant
- Particle, if hardware fit is available
- Node-RED or Adafruit IO when the task is primarily event routing/dashboarding

Required tasks:

- `task-02-button-ai-workflow`
- `task-04-sensor-events-app`
- `task-05-wifi-disconnect-rgb`
- `task-07-motion-display-event`

Pass threshold:

- Recipe includes endpoint manifest.
- Device event payload is documented and replayable.
- User can fork/rerun the device-app workflow on compatible hardware.
- Logs explain endpoint, firmware, network, and device-state failures.
- Artifact audit shows Blockless preserves more rerun-critical context than
  a dashboard, YAML file, cloud template, or flow export.
- Blockless does not need to become the device cloud; it must export enough
  endpoint/device context to interoperate cleanly.

Kill condition:

- Existing IoT platforms solve the workflow faster.
- Blockless output becomes a dashboard wrapper with no recipe advantage.
- Production users immediately need a different device cloud.
- The recurring value belongs to Blynk, Particle, Arduino Cloud, Home
  Assistant, or Node-RED while Blockless remains a one-time code generator.

## Gate 4: Recipe Marketplace

Question:

> Do verified recipes create more reuse than tutorials and project galleries?

Baselines:

- Arduino Project Hub
- Adafruit Learn
- Seeed Wiki
- Hackster or Instructables

Required tasks:

- `task-08-publish-recipe`
- `task-09-rerun-recipe`
- One converted known tutorial

Pass threshold:

- At least 20 published verified recipes.
- At least 30 percent of recipes are rerun by a second user.
- At least 15 percent are forked or modified.
- Rerun success beats tutorial completion on the same project.
- Users show willingness to pay for kit, workspace, recipe, or package.

Kill condition:

- Recipes are browsed but not rerun.
- Users prefer tutorials because they explain more context.
- Hardware purchase happens through Adafruit/Seeed/Amazon without Blockless
  capturing margin or workflow ownership.

## Gate 5: Vendor / Platform Context

Question:

> Does Blockless own dynamic hardware execution context, or do vendor docs,
> official IDEs, PlatformIO, and generic agents already cover enough of the
> workflow?

Baselines:

- PlatformIO with generic AI for ESP32 tasks
- Arduino IDE or Arduino CLI for Arduino-compatible tasks
- Arduino App Lab for UNO Q / App Lab-fit sketch, Python, AI, or Brick tasks
- ESP-IDF CLI or Espressif VS Code extension for technical ESP32 tasks
- ESP-Claw for ESP32 AI-agent / IoT behavior tasks
- Espressif Docs MCP or Docs AI for official-docs-plus-agent tasks
- Espressif RainMaker MCP for device-cloud/control/dashboard tasks
- Vendor docs plus generic AI
- Vendor tutorial conversion from Arduino, Adafruit, Seeed, or SparkFun

Required tasks:

- `task-01-temperature-fan`
- `task-03-agent-status-display`
- `task-10-bad-pin-repair`
- One converted official vendor tutorial

Pass threshold:

- Blockless preserves run-specific context not present in the vendor baseline:
  exact variants, pins, wiring, package versions, logs, repairs, and rerun
  history.
- Blockless reduces first-run or repair friction versus official tooling plus
  generic AI on the same hardware.
- A second tester reruns the Blockless artifact more reliably than the official
  IDE project or vendor tutorial artifact.
- The artifact remains useful inside existing IDE/vendor workflows rather than
  requiring users to abandon them prematurely.

Kill condition:

- Official docs plus a generic agent produce the same working project with
  similar effort.
- PlatformIO, Arduino CLI/IDE/App Lab, ESP-IDF, or Espressif VS Code absorbs
  the hard parts: board setup, libraries, build, flash, monitor, or debug.
- ESP-Claw or Espressif MCP solves the task well enough through official vendor
  AI/context/device-cloud surfaces.
- Vendor tutorials convert into machine-readable rerunnable artifacts with
  comparable reliability.
- Blockless data is mostly normalized vendor documentation, not measured
  execution outcomes that compound with every run.

## Gate 6: Edge AI / Production IoT

Question:

> When the task is AI vision, sound, anomaly detection, connected-product
> deployment, or fleet operations, is Blockless the system of record or only a
> recipe generator upstream of a stronger platform?

Baselines:

- Edge Impulse for dataset, training, optimization, and deployment tasks
- SenseCraft for no-code edge AI, AI vision/sound, HMI, fleet, and hardware
  vibe-coding claims
- Viam for robotics lifecycle, machine APIs, remote control, driver/model
  registry, fleet monitoring, or robot OTA claims
- Blues Notehub for cellular/satellite/LoRa/Wi-Fi connected-product workflows
- Golioth for Zephyr/ESP-IDF device-cloud workflows involving secure
  connectivity, OTA, logs, settings, RPC, data routing, or fleet management
- ThingsBoard for device management, telemetry, dashboards, rule chains, and
  edge/gateway workflows
- Hologram when the task depends on cellular connectivity and outage/coverage
  management
- Losant or Zerynth for industrial IoT app-enablement, low-code workflows,
  factory analytics, dashboards, AI-copilot-over-telemetry, or ERP/MES
  integration claims

Required tasks:

- `task-02-button-ai-workflow` when the workflow endpoint is the core value
- `task-04-sensor-events-app`
- `task-07-motion-display-event`
- One edge-AI vision/sound/anomaly task if the deck claims AI-on-hardware
- One connected-product/fleet task if the deck claims production IoT value

Pass threshold:

- Blockless produces the physical recipe and exports enough model, endpoint,
  connectivity, device, and fleet context to interoperate with the stronger
  platform.
- Blockless reduces hardware bring-up or repair friction before handoff to the
  edge-AI or IoT platform.
- The recipe artifact remains rerunnable by a second user after model,
  endpoint, dashboard, or connectivity credentials are replaced.
- The value claim is explicitly bounded: recipe creation, not model training,
  connectivity operations, fleet management, or production observability unless
  measured.

Kill condition:

- Edge Impulse or SenseCraft owns the user's actual job because the hard part is
  dataset/model/app deployment, not board/module/pin/recipe generation.
- Blues, ThingsBoard, Hologram, Blynk, Particle, Arduino Cloud, or a similar
  platform owns the recurring value through connectivity, device management,
  dashboards, alerts, OTA, support, or fleet operations.
- Viam owns the recurring value because the user's job is robotics lifecycle,
  remote operation, machine APIs, driver/model deployment, or fleet control.
- Golioth, Losant, or Zerynth owns the recurring value because the user's job is
  secure device cloud, industrial app-enablement, factory analytics, workflows,
  ERP/MES integration, or AI over operational telemetry.
- Blockless cannot rerun the physical project after credentials, endpoint,
  model version, or connectivity provider changes.
- The pitch uses "AI hardware" or "connected product" language but the product
  only creates a one-time firmware/demo artifact.

## Decision Rule

The first wedge to clear its gate becomes the deck wedge.

If no wedge clears:

- do not pitch "hardware appstore";
- do not pitch broad maker/education/IoT market;
- retreat to a narrower developer tool claim:
  "verified recipe generation and repair for a controlled ESP32 module matrix."
