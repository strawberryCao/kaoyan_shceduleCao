@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo Starting dependency installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1"

if errorlevel 1 (
  echo.
  echo Dependency installation failed. Please send the error output to ChatGPT.
  pause
  exit /b 1
)

echo.
echo Dependency installation completed.
pause
