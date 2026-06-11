# Handoff - Blockless Diligence / UberCab-Style Clarity Research

Date: 2026-06-11

## Goal

Continue the active research goal:

> Keep asking tough questions, question the data and logic behind every finding,
> and exhaust the competitor landscape, data logic, and vibe-coding analogy for
> Blockless.

Do not mark the goal complete yet. Desk research is much stronger now, but the
goal still requires real evidence: hands-on competitor benchmarks, second-user
recipe reruns, and paid/repeat-use behavior.

## Current Progress

The current defensible thesis is:

> Blockless is a verified hardware recipe workflow for a controlled ESP32 module
> matrix. It turns intent into a real run, captures logs and repair context, and
> produces a rerunnable recipe.

The current warning is:

> Do not pitch Blockless as the first AI hardware builder, the only closed loop,
> or the inevitable hardware version of Cursor/Lovable. Current evidence does
> not support those claims.

Latest continuation state:

- The active English deck now passes the strict benchmark-gated claim scanner:
  `python docs\research\blockless-benchmark\scan_deck_claims.py docs\pitch\deck\deck_en.md --fail-on benchmark_gated`
- The negative scanner fixture still catches the intended forbidden/market-gated
  claims with `--expect-findings`.
- Deprecated deck artifacts were checked as an artifact-leakage risk:
  `docs/pitch/deck/SPEC.md`, `docs/pitch/deck/deck_cn.md`, and
  `docs/pitch/deck/deck_cn.html` all carry deprecation/quarantine warnings.
  The HTML deck includes a visible fixed warning banner in the rendered page.
- The next hard question is not "is the active deck safer?" It is whether any
  future translation, HTML render, or competition deck can bypass the active
  scanner and reintroduce appstore/Cursor/TAM/closed-loop claims.

## Main Research Artifacts

Start with:

1. `docs/research/blockless_diligence_pack.md`
   - Operating index and 68 tough questions.
   - Read before editing the deck, website, memo, or benchmark plan.
2. `docs/research/research-INDEX.md`
   - Phase 3 source of truth and reading order.
   - Phase 2 files are explicitly marked as historical sediment unless restored
     and rechecked.
3. `docs/research/blockless_ubercab_style_clarity_doc.md`
   - Compressed UberCab-style Blockless story.
4. `docs/research/blockless_deck_v12_slide_audit.md`
   - Slide-by-slide pressure test of `docs/pitch/deck/deck_en.md`.
5. `docs/research/blockless_source_ledger.md`
   - Source-by-source evidence limits.
6. `docs/research/blockless_research_exhaustion_audit.md`
   - What desk research has covered and what remains unproven.
7. `docs/research/blockless_competitor_exhaustion_map.md`
   - Category map across direct AI hardware tools, AI ECAD/PCB, embedded
     tooling, IoT platforms, platform/vendor up-stack, education/simulation,
     tutorials, runtimes, and software vibe-coding tools.

Important newer audits:

- `docs/research/blockless_direct_substitute_claim_audit.md`
  - PleaseDontCode, Embedr, Cirkit, Schematik, Aily.
  - Key conclusion: direct substitutes already claim more than codegen.
- `docs/research/blockless_competitor_source_refresh_2026_06_11.md`
  - Refreshed closest live source pages.
  - Key conclusion: PleaseDontCode is the P0 closed-loop benchmark; cite
    `embedr.app` for Embedr and do not confuse it with unrelated `embedr.ai`.
- `docs/research/blockless_monetization_falsification_audit.md`
  - Pricing surfaces exist, but paid recipe/appstore demand is unproven.
- `docs/research/blockless_platform_vendor_pressure_audit.md`
  - Vendors own static hardware truth; Blockless must prove dynamic verified
    execution history compounds.
- `docs/research/blockless_vendor_platform_source_refresh_2026_06_11.md`
  - Restores source-backed pressure from Espressif ESP-Claw, Espressif MCP
    servers, and Espressif Docs AI.
  - Keeps exact "Arduino Cloud AI Assistant" claims quarantined.
- `docs/research/blockless_adjacent_competitor_gap_refresh_2026_06_11.md`
  - Adds Viam, Golioth, Losant, Zerynth, MicroBlocks, and XOD as pressure
    sources for robotics lifecycle, industrial IoT, device-cloud, live hardware
    iteration, and visual/no-code physical-computing claims.
