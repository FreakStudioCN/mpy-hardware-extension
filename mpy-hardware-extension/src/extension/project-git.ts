// Git helpers for Save Version (#95 §B). execFile-based, mirroring panel.ts's existing
// ensureProjectGitRepo pattern (execFileAsync + { windowsHide: true }): NO new dependency
// (no simple-git), NO vscode.git API (it would add an activation dependency on the built-in
// git extension for zero gain, and walks UP to a parent repo — the exact bug existsSync
// guards against).
//
// Save Version is DETECT-ONLY: isGitRepo checks for a literal .git under the project folder
// (never rev-parse --is-inside-work-tree, which climbs to a parent repo). We never git-init
// here — §3.6.3 forbids forcing Git initialization; a missing repo routes to the snapshot path.
//
// Errors are surfaced, never swallowed (a user-initiated save must not silently drop a
// failure the way the fire-and-forget ensureProjectGitRepo catch does): a missing git binary
// throws a typed git_unavailable; a nonzero git exit rejects with stderr verbatim.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Bound every git call so a hung git can't wedge the save (matches DIAGNOSTICS_EXEC_TIMEOUT
// scale in panel.ts, but generous — a commit stages files).
const GIT_TIMEOUT_MS = 15_000;

// Thrown when the git binary is not on PATH (ENOENT on spawn). The caller maps this to the
// git_unavailable taxonomy code and routes to the snapshot path.
export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

// Detect-only repo check: a literal .git directory under THIS project folder (§B). Never a
// rev-parse walk — that would find a parent repo and Save Version would commit into the
// user's own workspace repo.
export function isGitRepo(projectFolder: string): boolean {
  return existsSync(join(projectFolder, ".git"));
}

// Run a git subcommand in projectFolder. ENOENT on the binary => GitUnavailableError;
// any nonzero exit rejects with stderr verbatim (never swallowed).
async function git(projectFolder: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    // LC_ALL=C so git's human-readable output is stable English regardless of the machine's
    // locale. The caller classifies outcomes by matching that output ("nothing to commit"), and
    // git is gettext-localized (e.g. zh_CN "无文件要提交") — on a non-English machine, which is
    // this product's primary audience, an un-forced locale silently breaks the taxonomy.
    // core.quotepath=false so a non-ASCII (e.g. CJK — the primary audience) filename in `status`
    // output is raw UTF-8, not octal escapes ("\346\270\251"). The Save Version panel shows these
    // paths verbatim.
    return await execFileAsync("git", ["-C", projectFolder, "-c", "core.quotepath=false", ...args], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      // GIT_CEILING_DIRECTORIES pins the repo search to projectFolder: git stops its upward walk
      // at the parent, so if .git vanishes mid-sequence (between isGitRepo and a later add/commit)
      // git resolves to "not a repository" instead of climbing to the user's OWN workspace repo
      // and committing there — the exact escape the detect-only design exists to prevent.
      env: { ...process.env, LC_ALL: "C", GIT_CEILING_DIRECTORIES: dirname(projectFolder) },
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new GitUnavailableError("git is not installed or not on PATH");
    }
    // execFileAsync rejection carries both streams; surface them verbatim for the auditable
    // error. git writes "nothing to commit, working tree clean" to STDOUT (not stderr), so
    // stdout must be included or the caller can't tell nothing-to-commit from a real failure.
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const wrapped: any = new Error(stderr || stdout || error?.message || "git command failed");
    // Preserve git's numeric exit code so a caller can tell an EXPECTED nonzero (e.g. `diff
    // --cached --quiet` exit 1 = "staged changes exist") from a real failure (exit >=2, or a
    // timeout kill where code is null). Without this the taxonomy misreads every failure as "1".
    wrapped.exitCode = typeof error?.code === "number" ? error.code : null;
    throw wrapped;
  }
}

// `git status --porcelain` lines (trimmed of the trailing newline, empty array when clean).
// Each line is "XY path" — the caller renders these as the changed/untracked file summary.
export async function gitStatusPorcelain(projectFolder: string): Promise<string[]> {
  const { stdout } = await git(projectFolder, ["status", "--porcelain"]);
  return stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
}

// True when the index carries staged changes. `git diff --cached --quiet` exits 1 when the
// index differs from HEAD (that is the "staged changes exist" signal), 0 when clean. Both are
// normal outcomes, so a nonzero exit here is NOT an error to surface.
export async function gitHasStagedChanges(projectFolder: string): Promise<boolean> {
  try {
    await git(projectFolder, ["diff", "--cached", "--quiet"]);
    return false; // exit 0 => index clean
  } catch (error: any) {
    if (error instanceof GitUnavailableError) throw error;
    // ONLY exit 1 means "staged changes exist". Any other failure (exit >=2, a timeout kill with
    // exitCode null) is a real error — surface it, or gitCommit would skip `add -A` on a false
    // "already staged" and then commit an empty index while the tree is still dirty.
    if (error?.exitCode === 1) return true;
    throw error;
  }
}

