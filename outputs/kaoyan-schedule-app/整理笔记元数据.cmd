@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo 正在把散在科目文件夹里的 JSON 收进 .metadata 文件夹...
echo 路径：%USERPROFILE%\Desktop\笔记
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\migrate-note-metadata.cjs"

echo.
echo 整理结束。日志位置：%USERPROFILE%\Desktop\考研桌面助手\migrate-note-metadata.log
echo.
pause
