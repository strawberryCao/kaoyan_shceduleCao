const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  ensurePrivateDirectory,
  provisionRuntimeLayout,
  publicRuntimeSummary,
  resolveRuntimePaths,
} = require('./runtime-paths.cjs');

const AI_CONFIG_SCHEMA_VERSION = 2;
const PROVIDER_DEFINITIONS = Object.freeze({
  qwen: Object.freeze({
    label: 'Qwen / DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-vl-plus',
  }),
  gemini: Object.freeze({
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  }),
  kimi: Object.freeze({
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  }),
});

function clean(value) {
  return String(value || '').trim();
}

function assertProviderId(value) {
  const id = clean(value).toLowerCase();
  if (!Object.hasOwn(PROVIDER_DEFINITIONS, id)) {
    throw new Error(`Unsupported provider: ${value}. Supported: ${Object.keys(PROVIDER_DEFINITIONS).join(', ')}`);
  }
  return id;
}

function normalizeApiKey(value) {
  const key = clean(value).replace(/^['"]|['"]$/g, '');
  if (key.length < 12) throw new Error('API key is too short.');
  if (/\s/.test(key)) throw new Error('API key must not contain whitespace.');
  if (/^(?:your[-_ ]?key|api[-_ ]?key|replace[-_ ]?me|请填写)/i.test(key)) throw new Error('API key is still a placeholder.');
  return key;
}

function normalizeBaseUrl(value) {
  const raw = clean(value).replace(/\/+$/g, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid provider base URL: ${raw || '(empty)'}`);
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Provider base URL must use HTTPS (HTTP is allowed only for loopback development).');
  }
  if (url.username || url.password || url.hash) throw new Error('Provider base URL must not contain credentials or a fragment.');
  return raw;
}

function normalizeModels(value) {
  const inputs = Array.isArray(value) ? value : clean(value).split(',');
  const models = [...new Set(inputs.map(clean).filter(Boolean))];
  if (models.length === 0) throw new Error('At least one model id is required.');
  if (models.some((model) => model.length > 160 || /请填写|replace.?me/i.test(model))) {
    throw new Error('A model id is invalid or still a placeholder.');
  }
  return models;
}

function emptyAiConfig() {
  return {
    version: AI_CONFIG_SCHEMA_VERSION,
    providers: {},
    routing: {
      timeoutMs: 30_000,
      networkRetries: 1,
      jsonRepairRetries: 1,
      circuitThreshold: 3,
      circuitCooldownMs: 60_000,
    },
  };
}

function readAiConfig(configPath) {
  if (!fs.existsSync(configPath)) return emptyAiConfig();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`AI configuration is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI configuration must be a JSON object.');
  return {
    ...parsed,
    version: Number(parsed.version) || AI_CONFIG_SCHEMA_VERSION,
    providers: parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
      ? { ...parsed.providers }
      : {},
    routing: parsed.routing && typeof parsed.routing === 'object' && !Array.isArray(parsed.routing)
      ? { ...emptyAiConfig().routing, ...parsed.routing }
      : emptyAiConfig().routing,
  };
}

function upsertProvider(config, input) {
  const id = assertProviderId(input.id);
  const previous = config.providers?.[id] || {};
  const apiKey = input.apiKey ? normalizeApiKey(input.apiKey) : normalizeApiKey(previous.apiKey);
  const baseUrl = normalizeBaseUrl(input.baseUrl || previous.baseUrl || PROVIDER_DEFINITIONS[id].baseUrl);
  const models = normalizeModels(input.models || previous.models?.map((model) => typeof model === 'string' ? model : model?.id) || PROVIDER_DEFINITIONS[id].model);
  const previousModels = new Map((Array.isArray(previous.models) ? previous.models : [])
    .filter((model) => model && typeof model === 'object' && clean(model.id))
    .map((model) => [clean(model.id), model]));
  const provider = {
    ...previous,
    enabled: input.enabled !== false,
    apiKey,
    baseUrl,
    models: models.map((model) => ({ ...previousModels.get(model), id: model })),
    updatedAt: new Date().toISOString(),
  };
  return {
    ...config,
    version: Math.max(AI_CONFIG_SCHEMA_VERSION, Number(config.version) || 0),
    providers: { ...config.providers, [id]: provider },
    updatedAt: new Date().toISOString(),
  };
}

function removeProvider(config, value) {
  const id = assertProviderId(value);
  const providers = { ...config.providers };
  delete providers[id];
  return { ...config, providers, updatedAt: new Date().toISOString() };
}

function maskApiKey(value) {
  const key = clean(value);
  if (!key) return '(未配置)';
  if (key.length <= 10) return `*** (长度 ${key.length})`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (长度 ${key.length})`;
}

function validateStoredProvider(id, provider) {
  assertProviderId(id);
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('Provider configuration must be an object.');
  }
  normalizeApiKey(provider.apiKey);
  normalizeBaseUrl(provider.baseUrl);
  normalizeModels(Array.isArray(provider.models)
    ? provider.models.map((model) => typeof model === 'string' ? model : model?.id)
    : provider.models);
  return true;
}

function providerStatus(config) {
  return Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => {
    const provider = config.providers?.[id];
    const models = Array.isArray(provider?.models)
      ? provider.models.map((model) => clean(typeof model === 'string' ? model : model?.id)).filter(Boolean)
      : [];
    let validationError = '';
    if (provider) {
      try {
        validateStoredProvider(id, provider);
      } catch (error) {
        validationError = error.message;
      }
    }
    return {
      id,
      label: definition.label,
      configured: Boolean(provider && !validationError),
      enabled: provider?.enabled !== false,
      apiKey: maskApiKey(provider?.apiKey),
      baseUrl: clean(provider?.baseUrl),
      models,
      updatedAt: provider?.updatedAt || null,
      validationError: validationError || null,
    };
  });
}

function nonSecretStatusDocument(runtimePaths, config) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: publicRuntimeSummary(runtimePaths),
    providers: providerStatus(config).map(({ apiKey, ...status }) => status),
  };
}

function writeAiConfig(runtimePaths, config, options = {}) {
  provisionRuntimeLayout(runtimePaths, options);
  ensurePrivateDirectory(path.dirname(runtimePaths.aiConfigPath), options.fsModule || fs);
  atomicWriteJson(runtimePaths.aiConfigPath, config, options);
  atomicWriteJson(
    path.join(runtimePaths.configRoot, 'ai-provider-status.json'),
    nonSecretStatusDocument(runtimePaths, config),
    options,
  );
  return runtimePaths.aiConfigPath;
}

function loadRuntimeAndConfig(options = {}) {
  const env = { ...(options.env || process.env) };
  if (options.runtimeRoot) env.KAOYAN_RUNTIME_ROOT = options.runtimeRoot;
  const runtimePaths = resolveRuntimePaths({ env, ...options.runtimeOptions });
  return { runtimePaths, config: readAiConfig(runtimePaths.aiConfigPath) };
}

module.exports = {
  AI_CONFIG_SCHEMA_VERSION,
  PROVIDER_DEFINITIONS,
  assertProviderId,
  emptyAiConfig,
  loadRuntimeAndConfig,
  maskApiKey,
  nonSecretStatusDocument,
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeModels,
  providerStatus,
  readAiConfig,
  removeProvider,
  upsertProvider,
  validateStoredProvider,
  writeAiConfig,
};
