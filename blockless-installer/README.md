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
tooling. Producing an installable bundle (`.app`/`.dmg` on macOS, the NSIS installer
on Windows) needs `tauri-cli`, which is local/rig-only -- never installed or invoked
in CI:

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
