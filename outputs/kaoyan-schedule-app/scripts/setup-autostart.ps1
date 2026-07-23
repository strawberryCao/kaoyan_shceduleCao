$ErrorActionPreference = 'Stop'

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'Kaoyan Schedule Wallpaper Server.lnk'
$ServerScript = Join-Path $ProjectRoot 'scripts\start-wallpaper-server.ps1'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $PowerShellExe
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ServerScript`""
$Shortcut.WorkingDirectory = $ProjectRoot.Path
$Shortcut.IconLocation = $PowerShellExe
$Shortcut.Description = 'Start Kaoyan Schedule wallpaper local server'
$Shortcut.Save()

Write-Host 'Autostart shortcut created:' -ForegroundColor Green
Write-Host $ShortcutPath
Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Write-Host '1. Enable Start with Windows in Lively Wallpaper settings.'
Write-Host '2. Add this URL in Lively Wallpaper: http://127.0.0.1:5173/?wallpaper=1'
Write-Host '3. After reboot, the local server should start automatically.'
