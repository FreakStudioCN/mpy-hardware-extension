# Running the real LLM loop

The panel now drives the real ReAct agent loop (LLM → tools → device) by default,
bundled from `src/` via esbuild. The deterministic template pipeline is opt-in only.

## What is real now

- **LLM generation** — `Generate` posts the conversation + canonical tools to
  `mpyhw-api` `/v1/llm/messages`, which proxies **DeepSeek**. The model chooses
  packages, builds the manifest, calls `generate_code`, audits, and drives the
  device loop. Code and manifest render live in the panel.
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

## Remaining gaps before a board lights up

These are the honest TODOs that this change did **not** close:

1. **No device wiring yet.** With no `shim` connected, device tools return
   `device_unavailable` — generation is real, but the loop cannot reach `success`
   without a board. Plugging one in needs:
   - a stdio JSON-RPC server loop in `python/shim/serve.py` (the `Shim` class exists,
     but there is no `__main__` that reads requests the way `shim-process.ts` expects), and
   - `createPanel` to spawn it and pass the `shim` into `createLoop`.
2. **Codegen only handles AHT20 + LED.** `generate_code` → `generateMainPy` returns
   `not_generatable` for any other sensor/constructor ([codegen.ts](../src/core/codegen.ts)).
   The agent runs for any intent but can only *finish* on that one scenario until
   codegen generalizes.
3. **`ask_user` is not interactive.** It surfaces the question as a trace and returns
   `null`; the agent proceeds with defaults. A webview round-trip is still needed.
