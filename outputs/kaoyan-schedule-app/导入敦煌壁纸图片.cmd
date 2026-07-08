@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo 请选择你要作为敦煌动态桌面底图的图片。
echo 推荐选择 7 号那张原图 PNG/JPG。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -AssemblyName System.Windows.Forms;" ^
  "$dialog = New-Object System.Windows.Forms.OpenFileDialog;" ^
  "$dialog.Title = '选择敦煌桌面壁纸图片';" ^
  "$dialog.Filter = 'Image Files (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All Files (*.*)|*.*';" ^
  "if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 };" ^
  "$publicDir = Join-Path (Get-Location) 'public';" ^
  "New-Item -ItemType Directory -Force -Path $publicDir | Out-Null;" ^
  "$target = Join-Path $publicDir 'dunhuang-wallpaper.png';" ^
  "Copy-Item -LiteralPath $dialog.FileName -Destination $target -Force;" ^
  "Write-Host '';" ^
  "Write-Host ('已导入：' + $target);" ^
  "Write-Host '请刷新壁纸页面，或重新启动：启动考研桌面助手.cmd';"

if errorlevel 2 (
  echo 已取消导入。
  pause
  exit /b 1
)

echo.
echo 导入完成。壁纸页面会优先使用：public\dunhuang-wallpaper.png
echo.
pause
