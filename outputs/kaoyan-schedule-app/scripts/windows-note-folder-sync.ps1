[CmdletBinding()]
param(
  [string]$ConfigPath = 'D:\kaoyandata\NoteFolderSync\config.json',
  [switch]$NativeCommandSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:GitAuthorizationHeader = ''
$script:BlockedExtensions = @(
  '.exe', '.dll', '.msi', '.msp', '.ps1', '.psm1', '.bat', '.cmd', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.scr', '.com', '.lnk', '.hta', '.cpl', '.reg'
)

function Ensure-Directory([string]$Path) {
  if ($Path -and -not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  Write-Utf8NoBom $temporary (($Value | ConvertTo-Json -Depth 30) + "`n")
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Set-GitAuthorizationFromTokenFile([string]$TokenPath, [string]$Username) {
  if (-not (Test-Path -LiteralPath $TokenPath)) { throw "Encrypted GitHub token was not found: $TokenPath" }
  $encrypted = (Get-Content -LiteralPath $TokenPath -Raw -Encoding UTF8).Trim()
  if ([string]::IsNullOrWhiteSpace($encrypted)) { throw 'The encrypted GitHub token is empty.' }
  $secureToken = $encrypted | ConvertTo-SecureString
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $credentialBytes = [Text.Encoding]::UTF8.GetBytes("${Username}:$token")
    $script:GitAuthorizationHeader = 'Authorization: Basic ' + [Convert]::ToBase64String($credentialBytes)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $token = $null
  }
}

function Invoke-Git(
  [string[]]$Arguments,
  [string]$WorkingDirectory = '',
  [int[]]$AllowedExitCodes = @(0)
) {
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $previousInteractive = $env:GCM_INTERACTIVE
  $previousPreference = $ErrorActionPreference
  try {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $effective = @()
    if ($script:GitAuthorizationHeader) {
      $effective += @('-c', "http.https://github.com/.extraheader=$($script:GitAuthorizationHeader)")
      $effective += @('-c', 'credential.helper=')
    }
    $effective += $Arguments
    $ErrorActionPreference = 'Continue'
    if ($WorkingDirectory) { $output = & git -C $WorkingDirectory @effective 2>&1 | Out-String }
    else { $output = & git @effective 2>&1 | Out-String }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
    $env:GCM_INTERACTIVE = $previousInteractive
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

function Test-SafeFile([System.IO.FileInfo]$File) {
  if ($File.Name -in @('desktop.ini', 'Thumbs.db', '.DS_Store') -or $File.Name.StartsWith('~$')) { return $false }
  if (($File.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  return $script:BlockedExtensions -notcontains $File.Extension.ToLowerInvariant()
}

function Get-FileMap([string]$Root) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Root)) { return $map }
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force | ForEach-Object {
    if (-not (Test-SafeFile $_)) { return }
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
  } catch {}
  return $hashes
}

function Get-PathToken([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()).Substring(0, 24)
}

function Record-LocalDeletion(
  [string]$ClonePath,
  [string]$RemoteSubdir,
  [string]$RelativePath,
  [string]$RemoteFile,
  [string]$RemoteHash
) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $recycleRelative = Join-Path "data\local-delete-recycle\$stamp\$RemoteSubdir" $RelativePath
  $recyclePath = Join-Path $ClonePath $recycleRelative
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($recyclePath))
  Move-Item -LiteralPath $RemoteFile -Destination $recyclePath -Force
  $tombstone = [ordered]@{
    version = 1
    origin = 'windows-local'
    relativePath = $RelativePath.Replace('\', '/')
    previousHash = $RemoteHash
    deletedAt = [DateTime]::UtcNow.ToString('o')
    recyclePath = $recycleRelative.Replace('\', '/')
  }
  $tombstonePath = Join-Path $ClonePath ("data\deletions\" + (Get-PathToken $RelativePath) + '.json')
  Write-JsonAtomic $tombstonePath $tombstone
}

function Move-UnsafeRemoteFiles([string]$ClonePath, [string]$RemotePath, [string]$RemoteSubdir) {
  if (-not (Test-Path -LiteralPath $RemotePath)) { return 0 }
  $count = 0
  Get-ChildItem -LiteralPath $RemotePath -File -Recurse -Force | ForEach-Object {
    if (Test-SafeFile $_) { return }
    $relative = Get-RelativeFilePath $RemotePath $_.FullName
    $quarantine = Join-Path $ClonePath (Join-Path 'data\quarantine' (Join-Path (Get-Date -Format 'yyyyMMdd-HHmmss') (Join-Path $RemoteSubdir $relative)))
    Ensure-Directory ([System.IO.Path]::GetDirectoryName($quarantine))
    Move-Item -LiteralPath $_.FullName -Destination $quarantine -Force
    $count += 1
  }
  return $count
}

function Add-DefaultQuestionSplittingConfig([object]$AiConfig, [string]$AiConfigPath) {
  if ($null -eq $AiConfig.tasks) { $AiConfig | Add-Member -NotePropertyName tasks -NotePropertyValue ([pscustomobject]@{}) }
  if ($null -eq $AiConfig.tasks.question_splitting) {
    $task = [ordered]@{
      enabled = $true
      fallback = $true
      difficulty = 'medium'
      temperature = 0.1
      timeoutMs = 90000
      customInstructions = '识别完整题目区域。每道题必须包含题号、完整题干、全部选项以及相关公式、表格和配图；不要把一道题拆成多个区域，也不要合并相邻的独立题目。'
      options = [ordered]@{
        maxQuestions = 24
        includeQuestionNumber = $true
        includeOptions = $true
        includeDiagram = $true
        edgePaddingPercent = 1.2
        minimumRegionPercent = 3.5
        maxTokens = 1600
      }
    }
    $AiConfig.tasks | Add-Member -NotePropertyName question_splitting -NotePropertyValue ([pscustomobject]$task)
    Write-JsonAtomic $AiConfigPath $AiConfig
  }
}

function Convert-ToSafeConfigValue([object]$Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [string] -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return $Value }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [System.Collections.IDictionary]) -and -not ($Value -is [pscustomobject])) {
    $items = @()
    foreach ($item in $Value) { $items += ,(Convert-ToSafeConfigValue $item) }
    return $items
  }
  $result = [ordered]@{}
  foreach ($property in $Value.PSObject.Properties) {
    $name = [string]$property.Name
    if ($name -match '(?i)api.?key|token|secret|password|authorization|headers|base.?url|proxy|local.*path|directory') { continue }
    $result[$name] = Convert-ToSafeConfigValue $property.Value
  }
  return [pscustomobject]$result
}

function Export-SafeAssistantConfiguration([string]$ClonePath, [string]$AssistantRoot) {
  Ensure-Directory (Join-Path $ClonePath 'data\config')
  $aiPath = Join-Path $AssistantRoot 'ai-providers.json'
  if (Test-Path -LiteralPath $aiPath) {
    $ai = Get-Content -LiteralPath $aiPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Add-DefaultQuestionSplittingConfig $ai $aiPath
    $safe = [ordered]@{
      schemaVersion = 1
      updatedAt = [DateTime]::UtcNow.ToString('o')
      sourceDevice = $env:COMPUTERNAME
      tasks = Convert-ToSafeConfigValue $ai.tasks
      routing = Convert-ToSafeConfigValue $ai.routing
    }
    Write-JsonAtomic (Join-Path $ClonePath 'data\config\global-ai-settings.json') $safe
  }
  $taxonomy = Join-Path $AssistantRoot 'note-taxonomy.json'
  if (Test-Path -LiteralPath $taxonomy) {
    Copy-Item -LiteralPath $taxonomy -Destination (Join-Path $ClonePath 'data\config\note-taxonomy.json') -Force
  }
}

function Get-SafeFileName([string]$Value, [string]$Fallback) {
  $name = ($Value -replace '[<>:"/\\|?*\x00-\x1f]', ' ' -replace '\s+', ' ').Trim().TrimEnd('.')
  if ([string]::IsNullOrWhiteSpace($name)) { $name = $Fallback }
  if ($name.Length -gt 72) { $name = $name.Substring(0, 72).Trim() }
  return $name
}

function Materialize-CloudNotes([string]$LocalPath, [string]$RemotePath) {
  $touchedSubjects = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  Get-ChildItem -LiteralPath $LocalPath -Filter '*.cloud-note.json' -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $cloudMetaPath = $_.FullName
      $metaDir = $_.DirectoryName
      if ([System.IO.Path]::GetFileName($metaDir) -ne '.metadata') { return }
      $subjectDir = [System.IO.Path]::GetDirectoryName($metaDir)
      $subjectName = [System.IO.Path]::GetFileName($subjectDir)
      $meta = Get-Content -LiteralPath $cloudMetaPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $meta.noteUid -or -not $meta.fileName) { return }
      $imagePath = Join-Path $subjectDir ([string]$meta.fileName)
      if (-not (Test-Path -LiteralPath $imagePath)) {
        $candidate = Get-ChildItem -LiteralPath $subjectDir -File -Force | Where-Object { $_.BaseName -eq [string]$meta.noteUid } | Select-Object -First 1
        if ($candidate) { $imagePath = $candidate.FullName } else { return }
      }
      $extension = [System.IO.Path]::GetExtension($imagePath)
      $shortUid = ([string]$meta.noteUid).Substring(0, [Math]::Min(8, ([string]$meta.noteUid).Length))
      $safeTitle = Get-SafeFileName ([string]$meta.title) '普通笔记'
      $desiredName = "${safeTitle}_${shortUid}${extension}"
      $oldRelative = Get-RelativeFilePath $LocalPath $imagePath
      if ([System.IO.Path]::GetFileName($imagePath) -ne $desiredName) {
        $desiredPath = Join-Path $subjectDir $desiredName
        if (-not (Test-Path -LiteralPath $desiredPath)) { Move-Item -LiteralPath $imagePath -Destination $desiredPath -Force }
        else { Remove-Item -LiteralPath $imagePath -Force }
        $remoteOld = Join-Path $RemotePath $oldRelative
        $remoteNew = Join-Path $RemotePath (Get-RelativeFilePath $LocalPath $desiredPath)
        if (Test-Path -LiteralPath $remoteOld) {
          Ensure-Directory ([System.IO.Path]::GetDirectoryName($remoteNew))
          if (-not (Test-Path -LiteralPath $remoteNew)) { Move-Item -LiteralPath $remoteOld -Destination $remoteNew -Force }
          else { Remove-Item -LiteralPath $remoteOld -Force }
        }
        $imagePath = $desiredPath
        $meta.fileName = $desiredName
      }
      $meta.updatedAt = [DateTime]::UtcNow.ToString('o')
      Write-JsonAtomic $cloudMetaPath $meta
      $relativeCloudMeta = Get-RelativeFilePath $LocalPath $cloudMetaPath
      Write-JsonAtomic (Join-Path $RemotePath $relativeCloudMeta) $meta
      $created = try { [DateTime]::Parse([string]$meta.createdAt) } catch { Get-Date }
      $sidecar = [ordered]@{
        schemaVersion = 2
        id = [string]$meta.noteUid
        noteUid = [string]$meta.noteUid
        kind = 'single'
        subject = $subjectName
        requestedSubject = $subjectName
        title = [string]$meta.title
        remark = [string]$meta.remark
        fileName = [System.IO.Path]::GetFileName($imagePath)
        filePath = $imagePath
        createdAt = $created.ToUniversalTime().ToString('o')
        updatedAt = [string]$meta.updatedAt
        source = [ordered]@{
          type = [string]$meta.sourceType
          batchId = [string]$meta.sourceBatchId
          splitIndex = $meta.sourceSplitIndex
          origin = 'cloudflare'
        }
        learning = [ordered]@{
          capturedDate = $created.ToString('yyyy-MM-dd')
          title = [string]$meta.title
          subject = $subjectName
          remark = [string]$meta.remark
          tags = @($meta.tags)
          noteType = if ($meta.noteType) { [string]$meta.noteType } else { 'note' }
          sourceType = [string]$meta.sourceType
          sourceBatchId = [string]$meta.sourceBatchId
          sourceSplitIndex = $meta.sourceSplitIndex
          organizationStatus = 'confirmed'
          classificationSource = 'local'
          reviewStatus = 'auto_applied'
          decisionRevision = 0
        }
      }
      $sidecarName = ([string]$meta.noteUid) + '.note.json'
      $localSidecar = Join-Path $metaDir $sidecarName
      Write-JsonAtomic $localSidecar $sidecar
      $remoteSidecar = Join-Path $RemotePath (Get-RelativeFilePath $LocalPath $localSidecar)
      $remoteSidecarValue = [ordered]@{} + $sidecar
      $remoteSidecarValue.filePath = (Get-RelativeFilePath $LocalPath $imagePath).Replace('\', '/')
      Write-JsonAtomic $remoteSidecar $remoteSidecarValue
      [void]$touchedSubjects.Add($subjectDir)
    } catch {}
  }
  foreach ($subjectDir in $touchedSubjects) {
    $metaDir = Join-Path $subjectDir '.metadata'
    $items = @()
    Get-ChildItem -LiteralPath $metaDir -Filter '*.note.json' -File -Force | Where-Object { $_.Name -notlike '*.cloud-note.json' } | ForEach-Object {
      try { $items += ,(Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json) } catch {}
    }
    $indexPath = Join-Path $metaDir 'metadata.json'
    Write-JsonAtomic $indexPath $items
    $remoteIndex = Join-Path $RemotePath (Get-RelativeFilePath $LocalPath $indexPath)
    $remoteItems = @()
    foreach ($item in $items) {
      $copy = $item | ConvertTo-Json -Depth 30 | ConvertFrom-Json
      if ($copy.fileName) { $copy.filePath = (Join-Path ([System.IO.Path]::GetFileName($subjectDir)) ([string]$copy.fileName)).Replace('\', '/') }
      $remoteItems += ,$copy
    }
    Write-JsonAtomic $remoteIndex $remoteItems
  }
}

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

if ($NativeCommandSelfTest) {
  Write-Host 'Native command self-test is no longer required; Git commands use explicit process-scoped authentication.'
  exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Sync configuration was not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$localPath = [Environment]::ExpandEnvironmentVariables([string]$config.localPath)
$assistantRoot = [Environment]::ExpandEnvironmentVariables($(if ($config.assistantRoot) { [string]$config.assistantRoot } else { 'C:\Users\ASUS\Desktop\考研桌面助手' }))
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
Ensure-Directory $assistantRoot
Set-GitAuthorizationFromTokenFile $tokenPath $githubUsername

$lockStream = $null
try { $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { exit 0 }

try {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git for Windows is not installed or is not available in PATH.' }
  if (-not (Test-Path -LiteralPath (Join-Path $clonePath '.git'))) {
    Ensure-Directory ([System.IO.Path]::GetDirectoryName($clonePath))
    if (Test-Path -LiteralPath $clonePath) { Remove-Item -LiteralPath $clonePath -Recurse -Force }
    Invoke-Git @('clone', '--single-branch', '--branch', $branch, "https://github.com/$repository.git", $clonePath) | Out-Null
  } else {
    Invoke-Git @('config', 'user.name', 'Kaoyan Global Data Sync') $clonePath | Out-Null
    Invoke-Git @('config', 'user.email', 'global-sync@local.invalid') $clonePath | Out-Null
    Commit-Pending $clonePath 'data: recover pending synchronized data' | Out-Null
    Invoke-Git @('pull', '--rebase', '--autostash', 'origin', $branch) $clonePath | Out-Null
  }
  Invoke-Git @('config', 'user.name', 'Kaoyan Global Data Sync') $clonePath | Out-Null
  Invoke-Git @('config', 'user.email', 'global-sync@local.invalid') $clonePath | Out-Null

  $remotePath = Join-Path $clonePath $remoteSubdir
  Ensure-Directory $remotePath
  $quarantined = Move-UnsafeRemoteFiles $clonePath $remotePath $remoteSubdir
  $previousHashes = Read-PreviousHashes $statePath
  $localFiles = Get-FileMap $localPath
  $remoteFiles = Get-FileMap $remotePath
  $relativePaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $localFiles.Keys) { [void]$relativePaths.Add([string]$key) }
  foreach ($key in $remoteFiles.Keys) { [void]$relativePaths.Add([string]$key) }

  $changedFiles = 0
  $conflicts = 0
  $deletedFiles = 0
  foreach ($relative in ($relativePaths | Sort-Object)) {
    $local = $localFiles[$relative]
    $remote = $remoteFiles[$relative]
    $previous = if ($previousHashes.ContainsKey($relative)) { $previousHashes[$relative] } else { '' }

    if ($null -eq $local -and $null -ne $remote) {
      if ($previous -and $remote.Hash -eq $previous) {
        Record-LocalDeletion $clonePath $remoteSubdir $relative $remote.FullName $remote.Hash
        $deletedFiles += 1
      } else {
        Copy-ToRelative $remote.FullName $localPath $relative
        $changedFiles += 1
      }
      continue
    }
    if ($null -ne $local -and $null -eq $remote) {
      Copy-ToRelative $local.FullName $remotePath $relative
      $changedFiles += 1
      continue
    }
    if ($null -eq $local -or $null -eq $remote -or $local.Hash -eq $remote.Hash) { continue }
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

  Materialize-CloudNotes $localPath $remotePath
  Export-SafeAssistantConfiguration $clonePath $assistantRoot
  $committed = Commit-Pending $clonePath "data: synchronize global notes and settings $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
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
  Write-JsonAtomic $statePath ([pscustomobject]@{ version = 3; updatedAt = $now; files = $stateFiles })
  Write-JsonAtomic $statusPath ([pscustomobject]@{
    ok = $true
    lastRunAt = $now
    localPath = $localPath
    assistantRoot = $assistantRoot
    repository = $repository
    branch = $branch
    remoteSubdir = $remoteSubdir
    trackedFiles = $stateFiles.Count
    changedFiles = $changedFiles
    deletedFiles = $deletedFiles
    conflicts = $conflicts
    quarantinedFiles = $quarantined
    committed = [bool]$committed
    authentication = 'dpapi-token'
    deletionPolicy = 'windows-local-authoritative'
    safeConfigPath = 'data/config/global-ai-settings.json'
  })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now OK tracked=$($stateFiles.Count) changed=$changedFiles deleted=$deletedFiles conflicts=$conflicts quarantined=$quarantined committed=$committed"
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
