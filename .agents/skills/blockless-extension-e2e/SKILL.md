---
name: blockless-extension-e2e
description: >-
  Run and debug the Blockless VS Code extension release gate: CI-equivalent API and extension tests, V0 protocol smoke, live DeepSeek full-stack e2e, VSIX packaging, local reinstall, direct push-to-main verification, and GitHub Actions follow-up. Use when working in cursor_for_hardware/mpy-hardware-extension, when CI is failing, when the user asks to run e2e, push main, reinstall the plugin, or verify the extension against docs without editing extension docs.
---

# Blockless Extension E2E

## Rules

- Work from the real git repo root, not the parent folder: `cursor_for_hardware`.
- Do not edit `docs/` or `mpy-hardware-extension/docs/`. Check `git diff --name-only -- docs mpy-hardware-extension/docs` before staging.
- Do not stage unrelated untracked files. Stage only the files intentionally changed for the fix.
- For this project, live e2e is intentionally real: send the e2e prompt/context to DeepSeek unless the user explicitly says not to. Treat it as billable and external.
- Prefer a dedicated e2e API port, default `8791`, instead of the normal `8787` daemon. The daemon can exit or be stale during a long e2e.
- On Windows, avoid `npm run e2e:v0 -- "<Chinese prompt>"`; `cmd`/npm can mangle Unicode argv. Run `node.exe --no-warnings --experimental-strip-types src/cli/e2e-protocol-v0.ts "<prompt>"` directly and read logs as UTF-8.

## Quick Runner

Use the bundled script for repeatable execution:

```powershell
# CI-equivalent checks, package included
powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\blockless-extension-e2e\scripts\run-blockless-extension-e2e.ps1 -Mode ci

# Live full-stack e2e through DeepSeek
powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\blockless-extension-e2e\scripts\run-blockless-extension-e2e.ps1 -Mode e2e

# Package and reinstall current VSIX into VS Code
powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\blockless-extension-e2e\scripts\run-blockless-extension-e2e.ps1 -Mode reinstall
```

Use `-Mode all` when the user asks for the whole gate.

## CI Gate

Run these before committing or pushing:

1. Recreate isolated database `mpyhw_test` in Docker container `mpyhw-pg`.
2. API job environment: set only `DATABASE_URL=postgresql://postgres:mpyhw@127.0.0.1:55432/mpyhw_test`; remove dev overrides like `MPYHW_DAILY_GRANT`, `DEEPSEEK_API_KEY`, and `MPYHW_LLM_MODEL`.
3. Run `python -m pytest` in `mpyhw-api`.
4. Run `npm run build` in `mpy-hardware-extension`.
5. Recreate `mpyhw_test` again, then run `npm test` with `MPYHW_REQUIRE_CONTRACT_TESTS=1`.
6. Run `npm run test:v0` with `MPYHW_REQUIRE_CONTRACT_TESTS=1`.
7. Run `npm run typecheck`.
8. Run `python -m pytest` in `mpy-hardware-extension/python/shim`.
9. Run `npm run package`.

If API pytest fails only when `.env` was loaded, compare with CI environment before changing code. The dev `.env` may contain `MPYHW_DAILY_GRANT=1000000` or real DeepSeek settings that alter test behavior.

## Live V0 E2E

Use a logged child process so timeout never hides progress:

1. Start a dedicated API on `127.0.0.1:<port>` with env loaded from `mpyhw-api/.env`.
2. Probe `/v1/health` and require `{"status":"ok","mode":"live","llm_configured":true}`.
3. Mint `MPYHW_DEV_JWT` from `app.auth.mint_session`.
4. Set `MPYHW_API_BASE=http://127.0.0.1:<port>`.
5. Start `node.exe --no-warnings --experimental-strip-types src/cli/e2e-protocol-v0.ts "<prompt>"`.
6. Write stdout/stderr to `mpy-hardware-extension/tmp/e2e-v0-live-<port>.*.log`.
7. Poll process status and log tail until exit.
8. Pass condition is `E2E-V0-FULLSTACK: PASS`, with generated `firmware/main.py` and at least one real git commit in the temp project.

If e2e returns `REVIEW`, classify the cause before fixing:

- `awaiting_user` in `analyze`: model asked prose or the prompt/argv was mangled. Re-run direct `node.exe`, not `npm.cmd`.
- `ECONNREFUSED`: API process died or wrong port. Use a dedicated port and inspect API stderr.
- Protocol payload warning followed by recovery: observe, do not patch unless it terminates the run.
- Repeated same phase failure: inspect phase notes and docs/source-of-truth, but do not edit extension docs.

## Commit, Push, Reinstall

Before commit:

```powershell
git diff --name-only -- docs mpy-hardware-extension/docs
git diff --check
git status --short
```

Stage explicit files only. After push to `main`, monitor GitHub Actions with `gh run list --branch main --limit 1` and `gh run watch <run-id> --exit-status` when feasible.

For local reinstall, package first, then:

```powershell
code --install-extension mpy-hardware-extension\build\mpy-hardware-extension.vsix --force
```

Tell the user VS Code may need `Developer: Reload Window` or a full restart to load the installed VSIX.
