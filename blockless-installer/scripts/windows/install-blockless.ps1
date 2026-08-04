#!/usr/bin/env pwsh
# Blockless one-click installer -- M0 script spike (Windows). Mirror of
# scripts/macos/install-blockless.zsh: installs VS Code, installs the extension into a branded
# "Blockless" profile, provisions a contained Python + mpremote via uv, applies branded profile
# settings, and opts the profile into auto-opening the panel. Each step is detect -> skip-or-do ->
# verify, so re-running is a repair, not corruption.
#
# Usage:  .\install-blockless.ps1 -Vsix C:\path\to\mpy-hardware-extension.vsix
[CmdletBinding()]
param([string]$Vsix = "")

# Native-command failures must NOT throw: the extension-install fallback and the "skip if already
# present" checks rely on inspecting $LASTEXITCODE / output of commands *expected* to fail sometimes
# (e.g. `code --list-extensions` before the profile exists). PS 7.4+ has a per-native toggle
# ($PSNativeCommandUseErrorActionPreference), but Windows PowerShell 5.1 -- what ships in-box and in
# Windows Sandbox -- has none: under $ErrorActionPreference='Stop', a native command's stderr routed
# through `2>$null` becomes a *terminating* NativeCommandError, killing the run before the retry path.
# So run at the default 'Continue' (as verify-blockless.ps1 does) and abort explicitly via `die` on
# every critical cmdlet (each is guarded below). Set the 7.4 toggle too, for parity when run under pwsh.
$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false
# Windows PowerShell 5.1 (what ships in-box, incl. Windows Sandbox) renders an Invoke-WebRequest
# progress bar per-chunk; on a ~100MB download that is 10-50x slower and looks like a hang. Silence it.
$ProgressPreference = "SilentlyContinue"

# --- pins (the executable spec the Rust installer-core will mirror) ---
$PROFILE_NAME     = "Blockless"
$EXT_ID           = "blockless.mpy-hardware-extension"
$PY_EXT_ID        = "ms-python.python"
$UV_VERSION       = "0.11.29"
$PYTHON_SERIES    = "3.12"
$MPREMOTE_VERSION = "1.28.0"
$CANARY_THEME     = "Default Dark Modern"   # dark; Blockless has no light mode
$VSCODE_PLATFORM  = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64-user" } else { "win32-x64-user" }

# --- paths (everything the installer creates lives under one folder) ---
$BLK       = Join-Path $env:LOCALAPPDATA "Blockless"
$DL        = Join-Path $BLK "downloads"
$LOGS      = Join-Path $BLK "logs"
$STATE     = Join-Path $BLK "state.json"
$CODE_USER = Join-Path $env:APPDATA "Code\User"
$STORAGE   = Join-Path $CODE_USER "globalStorage\storage.json"
$ENVPY     = Join-Path $BLK "env\Scripts\python.exe"

# --- mutable state (script-scoped so functions can write it) ---
$script:STEP_VSCODE = $false; $script:STEP_EXT = $false; $script:STEP_PY = $false; $script:STEP_SETTINGS = $false
$script:VSCODE_PRODUCT_VERSION = ""
$script:VSCODE_INSTALLED_BY_US = $false   # "we installed VS Code" vs "it was already present"
$script:CODE = ""
$script:USER_HAD_CODE = $false            # was a VS Code the USER started already running when we began?

function log($m) { Write-Host "[blockless] $m" }
function die($m) { Write-Host "[blockless] ERROR: $m" -ForegroundColor Red; exit 1 }

# Resolve the `code` CLI explicitly -- never trust PATH on a fresh machine.
function Resolve-Code {
  $c = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"
  if (Test-Path $c) { $script:CODE = $c; return $true }
  return $false
}

# Preserve "we installed VS Code" across idempotent re-runs. On a re-run where step1 SKIPS (VS Code
# already present, possibly because a PRIOR run of THIS installer put it there), the skip branch leaves
# $script:VSCODE_INSTALLED_BY_US at its $false default -- which would clobber a true recorded earlier and
# make the uninstaller refuse to remove a VS Code we installed. Seed the flag from any existing state.json.
function Read-PriorState {
  if (-not (Test-Path $STATE)) { return }
  try { $st = Get-Content $STATE -Raw | ConvertFrom-Json } catch { return }
  if ($st.vscodeInstalledByUs) { $script:VSCODE_INSTALLED_BY_US = $true }
}

