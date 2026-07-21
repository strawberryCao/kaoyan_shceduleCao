@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TEST_ARGS=%*"
if "%~1"=="" (
  netstat -ano | findstr /R /C:"127.0.0.1:7897 .*LISTENING" >nul
  if not errorlevel 1 set "TEST_ARGS=--proxy=http://127.0.0.1:7897"
)
node "scripts\test-gemini.cjs" %TEST_ARGS%
echo.
pause
