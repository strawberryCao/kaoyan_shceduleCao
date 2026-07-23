[CmdletBinding()]
param(
  [string]$LocalPath = 'C:\Users\ASUS\Desktop\笔记',
  [string]$DataRoot = 'D:\kaoyandata',
  [string]$Repository = 'strawberryCao/Caobijidata',
  [string]$Branch = 'main',
  [string]$RemoteSubdir = 'source-notes',
  [string]$GitHubUsername = 'strawberryCao',
  [ValidateRange(2, 60)]
  [int]$IntervalMinutes = 5,
  [switch]$Uninstall,
  [switch]$ResetToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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
$installRoot = Join-Path $DataRoot 'NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configPath = Join-Path $installRoot 'config.json'
$tokenPath = Join-Path $installRoot 'github-token.dpapi'
$clonePath = Join-Path $DataRoot 'Caobijidata'
$legacyRoot = Join-Path $env:LOCALAPPDATA 'KaoyanStudyCenter\NoteFolderSync'
$legacyStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'KaoyanNoteFolderSync.cmd'

if ($Uninstall) {
  Invoke-ScheduledTaskCommand @('/Delete', '/TN', $taskName, '/F') @(0, 1) | Out-Null
  Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
  Write-Host 'Automatic note synchronization has been disabled.' -ForegroundColor Yellow
  Write-Host ('Local notes remain at: ' + $LocalPath)
  Write-Host ('GitHub data remains in: ' + $Repository + '/' + $RemoteSubdir)
  Write-Host ('Encrypted token, configuration and logs remain at: ' + $installRoot)
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git for Windows was not found. Install Git and ensure git.exe is available in PATH.'
}

$driveRoot = [System.IO.Path]::GetPathRoot($DataRoot)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) {
  throw "The target drive is unavailable: $driveRoot"
}

if (-not (Test-Path -LiteralPath $LocalPath)) {
  New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
}
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

# Remove failed legacy C-drive runtime data. The user's actual note folder is not touched.
Invoke-ScheduledTaskCommand @('/Delete', '/TN', $taskName, '/F') @(0, 1) | Out-Null
Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
if ($legacyRoot -ne $installRoot -and (Test-Path -LiteralPath $legacyRoot)) {
  Remove-Item -LiteralPath $legacyRoot -Recurse -Force
}

$localRuntime = Join-Path $PSScriptRoot 'windows-note-folder-sync.ps1'
if (Test-Path -LiteralPath $localRuntime) {
  Copy-Item -LiteralPath $localRuntime -Destination $runtimePath -Force
} else {
  $runtimeUrl = 'https://raw.githubusercontent.com/strawberryCao/kaoyan_shceduleCao/fix/learning-detail-title-latex/outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1?v=20260723-dpapi'
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeUrl -OutFile $runtimePath
}

if ($ResetToken) {
  Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $tokenPath)) {
  Write-Host ''
  Write-Host 'Git Credential Manager is unavailable on this computer.' -ForegroundColor Yellow
  Write-Host 'Enter a fine-grained GitHub PAT with Contents: Read and write for strawberryCao/Caobijidata.' -ForegroundColor Cyan
  Write-Host 'The token is entered locally, encrypted with Windows DPAPI, and never written to logs or Git URLs.'
  $secureToken = Read-Host 'GitHub PAT' -AsSecureString
  if ($secureToken.Length -lt 1) {
    throw 'A GitHub PAT is required for automatic synchronization.'
  }
  $secureToken | ConvertFrom-SecureString | Set-Content -LiteralPath $tokenPath -Encoding UTF8
  $secureToken.Dispose()
}

$config = [ordered]@{
  version = 2
  localPath = $LocalPath
  repository = $Repository
  branch = $Branch
  remoteSubdir = $RemoteSubdir
  clonePath = $clonePath
  tokenPath = $tokenPath
  githubUsername = $GitHubUsername
  intervalMinutes = $IntervalMinutes
  authentication = 'dpapi-token'
  deletionPolicy = 'preserve-both-sides'
}
$config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Host ''
Write-Host 'Running the first synchronization without Git Credential Manager...' -ForegroundColor Cyan
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

Write-Host ''
Write-Host 'Automatic note synchronization is enabled.' -ForegroundColor Green
Write-Host ('Local notes: ' + $LocalPath)
Write-Host ('Runtime data: ' + $installRoot)
Write-Host ('Local Git mirror: ' + $clonePath)
Write-Host ('GitHub folder: https://github.com/' + $Repository + '/tree/' + $Branch + '/' + $RemoteSubdir)
Write-Host ('Schedule: every ' + $IntervalMinutes + ' minutes')
Write-Host 'Authentication: Windows DPAPI encrypted PAT; Git Credential Manager is bypassed.'
Write-Host 'Conflict policy: both versions are preserved; deletions are not propagated.'
Write-Host ('Status: ' + (Join-Path $installRoot 'status.json'))
Write-Host ('Log: ' + (Join-Path $installRoot 'sync.log'))
