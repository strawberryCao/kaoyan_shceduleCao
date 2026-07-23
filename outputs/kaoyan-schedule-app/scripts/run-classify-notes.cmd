@echo off
chcp 65001 >nul
cd /d "%~dp0.."
rem Compatibility entry: the old scheduled task now uses the smart organizer.
node "%~dp0organize-notes.cjs"
