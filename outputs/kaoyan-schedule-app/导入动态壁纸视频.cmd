@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "SOURCE="

rem 支持把视频直接拖到本脚本上。
if not "%~1"=="" set "SOURCE=%~1"

if not defined SOURCE (
  for /f "usebackq delims=" %%F in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '选择已经处理好的无缝敦煌动态壁纸视频'; $dialog.Filter = '网页壁纸视频 (*.mp4;*.webm)|*.mp4;*.webm|MP4 视频 (*.mp4)|*.mp4|WebM 视频 (*.webm)|*.webm'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }"`) do set "SOURCE=%%F"
)

if not defined SOURCE (
  echo 未选择视频，操作已取消。
  pause
  exit /b 1
)

if not exist "!SOURCE!" (
  echo 找不到视频文件：!SOURCE!
  pause
  exit /b 1
)

for %%F in ("!SOURCE!") do set "EXT=%%~xF"
if /I "!EXT!"==".mp4" (
  set "TARGET=%~dp0public\dunhuang-master.mp4"
  set "OLD_TARGET=%~dp0public\dunhuang-master.webm"
) else if /I "!EXT!"==".webm" (
  set "TARGET=%~dp0public\dunhuang-master.webm"
  set "OLD_TARGET=%~dp0public\dunhuang-master.mp4"
) else (
  echo 当前只支持 MP4 或 WebM。
  echo 如果源文件是 MKV，请先用视频工具正确转码为 MP4，不要直接修改扩展名。
  pause
  exit /b 1
)

if not exist "%~dp0public" mkdir "%~dp0public"
if exist "!OLD_TARGET!" del /Q "!OLD_TARGET!"
copy /Y "!SOURCE!" "!TARGET!" >nul
if errorlevel 1 (
  echo 视频导入失败。
  pause
  exit /b 1
)

echo.
echo 无缝动态壁纸视频已导入：
echo !TARGET!
echo.
echo 网页将直接循环播放该视频，不再执行淡入、淡出或首尾交叉叠化。
echo 请彻底关闭旧服务，然后重新双击“启动考研桌面助手.cmd”。
pause
