@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo Collecting local environment information...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\collect-env.ps1"

if errorlevel 1 (
  echo.
  echo Failed to collect environment information. Please send the error output to ChatGPT.
  pause
  exit /b 1
)

echo.
echo Done. Open diagnostics\env-report.txt and send it to ChatGPT.
pause
