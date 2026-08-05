# Blockless installer, architecture

Status: agreed direction for the GUI installer. The shell scripts in `scripts/{macos,windows}/`
are the **executable spec**. Every flow, pin, and check below is already proven end-to-end on a
fresh macOS VM and a fresh Windows Sandbox. The GUI app re-implements this spec in a shared Rust
core; it does not invent new behavior.

The guiding rule (ruili): the installer **consumes release artifacts + a manifest**. It never imports
extension source. That keeps a future split into its own repo cheap.

---

## 1. Repo location & folder layout

Stays inside `mpy-hardware-extension` for now (the installer is tightly coupled to the extension
version, the pinned VSIX, the Python runtime requirements, the Skill submodule commit, and the
backend compatibility contract, a premature split would create version drift). It moves to its own
repo once it has its own release cadence, signing pipeline, and owner.

```
blockless-installer/
  ARCHITECTURE.md            # this doc
  scripts/                   # the executable spec (M0), kept as the reference + CI smoke
    macos/{install,verify,uninstall}-blockless.zsh
    windows/{install,verify,uninstall}-blockless.ps1
    NOTES.md
  manifest/
    installer.manifest.json  # pinned components + checksums (see §2)
  core/                      # shared Rust crate: all install logic (no GUI, no OS shell)
  app/
    macos/                   # thin Tauri shell -> core
    windows/                 # thin Tauri shell -> core
  components/                # optional embedded artifacts for an offline bundle (see §5)
```

The core crate is a plain library: the GUI, a headless CLI, and CI all call the same operations.

---

## 2. Manifest format

A single JSON manifest is the source of truth for *what* gets installed. The core reads the manifest
and plans/executes; it holds no version literals in code. Each component declares a **source**
(`download`, `bundled`, `managed`, `marketplace`) so the same manifest can drive an online install
or an offline bundle by swapping sources.

```jsonc
{
  "schemaVersion": 1,
  "installerVersion": "0.1.0",
  "profileName": "Blockless",
  "settings": {
    "workbench.colorTheme": "Default Dark Modern",   // Blockless has no light mode
    "mpyhw.autoOpenPanel": true                       // extension auto-opens its panel when set
  },
  "components": {
    "vscode": {
      "source": "download",
      "resolver": "vscode-update-api",                // sha256 comes from the API per platform at resolve time
      "channel": "stable",
      "platform": { "darwin": "darwin-universal", "win32-x64": "win32-x64-user", "win32-arm64": "win32-arm64-user" }
    },
    "uv":       { "source": "download", "version": "0.11.29", "sha256": { "darwin-aarch64": "…", "win32-x64": "…", "…": "…" } },
    "python":   { "source": "managed", "manager": "uv", "series": "3.12" },
    "mpremote": { "source": "pip", "version": "1.28.0" },
    "extension":{ "source": "bundled", "id": "blockless.mpy-hardware-extension", "version": "0.4.2",
                  "sha256": "…", "path": "components/mpy-hardware-extension.vsix" },
    "pythonExtension": { "source": "marketplace", "id": "ms-python.python" }  // pulls ms-python.vscode-pylance
  }
}
```

- `download` → fetch the pinned URL, verify `sha256`, then install.
- `bundled` → the artifact ships next to the installer (`components/…`); verify `sha256`, install.
- `managed` → provisioned by another tool at a pinned version (uv installs Python 3.12).
- `marketplace` → resolved live from the VS Code Marketplace (see §7, used only where trusted).

**Offline bundle = the same manifest with `download`/`marketplace` sources rewritten to `bundled`,**
plus the artifacts under `components/`. No code change.

---

## 3. Pinned component versions & checksums

| Component | Pin | Source | Integrity |
|---|---|---|---|
| VS Code | `stable` latest, per-arch User build | update API | `sha256hash` from the API response |
| uv | 0.11.29 | astral.sh install script | pinned `sha256` in the manifest |
| Python | 3.12 (latest patch) | uv-managed, contained | uv verifies its own download |
| mpremote | 1.28.0 | `uv pip install` | pip resolution |
| Blockless extension | pinned VSIX (0.4.2 today) | bundled | manifest `sha256` |
| MS Python (+ Pylance) | latest | Marketplace | Marketplace |

