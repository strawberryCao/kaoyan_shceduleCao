@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo Removing autostart for wallpaper local server...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove-autostart.ps1"

if errorlevel 1 (
  echo.
  echo Failed to remove autostart. Please send the error output to ChatGPT.
  pause
  exit /b 1
)

echo.
echo Autostart removal completed.
pause