// Commit the project. When the index already carries staged changes, commit ONLY those (the
// user's staging intent is preserved, unstaged files stay untouched). When the index is clean,
// `add -A` first (the "save everything" product action). Returns the new HEAD hash.
export async function gitCommit(projectFolder: string, message: string): Promise<string> {
  try {
    if (!(await gitHasStagedChanges(projectFolder))) {
      await git(projectFolder, ["add", "-A"]);
    }
    await git(projectFolder, ["commit", "-m", message]);
  } catch (error: any) {
    if (error instanceof GitUnavailableError) throw error;
    // A timed-out / killed git (GIT_TIMEOUT_MS) can strand .git/index.lock; every later commit then
    // fails with an opaque "Unable to create '.../index.lock'". Surface an actionable message (don't
    // auto-delete the lock — a genuinely concurrent git may hold it) instead of the raw error.
    if (existsSync(join(projectFolder, ".git", "index.lock"))) {
      throw new Error(`git index is locked (.git/index.lock exists, likely from an interrupted git command) — remove that file and retry. Original error: ${String(error?.message ?? error)}`);
    }
    throw error;
  }
  return gitHeadHash(projectFolder);
}

// Current HEAD commit hash (rev-parse HEAD), trimmed.
export async function gitHeadHash(projectFolder: string): Promise<string> {
  const { stdout } = await git(projectFolder, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

// Current branch name (rev-parse --abbrev-ref HEAD), trimmed. "HEAD" on a detached checkout.
export async function gitBranch(projectFolder: string): Promise<string> {
  const { stdout } = await git(projectFolder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

// ---- Read-only history helpers (Git History tool, §3.6.3). No write verbs, EVER. ----
// These pass `hash` to git as a REVISION (before `--`), so the caller MUST pre-validate it
// (^[0-9a-f]{7,64}$) at the host trust boundary: an unvalidated "--output=<file>" reaching
// `git show` writes a file to disk even when git then errors. `path` always rides after `--`.

export type GitLogEntry = { hash: string; shortHash: string; author: string; date: string; subject: string };
export type GitFileChange = { status: string; path: string };

// Unit separator between fields, record separator between commits — control bytes that cannot occur
// in a hash or ISO-8601 date. A deliberately crafted commit subject/author COULD embed them (git
// bans only NUL/newline), which would split into a garbage extra row — display-only, and a clicked
// garbage hash fails isValidCommitHash, so it's harmless. git emits them via %x1f/%x1e.
const GIT_LOG_FIELD_SEP = "\x1f";
const GIT_LOG_RECORD_SEP = "\x1e";
const GIT_LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";

// Newest-first commit list, capped at `limit`. An empty repo (no HEAD) exits 128 — return []
// rather than surface it, since "no commits yet" is a normal state the panel renders. (The
// caller only reaches here for a present repo, so 128 means no-HEAD, not not-a-repo.)
export async function gitLog(projectFolder: string, limit: number): Promise<GitLogEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await git(projectFolder, ["log", "-n", String(limit), "--format=" + GIT_LOG_FORMAT]));
  } catch (error: any) {
    if (error instanceof GitUnavailableError) throw error;
    if (error?.exitCode === 128) return [];
    throw error;
  }
  return stdout
    .split(GIT_LOG_RECORD_SEP)
    .map((record) => record.replace(/^\r?\n/, "").trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, author, date, subject] = record.split(GIT_LOG_FIELD_SEP);
      return { hash, shortHash, author, date, subject: subject ?? "" };
    });
}

// How many commits the branch ACTUALLY has, independent of the timeline's display cap. The panel
// renders the newest N; without this it would report N as the repo's commit count and silently
// hide the rest. Mirrors gitLog's empty-repo handling: no HEAD exits 128 and means 0 commits.
export async function gitCommitCount(projectFolder: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await git(projectFolder, ["rev-list", "--count", "HEAD"]));
  } catch (error: any) {
    if (error instanceof GitUnavailableError) throw error;
    if (error?.exitCode === 128) return 0;
    throw error;
  }
  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

// Current branch via `branch --show-current`. Unlike `rev-parse --abbrev-ref HEAD` (which exits
// 128 before the first commit), this exits 0 and returns the (unborn) branch name even on an empty
// repo, and prints "" on a detached HEAD — exactly what the read-only history view needs to show
// the branch in the "no commits yet" state.
export async function gitCurrentBranch(projectFolder: string): Promise<string> {
  const { stdout } = await git(projectFolder, ["branch", "--show-current"]);
  return stdout.trim();
}

// The file changes in ONE commit via `git show --name-status` (works on a root commit, unlike
// `diff hash^ hash` which has no parent to diff). Status is normalized to its leading letter
// (M/A/D/R/C/T); a rename/copy row keeps its NEW path (git's last tab-separated field).
export async function gitShowNameStatus(projectFolder: string, hash: string): Promise<GitFileChange[]> {
  const { stdout } = await git(projectFolder, ["show", "--format=", "--name-status", hash]);
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      return { status: fields[0].charAt(0), path: fields[fields.length - 1] };
    })
    .filter((change) => change.path.length > 0);
}

// The patch text for one file: within a commit (`show <hash> -- <path>`) or the uncommitted
// working-tree change (`diff HEAD -- <path>`). `path` always AFTER `--`. Untracked files are
// invisible to both — the caller renders those from `status --porcelain`, never via this.
export async function gitDiffText(projectFolder: string, path: string, hash?: string): Promise<string> {
  const args = hash ? ["show", "--format=", hash, "--", path] : ["diff", "HEAD", "--", path];
  const { stdout } = await git(projectFolder, args);
  return stdout;
}
