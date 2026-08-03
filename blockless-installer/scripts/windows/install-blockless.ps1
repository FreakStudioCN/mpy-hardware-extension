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

$ErrorActionPreference = "Stop"
# Cmdlet errors (a failed download etc.) stop the script; native-command exit codes must NOT throw,
# because the extension-install fallback and the "skip if already present" checks rely on inspecting
# $LASTEXITCODE / output of commands that are *expected* to fail sometimes (PS 7.4+ default is $true).
$PSNativeCommandUseErrorActionPreference = $false

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

function log($m) { Write-Host "[blockless] $m" }
function die($m) { Write-Host "[blockless] ERROR: $m" -ForegroundColor Red; exit 1 }

# Resolve the `code` CLI explicitly -- never trust PATH on a fresh machine.
function Resolve-Code {
  $c = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"
  if (Test-Path $c) { $script:CODE = $c; return $true }
  return $false
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

# A new profile only appears in storage.json after VS Code is launched with it (a headless
# --install-extension into a missing profile fails). Launch it, poll for registration, then close it
# if we were the ones who started VS Code (never quit a user's session). Fully hiding the launch is
# left to installer-core; this just avoids a lingering window.
function Register-Profile {
  if (Test-ProfileRegistered) { return }
  $wasRunning = [bool](Get-Process -Name "Code" -ErrorAction SilentlyContinue)
  Start-Process -FilePath $script:CODE -ArgumentList '--profile', $PROFILE_NAME, '--new-window'
  for ($i = 0; $i -lt 60; $i++) { if (Test-ProfileRegistered) { break }; Start-Sleep -Milliseconds 500 }
  if (-not $wasRunning) { Get-Process -Name "Code" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
}

# --- step 1: VS Code (User Setup, silent, no admin) ---
function Step-VSCode {
  if ((Resolve-Code) -and (& $script:CODE --version 2>$null)) {
    $script:VSCODE_PRODUCT_VERSION = (& $script:CODE --version | Select-Object -First 1)
    $script:STEP_VSCODE = $true; log "step1 VS Code: present ($($script:VSCODE_PRODUCT_VERSION)), skip"; return
  }
  log "step1 VS Code: installing"
  New-Item -ItemType Directory -Force -Path $DL | Out-Null
  $meta = Invoke-RestMethod "https://update.code.visualstudio.com/api/update/$VSCODE_PLATFORM/stable/latest"
  if (-not $meta.url -or -not $meta.sha256hash) { die "could not parse VS Code download metadata" }
  $exe = Join-Path $DL "VSCodeUserSetup.exe"
  Invoke-WebRequest $meta.url -OutFile $exe
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
  & $script:CODE --profile $PROFILE_NAME --install-extension $id --force *> $null
  if ($LASTEXITCODE -eq 0) { return $true }
  if (($id -eq $EXT_ID) -and $Vsix -and (Test-Path $Vsix)) {
    log "step2: marketplace failed for $id, using bundled vsix"
    & $script:CODE --profile $PROFILE_NAME --install-extension $Vsix --force *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}
function Step-Extension {
  if (Test-BothExt) { $script:STEP_EXT = $true; log "step2 extension: present, skip"; return }
  log "step2 extension: installing into profile '$PROFILE_NAME'"
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
  ($s | ConvertTo-Json -Depth 20) | Set-Content -Path $target -Encoding UTF8
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
function Open-Blockless {
  log "opening the Blockless profile"
  Start-Process -FilePath $script:CODE -ArgumentList '--profile', $PROFILE_NAME
}

# --- main ---
New-Item -ItemType Directory -Force -Path $DL, $LOGS | Out-Null
Step-VSCode;    Write-State
Step-Extension; Write-State
Step-Python;    Write-State
Step-Settings;  Write-State
log "setup complete. run verify-blockless.ps1 to check."
Open-Blockless
