@echo off
setlocal

cd /d "%~dp0.."

if /i "%~1"=="--check" (
  if not exist node_modules\electron\dist\electron.exe exit /b 1
  if not exist node_modules\.bin\wait-on.cmd exit /b 1
  echo Compact note launcher is ready.
  exit /b 0
)

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

if not exist node_modules\electron\dist\electron.exe (
  echo Electron is missing. Installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo Electron installation failed.
    pause
    exit /b 1
  )
)

if not exist node_modules\.bin\wait-on.cmd (
  echo Startup helper is missing. Installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /R /C:":5174 .*LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Kaoyan Note Server" /min node "scripts\note-server.cjs"
)

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Kaoyan Wallpaper Server" /min npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
)

echo Waiting for local services...
call "node_modules\.bin\wait-on.cmd" --timeout 20000 "http-get://127.0.0.1:5173/" "http-get://127.0.0.1:5174/health"
if errorlevel 1 (
  echo Local services did not become ready. Please close this window and try again.
  pause
  exit /b 1
)

if /i "%~1"=="--services-only" exit /b 0

start "" "node_modules\electron\dist\electron.exe" "." --note-app
exit /b %errorlevel%
