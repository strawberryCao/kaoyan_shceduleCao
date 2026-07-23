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

if /I "%~1"=="--schedule-only" goto configure_schedule

set "KAOYAN_LAN_IP="
for /f "delims=" %%i in ('node "scripts\lan-address.cjs"') do set "KAOYAN_LAN_IP=%%i"

echo Checking local services...
call "%~dp0scripts\start-note-app.cmd" --services-only
if errorlevel 1 (
  echo Failed to start local services.
  pause
  exit /b 1
)

echo.
echo Opening desktop console...
start "" "http://127.0.0.1:5173/?console=1"

:configure_schedule
echo Checking smart note organizer in the background...
schtasks /Query /TN "KaoyanNotesSmartOrganizer" >nul 2>nul
if errorlevel 1 schtasks /Create /F /TN "KaoyanNotesSmartOrganizer" /TR "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File %~sdp0scripts\run-smart-note-organizer-hidden.ps1" /SC DAILY /ST 09:00 >nul 2>nul
schtasks /Query /TN "KaoyanNotesAutoClassify" >nul 2>nul
if not errorlevel 1 schtasks /Delete /F /TN "KaoyanNotesAutoClassify" >nul 2>nul
if /I "%~1"=="--schedule-only" exit /b 0
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\run-smart-note-organizer-hidden.ps1"

echo.
echo Console:   http://127.0.0.1:5173/?console=1
echo Wallpaper: http://127.0.0.1:5173/?wallpaper=1
echo Hub:       http://127.0.0.1:5173/?hub=1
echo Canvas:    http://127.0.0.1:5173/?notes=1^&mode=canvas
echo Health:    http://127.0.0.1:5174/health
if defined KAOYAN_LAN_IP (
  echo.
  echo iPad Canvas: http://%KAOYAN_LAN_IP%:5173/?notes=1^&mode=canvas
  echo No pairing code is required. Port 5174 remains local-only.
  echo If iPad cannot connect, allow TCP 5173 for the local subnet in Windows Firewall.
)
echo.
echo Smart organizer: checks daily at 09:00 and runs every 72 hours
echo Task name: KaoyanNotesSmartOrganizer
echo State: %USERPROFILE%\Desktop\考研桌面助手\note-organizer-state.json
echo Move log: %USERPROFILE%\Desktop\考研桌面助手\note-organizer-moves.jsonl
echo.
echo Healthy services are reused for fast startup.
exit /b 0
