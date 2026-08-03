#!/usr/bin/env pwsh
# Blockless uninstaller (Windows). Mirror of scripts/macos/uninstall-blockless.zsh. Removes:
#   1. the "Blockless" VS Code profile (profile dir + its storage.json entry)
#   2. the contained runtime under %LOCALAPPDATA%\Blockless (uv, python, env, downloads, logs, state)
# VS Code and its OTHER profiles are left alone by default. VS Code is removed ONLY when the installer
# recorded that it installed it (state.json vscodeInstalledByUs) -- never a user's pre-existing editor.
# -All forces removal, -KeepVSCode prevents it. The shared VS Code user data (%APPDATA%\Code) is never
# touched. (Windows Sandbox discards state on close, so this is mainly the real-user uninstaller.)
#
#   .\uninstall-blockless.ps1              # VS Code removed only if we installed it
#   .\uninstall-blockless.ps1 -All         # also force-remove VS Code
#   .\uninstall-blockless.ps1 -KeepVSCode  # never remove VS Code
[CmdletBinding()]
param([switch]$All, [switch]$KeepVSCode)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$PROFILE_NAME = "Blockless"
$BLK        = Join-Path $env:LOCALAPPDATA "Blockless"
$STATE      = Join-Path $BLK "state.json"
$CODE_USER  = Join-Path $env:APPDATA "Code\User"
$STORAGE    = Join-Path $CODE_USER "globalStorage\storage.json"
$VSCODE_DIR = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code"

function log($m) { Write-Host "[blockless-uninstall] $m" }

# Read BEFORE we delete $BLK: did the installer install VS Code?
$installedByUs = $false
if (Test-Path $STATE) {
  try { $st = Get-Content $STATE -Raw | ConvertFrom-Json; if ($st.vscodeInstalledByUs) { $installedByUs = $true } } catch {}
}

# 1. Remove the Blockless profile: its dir + its storage.json entry (so no orphan lingers in the
# picker). -Depth 100 avoids truncating the (deeply nested) storage.json on the JSON round-trip.
$loc = ""
if (Test-Path $STORAGE) {
  try {
    $d = Get-Content $STORAGE -Raw | ConvertFrom-Json
    $p = $d.userDataProfiles | Where-Object { $_.name -eq $PROFILE_NAME } | Select-Object -First 1
    if ($p) { $loc = [string]$p.location }
    if ($d.PSObject.Properties.Name -contains "userDataProfiles") {
      $d.userDataProfiles = @($d.userDataProfiles | Where-Object { $_.name -ne $PROFILE_NAME })
      ($d | ConvertTo-Json -Depth 100) | Set-Content -Path $STORAGE -Encoding UTF8
      log "removed '$PROFILE_NAME' from storage.json"
    }
  } catch { log "could not edit storage.json; the profile entry may remain in the picker" }
}
if ($loc) {
  $pdir = Join-Path $CODE_USER "profiles\$loc"
  if (Test-Path $pdir) { Remove-Item -Recurse -Force $pdir; log "removed profile directory ($loc)" }
}

# 2. Remove the whole contained runtime.
if (Test-Path $BLK) { Remove-Item -Recurse -Force $BLK; log "removed $BLK" } else { log "$BLK not present" }

# 3. Remove VS Code only when appropriate: -KeepVSCode never; otherwise forced (-All) or because we
# installed it. Prefer the User Setup's own uninstaller (clean); fall back to removing the folder.
$removeVSCode = $false
if ($KeepVSCode) { $removeVSCode = $false }
elseif ($All -or $installedByUs) { $removeVSCode = $true }
if ($removeVSCode -and (Test-Path $VSCODE_DIR)) {
  $unins = Join-Path $VSCODE_DIR "unins000.exe"
  if (Test-Path $unins) {
    Start-Process -FilePath $unins -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES' -Wait
    log "ran the VS Code uninstaller"
  } else {
    Remove-Item -Recurse -Force $VSCODE_DIR
    log "removed $VSCODE_DIR"
  }
  log "note: VS Code user data ($CODE_USER) is left intact; delete it manually for a total wipe"
} else {
  log "left VS Code in place (installed-by-us=$installedByUs, -All=$($All.IsPresent), -KeepVSCode=$($KeepVSCode.IsPresent))"
}

log "done. re-run install-blockless.ps1 for a fresh setup."
