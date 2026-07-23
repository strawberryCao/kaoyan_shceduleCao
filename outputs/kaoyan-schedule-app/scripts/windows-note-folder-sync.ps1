[CmdletBinding()]
param(
  [string]$ConfigPath = 'D:\kaoyandata\NoteFolderSync\config.json',
  [switch]$NativeCommandSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Invoke-Git(
  [string[]]$Arguments,
  [string]$WorkingDirectory = '',
  [int[]]$AllowedExitCodes = @(0)
) {
  $previousPreference = $ErrorActionPreference
  try {
    # Git writes normal clone/fetch/push progress to stderr. Windows PowerShell
    # 5.1 otherwise converts those lines into terminating ErrorRecord objects.
    $ErrorActionPreference = 'Continue'
    if ($WorkingDirectory) {
      $output = & git -C $WorkingDirectory @Arguments 2>&1 | Out-String
    } else {
      $output = & git @Arguments 2>&1 | Out-String
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
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
    # Rebuild state when the local status file is damaged.
  }
  return $hashes
}

function Commit-PendingMirror([string]$ClonePath, [string]$RemoteSubdir, [string]$Message) {
  $mirrorPath = Join-Path $ClonePath $RemoteSubdir
  if (-not (Test-Path -LiteralPath $mirrorPath)) { return $false }
  $files = @(Get-ChildItem -LiteralPath $mirrorPath -File -Recurse -Force -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return $false }

  Invoke-Git @('add', '-A', '--', $RemoteSubdir) $ClonePath | Out-Null
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
    Invoke-Git @('init', '--bare', $bareRepository) | Out-Null
    $cloneResult = Invoke-Git @('clone', $bareRepository, $cloneRepository)
    Invoke-Git @('config', 'user.name', 'Sync Self Test') $cloneRepository | Out-Null
    Invoke-Git @('config', 'user.email', 'sync-test@local.invalid') $cloneRepository | Out-Null

    if (Commit-PendingMirror $cloneRepository 'source-notes' 'self-test: missing path') {
      throw 'A missing source-notes path must not create a commit.'
    }
    Ensure-Directory (Join-Path $cloneRepository 'source-notes')
    Set-Content -LiteralPath (Join-Path $cloneRepository 'source-notes\sample.txt') -Value 'sample' -Encoding UTF8
    if (-not (Commit-PendingMirror $cloneRepository 'source-notes' 'self-test: mirror path')) {
      throw 'A populated source-notes path should create a commit.'
    }
    Write-Host "Native Git and missing-path self-test passed (clone exit $($cloneResult.ExitCode))."
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
$remoteSubdir = ([string]$config.remoteSubdir).Trim('/').Replace('/', '\')
$clonePath = [Environment]::ExpandEnvironmentVariables([string]$config.clonePath)
$workRoot = [System.IO.Path]::GetDirectoryName($ConfigPath)
$statePath = Join-Path $workRoot 'state.json'
$statusPath = Join-Path $workRoot 'status.json'
$logPath = Join-Path $workRoot 'sync.log'
$lockPath = Join-Path $workRoot 'sync.lock'

Ensure-Directory $workRoot
Ensure-Directory $localPath
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
  Write-JsonAtomic $statePath ([pscustomobject]@{ version = 1; updatedAt = $now; files = $stateFiles })
  Write-JsonAtomic $statusPath ([pscustomobject]@{
    ok = $true
    lastRunAt = $now
    localPath = $localPath
    repository = $repository
    branch = $branch
    remoteSubdir = $remoteSubdir.Replace('\', '/')
    trackedFiles = $stateFiles.Count
    changedFiles = $changedFiles
    conflicts = $conflicts
    committed = [bool]$committed
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
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
