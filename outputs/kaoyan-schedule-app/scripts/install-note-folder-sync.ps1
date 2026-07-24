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

function Invoke-ScheduledTaskCommand([string[]]$Arguments, [int[]]$AllowedExitCodes = @(0)) {
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
  $parent = [System.IO.Path]::GetDirectoryName($Path)
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Write-Utf8Bom([string]$Path, [string]$Content) {
  $parent = [System.IO.Path]::GetDirectoryName($Path)
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($true))
}

function Install-ScriptFile([string]$LocalName, [string]$Destination, [string]$RemoteUrl) {
  $localFile = Join-Path $PSScriptRoot $LocalName
  if (Test-Path -LiteralPath $localFile) {
    Copy-Item -LiteralPath $localFile -Destination $Destination -Force
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $RemoteUrl -OutFile $Destination
  }
}

function Replace-Required([string]$Text, [string]$Search, [string]$Replacement, [string]$Name) {
  if (-not $Text.Contains($Search)) { throw "安装器无法修补运行脚本：$Name。请不要继续使用这个安装包。" }
  return $Text.Replace($Search, $Replacement)
}

$noteTaskName = 'Kaoyan Note Folder Sync'
$watchTaskName = 'Kaoyan Assistant Config Watch'
$installRoot = Join-Path $DataRoot 'NoteFolderSync'
$runtimePath = Join-Path $installRoot 'windows-note-folder-sync.ps1'
$configSyncPath = Join-Path $installRoot 'windows-assistant-config-sync.ps1'
$exporterPath = Join-Path $installRoot 'export-agent-runtime.cjs'
$learningMergePath = Join-Path $installRoot 'merge-learning-data.cjs'
$watcherPath = Join-Path $installRoot 'assistant-config-watch.cjs'
$runnerPath = Join-Path $installRoot 'run-global-sync.ps1'
$configPath = Join-Path $installRoot 'config.json'
$tokenPath = Join-Path $installRoot 'github-token.dpapi'
$syncLauncherPath = Join-Path $installRoot 'silent-sync.vbs'
$watchLauncherPath = Join-Path $installRoot 'silent-config-watch.vbs'
$watchSupervisorPath = Join-Path $installRoot 'assistant-config-watch-supervisor.ps1'
$clonePath = Join-Path $DataRoot 'Caobijidata'
$legacyRoot = Join-Path $env:LOCALAPPDATA 'KaoyanStudyCenter\NoteFolderSync'
$startupFolder = [Environment]::GetFolderPath('Startup')
$legacyStartup = Join-Path $startupFolder 'KaoyanNoteFolderSync.cmd'
$startupLauncherPath = Join-Path $startupFolder 'KaoyanAssistantSync.vbs'

if ($Uninstall) {
  Invoke-ScheduledTaskCommand @('/Delete', '/TN', $noteTaskName, '/F') @(0, 1) | Out-Null
  Invoke-ScheduledTaskCommand @('/Delete', '/TN', $watchTaskName, '/F') @(0, 1) | Out-Null
  Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $startupLauncherPath -Force -ErrorAction SilentlyContinue
  Write-Host '自动同步与配置监听已关闭。' -ForegroundColor Yellow
  Write-Host ('本地笔记仍保留在：' + $LocalPath)
  Write-Host ('本地配置仍保留在：' + $AssistantRoot)
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '未找到 Git for Windows。请先安装 Git 并确保 git.exe 位于 PATH。' }
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }

$driveRoot = [System.IO.Path]::GetPathRoot($DataRoot)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) { throw "目标磁盘不可用：$driveRoot" }
foreach ($folder in @($LocalPath, $AssistantRoot, $installRoot, $startupFolder)) {
  if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
}

Invoke-ScheduledTaskCommand @('/Delete', '/TN', $noteTaskName, '/F') @(0, 1) | Out-Null
Invoke-ScheduledTaskCommand @('/Delete', '/TN', $watchTaskName, '/F') @(0, 1) | Out-Null
Remove-Item -LiteralPath $legacyStartup -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startupLauncherPath -Force -ErrorAction SilentlyContinue
if ($legacyRoot -ne $installRoot -and (Test-Path -LiteralPath $legacyRoot)) { Remove-Item -LiteralPath $legacyRoot -Recurse -Force }

