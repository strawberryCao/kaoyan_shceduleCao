[CmdletBinding()]
param(
  [string]$ConfigPath = 'D:\kaoyandata\NoteFolderSync\config.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:GitAuthorizationHeader = ''

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
  Write-Utf8NoBom $temporary (($Value | ConvertTo-Json -Depth 50) + "`n")
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
    if ($name -match '(?i)api.?key|token|secret|password|authorization|headers|base.?url|endpoint|proxy|local.*path|directory') { continue }
    $result[$name] = Convert-ToSafeConfigValue $property.Value
  }
  return [pscustomobject]$result
}

function Ensure-QuestionSplittingTask([object]$AiConfig, [string]$AiConfigPath) {
  $changed = $false
  if ($null -eq $AiConfig.tasks) {
    $AiConfig | Add-Member -NotePropertyName tasks -NotePropertyValue ([pscustomobject]@{})
    $changed = $true
  }
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
    $changed = $true
  }
  if ($changed) { Write-JsonAtomic $AiConfigPath $AiConfig }
  return $changed
}

function Comparable-Json([object]$Value) {
  return ($Value | ConvertTo-Json -Depth 50 -Compress)
}

function Read-ExistingConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { return $null }
}

function Get-FileHashOrEmpty([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Sync configuration was not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$assistantRoot = [Environment]::ExpandEnvironmentVariables($(if ($config.assistantRoot) { [string]$config.assistantRoot } else { 'C:\Users\ASUS\Desktop\考研桌面助手' }))
$repository = [string]$config.repository
$branch = [string]$config.branch
$clonePath = [Environment]::ExpandEnvironmentVariables([string]$config.clonePath)
$tokenPath = [Environment]::ExpandEnvironmentVariables([string]$config.tokenPath)
$githubUsername = if ($config.githubUsername) { [string]$config.githubUsername } else { 'strawberryCao' }
$workRoot = [System.IO.Path]::GetDirectoryName($ConfigPath)
$statusPath = Join-Path $workRoot 'config-status.json'
$logPath = Join-Path $workRoot 'sync.log'
$lockPath = Join-Path $workRoot 'sync.lock'

Ensure-Directory $workRoot
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
    Invoke-Git @('pull', '--rebase', '--autostash', 'origin', $branch) $clonePath | Out-Null
  }
  Invoke-Git @('config', 'user.name', 'Kaoyan Assistant Config Sync') $clonePath | Out-Null
  Invoke-Git @('config', 'user.email', 'assistant-config-sync@local.invalid') $clonePath | Out-Null

  $configRoot = Join-Path $clonePath 'data\config'
  Ensure-Directory $configRoot
  $changed = $false
  $aiConfigPath = Join-Path $assistantRoot 'ai-providers.json'
  if (Test-Path -LiteralPath $aiConfigPath) {
    $aiConfig = Get-Content -LiteralPath $aiConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    [void](Ensure-QuestionSplittingTask $aiConfig $aiConfigPath)
    $core = [ordered]@{
      schemaVersion = 1
      tasks = Convert-ToSafeConfigValue $aiConfig.tasks
      routing = Convert-ToSafeConfigValue $aiConfig.routing
    }
    $remoteAiPath = Join-Path $configRoot 'global-ai-settings.json'
    $existing = Read-ExistingConfig $remoteAiPath
    $existingCore = if ($null -eq $existing) { $null } else {
      [ordered]@{
        schemaVersion = 1
        tasks = $existing.tasks
        routing = $existing.routing
      }
    }
    if ($null -eq $existingCore -or (Comparable-Json $core) -ne (Comparable-Json $existingCore)) {
      $payload = [ordered]@{
        schemaVersion = 1
        updatedAt = [DateTime]::UtcNow.ToString('o')
        tasks = $core.tasks
        routing = $core.routing
      }
      Write-JsonAtomic $remoteAiPath $payload
      $changed = $true
    }
  }

  $localTaxonomyPath = Join-Path $assistantRoot 'note-taxonomy.json'
  if (Test-Path -LiteralPath $localTaxonomyPath) {
    $remoteTaxonomyPath = Join-Path $configRoot 'note-taxonomy.json'
    if ((Get-FileHashOrEmpty $localTaxonomyPath) -ne (Get-FileHashOrEmpty $remoteTaxonomyPath)) {
      Copy-Item -LiteralPath $localTaxonomyPath -Destination $remoteTaxonomyPath -Force
      $changed = $true
    }
  }

  $committed = $false
  if ($changed) {
    Invoke-Git @('add', '--', 'data/config') $clonePath | Out-Null
    $diff = Invoke-Git @('diff', '--cached', '--quiet', '--', 'data/config') $clonePath @(0, 1)
    if ($diff.ExitCode -eq 1) {
      Invoke-Git @('commit', '-m', "config: synchronize sanitized assistant settings $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") $clonePath | Out-Null
      Invoke-Git @('push', 'origin', "HEAD:$branch") $clonePath | Out-Null
      $committed = $true
    }
  }

  $now = [DateTime]::UtcNow.ToString('o')
  Write-JsonAtomic $statusPath ([pscustomobject]@{
    ok = $true
    lastRunAt = $now
    assistantRoot = $assistantRoot
    repository = $repository
    branch = $branch
    changed = $changed
    committed = $committed
    synchronizedFiles = @('data/config/global-ai-settings.json', 'data/config/note-taxonomy.json')
    excludedSecrets = @('apiKey', 'token', 'password', 'authorization', 'headers', 'baseUrl', 'endpoint', 'proxy', 'localPath')
  })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now CONFIG_OK changed=$changed committed=$committed"
} catch {
  $now = [DateTime]::UtcNow.ToString('o')
  $message = $_.Exception.Message
  Write-JsonAtomic $statusPath ([pscustomobject]@{ ok = $false; lastRunAt = $now; error = $message })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now CONFIG_ERROR $message"
  throw
} finally {
  $script:GitAuthorizationHeader = ''
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
