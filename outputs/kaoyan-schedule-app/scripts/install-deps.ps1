$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

function Write-Step($Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
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
    Write-Warn "未检测到 winget，无法自动安装 $Name。请手动安装后重新运行本脚本。"
    return $false
  }

  Write-Step "尝试通过 winget 安装 $Name"
  try {
    winget install --id $Id --exact --source winget --accept-source-agreements --accept-package-agreements
    return $LASTEXITCODE -eq 0
  } catch {
    Write-Warn "$Name 自动安装失败：$($_.Exception.Message)"
    return $false
  }
}

function Ensure-Node() {
  if ((Test-Command 'node') -and (Test-Command 'npm')) {
    $nodeVersion = node --version
    $npmVersion = npm --version
    Write-Ok "已检测到 Node.js $nodeVersion / npm $npmVersion"
    return
  }

  $installed = Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not $installed) {
    throw 'Node.js / npm 未安装。请先安装 Node.js LTS，然后重新运行本脚本。'
  }

  Write-Warn 'Node.js 安装完成后，可能需要关闭并重新打开终端，再重新运行本脚本。'
}

function Ensure-Lively() {
  if (-not (Test-Command 'winget')) {
    Write-Warn '未检测到 winget，跳过 Lively Wallpaper 自动安装。你可以手动安装 Lively Wallpaper。'
    return
  }

  Write-Step '检查 Lively Wallpaper'
  winget list --id rocksdanister.LivelyWallpaper --exact | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok '已检测到 Lively Wallpaper'
    return
  }

  $installed = Install-WithWinget 'rocksdanister.LivelyWallpaper' 'Lively Wallpaper'
  if (-not $installed) {
    Write-Warn 'Lively Wallpaper 自动安装失败。请手动安装后，在 Lively 中添加 http://127.0.0.1:5173/?wallpaper=1'
  }
}

function Install-NpmPackages() {
  Write-Step '安装项目 npm 依赖'
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install 失败。请检查网络、npm 源或 Node.js 安装。'
  }
  Write-Ok 'npm 依赖安装完成'
}

function Build-Project() {
  Write-Step '验证项目能否构建'
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw 'npm run build 失败。请把报错发给我继续修。'
  }
  Write-Ok '构建成功'
}

Write-Host '考研课表 App 依赖安装脚本' -ForegroundColor White
Write-Host "项目目录：$ProjectRoot" -ForegroundColor DarkGray

Ensure-Node
Ensure-Lively
Install-NpmPackages
Build-Project

Write-Host "`n全部完成。下一步：" -ForegroundColor Green
Write-Host '1. 双击 启动壁纸模式.cmd，或运行：npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'
Write-Host '2. 在 Lively Wallpaper 中添加 URL：http://127.0.0.1:5173/?wallpaper=1'
Write-Host '3. 普通管理模式打开：http://127.0.0.1:5173/'