$codeRoot = 'https://raw.githubusercontent.com/strawberryCao/kaoyan_shceduleCao/fix/learning-detail-title-latex/outputs/kaoyan-schedule-app/scripts'
$version = '20260724-learning-sync-v10'
Install-ScriptFile 'windows-note-folder-sync.ps1' $runtimePath "$codeRoot/windows-note-folder-sync.ps1?v=$version"
Install-ScriptFile 'windows-assistant-config-sync.ps1' $configSyncPath "$codeRoot/windows-assistant-config-sync.ps1?v=$version"
Install-ScriptFile 'export-agent-runtime.cjs' $exporterPath "$codeRoot/export-agent-runtime.cjs?v=$version"
Install-ScriptFile 'merge-learning-data.cjs' $learningMergePath "$codeRoot/merge-learning-data.cjs?v=$version"
Install-ScriptFile 'assistant-config-watch.cjs' $watcherPath "$codeRoot/assistant-config-watch.cjs?v=$version"
foreach ($dependency in @('ai-router.cjs', 'qwen-config.cjs', 'note-ai-analyzer.cjs', 'canvas-ai-organizer.cjs', 'review-github-sync.cjs', 'note-server.cjs')) {
  Install-ScriptFile $dependency (Join-Path $installRoot $dependency) "$codeRoot/${dependency}?v=$version"
}

$runtimeText = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8
$runtimeText = Replace-Required $runtimeText `
  '  Export-SafeAssistantConfiguration $clonePath $assistantRoot' `
  '  # Agent configuration is published one-way by windows-assistant-config-sync.ps1.' `
  'disable reverse configuration export'

$oldCommitPending = @'
function Commit-Pending([string]$ClonePath, [string]$Message) {
  $paths = @('source-notes', 'data/config', 'data/deletions', 'data/local-delete-recycle', 'data/quarantine')
  $status = Invoke-Git (@('status', '--porcelain', '--') + $paths) $ClonePath
  if ([string]::IsNullOrWhiteSpace($status.Output)) { return $false }
  Invoke-Git (@('add', '--') + $paths) $ClonePath | Out-Null
  $diff = Invoke-Git (@('diff', '--cached', '--quiet', '--') + $paths) $ClonePath @(0, 1)
  if ($diff.ExitCode -eq 1) {
    Invoke-Git @('commit', '-m', $Message) $ClonePath | Out-Null
    return $true
  }
  return $false
}
'@

$newCommitPending = @'
function Commit-Pending([string]$ClonePath, [string]$Message) {
  $candidatePaths = @(
    'source-notes',
    'data/cloud/learning-data.json',
    'data/config',
    'data/deletions',
    'data/local-delete-recycle',
    'data/quarantine'
  )
  $paths = @()
  foreach ($candidate in $candidatePaths) {
    if (Test-Path -LiteralPath (Join-Path $ClonePath $candidate)) {
      $paths += $candidate
      continue
    }
    $tracked = Invoke-Git @('ls-files', '--', $candidate) $ClonePath
    if (-not [string]::IsNullOrWhiteSpace($tracked.Output)) { $paths += $candidate }
  }
  if ($paths.Count -eq 0) { return $false }
  $status = Invoke-Git (@('status', '--porcelain', '--') + $paths) $ClonePath
  if ([string]::IsNullOrWhiteSpace($status.Output)) { return $false }
  Invoke-Git (@('add', '-A', '--') + $paths) $ClonePath | Out-Null
  $diff = Invoke-Git (@('diff', '--cached', '--quiet', '--') + $paths) $ClonePath @(0, 1)
  if ($diff.ExitCode -eq 1) {
    Invoke-Git @('commit', '-m', $Message) $ClonePath | Out-Null
    return $true
  }
  return $false
}
'@
$runtimeText = Replace-Required $runtimeText $oldCommitPending $newCommitPending 'filter optional Git pathspecs'

$runtimeNode = $nodeCommand.Source.Replace("'", "''")
$runtimeMerge = $learningMergePath.Replace("'", "''")
$runtimeConfig = $configPath.Replace("'", "''")
$mergeBlock = @"
  Materialize-CloudNotes `$localPath `$remotePath
  & '$runtimeNode' '$runtimeMerge' --config '$runtimeConfig' | Out-Null
  if (`$LASTEXITCODE -ne 0) { throw 'Learning data merge failed.' }
"@
$runtimeText = Replace-Required $runtimeText '  Materialize-CloudNotes $localPath $remotePath' $mergeBlock.TrimEnd() 'enable structured learning-data merge'
Write-Utf8Bom $runtimePath $runtimeText
Write-Utf8Bom $configSyncPath (Get-Content -LiteralPath $configSyncPath -Raw -Encoding UTF8)

