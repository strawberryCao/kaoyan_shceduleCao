$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop

function Test-ListeningPort([int]$Port) {
  try {
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Start-HiddenNodeProcess([string]$ScriptPath) {
  Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @($ScriptPath) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden
}

if (-not (Test-ListeningPort 5174)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\note-server.cjs')
}

if (-not (Test-ListeningPort 5173)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\web-server.cjs')
}
