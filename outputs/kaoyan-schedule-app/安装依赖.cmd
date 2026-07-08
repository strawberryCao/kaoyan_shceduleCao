@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo 正在启动依赖安装脚本...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1"

if errorlevel 1 (
  echo.
  echo 依赖安装失败。请把上面的报错截图或复制给 ChatGPT。
  pause
  exit /b 1
)

echo.
echo 依赖安装完成。
pause
