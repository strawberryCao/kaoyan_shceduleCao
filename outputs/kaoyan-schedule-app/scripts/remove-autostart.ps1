$ErrorActionPreference = 'Stop'

$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'Kaoyan Schedule Wallpaper Server.lnk'

if (Test-Path $ShortcutPath) {
  Remove-Item $ShortcutPath -Force
  Write-Host 'Autostart shortcut removed:' -ForegroundColor Green
  Write-Host $ShortcutPath
} else {
  Write-Host 'Autostart shortcut was not found.' -ForegroundColor Yellow
}