VS Code is the one component whose checksum is resolved at install time (the update API returns the
URL + `sha256hash` + `productVersion` together); everything else carries a static pin.

---

## 4. Online bootstrap flow (default)

The proven flow, everything contained under one folder (macOS `~/Library/Application Support/Blockless`,
Windows `%LOCALAPPDATA%\Blockless`). Every step is **detect → skip-or-do → verify**, so re-running is a
repair, not corruption.

1. **VS Code**: if absent, resolve from the update API, download, verify `sha256`, install
   *silently, no admin*: macOS `ditto`-extract into `/Applications` (fall back to `~/Applications`);
   Windows User Setup `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /MERGETASKS=!runcode` into
   `%LOCALAPPDATA%\Programs\Microsoft VS Code`. Record `vscodeInstalledByUs`.
2. **Profile + extension**: register the `Blockless` profile **offline** (seed `storage.json`'s
   `userDataProfiles` entry + create `profiles/blockless/` directly, *without launching VS Code*).
   Root cause this fixes: registering via a live window then quitting VS Code leaves half-written
   window state, so the first real launch fires `onStartupFinished` against the *default* profile and
   the extension's auto-open never runs. Seeding means no window exists before the final launch, so
   the CLI installs the extension straight into the profile and the first window auto-opens the panel.
   Install our extension from the **bundled pinned VSIX** (see §6), plus `ms-python.python`.
3. **Python + mpremote**: install `uv` contained (`UV_UNMANAGED_INSTALL`), then a *contained,
   uv-managed* interpreter (`UV_PYTHON_INSTALL_DIR`, `uv python install --no-bin`,
   `uv venv --managed-python`), then `mpremote`. No system Python is ever invoked (avoids the macOS
   Xcode CLT prompt) and the env never leaks to a system/Anaconda Python (verify asserts the base).
4. **Branded settings**: write the profile's `settings.json` (mechanism A, per-profile file):
   `mpyhw.pythonPath`, the dark theme, `mpyhw.autoOpenPanel: true`.
5. **Open**: launch into the `Blockless` profile; the extension auto-opens its panel.

State is journaled to `state.json` after each step (`vscodeInstalledByUs`, per-step booleans, env
python path, settings mechanism, timestamp).

---

## 5. Offline bundle flow (design allowance, not the default artifact)

