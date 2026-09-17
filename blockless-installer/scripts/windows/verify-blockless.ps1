#!/usr/bin/env pwsh
# Blockless installer -- M0 acceptance check (Windows). Read-only. Prints one PASS/FAIL line per
# assertion and exits non-zero if any fail. Mirror of scripts/macos/verify-blockless.zsh.

$PROFILE_NAME     = "Blockless"
$EXT_ID           = "blockless.mpy-hardware-extension"
$PY_EXT_ID        = "ms-python.python"
$PYLANCE_ID       = "ms-python.vscode-pylance"
$MPREMOTE_VERSION = "1.28.0"

$BLK       = Join-Path $env:LOCALAPPDATA "Blockless"
$STATE     = Join-Path $BLK "state.json"
$CODE_USER = Join-Path $env:APPDATA "Code\User"
$STORAGE   = Join-Path $CODE_USER "globalStorage\storage.json"
$ENVPY     = Join-Path $BLK "env\Scripts\python.exe"

$script:fails = 0
function pass($m) { Write-Host "PASS: $m" }
function fail($m) { Write-Host "FAIL: $m"; $script:fails++ }

# Every external invocation in this script goes through here, and it exists for
# one reason: `&` on a path that EXISTS but is not a runnable PE raises
# ApplicationFailedException, which is STATEMENT-TERMINATING. PowerShell then
# abandons the whole if/else around the call, so neither pass nor fail runs,
# $script:fails is never incremented, and this script prints ALL PASS and exits 0
# having silently dropped an assertion. A present-but-unrunnable
# env\Scripts\python.exe is exactly what a half-finished or corrupted install
# looks like, so the check most likely to matter is the one that vanished.
# Returning $null instead makes every such check fail closed.
function invoke_tool([string]$exe, [string[]]$toolArgs) {
  try { return (& $exe @toolArgs 2>$null) } catch { return $null }
}

$CODE = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"

# 1. VS Code CLI runnable
$codeVersion = if (Test-Path $CODE) { invoke_tool $CODE @("--version") } else { $null }
if ($codeVersion) {
  pass "VS Code CLI ($(@($codeVersion)[0]))"
} else { fail "VS Code CLI not runnable"; $CODE = "" }

# 2. all three extensions in the branded profile
if ($CODE) {
  $list = invoke_tool $CODE @("--profile", $PROFILE_NAME, "--list-extensions")
  if (($list -contains $EXT_ID) -and ($list -contains $PY_EXT_ID) -and ($list -contains $PYLANCE_ID)) {
    pass "extensions in profile '$PROFILE_NAME' (blockless + python + pylance)"
  } else { fail "extensions missing in profile '$PROFILE_NAME' (need blockless + python + pylance)" }
} else { fail "extension check skipped (no code CLI)" }

# 3. python env has the pinned mpremote
if ((Test-Path $ENVPY) -and ((invoke_tool $ENVPY @("-m", "mpremote", "version")) -match $MPREMOTE_VERSION)) {
  pass "mpremote $MPREMOTE_VERSION in env"
} else { fail "mpremote $MPREMOTE_VERSION not found (envPython='$ENVPY')" }

# 3b. the env's BASE interpreter is contained under $BLK (not a system / py-launcher python).
# pyvenv.cfg's `home` is the base interpreter dir; if it points outside $BLK, uninstall-by-deleting-
# one-folder breaks. This is the guard for the --managed-python pin.
$cfg = Join-Path $BLK "env\pyvenv.cfg"
$baseHome = ""
if (Test-Path $cfg) {
  $m = Select-String -Path $cfg -Pattern '^home\s*=\s*(.+)$' | Select-Object -First 1
  if ($m) { $baseHome = $m.Matches[0].Groups[1].Value.Trim() }
}
# Require an exact match or a real path boundary ($BLK\...), not a bare prefix (which would also accept
# a sibling like "${BLK}-foreign\python"). OrdinalIgnoreCase because Windows paths are case-insensitive,
# so a casing difference between the resolved home and $BLK is the same directory, not a breach.
$sep = [IO.Path]::DirectorySeparatorChar
if ($baseHome -and ($baseHome.Equals($BLK, [StringComparison]::OrdinalIgnoreCase) -or $baseHome.StartsWith("$BLK$sep", [StringComparison]::OrdinalIgnoreCase))) {
  pass "env base interpreter is contained ($baseHome)"
} else { fail "env base interpreter NOT contained (home='$baseHome', expected under $BLK)" }

# resolve the profile settings target once (mechanism A); the on-disk location is journaled in state.json
$loc = ""
if (Test-Path $STATE) { try { $loc = [string]((Get-Content $STATE -Raw | ConvertFrom-Json).profileLocation) } catch {} }
$target = if ($loc) { Join-Path $CODE_USER "profiles\$loc\settings.json" } else { "" }
$set = $null
if ($target -and (Test-Path $target)) { try { $set = Get-Content $target -Raw | ConvertFrom-Json } catch {} }

# 4. settings carry our pythonPath pointing at a real exe
if ($set -and ($set."mpyhw.pythonPath" -eq $ENVPY) -and (Test-Path $ENVPY)) {
  pass "mpyhw.pythonPath set in profile settings and points at a real exe"
} else { fail "mpyhw.pythonPath wrong/missing (target='$target')" }

# 4b. the profile opts into auto-opening the panel
if ($set -and ($set."mpyhw.autoOpenPanel" -eq $true)) {
  pass "mpyhw.autoOpenPanel enabled in profile settings"
} else { fail "mpyhw.autoOpenPanel not enabled (target='$target')" }

# 5. state.json records every step ok
$ok = $false
if (Test-Path $STATE) {
  try { $st = Get-Content $STATE -Raw | ConvertFrom-Json
        $s = $st.steps
        $ok = ($s.vscode -and $s.extension -and $s.python -and $s.settings) } catch {}
}
if ($ok) { pass "state.json marks all four steps ok" } else { fail "state.json missing or a step is not ok" }

Write-Host "----"
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILED"; exit 1 }
