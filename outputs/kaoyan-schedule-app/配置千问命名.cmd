@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\configure-qwen.cjs"

if errorlevel 1 (
  echo.
  echo 配置失败。请把上面的错误发给 ChatGPT。
  pause
  exit /b 1
)

echo.
echo 配置完成。
pause
