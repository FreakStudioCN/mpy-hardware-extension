# Running the real LLM loop

The panel now drives the real ReAct agent loop (LLM → tools → device) by default,
bundled from `src/` via esbuild. The deterministic template pipeline is opt-in only.

## What is real now

- **LLM generation** — `Generate` posts the conversation + canonical tools to
  `mpyhw-api` `/v1/llm/messages`, which proxies **DeepSeek**. The model chooses
  packages, builds the manifest, calls `generate_code`, audits, and drives the
  device loop. Code and manifest render live in the panel.
- **User-facing Activity** — the panel does not show raw tool names such as
  `generate_code`, `query_board_profile`, or `ask_user` by default. It renders
  product-level phases ("生成代码", "检查代码"), interactive questions, plan
  confirmations, code, serial output, and wiring. Raw tool calls and observations
  remain in session logs / developer trace for debugging.
- **Interactive questions** — `ask_user` pauses the loop, renders one question
  card in the WebView, and feeds the answer back into the agent. It must not also
  appear as a duplicate trace line.
- **Plan confirmation** — before paid codegen, the UI shows a user-facing hardware
  plan: target board, capabilities, selected driver packages, wiring, and rough
  credit estimate. It must not expose internal manifest fields like `logic` when
  those are not meaningful product choices.
- **Closed-loop plumbing** — `install → write → flash → read_serial → verify` runs
  through the real agent loop; serial markers (`MPYHW_READY`, `TEMP_C=…`) drive the
  `success` terminal. Verified end-to-end with fakes in
  `test/agent-backed-loop.test.ts`.

## Prerequisites to run it for real

1. **DeepSeek key** — `export DEEPSEEK_API_KEY=…` before starting the API
   (optional `MPYHW_LLM_MODEL`, defaults to `deepseek-v4-pro`). Without it the API
   returns `llm_upstream_not_configured` and the panel shows that error.
2. **Run the API** — from `mpyhw-api/`: `uvicorn app.main:app --port 8787`.
   If it is not on `http://127.0.0.1:8787`, set `MPYHW_API_BASE`.
3. **Open the panel** — VS Code command `MPY Hardware: Open Panel`, type the intent,
   press `Generate`.

### Loop modes (env)

- *(default)* real DeepSeek agent loop.
- `MPYHW_LOOP=template` — offline deterministic pipeline (no key, AHT20+LED only).
- `MPYHW_LLM_STUB=1` (API side) — connectivity smoke test only; the stub emits text,
  not tool calls, so it cannot drive the full loop.

## Current boundaries

1. **Hardware success still requires a real board and a compatible driver context.**
   The loop can generate files without a connected board, but install / flash /
   serial verification need the shim and a detected MicroPython device.
2. **Codegen is grounded, not hardcoded.** `generate_code` now uses a nested LLM
   call grounded on the board profile, manifest, loaded skills, and resolved
   driver contexts. If driver context is missing or weak, the agent should ask the
   user, load a skill, or mark the path experimental instead of inventing APIs.
3. **Logs are not the product UI.** Keep raw tool traffic, JSON arguments,
   observations, and terminal internals in recorder output / developer trace.
   The default Activity stream should stay readable for a hardware builder.
