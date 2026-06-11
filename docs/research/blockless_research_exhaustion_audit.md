# Blockless Research Exhaustion Audit

Date: 2026-06-11

Purpose: audit whether the current Blockless research has actually exhausted
the competitors, data, logic, and vibe-coding analogy behind the pitch. This is
not a narrative doc. It is a completion check.

## Verdict

The desk research is close to exhausted for the current pitch question.

The overall objective is not complete because the decisive evidence is not desk
research. The unresolved gates require hands-on competitor benchmarks, real
hardware runs, second-user reruns, and willingness-to-pay tests.

## Requirement Audit

| Requirement from objective | Current evidence | Status | What would prove completion |
|---|---|---|---|
| Analyze the UberCab 2008 deck page by page | `blockless_ubercab_page_by_page.md` maps all 25 pages to Blockless evidence requirements | Desk-research complete | No further desk work required unless a different UberCab source/deck version is introduced |
| Create a Blockless doc with similar clarity | `blockless_ubercab_style_clarity_doc.md` compresses the story into thesis, product, moat, wedge, appstore, claims allowed/not allowed | Draft complete | Convert into a final deck only after benchmark and progress evidence exists |
| Question direct AI-hardware competitors | Main memo covers PleaseDontCode, Schematik, Cirkit Designer, Embedr, Aily Blockly, ArduinoGPT-style clones, academic systems | Desk-research largely complete | Hands-on runs of PleaseDontCode, Cirkit/Wokwi, and generic AI+PlatformIO on the same tasks |
| Question embedded workflow incumbents | Main memo and refresh cover PlatformIO, ESPHome, Arduino Cloud, Blynk, Particle | Desk-research complete enough for pitch risk | Same-task baseline runs on ESPHome/PlatformIO/Arduino Cloud/Blynk where task fit exists |
| Question AI ECAD/PCB automation | `blockless_competitor_exhaustion_map.md` and source ledger cover Flux, Quilter, Diode, SnapMagic, tscircuit, KiCad, SchGen, pcbGPT, PCBSchemaGen, OmniSch | Desk-research complete enough to narrow category language | Hands-on only required if deck claims broad AI hardware design/PCB/fab superiority |
| Question IoT/event, edge-AI, fleet, and code-to-device runtimes | Source ledger covers Node-RED, Tasmota, Home Assistant ESPHome integration, Adafruit IO, Ubidots, Edge Impulse, SenseCraft, Blues, ThingsBoard, Hologram, DeviceScript, Johnny-Five | Desk-research complete enough to ban uniqueness claims around dashboards/events/runtimes/AI-on-hardware/production IoT | Same-task tests where the workflow overlaps tasks 2, 4, 7, home-automation variants, edge-AI variants, or connected-product/fleet variants |
| Question robotics, industrial IoT, and live visual physical-computing adjacencies | `blockless_adjacent_competitor_gap_refresh_2026_06_11.md` adds Viam, Golioth, Losant, Zerynth, MicroBlocks, and XOD as gate-specific pressure sources | Desk-research complete enough to narrow broad physical-world, industrial IoT, and live/no-code claims | Same-task baselines only if the deck claims robotics lifecycle, device-cloud/fleet, industrial app-enablement, factory AI, live hardware iteration, or visual/no-code physical computing |
| Question education/no-code/simulation incumbents | Main memo and refresh cover Wokwi, Tinkercad, MakeCode, Visuino, Mind+, Mixly, Cirkit | Desk-research complete enough for wedge choice | Classroom-style completion test against blocks/simulation |
| Question distribution/community incumbents | Main memo covers Hackster, Arduino Project Hub, Adafruit Learn, Seeed Wiki, Instructables | Desk-research complete enough for appstore skepticism | Convert a known tutorial into a recipe and compare second-user completion |
| Question vibe-coding analogy | Main memo and clarity docs compare Cursor, Lovable, Bolt, v0, Replit Agent, Copilot, Base44, software artifacts, Stack Overflow 2025, METR 2025 | Desk-research complete for analogy limits | Hardware-specific repeat-use, payment, and trust data |
| Question market behavior | Main memo identifies repeat project rate, rerun/fork rate, kit attach, workspace conversion, paid recipe/package purchase | Hypothesis only | Cohort data from real users over at least second and third projects |
| Question moat logic | Main memo defines hardware execution context graph and warns that data is not automatically moat | Logic complete; evidence missing | Show that each verified run improves future success/reduces failure rate |
| Question appstore logic | Main memo downgrades appstore to verified recipe registry until rerun/fork/payment exists | Logic complete; market evidence missing | 20+ recipes, second-user reruns, forks, paid/attach behavior |
| Question MicroPython stack logic | Main memo downgrades MicroPython to narrow v1 wedge and compares against Arduino/C/PlatformIO/ESPHome | Logic complete; benchmark missing | Same-task timing/reliability results vs Arduino/C and ESPHome |
| Question deck claims | Main memo includes red-team claim table and forbidden/downgraded claims | Complete for current v12 claims | Update again after actual deck rewrite or new claims |
| Produce executable validation tools | `blockless-benchmark/` contains tasks, schema, run sheet, README, wedge gates | Scaffold complete | Actual populated benchmark run folders with result JSON and evidence files |

