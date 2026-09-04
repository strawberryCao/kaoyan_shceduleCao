$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$configuredSyncRoot = if ($env:KAOYAN_SYNC_ROOT) { $env:KAOYAN_SYNC_ROOT } else { 'D:\kaoyandata\NoteFolderSync' }
$configuredSyncPath = Join-Path $configuredSyncRoot 'config.json'
$configuredAssistantRoot = if (Test-Path -LiteralPath $configuredSyncPath) {
  (Get-Content -LiteralPath $configuredSyncPath -Raw -Encoding UTF8 | ConvertFrom-Json).assistantRoot
} else {
  $null
}
$assistantRoot = if ($env:KAOYAN_ASSISTANT_ROOT) {
  $env:KAOYAN_ASSISTANT_ROOT
} elseif ($configuredAssistantRoot) {
  [string]$configuredAssistantRoot
} else {
  $assistantFolderName = -join @([char]0x8003, [char]0x7814, [char]0x684c, [char]0x9762, [char]0x52a9, [char]0x624b)
  Join-Path ([Environment]::GetFolderPath('Desktop')) $assistantFolderName
}
$logRoot = Join-Path $assistantRoot 'service-logs'
if (-not (Test-Path -LiteralPath $logRoot)) { New-Item -ItemType Directory -Path $logRoot -Force | Out-Null }

function Test-ListeningPort([int]$Port) {
  try {
    $networkProperties = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $listeners = $networkProperties.GetActiveTcpListeners()
    return $listeners.Port -contains $Port
  } catch {
    return $false
  }
}

function Wait-HttpEndpoint([string]$Uri, [int]$TimeoutSeconds = 20) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  return $false
}

function Refresh-SyncRuntime {
  $syncRoot = if ($env:KAOYAN_SYNC_ROOT) { $env:KAOYAN_SYNC_ROOT } else { 'D:\kaoyandata\NoteFolderSync' }
  $configPath = Join-Path $syncRoot 'config.json'
  if (-not (Test-Path -LiteralPath $configPath)) { return }
  $syncConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($name in @(
    'windows-note-folder-sync.ps1',
    'windows-assistant-config-sync.ps1',
    'merge-learning-data.cjs',
    'export-agent-runtime.cjs',
    'agent-workflow-contracts.cjs',
    'assistant-config-watch.cjs',
    'ai-router.cjs',
    'ai-request-budget.cjs',
    'ai-subject-policy.cjs',
    'qwen-config.cjs',
    'note-ai-analyzer.cjs',
    'canvas-ai-organizer.cjs',
    'organize-notes.cjs',
    'v2-local-adapter.cjs',
    'migrate-learning-data-v2.cjs',
    'review-github-sync.cjs',
    'note-server.cjs'
  )) {
    $source = Join-Path $projectRoot (Join-Path 'scripts' $name)
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $syncRoot $name) -Force }
  }
  $autoSyncEnabled = $syncConfig.autoSyncEnabled -eq $true
  $syncIsPaused = [string]$syncConfig.persistenceMode -eq 'installed-paused'
  if (-not $autoSyncEnabled -or $syncIsPaused) { return }
  $runner = Join-Path $syncRoot 'run-global-sync.ps1'
  if (Test-Path -LiteralPath $runner) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-ConfigPath', $configPath) -WindowStyle Hidden
  }
}

function Start-HiddenNodeProcess([string]$ScriptPath, [string]$LogName) {
  $stdoutPath = Join-Path $logRoot "$LogName.out.log"
  $stderrPath = Join-Path $logRoot "$LogName.err.log"
  Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @($ScriptPath) `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden
}

Refresh-SyncRuntime

if (-not (Test-ListeningPort 5174)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\note-server.cjs') 'note-server'
}

if (-not (Test-ListeningPort 5173)) {
  Start-HiddenNodeProcess (Join-Path $projectRoot 'scripts\web-server.cjs') 'web-server'
}

if (-not (Wait-HttpEndpoint 'http://127.0.0.1:5174/health')) {
  throw 'Note service failed its startup health check. See service-logs\note-server.err.log.'
}
if (-not (Wait-HttpEndpoint 'http://127.0.0.1:5173/')) {
  throw 'LAN web service failed its startup health check. See service-logs\web-server.err.log.'
}

@{
  checkedAt = [DateTime]::UtcNow.ToString('o')
  noteService = 'http://127.0.0.1:5174/health'
  lanService = 'http://0.0.0.0:5173/'
  healthy = $true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'service-startup-status.json') -Encoding UTF8
