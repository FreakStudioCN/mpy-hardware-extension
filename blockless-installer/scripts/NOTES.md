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

The visual canary (`workbench.colorTheme` = "Default Light Modern") makes "did VS
Code read this file?" answerable in two seconds on camera.

### Finding

_TODO: fill in after the first fresh-VM run._

- Winner: (A | B)
- macOS observed `userDataProfiles` excerpt from storage.json:

```
(paste the observed array entry for the Blockless profile here)
```

- Notes / surprises:

## Per-OS quirks observed

_TODO: fill in as runs surface them (e.g. `/Applications` writability, profile not
registered until first launch, arch detection, proxy behavior)._

## Pinned versions confirmed working

- VS Code: (productVersion observed)
- uv: 0.11.29
- Python: (3.12.x observed)
- mpremote: 1.28.0
