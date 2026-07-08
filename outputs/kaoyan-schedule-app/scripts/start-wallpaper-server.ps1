$ErrorActionPreference = 'Stop'

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

function Test-Port5173 {
  try {
    $connection = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop | Select-Object -First 1
    return $null -ne $connection
  } catch {
    $netstat = cmd.exe /c "netstat -ano | findstr :5173"
    return -not [string]::IsNullOrWhiteSpace($netstat)
  }
}

if (Test-Port5173) {
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  exit 1
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  exit 1
}

if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
  npm.cmd install
}

npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
