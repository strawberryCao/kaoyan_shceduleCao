[CmdletBinding()]
param(
  [string]$LocalPath = 'C:\Users\ASUS\Desktop\笔记',
  [string]$AssistantRoot = 'C:\Users\ASUS\Desktop\考研桌面助手',
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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

$taskName = 'Kaoyan Note Folder Sync'
$installRoot = Join-Path $DataRoot 'NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configPath = Join-Path $installRoot 'config.json'
$tokenPath = Join-Path $installRoot 'github-token.dpapi'
$launcherPath = Join-Path $installRoot 'silent-sync.vbs'
$clonePath = Join-Path $DataRoot 'Caobijidata'
$legacyRoot = Join-Path $env:LOCALAPPDATA 'KaoyanStudyCenter\NoteFolderSync'
$legacyStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'KaoyanNoteFolderSync.cmd'

if ($Uninstall) {
  Invoke-ScheduledTaskCommand @('/Delete', '/TN', $taskName, '/F') @(0, 1) | Out-Null
  Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
  Write-Host '自动同步已关闭。' -ForegroundColor Yellow
  Write-Host ('本地笔记仍保留在：' + $LocalPath)
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw '未找到 Git for Windows。请先安装 Git 并确保 git.exe 位于 PATH。'
}

$driveRoot = [System.IO.Path]::GetPathRoot($DataRoot)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) {
  throw "目标磁盘不可用：$driveRoot"
}

foreach ($path in @($LocalPath, $AssistantRoot, $installRoot)) {
  if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
}

Invoke-ScheduledTaskCommand @('/Delete', '/TN', $taskName, '/F') @(0, 1) | Out-Null
Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
if ($legacyRoot -ne $installRoot -and (Test-Path -LiteralPath $legacyRoot)) {
  Remove-Item -LiteralPath $legacyRoot -Recurse -Force
}

$localRuntime = Join-Path $PSScriptRoot 'windows-note-folder-sync.ps1'
if (Test-Path -LiteralPath $localRuntime) {
  Copy-Item -LiteralPath $localRuntime -Destination $runtimePath -Force
} else {
  $runtimeUrl = 'https://raw.githubusercontent.com/strawberryCao/kaoyan_shceduleCao/fix/learning-detail-title-latex/outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1?v=20260723-global-sync-v3'
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeUrl -OutFile $runtimePath
}

if ($ResetToken) { Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue }
if (-not (Test-Path -LiteralPath $tokenPath)) {
  Write-Host ''
  Write-Host '请输入仅授权 strawberryCao/Caobijidata 的 fine-grained PAT。' -ForegroundColor Cyan
  Write-Host '权限要求：Contents - Read and write。Token 只在本机通过 Windows DPAPI 加密保存。'
  $secureToken = Read-Host 'GitHub PAT' -AsSecureString
  if ($secureToken.Length -lt 1) { throw '自动同步需要 GitHub PAT。' }
  $encrypted = $secureToken | ConvertFrom-SecureString
  Write-Utf8NoBom $tokenPath $encrypted.Trim()
  $secureToken.Dispose()
}

$config = [ordered]@{
  version = 3
  localPath = $LocalPath
  assistantRoot = $AssistantRoot
  repository = $Repository
  branch = $Branch
  remoteSubdir = $RemoteSubdir
  clonePath = $clonePath
  tokenPath = $tokenPath
  githubUsername = $GitHubUsername
  intervalMinutes = $IntervalMinutes
  authentication = 'dpapi-token'
  deletionPolicy = 'windows-local-authoritative'
  cloudDeleteAllowed = $false
  safeConfigurationSync = $true
}
Write-Utf8NoBom $configPath (($config | ConvertTo-Json -Depth 8) + "`n")

$runtimeEscaped = $runtimePath.Replace('"', '""')
$configEscaped = $configPath.Replace('"', '""')
$launcher = @"
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$runtimeEscaped"" -ConfigPath ""$configEscaped"""
shell.Run command, 0, False
"@
Write-Utf8NoBom $launcherPath $launcher

Write-Host ''
Write-Host '正在执行首次全局同步…' -ForegroundColor Cyan
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runtimePath -ConfigPath $configPath
if ($LASTEXITCODE -ne 0) {
  throw ('首次同步失败，请查看：' + (Join-Path $installRoot 'sync.log'))
}

$taskCommand = 'wscript.exe //B //Nologo "' + $launcherPath + '"'
Invoke-ScheduledTaskCommand @(
  '/Create',
  '/TN', $taskName,
  '/TR', $taskCommand,
  '/SC', 'MINUTE',
  '/MO', [string]$IntervalMinutes,
  '/F'
) | Out-Null

Write-Host ''
Write-Host '全局同步已启用。' -ForegroundColor Green
Write-Host ('本地笔记：' + $LocalPath)
Write-Host ('本地配置：' + $AssistantRoot)
Write-Host ('GitHub 数据：' + $Repository + '/' + $RemoteSubdir)
Write-Host ('频率：每 ' + $IntervalMinutes + ' 分钟')
Write-Host '运行方式：完全隐藏，不弹 PowerShell 窗口。'
Write-Host '删除规则：只有 Windows 本地删除会向全局扩散；云端删除被拒绝。'
Write-Host 'AI 配置：只上传脱敏后的任务规则、提示词和参数；API Key 不上传。'
Write-Host ('状态：' + (Join-Path $installRoot 'status.json'))
Write-Host ('日志：' + (Join-Path $installRoot 'sync.log'))
