param(
  [ValidateSet("ci", "e2e", "package", "reinstall", "all")]
  [string]$Mode = "ci",
  [string]$RepoRoot,
  [int]$ApiPort = 8791,
  [string]$Prompt = "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数"
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  if ($RepoRoot) { return (Resolve-Path $RepoRoot).Path }
  $here = (Get-Location).Path
  if (Test-Path (Join-Path $here "mpy-hardware-extension\package.json")) { return $here }
  $parent = Split-Path $here -Parent
  if (Test-Path (Join-Path $parent "mpy-hardware-extension\package.json")) { return $parent }
  throw "Run from cursor_for_hardware repo root or pass -RepoRoot."
}

function Run-Step([string]$Name, [string]$WorkingDirectory, [scriptblock]$Body) {
  Write-Host ""
  Write-Host "== $Name =="
  Push-Location $WorkingDirectory
  try { & $Body } finally { Pop-Location }
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

function Load-EnvFile([string]$Path) {
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#=][^=]*?)\s*=\s*(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
    }
  }
}

function Reset-TestDb {
  docker exec mpyhw-pg psql -U postgres -c "DROP DATABASE IF EXISTS mpyhw_test"
  if ($LASTEXITCODE -ne 0) { throw "DROP DATABASE failed" }
  docker exec mpyhw-pg psql -U postgres -c "CREATE DATABASE mpyhw_test"
  if ($LASTEXITCODE -ne 0) { throw "CREATE DATABASE failed" }
}

function Use-CiDbEnv {
  $env:DATABASE_URL = "postgresql://postgres:mpyhw@127.0.0.1:55432/mpyhw_test"
  Remove-Item Env:\MPYHW_DAILY_GRANT -ErrorAction SilentlyContinue
  Remove-Item Env:\MPYHW_GRANT_OVERRIDES -ErrorAction SilentlyContinue
  Remove-Item Env:\MPYHW_DAILY_GLOBAL_BUDGET -ErrorAction SilentlyContinue
  Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\MPYHW_LLM_MODEL -ErrorAction SilentlyContinue
}

function Invoke-CiGate([string]$Root) {
  $api = Join-Path $Root "mpyhw-api"
  $ext = Join-Path $Root "mpy-hardware-extension"
  $shim = Join-Path $ext "python\shim"

  Reset-TestDb
  Use-CiDbEnv
  Run-Step "API pytest" $api { python -m pytest }

  Run-Step "extension build" $ext { npm run build }

  Reset-TestDb
  $env:DATABASE_URL = "postgresql://postgres:mpyhw@127.0.0.1:55432/mpyhw_test"
  $env:MPYHW_REQUIRE_CONTRACT_TESTS = "1"
  Run-Step "extension npm test" $ext { npm test }
  Run-Step "V0 protocol smoke" $ext { npm run test:v0 }
  Run-Step "typecheck" $ext { npm run typecheck }
  Run-Step "shim pytest" $shim { python -m pytest }
}

function Start-E2eApi([string]$Root) {
  $api = Join-Path $Root "mpyhw-api"
  $tmp = Join-Path $api "tmp"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $out = Join-Path $tmp "api-e2e-$ApiPort.out.log"
  $err = Join-Path $tmp "api-e2e-$ApiPort.err.log"
  $pidFile = Join-Path $tmp "api-e2e-$ApiPort.pid"
  Remove-Item $out,$err,$pidFile -ErrorAction SilentlyContinue
  Load-EnvFile (Join-Path $api ".env")
  $p = Start-Process -FilePath "python.exe" `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$ApiPort") `
    -WorkingDirectory $api -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  $p.Id | Set-Content -Path $pidFile -Encoding ascii
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/v1/health" -TimeoutSec 1
      if ($r.status -eq "ok") {
        Write-Host "API ready on $ApiPort mode=$($r.mode) llm_configured=$($r.llm_configured)"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  Get-Content -Path $err -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue
  throw "API $ApiPort did not become healthy."
}

function Invoke-LiveE2e([string]$Root) {
  $api = Join-Path $Root "mpyhw-api"
  $ext = Join-Path $Root "mpy-hardware-extension"
  $tmp = Join-Path $ext "tmp"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  Start-E2eApi $Root
  Load-EnvFile (Join-Path $api ".env")
  $env:MPYHW_API_BASE = "http://127.0.0.1:$ApiPort"
  Push-Location $api
  try {
    $env:MPYHW_DEV_JWT = python -c "from app.auth import mint_session; print(mint_session({'id':'e2e','login':'e2e','email':None}))"
  } finally {
    Pop-Location
  }
  if (-not $env:MPYHW_DEV_JWT) { throw "failed to mint MPYHW_DEV_JWT" }

  $out = Join-Path $tmp "e2e-v0-live-$ApiPort.out.log"
  $err = Join-Path $tmp "e2e-v0-live-$ApiPort.err.log"
  $pidFile = Join-Path $tmp "e2e-v0-live-$ApiPort.pid"
  Remove-Item $out,$err,$pidFile -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath "node.exe" `
    -ArgumentList @("--no-warnings", "--experimental-strip-types", "src/cli/e2e-protocol-v0.ts", $Prompt) `
    -WorkingDirectory $ext -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  $p.Id | Set-Content -Path $pidFile -Encoding ascii
  Write-Host "e2e pid=$($p.Id)"

  while (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 30
    Get-Content -Path $out -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue
  }
  Write-Host ""
  Write-Host "== e2e stdout tail =="
  Get-Content -Path $out -Tail 160 -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "== e2e stderr tail =="
  Get-Content -Path $err -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue
  $text = Get-Content -Path $out -Raw -Encoding UTF8
  if ($text -notmatch "E2E-V0-FULLSTACK:\s+PASS") {
    throw "Live e2e did not report PASS. See $out and $err."
  }
}

function Invoke-Package([string]$Root) {
  $ext = Join-Path $Root "mpy-hardware-extension"
  Run-Step "package VSIX" $ext { npm run package }
}

function Invoke-Reinstall([string]$Root) {
  Invoke-Package $Root
  $vsix = Join-Path $Root "mpy-hardware-extension\build\mpy-hardware-extension.vsix"
  if (-not (Test-Path $vsix)) { throw "VSIX not found: $vsix" }
  code --install-extension $vsix --force
  if ($LASTEXITCODE -ne 0) { throw "VS Code extension install failed" }
}

$root = Resolve-RepoRoot
Write-Host "repo=$root"

switch ($Mode) {
  "ci" { Invoke-CiGate $root; Invoke-Package $root }
  "e2e" { Invoke-LiveE2e $root }
  "package" { Invoke-Package $root }
  "reinstall" { Invoke-Reinstall $root }
  "all" { Invoke-CiGate $root; Invoke-LiveE2e $root; Invoke-Reinstall $root }
}
