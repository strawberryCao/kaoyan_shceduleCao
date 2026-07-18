@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
call scripts\start-note-app.cmd %*
exit /b %errorlevel%
