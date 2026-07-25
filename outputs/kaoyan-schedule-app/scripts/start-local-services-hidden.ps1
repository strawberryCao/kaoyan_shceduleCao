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

function Refresh-SyncRuntime {
  $syncRoot = if ($env:KAOYAN_SYNC_ROOT) { $env:KAOYAN_SYNC_ROOT } else { 'D:\kaoyandata\NoteFolderSync' }
  $configPath = Join-Path $syncRoot 'config.json'
  if (-not (Test-Path -LiteralPath $configPath)) { return }
  foreach ($name in @(
    'windows-note-folder-sync.ps1',
    'windows-assistant-config-sync.ps1',
    'merge-learning-data.cjs',
    'export-agent-runtime.cjs',
    'agent-workflow-contracts.cjs',
    'assistant-config-watch.cjs',
    'ai-router.cjs',
    'qwen-config.cjs',
    'note-ai-analyzer.cjs',
    'canvas-ai-organizer.cjs',
    'review-github-sync.cjs',
    'note-server.cjs'
  )) {
    $source = Join-Path $projectRoot (Join-Path 'scripts' $name)
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $syncRoot $name) -Force }
  }
  $runner = Join-Path $syncRoot 'run-global-sync.ps1'
  if (Test-Path -LiteralPath $runner) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-ConfigPath', $configPath) -WindowStyle Hidden
  }
}

function Start-HiddenNodeProcess([string]$ScriptPath) {
  Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @($ScriptPath) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden
}

Refresh-SyncRuntime

if (-not (Test-ListeningPort 5174)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\note-server.cjs')
}

if (-not (Test-ListeningPort 5173)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\web-server.cjs')
}
