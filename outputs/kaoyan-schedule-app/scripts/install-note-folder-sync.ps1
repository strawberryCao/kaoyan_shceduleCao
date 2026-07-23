[CmdletBinding()]
param(
  [string]$LocalPath = 'C:\Users\ASUS\Desktop\笔记',
  [string]$Repository = 'strawberryCao/Caobijidata',
  [string]$Branch = 'main',
  [string]$RemoteSubdir = 'source-notes',
  [ValidateRange(2, 60)]
  [int]$IntervalMinutes = 5,
  [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-ScheduledTaskCommand(
  [string[]]$Arguments,
  [int[]]$AllowedExitCodes = @(0)
) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & schtasks.exe @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($AllowedExitCodes -notcontains $exitCode) {
    throw "Task Scheduler command failed (exit $exitCode).`n$($output.Trim())"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output.Trim() }
}

$taskName = 'Kaoyan Note Folder Sync'
$installRoot = Join-Path $env:LOCALAPPDATA 'KaoyanStudyCenter\NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configPath = Join-Path $installRoot 'config.json'
$clonePath = Join-Path $installRoot 'Caobijidata'
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'KaoyanNoteFolderSync.cmd'

if ($Uninstall) {
  # Exit code 1 is expected when the task does not exist yet.
  Invoke-ScheduledTaskCommand @('/Delete', '/TN', $taskName, '/F') @(0, 1) | Out-Null
  Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue
  Write-Host 'Automatic note synchronization has been disabled.' -ForegroundColor Yellow
  Write-Host ('Local configuration and logs remain at: ' + $installRoot)
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git for Windows was not found. Install Git and ensure git.exe is available in PATH.'
}

if (-not (Test-Path -LiteralPath $LocalPath)) {
  New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
}
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

$localRuntime = Join-Path $PSScriptRoot 'windows-note-folder-sync.ps1'
if (Test-Path -LiteralPath $localRuntime) {
  Copy-Item -LiteralPath $localRuntime -Destination $runtimePath -Force
} else {
  $runtimeUrl = 'https://raw.githubusercontent.com/strawberryCao/kaoyan_shceduleCao/fix/learning-detail-title-latex/outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1'
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeUrl -OutFile $runtimePath
}

$config = [ordered]@{
  version = 1
  localPath = $LocalPath
  repository = $Repository
  branch = $Branch
  remoteSubdir = $RemoteSubdir
  clonePath = $clonePath
  intervalMinutes = $IntervalMinutes
  deletionPolicy = 'preserve-both-sides'
}
$config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Host 'Running the first synchronization. Git Credential Manager may ask you to sign in once.' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runtimePath -ConfigPath $configPath
if ($LASTEXITCODE -ne 0) {
  throw ('Initial synchronization failed. Check: ' + (Join-Path $installRoot 'sync.log'))
}

$quotedRuntime = '"' + $runtimePath + '"'
$quotedConfig = '"' + $configPath + '"'
$taskArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $quotedRuntime + ' -ConfigPath ' + $quotedConfig
$taskCommand = 'powershell.exe ' + $taskArguments

$taskCreateArguments = @(
  '/Create',
  '/TN', $taskName,
  '/TR', $taskCommand,
  '/SC', 'MINUTE',
  '/MO', [string]$IntervalMinutes,
  '/F'
)
Invoke-ScheduledTaskCommand $taskCreateArguments | Out-Null

$startupLines = @(
  '@echo off',
  ('start "" /min ' + $taskCommand)
)
$startupLines | Set-Content -LiteralPath $startupPath -Encoding ASCII

Write-Host ''
Write-Host 'Automatic note synchronization is enabled.' -ForegroundColor Green
Write-Host ('Local folder: ' + $LocalPath)
Write-Host ('GitHub folder: https://github.com/' + $Repository + '/tree/' + $Branch + '/' + $RemoteSubdir)
Write-Host ('Schedule: every ' + $IntervalMinutes + ' minutes and once after Windows sign-in')
Write-Host 'Conflict policy: both versions are preserved; deletions are not propagated.'
Write-Host ('Status: ' + (Join-Path $installRoot 'status.json'))
Write-Host ('Log: ' + (Join-Path $installRoot 'sync.log'))
