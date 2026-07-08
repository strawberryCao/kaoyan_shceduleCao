$ErrorActionPreference = 'Stop'

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

function Test-Port($Port) {
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    return $null -ne $connection
  } catch {
    $netstat = cmd.exe /c "netstat -ano | findstr :$Port"
    return -not [string]::IsNullOrWhiteSpace($netstat)
  }
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

if (-not (Test-Port 5174)) {
  Start-Process -FilePath 'node' -ArgumentList @((Join-Path $ProjectRoot 'scripts\note-server.cjs')) -WindowStyle Hidden -WorkingDirectory $ProjectRoot
}

if (Test-Port 5173) {
  exit 0
}

npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
