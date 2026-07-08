@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo Starting Kaoyan Desktop Assistant...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please check your Node.js installation.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Restarting local servers so the latest code is used...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":5173 .*LISTENING"') do taskkill /PID %%a /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":5174 .*LISTENING"') do taskkill /PID %%a /F >nul 2>nul
timeout /t 1 >nul

echo Starting note save/layout server on 5174...
start "Kaoyan Note Server" /min node "%~dp0scripts\note-server.cjs"

echo Starting web server on 5173...
start "Kaoyan Web Server" /min npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort

timeout /t 4 >nul

echo.
echo Opening unified hub...
start "" "http://127.0.0.1:5173/?hub=1"

echo.
echo Hub:       http://127.0.0.1:5173/?hub=1
echo Wallpaper: http://127.0.0.1:5173/?wallpaper=1
echo Console:   http://127.0.0.1:5173/?console=1
echo Notes:     http://127.0.0.1:5173/?notes=1
echo Health:    http://127.0.0.1:5174/health
echo.
echo This launcher restarts ports 5173 and 5174 to avoid running stale code.
echo You can close this window. The servers were started in minimized windows.
pause
