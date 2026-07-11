@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "TARGET=%~dp0public\dunhuang-reference.mp4"
set "SOURCE="

if exist "%USERPROFILE%\Downloads\ce23349f07467f40911d33ca2a59107c_raw.mp4" set "SOURCE=%USERPROFILE%\Downloads\ce23349f07467f40911d33ca2a59107c_raw.mp4"
if not defined SOURCE if exist "%USERPROFILE%\Desktop\ce23349f07467f40911d33ca2a59107c_raw.mp4" set "SOURCE=%USERPROFILE%\Desktop\ce23349f07467f40911d33ca2a59107c_raw.mp4"

if not defined SOURCE (
  for /f "usebackq delims=" %%F in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '选择敦煌动态壁纸参考视频'; $dialog.Filter = 'MP4 视频 (*.mp4)|*.mp4|所有文件 (*.*)|*.*'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }"`) do set "SOURCE=%%F"
)

if not defined SOURCE (
  echo 未选择视频，操作已取消。
  pause
  exit /b 1
)

if not exist "!SOURCE!" (
  echo 找不到视频文件：!SOURCE!
  pause
  exit /b 1
)

if not exist "%~dp0public" mkdir "%~dp0public"
copy /Y "!SOURCE!" "%TARGET%" >nul
if errorlevel 1 (
  echo 视频导入失败。
  pause
  exit /b 1
)

echo.
echo 动态壁纸视频已导入：
echo %TARGET%
echo.
echo 请重新启动“启动考研桌面助手.cmd”，壁纸会优先播放这个视频。
pause
