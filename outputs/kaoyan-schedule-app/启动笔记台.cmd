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
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /R /C:":5174 .*LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Kaoyan Note Server" /min node "%~dp0scripts\note-server.cjs"
)

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Kaoyan Wallpaper Server" /min npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
  timeout /t 3 >nul
)

start "" "http://127.0.0.1:5173/?notes=1"
