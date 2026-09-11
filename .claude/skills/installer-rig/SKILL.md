---
name: installer-rig
description: Build, gate and acceptance-test the Rust installer (blockless-installer) on macOS and Windows. Use before running any installer command, when its tests fail, when packaging the VSIX, or when preparing a UTM VM or Windows Sandbox rig run.
---

# The installer rig

`blockless-installer` is a Rust rewrite of the M0 shell installers. It writes to the user's VS
Code `storage.json`, does recursive deletes and terminates processes by PID, so where you run
it matters more than for anything else in this repo.

Two rules before anything else.

**The M0 scripts under `blockless-installer/scripts/` are the executable spec.** Where the Rust
and a script disagree, the script is usually what shipped on a real VM and the Rust is wrong. The
parity suites shell out to those scripts at test time, so they are the oracle, not legacy. Never
delete them.

**"Usually" is doing real work in that sentence.** The first counter-example is on record: on
Windows, `verify-blockless.ps1` could report ALL PASS and exit 0 while silently dropping a check,
and the Rust was correct. So a divergence means "one of these two is wrong", not "the Rust is
wrong". Read both before deciding, and say which side you concluded is the outlier and why.

**`npm run baseline` is the wrong gate for this component.** It is the extension gate, the
installer touches no extension source, and it can only fail here for environment reasons. The
gate is cargo.

## Where to work

Use the **main checkout**, on the branch. Not a clawker worktree.

A clawker worktree has empty submodule dirs, Linux `node_modules` and no venv. Packaging there
silently produces a VSIX with **zero** plugin files: `prepare-vsce.mjs` prints
`Vendored 0 V0 plugin files` and packages 44 files instead of 434. That artifact installs fine
and cannot run a build, which is the worst possible failure shape for a rig run whose success
criterion is "the panel opens".

`Cargo.toml` is in `blockless-installer/`, not the repo root. Running cargo from the repo root
fails with "could not find Cargo.toml".

## The ladder

| rung | cost | answers |
|---|---|---|
| 1. cargo gate | ~30 s | does the logic hold, and does it hold on THIS platform? |
| 2. CI on three runners | ~5 min | does it hold on the platforms nobody is sitting at? |
| 3. read-only ops on a real machine | seconds | does the binary run outside a test harness? |
| 4. VM rig acceptance | hours | does it actually install, verify and uninstall? |

## Rung 1: the cargo gate

    cd blockless-installer
    cargo test --workspace
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

`rust-toolchain.toml` pins 1.98.1 with clippy and rustfmt; rustup auto-installs it on first run.

**Check the exit code directly.** Piping through `tail`, `head` or `findstr` reports the pager's
status, not cargo's, and that has produced a false green here. In zsh the pipeline status is
`$pipestatus`, not `$PIPESTATUS`.

**A green here is a claim about one platform only.** Two defects shipped past a green Linux run
because both tests read the machine they ran on rather than their fixture:

- A fixture wrote a FILE at `dir/code` beside a DIRECTORY at `dir/Code`. macOS and Windows are
  case-insensitive, so those are one path and the test failed ENOTDIR. Linux sees two paths.
- Both `resolve_code` and `code_cli_candidates` built the macOS system candidate from the
  absolute literal `/Applications`, which no fabricated environment can redirect. On any machine
  with VS Code installed, both sides answered about that machine. Both now read
  `BLOCKLESS_APPS_ROOT`, defaulting to `/Applications`.

When a parity test fails, report the full `left`/`right` bit vectors: `left` is the script,
`right` is the Rust. Check order is code CLI runnable, extensions in profile, pinned mpremote,
env containment, `mpyhw.pythonPath`, `mpyhw.autoOpenPanel`, state steps.

**Count the bits before comparing them.** Seven checks means seven PASS/FAIL lines. Six means a
check did not fail, it *vanished*, and that is a different and worse bug than a divergence. On
Windows, `&` against a path that exists but is not a runnable PE raises
`ApplicationFailedException`, which is statement-terminating: PowerShell abandons the whole
if/else, neither `pass` nor `fail` runs, the fail counter never moves, and the script reports ALL
PASS and exits 0 with an assertion missing. Every external invocation in the ps1 goes through
`invoke_tool` for that reason. A present-but-unrunnable `env\Scripts\python.exe` is exactly what a
half-finished install looks like, so the check most likely to matter is the one that disappeared.

