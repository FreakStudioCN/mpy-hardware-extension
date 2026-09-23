# Blockless installer

An all-in-one, one-click installer that sets up a fresh machine for Blockless
MicroPython hardware education: it installs VS Code, installs the Blockless
extension into a branded profile, provisions a contained Python + mpremote
environment, and applies branded profile settings.

Audience: education (K12, STEAM maker, university embedded courses), not industrial
developers.

## M1: Rust installer-core library, headless CLI, and GUI shell

`blockless-installer` contains the Rust core library, the headless CLI, and a Tauri
GUI shell (`app/`). The original M0 scripts remain as executable specs and parity
references.

### Building/running the GUI (`app/`)

`app/` is excluded from the root cargo workspace and only compiles on macOS/Windows
(it uses the cfg-gated `core::system::SystemEnvironment`, same as the CLI). Every
command below runs from inside `app/` -- or `blockless-installer/` with
`--manifest-path app/Cargo.toml` -- so `rust-toolchain.toml` and `.cargo/config.toml`
are discovered by cargo's ancestor walk the same way they are for `core`/`cli`.

```
cd app
cargo build          # a runnable dev binary; no tauri-cli needed
cargo run
```

A plain `cargo build`/`cargo run` produces a working dev binary without any extra
tooling.

**It will not install anything on its own.** Like the CLI, the GUI reads
`installer.manifest.json` and resolves the bundled VSIX relative to that manifest.

`tauri_build::build()` honours `bundle.resources` on every plain `cargo build`, so a
build DOES place the committed manifest beside the dev executable. That manifest carries
all-zero hashes and no VSIX is copied with it, so pressing Install in a `cargo run`
window stops at the missing-VSIX check and mutates nothing: the check runs before the
window creates `logs/`, so not even the log directory appears.

**Uninstall and Diagnostics are a different matter in a dev window.** Neither needs the
VSIX, so both run for real against the machine you are sitting at. Do not confirm the
uninstall dialog on a machine whose VS Code or Blockless install you care about. That is
what the virtual machine is for.

It looks in two places, in this order: beside its own executable first, then its
bundle's resource directory. Exe-adjacent wins deliberately, so a manifest you stamped
and placed yourself always beats a copy baked into a bundle.

So the GUI ships as a sidecar set, three things in one directory:

```
blockless-installer-gui            # or the .app / installed exe
installer.manifest.json            # stamped, NOT the committed zero-sha copy
components/<extension>.vsix        # the exact VSIX that manifest's sha256 covers
```

The committed `manifest/installer.manifest.json` carries all-zero hashes on purpose, so
an unstamped set fails closed at the verification step rather than installing something
unverified. Assemble the set the way the rig does before testing an install.

**Never assemble that set inside a cargo target directory.** The build copies the
committed manifest over anything at that path, so a manifest you stamped into
`app/target/release/` is silently reverted to the zero-hash copy by the next
`cargo build`. Assemble it somewhere else and copy the binary to it.

A `cargo tauri build` bundle carries the manifest: `tauri.conf.json` declares it under
`bundle.resources`, in map form, and the resource-directory fallback is what finds it on
macOS, where Tauri puts resources in `Contents/Resources/` while the executable sits in
`Contents/MacOS/`.

What a bundle does NOT carry is a usable one. The declared file is the committed
manifest, whose hashes are zeros, so a bundle built with no stamping step finds a
manifest, fails the hash check and installs nothing. That is the honest outcome rather
than a bug: the VSIX is not reproducible, so a stamped manifest is only valid for the
exact VSIX beside it, and a real hash committed here would be wrong as soon as the VSIX
is rebuilt. A bundle that can install needs a stamp-and-inject packaging step, which
does not exist yet. Until it does, install from a release binary and its sidecar files.

**The bundle provisions WebView2, but the app does not depend on it.** Tauri's NSIS
template decides whether to provision by reading an EdgeUpdate registry key that
Microsoft Edge also registers, so on a machine carrying that registration without the
runtime it provisions nothing. The app therefore checks and provisions the runtime
itself (`core/src/webview2.rs`), using Microsoft's detection API rather than the
registry. See ARCHITECTURE.md section 10.

Producing an installable bundle (`.app`/`.dmg` on macOS, the NSIS installer on Windows)
needs `tauri-cli`, which is local/rig-only -- never installed or invoked in CI:

```
cargo install tauri-cli --version "^2"   # once, locally
cargo tauri build                        # from app/
```

Icons under `app/icons/` are generated once from `mpy-hardware-extension/media/icon.svg`
(render to a 1024px PNG, then `cargo tauri icon`) and committed; regenerate them the
same way if the source SVG changes.

### Pins

| Component        | Pinned value        |
|------------------|---------------------|
| Profile name     | `Blockless`         |
| Extension        | `blockless.mpy-hardware-extension` |
| Python extension | `ms-python.python`  |
| uv               | `0.11.29`           |
| Python           | `3.12` (latest patch) |
| mpremote         | `1.28.0`            |
| VS Code          | `stable` / latest   |

Everything the scripts create lives under one folder, so uninstalling is deleting it:

- macOS: `~/Library/Application Support/Blockless/`
- Windows: `%LOCALAPPDATA%\Blockless\`

(The exception is VS Code itself and its user profile, which live in VS Code's own
locations, as expected.)

## Run

### macOS

```
zsh scripts/macos/install-blockless.zsh          # optional: --vsix /path/to/ext.vsix
zsh scripts/macos/verify-blockless.zsh           # exits 0 only if every step passed
```

Re-running the installer is a repair: each step detects its own success marker and
skips if already done.

### Windows

Added later in M0 (`scripts/windows/`). Same flow, PowerShell.

## Test on a genuinely fresh environment

- **macOS**: a freshly installed macOS VM in UTM (Apple Silicon). Keep the clean
  `.utm` as a golden copy and duplicate it per run (UTM macOS guests lack usable
  snapshots).
- **Windows**: Windows Sandbox (Pro/Enterprise/Education), which is pristine every
  launch and discards all state on close.

A second consecutive install run must log every step as a skip and still verify
green, that is the idempotency proof.

## Notes

- Behind a proxy, the scripts honor the system/env proxy (`HTTPS_PROXY`), since they
  use `curl` / `Invoke-WebRequest`.
- No system Python is invoked on macOS (that would trigger the Xcode Command Line
  Tools prompt); the provisioned interpreter is used for all JSON work after step 3.
- The empirical finding for the profile-settings mechanism (A vs B) is recorded in
  `scripts/NOTES.md`.