## Artifact Map

Use these files for different decisions:

| Artifact | Use |
|---|---|
| `docs/research/blockless_clarity_research.md` | Full research memo and adversarial evidence map |
| `docs/research/blockless_ubercab_style_clarity_doc.md` | Short deck-ready reasoning spine |
| `docs/research/blockless_ubercab_page_by_page.md` | UberCab page-by-page clarity mapping |
| `docs/research/blockless_deck_v12_slide_audit.md` | Slide-level audit of current v12 deck claims |
| `docs/research/blockless_competitor_exhaustion_map.md` | Category-level competitor pressure and broad-language guardrails |
| `docs/research/blockless_hard_questions_addendum.md` | Extra pressure from MCP/agent plumbing, hardware-log tooling, and source-integrity gaps |
| `docs/research/blockless_direct_substitute_claim_audit.md` | Direct competitor claim audit for PleaseDontCode, Embedr, Cirkit, Schematik, and Aily |
| `docs/research/blockless_competitor_source_refresh_2026_06_11.md` | Dated refresh of closest competitor pages, citation hygiene, and updated hard questions |
| `docs/research/blockless_vendor_platform_source_refresh_2026_06_11.md` | Dated refresh restoring Espressif ESP-Claw/MCP/Docs AI as source-backed vendor-platform pressure and keeping Arduino Cloud AI Assistant quarantined |
| `docs/research/blockless_adjacent_competitor_gap_refresh_2026_06_11.md` | Dated refresh for robotics lifecycle, industrial IoT app-enablement, device-cloud, live blocks, and visual physical-computing pressure |
| `docs/research/blockless_source_ledger.md` | Source-by-source evidence limits and allowed claims |
| `docs/research/blockless-benchmark/README.md` | How to run the benchmark |
| `docs/research/blockless-benchmark/tasks.json` | Ten same-task prompts |
| `docs/research/blockless-benchmark/result.schema.json` | Structured result format |
| `docs/research/blockless-benchmark/validate_result.py` | Dependency-free validator for benchmark result JSON, market signals, and market-cohort count sanity |
| `docs/research/blockless-benchmark/claim_gate_matrix.schema.json` | Structured format for mapping pitch claims to gates, baselines, pass conditions, kill conditions, and forbidden inferences |
| `docs/research/blockless-benchmark/claim-gate-matrix.json` | Current high-risk claim matrix; use before upgrading deck language |
| `docs/research/blockless-benchmark/claim_scan_patterns.schema.json` | Structured format for deck scan patterns tied to claim IDs |
| `docs/research/blockless-benchmark/claim-scan-patterns.json` | Current risky-language pattern list |
| `docs/research/blockless-benchmark/scan_deck_claims.py` | Deck scanner that flags forbidden, market-gated, and benchmark-gated language |
| `docs/research/blockless-benchmark/market_signal.schema.json` | Structured market behavior signal format for repeat-use, rerun/fork, kit, paid, and support evidence |
| `docs/research/blockless-benchmark/market_cohort.schema.json` | Structured market cohort summary format for denominator, segment mix, support load, follow-up, and claim permissions |
| `docs/research/blockless-benchmark/run-sheet.md` | Human benchmark recording sheet |
| `docs/research/blockless-benchmark/task-01-p0-preregistration.md` | Pre-run packet that fixes task 01 hardware, null hypotheses, evidence, and scoring thresholds |
| `docs/research/blockless-benchmark/wedge-gates.md` | Maker/education/IoT/marketplace proof gates |
| `docs/research/blockless-benchmark/market-validation-runbook.md` | Repeat-use, rerun/fork, and paid-behavior test plan |

