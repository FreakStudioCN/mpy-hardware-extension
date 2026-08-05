#!/usr/bin/env pwsh
# Blockless uninstaller (Windows). Mirror of scripts/macos/uninstall-blockless.zsh. Removes:
#   1. the "Blockless" VS Code profile (dir + its storage.json entry) -- ONLY when the installer
#      recorded creating it (state.json profileCreatedByUs), never a user's pre-existing profile that
#      merely shares the name
#   2. the contained runtime under %LOCALAPPDATA%\Blockless (uv, python, env, downloads, logs, state)
# VS Code and its OTHER profiles are left alone by default. VS Code is removed ONLY when the installer
# recorded that it installed it (state.json vscodeInstalledByUs) -- never a user's pre-existing editor.
# -All forces removal, -KeepVSCode prevents it. The shared VS Code user data (%APPDATA%\Code) is never
# touched. Requires VS Code to be closed. (Windows Sandbox discards state on close, so this is mainly
# the real-user uninstaller.)
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

# Read state BEFORE any deletion ($BLK holds state.json). We only remove what the installer recorded
# creating: VS Code iff vscodeInstalledByUs, the profile iff profileCreatedByUs -- never a user's
# pre-existing editor or a "Blockless" profile that already existed. profileLocation is the installer-
# journaled on-disk id, so the delete target is never derived from the user-writable storage.json.
$installedByUs = $false; $profileCreatedByUs = $false; $profileLocation = ""
if (Test-Path $STATE) {
  try {
    $st = Get-Content $STATE -Raw | ConvertFrom-Json
    if ($st.vscodeInstalledByUs) { $installedByUs = $true }
    if ($st.profileCreatedByUs) { $profileCreatedByUs = $true }
    if ($st.profileLocation) { $profileLocation = [string]$st.profileLocation }
  } catch {}
}

# A running VS Code holds storage.json in memory and would clobber our edit; removing $BLK now would
# also drop state.json before a re-run could finish the profile cleanup. So if VS Code is running, do
# NOTHING and ask the user to quit it and re-run -- a clean all-or-nothing uninstall.
if (Get-Process -Name "Code" -ErrorAction SilentlyContinue) {
  log "VS Code is running; quit it and re-run to uninstall. Nothing was removed."
  exit 0
}

# 1. Remove the branded profile -- ONLY if this installer created it (never a user's own).
if (-not $profileCreatedByUs) {
  log "leaving the '$PROFILE_NAME' profile in place (not created by this installer, or state.json already gone); remove it from VS Code's picker manually if you want it gone"
} else {
  # Drop the profile's entry so no orphan lingers in the picker. Atomic + BOM-free + depth-100 write
  # (temp then rename), matching the installer's Write-StorageAtomic. Skip a corrupt/unreadable file.
  $entryRemoved = $true
  if (Test-Path $STORAGE) {
    try {
      $d = Get-Content $STORAGE -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($d.PSObject.Properties.Name -contains "userDataProfiles") {
        $d.userDataProfiles = @($d.userDataProfiles | Where-Object { $_.name -ne $PROFILE_NAME })
        $tmp = "$STORAGE.tmp"
        [System.IO.File]::WriteAllText($tmp, ($d | ConvertTo-Json -Depth 100))
        Move-Item -LiteralPath $tmp -Destination $STORAGE -Force
        log "removed '$PROFILE_NAME' from storage.json"
      }
    } catch { $entryRemoved = $false; log "could not edit storage.json ($($_.Exception.Message))" }
  }
  if (-not $entryRemoved) {
    # ABORT before deleting anything: removing the profile dir now would orphan a registered profile
    # with no backing dir, and removing $BLK (below) would destroy state.json -- the ownership journal
    # a re-run needs to finish the job. Leave everything intact and stop.
    log "could not remove '$PROFILE_NAME' from storage.json (corrupt or unwritable). Leaving the profile and the contained runtime intact so a re-run can finish after you fix storage.json. Nothing was removed."
    exit 1
  }
  # Entry gone (or storage.json absent): safe to remove the profile dir. profileLocation is installer-
  # journaled, still allowlisted to VS Code's id shape before a recursive delete. -LiteralPath disables
  # globbing so "." / "*" cannot escape to sibling profiles.
  $loc = $profileLocation
  if ($loc -and ($loc -match '^[A-Za-z0-9_-]+$')) {
    $pdir = Join-Path $CODE_USER "profiles\$loc"
    if (Test-Path -LiteralPath $pdir) {
      try { Remove-Item -Recurse -Force -LiteralPath $pdir; log "removed profile directory ($loc)" }
      catch {
        # Same class as the storage.json abort: if the dir will not delete, do NOT remove $BLK
        # (state.json) below, or a re-run loses the ownership journal and refuses to clean the leftover
        # dir. Stop.
        log "could not remove profile directory ($loc): $($_.Exception.Message). Leaving the contained runtime intact so a re-run keeps the ownership journal. Nothing else was removed."
        exit 1
      }
    }
  } elseif ($loc) {
    log "refusing to delete a suspicious profile location ($loc); remove it manually if needed"
  }
}

# 2. Remove the whole contained runtime. A file here can be locked (a running mpremote/python holds
# env\Scripts\python.exe); under ErrorActionPreference=Stop that would abort the whole script before
# VS Code removal below. Catch it, tell the user to close the tools, and continue.
if (Test-Path $BLK) {
  try { Remove-Item -Recurse -Force $BLK; log "removed $BLK" }
  catch { log "could not fully remove $BLK ($($_.Exception.Message)); if a file is in use, close VS Code and any running Python/mpremote, then re-run. Continuing." }
} else {
  log "$BLK not present"
}

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
