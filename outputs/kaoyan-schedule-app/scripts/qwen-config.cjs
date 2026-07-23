const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const CONFIG_PATH = path.join(ASSISTANT_ROOT, 'qwen-config.json');

function cleanApiKey(input) {
  return String(input || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\r\n\t ]+/g, '');
}

function normalizeQwenModel(input) {
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

function normalizeQwenBaseUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/g, '');
  const base = raw || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  if (base.endsWith('/compatible-mode/v1')) {
    return `${base}/chat/completions`;
  }
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}/chat/completions`;
}

function readFileConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeFileConfig(config) {
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  const payload = {
    apiKey: cleanApiKey(config.apiKey),
    model: normalizeQwenModel(config.model),
    baseUrl: normalizeQwenBaseUrl(config.baseUrl),
    rawBaseUrl: String(config.baseUrl || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadQwenConfig() {
  const fileConfig = readFileConfig();
  const apiKey = cleanApiKey(fileConfig.apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '');
  const model = normalizeQwenModel(fileConfig.model || process.env.QWEN_MODEL || 'qwen-vl-plus');
  const baseUrl = normalizeQwenBaseUrl(fileConfig.baseUrl || process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  return {
    apiKey,
    model,
    baseUrl,
    configPath: CONFIG_PATH,
    assistantRoot: ASSISTANT_ROOT,
    source: fileConfig.apiKey ? 'file' : 'env',
  };
}

function maskKey(key) {
  if (!key) {
    return '(empty)';
  }
  return `${key.slice(0, 8)}...${key.slice(-6)} len=${key.length}`;
}

module.exports = {
  ASSISTANT_ROOT,
  CONFIG_PATH,
  cleanApiKey,
  normalizeQwenModel,
  normalizeQwenBaseUrl,
  readFileConfig,
  writeFileConfig,
  loadQwenConfig,
  maskKey,
};
