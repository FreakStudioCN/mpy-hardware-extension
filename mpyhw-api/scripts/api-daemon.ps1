# Run mpyhw-api as a background daemon that SURVIVES VS Code closing.
#
# Why this exists: serve.ps1 / dev-up.ps1 run uvicorn in the foreground, so it ends up
# inside VS Code's process tree and dies when you fully quit VS Code ("Cannot reach the
# auth API" on next launch). This launches uvicorn via WMI (Win32_Process.Create), whose
# child is parented to the WMI service instead of VS Code — so quitting VS Code no longer
# kills the API. Logs go to mpyhw-api/tmp/api.log.
#
# Postgres is NOT managed here (run dev-up.ps1 once to bring up the mpyhw-pg container; it
# survives VS Code on its own). After a full machine reboot, start PG first:
#   docker start mpyhw-pg   (or just rerun /dev-up)
#
# Usage:
#   .\scripts\api-daemon.ps1 start     # launch detached
#   .\scripts\api-daemon.ps1 stop      # kill the API
#   .\scripts\api-daemon.ps1 restart   # after you change backend code
#   .\scripts\api-daemon.ps1 status
#   .\scripts\api-daemon.ps1 logs      # tail recent output
param([ValidateSet('start','stop','restart','status','logs','worker')][string]$Action = 'start', [switch]$Stub, [switch]$DevAuth)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$root = Split-Path $scriptDir -Parent
$logDir = Join-Path $root 'tmp'
$log = Join-Path $logDir 'api.log'
$port = 8787

function Get-ApiPid {
  try { (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { $null }
}

function Stop-Api {
  $procId = Get-ApiPid
  if ($procId) { Stop-Process -Id $procId -Force; Write-Host "stopped API (pid $procId)" }
  else { Write-Host "API not running on $port" }
}

function Start-Api {
  $existing = Get-ApiPid
  if ($existing) { Write-Host "API already running on $port (pid $existing)"; return }
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  # Re-invoke THIS script's `worker` action via -File (single-level quoting, no nested
  # quotes) so the WMI CommandLine is robust to the space in the repo path. The detached
  # worker is a fresh process that does NOT inherit this shell's env, so forward stub mode
  # explicitly (passed via -Stub, or $env:MPYHW_LLM_STUB=1 set before `start`).
  $self = Join-Path $scriptDir 'api-daemon.ps1'
  $stubArg = if ($Stub -or $env:MPYHW_LLM_STUB -eq '1') { ' -Stub' } else { '' }
  $devAuthArg = if ($DevAuth -or $env:MPYHW_ENABLE_DEV_AUTH -eq '1') { ' -DevAuth' } else { '' }
  $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" worker$stubArg$devAuthArg"
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
  if ($res.ReturnValue -ne 0) { throw "Detached launch failed (Win32_Process.Create returned $($res.ReturnValue))" }
  Write-Host "API launching detached (launcher pid $($res.ProcessId)); logs -> $log"
}

switch ($Action) {
  'start'   { Start-Api }
  'stop'    { Stop-Api }
  'restart' { Stop-Api; Start-Sleep -Seconds 1; Start-Api }
  'status'  { $p = Get-ApiPid; if ($p) { "running (pid $p) on $port" } else { "stopped" } }
  'logs'    { if (Test-Path $log) { Get-Content $log -Tail 40 } else { "no log yet at $log" } }
  'worker'  {
    # Runs INSIDE the detached process. Load .env, then launch uvicorn with OS-level output
    # redirection via Start-Process. Do NOT use `python ... *>> file`: in PS 5.1 that promotes
    # uvicorn's stderr log lines to terminating NativeCommandErrors and kills the server.
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $diag = Join-Path $logDir 'api.worker.log'
    $outLog = Join-Path $logDir 'api.out.log'
    try {
      $envFile = Join-Path $root '.env'
      if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
          if ($_ -match '^\s*([^#=][^=]*?)\s*=\s*(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process') }
        }
      }
      if ($Stub) { [Environment]::SetEnvironmentVariable('MPYHW_LLM_STUB', '1', 'Process') }
      if ($DevAuth) { [Environment]::SetEnvironmentVariable('MPYHW_ENABLE_DEV_AUTH', '1', 'Process') }
      # Prefer the project venv's interpreter (mpyhw-api/.venv) so a detached launch — which
      # has no activated shell — still sees the installed deps; fall back to PATH `python`.
      $py = Join-Path $root '.venv\Scripts\python.exe'
      if (-not (Test-Path $py)) { $py = 'python' }
      Add-Content -Path $diag -Value "=== worker $PID launching uvicorn ($py) $(Get-Date -Format s) ==="
      $proc = Start-Process -FilePath $py `
        -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port',"$port" `
        -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardError $log -RedirectStandardOutput $outLog
      Add-Content -Path $diag -Value "uvicorn pid=$($proc.Id)"
      Wait-Process -Id $proc.Id
      Add-Content -Path $diag -Value "=== uvicorn exited $(Get-Date -Format s) ==="
    } catch {
      Add-Content -Path $diag -Value ("ERROR: " + $_.Exception.Message)
      Add-Content -Path $diag -Value $_.ScriptStackTrace
    }
  }
}
