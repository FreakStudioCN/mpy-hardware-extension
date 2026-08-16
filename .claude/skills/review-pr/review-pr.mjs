#!/usr/bin/env node
// review-pr.mjs — deterministic plumbing for the `review-pr` skill.
// Judgment (verify, reproduce, verdict) stays with the model; this only does the mechanical
// parts: enumerate open PRs, fetch+fingerprint them, run the baseline gate, and post/merge.
//
//   node review-pr.mjs list                       list open PRs (number, title, author, size)
//   node review-pr.mjs fetch [--all | N ...]      fetch pull/N/head->pr-N; print diffstat + rev + intent
//   node review-pr.mjs gate  <N>                  checkout pr-N, run `npm run baseline`; PASS/FAIL + fingerprint
//   node review-pr.mjs post  <N> --changes|--comment|--approve --body <file>   post a review
//   node review-pr.mjs merge <N> [--squash|--merge|--rebase] --yes             merge (REFUSES without --yes)
//
// The merge subcommand refuses without --yes so the skill's human gate is enforced mechanically.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "main";
const scriptDir = dirname(fileURLToPath(import.meta.url));

function git(args, opts = {}) {
  // stdio:"inherit" callers (checkout) get null back from execFileSync — guard before .trim().
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return out == null ? "" : out.trim();
}
function gh(args) {
  return execFileSync("gh", ["-R", REPO, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function die(msg) { console.error("error: " + msg); process.exit(1); }

// --- resolve repo root + GH slug from the script's own location ---
let ROOT, REPO;
try {
  ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: scriptDir, encoding: "utf8" }).trim();
} catch { die("not inside a git repo (run from the extension checkout)"); }
try {
  REPO = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch { die("`gh` not available or not authed. Run `gh auth status`."); }

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const optval = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const nums = () => rest.filter((a) => /^\d+$/.test(a));

function openPrNumbers() {
  return JSON.parse(gh(["pr", "list", "--state", "open", "--json", "number"])).map((p) => p.number);
}

function doList() {
  const prs = JSON.parse(gh(["pr", "list", "--state", "open", "--json",
    "number,title,author,additions,deletions,changedFiles,headRefName,reviewDecision"]));
  if (!prs.length) { console.log("no open PRs."); return; }
  for (const p of prs) {
    console.log(`#${p.number}  ${p.title}`);
    console.log(`      by ${p.author.login}  ·  +${p.additions}/-${p.deletions} in ${p.changedFiles} files` +
      `  ·  ${p.headRefName}${p.reviewDecision ? "  ·  " + p.reviewDecision : ""}`);
  }
  console.log(`\n${prs.length} open PR(s) on ${REPO}. Next: fetch, then Codex+independent review per SKILL.md.`);
}

function doFetch() {
  const list = flag("--all") || !nums().length ? openPrNumbers() : nums().map(Number);
  git(["fetch", "origin", BASE, ...list.map((n) => `pull/${n}/head:pr-${n}`)]);
  for (const n of list) {
    const rev = git(["rev-parse", `pr-${n}`]);
    const stat = git(["diff", "--stat", `${BASE}...pr-${n}`]);
    let intent = "";
    try { intent = gh(["pr", "view", String(n), "--json", "title,body", "-q", ".title"]); } catch {}
    console.log(`\n===== PR #${n}  (${intent})  [pr-${n} @ ${rev.slice(0, 12)}] =====`);
    console.log(stat);
  }
  console.log(`\nFingerprints recorded above — re-check them before trusting any red gate (parallel-session trap).`);
  console.log(`Now run Codex (codex:rescue) AND read the diff yourself; verify every blocker from source.`);
}

function doGate() {
  const n = Number(nums()[0]);
  if (!n) die("gate needs a PR number, e.g. `gate 32`");
  const extDir = join(ROOT, "mpy-hardware-extension");
  if (!existsSync(join(extDir, "package.json"))) die(`no package.json in ${extDir}`);
  const started = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  git(["checkout", `pr-${n}`], { stdio: "inherit" });
  const rev = git(["rev-parse", "HEAD"]);
  console.log(`\ngate: pr-${n} @ ${rev} — running \`npm run baseline\` (node ${process.version}) ...\n`);
  const r = spawnSync("npm run baseline", { cwd: extDir, shell: true, stdio: "inherit" });
  git(["checkout", started], { stdio: "inherit" }); // restore the tree we started on
  const ok = r.status === 0;
  console.log(`\ngate: pr-${n} @ ${rev.slice(0, 12)} → ${ok ? "PASS ✅ (merge is on the table)" : "FAIL ❌ (do NOT recommend merge)"}`);
  process.exit(ok ? 0 : 1);
}

function doPost() {
  const n = nums()[0];
  if (!n) die("post needs a PR number");
  const body = optval("--body");
  if (!body || !existsSync(body)) die("post needs --body <existing markdown file>");
  const event = flag("--changes") ? "--request-changes" : flag("--approve") ? "--approve" : "--comment";
  console.log(gh(["pr", "review", n, event, "--body-file", body]) || `posted ${event.replace("--", "")} on #${n}`);
  const dec = gh(["pr", "view", n, "--json", "reviewDecision", "-q", ".reviewDecision"]);
  console.log(`#${n} reviewDecision=${dec || "(none)"}`);
}

function doMerge() {
  const n = nums()[0];
  if (!n) die("merge needs a PR number");
  if (!flag("--yes")) die(`merge is human-gated. Re-run with --yes only after the human says "merge #${n}".`);
  const method = flag("--merge") ? "--merge" : flag("--rebase") ? "--rebase" : "--squash";
  gh(["pr", "merge", n, method]);
  const s = gh(["pr", "view", n, "--json", "state,mergedAt", "-q", '"state=\\(.state) mergedAt=\\(.mergedAt)"']);
  console.log(`#${n} ${s}`);
}

const HELP = `review-pr.mjs — plumbing for the review-pr skill (repo: ${REPO})

  list                        list open PRs
  fetch [--all | N ...]       fetch pull/N/head -> pr-N; print diffstat + fingerprint + intent
  gate  <N>                   checkout pr-N, run npm run baseline; PASS/FAIL (restores your branch)
  post  <N> --changes|--comment|--approve --body <file>
  merge <N> [--squash|--merge|--rebase] --yes    (REFUSES without --yes)

Judgment (verify, reproduce, verdict) is the model's job — see SKILL.md.`;

switch (cmd) {
  case "list": doList(); break;
  case "fetch": doFetch(); break;
  case "gate": doGate(); break;
  case "post": doPost(); break;
  case "merge": doMerge(); break;
  default: console.log(HELP);
}
