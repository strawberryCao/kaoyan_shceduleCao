from pathlib import Path
import subprocess
import sys

subprocess.run([sys.executable, '.github/scripts/repair-public-lan-transformer-v3.py'], check=True)

path = Path('.github/scripts/apply-public-lan-parity.cjs')
source = path.read_text(encoding='utf-8')

injection = r'''
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-provider.test.mjs',
  "  const prompt = renameWorkflowInternals.namingPrompt({\n    customInstructions:",
  "  const prompt = renameWorkflowInternals.namingPrompt({\n    workflow: {\n      version: 'test-note-naming-v1',\n      steps: ['读取局域网配置', '调用命名模型', '校验文件名'],\n      prompt: {\n        instructions: [\n          '你是考研学习笔记整理助手。请生成适合 Windows 文件名的中文标题。',\n          'title 目标长度为 {titleMinLength} 到 {titleMaxLength} 个字符。',\n          '用户备注：{remark}',\n          '字段命名规则：{namingRules}',\n        ],\n        outputFormat: '只输出 JSON 对象。',\n      },\n    },\n    customInstructions:",
  'legacy naming prompt test workflow fixture',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-provider.test.mjs',
  "  const prompt = questionDetectionInternals.splittingPrompt({\n    customInstructions:",
  "  const prompt = questionDetectionInternals.splittingPrompt({\n    workflow: {\n      version: 'test-question-splitting-v1',\n      steps: ['读取局域网配置', '识别区域', '规范化坐标'],\n      prompt: {\n        instructions: [\n          '最多返回 {maxQuestions} 个区域。',\n          'x、y、width、height 使用 0 到 1 的归一化坐标。',\n        ],\n        outputFormat: '只返回 JSON 对象。',\n      },\n    },\n    customInstructions:",
  'legacy splitting prompt test workflow fixture',
);

'''
marker = "process.stdout.write('public LAN parity source patch applied\\n');"
if injection not in source:
    if source.count(marker) != 1:
        raise SystemExit('transformer completion marker missing')
    source = source.replace(marker, injection + marker)

path.write_text(source, encoding='utf-8')
print('public LAN transformer repaired v4')