For schools / workshops / locked-down lab networks with no reliable internet. **Not** the default
build (it's large), but the design supports producing one:

- Ship the installer with `components/` populated (VS Code installer, uv binary, a pre-downloaded
  uv Python, the VSIX, wheels for mpremote + deps).
- The manifest for that build declares those components `bundled`; the core takes the embedded path
  instead of downloading, verifies the same `sha256`, and runs the identical install steps.
- Same core, same verify, only the component *source* differs.

---

## 6. Pinned-VSIX delivery policy

The installer installs the **exact extension build it was tested with**, shipped as a bundled VSIX and
verified by `sha256`. It does **not** default to "latest from Marketplace."

Reason (already hit): the Marketplace had a `0.4.2` published at an *older* commit, same version
number, but built before `mpyhw.autoOpenPanel` existed, so a Marketplace install silently produced a
build where the panel never auto-opens. Installer and extension versions move together through the
pinned VSIX.

---

## 7. Marketplace fallback policy

Two channels, longer term:
- **Pinned channel (default):** bundled VSIX + pinned manifest, every stable installer release.
- **Marketplace channel:** only once the Marketplace release flow is reliable *and* the core runs a
  compatibility check (version + a known-good marker) before trusting it.

Today: pinned only. `ms-python.python`/Pylance still come from the Marketplace (they're stable and not
ours).

---

## 8. Update / repair / diagnostics

Not install-once-and-forget, but **no silent auto-updates**, classroom/lab environments often need
fixed versions and silent toolchain bumps cause hard-to-debug failures. The core exposes explicit
modes:

- **repair**, fix missing/broken VS Code integration, re-seed the profile, re-apply settings.
- **update-extension**, reinstall/update the Blockless VSIX to the pinned version.
- **verify**, the acceptance checks (§13).
- **repair-runtime**, re-provision Python/uv/mpremote if broken.
- **diagnostics**, export logs + `state.json` + resolved manifest.
- **uninstall**, remove the profile (dir + `storage.json` entry) and the contained runtime; remove
  VS Code only if we installed it.

VS Code and Python version *upgrades* are user-triggered/confirmed, never automatic.

---

## 9. Logging & diagnostics paths

Everything under the one contained folder: `…/Blockless/logs/` for run logs, `…/Blockless/state.json`
for the journal. `diagnostics` bundles those plus the resolved manifest and OS/arch/version facts.
No data leaves the machine unless the user exports it.

---

## 10. Privilege / admin policy

**No admin, ever.** macOS installs to `/Applications` only if writable, else `~/Applications`; the
contained runtime is under the user's Application Support. Windows uses VS Code **User** Setup
(`%LOCALAPPDATA%`), uv unmanaged-install, and a per-user contained runtime. If a step would require
elevation, it fails with guidance rather than prompting for admin.

---

## 11. Proxy / network failure handling

- Honor the system/env proxy (`HTTPS_PROXY`) for every download (the scripts already do via
  `curl` / `Invoke-WebRequest`).
- Retries with backoff on transient failures; every download is `sha256`-verified, so a
  partial/corrupt fetch fails loudly rather than installing a bad artifact.
- A hard network failure stops with a clear "couldn't reach X" message and leaves the machine in a
  re-runnable state (detect→skip means the next run resumes).

---

## 12. Rollback / failure handling

- Each step verifies before marking itself done in `state.json`; a failed step aborts with a specific
  error and never advances the journal.
- Because everything is contained under one folder plus a single dedicated VS Code profile, the
  **uninstaller is the rollback**: it removes the profile (dir + `storage.json` entry, no orphan) and
  the runtime folder, and removes VS Code only if `vscodeInstalledByUs`. It never touches the shared
  VS Code user data or a user's other profiles.
- Re-running the installer after a failure repairs rather than duplicates.

---

## 13. macOS / Windows acceptance checklist

The `verify` operation (7 checks, exit 0 only if all pass), run on a **fresh** machine:

1. VS Code CLI runnable.
2. All three extensions present in the `Blockless` profile: `blockless.mpy-hardware-extension` +
   `ms-python.python` + `ms-python.vscode-pylance`.
3. Pinned `mpremote` (1.28.0) importable in the contained env.
4. The env's base interpreter is **contained** (its `pyvenv.cfg home` is under `…/Blockless`), not a
   system/Anaconda/py-launcher Python.
5. `mpyhw.pythonPath` set in the profile settings and points at a real executable.
6. `mpyhw.autoOpenPanel: true` in the profile settings.
7. `state.json` records all four steps ok.

Plus, manually / on camera: cold install with **no admin or security prompt**, **no stray VS Code
window**, and the Blockless panel **auto-opens** on the final launch; a second run logs every step as
a skip and still verifies green (idempotency).

Environments: fresh macOS VM (UTM) and fresh Windows Sandbox (pristine per launch).

---

## 14. Stack

Shared **Rust core** + thin **Tauri** shells per OS. The install flow lives once in the core, which
owns: OS/arch detection, manifest resolution + install planning, downloads + checksum verification,
VS Code install, offline profile seeding, VSIX install, uv/Python/mpremote setup, settings write,
logging, diagnostics, retry, and repair/update/uninstall. The macOS and Windows GUIs stay thin and
call the same core operations.

---

## Open items before the GUI PR

- Sign-off on the manifest schema (§2) and the pinned set (§3).
- Populate real `sha256` values in the first manifest.
- Decide the offline-bundle trigger (a separate build target vs a flag).
- Code signing + notarization (Apple Developer cert + notarization; Windows Authenticode), separate
  track, real cost + lead time, needed before public distribution.
