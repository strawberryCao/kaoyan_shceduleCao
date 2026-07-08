@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ================================================
echo        配置千问 / DashScope API Key
echo ================================================
echo.
echo 这个窗口才是填写 API Key 的地方。
echo 不要把密钥粘到 Node 服务窗口里。
echo.
echo 推荐模型：qwen-vl-plus
echo 原因：它有视觉能力，适合学习截图识别、科目分类、笔记命名；比 Max 档更适合高频小任务。
echo.

set /p QWEN_KEY=请粘贴你的千问/DashScope API Key 后按回车: 
if "%QWEN_KEY%"=="" (
  echo.
  echo API Key 为空，已取消。
  pause
  exit /b 1
)

echo.
set /p QWEN_MODEL_INPUT=请输入模型名，直接回车默认 qwen-vl-plus: 
if "%QWEN_MODEL_INPUT%"=="" set "QWEN_MODEL_INPUT=qwen-vl-plus"

setx QWEN_API_KEY "%QWEN_KEY%" >nul
setx QWEN_MODEL "%QWEN_MODEL_INPUT%" >nul
setx QWEN_BASE_URL "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" >nul

echo.
echo 已写入 Windows 用户环境变量：
echo QWEN_API_KEY = 已隐藏
echo QWEN_MODEL = %QWEN_MODEL_INPUT%
echo QWEN_BASE_URL = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
echo.
echo 接下来请关闭旧服务窗口，然后重新双击：
echo 启动考研桌面助手.cmd
echo.
echo 启动后打开这个地址检查：
echo http://127.0.0.1:5174/health
echo 看到 enabled: true 且 model 是 qwen-vl-plus 就说明配置成功。
echo.
pause