function Write-State {
  New-Item -ItemType Directory -Force -Path $BLK | Out-Null
  $s = [ordered]@{
    productVersion      = $script:VSCODE_PRODUCT_VERSION
    vscodeInstalledByUs = $script:VSCODE_INSTALLED_BY_US
    steps               = [ordered]@{ vscode = $script:STEP_VSCODE; extension = $script:STEP_EXT; python = $script:STEP_PY; settings = $script:STEP_SETTINGS }
    mpremoteVersion     = $MPREMOTE_VERSION
    envPython           = $ENVPY
    settingsMechanism   = "A"
    updatedAt           = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  ($s | ConvertTo-Json -Depth 5) | Set-Content -Path $STATE -Encoding UTF8
}

# --- profile helpers (PowerShell has native JSON, so no python is needed for this) ---
function Get-ProfileLocation {
  if (-not (Test-Path $STORAGE)) { return "" }
  try { $d = Get-Content $STORAGE -Raw | ConvertFrom-Json } catch { return "" }
  $p = $d.userDataProfiles | Where-Object { $_.name -eq $PROFILE_NAME } | Select-Object -First 1
  if ($p) { return [string]$p.location } else { return "" }
}
function Test-ProfileRegistered { return [bool](Get-ProfileLocation) }

# Close VS Code and WAIT for every "Code" process to exit. Two things matter here:
#  * GRACEFUL close, not a hard kill. `taskkill` WITHOUT /F posts WM_CLOSE so Electron shuts down cleanly
#    and SAVES its window/profile state (the macOS installer gets this from `osascript quit`). A hard
#    Stop-Process -Force skips that save, and the next cold `code --profile Blockless` launch then falls
#    back to the DEFAULT profile instead of Blockless -- so the auto-opened window lacks the extension
#    and the panel never appears. Force-kill is kept only as a last resort if graceful close doesn't take.
#  * WAIT to zero. VS Code spawns several "Code" processes; the next launch could otherwise attach to one
#    still shutting down. A fresh instance is essential -- a running extension host won't load a
#    newly-installed extension, so a stale instance would never activate the Blockless extension.
function Stop-CodeAndWait {
  taskkill /IM Code.exe *> $null                      # graceful (WM_CLOSE); no /F -> state is saved
  for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Name "Code" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
  if (Get-Process -Name "Code" -ErrorAction SilentlyContinue) {   # last resort only
    Get-Process -Name "Code" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) { if (-not (Get-Process -Name "Code" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
  }
}

# Register the profile WITHOUT launching VS Code, by seeding the userDataProfiles entry in
# storage.json ourselves (the same internal name->location mapping mechanism A already reads).
# WHY (root cause of "panel never auto-opens", see NOTES.md): registering via a live window and then
# killing VS Code mid-startup leaves half-written window state in storage.json (the empty-window
# backup lands, its profileAssociations entry may not). On the final cold launch the workbench then
# resolves the window's INITIAL extension list against the DEFAULT profile, fires onStartupFinished
# with built-ins only, and only delta-adds the profile's extensions moments later -- too late:
# onStartupFinished is never re-fired, so activate()/auto-open never runs even though the icon works
# (clicking it activates via onView). Seeding storage.json means NO window ever exists before the
# final launch: the CLI installs straight into profiles/blockless/ (verified on 1.130.0 + 1.131.0),
# and Open-Blockless opens the profile's FIRST-ever window, whose association is written
# synchronously by VS Code itself -- the extension lands in the onStartupFinished batch (verified
# via exthost.log in an isolated instance). If a VS Code instance is running it owns storage.json
# in memory and would clobber our edit, so skip; Step-Extension's window-based fallback covers that.
function Register-ProfileOffline {
  if (Test-ProfileRegistered) { return }
  if (Get-Process -Name "Code" -ErrorAction SilentlyContinue) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path $STORAGE -Parent) | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $CODE_USER "profiles\blockless") | Out-Null
  $d = $null
  if (Test-Path $STORAGE) { try { $d = Get-Content $STORAGE -Raw | ConvertFrom-Json } catch { $d = $null } }
  if ($null -eq $d) { $d = [pscustomobject]@{} }
  $list = @()
  if ($d.PSObject.Properties["userDataProfiles"]) { $list = @($d.userDataProfiles) }
  $list += [pscustomobject]@{ location = "blockless"; name = $PROFILE_NAME }
  $d | Add-Member -Force -NotePropertyName "userDataProfiles" -NotePropertyValue $list
  # WriteAllText, not Set-Content: VS Code's state reader is strict JSON and PS 5.1's
  # `Set-Content -Encoding UTF8` prepends a BOM, which would corrupt storage.json.
  [System.IO.File]::WriteAllText($STORAGE, ($d | ConvertTo-Json -Depth 30))
  if (Test-ProfileRegistered) { log "step2: profile '$PROFILE_NAME' registered offline (no VS Code launch)" }
}

# Fallback only (a live VS Code owns storage.json, or a future VS Code stops honoring the seeded
# entry): a new profile also appears in storage.json after VS Code is launched with it (a headless
# --install-extension into a missing profile fails). Launch it, poll for registration, then close it
# if we were the ones who started VS Code (never quit a user's session). NOTE: this path re-creates
# the half-written-state race described above Register-ProfileOffline; keep it a last resort.
function Register-Profile {
  if (Test-ProfileRegistered) { return }
  Start-Process -FilePath $script:CODE -ArgumentList '--profile', $PROFILE_NAME, '--new-window'
  for ($i = 0; $i -lt 60; $i++) { if (Test-ProfileRegistered) { break }; Start-Sleep -Milliseconds 500 }
  # Only tear down VS Code if the user had none running when we started (never kill a user's session).
  if (-not $script:USER_HAD_CODE) { Stop-CodeAndWait }
}

# --- step 1: VS Code (User Setup, silent, no admin) ---
function Step-VSCode {
  if ((Resolve-Code) -and (& $script:CODE --version 2>$null)) {
    $script:VSCODE_PRODUCT_VERSION = (& $script:CODE --version | Select-Object -First 1)
    $script:STEP_VSCODE = $true; log "step1 VS Code: present ($($script:VSCODE_PRODUCT_VERSION)), skip"; return
  }
  log "step1 VS Code: installing (downloading ~100 MB)"
  New-Item -ItemType Directory -Force -Path $DL | Out-Null
  $meta = Invoke-RestMethod "https://update.code.visualstudio.com/api/update/$VSCODE_PLATFORM/stable/latest"
  if (-not $meta.url -or -not $meta.sha256hash) { die "could not parse VS Code download metadata" }
  $exe = Join-Path $DL "VSCodeUserSetup.exe"
  # Download with curl.exe (in-box since Win10 1803) for a real, fast progress bar. This is DOWNLOAD-ONLY:
  # curl just writes the .exe to an ABSOLUTE -o path (so its working dir never matters, even when launched
  # from the mapped C:\blk share), then the PROVEN User Setup installs it below unchanged. PS 5.1's IWR
  # renders its progress bar per-chunk (~10-50x slower on ~100 MB, looks hung), so it's the fallback ONLY
  # if curl is somehow absent -- its own bar stays suppressed via $ProgressPreference at top. The sha256
  # check below catches any corrupt/partial download regardless of which path fetched it.
  $curl = Join-Path $env:SystemRoot "System32\curl.exe"
  if (Test-Path $curl) {
    & $curl -fL --progress-bar -o $exe $meta.url
    if ($LASTEXITCODE -ne 0) { die "VS Code download failed (curl exit $LASTEXITCODE)" }
  } else {
    Invoke-WebRequest $meta.url -OutFile $exe -UseBasicParsing   # -UseBasicParsing avoids the 5.1 IE engine
  }
  if (-not (Test-Path $exe)) { die "VS Code download failed (no file written)" }
  if ((Get-FileHash $exe -Algorithm SHA256).Hash -ne $meta.sha256hash) { die "VS Code sha256 mismatch (corrupt download)" }
  # /MERGETASKS=!runcode: install silently, do NOT auto-launch VS Code afterward.
  Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES','/MERGETASKS=!runcode' -Wait
  if (-not (Resolve-Code)) { die "VS Code CLI not found after install" }
  & $script:CODE --version *> $null
  $script:VSCODE_PRODUCT_VERSION = (& $script:CODE --version | Select-Object -First 1)
  $script:VSCODE_INSTALLED_BY_US = $true; $script:STEP_VSCODE = $true
  log "step1 VS Code: installed ($($script:VSCODE_PRODUCT_VERSION))"
}

# --- step 2: extension into the "Blockless" profile ---
function Test-BothExt {
  $list = & $script:CODE --profile $PROFILE_NAME --list-extensions 2>$null
  return (($list -contains $EXT_ID) -and ($list -contains $PY_EXT_ID))
}
function Install-Ext($id) {
  # OUR extension: install the BUNDLED vsix -- it is the exact build this installer ships and verifies.
  # The Marketplace has a 0.4.2 published at an OLDER commit (SAME version number, but built before
  # mpyhw.autoOpenPanel existed), so `--install-extension $EXT_ID` pulls that stale build and the panel
  # never auto-opens. So prefer the vsix; fall back to the Marketplace only if no usable vsix was given.
  if ($id -eq $EXT_ID) {
    if ($Vsix -and (Test-Path $Vsix)) {
      log "step2: installing $id from the bundled vsix"
      & $script:CODE --profile $PROFILE_NAME --install-extension $Vsix --force *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
      log "step2: bundled vsix install failed, falling back to the Marketplace for $id"
    }
    & $script:CODE --profile $PROFILE_NAME --install-extension $id --force *> $null
    return ($LASTEXITCODE -eq 0)
  }
  # Marketplace-sourced dependency (ms-python.python -> also pulls Pylance).
  & $script:CODE --profile $PROFILE_NAME --install-extension $id --force *> $null
  return ($LASTEXITCODE -eq 0)
}
function Step-Extension {
  if (Test-BothExt) { $script:STEP_EXT = $true; log "step2 extension: present, skip"; return }
  log "step2 extension: installing into profile '$PROFILE_NAME'"
  Register-ProfileOffline   # headless registration first: no window may run before the final launch
  if ((-not (Install-Ext $EXT_ID)) -or (-not (Install-Ext $PY_EXT_ID))) {
    log "step2: first attempt failed, registering the profile then retrying"
    Register-Profile
    if (-not (Install-Ext $EXT_ID))    { die "failed to install $EXT_ID" }
    if (-not (Install-Ext $PY_EXT_ID)) { die "failed to install $PY_EXT_ID" }
  }
  if (-not (Test-BothExt)) { die "extensions missing after install" }
  $script:STEP_EXT = $true; log "step2 extension: installed"
}

# --- step 3: Python + mpremote via uv (contained under $BLK, no PATH edits, no system python) ---
function Step-Python {
  if ((Test-Path $ENVPY) -and ((& $ENVPY -m mpremote version 2>$null) -match $MPREMOTE_VERSION)) {
    $script:STEP_PY = $true; log "step3 python: mpremote $MPREMOTE_VERSION present, skip"; return
  }
  $uv = Join-Path $BLK "uv\uv.exe"
  if ((-not (Test-Path $uv)) -or (-not ((& $uv --version 2>$null) -match $UV_VERSION))) {
    log "step3 python: installing uv $UV_VERSION (contained, no PATH edits)"
    $env:UV_UNMANAGED_INSTALL = (Join-Path $BLK "uv")
    powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/$UV_VERSION/install.ps1 | iex"
  }
  if (-not (Test-Path $uv)) { die "uv binary missing after install" }
  # Contained interpreter: install under $BLK, force the venv onto the managed interpreter (not a
  # system/py-launcher python), and keep uv from writing shims elsewhere.
  $env:UV_PYTHON_INSTALL_DIR = (Join-Path $BLK "python")
  log "step3 python: provisioning Python $PYTHON_SERIES + mpremote $MPREMOTE_VERSION"
  & $uv python install --no-bin $PYTHON_SERIES
  & $uv venv (Join-Path $BLK "env") --managed-python --python $PYTHON_SERIES
  & $uv pip install --python $ENVPY "mpremote==$MPREMOTE_VERSION"
  if (-not ((& $ENVPY -m mpremote version 2>$null) -match $MPREMOTE_VERSION)) { die "mpremote verify failed" }
  $script:STEP_PY = $true; log "step3 python: ready ($ENVPY)"
}

# --- step 4: branded profile settings (mechanism A: per-profile settings.json) ---
function Merge-Settings($target) {
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  $s = $null
  if (Test-Path $target) { try { $s = Get-Content $target -Raw | ConvertFrom-Json } catch { $s = $null } }
  if ($null -eq $s) { $s = [pscustomobject]@{} }
  $s | Add-Member -Force -NotePropertyName "mpyhw.pythonPath"     -NotePropertyValue $ENVPY
  $s | Add-Member -Force -NotePropertyName "workbench.colorTheme" -NotePropertyValue $CANARY_THEME
  # Opt this dedicated profile into auto-opening the panel on every startup (the extension reads this).
  $s | Add-Member -Force -NotePropertyName "mpyhw.autoOpenPanel"  -NotePropertyValue $true
  # Hide VS Code's secondary side bar (the Agent/Chat panel, default-visible since 1.104) so the branded
  # profile opens straight to just the Blockless panel instead of also showing VS Code's chat sidebar.
  $s | Add-Member -Force -NotePropertyName "workbench.secondarySideBar.defaultVisibility" -NotePropertyValue "hidden"
  # WriteAllText (no BOM): PS 5.1's Set-Content -Encoding UTF8 prepends a BOM. VS Code tolerates it in
  # settings.json, but the clean form is what was verified working, so match it (as storage.json requires).
  [System.IO.File]::WriteAllText($target, ($s | ConvertTo-Json -Depth 20))
}
function Step-Settings {
  $loc = Get-ProfileLocation
  if (-not $loc) { log "step4: profile not registered yet, registering"; Register-Profile; $loc = Get-ProfileLocation }
  if (-not $loc) { die "could not resolve the '$PROFILE_NAME' profile location" }
  $target = Join-Path $CODE_USER "profiles\$loc\settings.json"
  if (Test-Path $target) {
    try { $cur = Get-Content $target -Raw | ConvertFrom-Json } catch { $cur = $null }
    if ($cur -and ($cur."mpyhw.pythonPath" -eq $ENVPY)) { $script:STEP_SETTINGS = $true; log "step4 settings: already applied, skip"; return }
  }
  Merge-Settings $target
  $script:STEP_SETTINGS = $true
  log "step4 settings: applied -> $target"
}

# --- final: drop the user straight into the Blockless profile ---
# This must be a FRESH extension host so it loads the extension we just installed: a VS Code instance
# already running (e.g. the one Register-Profile spun up) will NOT pick up a newly-installed extension,
# so `--new-window` would merely attach to that stale host and the Blockless panel would never activate.
# On a machine where the user had no VS Code open when we started, close whatever we launched and wait
# for it to fully exit, then launch clean. If the user already had VS Code running, respect their
# session and just open a window (--new-window for parity with macOS open_blockless).
function Open-Blockless {
  log "opening the Blockless profile"
  if (-not $script:USER_HAD_CODE) { Stop-CodeAndWait }
  Start-Process -FilePath $script:CODE -ArgumentList '--profile', $PROFILE_NAME, '--new-window'
  # NOTE: do NOT try to force activation with `code --open-url vscode://<ext>/...` -- VS Code shows an
  # "Allow '<extension>' to open this URI?" confirmation dialog, which defeats auto-open (needs a click).
  # The panel auto-opens on its own via the extension's onStartupFinished activation once the profile is
  # registered offline (Register-ProfileOffline) so the extension is enumerated in the window's initial
  # startup batch. This is reliable on real machines; the only environment observed to lose the startup
  # enumeration race is the artificially slow, elevated Windows Sandbox VM.
}

# --- main ---
New-Item -ItemType Directory -Force -Path $DL, $LOGS | Out-Null
# Did the USER already have VS Code open before we touched anything? If so we must never kill it; if not,
# we own every instance we spawn and can freely restart it so the final window is a clean extension host.
$script:USER_HAD_CODE = [bool](Get-Process -Name "Code" -ErrorAction SilentlyContinue)
Read-PriorState
Step-VSCode;    Write-State
Step-Extension; Write-State
Step-Python;    Write-State
Step-Settings;  Write-State
log "setup complete. run verify-blockless.ps1 to check."
Open-Blockless