The general shape, and this is the third instance on this project after a mocked deploy grading
PASS and a classifier reading our own Ctrl-C as a firmware crash: **a gate that cannot see its own
blindness reports success.** When a check cannot be performed, it has to fail, never disappear.

Beware of fixes that hide this. Giving the fixture a runnable stub makes the parity tests pass and
puts the vanishing-check hole straight back out of sight, so the fail-closed behaviour needs its
own test that deliberately uses an unrunnable file.

## Rung 2: CI

`installer-ci.yml` runs ubuntu, macos and windows. Three things to know:

- **The path filter is `blockless-installer/**`.** A commit touching only the workflow or
  `.gitattributes` does not trigger it. Include those paths in the filter, or expect the next
  qualifying commit to pick the change up.
- **ubuntu needs zsh installed.** `verify_parity_macos.rs` is `cfg(unix)` and shells out to
  `verify-blockless.zsh`; `ubuntu-latest` ships no zsh, so without the install step all 11
  parity tests fail NotFound.
- **`verify_parity_windows.rs` is `#![cfg(windows)]` for the whole file**, so every other
  platform compiles it to zero tests. It only ever runs on the windows job.

Committed JSON is compiled in with `include_str!` and string-matched, so `.gitattributes` pins
it to LF. Without that, a CRLF checkout on Windows makes patterns written with `\n` match
nothing. An existing clone does not renormalize on its own: `git add --renormalize .` or
re-clone.

## Rung 3: read-only ops, safe on a real machine

    blockless-installer verify
    blockless-installer diagnostics --output bundle.zip

`verify` is read-only throughout and `diagnostics` only writes the zip you name. Both are safe
on a working machine and are the only way to point the binary at real state rather than a
fixture.

Expect FAILs against an old M0 tree: checks 2, 4 and 4b resolve settings from the journaled
`profileLocation`, and journals written before that field existed do not have it. That is an old
journal meeting a newer reader, not a bug. What matters is whether it fails readably.

Unzip the bundle and confirm `logs/` is non-empty. An empty `logs/` was a real review finding.

## Rung 4: the VM rig, the card's actual acceptance

**Fresh UTM macOS VM and fresh Windows Sandbox. Never the host.** `install` writes
`storage.json`, which holds every profile and window state on the machine, and `uninstall` does
recursive deletes. The VM must have **no VS Code installed**, because step 1 is installing it and
`vscodeInstalledByUs` has to end up true for the uninstall path to be exercised at all.

### Packaging, and the trap in it

    cd mpy-hardware-extension
    npm run package                              # must say "Vendored 390 V0 plugin files"
    node scripts/stamp-installer-manifest.mjs    # version + sha, never edit either by hand

**The VSIX is not reproducible.** Two builds of identical source produce different digests, so a
stamped manifest is only valid for the exact VSIX beside it. Stamp immediately before use and
ship the manifest and the VSIX together. Never trust a manifest you did not just stamp.

For the same reason the committed manifest keeps `sha256` as zeros and the canary test asserts
that. Zeros fail closed, which is honest while `components/` is unpopulated. If a real sha is
ever committed, the canary should assert shape (64 hex, not all zeros) rather than a literal,
keeping exact values for the uv pins, which are reproducible upstream release assets.

Build a release binary and copy binary, stamped manifest and VSIX into the VM. The manifest is
read from alongside the binary unless `--manifest` says otherwise; pass `--vsix` explicitly
because `components/` is not populated.

### The sequence

    blockless-installer --vsix <path> install      # no admin prompt, no stray window, panel opens
    blockless-installer verify                     # 7/7, exit 0
    blockless-installer --vsix <path> install      # second run: every step logs skip
    blockless-installer verify                     # still green
    blockless-installer diagnostics --output b.zip # logs/ non-empty
    blockless-installer uninstall                  # machine clean

On camera. Tests reinforce this; they do not substitute for it.

### Four things a clean run cannot reach

1. **Broken VS Code install (Windows).** After a successful install, break `code.cmd` so
   `version()` returns None while leaving `%LOCALAPPDATA%\Programs\Microsoft VS Code` intact,
   with `vscodeInstalledByUs: true`. Uninstall must still remove it.
2. **Window state across the graceful close (macOS).** Arrange windows and panel state, run the
   close, reopen, confirm it survived. This is the `osascript` quit path, unverifiable anywhere
   but a real Mac, and it is the path the panel-auto-open fix depends on.
