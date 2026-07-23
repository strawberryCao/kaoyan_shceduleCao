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
    echo Dependency installation failed. Please check your network or npm config.
    pause
    exit /b 1
  )
)

echo Starting note save server...
netstat -ano | findstr /R /C:":5174 .*LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Kaoyan Note Server" /min node "%~dp0scripts\note-server.cjs"
) else (
  echo Port 5174 is already running.
)

echo Starting local server for Lively Wallpaper...
echo.
echo Wallpaper URL for Lively:
echo http://127.0.0.1:5173/?wallpaper=1
echo.
echo Management URL for browser:
echo http://127.0.0.1:5173/
echo.
echo Note server:
echo http://127.0.0.1:5174/health
echo.
echo Keep this window open while using the wallpaper.
echo Do NOT use this URL as a normal browser wallpaper window.
echo Add the wallpaper URL inside Lively Wallpaper instead.
echo.

call "%~dp0scripts\start-note-app.cmd" --services-only
if errorlevel 1 exit /b 1

echo Optimized wallpaper service is ready. Add the wallpaper URL in Lively Wallpaper.
pause