- `docs/research/blockless_market_size_data_falsification_audit.md`
  - MCU shipments, Arduino/Raspberry Pi installed base, Kickstarter, AI gadget
    revenue, STEM populations, and Cursor/Lovable ARR do not prove Blockless
    demand.
- `docs/research/blockless_vibe_coding_analogy_stress_test.md`
  - Software vibe coding transfers workflow shape, not hardware market proof.
- `docs/research/blockless_hard_questions_addendum.md`
  - MCP/tool plumbing, log debugging, and generic-agent baselines.

Benchmark scaffold:

- `docs/research/blockless-benchmark/README.md`
- `docs/research/blockless-benchmark/tasks.json`
- `docs/research/blockless-benchmark/result.schema.json`
- `docs/research/blockless-benchmark/claim_gate_matrix.schema.json`
- `docs/research/blockless-benchmark/claim-gate-matrix.json`
- `docs/research/blockless-benchmark/claim_scan_patterns.schema.json`
- `docs/research/blockless-benchmark/claim-scan-patterns.json`
- `docs/research/blockless-benchmark/scan_deck_claims.py`
- `docs/research/blockless-benchmark/market_signal.schema.json`
- `docs/research/blockless-benchmark/market_cohort.schema.json`
- `docs/research/blockless-benchmark/validate_result.py`
  - Structural validation plus market-cohort count sanity checks.
- `docs/research/blockless-benchmark/recipe.schema.json`
- `docs/research/blockless-benchmark/p0-runbook.md`
- `docs/research/blockless-benchmark/verified-recipe-spec.md`
- `docs/research/blockless-benchmark/market-validation-runbook.md`
- `docs/research/blockless-benchmark/wedge-gates.md`
- `docs/research/blockless-benchmark/task-01-p0-preregistration.md`

The JSON files have previously been parsed successfully with `python -m
json.tool`.

## Current Deck Changes

`docs/pitch/deck/deck_en.md` has been edited to align active deck language with
Phase 3 diligence.

Main changes:

- Replaced "physical world has no agent / still empty" with verified-creation
  loop framing.
- Replaced "last creative domain still gatekept" and giant market-number proof
  with "scale numbers are not demand proof."
- Removed active-deck use of:
  - `$100M+ ARR`
  - `50K active creators`
  - `~70% hardware sales`
  - `Hardware App Store`
  - `30M Arduino + 60M Raspberry Pi + 50M students` as demand proof
  - `10x better Python`
  - `no compile, no flash`
  - `first time possible`
  - `they bet wrong`
- Changed business model slide to "Business model is a test, not a revenue mix."
- Changed appstore language to "verified recipe registry."
- Changed market slide to require active builders, repeat projects, rerun/fork,
  paid conversion, kit attach, margin, support cost, churn, and recipe
  maintenance.

Verification already run:

- `rg` over `docs/pitch/deck/deck_en.md` found no active-deck matches for the
  banned phrases above.
- Research docs still contain those phrases only as downgraded/forbidden claim
  examples.

Do not regenerate deck HTML unless asked; only `deck_en.md` was intentionally
updated.

## What Worked

- Treat each source by evidence type:
  - docs/marketing prove public claims;
  - pricing pages prove paid surfaces, not adoption;
  - press proves narrative/funding signals, not product reliability;
  - software ARR proves analogy shape, not hardware repeat use;
  - benchmark data is required for speed/reliability/repair claims;
  - user/payment data is required for market claims.
- The strongest Blockless differentiation is not "LLM writes code."
  It is the artifact:
  - board profile
  - module manifest
  - driver/package context
  - pin capability
  - package versions
  - install/flash/run methods
  - serial/run logs
  - failure labels
  - repair hints
  - endpoint manifest
  - compatibility matrix
  - second-user rerun history
- The safest pitch category is "verified hardware recipe workflow," not "AI
  hardware builder" or "hardware appstore."
- The safest market framing is a bottom-up proof plan, not TAM theater.

## What Did Not Work / Do Not Repeat

- Do not use "first," "only," "empty," "inevitable," or "Cursor for hardware"
  as strong claims.
