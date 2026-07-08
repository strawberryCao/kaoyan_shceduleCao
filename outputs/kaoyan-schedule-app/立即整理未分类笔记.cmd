@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo 正在整理默认文件夹中的未分类笔记...
echo 路径：%USERPROFILE%\Desktop\笔记\默认文件夹
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\classify-notes.cjs"

echo.
echo 整理结束。日志位置：%USERPROFILE%\Desktop\考研桌面助手\classify-notes.log
echo.
pause
