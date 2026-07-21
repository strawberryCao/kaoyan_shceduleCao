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

node "scripts\local-services-ready.cjs" >nul 2>nul
if not errorlevel 1 (
  if /i "%~1"=="--services-only" exit /b 0
  if exist node_modules\electron\dist\electron.exe (
    start "" "node_modules\electron\dist\electron.exe" "." --note-app
    exit /b 0
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

echo Checking optimized production assets...
node "scripts\ensure-web-build.cjs"
if errorlevel 1 (
  echo Production build failed.
  pause
  exit /b 1
)

set "KAOYAN_LAN_IP="
for /f "delims=" %%i in ('node "scripts\lan-address.cjs"') do set "KAOYAN_LAN_IP=%%i"

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "scripts\start-local-services-hidden.ps1"
if errorlevel 1 (
  echo Failed to start local services.
  exit /b 1
)

echo Waiting for local services...
call "node_modules\.bin\wait-on.cmd" --timeout 20000 "http-get://127.0.0.1:5173/" "http-get://127.0.0.1:5174/health"
if errorlevel 1 (
  echo Local services did not become ready. Please close this window and try again.
  pause
  exit /b 1
)

if defined KAOYAN_LAN_IP (
  echo LAN Canvas: http://%KAOYAN_LAN_IP%:5173/?notes=1^&mode=canvas
  echo No pairing code is required. Keep port 5174 private.
) else (
  echo No active LAN IPv4 address was found. Connect this computer to Wi-Fi and restart.
)

if /i "%~1"=="--services-only" exit /b 0

start "" "node_modules\electron\dist\electron.exe" "." --note-app
exit /b %errorlevel%
