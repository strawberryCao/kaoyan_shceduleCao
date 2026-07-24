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
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  Write-Utf8NoBom $temporary (($Value | ConvertTo-Json -Depth 50) + "`n")
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-Property([object]$Object, [string]$Name, [object]$DefaultValue = $null) {
  if ($null -eq $Object) { return $DefaultValue }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $DefaultValue }
  return $property.Value
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

function Copy-DirectoryContent([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "Export directory was not created: $Source" }
  $temporary = "$Destination.next.$PID"
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  Ensure-Directory $temporary
  Copy-Item -Path (Join-Path $Source '*') -Destination $temporary -Recurse -Force
  Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $temporary -Destination $Destination
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Sync configuration was not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$assistantRoot = [Environment]::ExpandEnvironmentVariables([string](Get-Property $config 'assistantRoot' 'C:\Users\ASUS\Desktop\考研桌面助手'))
$repository = [string](Get-Property $config 'repository' 'strawberryCao/Caobijidata')
$branch = [string](Get-Property $config 'branch' 'main')
$clonePath = [Environment]::ExpandEnvironmentVariables([string](Get-Property $config 'clonePath' 'D:\kaoyandata\Caobijidata'))
$tokenPath = [Environment]::ExpandEnvironmentVariables([string](Get-Property $config 'tokenPath' 'D:\kaoyandata\NoteFolderSync\github-token.dpapi'))
$githubUsername = [string](Get-Property $config 'githubUsername' 'strawberryCao')
$workRoot = [System.IO.Path]::GetDirectoryName($ConfigPath)
$exporterPath = [Environment]::ExpandEnvironmentVariables([string](Get-Property $config 'agentRuntimeExporter' (Join-Path $workRoot 'export-agent-runtime.cjs')))
$statusPath = Join-Path $workRoot 'config-status.json'
$logPath = Join-Path $workRoot 'sync.log'
$lockPath = Join-Path $workRoot 'config-sync.lock'
$exportRoot = Join-Path $workRoot 'agent-runtime-export'

Ensure-Directory $workRoot
Ensure-Directory $assistantRoot
Set-GitAuthorizationFromTokenFile $tokenPath $githubUsername

$lockStream = $null
try { $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { exit 0 }

try {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git for Windows is not installed or is not available in PATH.' }
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
  if (-not (Test-Path -LiteralPath $exporterPath)) { throw "Agent runtime exporter was not found: $exporterPath" }

  Remove-Item -LiteralPath $exportRoot -Recurse -Force -ErrorAction SilentlyContinue
  $exportOutput = & $nodeCommand.Source $exporterPath '--assistant-root' $assistantRoot '--output-root' $exportRoot 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Agent runtime export failed.`n$($exportOutput.Trim())" }
  $exportResult = $exportOutput.Trim() | ConvertFrom-Json
  $manifestPath = Join-Path $exportRoot 'manifest.json'
  $runtimePath = Join-Path $exportRoot 'agent-runtime.json'
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $runtimePath)) {
    throw 'Agent runtime export did not produce manifest.json and agent-runtime.json.'
  }

  if (-not (Test-Path -LiteralPath (Join-Path $clonePath '.git'))) {
    Ensure-Directory ([System.IO.Path]::GetDirectoryName($clonePath))
    if (Test-Path -LiteralPath $clonePath) { Remove-Item -LiteralPath $clonePath -Recurse -Force }
    Invoke-Git @('clone', '--single-branch', '--branch', $branch, "https://github.com/$repository.git", $clonePath) | Out-Null
  } else {
    Invoke-Git @('pull', '--rebase', '--autostash', 'origin', $branch) $clonePath | Out-Null
  }
  Invoke-Git @('config', 'user.name', 'Kaoyan Assistant Config Sync') $clonePath | Out-Null
  Invoke-Git @('config', 'user.email', 'assistant-config-sync@local.invalid') $clonePath | Out-Null

  $remoteRoot = Join-Path $clonePath 'data\config\local-assistant'
  Copy-DirectoryContent $exportRoot $remoteRoot
  Invoke-Git @('add', '--', 'data/config/local-assistant') $clonePath | Out-Null
  $diff = Invoke-Git @('diff', '--cached', '--quiet', '--', 'data/config/local-assistant') $clonePath @(0, 1)
  $committed = $false
  if ($diff.ExitCode -eq 1) {
    Invoke-Git @('commit', '-m', "config: publish local Agent runtime $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") $clonePath | Out-Null
    Invoke-Git @('push', 'origin', "HEAD:$branch") $clonePath | Out-Null
    $committed = $true
  }

  $manifest = Get-Content -LiteralPath (Join-Path $remoteRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $runtime = Get-Content -LiteralPath (Join-Path $remoteRoot 'agent-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $now = [DateTime]::UtcNow.ToString('o')
  Write-JsonAtomic $statusPath ([pscustomobject]@{
    ok = $true
    lastRunAt = $now
    direction = 'local-to-github-only'
    localConfigurationWasOverwritten = $false
    assistantRoot = $assistantRoot
    repository = $repository
    branch = $branch
    committed = $committed
    runtimeHash = [string]$manifest.runtimeHash
    workflowHash = [string]$runtime.source.workflowHash
    generatedFromJsonFiles = [int]$manifest.generatedFromJsonFiles
    includedFiles = [int]$manifest.includedFiles
    excludedFiles = [int]$manifest.excludedFiles
    configuredTasks = @($runtime.tasks.PSObject.Properties.Name)
    providerSecretRefs = @($runtime.providers.PSObject.Properties | ForEach-Object { $_.Value.secretRef })
    remotePath = 'data/config/local-assistant'
  })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now CONFIG_OK committed=$committed runtimeHash=$($manifest.runtimeHash) included=$($manifest.includedFiles) excluded=$($manifest.excludedFiles)"
} catch {
  $now = [DateTime]::UtcNow.ToString('o')
  $message = $_.Exception.Message
  Write-JsonAtomic $statusPath ([pscustomobject]@{ ok = $false; lastRunAt = $now; direction = 'local-to-github-only'; error = $message })
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$now CONFIG_ERROR $message"
  throw
} finally {
  $script:GitAuthorizationHeader = ''
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