- Do not say competitors only generate code. PleaseDontCode, Embedr, Cirkit,
  and Aily publicly claim many closed-loop ingredients.
- Do not cite `embedr.ai` for embedded workflow claims. Use `embedr.app`;
  `embedr.ai` is a different private-knowledge/RAG product.
- Do not treat PleaseDontCode builder/update counters or pricing tiers as
  adoption proof. They are source-refresh signals to benchmark and question.
- Do not say closed loop is unique until same-task benchmarks prove it.
- Do not claim Schematik failed unless directly verified. Safer: Schematik
  validates category pressure and raises stack/reliability questions.
- ESP-Claw, Espressif MCP servers, and Espressif Docs AI are now source-backed
  vendor/platform pressure. Treat them as baselines, not proof Blockless loses.
- Do not use the exact "Arduino Cloud AI Assistant" claim from older Phase 2
  notes unless a primary Arduino source is restored and checked.
- Do not use MCU shipments, Raspberry Pi/Arduino installed base, Kickstarter
  hardware comps, AI gadget revenue, STEM population, or Cursor/Lovable ARR as
  Blockless demand proof.
- Do not use broad physical-world platform, robotics lifecycle, industrial IoT,
  factory AI, live hardware iteration, or no-code physical-computing claims
  without the adjacent baselines from
  `blockless_adjacent_competitor_gap_refresh_2026_06_11.md`.
- Do not model hardware as 70% revenue before kit attach, gross margin,
  inventory, and support data.
- Do not call the registry an appstore/marketplace until rerun/fork/payment
  behavior exists.
- Avoid writing/rewriting files through shell commands unless necessary.
  `apply_patch` is preferred. A previous line-based PowerShell write introduced
  encoding churn in `deck_en.md`; it was repaired, but avoid repeating that.

## Open Risks In The Active Deck

`docs/pitch/deck/deck_en.md` is now much safer on the highest-risk active-deck
claims:

- no "hardware is empty" or "physical world has no agent" claim;
- no Schematik failure anecdote or 20% package-hallucination attack;
- no hard `<1 sec` hot-reload, no "no compile/no flash," no "wins" framing;
- no Hardware App Store language;
- no $100M ARR, 50K creator, 70% hardware-sales, Kickstarter top-5, $3-7M,
  1,000-order, or 30-module roadmap target;
- no "complete stack" closing line.

Remaining risk areas:

- Slide 7 is explicitly a demo target, not proof. It still needs a real
  benchmark video/log/recipe artifact.
- Slide 8 still mentions BOM/retail targets as unvalidated. Keep that wording
  unless kit economics are measured.
- Slide 10 still uses Arduino/Raspberry Pi/Kickstarter as activity indicators;
  do not upgrade this to market proof.
- `docs/pitch/deck/deck_cn.md`, `docs/pitch/deck/deck_cn.html`, and
  `docs/pitch/deck/SPEC.md` are explicitly deprecated/quarantined. Do not use
  them as current pitch sources unless rewritten from the active EN deck and
  re-scanned.

## Next Steps

1. Run actual benchmark baselines:
   - Blockless
   - ChatGPT/Cursor plus PlatformIO or Arduino CLI
   - agentic IDE/CLI with docs retrieval, shell, flashing, and serial logs
   - PleaseDontCode
   - Embedr
   - Cirkit/Wokwi for education/simulation tasks
   - ESPHome/Tasmota for home-automation tasks
   - Gate 5 vendor/platform baselines:
     PlatformIO, Arduino CLI/IDE/App Lab, ESP-IDF/Espressif VS Code,
     ESP-Claw, Espressif Docs MCP / Docs AI, vendor docs plus generic AI, and
     one vendor tutorial conversion
   - Gate 6 edge-AI / production-IoT baselines when task fit exists:
     Edge Impulse, SenseCraft, Blues Notehub, ThingsBoard, Hologram, and
     Espressif RainMaker MCP when device-cloud/control behavior is claimed
   - Adjacent baselines when broad claims require them:
     Viam, Golioth, Losant, Zerynth, MicroBlocks, and XOD
2. Fill `docs/research/blockless-benchmark/` with real run folders and result
   JSONs.
   - Start by filling `task-01-p0-preregistration.md`, then run
     `task-01-temperature-fan` across the P0 systems.
