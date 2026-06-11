# Blockless Deck v12 Slide Audit

Date: 2026-06-11

Deck audited: `docs/pitch/deck/deck_en.md` v12.

Purpose: apply the competitor, data, logic, UberCab, and vibe-coding research
to the current deck. This is not a rewrite. It is a claim safety audit.

## Overall Verdict

The deck has the right compression style, but the current narrative is too
aggressive for the evidence.

The biggest issue is not wording. It is that several slides still rely on
claims the research has already downgraded:

- hardware is empty;
- the physical world has no agent;
- Schematik tried and failed;
- C/Arduino is structurally dead;
- MicroPython is categorically better;
- hardware appstore behavior is already proven;
- vibe-coding market behavior transfers to hardware;
- $100M+ ARR can be shown before repeat-use/payment evidence.

The safer deck should lead with:

> AI can write code. Hardware needs verified recipes.

And the first wedge should be:

> controlled ESP32 module matrix -> real run -> verified recipe -> rerun/fork.

## Slide-by-Slide Audit

| Slide | Current claim pattern | Risk level | Why it breaks | Safer direction |
|---|---|---:|---|---|
| 1. Cover | "Software's Lovable moment was 2025. Hardware's is now." / "AI-native hardware creation platform" | Medium | Vibe-coding analogy is useful but not proof. "Hardware's is now" implies market timing is already validated. | "AI can write code. Hardware needs verified recipes." Show prompt -> real device -> recipe. |
| 2. Thesis | "The physical world has no agent" / "Hardware still empty" | High | PleaseDontCode, Schematik, Cirkit, Wokwi, ESPHome, Aily/Blockly-like tools, academic systems all attack parts of this. | "No dominant workflow has made real hardware builds reproducible from intent to rerun." |
| 3. Problem | "Hardware is last creative domain still gatekept" / "Nothing democratizes physical things yet" | High | MakeCode, Tinkercad, Visuino, Mind+, Mixly, Arduino Project Hub, Adafruit Learn, Seeed Wiki, Hackster already democratize pieces. | "Tools help people learn and start; real-device build/run/repair/reuse remains fragmented." |
| 4. Why AI Hardware Is Failing | "Someone tried Cursor for hardware. It didn't work." / founder demo failure / 20% package claim | High | Overclaims from press/blog/general package-hallucination evidence. Risks sounding defamatory or brittle. | "Early Cursor-for-hardware attempts validate the category and expose stack-level risks." |
| 5. Why Now | "Hardware is the only one still empty" / "10x Python" / "First time possible" / "They bet wrong" | High | Too absolute. Vibe coding does not prove hardware demand; Python/C evidence may not apply to embedded tasks; competitors exist. | "AI agents are mature enough to try the physical loop; our narrow MicroPython workflow is now practical." |
| 6. What We Built | "Hardware App Store" / active modules as universal substrate | High | Appstore behavior not proven; Lego analogy hides electronics compatibility/support cost. | "Verified recipe registry first: board + module + wiring + code + logs + repair hints." |
| 7. Demo | "Speak. Snap. Run." / full-flow video TBD | Medium/High | Demo claim is strong but video is TBD; current image is sample module, not full workflow proof. | Show an actual run artifact or label as roadmap/prototype. Add logs/recipe output, not just module GIF. |
| 8. Product | "Hardware is commercial core" / App Store fork one tap / broad target users | High | Hardware revenue share and appstore/fork behavior are unproven; target users span too many wedges. | Pick one wedge: maker prototyping. Appstore -> verified recipe registry. Business model -> hypotheses. |
| 9. Why This Wins | "Same category. We win on the stack." / Schematik vs us table | High | Benchmarks missing; C/Arduino can be automated; PleaseDontCode is closer than Schematik on full loop; "no compile/no flash" is not fully true. | Compare against categories, not one rival. Use benchmark gates before "wins." |
| 10. Market | Kickstarter comps, $100M+ ARR, 50K active creators | High | Kickstarter hardware comps do not prove repeat workflow, ARR, or software subscription behavior. | Use bottom-up wedge model with explicit assumptions: users, kit attach, workspace conversion, support cost. |
| 11. Business Model | "Cursor for hardware" / 70% hardware sales / moat = three-layer coupling | High | Revenue mix untested; "Cursor for hardware" occupied and misleading; coupling is not moat unless verified run data compounds. | Present business model hypotheses and first paid behavior to test. Moat = hardware execution context graph if it improves success. |
| 12. Team | CTO/uPyPI, patents, hardware services, views | Medium | Team slide is mostly factual if all numbers are source-backed. But final line repeats "last domain still locked." | Keep factual bios. Replace sweeping line with "We know the package and hardware-service pain firsthand." |
| 13. GTM/Roadmap | Kickstarter top-5 target, 1,000 orders, 30 modules, curricula default | High | Roadmap assumes channel success and education adoption before wedge proof. 30 modules may raise support/matrix risk. | Roadmap should be milestone-gated: benchmark pass -> 20 recipes -> beta kits -> rerun rate -> channel tests. |
| 14. Closing | "Every smart device may one day be spoken into existence" / complete stack | Medium | Good vision, but too broad if preceding proof is narrow. | Keep as vision after narrow proof, or close with "Say one sentence. Get a real device running. Publish the recipe." |

