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

echo Starting optimized Kaoyan Schedule App...
call "%~dp0scripts\start-note-app.cmd" --services-only
if errorlevel 1 exit /b 1

start "" "http://127.0.0.1:5173/"
