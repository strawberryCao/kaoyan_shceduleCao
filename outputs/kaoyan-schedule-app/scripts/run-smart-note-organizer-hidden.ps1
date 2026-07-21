$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$organizerScript = Join-Path $PSScriptRoot 'organize-notes.cjs'
$nodeCommand = Get-Command node.exe -ErrorAction Stop

Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList @($organizerScript) `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden
