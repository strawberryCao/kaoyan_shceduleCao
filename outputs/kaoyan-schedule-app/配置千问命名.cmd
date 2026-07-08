@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-qwen.ps1"

if errorlevel 1 (
  echo.
  echo Qwen configuration failed. Please send the error output to ChatGPT.
  pause
  exit /b 1
)

echo.
echo Qwen configuration completed.
pause