## Competitor Exhaustion Status

### Exhausted enough for desk research

These categories have enough public-source pressure to prevent broad claims:

- direct AI hardware workflow: PleaseDontCode, Schematik, Cirkit Designer;
- AI ECAD/PCB automation: Flux, Quilter, Diode, SnapMagic, tscircuit, KiCad,
  SchGen, pcbGPT, PCBSchemaGen;
- embedded tooling: PlatformIO, ESPHome, Arduino Cloud, Blynk, Particle,
  DeviceScript, Johnny-Five;
- IoT/event automation: Node-RED, Home Assistant ESPHome integration, Tasmota,
  Adafruit IO, Ubidots;
- edge AI and no-code AIoT: Edge Impulse, SenseCraft;
- connected-product and fleet platforms: Blues Notehub, ThingsBoard, Hologram;
- robotics lifecycle and industrial IoT app-enablement: Viam, Golioth, Losant,
  Zerynth;
- simulation/education/no-code: Wokwi, Tinkercad, MakeCode, Visuino, Mind+,
  Mixly, MicroBlocks, XOD;
- tutorial/community distribution: Arduino Project Hub, Adafruit Learn, Seeed
  Wiki, Hackster, Instructables;
- software analogy: Cursor, Lovable, Bolt, v0, Replit Agent, GitHub Copilot,
  Base44/Windsurf class;
- research direction: recent LLM-for-embedded/circuit papers.
- agent plumbing and MCP pressure: Anthropic MCP, MCP docs, GitHub Copilot MCP,
  OpenAI agent tooling, MCP security/maintainability research.

The conclusion from desk research is stable:

> "AI hardware builder" is crowded across firmware, PCB, IoT, simulation, and
> cloud workflows. "Closed loop" is contested. The defensible Blockless claim
> is verified, rerunnable hardware recipes inside a controlled v1 matrix.

### Not exhausted because public pages are insufficient

These cannot be resolved without using the products:

- Does PleaseDontCode's claimed loop work reliably on the same tasks?
- Does PleaseDontCode's public project artifact equal or beat Blockless
  recipes?
- Does PleaseDontCode's pricing/fleet/device model indicate a stronger
  monetization path than Blockless recipes?
- Do PleaseDontCode public/project-download artifacts preserve enough state for
  a second-user rerun?
- Does Embedr's firmware/board-bring-up/KiCad/serial/Git workflow beat
  Blockless for pro/prototyping users?
- Can ChatGPT/Cursor plus PlatformIO solve 80 percent of the v1 workflow?
- Does Wokwi/Cirkit beat Blockless for beginners by avoiding physical setup?
- Does ESPHome beat Blockless on sensor/actuator IoT tasks?
- Does Tasmota or Home Assistant beat Blockless when the task is really home
  automation?
- Does Edge Impulse or SenseCraft beat Blockless when the task is really model,
  vision, sound, anomaly, HMI, or no-code edge-AI deployment?
- Does Blues Notehub, ThingsBoard, or Hologram own the recurring value when the
  task is connected-product, telemetry, connectivity, fleet, or production IoT?
- Does Viam own the workflow when the task is robotics lifecycle, remote
  control, driver/model registry, or fleet operation rather than bench recipe?
- Does Golioth own the recurring value when the task is Zephyr/ESP-IDF OTA,
  logs, settings, RPC, data routing, or secure embedded-device cloud?
- Does Losant or Zerynth own the value when the task is industrial IoT
  app-enablement, factory analytics, dashboards, AI over telemetry, or
  ERP/MES integration?
- Does MicroBlocks or XOD beat Blockless when the user values live board
  interaction, visual inspectability, and blocks/dataflow over natural language?
- Does DeviceScript or Johnny-Five undermine the MicroPython runtime claim?
- Do tutorials still win because they explain context better?
- Can a modern coding agent with docs retrieval, command execution, flash
  tooling, and serial-log inspection solve enough of the v1 workflow?
- Can ESP-Claw, Espressif Docs MCP, Espressif Docs AI, or Espressif RainMaker
  MCP solve enough ESP32 workflow through official vendor context and device
  cloud surfaces?
- If vendor/community manifests are exposed through MCP-like servers, does
  Blockless still own a context advantage?

## Data and Logic Questions Still Open

These are not optional. A strong deck needs answers.

