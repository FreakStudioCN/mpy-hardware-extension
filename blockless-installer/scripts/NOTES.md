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

_TODO: fill in after the first fresh-VM run._

- Winner: (A | B)
- macOS observed `userDataProfiles` excerpt from storage.json:

```
(paste the observed array entry for the Blockless profile here)
```

- Notes / surprises:

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

_TODO: fill in as runs surface them (e.g. `/Applications` writability, profile not
registered until first launch, arch detection, proxy behavior)._

## Pinned versions confirmed working

- VS Code: (productVersion observed)
- uv: 0.11.29
- Python: (3.12.x observed)
- mpremote: 1.28.0