3. Run second-user reruns:
   - verify whether a recipe can be run without hidden founder/session context.
4. Run market validation:
   - first build
   - second/third project rate
   - rerun/fork behavior
   - kit attach
   - paid workspace/recipe/vendor/school/service intent
   - support touches per successful build
5. Only after those tests, decide whether to upgrade language from:
   - "verified recipe registry" to "appstore"
   - "business model hypotheses" to a revenue model
   - "workflow analogy" to market proof

## Verification Commands Used Recently

Useful commands:

```powershell
rg -n "The 60 Tough Questions|The 68 Tough Questions|blockless_market_size_data_falsification_audit|blockless_platform_vendor_pressure_audit|blockless_monetization_falsification_audit" docs/research/research-INDEX.md docs/research/blockless_diligence_pack.md

rg -n "first time|only one still empty|still empty|physical world has no agent|Nothing democratizes physical|Hardware App Store|App Store:|\$100M\+ ARR|50K active creators|Hardware sales|~70%|10x|no compile, no flash|bet wrong|US creator demand|commercial core|Not replicable|We win on the stack|30M Arduino IDE|60M Raspberry|50M students|US K-12 \+ post-secondary" docs/pitch/deck/deck_en.md

rg -n "first|only|empty|App Store|appstore|100M|50K|70%|10x|no compile|no flash|TAM|default|wins|beats|failed|hallucinat|20%|<1|Hardware Top-5|\$3|1,000\+|30\+ modules|complete stack|commercial core|US creator demand|default stack|prove physical|Proven" docs/pitch/deck/deck_en.md

python -m json.tool docs\research\blockless-benchmark\result.schema.json
python -m json.tool docs\research\blockless-benchmark\tasks.json
python -m json.tool docs\research\blockless-benchmark\recipe.schema.json

python docs\research\blockless-benchmark\validate_result.py benchmark_runs\YYYY-MM-DD-system-task-id\result.json
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\claim_gate_matrix.schema.json docs\research\blockless-benchmark\claim-gate-matrix.json
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\claim_scan_patterns.schema.json docs\research\blockless-benchmark\claim-scan-patterns.json
python docs\research\blockless-benchmark\scan_deck_claims.py docs\pitch\deck\deck_en.md --fail-on benchmark_gated
python docs\research\blockless-benchmark\scan_deck_claims.py docs\research\blockless-benchmark\examples\forbidden-claim-deck.example.md --expect-findings
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_signal.schema.json docs\research\blockless-benchmark\examples\no-commitment-market-signal.example.json
python docs\research\blockless-benchmark\validate_result.py --schema docs\research\blockless-benchmark\market_cohort.schema.json docs\research\blockless-benchmark\examples\insufficient-market-cohort.example.json

rg -n "Gate 5|vendor_docs_ai|vendor_tutorial_conversion|arduino_app_lab|espressif_vscode|platformio_project|vendor_tutorial|Vendor/platform systems" docs\research\blockless-benchmark docs\research\blockless_diligence_pack.md

rg -n "Gate 6|edge_impulse|sensecraft|blues_notehub|thingsboard|hologram|SenseCraft|Blues|ThingsBoard|Hologram|hardware vibe-coding|production IoT" docs\research\blockless-benchmark docs\research\blockless_competitor_exhaustion_map.md docs\research\blockless_source_ledger.md docs\research\blockless_diligence_pack.md
```

## Current Git / File State Notes

Expected relevant changes:

- Modified:
  - `docs/pitch/deck/deck_en.md`
  - `docs/research/research-INDEX.md`
- New/untracked Phase 3 research files under `docs/research/`, including the
  Blockless diligence docs and `docs/research/blockless-benchmark/`.
- Existing untracked research/support artifacts:
  - `Uber.pdf`
  - `uber_pages/`
  - `.claude/skills/security-review/`
  - `docs/新手测试指南.md`

Do not revert unrelated untracked files unless explicitly asked.

## Completion Status

The handoff is complete, but the research goal is not.

Completion still requires evidence that can withstand audit:

- same-task hands-on benchmarks;
- second-user recipe reruns;
- support-cost measurements;
- paid/repeat-use behavior;
- a bottom-up market model tied to measured cohorts.
