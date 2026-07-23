const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const CONFIG_PATH = path.join(ASSISTANT_ROOT, 'qwen-config.json');

function normalizeQwenModel(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'qwen-vl-plus';
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

function cleanKey(input) {
  return String(input || '').trim().replace(/^['"]|['"]$/g, '').replace(/[\r\n\t ]+/g, '');
}

function readFileConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const fileConfig = readFileConfig();
const apiKey = cleanKey(fileConfig.apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '');
const model = normalizeQwenModel(fileConfig.model || process.env.QWEN_MODEL || 'qwen-vl-plus');
const baseUrl = String(fileConfig.baseUrl || process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions').trim();

function maskKey(key) {
  if (!key) return '(empty)';
  return `${key.slice(0, 8)}...${key.slice(-6)} len=${key.length}`;
}

function postJson(urlString, headers, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('---- Qwen connection test ----');
  console.log(`configPath=${CONFIG_PATH}`);
  console.log(`apiKey=${maskKey(apiKey)}`);
  console.log(`model=${model}`);
  console.log(`baseUrl=${baseUrl}`);

  if (!apiKey) {
    console.log('FAIL: API Key is empty.');
    process.exitCode = 1;
    return;
  }

  const result = await postJson(baseUrl, { Authorization: `Bearer ${apiKey}` }, {
    model,
    messages: [{ role: 'user', content: '只回复 OK' }],
    temperature: 0,
  });

  console.log(`HTTP ${result.status}`);
  console.log(result.data.slice(0, 1000));

  if (result.status === 401) {
    console.log('DIAGNOSIS: 阿里云已经收到请求，但拒绝了这个 API Key。请确认它是百炼/DashScope 模型调用 API Key，不是通义网页/灵码/普通阿里云 AccessKey。');
    process.exitCode = 1;
  } else if (result.status >= 200 && result.status < 300) {
    console.log('OK: API Key and model are usable.');
  } else {
    console.log('FAIL: Request reached the API, but the model/account returned an error above.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
