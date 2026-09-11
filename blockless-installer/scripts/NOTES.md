# M0 spec notes (spec input for installer-core)

Records empirical findings from running the M0 scripts on fresh machines. These are
the facts the later Rust `installer-core` must encode.

## Profile settings mechanism: A vs B

VS Code profile UI-state (Activity Bar pinning, hidden views) has no documented
headless write path, and `.code-profile` import is interactive. So the installer
writes the branded settings by hand and we determine empirically which file VS Code
actually reads for a named profile:

- **Mechanism A** (shipped default): write into the per-profile settings file at
  `<UserDir>/profiles/<id>/settings.json`, where `<id>` is looked up by profile name
  from the `userDataProfiles` array in `<UserDir>/globalStorage/storage.json`. The
  per-profile settings path is documented; the name->id lookup via storage.json is
  internal and could break across VS Code versions.
- **Mechanism B** (insurance): write into the default `<UserDir>/settings.json`.

The visual canary (`workbench.colorTheme` = "Default Dark Modern") makes "did VS
Code read this file?" answerable in two seconds on camera. Dark, not light: Blockless
has no light mode, so the shipped theme must not flip users to light.

### Finding

- Winner: **A**. Settled in the M1 scope (`/scope.md`'s "Settings" decision):
  mechanism A only, shipped as the sole path in `settings.rs`; mechanism B
  (the user's default `settings.json`) was removed from the scripts and was
  never carried into `installer-core`.
- Seeded `userDataProfiles` entry (answerable from the scripts/core directly,
  not rig-dependent — this is exactly what `register_profile_offline`/
  `profile.rs::register_profile_offline` writes, deterministically):

```json
{ "location": "blockless", "name": "Blockless" }
```

- Notes / surprises: the seeded `location` ("blockless") is only the id for
  a fresh, offline-seeded profile. If the offline seed is skipped (a VS Code
  instance was already running) and the window-fallback registration path
  creates the profile instead, VS Code assigns a hashed directory id of its
  own — `profile.rs::resolve_profile_location` reads that back and
  `state.json`'s `profileLocation` is journaled from THAT value, never the
  seed constant, so `verify.rs`/`settings.rs` always resolve the real
  on-disk id regardless of which path registered it.

## Profile registration (no headless create)

A named profile does not exist until VS Code is launched with it: `code --profile <new>
--install-extension <id>` FAILS into a not-yet-registered profile, and the profile only
appears in `storage.json`'s `userDataProfiles` after a `--profile <name> --new-window`
launch. `code --help` says `--profile` creates the profile "if it does not exist", but only
on the window-opening path, not on `--install-extension`.

Mitigation shipped in M0 (`register_profile`): if VS Code is not already running, launch it
hidden + in the background (`open -gj -a "Visual Studio Code" --args --profile <name>
--new-window`), poll `storage.json` for the profile entry (not a blind sleep), then quit VS
Code once it registers. If the user already had VS Code open, open a normal window and leave
their session alone (never quit it), since we cannot safely hide/kill a session we did not
start. `open -gj` is best-effort — a window may still flash briefly on some setups.

installer-core (Rust) should own this cleanly: spawn VS Code as a child process it controls,
keep it off-screen, and terminate exactly that process once the profile registers — no
app-wide quit, no reliance on `open -gj`.

## Per-OS quirks observed

From the first macOS rig runs, 2026-09-09, on macOS 15.6.1 arm64 in UTM.

**A running VS Code is not detectable by its main process.** `pgrep -f` could not
read the main process's argv on one machine while it could on another, so any
pattern aimed at `.../Contents/MacOS/<binary>` is unreliable. The binary is also
named `Code`, not `Electron`, which the M0 scripts assumed in seven places. Match
the app bundle instead: the helper processes are always visible and exist only
while VS Code does.

**The VS Code download is 542 MB.** Any total request timeout is a throughput
floor in disguise. `reqwest`'s blocking client defaults to 30 seconds covering
connect, read and write, which silently required ~152 Mbps sustained; below that
every attempt died mid-body. On this rig the step took 54 seconds.

**Extraction produces a flood of `xattr: Operation not permitted`.** Quarantine
stripping cannot touch individual signed files inside the bundle. Harmless, and
the install completes, but it makes install output hard to read and it hid the
useful lines in the rig logs.

**A `--keep-vscode` uninstall is a one-way door.** It removes `BLK`, which holds
`state.json`, so any later uninstall has no ownership record and cannot remove
VS Code. It ends up orphaned, removable only with `--all`, which deletes
regardless of ownership. Test `--keep-vscode` last, or on its own machine.

**An M0 tree upgrades cleanly.** `verify` returned 7/7 against a real M0 install
from 2026-08-05, and the ownership flags carried forward correctly: sticky
`vscodeInstalledByUs: true` and `profileCreatedByUs: false`, so uninstall removed
VS Code and kept the profile.

**A macOS dialog appears on any Mac without Xcode Command Line Tools, and it
is a known deviation from the acceptance criteria.** `uv python install` calls
`install_name_tool` to patch the managed Python's dylib paths. That binary ships
with CLT, so on a fresh Mac macOS pops:

    The install_name_tool command requires the command line developer tools.
    Would you like to install the tools now?

It does NOT block: dismiss it and the install completes. uv logs
`warning: Failed to patch the install name of the dynamic library`, which is
also harmless for us, because the patch only matters when building native
extensions and the runtime installs `mpremote`, `pyserial` and `platformdirs`,
all pure Python. `verify` check 3 (pinned mpremote in env) passed on every rig
run with the patch having failed.

It is inherited: M0 provisions the same uv-managed Python by the identical path,
so every M0 install on a fresh Mac showed this too.

**FIXED in M1.** uv documents no flag for skipping the patch, but it resolves
`install_name_tool` through `PATH`, measured directly on the rig with a shim
that recorded being called. So `runtime.rs` puts a no-op ahead of it, and only
where the real tool is absent, checked against the CLT and Xcode paths rather
than `/usr/bin/install_name_tool` -- that last one exists even on a machine with
no developer tools, because it IS the stub that raises the dialog. On a machine
that has the tools, nothing is shimmed and the real patch still runs.

What that trades: with the shim in place uv believes the patch succeeded and
stops warning, so the installer logs that it shimmed instead. Since the patch
could not have worked on those machines anyway, no capability is lost.

The alternative considered and rejected was pre-installing CLT on the rig. It
would have made the demo pass by no longer being a fresh Mac, while every real
user still hit the dialog.

**UTM shared folders serve the guest stale copies.** A file changed on the host
can still read as its old content in the VM, and two processes appending to one
file on the share lose writes. Copy the folder to local disk in the guest and
work there. Executing a binary from the share on the HOST, while the guest has
it mounted, stalls for minutes.

## Acceptance checklist: replace the shape fixture with a real capture

DONE, 2026-09-09, on the macOS rig.
`core/tests/fixtures/vscode-update-api.darwin-universal.json` is now a real
captured response and the hand-authored `.SHAPE.` stand-in is gone.

It was worth doing rather than waving through: the real payload carries a
`notes` field the stand-in did not have. A fixture nobody observed asserts a
shape nobody has seen, so its parse test only proved the parser agreed with
whoever wrote the fixture.

Re-capture only when `live_update_api.rs`'s ignored test fails, which means the
API's shape actually changed. The version-specific values going stale with each
VS Code release is expected and is not a reason to re-record. Steps are in
`core/tests/fixtures/README.md`.

## Pinned versions confirmed working

Observed on the macOS rig, 2026-09-09, macOS 15.6.1 arm64.

- VS Code: 1.136.2 (resolve-at-install, so this is what the API served that day)
- uv: 0.11.29
- Python: 3.12.13 (uv-managed, `cpython-3.12.13-macos-aarch64-none`)
- mpremote: 1.28.0

## uv pin coverage: two separate questions

"One of four" was too blunt and undersold what is verified. There are two
levels, and only the second needs hardware.

**Level 1, the pinned value is correct: 4 of 4.** Every asset for uv 0.11.29 was
downloaded and hashed on 2026-09-09, and all four match the manifest. Derived by
hashing the archives, not by re-reading the published `.sha256` files, so it does
not just restate its own source.

    darwin-aarch64  61c04acc52a33ef0f331e494bdfbedcdb6c26c6970c022ed3699e5860f8930e3
    darwin-x86_64   c4c4de482da9ccdd076dc4fb5cfe7b740609029385c72f58606be3153602387d
    win32-x64       a047d55651bc3e0ca24595b25ec4cfcb10f9dca9fb56514e661269b37d4fae68
    win32-arm64     55b597ae81bc29531a7c352a1431a8a73cc2755d7a5b9ec454580cbe02e5154f

Repeat with, from any machine:

    curl -sSLO https://github.com/astral-sh/uv/releases/download/0.11.29/<asset>
    shasum -a 256 <asset>

**Level 2, the whole platform path works: 2 of 4.** An install on that
architecture, proving `Arch::detect` picks the right key, `download_url` builds
the right asset name, the download verifies against the pin, extraction works,
and uv runs.

| platform | proved by | status |
| --- | --- | --- |
| darwin-aarch64 | UTM macOS VM, 2026-09-09 | done |
| win32-x64 | Windows Sandbox, 2026-09-10 | done |
| win32-arm64 | **a UTM Windows 11 ARM64 VM** | reachable, not yet run |
| darwin-x86_64 | an Intel Mac | no hardware |

win32-x64 went end to end on the Sandbox rig: arch detection, URL, download, sha
verification, extraction, and a working uv that then provisioned Python 3.12.13
and mpremote 1.28.0.

**Correction, 2026-09-10.** This table previously recorded win32-arm64 as a hardware
gap. That was wrong. UTM runs Windows 11 ARM64 on Apple Silicon through Apple's
Hypervisor framework, with the TPM emulation and Secure Boot that Windows 11 requires,
so the same Mac that hosts the macOS rig can host an ARM64 Windows one. Only
darwin-x86_64 is genuinely out of reach, since that needs an Intel Mac.

Reaching win32-arm64 is worth more than one more pin. `Arch::detect` reads
`%PROCESSOR_ARCHITECTURE%`, which is `ARM64` there, and that branch selects the
`win32-arm64-user` VS Code build and the `aarch64-pc-windows-msvc` uv asset. It has
never executed anywhere. Note that the Rust toolchain has to be
`aarch64-pc-windows-msvc`, so the VS Build Tools linker prerequisite applies again on
that VM.

Only darwin-x86_64 is a hardware gap. Nobody on this project has an
Intel Mac, so state it rather than implying the pins are unchecked: a wrong
pin is ruled out by level 1 and would fail closed anyway. What level 2 catches
that level 1 cannot is a wrong ARCH MAPPING, which would fetch the wrong asset
and then fail its sha. `uv_download_url_embeds_the_manifest_version_and_right_asset`
already unit-tests that mapping for every key, so level 2 adds the live
confirmation that the mapping matches what the machine really is.
