[CmdletBinding()]
param(
  [string]$ConfigPath = 'D:\kaoyandata\NoteFolderSync\config.json',
  [switch]$NativeCommandSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:GitAuthorizationHeader = ''

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Set-GitAuthorizationFromTokenFile([string]$TokenPath, [string]$Username) {
  if (-not (Test-Path -LiteralPath $TokenPath)) {
    throw "Encrypted GitHub token was not found: $TokenPath"
  }

  $secureToken = Get-Content -LiteralPath $TokenPath -Raw -Encoding UTF8 | ConvertTo-SecureString
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($token)) {
      throw 'The encrypted GitHub token is empty.'
    }
    $credentialBytes = [Text.Encoding]::UTF8.GetBytes("${Username}:$token")
    $script:GitAuthorizationHeader = 'Authorization: Basic ' + [Convert]::ToBase64String($credentialBytes)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $token = $null
  }
}

function Invoke-Git(
  [string[]]$Arguments,
  [string]$WorkingDirectory = '',
  [int[]]$AllowedExitCodes = @(0)
) {
  $environmentNames = @(
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1',
    'GIT_TERMINAL_PROMPT',
    'GCM_INTERACTIVE'
  )
  $savedEnvironment = @{}
  foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  $previousPreference = $ErrorActionPreference
  try {
    if ($script:GitAuthorizationHeader) {
      $env:GIT_CONFIG_COUNT = '2'
      $env:GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
      $env:GIT_CONFIG_VALUE_0 = $script:GitAuthorizationHeader
      $env:GIT_CONFIG_KEY_1 = 'credential.helper'
      $env:GIT_CONFIG_VALUE_1 = ''
      $env:GIT_TERMINAL_PROMPT = '0'
      $env:GCM_INTERACTIVE = 'Never'
    }

    # Git writes normal progress messages to stderr. Windows PowerShell 5.1
    # otherwise converts them into terminating ErrorRecord objects.
    $ErrorActionPreference = 'Continue'
    if ($WorkingDirectory) {
      $output = & git -C $WorkingDirectory @Arguments 2>&1 | Out-String
    } else {
      $output = & git @Arguments 2>&1 | Out-String
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    foreach ($name in $environmentNames) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
  }

  if ($AllowedExitCodes -notcontains $exitCode) {
    throw "Git command failed (exit $exitCode): git $($Arguments -join ' ')`n$($output.Trim())"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output.Trim() }
}

function Get-RelativeFilePath([string]$Root, [string]$FullPath) {
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $filePath = [System.IO.Path]::GetFullPath($FullPath)
  $rootUri = [Uri]$rootPath
  $fileUri = [Uri]$filePath
  return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString()).Replace('/', '\')
}

function Get-FileMap([string]$Root) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Root)) { return $map }
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force | ForEach-Object {
    if ($_.Name -in @('desktop.ini', 'Thumbs.db', '.DS_Store') -or $_.Name.StartsWith('~$')) { return }
    $relative = Get-RelativeFilePath $Root $_.FullName
    $map[$relative] = [pscustomobject]@{
      FullName = $_.FullName
      Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      LastWriteUtc = $_.LastWriteTimeUtc
      Length = $_.Length
    }
  }
  return $map
}

function Copy-ToRelative([string]$SourcePath, [string]$DestinationRoot, [string]$RelativePath) {
  $destination = Join-Path $DestinationRoot $RelativePath
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($destination))
  Copy-Item -LiteralPath $SourcePath -Destination $destination -Force
  (Get-Item -LiteralPath $destination).LastWriteTimeUtc = (Get-Item -LiteralPath $SourcePath).LastWriteTimeUtc
}

function Get-ConflictRelativePath([string]$RelativePath, [string]$Label, [string]$Hash) {
  $directory = [System.IO.Path]::GetDirectoryName($RelativePath)
  $extension = [System.IO.Path]::GetExtension($RelativePath)
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($RelativePath)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $fileName = "$baseName.sync-conflict-$Label-$stamp-$($Hash.Substring(0, 8))$extension"
  if ([string]::IsNullOrWhiteSpace($directory)) { return $fileName }
  return Join-Path $directory $fileName
}

