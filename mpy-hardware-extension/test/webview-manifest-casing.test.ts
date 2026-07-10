import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the case-only manifest/index divergence that broke PR #27:
// `manifest.json` referenced `shared.js` while git tracked `Shared.js`. On a
// case-insensitive macOS filesystem readFileSync("shared.js") happily opened the
// `Shared.js` blob, so every local check (readdir, jsdom assembly, the whole suite)
// passed — but a case-sensitive Linux CI checkout writes the file as `Shared.js`,
// readWebviewHtml() can't resolve `shared.js`, and all 16 webview-assembly tests fail
// with the generic webview_html_not_found.
//
// A working-tree check (fs.existsSync / readdir) cannot catch this on a Mac: the disk
// name is whatever the last write used, not what CI will check out. The authoritative
// source for "what CI sees" is the git index, so this asserts every manifest entry is
// tracked with EXACT case. That fails on the developer's Mac before the push.

const compDir = new URL("../src/webview/components/", import.meta.url);
const compDirPath = fileURLToPath(compDir);
const manifest: string[] = JSON.parse(readFileSync(new URL("manifest.json", compDir), "utf-8"));

// Exact-case names as git will materialize them on checkout (index truth, FS-agnostic).
// Falls back to the working tree only when git is unavailable (e.g. an exported tarball).
function trackedNames(): { names: Set<string>; source: "git-index" | "worktree" } {
  try {
    const out = execFileSync("git", ["-C", compDirPath, "ls-files"], { encoding: "utf8" });
    const names = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (names.length > 0) return { names: new Set(names), source: "git-index" };
  } catch {
    // not a git repo / git missing — fall through to the working tree
  }
  return { names: new Set(readdirSync(compDirPath)), source: "worktree" };
}

test("every manifest.json entry resolves to a tracked file with exact case", () => {
  const { names, source } = trackedNames();
  assert.ok(manifest.length > 0, "manifest.json is empty");
  for (const entry of manifest) {
    assert.ok(
      names.has(entry),
      `manifest entry "${entry}" is not present with exact case in the ${source}. ` +
        `Case-only mismatches pass on a case-insensitive Mac but break case-sensitive CI ` +
        `(webview_html_not_found). Tracked: ${[...names].sort().join(", ")}`,
    );
  }
});

test("manifest.json itself is tracked (so CI actually gets the load order)", () => {
  const { names, source } = trackedNames();
  assert.ok(names.has("manifest.json"), `manifest.json missing from the ${source}`);
});
