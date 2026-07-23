@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

if /I "%~1"=="--force" (
  node "%~dp0organize-notes.cjs" --force
) else if /I "%~1"=="--dry-run" (
  node "%~dp0organize-notes.cjs" --dry-run
) else (
  node "%~dp0organize-notes.cjs"
)
