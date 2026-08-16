---
name: review-pr
description: Use when reviewing the open pull requests in this repo (mpy-hardware-extension / blockless extension) — "review the PRs", "review PRs with codex", triaging open PRs, gating PRs before merge, or deciding which to merge vs send back. Applies whenever a PR verdict will drive a merge or a request-changes.
---

# Review PR

Review the repo's open PRs and produce a per-PR verdict with a **rerunnable reproduction** attached
to each blocker. Codex (if used) is a first pass, not the verdict. **Merge is human-gated and gated
on a green baseline** — those two are the guarantees this skill exists to enforce; the review reasoning
itself is largely your default, so keep it tight.

Run the mechanical steps with `node .claude/skills/review-pr/review-pr.mjs --help`.

## Pipeline

```
0  scan & fetch    all open PRs (default) or a given #list → fetch + fingerprint + read intent
1  diff map        enumerate changed hunks → lenses (correctness · security · concurrency · tests)
2  dual review     optional Codex first pass  ⟂  your own read of the source → candidate findings
3  verify+repro     each blocker: reproduce (Tier A) or trace-with-reason (Tier B); sibling sweep
4  verdict          per PR, blockers first, each with its evidence tier
5  act              blockers → auto-post request-changes;  clean+green → recommend, WAIT for human
```

## Output contract (the verdict)

```
PR #<n> — <title>
Blocking (most severe first):
  - <one line>  [Tier A|B]  file:line — <inputs → wrong result>;  repro: <command>
Non-blocking (optional): …
Test coverage: <do the tests exercise the claims, or assert-nothing?>
Verdict: merge-ready | merge-after-fixes | needs-work
```

- **Tier A** = a saved, runnable repro that demonstrates the bug — mandatory whenever the logic is
  pure/headless (encoding, parsing, path, queue). Write it to the scratchpad; keep the command.
- **Tier B** = full input→sink trace **+ an explicit reason Tier A can't run** (needs hardware / CI /
  prod). Weaker than either → `unverified`, does not block.
- If you run Codex, surface where you **agree/differ** — don't relay it verbatim.

## Mechanical non-negotiables (the helper enforces these)

- **Gate before recommending merge:** `review-pr.mjs gate <N>` runs `cd mpy-hardware-extension &&
  npm run baseline` (node ≥ 22.6) and reports PASS/FAIL. Green is required — but **green ≠ mergeable**,
  so still review (a passing PR can carry blockers its tests don't cover).
- **Merge is human-gated:** `review-pr.mjs merge` refuses without `--yes`. Recommend merge and wait
  for the human's explicit "merge #N"; never merge autonomously. Send-backs (`post --changes`) are
  auto (reversible).
- **Fingerprint before trusting a red gate:** the helper prints `git rev-parse pr-N`; a parallel
  session can swap the tree and turn a green PR red.
- **Cite file:line on the PR branch** + a concrete failure scenario. No file:line, no finding.

## Two scans

- **Sibling sweep:** once a pattern is confirmed, grep the module for other instances of it.
- **Completeness:** every changed hunk gets a lens; for each behavior the PR *claims*, find the test
  that exercises it (mutation mindset) — flag assert-nothing tests.

## Helper

`node .claude/skills/review-pr/review-pr.mjs <list|fetch|gate|post|merge>` — read-only scan
(list/fetch/gate) + guarded actions (post; merge refuses without `--yes`). Repo:
`FreakStudioCN/mpy-hardware-extension`, `gh` must have write access.
