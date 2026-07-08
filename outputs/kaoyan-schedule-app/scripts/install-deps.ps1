$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok($Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn($Message) {
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget($Id, $Name) {
  if (-not (Test-Command 'winget')) {
    Write-Warn "winget not found. Cannot auto-install $Name. Please install it manually, then run this script again."
    return $false
  }

  Write-Step "Installing $Name with winget"
  try {
    winget install --id $Id --exact --source winget --accept-source-agreements --accept-package-agreements
    return $LASTEXITCODE -eq 0
  } catch {
    Write-Warn "$Name install failed: $($_.Exception.Message)"
    return $false
  }
}

function Ensure-Node() {
  if ((Test-Command 'node') -and (Test-Command 'npm')) {
    $nodeVersion = node --version
    $npmVersion = npm --version
    Write-Ok "Node.js $nodeVersion / npm $npmVersion detected"
    return
  }

  $installed = Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not $installed) {
    throw 'Node.js / npm is not installed. Please install Node.js LTS manually, then run this script again.'
  }

  Write-Warn 'Node.js was installed. You may need to close and reopen the terminal, then run this script again.'
}

function Ensure-Lively() {
  if (-not (Test-Command 'winget')) {
    Write-Warn 'winget not found. Skipping Lively Wallpaper auto-install. Please install Lively Wallpaper manually.'
    return
  }

  Write-Step 'Checking Lively Wallpaper'
  winget list --id rocksdanister.LivelyWallpaper --exact | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok 'Lively Wallpaper detected'
    return
  }

  $installed = Install-WithWinget 'rocksdanister.LivelyWallpaper' 'Lively Wallpaper'
  if (-not $installed) {
    Write-Warn 'Lively Wallpaper install failed. Please install it manually and add this URL in Lively: http://127.0.0.1:5173/?wallpaper=1'
  }
}

function Install-NpmPackages() {
  Write-Step 'Installing npm packages'
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install failed. Please check your network, npm registry, or Node.js installation.'
  }
  Write-Ok 'npm packages installed'
}

function Build-Project() {
  Write-Step 'Building project'
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw 'npm run build failed. Send the error output to ChatGPT for a fix.'
  }
  Write-Ok 'Build succeeded'
}

Write-Host 'Kaoyan Schedule App dependency installer' -ForegroundColor White
Write-Host "Project root: $ProjectRoot" -ForegroundColor DarkGray

Ensure-Node
Ensure-Lively
Install-NpmPackages
Build-Project

Write-Host "" -ForegroundColor Green
Write-Host 'All done. Next steps:' -ForegroundColor Green
Write-Host '1. Run: start-wallpaper-mode.cmd, or run: npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'
Write-Host '2. Add this URL in Lively Wallpaper: http://127.0.0.1:5173/?wallpaper=1'
Write-Host '3. Management mode URL: http://127.0.0.1:5173/'
