@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "AI_DIR=%USERPROFILE%\Desktop\考研桌面助手"
set "AI_CONFIG=%AI_DIR%\ai-providers.json"

if not exist "%AI_DIR%" mkdir "%AI_DIR%"
if not exist "%AI_CONFIG%" copy /Y "%~dp0scripts\ai-providers.example.json" "%AI_CONFIG%" >nul

echo 即将打开私有 AI 配置：
echo %AI_CONFIG%
echo.
echo 请填写 Gemini 和 Kimi 的 apiKey 与实际模型名。
echo 千问仍兼容原来的 配置千问命名.cmd，不需要重复填写。
echo 密钥文件位于桌面助手数据目录，不会写入项目或前端。
echo.
start "" notepad.exe "%AI_CONFIG%"
pause