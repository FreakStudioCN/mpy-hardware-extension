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
$PROFILE_LOCATION = "blockless"             # the on-disk profiles/<loc> id we seed for our profile
$EXT_ID           = "blockless.mpy-hardware-extension"
$PY_EXT_ID        = "ms-python.python"
# Pylance ships as an extensionDependency of ms-python.python (VS Code auto-installs it). verify asserts
# all three, so the install idempotency check must require all three too, else a re-run skips step 2
# forever while verify fails permanently (no repair path).
$PYLANCE_ID       = "ms-python.vscode-pylance"
$UV_VERSION       = "0.11.29"
# sha256 of the version-pinned uv install script. We download it, verify this digest, then run it,
# rather than piping `irm | iex`: a compromised astral.sh response would otherwise be arbitrary code
# execution as the installing user. (installer-core pins the uv binary itself; this is the equivalent.)
$UV_INSTALL_SHA256 = "d40be32be5121f25fd433cdc5786549b53aad072947674c2818a9c31a7912b4d"
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
$script:WE_STARTED_CODE = $false          # did WE spawn a VS Code this run? only such instances may be torn down
$script:OUR_CODE_PIDS = @()               # the exact Code.exe PIDs we spawned; only these may be closed
# Did THIS installer create the branded profile (vs adopt a user's pre-existing profile of the same
# name)? The uninstaller only deletes the profile dir when this is true, so it never destroys a user's
# own "Blockless" profile.
$script:PROFILE_CREATED_BY_US = $false
# sha256 of the VSIX our extension was installed from. Recorded so a re-run reinstalls when the bundled
# build changes, and so a stale Marketplace build of the same version number is never mistaken for ours.
$script:VSIX_SHA256 = ""; $script:EXT_VSIX_SHA256 = ""; $script:PRIOR_EXT_VSIX_SHA256 = ""

function log($m) { Write-Host "[blockless] $m" }
function die($m) { Write-Host "[blockless] ERROR: $m" -ForegroundColor Red; exit 1 }

# PS 5.1's Invoke-WebRequest/RestMethod have no -MaximumRetryCount (that's PS 6+), so wrap a manual
# retry to match the macOS `curl --retry 3` -- every download is retried before the install aborts.
function Invoke-WithRetry([scriptblock]$op) {
  for ($n = 1; $n -le 3; $n++) {
    try { return & $op } catch { if ($n -eq 3) { throw }; Start-Sleep -Seconds 2 }
  }
}

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
  # Preserve "we created the profile" across re-runs: on a repair run the profile already exists (WE
  # made it last time), so without this the current run would record false and the uninstaller would
  # then refuse to remove a profile it should own.
  if ($st.profileCreatedByUs) { $script:PROFILE_CREATED_BY_US = $true }
  if ($st.extVsixSha256) {
    $script:PRIOR_EXT_VSIX_SHA256 = [string]$st.extVsixSha256
    # Carry it forward so the incremental Write-State before step 2 does not transiently blank it.
    $script:EXT_VSIX_SHA256 = [string]$st.extVsixSha256
  }
}

function Write-State {
  New-Item -ItemType Directory -Force -Path $BLK | Out-Null
  $s = [ordered]@{
    productVersion      = $script:VSCODE_PRODUCT_VERSION
    vscodeInstalledByUs = $script:VSCODE_INSTALLED_BY_US
    profileCreatedByUs  = $script:PROFILE_CREATED_BY_US
    profileLocation     = $PROFILE_LOCATION
    steps               = [ordered]@{ vscode = $script:STEP_VSCODE; extension = $script:STEP_EXT; python = $script:STEP_PY; settings = $script:STEP_SETTINGS }
    mpremoteVersion     = $MPREMOTE_VERSION
    envPython           = $ENVPY
    extVsixSha256       = $script:EXT_VSIX_SHA256
    settingsMechanism   = "A"
    updatedAt           = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  ($s | ConvertTo-Json -Depth 5) | Set-Content -Path $STATE -Encoding UTF8
}

# Atomic, BOM-free JSON write for storage.json (VS Code's global state). WriteAllText in place would
# truncate the whole file if interrupted mid-write; write a temp then rename (Move-Item -Force is a
# same-volume rename on NTFS). Depth 100 preserves VS Code's deeply nested window state -- the install
# and uninstall paths MUST use the same depth or one flattens state the other keeps.
function Write-StorageAtomic($obj) {
  $tmp = "$STORAGE.tmp"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 100))
  Move-Item -LiteralPath $tmp -Destination $STORAGE -Force
}

