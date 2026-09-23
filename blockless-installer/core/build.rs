//! Stamps the build's git commit into the binary, for the diagnostics bundle.
//!
//! WHY: `installerVersion` alone cannot identify a build. During the Windows
//! acceptance of 2026-09-21/22, at least six different `0.1.0` executables
//! were produced in two days -- before the fixes, after each of them, and
//! after the NSIS bundle was dropped -- and nothing distinguished them. The
//! VSIX is not reproducible either, so "0.1.0" in a bug report identifies a
//! version number, not an artefact. `facts.json` is the first thing anyone
//! reads when triaging, so it should say which commit it came from.
//!
//! Falls back to `unknown` rather than failing the build: a source tarball,
//! a vendored build, or a machine without git on PATH must still compile.
//! `-dirty` is appended when the working tree has uncommitted changes, which
//! is the normal state for a developer build and exactly what you want to see
//! in a bug report from one.
//!
//! RE-RUNS on commits and checkouts (`.git/HEAD`, refs), on staging
//! (`.git/index`), and on edits to the source of every crate that links this
//! one (`core`, `cli`, `app`), so a rebuild after an uncommitted edit picks up
//! `-dirty`. Edits outside those trees can still leave the flag stale: it
//! identifies the commit, not the exact bytes; for a release, build from a
//! clean tree and tag it.

use std::process::Command;

fn main() {
    // Re-run when HEAD moves (commit, checkout) or when the ref it points at
    // is updated. Paths are relative to this crate's manifest directory.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");
    println!("cargo:rerun-if-changed=../../.git/index");
    // Source trees, not the crate roots: `target/` lives beside them and
    // would make every build re-run this.
    for dir in ["src", "../cli/src", "../app/src", "../app/ui"] {
        println!("cargo:rerun-if-changed={dir}");
    }

    let sha = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let dirty = match git(&["status", "--porcelain"]) {
        Some(out) if !out.trim().is_empty() => "-dirty",
        Some(_) => "",
        // Could not ask git at all: say so rather than implying a clean tree.
        None if sha != "unknown" => "-status-unknown",
        None => "",
    };
    println!("cargo:rustc-env=BLOCKLESS_GIT_SHA={sha}{dirty}");
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.trim().to_string())
}
