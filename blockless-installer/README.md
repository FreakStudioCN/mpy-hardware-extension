# Blockless installer

An all-in-one, one-click installer that sets up a fresh machine for Blockless
MicroPython hardware education: it installs VS Code, installs the Blockless
extension into a branded profile, provisions a contained Python + mpremote
environment, and applies branded profile settings.

Audience: education (K12, STEAM maker, university embedded courses), not industrial
developers.

## Status: M0 (script spike)

M0 proves the whole flow with plain per-OS scripts before any Rust/Tauri app exists.
The scripts are the executable spec that the later `installer-core` Rust library
mirrors. The permanent home for the code (dedicated repo vs subfolder) is decided at
M1, not here.

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
