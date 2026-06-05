# DEPRECATED for normal local dev — use dev-up.ps1, which brings up Postgres and starts the
# API as a DETACHED daemon (via api-daemon.ps1) that survives VS Code closing. This script
# remains only as a minimal FOREGROUND launcher: it loads mpyhw-api/.env into the process
# env, then runs uvicorn in the foreground (dies with the shell / VS Code). No Postgres mgmt.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=][^=]*?)\s*=\s*(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }
}
Set-Location $root
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