if ($ResetToken) { Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue }
if (-not (Test-Path -LiteralPath $tokenPath)) {
  Write-Host ''
  Write-Host '请输入仅授权 strawberryCao/Caobijidata 的 fine-grained PAT。' -ForegroundColor Cyan
  Write-Host '权限要求：Contents - Read and write。Token 只在本机通过 Windows DPAPI 加密保存。'
  $secureToken = Read-Host 'GitHub PAT' -AsSecureString
  if ($secureToken.Length -lt 1) { throw '自动同步需要 GitHub PAT。' }
  Write-Utf8NoBom $tokenPath (($secureToken | ConvertFrom-SecureString).Trim())
  $secureToken.Dispose()
}

$config = [ordered]@{
  version = 10
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
  configurationDirection = 'local-to-github-only'
  githubMayOverwriteLocalConfiguration = $false
  learningDataDirection = 'bidirectional-structured-merge'
  learningDataLocalPath = (Join-Path $AssistantRoot 'learning-data.json')
  learningDataRemotePath = 'data/cloud/learning-data.json'
  agentRuntimeExporter = $exporterPath
  agentRuntimeRemotePath = 'data/config/local-assistant'
  strictAgentRuntime = $true
  persistenceMode = 'current-user-startup-hidden-watcher'
  taskSchedulerRequired = $false
  optionalGitPathsAreFiltered = $true
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
$syncLauncher = @"
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$runnerEscaped"" -ConfigPath ""$configEscaped"""
shell.Run command, 0, False
"@
Write-Utf8NoBom $syncLauncherPath $syncLauncher

$nodePathForPowerShell = $nodeCommand.Source.Replace("'", "''")
$watcherPathForPowerShell = $watcherPath.Replace("'", "''")
$installRootForPowerShell = $installRoot.Replace("'", "''")
$assistantRootForPowerShell = $AssistantRoot.Replace("'", "''")
$watchSupervisor = @"
`$ErrorActionPreference = 'Continue'
`$env:KAOYAN_SYNC_ROOT = '$installRootForPowerShell'
`$env:KAOYAN_ASSISTANT_ROOT = '$assistantRootForPowerShell'
`$env:KAOYAN_SYNC_INTERVAL_MINUTES = '$IntervalMinutes'
while (`$true) {
  & '$nodePathForPowerShell' '$watcherPathForPowerShell'
  `$exitCode = `$LASTEXITCODE
  if (`$exitCode -eq 0) { exit 0 }
  Start-Sleep -Seconds 15
}
"@
Write-Utf8Bom $watchSupervisorPath $watchSupervisor

$supervisorEscaped = $watchSupervisorPath.Replace('"', '""')
$watchLauncher = @"
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$supervisorEscaped"""
shell.Run command, 0, False
"@
Write-Utf8NoBom $watchLauncherPath $watchLauncher
Copy-Item -LiteralPath $watchLauncherPath -Destination $startupLauncherPath -Force

Write-Host ''
Write-Host '正在执行首次全局同步…' -ForegroundColor Cyan
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runnerPath -ConfigPath $configPath
if ($LASTEXITCODE -ne 0) { throw ('首次同步失败，请查看：' + (Join-Path $installRoot 'sync.log')) }
Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $watchLauncherPath) -WindowStyle Hidden

Write-Host ''
Write-Host '全局同步 v10 已启用。' -ForegroundColor Green
Write-Host ('本地笔记：' + $LocalPath)
Write-Host ('本地配置：' + $AssistantRoot)
Write-Host ('GitHub 数据：' + $Repository)
Write-Host '配置方向：只允许本地配置发布到 GitHub；GitHub 不会覆盖本地配置。'
Write-Host '学习数据：本地与 GitHub 按 noteUid、thought id、card id 和 review id 双向合并。'
Write-Host 'Git 路径：不存在且未跟踪的可选目录会自动跳过；已跟踪删除仍会正常提交。'
Write-Host '运行方式：当前用户启动目录 + 隐藏监督进程，不需要管理员或计划任务权限。'
Write-Host ('笔记状态：' + (Join-Path $installRoot 'status.json'))
Write-Host ('学习数据状态：' + (Join-Path $installRoot 'learning-data-sync-status.json'))
Write-Host ('配置状态：' + (Join-Path $installRoot 'config-status.json'))
Write-Host ('日志：' + (Join-Path $installRoot 'sync.log'))
