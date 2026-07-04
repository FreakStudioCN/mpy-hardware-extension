# Handoff 鈥?mpy-hardware-extension issue #3 (鐩墠BUG姹囨€? + live-test fixes

Date: 2026-06-26
Repo: `cursor_for_hardware` (git root, remote `FreakStudioCN/mpy-hardware-extension`). The
published extension lives in the `mpy-hardware-extension/` subdir; the backend in `mpyhw-api/`.

## Goal

Fix every problem in GitHub issue **#3 (鐩墠BUG姹囨€?** 鈥?the 7 items #1鈥?7 鈥?**plus** the 3
findings from the user's live cloud test (鈶?telemetry gap, 鈶?search-drivers stall, 鈶?approval-card race). Each fix: **one branch off `main` 鈫?TDD red-first 鈫?green 鈫?one PR 鈫?Codex review 鈫?squash-merge**. Do NOT fabricate data; surface failures loudly (user demands
fail-fast). The work was consolidated into **5 PRs**.

## Current Progress 鈥?4 of 5 PRs MERGED, PR5 open & ready

| PR | Issues | State | Commit on main |
|----|--------|-------|----------------|
| **#4** | 鈶?telemetry observability | 鉁?MERGED | (telemetry) |
| **#5** | 鈶?search-drivers stall | 鉁?MERGED | `730e72d` |
| **#8** | #1 + #5 + #4 | 鉁?MERGED | `715350d` |
| **#9** | #3 preferences/context | 鉁?MERGED | `d1c514c` |
| **#10** | #6 device fs bridge | 馃煛 OPEN, ready to merge | branch `fix/device-fs-bridge` |

### What each merged PR did
- **PR #4 (鈶?:** the cloud DB was blind to protocol builds (only `session_started/intent_submitted/session_finished`). Root cause: `telemetry.ts mapSessionEvent` only knew the OLD agent-backed-loop vocabulary. Now it maps `phase_start/phase_complete/status_update/approval_requested/components_proposed`; `session-controller` **records** `status_update`+`phase_start` (were postMessage-only); backend `analytics.py ALLOWED_EVENT_TYPES` allows them (ingest-only, not in `_update_session`).
- **PR #5 (鈶?:** `protocol-loop.ts:102` instantly stalled on a single tool-less (prose) turn 鈫?UI froze on "姝ｅ湪鎼滅储椹卞姩" 鈫?mapped to `awaiting_user`. Now it re-prompts the model up to `MAX_TOOLLESS_TURNS` (3) before stalling, and emits a `phase_stalled` event (recorded + telemetry + allowlist) so a genuine stall is visible.
- **PR #8 (#1/#5/#4):** #1 `serve.py` resolves a **plugin-qualified** script name (`upy-deploy-plugin/list_serial_ports.py`) to disambiguate duplicate basenames; the ambiguous error now LISTS candidates, forwarded through `protocol-build`/`protocol-loop` to the model. #5 removed the dead `createAgentBackedLoop` import from `panel.ts` (**Codex caught that `codegen.ts` is NOT an orphan 鈥?`pipeline.ts` imports it; do NOT delete it**) + arch-guard test + clarifying header comments. #4 WONTFIX comment in `prepare-vsce.mjs`.
- **PR #9 (#3):** the protocol request now carries a `context` block (`pre_selected_board` from boardId + `preferences{mode,locale,existing_hardware}`); server `_context_injection` surfaces it from the analyze phase. Hardened after Codex: context is **sanitized & framed as untrusted** (board-id charset-validated, free-text newline-flattened+capped, "never instructions"); `locale` wired end-to-end (panel `vscode.env.language` 鈫?controller 鈫?loop); preferences **cleared on a fresh session** (board change / reset).

### PR #5 (#10) 鈥?#6 device fs bridge 鈥?OPEN, ALL fixes committed, NOT yet merged
`protocol-build.device()` returned `device_action_unsupported` for `ls/rm/mkdir/cp_from`.
Now wired across 3 layers, 5 Codex rounds folded in (branch `fix/device-fs-bridge`, HEAD `a506f79`):
- `serve.py`: `device.fs_remove` / `device.fs_mkdir` (idempotent on EEXIST) / `device.copy_from` over `mpremote fs`; `_list_files` drops the `ls :` header + accepts an optional dir; `_fs_copy_from` creates local parent dirs.
- `device-shim.ts`: `listDir(dir?)` / `removePath` / `makeDir` / `copyFromDevice` (throw on non-ok).
- `protocol-build.ts device()`: routes `ls/rm/mkdir/cp_from` using the **protocol `src`/`dst`** fields (per `contracts/protocol_messages.json`); `containLocalPath` contains cp_from's local dst to the project root (path-traversal guard).
- Tests: `test_serve.py` (fs dispatch, mkdir-idempotent, ls-header, copy_from parent-dirs) + `device-shim.test.ts` (4 fs methods) + `protocol-build.test.ts` (`containLocalPath` containment). Suite green (**400**), typecheck clean, serve tests pass.