## Claims To Remove Before Next Rewrite

- "The physical world has no agent."
- "Hardware is still empty."
- "Nothing democratizes physical things yet."
- "Someone already tried Cursor for hardware. It didn't work."
- "Even the founder can't run it."
- "Hardware is the only one still empty."
- "LLMs write Python 10x more accurately than C" unless source scope is
  precisely tied to Blockless tasks.
- "First time possible."
- "Not replicable 1:1."
- "Hardware App Store" as a current product claim.
- "No compile, no flash."
- "Same category. We win on the stack."
- "$100M+ ARR" before bottom-up assumptions and behavior evidence.
- "Hardware sales ~70%" before attach-rate tests.
- "Default stack in US K-12 and university STEM curricula."

## Claims That Can Survive Now

These are defensible with current research:

- Hardware creation is fragmented across datasheets, pins, drivers, packages,
  flashing, logs, and tutorials.
- AI code generation alone is insufficient for real hardware.
- The strongest Blockless thesis is a verified recipe workflow.
- The v1 matrix should be narrow by design.
- MicroPython is a plausible v1 wedge for fast sensor/actuator iteration, not a
  universal embedded replacement.
- The appstore should start as a verified recipe registry.
- The moat is possible only if the hardware execution context graph improves
  future success rates.

## Suggested Slide Spine For v13

This is the current safest sequence:

1. **Cover:** AI can write code. Hardware needs verified recipes.
2. **Old workflow:** hardware builds fail between tutorial and real device.
3. **Why old tools fail:** code assistants cannot see board/module/pin/package/log context.
4. **What exists:** tutorials, simulation, PlatformIO/ESPHome, PleaseDontCode solve pieces.
5. **Blockless concept:** sentence -> selected hardware context -> real run -> verified recipe.
6. **Recipe object:** board, module, wiring, code, package versions, logs, repair hints.
7. **Demo:** one task running on real ESP32 hardware with serial/run log and recipe output.
8. **V1 wedge:** ESP32-S3/C3 plus 8-12 modules, 20-30 verified recipes.
9. **Why now:** AI agents + cheap modules + MicroPython package layer make this narrow loop practical.
10. **Competitive boundary:** not first AI hardware, but verified recipe/reproducibility focus.
11. **Market wedge:** maker prototyping first; education/IoT/marketplace later.
12. **Business model hypotheses:** kit, workspace, recipe/package, vendor/education support.
13. **Milestone roadmap:** benchmark -> beta -> reruns -> paid behavior -> channel expansion.
14. **Progress:** real runs, supported matrix, recipes, testers, benchmark results.

## Proof Gates By Slide

| Slide type | Minimum evidence before strong claim |
|---|---|
| Demo | Video or logs of real hardware completing benchmark task |
| Differentiation | Same-task benchmark vs PleaseDontCode and AI+PlatformIO |
| Appstore/registry | At least one second-user rerun; ideally 20 recipes and rerun/fork metrics |
| Market | Cohort repeat-project data and first paid behavior |
| Hardware revenue | Kit attach rate and gross margin data |
| Moat | Evidence that prior runs reduce future failure rates |
| Education | Classroom completion and teacher intervention test |
| IoT app/control | Baseline vs Arduino Cloud/Blynk/ESPHome/Particle |

