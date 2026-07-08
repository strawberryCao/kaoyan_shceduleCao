const readline = require('readline');
const { spawnSync } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function normalizeModelName(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return 'qwen-vl-plus';
  }
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  const aliases = new Map([
    ['qwen-v1-plus', 'qwen-vl-plus'],
    ['qwen-vlplus', 'qwen-vl-plus'],
    ['qwen-vl_plus', 'qwen-vl-plus'],
    ['qwenvlplus', 'qwen-vl-plus'],
    ['qwen3.5-plus-vl', 'qwen-vl-plus'],
    ['qwen3-plus-vl', 'qwen-vl-plus'],
    ['qwen3-plus', 'qwen-vl-plus'],
  ]);
  return aliases.get(compact) || raw;
}

function setUserEnv(name, value) {
  const result = spawnSync('setx', [name, value], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });

  if (result.status !== 0) {
    const stderr = result.stderr || result.stdout || '';
    throw new Error(`setx ${name} failed: ${stderr}`);
  }
}

async function main() {
  console.log('================================================');
  console.log('       配置千问 / DashScope');
  console.log('================================================');
  console.log('这个脚本会写入 Windows 用户环境变量。');
  console.log('密钥不会写进 GitHub 仓库。');
  console.log('视觉命名/未分类整理推荐模型：qwen-vl-plus');
  console.log('注意：是 qwen-vl-plus，中间是字母 l，不是数字 1。');
  console.log('');

  const key = await ask('请粘贴新的千问/DashScope 配置值后按回车: ');
  if (!key) {
    throw new Error('配置值为空，已取消。');
  }

  const modelInput = await ask('请输入模型名，直接回车默认 qwen-vl-plus: ');
  const model = normalizeModelName(modelInput);

  setUserEnv('QWEN_API_KEY', key);
  setUserEnv('QWEN_MODEL', model);
  setUserEnv('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');

  console.log('');
  console.log('已写入 Windows 用户环境变量。');
  console.log(`QWEN_MODEL = ${model}`);
  console.log('QWEN_BASE_URL = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  console.log('');
  console.log('接下来请关闭旧终端/旧服务窗口，然后重新双击：启动考研桌面助手.cmd');
  console.log('再运行：立即整理未分类笔记.cmd');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => rl.close());
