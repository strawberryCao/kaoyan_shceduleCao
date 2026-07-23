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

function Write-Utf8Bom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($true))
}

function Install-ScriptFile([string]$LocalName, [string]$Destination, [string]$RemoteUrl) {
  $localPath = Join-Path $PSScriptRoot $LocalName
  if (Test-Path -LiteralPath $localPath) {
    Copy-Item -LiteralPath $localPath -Destination $Destination -Force
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $RemoteUrl -OutFile $Destination
  }
}

$taskName = 'Kaoyan Note Folder Sync'
$installRoot = Join-Path $DataRoot 'NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configSyncPath = Join-Path $installRoot 'windows-assistant-config-sync.ps1'
$runnerPath = Join-Path $installRoot 'run-global-sync.ps1'
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

$codeRoot = 'https://raw.githubusercontent.com/strawberryCao/kaoyan_shceduleCao/fix/learning-detail-title-latex/outputs/kaoyan-schedule-app/scripts'
Install-ScriptFile 'windows-note-folder-sync.ps1' $runtimePath "$codeRoot/windows-note-folder-sync.ps1?v=20260723-global-sync-v5"
Install-ScriptFile 'windows-assistant-config-sync.ps1' $configSyncPath "$codeRoot/windows-assistant-config-sync.ps1?v=20260723-global-sync-v5"

# Configuration export is handled by the dedicated stable synchronizer below.
# Disable the older inline exporter to avoid a new Git commit every five minutes
# caused only by its generated updatedAt timestamp.
$runtimeText = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8
$runtimeText = $runtimeText.Replace(
  '  Export-SafeAssistantConfiguration $clonePath $assistantRoot',
  '  # Assistant configuration synchronization is handled by windows-assistant-config-sync.ps1.'
)
# Windows PowerShell 5.1 requires a BOM to decode Chinese paths and messages reliably.
Write-Utf8Bom $runtimePath $runtimeText
$configSyncText = Get-Content -LiteralPath $configSyncPath -Raw -Encoding UTF8
Write-Utf8Bom $configSyncPath $configSyncText

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
  version = 5
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
  safeConfigurationFiles = @('data/config/global-ai-settings.json', 'data/config/note-taxonomy.json')
}
Write-Utf8NoBom $configPath (($config | ConvertTo-Json -Depth 8) + "`n")

$runner = @"
[CmdletBinding()]
param([string]`$ConfigPath = '$($configPath.Replace("'", "''"))')
`$ErrorActionPreference = 'Continue'
& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '$($runtimePath.Replace("'", "''"))' -ConfigPath `$ConfigPath
`$noteExit = `$LASTEXITCODE
& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '$($configSyncPath.Replace("'", "''"))' -ConfigPath `$ConfigPath
`$configExit = `$LASTEXITCODE
if (`$noteExit -ne 0 -or `$configExit -ne 0) { exit 1 }
exit 0
"@
Write-Utf8Bom $runnerPath $runner

$runnerEscaped = $runnerPath.Replace('"', '""')
$configEscaped = $configPath.Replace('"', '""')
$launcher = @"
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$runnerEscaped"" -ConfigPath ""$configEscaped"""
shell.Run command, 0, False
"@
Write-Utf8NoBom $launcherPath $launcher

Write-Host ''
Write-Host '正在执行首次全局同步…' -ForegroundColor Cyan
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runnerPath -ConfigPath $configPath
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
Write-Host 'AI 配置：只上传脱敏后的任务规则、提示词和参数；API Key、接口地址和本机路径不上传。'
Write-Host ('笔记状态：' + (Join-Path $installRoot 'status.json'))
Write-Host ('配置状态：' + (Join-Path $installRoot 'config-status.json'))
Write-Host ('日志：' + (Join-Path $installRoot 'sync.log'))
