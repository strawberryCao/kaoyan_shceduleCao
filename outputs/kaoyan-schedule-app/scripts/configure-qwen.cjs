const readline = require('readline');
const { spawnSync } = require('child_process');
const { normalizeQwenModel, normalizeQwenBaseUrl, writeFileConfig, CONFIG_PATH } = require('./qwen-config.cjs');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
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
  console.log('       配置千问 / 阿里云百炼');
  console.log('================================================');
  console.log('你现在用的是 sk-ws-... 工作空间 Key，必须配合百炼页面上的 OpenAI compatible 地址。');
  console.log('位置：百炼 API Key 页面顶部，OpenAI compatible 后面的 URL。');
  console.log('例子：https://ws-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  console.log('脚本会自动补 /chat/completions。');
  console.log('');

  const key = await ask('请粘贴新的 sk-ws API Key 后按回车: ');
  if (!key) {
    throw new Error('配置值为空，已取消。');
  }

  const baseInput = await ask('请粘贴 OpenAI compatible 地址后按回车: ');
  if (!baseInput) {
    throw new Error('OpenAI compatible 地址为空。sk-ws Key 不能使用旧的全局 dashscope 地址。');
  }

  const modelInput = await ask('请输入模型名，直接回车默认 qwen-vl-plus: ');
  const model = normalizeQwenModel(modelInput);
  const baseUrl = normalizeQwenBaseUrl(baseInput);

  const fileConfig = writeFileConfig({ apiKey: key, model, baseUrl: baseInput });

  setUserEnv('QWEN_API_KEY', fileConfig.apiKey);
  setUserEnv('QWEN_MODEL', fileConfig.model);
  setUserEnv('QWEN_BASE_URL', fileConfig.baseUrl);

  console.log('');
  console.log('已写入配置文件和 Windows 用户环境变量。');
  console.log(`配置文件 = ${CONFIG_PATH}`);
  console.log(`QWEN_MODEL = ${fileConfig.model}`);
  console.log(`QWEN_BASE_URL = ${fileConfig.baseUrl}`);
  console.log('');
  console.log('接下来请关闭旧终端/旧服务窗口，然后重新双击：启动考研桌面助手.cmd');
  console.log('再运行：测试千问连接.cmd');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => rl.close());