function Read-PreviousHashes([string]$StatePath) {
  $hashes = @{}
  if (-not (Test-Path -LiteralPath $StatePath)) { return $hashes }
  try {
    $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in @($state.files)) {
      if ($entry.path -and $entry.hash) { $hashes[[string]$entry.path] = [string]$entry.hash }
    }
  } catch {
    # A damaged local state file must not block synchronization.
  }
  return $hashes
}

function Commit-PendingMirror([string]$ClonePath, [string]$RemoteSubdir, [string]$Message) {
  $status = Invoke-Git @('status', '--porcelain', '--', $RemoteSubdir) $ClonePath
  if ([string]::IsNullOrWhiteSpace($status.Output)) { return $false }
  Invoke-Git @('add', '--', $RemoteSubdir) $ClonePath | Out-Null
  $diff = Invoke-Git @('diff', '--cached', '--quiet', '--', $RemoteSubdir) $ClonePath @(0, 1)
  if ($diff.ExitCode -eq 1) {
    Invoke-Git @('commit', '-m', $Message) $ClonePath | Out-Null
    return $true
  }
  return $false
}

if ($NativeCommandSelfTest) {
  $selfTestRoot = Join-Path $env:TEMP "kaoyan-note-sync-native-test-$PID"
  try {
    Ensure-Directory $selfTestRoot
    $bareRepository = Join-Path $selfTestRoot 'source.git'
    $cloneRepository = Join-Path $selfTestRoot 'clone'
    $script:GitAuthorizationHeader = 'Authorization: Basic dGVzdDp0ZXN0'
    Invoke-Git @('init', '--bare', $bareRepository) | Out-Null
    $cloneResult = Invoke-Git @('clone', $bareRepository, $cloneRepository)
    if (-not (Test-Path -LiteralPath (Join-Path $cloneRepository '.git'))) {
      throw 'Native Git self-test clone did not create a repository.'
    }
    $missingMirrorCommitted = Commit-PendingMirror $cloneRepository 'source-notes' 'self-test'
    if ($missingMirrorCommitted) { throw 'A missing mirror path must not create a commit.' }
    Write-Host "Native Git and missing mirror path self-test passed (exit $($cloneResult.ExitCode))."
  } finally {
    Remove-Item -LiteralPath $selfTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Sync configuration was not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$localPath = [Environment]::ExpandEnvironmentVariables([string]$config.localPath)
$repository = [string]$config.repository
$branch = [string]$config.branch
$remoteSubdir = ([string]$config.remoteSubdir).Trim('/').Trim('\').Replace('\', '/')
$clonePath = [Environment]::ExpandEnvironmentVariables([string]$config.clonePath)
$tokenPath = [Environment]::ExpandEnvironmentVariables([string]$config.tokenPath)
$githubUsername = if ($config.githubUsername) { [string]$config.githubUsername } else { 'strawberryCao' }
$workRoot = [System.IO.Path]::GetDirectoryName($ConfigPath)
$statePath = Join-Path $workRoot 'state.json'
$statusPath = Join-Path $workRoot 'status.json'
$logPath = Join-Path $workRoot 'sync.log'
$lockPath = Join-Path $workRoot 'sync.lock'

Ensure-Directory $workRoot
Ensure-Directory $localPath
Set-GitAuthorizationFromTokenFile $tokenPath $githubUsername

$lockStream = $null
try {
  $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  exit 0
}

try {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git for Windows is not installed or is not available in PATH.'
  }

  if (-not (Test-Path -LiteralPath (Join-Path $clonePath '.git'))) {
    Ensure-Directory ([System.IO.Path]::GetDirectoryName($clonePath))
    if (Test-Path -LiteralPath $clonePath) { Remove-Item -LiteralPath $clonePath -Recurse -Force }
    Invoke-Git @('clone', '--single-branch', '--branch', $branch, "https://github.com/$repository.git", $clonePath) | Out-Null
  } else {
    Invoke-Git @('config', 'user.name', 'Kaoyan Note Folder Sync') $clonePath | Out-Null
    Invoke-Git @('config', 'user.email', 'note-folder-sync@local.invalid') $clonePath | Out-Null
    Commit-PendingMirror $clonePath $remoteSubdir 'data: recover pending local note mirror' | Out-Null
    Invoke-Git @('pull', '--rebase', '--autostash', 'origin', $branch) $clonePath | Out-Null
  }

  Invoke-Git @('config', 'user.name', 'Kaoyan Note Folder Sync') $clonePath | Out-Null
  Invoke-Git @('config', 'user.email', 'note-folder-sync@local.invalid') $clonePath | Out-Null

  $remotePath = Join-Path $clonePath $remoteSubdir
  Ensure-Directory $remotePath
  $previousHashes = Read-PreviousHashes $statePath
  $localFiles = Get-FileMap $localPath
  $remoteFiles = Get-FileMap $remotePath
  $relativePaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $localFiles.Keys) { [void]$relativePaths.Add([string]$key) }
  foreach ($key in $remoteFiles.Keys) { [void]$relativePaths.Add([string]$key) }

  $changedFiles = 0
  $conflicts = 0
  foreach ($relative in ($relativePaths | Sort-Object)) {
    $local = $localFiles[$relative]
    $remote = $remoteFiles[$relative]

    if ($null -eq $local -and $null -ne $remote) {
      Copy-ToRelative $remote.FullName $localPath $relative
      $changedFiles += 1
      continue
    }
    if ($null -ne $local -and $null -eq $remote) {
      Copy-ToRelative $local.FullName $remotePath $relative
      $changedFiles += 1
      continue
    }
    if ($null -eq $local -or $null -eq $remote -or $local.Hash -eq $remote.Hash) { continue }

    $previous = if ($previousHashes.ContainsKey($relative)) { $previousHashes[$relative] } else { '' }
    if ($previous -and $local.Hash -eq $previous -and $remote.Hash -ne $previous) {
      Copy-ToRelative $remote.FullName $localPath $relative
      $changedFiles += 1
      continue
    }
    if ($previous -and $remote.Hash -eq $previous -and $local.Hash -ne $previous) {
      Copy-ToRelative $local.FullName $remotePath $relative
      $changedFiles += 1
      continue
    }

    $conflicts += 1
    if ($local.LastWriteUtc -ge $remote.LastWriteUtc) {
      $conflictRelative = Get-ConflictRelativePath $relative 'github' $remote.Hash
      Copy-ToRelative $remote.FullName $localPath $conflictRelative
      Copy-ToRelative $remote.FullName $remotePath $conflictRelative
      Copy-ToRelative $local.FullName $remotePath $relative
    } else {
      $conflictRelative = Get-ConflictRelativePath $relative 'local' $local.Hash
      Copy-ToRelative $local.FullName $localPath $conflictRelative
      Copy-ToRelative $local.FullName $remotePath $conflictRelative
      Copy-ToRelative $remote.FullName $localPath $relative
    }
    $changedFiles += 2
  }

  $committed = Commit-PendingMirror $clonePath $remoteSubdir "data: sync Windows note folder $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  Invoke-Git @('push', 'origin', "HEAD:$branch") $clonePath | Out-Null

  $finalLocal = Get-FileMap $localPath
  $finalRemote = Get-FileMap $remotePath
  $stateFiles = @()
  foreach ($relative in ($finalLocal.Keys | Sort-Object)) {
    if ($finalRemote.ContainsKey($relative) -and $finalLocal[$relative].Hash -eq $finalRemote[$relative].Hash) {
      $stateFiles += [pscustomobject]@{ path = $relative; hash = $finalLocal[$relative].Hash }
    }
  }

  $now = [DateTime]::UtcNow.ToString('o')
  Write-JsonAtomic $statePath ([pscustomobject]@{ version = 2; updatedAt = $now; files = $stateFiles })
  Write-JsonAtomic $statusPath ([pscustomobject]@{
    ok = $true
    lastRunAt = $now
    localPath = $localPath
    repository = $repository
    branch = $branch
    remoteSubdir = $remoteSubdir
    trackedFiles = $stateFiles.Count
    changedFiles = $changedFiles
    conflicts = $conflicts
    committed = [bool]$committed
    authentication = 'dpapi-token'
    deletionPolicy = 'preserve-both-sides'
  })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now OK tracked=$($stateFiles.Count) changed=$changedFiles conflicts=$conflicts committed=$committed"
} catch {
  $now = [DateTime]::UtcNow.ToString('o')
  $message = $_.Exception.Message
  Write-JsonAtomic $statusPath ([pscustomobject]@{ ok = $false; lastRunAt = $now; error = $message })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now ERROR $message"
  throw
} finally {
  $script:GitAuthorizationHeader = ''
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
