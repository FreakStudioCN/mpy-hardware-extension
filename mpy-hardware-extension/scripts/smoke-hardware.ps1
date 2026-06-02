param(
  [Parameter(Mandatory=$true)]
  [string]$Port
)

mpremote --version | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "mpremote is not installed or not on PATH."
  exit 1
}

$ports = mpremote connect list
if ($LASTEXITCODE -ne 0 -or -not ($ports -match [regex]::Escape($Port))) {
  Write-Error "Port $Port was not found. Available ports: $ports"
  exit 1
}

mpremote connect $Port exec "print('MPYHW_PROBE')"
exit $LASTEXITCODE
