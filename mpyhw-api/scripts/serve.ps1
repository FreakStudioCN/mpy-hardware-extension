# Launch mpyhw-api live against real DeepSeek.
# Loads secrets from mpyhw-api/.env into the process env, then starts uvicorn.
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
