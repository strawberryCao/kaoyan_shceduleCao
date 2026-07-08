$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DiagnosticsDir = Join-Path $ProjectRoot 'diagnostics'
$JsonPath = Join-Path $DiagnosticsDir 'env-report.json'
$TextPath = Join-Path $DiagnosticsDir 'env-report.txt'

New-Item -ItemType Directory -Force -Path $DiagnosticsDir | Out-Null

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Safe-Run($ScriptBlock) {
  try {
    return & $ScriptBlock
  } catch {
    return "ERROR: $($_.Exception.Message)"
  }
}

function Get-CommandVersion($Name, $Args) {
  if (-not (Test-Command $Name)) {
    return $null
  }
  return Safe-Run { & $Name @Args }
}

function Get-RegistryValue($Path, $Name) {
  return Safe-Run {
    $item = Get-ItemProperty -Path $Path -ErrorAction Stop
    return $item.$Name
  }
}

function Get-DisplayInfo {
  $screens = @()
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $index = 0
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
      $index += 1
      $bounds = $screen.Bounds
      $working = $screen.WorkingArea
      $screens += [ordered]@{
        index = $index
        primary = $screen.Primary
        deviceName = $screen.DeviceName
        bounds = [ordered]@{
          x = $bounds.X
          y = $bounds.Y
          width = $bounds.Width
          height = $bounds.Height
        }
        workingArea = [ordered]@{
          x = $working.X
          y = $working.Y
          width = $working.Width
          height = $working.Height
        }
      }
    }
  } catch {
    $screens += [ordered]@{ error = $_.Exception.Message }
  }
  return $screens
}

function Get-ScaleInfo {
  $scale = @{}
  try {
    $desktop = Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -ErrorAction Stop
    $scale.LogPixels = $desktop.LogPixels
    if ($desktop.LogPixels) {
      $scale.Percent = [math]::Round(($desktop.LogPixels / 96) * 100)
    }
    $scale.Win8DpiScaling = $desktop.Win8DpiScaling
  } catch {
    $scale.Error = $_.Exception.Message
  }
  return $scale
}

function Get-PortInfo($Port) {
  $result = [ordered]@{
    port = $Port
    listeners = @()
  }
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    foreach ($connection in $connections) {
      $processName = $null
      try {
        $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
      } catch {
        $processName = 'unknown'
      }
      $result.listeners += [ordered]@{
        localAddress = $connection.LocalAddress
        localPort = $connection.LocalPort
        owningProcess = $connection.OwningProcess
        processName = $processName
      }
    }
  } catch {
    $netstat = Safe-Run { netstat -ano | Select-String ":$Port" | ForEach-Object { $_.Line } }
    $result.netstat = $netstat
  }
  return $result
}

function Get-LivelyInfo {
  $info = [ordered]@{
    wingetList = $null
    installedPaths = @()
    possibleProcesses = @()
  }

  if (Test-Command 'winget') {
    $info.wingetList = Safe-Run { winget list --id rocksdanister.LivelyWallpaper --exact }
  }

  $candidatePaths = @(
    "$env:LOCALAPPDATA\Programs\Lively Wallpaper",
    "$env:LOCALAPPDATA\Microsoft\WindowsApps",
    "$env:ProgramFiles\Lively Wallpaper",
    "${env:ProgramFiles(x86)}\Lively Wallpaper"
  )

  foreach ($path in $candidatePaths) {
    if ($path -and (Test-Path $path)) {
      $info.installedPaths += $path
    }
  }

  try {
    $processes = Get-Process | Where-Object { $_.ProcessName -match 'Lively' }
    foreach ($process in $processes) {
      $info.possibleProcesses += [ordered]@{
        id = $process.Id
        processName = $process.ProcessName
        mainWindowTitle = $process.MainWindowTitle
      }
    }
  } catch {
    $info.processError = $_.Exception.Message
  }

  return $info
}

function Get-ProjectInfo {
  $info = [ordered]@{
    projectRoot = $ProjectRoot.Path
    packageJsonExists = Test-Path (Join-Path $ProjectRoot 'package.json')
    nodeModulesExists = Test-Path (Join-Path $ProjectRoot 'node_modules')
    distExists = Test-Path (Join-Path $ProjectRoot 'dist')
    currentBranch = $null
    gitStatus = $null
  }

  if (Test-Command 'git') {
    Push-Location $ProjectRoot
    try {
      $info.currentBranch = Safe-Run { git branch --show-current }
      $info.gitStatus = Safe-Run { git status --short }
    } finally {
      Pop-Location
    }
  }
  return $info
}

