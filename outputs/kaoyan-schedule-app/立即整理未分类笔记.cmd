@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo 正在智能整理全部笔记...
echo 将识别知识点、错因和背诵意图，并同步课表与卡片。
echo 目录深度固定为：科目\一级知识点
echo 路径：%USERPROFILE%\Desktop\笔记
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\organize-notes.cjs" --force

echo.
echo 整理结束。状态位置：%USERPROFILE%\Desktop\考研桌面助手\note-organizer-state.json
echo 移动恢复日志：%USERPROFILE%\Desktop\考研桌面助手\note-organizer-moves.jsonl
echo.
pause