## What Worked

- **TDD red-first, every change.** Verify locally: `cd mpy-hardware-extension && node --no-warnings --experimental-strip-types --test test/*.test.ts` and `node scripts/typecheck.mjs`; serve: `cd python/shim && python test_serve.py`. Backend pytest is unreliable locally 鈥?verify the logic **DB-free** with a direct `python -c` and rely on **CI** for the full backend suite.
- **Per-PR Codex review** via `node <codex-companion.mjs> review --wait --base main --scope branch` then `result --json` 鈫?read `(job).summary` (stdout is noisy exploration; the verdict is in the summary). It caught a real issue on most PRs (codegen.ts-not-orphan, unforwarded candidates, prompt-injection, stale prefs, wrong payload fields, ls-header, cp_from containment, parent dirs).
- **Cloud-DB diagnosis**: the new **`/diagnose-cloud-session`** skill (`cursor_for_hardware/.claude/skills/`) + `PROD_DATABASE_URL` in `mpyhw-api/.env` (read-only). Semantics: `terminal=awaiting_user` 鈮?a protocol **stall**, NOT a real user-wait.
- Branch per fix, `gh pr create`, `gh pr merge <n> --squash --delete-branch`, then `git checkout main && git pull`.

## What Didn't Work / Gotchas

- Codex **`task`** (rescue) hung twice early (frozen `updatedAt`, killed via `taskkill /PID` from **PowerShell** 鈥?Git Bash mangles `/PID`). `review --wait` is reliable.
- `test_serve.py` has a custom `if __name__=="__main__"` runner collecting `test_*` from `globals()` 鈥?**tests appended AFTER that block never run.** Put new tests BEFORE it.
- Codex iterated **5 rounds on `cp_from`** (a minor action) 鈥?watch for diminishing returns on non-critical paths.
- `.env` holds the prod DB URL 鈥?it's gitignored; never commit/echo it.

## Next Steps

1. **Finish PR #5 (#10):** final Codex review of `a506f79`, confirm `gh pr checks 10` green, then `gh pr merge 10 --squash --delete-branch` + sync main. (User stopped right before this; the branch is complete and green.)
2. **#7 鈥?device UI entry points** (NOT started): `package.json` contributes only `mpyhw.openPanel`. Add a device-unittest runner, an independent REPL monitor, and a read-device-log button (commands + webview handlers). **Requires a running Extension Dev Host + real device to verify the UI/behavior** ("see it before concluding") 鈥?not fully unit-testable. Use the `dev-up` / `cloud-test` skills.
3. **#2 鈥?full board index** (NOT done, by design): server `mpyhw-api/content/boards` has only 3 boards (+7 in the `upy-analyze-plugin` skill), far from micropython.org/download's ~150. **Decided: full index, but do NOT auto-fabricate** 鈥?per the user's preference, board data is Codex-audited curated data. Plan: (a) a board-schema validator + coverage/drift test (infra, TDD-able); (b) a Codex-audited curation pass over the official roster. Per-board `pin_capabilities` need datasheets; don't invent them. Server schema: `board_id/display_name/manufacturer/pin_capabilities/pin_recommendations/forbidden_pins/available_modules/voltage_notes`.
4. **鈶?鈥?approval-card race** (DEFERRED, needs repro): "淇敼鍣ㄤ欢娓呭崟" sometimes gray-screens or skips to the next step. A webview鈫攃ontroller race; the controller side (`session-controller.ts confirmApproval/resolvePrompt`) looks correct, so it's likely a webview render exception (`addApprovalPrompt` in `src/webview/index.html`) or a modify-action/protocol mismatch. **Can't TDD without live repro.** Now that PR #4's observability is merged, the next user cloud-test records `approval_requested`/phase events to the DB 鈥?pull them with `/diagnose-cloud-session`, plus the local `<workspace>/.mpyhw/sessions/<trace>/session.jsonl` and the Dev Host webview devtools.

## Key references

- Memory: `[[blockless-cloud-session-diagnosis]]`, `[[user-demands-fail-fast-no-fallback]]`, `[[user-prefers-codex-review-gates]]`, `[[blockless-no-worktrees]]`.
- Codex companion: `C:/Users/Haipeng Wu/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs`.
- Verify a stalled/failed session live: `cd mpyhw-api && python ../.claude/skills/diagnose-cloud-session/db_query.py .env PROD_DATABASE_URL`.

