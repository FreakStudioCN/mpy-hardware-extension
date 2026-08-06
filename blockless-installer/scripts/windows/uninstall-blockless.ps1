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
  # Fail CLOSED: state.json exists, so it must be readable AND complete or we cannot know what we own.
  # An unreadable or corrupt journal must NOT read as "not ours" -- section 2 would then delete $BLK and
  # destroy a recoverable ownership journal while the profile survives. Do NOT swallow the read error.
  try { $st = Get-Content $STATE -Raw -ErrorAction Stop | ConvertFrom-Json }
  catch {
    log "state.json exists but is unreadable or corrupt; cannot determine what to remove. Fix it, or delete '$BLK' manually, then re-run. Nothing was removed."
    exit 1
  }
  if ($null -eq $st.PSObject.Properties['profileCreatedByUs']) {
    log "state.json is missing expected fields (incomplete/corrupt); cannot determine what to remove. Fix it, or delete '$BLK' manually, then re-run. Nothing was removed."
    exit 1
  }
  if ($st.vscodeInstalledByUs) { $installedByUs = $true }
  if ($st.profileCreatedByUs) { $profileCreatedByUs = $true }
  if ($st.profileLocation) { $profileLocation = [string]$st.profileLocation }
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
  # Attempt both removals (storage.json entry, then the profile dir) best-effort, then apply ONE
  # invariant guard before section 2 removes $BLK (which holds state.json, the ownership journal):
  # never destroy the journal while any owned profile artifact survives, or a re-run loses ownership
  # and can never finish. The guard checks what actually REMAINS rather than trusting each command's
  # result, so a single check covers every failure mode (corrupt/locked/unwritable storage.json, a dir
  # Remove-Item that could not complete, etc.). storage.json writes are atomic + BOM-free (temp + rename).
  if (Test-Path $STORAGE) {
    try {
      $d = Get-Content $STORAGE -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($d.PSObject.Properties.Name -contains "userDataProfiles") {
        $d.userDataProfiles = @($d.userDataProfiles | Where-Object { $_.name -ne $PROFILE_NAME })
        $tmp = "$STORAGE.tmp"
        [System.IO.File]::WriteAllText($tmp, ($d | ConvertTo-Json -Depth 100))
        Move-Item -LiteralPath $tmp -Destination $STORAGE -Force
      }
    } catch { log "could not edit storage.json ($($_.Exception.Message))" }
  }
  # profileLocation is installer-journaled, allowlisted to VS Code's id shape; -LiteralPath disables
  # globbing so "." / "*" / traversal from a tampered journal cannot escape to sibling profiles.
  $pdir = if ($profileLocation -match '^[A-Za-z0-9_-]+$') { Join-Path $CODE_USER "profiles\$profileLocation" } else { $null }
  if ($pdir) {
    if (Test-Path -LiteralPath $pdir) { try { Remove-Item -Recurse -Force -LiteralPath $pdir } catch { log "could not remove profile directory ($profileLocation): $($_.Exception.Message)" } }
  } elseif ($profileLocation) {
    log "refusing to delete a suspicious profile location ($profileLocation); remove it manually if needed"
  }

  # Invariant guard: is any owned artifact still present? If so, stop before touching the journal.
  $entryPresent = $false
  if (Test-Path $STORAGE) {
    try { $chk = Get-Content $STORAGE -Raw -ErrorAction Stop | ConvertFrom-Json
          if ($chk.userDataProfiles | Where-Object { $_.name -eq $PROFILE_NAME }) { $entryPresent = $true } }
    catch { $entryPresent = $true }   # cannot read it => cannot confirm it is gone => treat as present
  }
  $dirPresent = [bool]($pdir -and (Test-Path -LiteralPath $pdir))
  if ($entryPresent -or $dirPresent) {
    log "could not fully remove the '$PROFILE_NAME' profile (storage.json entry present=$entryPresent, directory present=$dirPresent); it is likely corrupt, locked, or unwritable. Leaving the contained runtime and the ownership journal (state.json) intact so a re-run can finish. Nothing else was removed."
    exit 1
  }
  log "removed the '$PROFILE_NAME' profile (storage.json entry + directory)"
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