3. **The uninstall ownership matrix**, the destructive surface:

   | state | expected |
   |---|---|
   | `vscodeInstalledByUs: false` | VS Code left alone |
   | `vscodeInstalledByUs: true` | removed |
   | `--all` | removed regardless |
   | `--keep-vscode` | never removed |

4. **The `#[ignore]`d live update-API test**, run explicitly, capturing the real response to
   replace the hand-authored `.SHAPE.` fixture.

### Recording arch coverage

A successful cold install proves the uv sha pin only for the arch it ran on. There are four:
darwin-aarch64, darwin-x86_64, win32-x64, win32-arm64. mac aarch64 plus win x64 is **two of
four**. Write two of four, not "the pins are proven".

## Prerequisites

### To build and test the Rust (rungs 1 to 3)

- **rustup.** `rust-toolchain.toml` pins 1.98.1 with clippy and rustfmt, and rustup installs that
  toolchain on the first `cargo` run inside `blockless-installer/`.
- **A linker, and rustup does not bring one.** Both platforms need a system linker, neither CI
  runner exposes the gap, and on a fresh machine `cargo test` dies before a single test runs.
- **macOS: Xcode Command Line Tools.** `xcode-select -p` must print a path; if it does not,
  `xcode-select --install`. `macos-latest` ships them, so CI cannot catch this either, and a
  fresh UTM VM will not have them. Not a blocker for the rig itself, which runs a prebuilt
  binary rather than compiling.
- **Windows: VS Build Tools.** rustup's default host is `x86_64-pc-windows-msvc`, which links with
  `link.exe` from **VS Build Tools with the VCTools workload**. Without it `cargo test` dies with
  "linker `link.exe` not found" before a single test runs, so rustup alone is not enough on
  Windows. Install with:

      winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

  **CI never sees this**, because `windows-latest` ships Build Tools preinstalled. It is a
  local-machine gap only, which is why it went unnoticed until the first Windows session.
  `x86_64-pc-windows-gnu` will build without Build Tools if mingw is present, but it is not the
  target the product ships on; say so in any result reported from it.
- **A shell the parity suite can drive**, per platform:
  - macOS and Linux need **zsh**, for `verify-blockless.zsh` and for the fixture's stub
    executables, whose shebang is `#!/usr/bin/env zsh`. `ubuntu-latest` has none by default.
  - Windows needs **pwsh 7**, not Windows PowerShell 5.1. The harness invokes `pwsh` by name and
    panics with "is pwsh installed?" otherwise. Check with `pwsh -Version`.
- **python3 on PATH, macOS and Linux only.** Easy to miss: the fixture's stub python answers
  `-m mpremote version` itself and then `exec python3 "$@"` for everything else, because the mac
  script checks settings.json through a Python heredoc and that needs a real interpreter. Windows
  does not need it, since the `.ps1` parses JSON natively with `ConvertFrom-Json`.

Nothing here needs Node, and nothing here needs the submodule.

### To package the VSIX (rung 4 only)

- **Node and npm**, plus `npm ci` in `mpy-hardware-extension/`. `vsce` is a devDependency and is
  not expected to be installed globally.
- **The `MicroPython_Skills` submodule, populated.** `prepare-vsce.mjs` vendors from it, and an
  empty submodule silently yields a VSIX with zero plugin files. Initialise with:

      git submodule update --init third_party/MicroPython_Skills

  `GraftSense-Drivers-MicroPython` is not needed for packaging and can be left uninitialised,
  which also avoids a revision error in some checkouts.
- Verify by reading the packaging output, not by assuming: it must say
  `Vendored 390 V0 plugin files` and package 434 files, not 44.

### For the acceptance rig

- **macOS**: UTM, and a fresh macOS VM with no VS Code installed.
- **Windows**: Windows Sandbox, fresh.

## Do not

- Do not revisit the uninstall invariants, `storage.json` writers, carry-forward, verify parity
  or signature gating. A rigorous review confirmed them faithful.
- Do not write a sha256 from memory or reconstruct one. Fetch it, or report that you could not.
  A zero fails closed; a plausible-looking digest gets trusted.
- Do not run `install`, `repair`, `repair-runtime`, `update-extension` or `uninstall` outside a
  VM.
- Do not edit `components.extension.sha256` or `version` by hand. The stamping script is the
  only thing allowed to change them.
