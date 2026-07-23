$ErrorActionPreference = 'Continue'

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DiagnosticsDir = Join-Path $ProjectRoot 'diagnostics'
$ReportPath = Join-Path $DiagnosticsDir 'env-report.txt'

New-Item -ItemType Directory -Force -Path $DiagnosticsDir | Out-Null

function Add-Line($Text) {
  Add-Content -Path $ReportPath -Value $Text -Encoding UTF8
}

function Step($Text) {
  Write-Host "==> $Text" -ForegroundColor Cyan
  Add-Line ""
  Add-Line "==> $Text"
}

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Run-Quick($Name, $ArgText) {
  if (-not (Has-Command $Name)) {
    return 'NOT_FOUND'
  }

  try {
    $job = Start-Job -ScriptBlock {
      param($CommandLine)
      cmd.exe /c $CommandLine 2>&1
    } -ArgumentList "$Name $ArgText"

    $finished = Wait-Job $job -Timeout 5
    if (-not $finished) {
      Stop-Job $job -Force | Out-Null
      Remove-Job $job -Force | Out-Null
      return 'TIMEOUT_AFTER_5S'
    }

    $out = Receive-Job $job | Out-String
    Remove-Job $job -Force | Out-Null
    if ([string]::IsNullOrWhiteSpace($out)) {
      return 'OK_NO_OUTPUT'
    }
    return $out.Trim()
  } catch {
    return "ERROR: $($_.Exception.Message)"
  }
}

Set-Content -Path $ReportPath -Value @(
  'Kaoyan Schedule App Environment Report',
  '======================================',
  "GeneratedAt: $((Get-Date).ToString('s'))",
  "ProjectRoot: $($ProjectRoot.Path)"
) -Encoding UTF8

Step 'PowerShell'
Add-Line "Version: $($PSVersionTable.PSVersion.ToString())"
Add-Line "ExecutionPolicy: $(Get-ExecutionPolicy)"
Add-Line "Is64BitProcess: $([Environment]::Is64BitProcess)"

Step 'Windows'
try {
  $os = Get-WmiObject Win32_OperatingSystem
  Add-Line "Caption: $($os.Caption)"
  Add-Line "Version: $($os.Version)"
  Add-Line "BuildNumber: $($os.BuildNumber)"
  Add-Line "OSArchitecture: $($os.OSArchitecture)"
} catch {
  Add-Line "WindowsInfoError: $($_.Exception.Message)"
}

Step 'Commands'
Add-Line "git: $(Run-Quick 'git' '--version')"
Add-Line "node: $(Run-Quick 'node' '--version')"
Add-Line "npm: $(Run-Quick 'npm' '--version')"
Add-Line "winget: $(Run-Quick 'winget' '--version')"

Step 'Display'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $i = 0
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $i += 1
    $b = $screen.Bounds
    $w = $screen.WorkingArea
    Add-Line "Screen${i}: Primary=$($screen.Primary), Bounds=$($b.Width)x$($b.Height)+$($b.X)+$($b.Y), WorkArea=$($w.Width)x$($w.Height)+$($w.X)+$($w.Y)"
  }
} catch {
  Add-Line "DisplayError: $($_.Exception.Message)"
}

Step 'Ports'
Add-Line "Port5173: $(Run-Quick 'netstat' '-ano | findstr :5173')"
Add-Line "Port4173: $(Run-Quick 'netstat' '-ano | findstr :4173')"

Step 'Lively'
Add-Line "LivelyWinget: $(Run-Quick 'winget' 'list --id rocksdanister.LivelyWallpaper --exact')"

Step 'Project'
Add-Line "PackageJsonExists: $(Test-Path (Join-Path $ProjectRoot 'package.json'))"
Add-Line "NodeModulesExists: $(Test-Path (Join-Path $ProjectRoot 'node_modules'))"
Add-Line "DistExists: $(Test-Path (Join-Path $ProjectRoot 'dist'))"
Push-Location $ProjectRoot
try {
  Add-Line "GitBranch: $(Run-Quick 'git' 'branch --show-current')"
  Add-Line "GitStatus: $(Run-Quick 'git' 'status --short')"
} finally {
  Pop-Location
}

Step 'Done'
Add-Line "ReportPath: $ReportPath"
Write-Host ""
Write-Host "Report generated:" -ForegroundColor Green
Write-Host $ReportPath