$report = [ordered]@{
  generatedAt = (Get-Date).ToString('s')
  note = 'This report avoids collecting file contents, browser data, passwords, tokens, or personal documents. It may include local paths and process names.'
  os = [ordered]@{
    caption = Safe-Run { (Get-CimInstance Win32_OperatingSystem).Caption }
    version = Safe-Run { (Get-CimInstance Win32_OperatingSystem).Version }
    buildNumber = Safe-Run { (Get-CimInstance Win32_OperatingSystem).BuildNumber }
    architecture = Safe-Run { (Get-CimInstance Win32_OperatingSystem).OSArchitecture }
    computerSystem = Safe-Run { (Get-CimInstance Win32_ComputerSystem | Select-Object -Property Manufacturer,Model,SystemType | ConvertTo-Json -Compress) }
  }
  shell = [ordered]@{
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    executionPolicy = Safe-Run { Get-ExecutionPolicy }
    processArchitecture = if ([Environment]::Is64BitProcess) { '64-bit' } else { '32-bit' }
  }
  commands = [ordered]@{
    git = Get-CommandVersion 'git' @('--version')
    node = Get-CommandVersion 'node' @('--version')
    npm = Get-CommandVersion 'npm' @('--version')
    npx = Get-CommandVersion 'npx' @('--version')
    winget = Get-CommandVersion 'winget' @('--version')
  }
  display = [ordered]@{
    screens = Get-DisplayInfo
    scale = Get-ScaleInfo
  }
  network = [ordered]@{
    port5173 = Get-PortInfo 5173
    port4173 = Get-PortInfo 4173
  }
  lively = Get-LivelyInfo
  project = Get-ProjectInfo
  packageManager = [ordered]@{
    npmConfigRegistry = Safe-Run { npm config get registry }
  }
}

$json = $report | ConvertTo-Json -Depth 8
Set-Content -Path $JsonPath -Value $json -Encoding UTF8

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('Kaoyan Schedule App Environment Report')
$lines.Add('======================================')
$lines.Add("GeneratedAt: $($report.generatedAt)")
$lines.Add('')
$lines.Add('OS')
$lines.Add("- Caption: $($report.os.caption)")
$lines.Add("- Version: $($report.os.version)")
$lines.Add("- Build: $($report.os.buildNumber)")
$lines.Add("- Architecture: $($report.os.architecture)")
$lines.Add('')
$lines.Add('Shell')
$lines.Add("- PowerShell: $($report.shell.powershellVersion)")
$lines.Add("- ExecutionPolicy: $($report.shell.executionPolicy)")
$lines.Add("- ProcessArchitecture: $($report.shell.processArchitecture)")
$lines.Add('')
$lines.Add('Commands')
$lines.Add("- git: $($report.commands.git)")
$lines.Add("- node: $($report.commands.node)")
$lines.Add("- npm: $($report.commands.npm)")
$lines.Add("- npx: $($report.commands.npx)")
$lines.Add("- winget: $($report.commands.winget)")
$lines.Add('')
$lines.Add('Display')
foreach ($screen in $report.display.screens) {
  if ($screen.error) {
    $lines.Add("- error: $($screen.error)")
  } else {
    $lines.Add("- screen $($screen.index): primary=$($screen.primary), bounds=$($screen.bounds.width)x$($screen.bounds.height)+$($screen.bounds.x)+$($screen.bounds.y), work=$($screen.workingArea.width)x$($screen.workingArea.height)+$($screen.workingArea.x)+$($screen.workingArea.y)")
  }
}
$lines.Add("- scale: $($report.display.scale | ConvertTo-Json -Compress)")
$lines.Add('')
$lines.Add('Ports')
$lines.Add("- 5173: $($report.network.port5173 | ConvertTo-Json -Compress)")
$lines.Add("- 4173: $($report.network.port4173 | ConvertTo-Json -Compress)")
$lines.Add('')
$lines.Add('Lively')
$lines.Add("- wingetList: $($report.lively.wingetList)")
$lines.Add("- installedPaths: $($report.lively.installedPaths -join '; ')")
$lines.Add("- possibleProcesses: $($report.lively.possibleProcesses | ConvertTo-Json -Compress)")
$lines.Add('')
$lines.Add('Project')
$lines.Add("- projectRoot: $($report.project.projectRoot)")
$lines.Add("- packageJsonExists: $($report.project.packageJsonExists)")
$lines.Add("- nodeModulesExists: $($report.project.nodeModulesExists)")
$lines.Add("- distExists: $($report.project.distExists)")
$lines.Add("- currentBranch: $($report.project.currentBranch)")
$lines.Add("- gitStatus: $($report.project.gitStatus)")
$lines.Add('')
$lines.Add('npm')
$lines.Add("- registry: $($report.packageManager.npmConfigRegistry)")

Set-Content -Path $TextPath -Value $lines -Encoding UTF8

Write-Host 'Environment report generated:' -ForegroundColor Green
Write-Host $TextPath
Write-Host $JsonPath
Write-Host ''
Write-Host 'Send env-report.txt to ChatGPT first. If needed, also send env-report.json.' -ForegroundColor Cyan
