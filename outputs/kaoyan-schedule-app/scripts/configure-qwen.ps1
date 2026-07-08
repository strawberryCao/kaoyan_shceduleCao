$ErrorActionPreference = 'Stop'

Write-Host 'Configure Qwen naming for Kaoyan note server' -ForegroundColor Cyan
Write-Host 'The API key will be saved to your current Windows user environment variable.' -ForegroundColor DarkGray
Write-Host 'It will NOT be written into this GitHub repository.' -ForegroundColor DarkGray
Write-Host ''

$key = Read-Host 'Enter Qwen/DashScope API Key'
if ([string]::IsNullOrWhiteSpace($key)) {
  throw 'API key is empty.'
}

$model = Read-Host 'Enter Qwen vision model, default qwen-vl-plus'
if ([string]::IsNullOrWhiteSpace($model)) {
  $model = 'qwen-vl-plus'
}

[Environment]::SetEnvironmentVariable('QWEN_API_KEY', $key, 'User')
[Environment]::SetEnvironmentVariable('QWEN_MODEL', $model, 'User')
[Environment]::SetEnvironmentVariable('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'User')

Write-Host ''
Write-Host 'Qwen environment variables saved:' -ForegroundColor Green
Write-Host 'QWEN_API_KEY = ***hidden***'
Write-Host "QWEN_MODEL = $model"
Write-Host 'QWEN_BASE_URL = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
Write-Host ''
Write-Host 'Important: close and restart 启动壁纸模式.cmd so the note server can read the new variables.' -ForegroundColor Yellow