# --- profile helpers (PowerShell has native JSON, so no python is needed for this) ---
function Get-ProfileLocation {
  if (-not (Test-Path $STORAGE)) { return "" }
  try { $d = Get-Content $STORAGE -Raw | ConvertFrom-Json } catch { return "" }
  $p = $d.userDataProfiles | Where-Object { $_.name -eq $PROFILE_NAME } | Select-Object -First 1
  if ($p) { return [string]$p.location } else { return "" }
}
function Test-ProfileRegistered { return [bool](Get-ProfileLocation) }

function Get-CodePids { @(Get-Process -Name "Code" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }

# Close ONLY the VS Code processes WE spawned this run (tracked in $script:OUR_CODE_PIDS), never every
# Code.exe on the machine -- a global `taskkill /IM Code.exe` would close the user's own windows and the
# force fallback would discard their unsaved work, and worse, it fires on a STALE decision (a session the
# user opened after our initial check). Two things still matter:
#  * GRACEFUL close first. `taskkill /PID` WITHOUT /F posts WM_CLOSE so Electron saves its window/profile
#    state (the macOS installer gets this from `osascript quit`). Without the save, the next cold
#    `code --profile Blockless` launch falls back to the DEFAULT profile and the panel never appears.
#    Force-kill (ours only) is the last resort if graceful close does not take.
#  * WAIT to zero (ours). A running extension host won't load a newly-installed extension, so the final
#    launch must be a fresh instance; we wait for the ones we started to fully exit.
function Stop-OurCode {
  if (-not $script:OUR_CODE_PIDS) { return }
  foreach ($procId in $script:OUR_CODE_PIDS) { taskkill /PID $procId *> $null }   # graceful WM_CLOSE, state saved
  for ($i = 0; $i -lt 60; $i++) {
    if (-not @($script:OUR_CODE_PIDS | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) { break }
    Start-Sleep -Milliseconds 250
  }
  foreach ($procId in $script:OUR_CODE_PIDS) {   # last resort, ours only
    Get-Process -Id $procId -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 20; $i++) {   # confirm ours have exited so the caller's final launch is a fresh host
    if (-not @($script:OUR_CODE_PIDS | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) { break }
    Start-Sleep -Milliseconds 250
  }
  $script:OUR_CODE_PIDS = @()
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
  if (Test-Path $STORAGE) {
    # An EXISTING storage.json we can't parse OR can't read must NOT be replaced (that would wipe
    # every other profile + window state). -EA Stop makes a read failure (EACCES/lock) throw too, not
    # just a parse failure, so both skip the offline seed; Register-Profile's window fallback covers it.
    try { $d = Get-Content $STORAGE -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return }
  }
  if ($null -eq $d) { $d = [pscustomobject]@{} }   # file did not exist: start fresh
  $list = @()
  if ($d.PSObject.Properties["userDataProfiles"]) { $list = @($d.userDataProfiles) }
  $list += [pscustomobject]@{ location = "blockless"; name = $PROFILE_NAME }
  $d | Add-Member -Force -NotePropertyName "userDataProfiles" -NotePropertyValue $list
  # Atomic, BOM-free, depth-100 write (see Write-StorageAtomic): PS 5.1's `Set-Content -Encoding UTF8`
  # prepends a BOM, an in-place WriteAllText can truncate, and a shallow depth flattens VS Code state.
  Write-StorageAtomic $d
  if (Test-ProfileRegistered) { log "step2: profile '$PROFILE_NAME' registered offline (no VS Code launch)" }
}

# Fallback only (a live VS Code owns storage.json, or a future VS Code stops honoring the seeded
# entry): a new profile also appears in storage.json after VS Code is launched with it (a headless
# --install-extension into a missing profile fails). Launch it, poll for registration, then close it
# if we were the ones who started VS Code (never quit a user's session). NOTE: this path re-creates
# the half-written-state race described above Register-ProfileOffline; keep it a last resort.
function Register-Profile {
  if (Test-ProfileRegistered) { return }
  # Re-probe HERE, not once at start: the user may have opened VS Code during the minutes-long download.
  # If the user already has one open, --new-window attaches to it (spawns no new main process) and we
  # must leave it running. If nothing is running, everything alive after our launch is OURS -- record
  # exactly those PIDs so we tear down only what we started, never the user's session.
  $before = Get-CodePids
  Start-Process -FilePath $script:CODE -ArgumentList '--profile', $PROFILE_NAME, '--new-window'
  for ($i = 0; $i -lt 60; $i++) { if (Test-ProfileRegistered) { break }; Start-Sleep -Milliseconds 500 }
  if (-not $before) {
    # Caveat (narrow, inherent to VS Code's single-instance model): if the user opens VS Code during the
    # poll above while ours is up, their window is hosted inside OUR process, so closing our PID closes
    # theirs too. Not fixable by PID bookkeeping; still far better than the old global taskkill /IM.
    $script:OUR_CODE_PIDS += @(Get-CodePids)
    if ($script:OUR_CODE_PIDS) { $script:WE_STARTED_CODE = $true; Stop-OurCode }
  }
}

# --- step 1: VS Code (User Setup, silent, no admin) ---
function Step-VSCode {
  if ((Resolve-Code) -and (& $script:CODE --version 2>$null)) {
    $script:VSCODE_PRODUCT_VERSION = (& $script:CODE --version | Select-Object -First 1)
    $script:STEP_VSCODE = $true; log "step1 VS Code: present ($($script:VSCODE_PRODUCT_VERSION)), skip"; return
  }
  log "step1 VS Code: installing (downloading ~100 MB)"
  New-Item -ItemType Directory -Force -Path $DL | Out-Null
  $meta = Invoke-WithRetry { Invoke-RestMethod "https://update.code.visualstudio.com/api/update/$VSCODE_PLATFORM/stable/latest" }
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
    & $curl -fL --retry 3 --retry-delay 2 --progress-bar -o $exe $meta.url
    if ($LASTEXITCODE -ne 0) { die "VS Code download failed (curl exit $LASTEXITCODE)" }
  } else {
    Invoke-WithRetry { Invoke-WebRequest $meta.url -OutFile $exe -UseBasicParsing }   # -UseBasicParsing avoids the 5.1 IE engine
  }
  if (-not (Test-Path $exe)) { die "VS Code download failed (no file written)" }
  if ((Get-FileHash $exe -Algorithm SHA256).Hash -ne $meta.sha256hash) { die "VS Code sha256 mismatch (corrupt download)" }
  # Independently AUTHENTICATE the installer, not just its integrity. The sha256 above only matches the
  # digest the update API returned over TLS (trust-on-first-use): it catches a corrupt/MITM'd download
  # but not a compromised API response serving a malicious URL + its matching digest. Authenticode chains
  # to a trusted root independent of that response, so verify the signature and pin Microsoft before run.
  $sig = Get-AuthenticodeSignature $exe
  if ($sig.Status -ne 'Valid') { die "VS Code installer signature not Valid ($($sig.Status)); refusing to run" }
  if ($sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(,|$)') { die "VS Code installer not signed by Microsoft; refusing to run" }
  # /MERGETASKS=!runcode: install silently, do NOT auto-launch VS Code afterward.
  Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES','/MERGETASKS=!runcode' -Wait
  if (-not (Resolve-Code)) { die "VS Code CLI not found after install" }
  & $script:CODE --version *> $null
  $script:VSCODE_PRODUCT_VERSION = (& $script:CODE --version | Select-Object -First 1)
  $script:VSCODE_INSTALLED_BY_US = $true; $script:STEP_VSCODE = $true
  log "step1 VS Code: installed ($($script:VSCODE_PRODUCT_VERSION))"
}

# --- step 2: extension into the "Blockless" profile ---
function Test-Ext($id) {
  $list = & $script:CODE --profile $PROFILE_NAME --list-extensions 2>$null
  return ($list -contains $id)
}
# Our extension is "current" only if present AND installed from the exact VSIX we bundle now (matched by
# the sha256 journaled in state.json). Presence alone is not enough: a Marketplace build with the SAME
# version number but built before mpyhw.autoOpenPanel would pass an id/version check yet break auto-open,
# and verify (which checks the SETTING we write, not the build) would not catch it.
function Test-OurExtBundled {
  return ((Test-Ext $EXT_ID) -and $script:VSIX_SHA256 -and ($script:PRIOR_EXT_VSIX_SHA256 -eq $script:VSIX_SHA256))
}
function Test-AllExtCurrent {
  return ((Test-OurExtBundled) -and (Test-Ext $PY_EXT_ID) -and (Test-Ext $PYLANCE_ID))
}
function Install-Ext($id) {
  # OUR extension: install ONLY the bundled vsix -- the exact build this installer ships + verifies.
  # We deliberately do NOT fall back to the Marketplace: its 0.4.2 is an OLDER build (same version
  # number, built before mpyhw.autoOpenPanel existed), so installing it produces a broken auto-open
  # that verify cannot catch (verify checks the SETTING we write, not the extension build). A
  # missing/failed vsix must fail loudly, not silently install a broken build.
  if ($id -eq $EXT_ID) {
    if (-not ($Vsix -and (Test-Path $Vsix))) { log "step2: no bundled vsix (-Vsix) for $id; refusing the stale Marketplace build"; return $false }
    log "step2: installing $id from the bundled vsix"
    & $script:CODE --profile $PROFILE_NAME --install-extension $Vsix --force *> $null
    return ($LASTEXITCODE -eq 0)
  }
  # Marketplace-sourced dependency (ms-python.python -> also pulls Pylance).
  & $script:CODE --profile $PROFILE_NAME --install-extension $id --force *> $null
  return ($LASTEXITCODE -eq 0)
}
function Step-Extension {
  if ($Vsix -and (Test-Path $Vsix)) { $script:VSIX_SHA256 = (Get-FileHash $Vsix -Algorithm SHA256).Hash }
  # Record whether WE create the profile (vs adopt a user's pre-existing profile of the same name),
  # BEFORE we seed it. Read-PriorState may have already set this true from an earlier run of ours.
  if (($script:PROFILE_CREATED_BY_US -eq $false) -and (-not (Test-ProfileRegistered))) { $script:PROFILE_CREATED_BY_US = $true }

  if (Test-AllExtCurrent) { $script:STEP_EXT = $true; $script:EXT_VSIX_SHA256 = $script:VSIX_SHA256; log "step2 extension: present (matching bundled build), skip"; return }
  log "step2 extension: installing into profile '$PROFILE_NAME'"
  Register-ProfileOffline   # headless registration first: no window may run before the final launch
  if ((-not (Install-Ext $EXT_ID)) -or (-not (Install-Ext $PY_EXT_ID))) {
    log "step2: first attempt failed, registering the profile then retrying"
    Register-Profile
    if (-not (Install-Ext $EXT_ID))    { die "failed to install $EXT_ID" }
    if (-not (Install-Ext $PY_EXT_ID)) { die "failed to install $PY_EXT_ID" }
  }
  # Pylance ships as a dependency of ms-python.python; if it did not resolve, install it explicitly so
  # verify (which requires it) has a repair path instead of failing forever.
  if (-not (Test-Ext $PYLANCE_ID)) { if (-not (Install-Ext $PYLANCE_ID)) { die "failed to install $PYLANCE_ID" } }
  if (-not ((Test-Ext $EXT_ID) -and (Test-Ext $PY_EXT_ID) -and (Test-Ext $PYLANCE_ID))) { die "extensions missing after install" }
  $script:EXT_VSIX_SHA256 = $script:VSIX_SHA256
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
    $uvIvs = Join-Path $DL "uv-install.ps1"
    Invoke-WithRetry { Invoke-WebRequest "https://astral.sh/uv/$UV_VERSION/install.ps1" -OutFile $uvIvs -UseBasicParsing }
    if ((Get-FileHash $uvIvs -Algorithm SHA256).Hash -ne $UV_INSTALL_SHA256) { die "uv install script sha256 mismatch (refusing to run)" }
    powershell -ExecutionPolicy Bypass -File $uvIvs
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
  if (Test-Path $target) {
    # An existing settings.json we can't read/parse must NOT be clobbered down to just our keys (it may
    # hold the user's own profile settings). Refuse, matching macOS merge_settings' exit-2 behavior.
    try { $s = Get-Content $target -Raw -ErrorAction Stop | ConvertFrom-Json }
    catch { die "refusing to overwrite an unreadable settings.json at $target (fix or remove it, then re-run)" }
  } else {
    $s = [pscustomobject]@{}   # no file yet: start fresh
  }
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
    # All FOUR installer-owned keys must match, not just pythonPath, so a repair re-applies the theme,
    # autoOpenPanel, or secondarySideBar visibility if any was removed/changed (otherwise the branded
    # startup stays broken). Mirror every key Merge-Settings writes, or a repair leaves a stale profile.
    if ($cur -and ($cur."mpyhw.pythonPath" -eq $ENVPY) -and ($cur."workbench.colorTheme" -eq $CANARY_THEME) -and ($cur."mpyhw.autoOpenPanel" -eq $true) -and ($cur."workbench.secondarySideBar.defaultVisibility" -eq "hidden")) { $script:STEP_SETTINGS = $true; log "step4 settings: already applied, skip"; return }
  }
  Merge-Settings $target
  $script:STEP_SETTINGS = $true
  log "step4 settings: applied -> $target"
}

# --- final: drop the user straight into the Blockless profile ---
# This must be a FRESH extension host so it loads the extension we just installed: a VS Code instance
# already running (e.g. the one Register-Profile spun up) will NOT pick up a newly-installed extension,
# so `--new-window` would merely attach to that stale host and the Blockless panel would never activate.
# If WE spawned a VS Code this run (the Register-Profile fallback), close exactly those processes (by the
# PIDs we recorded, never a global taskkill) and wait for them to exit, then launch clean. If the user
# has their own session open, respect it and just open a window (--new-window for parity with macOS
# open_blockless) rather than killing their editor. By this point Register-Profile has usually already
# closed our instance, so Stop-OurCode is typically a no-op; it never targets a session the user opened.
function Open-Blockless {
  log "opening the Blockless profile"
  if ($script:WE_STARTED_CODE) { Stop-OurCode }
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
Read-PriorState
# Our extension is only ever installed from the bundled VSIX (never the Marketplace, see Install-Ext),
# so -Vsix is required on every run, including repairs. Fail fast here rather than after downloading
# VS Code and launching a throwaway window in step 2.
if (-not ($Vsix -and (Test-Path $Vsix))) { die "-Vsix <path> to the bundled Blockless extension is required; re-run with: -Vsix C:\path\to\mpy-hardware-extension.vsix" }
Step-VSCode;    Write-State
Step-Extension; Write-State
Step-Python;    Write-State
Step-Settings;  Write-State
log "setup complete. run verify-blockless.ps1 to check."
Open-Blockless