1. What is the first-run success rate for Blockless on real hardware?
2. What is median sentence-to-working-device time?
3. How many repair loops are required per successful run?
4. What percentage of failures are code, package, driver, pin, wiring, flash,
   runtime, network, or user setup?
5. Does the system classify failure correctly from logs?
6. Does auto-repair work on failures that are not compile errors?
7. Can a second user rerun a recipe without hidden context from the original
   session?
8. Do users make a second and third project?
9. Do users fork or combine recipes?
10. Do users pay for kit, workspace, recipe, package, or vendor-supported lab?
11. Does support cost stay controlled as the module matrix grows?
12. Does each run add reusable context that improves future success?
13. Does broad AI hardware language cause investors to benchmark Blockless
    against Flux, Quilter, Diode, SnapMagic, and tscircuit instead of the bench
    recipe workflow?

## Analogy Audit

The vibe-coding analogy survives only at the artifact/workflow level.

What transfers:

- prompt-to-working artifact;
- project context;
- iteration loop;
- logs;
- reviewable changes;
- deploy/publish;
- templates/marketplace;
- usage metrics.

What does not transfer automatically:

- instant live URL;
- low marginal reproduction cost;
- no physical inventory;
- no wiring;
- no board clones or pin variants;
- software subscription frequency;
- trust in AI output;
- marketplace liquidity.

Therefore the allowed statement is:

> Software vibe-coding shows the shape of the workflow. Hardware needs its own
> proof because the artifact is physical, fragile, and harder to reproduce.

The forbidden statement is:

> Cursor/Lovable worked, therefore Blockless will work.

## Completion Criteria For This Research Goal

The goal can only be marked complete when all of these are true:

1. Desk research has named and pressure-tested all known direct and adjacent
   competitors relevant to the current wedge.
2. The pitch claims have been downgraded wherever public competitor evidence
   contradicts them.
3. A same-task benchmark has been run against at least:
   - Blockless;
   - PleaseDontCode;
   - ChatGPT/Cursor plus PlatformIO or Arduino CLI;
   - one simulation/visual baseline;
   - one tutorial baseline.
4. Benchmark evidence includes prompts, code, wiring, install logs, flash logs,
   serial/run logs, repair attempts, and recipe artifacts.
5. At least one second-user rerun has been measured.
6. At least one market behavior test has measured repeat project, rerun/fork,
   kit attach, workspace conversion, or paid recipe/package interest.
   Market behavior must be summarized as a cohort, not cited from one isolated
   signal.
7. The final deck uses only claims supported by the above evidence.
   Each upgraded claim should map to `claim-gate-matrix.json`.
   Deck Markdown should pass `scan_deck_claims.py` at the chosen severity gate.
8. The same-task benchmark includes an agentic baseline, not only a chat-plus-CLI
   baseline.

Current state:

- Items 1 and 2 are largely satisfied by desk research.
- Items 3 through 8 are not satisfied.

## Immediate Next Research Actions

Run these before writing a more aggressive deck:

1. Run Blockless on tasks 1, 3, 4, and 10 from `tasks.json`.
2. Run ChatGPT/Cursor plus PlatformIO or Arduino CLI on the same tasks.
3. Run a modern agentic IDE/CLI baseline with docs retrieval, command
   execution, flash tooling, and serial-log inspection on the same tasks.
4. Run PleaseDontCode on tasks 1, 2, 3, 8, and 9 if access allows.
5. Run Wokwi or Cirkit on tasks 1, 3, and 6.
6. Run ESPHome or Tasmota on the closest home-automation versions of tasks 1,
   5, and 7.
7. Run Node-RED/Blynk/Arduino Cloud/Ubidots only for endpoint/dashboard tasks
   where they are a natural baseline.
8. Run Edge Impulse/SenseCraft only when AI vision, sound, anomaly, HMI,
   no-code edge AI, or hardware-vibe-coding language is claimed.
9. Run Blues Notehub/ThingsBoard/Hologram only when connected-product,
   telemetry, connectivity, fleet, or production-IoT language is claimed.
10. Convert one Adafruit/Arduino/Seeed tutorial into a Blockless recipe and have
   a second user rerun it.
11. Record every run with `run-sheet.md` and `result.schema.json`.

Until those runs exist, the honest final answer is:

> Blockless has a strong, narrowed thesis. It does not yet have proof strong
> enough for broad category, marketplace, or vibe-coding-scale claims.
