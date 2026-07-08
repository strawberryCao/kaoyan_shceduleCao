@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ============================================================
echo        生成敦煌动态壁纸视频 / Blender Render
echo ============================================================
echo.
echo 这个脚本会用 Blender 渲染一个低眩晕、慢速循环的敦煌动态背景视频。
echo 输出位置：public\dunhuang-loop.mp4
echo 同时会保存一个 .blend 文件方便你以后手动调。
echo.

set "BLENDER_EXE="
for /f "delims=" %%i in ('where blender 2^>nul') do (
  if not defined BLENDER_EXE set "BLENDER_EXE=%%i"
)

if not defined BLENDER_EXE (
  echo 没有在 PATH 里找到 blender.exe，请手动选择 Blender 安装目录里的 blender.exe。
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择 blender.exe'; $d.Filter='blender.exe|blender.exe|Executable (*.exe)|*.exe'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileName}"`) do set "BLENDER_EXE=%%i"
)

if not defined BLENDER_EXE (
  echo 没有选择 blender.exe，已取消。
  pause
  exit /b 1
)

set "IMAGE_PATH=%~dp0public\dunhuang-wallpaper.png"
if not exist "%IMAGE_PATH%" (
  echo 没有找到 public\dunhuang-wallpaper.png，请选择 7 号敦煌原图。
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择 7 号敦煌原图'; $d.Filter='Image Files (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All Files (*.*)|*.*'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileName}"`) do set "IMAGE_PATH=%%i"
)

if not exist "%IMAGE_PATH%" (
  echo 没有选择图片，已取消。
  pause
  exit /b 1
)

if not exist public mkdir public

set "OUTPUT_PATH=%~dp0public\dunhuang-loop.mp4"
set "SCRIPT_PATH=%~dp0scripts\create_dunhuang_wallpaper_scene.py"

echo.
echo Blender: %BLENDER_EXE%
echo 图片:    %IMAGE_PATH%
echo 输出:    %OUTPUT_PATH%
echo.
echo 开始渲染。第一次可能会比较久，窗口不要关。
echo 如果你电脑性能可以，后续我再给你加 2K/4K 高质量档。
echo.

"%BLENDER_EXE%" -b --python "%SCRIPT_PATH%" -- --image "%IMAGE_PATH%" --output "%OUTPUT_PATH%" --width 1920 --height 1080 --fps 30 --seconds 16 --quality medium

if errorlevel 1 (
  echo.
  echo 渲染失败。请把上面的 Blender 报错截图发给我。
  pause
  exit /b 1
)

echo.
echo 渲染完成：%OUTPUT_PATH%
echo 现在重新启动：启动考研桌面助手.cmd
echo 然后打开：http://127.0.0.1:5173/?wallpaper=1
echo.
pause
