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

echo Starting local server for Lively Wallpaper...
echo.
echo Wallpaper URL for Lively:
echo http://127.0.0.1:5173/?wallpaper=1
echo.
echo Management URL for browser:
echo http://127.0.0.1:5173/
echo.
echo Keep this window open while using the wallpaper.
echo Do NOT use this URL as a normal browser wallpaper window.
echo Add the wallpaper URL inside Lively Wallpaper instead.
echo.

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Port 5173 is already running. Add the wallpaper URL in Lively Wallpaper.
  pause
  exit /b 0
)

call npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort

pause
