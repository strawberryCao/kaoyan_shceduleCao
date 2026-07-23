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

$taskName = 'Kaoyan Note Folder Sync'
$installRoot = Join-Path $env:LOCALAPPDATA 'KaoyanStudyCenter\NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configPath = Join-Path $installRoot 'config.json'
$clonePath = Join-Path $installRoot 'Caobijidata'
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'KaoyanNoteFolderSync.cmd'

if ($Uninstall) {
  & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
  Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue
  Write-Host '已停止自动同步。配置、日志和本地 Git 缓存仍保留在：' -ForegroundColor Yellow
  Write-Host $installRoot
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw '未检测到 Git for Windows。请先安装 Git，并确保 git 命令可在 PowerShell 中运行。'
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

Write-Host '正在执行首次同步。GitHub 若要求登录，请在弹出的 Git Credential Manager 中完成一次授权。' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runtimePath -ConfigPath $configPath
if ($LASTEXITCODE -ne 0) {
  throw "首次同步失败。请查看日志：$(Join-Path $installRoot 'sync.log')"
}

$taskArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runtimePath`" -ConfigPath `"$configPath`""
$taskCommand = "powershell.exe $taskArguments"
& schtasks.exe /Create /TN $taskName /TR $taskCommand /SC MINUTE /MO $IntervalMinutes /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Windows 计划任务创建失败。请用当前账户重新运行该安装脚本。'
}

@"
@echo off
start "" /min powershell.exe $taskArguments
"@ | Set-Content -LiteralPath $startupPath -Encoding ASCII

Write-Host ''
Write-Host '自动同步已启用。' -ForegroundColor Green
Write-Host "本机目录：$LocalPath"
Write-Host "GitHub 目录：https://github.com/$Repository/tree/$Branch/$RemoteSubdir"
Write-Host "同步频率：每 $IntervalMinutes 分钟，并在登录 Windows 时运行一次"
Write-Host '冲突策略：保留双方文件，并生成 sync-conflict 副本；删除不会自动传播。'
Write-Host "状态文件：$(Join-Path $installRoot 'status.json')"
Write-Host "日志文件：$(Join-Path $installRoot 'sync.log')"
