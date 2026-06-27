param(
  [string]$EnvFile,
  [switch]$PlanOnly,
  [string]$ContainerName = "mpyhw-pg",
  [string]$PostgresImage = "postgres:16"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $EnvFile) {
  $EnvFile = Join-Path $root ".env"
}

function Load-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw ".env file not found: $Path"
  }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#=][^=]*?)\s*=\s*(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
    }
  }
}

function Require-Env([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not $value) {
    if ($Name -eq "DATABASE_URL") {
      throw "DATABASE_URL is required"
    }
    throw "$Name is required"
  }
  Write-Host "$Name ok"
  return $value
}

function Parse-PostgresUrl([string]$DatabaseUrl) {
  $uri = [Uri]$DatabaseUrl
  if ($uri.Scheme -ne "postgres" -and $uri.Scheme -ne "postgresql") {
    throw "DATABASE_URL must be a postgres:// or postgresql:// URL"
  }
  $user = "postgres"
  $password = ""
  if ($uri.UserInfo) {
    $parts = $uri.UserInfo.Split(":", 2)
    $user = [Uri]::UnescapeDataString($parts[0])
    if ($parts.Length -gt 1) {
      $password = [Uri]::UnescapeDataString($parts[1])
    }
  }
  if (-not $password) {
    throw "DATABASE_URL must include a Postgres password for local Docker startup"
  }
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  $database = $uri.AbsolutePath.TrimStart("/")
  if (-not $database) {
    throw "DATABASE_URL must include a database name"
  }
  return [pscustomobject]@{
    Host = $uri.Host
    Port = $port
    Database = $database
    User = $user
    Password = $password
  }
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(1000)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-TcpPort([string]$HostName, [int]$Port, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-TcpPort $HostName $Port) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for Postgres at ${HostName}:${Port}"
}

function Invoke-NativeQuiet([scriptblock]$Command) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command *> $null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

function Ensure-DockerReady() {
  if ((Invoke-NativeQuiet { docker info }) -eq 0) {
    return
  }

  $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $desktop) {
    Start-Process -FilePath $desktop -WindowStyle Hidden
  }

  for ($i = 0; $i -lt 90; $i++) {
    if ((Invoke-NativeQuiet { docker info }) -eq 0) {
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "Docker is not ready. Start Docker Desktop and rerun this script."
}

function Ensure-Postgres($Pg) {
  Write-Host "Postgres: $($Pg.Host):$($Pg.Port)/$($Pg.Database)"
  if ($PlanOnly) {
    Write-Host "Plan: ensure Docker is ready, then ensure container $ContainerName uses $PostgresImage"
    return
  }
  if (Test-TcpPort $Pg.Host $Pg.Port) {
    Write-Host "Postgres already reachable"
    return
  }

  Ensure-DockerReady
  if ((Invoke-NativeQuiet { docker container inspect $ContainerName }) -eq 0) {
    $code = Invoke-NativeQuiet { docker start $ContainerName }
    if ($code -ne 0) {
      throw "Failed to start Docker container $ContainerName"
    }
  } else {
    $portMap = "$($Pg.Port):5432"
    $code = Invoke-NativeQuiet { docker run --name $ContainerName `
      -e "POSTGRES_USER=$($Pg.User)" `
      -e "POSTGRES_PASSWORD=$($Pg.Password)" `
      -e "POSTGRES_DB=$($Pg.Database)" `
      -p $portMap `
      -d $PostgresImage }
    if ($code -ne 0) {
      throw "Failed to create Docker container $ContainerName"
    }
  }
  Wait-TcpPort $Pg.Host $Pg.Port 60
  Write-Host "Postgres ready"
}

Load-EnvFile $EnvFile
$databaseUrl = Require-Env "DATABASE_URL"
if ($env:MPYHW_LLM_STUB -ne "1") {
  Require-Env "DEEPSEEK_API_KEY" | Out-Null
}
$pg = Parse-PostgresUrl $databaseUrl
Ensure-Postgres $pg

# Start the API as a DETACHED daemon (survives VS Code closing) rather than a foreground
# uvicorn child, by delegating to api-daemon.ps1. It binds 127.0.0.1:8787, is idempotent
# (no-op if already listening), forwards stub mode ($env:MPYHW_LLM_STUB), and logs to
# mpyhw-api/tmp/api.log. Manage it afterward with: api-daemon.ps1 stop|restart|status|logs.
$daemon = Join-Path $PSScriptRoot "api-daemon.ps1"
if ($PlanOnly) {
  Write-Host "Plan: $daemon start  (detached uvicorn on 127.0.0.1:8787)"
} else {
  $devAuthArg = if ($env:MPYHW_ENABLE_DEV_AUTH -eq '1') { @{ DevAuth = $true } } else { @{} }
  & $daemon start @devAuthArg
}