## Tough Questions For Each Risky Slide

### Slide 2/3

If an investor names PleaseDontCode, Cirkit, Wokwi, MakeCode, or ESPHome, what
is the non-semantic reason Blockless still matters?

Good answer:

> Those tools solve pieces. Blockless focuses on verified, rerunnable recipes
> backed by real run logs and compatibility metadata.

Bad answer:

> They are not real competitors.

### Slide 4/9

Why is Schematik the right foil when PleaseDontCode appears closer to the full
intent/wiring/code/flash/log/project loop?

Good answer:

> Schematik is a narrative foil; PleaseDontCode is the real workflow benchmark.

Bad answer:

> Schematik failed, so we win.

### Slide 5

What exactly became possible now that was impossible 24 months ago?

Good answer:

> Not all hardware. A narrow loop: LLM intent parsing + curated MicroPython
> packages + ESP32 modules + fast run/log/repair + recipe registry.

Bad answer:

> Hardware can finally host an agent.

### Slide 6/8/11

Why should anyone believe appstore or hardware revenue before rerun and attach
behavior?

Good answer:

> We do not claim marketplace yet. We first test verified recipe reruns and kit
> attach.

Bad answer:

> Appstores always work.

### Slide 10/13

Why do Kickstarter hardware comps imply a recurring workflow business?

Good answer:

> They do not. They only suggest a launch channel; repeat use and ARR require
> separate cohort evidence.

Bad answer:

> Kickstarter proves demand.

## Current Deck Decision

Do not rewrite v12 by polishing wording only. The story architecture should
change:

- from "hardware is empty" to "hardware workflow remains fragmented";
- from "we beat Schematik" to "we must beat PleaseDontCode and AI+PlatformIO on
  the same tasks";
- from "Hardware App Store" to "verified recipe registry";
- from "US creator TAM" to "maker prototyping wedge with measured repeat use";
- from "stack win" to "recipe/reproducibility proof."

Until benchmark data exists, v13 should be a narrower seed narrative, not a
category-dominance narrative.

## Current Patch Note

2026-06-11 follow-up edit to `docs/pitch/deck/deck_en.md` addressed the highest
risk active-deck contradictions from this audit:

- Slide 1 no longer says hardware's Lovable moment is now.
- Slide 2/3 already use verified-creation-loop and fragmentation framing.
- Slide 4 no longer says Schematik tried and failed. It now names
  PleaseDontCode, Embedr, Cirkit, and Schematik as category pressure and asks
  whether any workflow proves generation, execution, and second-user rerun.
- Slide 5 no longer claims the opportunity started in the US or depends on
  Schematik betting wrong.
- Slide 6/8 no longer use hardware-appstore or hard BOM/retail claims.
- Slide 9 no longer says "Why This Wins" or uses a Schematik-only comparison.
  It now treats direct substitutes as benchmark baselines and makes victory
  benchmark-gated.
- Slide 13 now frames Kickstarter as a useful launch channel, not
  recurring-demand proof.

2026-06-11 second follow-up edit tightened remaining active-deck leakage:

- Slide 2 now says hardware lacks a dominant verified loop, not that verified
  hardware creation is absent.
- Slide 5/12 changed the CTO claim from "MicroPython's only package manager" to
  "uPyPI, a MicroPython package manager" until source strength is rechecked.
- Slide 6 changed the Lego analogy from evidence to aspiration.
- Slide 7 now labels the flow as a demo target and requires behavior, logs, and
  recipe capture after benchmark run.
- Slide 8 narrows the initial user test to ESP32 makers and module vendors;
  education remains a later gate.
- Slide 10 changed physical-computing comparables from proof to activity
  indicators.
- Slide 13 removed Kickstarter top-5, $3-7M, 1,000-order, and 30-module targets
  from the active roadmap and made launch/channel expansion metric-gated.
- Slide 14 changed "complete stack" to "verified recipe workflow."
- `deck_cn.md`, `deck_cn.html`, and `SPEC.md` were not rewritten; they were
  explicitly deprecated/quarantined because they still contain pre-diligence
  claims and encoding damage. Rewrite from the active EN deck before use.

Remaining proof gaps are unchanged: same-task benchmarks, second-user reruns,
support-cost measurement, and paid/repeat behavior still decide whether the
stronger story is earned.
