const fs = require('fs');
const path = require('path');
const { loadQwenConfig } = require('./qwen-config.cjs');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;

const TASK_PROFILES = Object.freeze({
  note_naming: Object.freeze({ difficulty: 'low', capabilities: ['text', 'vision', 'json'] }),
  note_classification: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),
  note_enrichment: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),
  taxonomy: Object.freeze({ difficulty: 'high', capabilities: ['text', 'json', 'longContext'] }),
  flashcard_generation: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'json'] }),
  widget_generation: Object.freeze({ difficulty: 'high', capabilities: ['text', 'json'] }),
  custom: Object.freeze({ difficulty: 'medium', capabilities: ['text'] }),
});

class AiRouterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiRouterError';
    this.code = options.code || 'AI_ROUTER_ERROR';
    this.retryable = Boolean(options.retryable);
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.provider = options.provider || null;
    this.model = options.model || null;
    this.attempts = Array.isArray(options.attempts) ? options.attempts : [];
    if (options.cause) this.cause = options.cause;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanApiKey(value) {
  return cleanString(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\r\n\t ]+/g, '');
}

function toFiniteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = cleanString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeCapabilityName(value) {
  const raw = cleanString(value).toLowerCase().replace(/[\s_-]+/g, '');
  const aliases = new Map([
    ['text', 'text'],
    ['vision', 'vision'],
    ['image', 'vision'],
    ['images', 'vision'],
    ['json', 'json'],
    ['structuredoutput', 'json'],
    ['longcontext', 'longContext'],
    ['reasoning', 'reasoning'],
    ['thinking', 'reasoning'],
  ]);
  return aliases.get(raw) || null;
}

function parseCapabilities(value, fallback = ['text']) {
  const rawValues = Array.isArray(value)
    ? value
    : cleanString(value).split(',').map((item) => item.trim()).filter(Boolean);
  const normalized = rawValues.map(normalizeCapabilityName).filter(Boolean);
  const result = normalized.length > 0 ? normalized : fallback;
  return [...new Set(['text', ...result])];
}

function inferCapabilities(providerId, modelId) {
  const model = cleanString(modelId).toLowerCase();
  const capabilities = ['text', 'json'];
  if (
    providerId === 'gemini'
    || /(?:^|[-_.])(vl|vision)(?:[-_.]|$)/i.test(model)
    || /qwen.*vl/i.test(model)
    || /kimi-k2\.(?:5|6)/i.test(model)
  ) {
    capabilities.push('vision');
  }
  if (providerId === 'gemini' || /(?:long|128k|256k|k2)/i.test(model)) {
    capabilities.push('longContext');
  }
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) {
    capabilities.push('reasoning');
  }
  return [...new Set(capabilities)];
}

function inferCostTier(modelId) {
  const model = cleanString(modelId).toLowerCase();
  if (/(?:lite|flash|turbo|mini|vl-plus)/i.test(model)) return 1;
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) return 3;
  return 2;
}

function inferQualityTier(modelId) {
  const model = cleanString(modelId).toLowerCase();
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) return 3;
  if (/(?:lite|mini)/i.test(model)) return 1;
  return 2;
}

function normalizeChatCompletionUrl(value) {
  const raw = cleanString(value).replace(/\/+$/g, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new AiRouterError(`AI 配置文件无法读取：${filePath}`, {
      code: 'AI_CONFIG_INVALID',
      cause: error,
    });
  }
}

function providerFromObject(id, input = {}) {
  const modelInputs = Array.isArray(input.models) && input.models.length > 0
    ? input.models
    : input.model
      ? [{ id: input.model }]
      : [];

  const models = modelInputs
    .map((modelInput) => {
      const model = typeof modelInput === 'string' ? { id: modelInput } : modelInput || {};
      const modelId = cleanString(model.id || model.model);
      if (!modelId) return null;
      const inferredCapabilities = inferCapabilities(id, modelId);
      return {
        id: modelId,
        capabilities: parseCapabilities(model.capabilities || input.capabilities, inferredCapabilities),
        costTier: toFiniteNumber(model.costTier ?? input.costTier, inferCostTier(modelId), 1, 3),
        qualityTier: toFiniteNumber(model.qualityTier ?? input.qualityTier, inferQualityTier(modelId), 1, 3),
        priority: toFiniteNumber(model.priority, 0, -100, 100),
        supportsResponseFormat: parseBoolean(
          model.supportsResponseFormat ?? input.supportsResponseFormat,
          true,
        ),
      };
    })
    .filter(Boolean);

  const headers = input.headers && typeof input.headers === 'object'
    ? Object.fromEntries(Object.entries(input.headers).filter(([key, value]) => cleanString(key) && typeof value === 'string'))
    : {};

  return {
    id,
    enabled: parseBoolean(input.enabled, true),
    apiKey: cleanApiKey(input.apiKey),
    baseUrl: normalizeChatCompletionUrl(input.baseUrl),
    priority: toFiniteNumber(input.priority, id === 'qwen' ? 10 : 0, -100, 100),
    headers,
    models,
  };
}

function getLocalProvider(localConfig, id) {
  const providers = localConfig?.providers;
  if (Array.isArray(providers)) {
    return providers.find((provider) => provider?.id === id) || {};
  }
  if (providers && typeof providers === 'object') return providers[id] || {};
  return {};
}

function nonEmptyOverride(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function envProviderConfig(env, id) {
  if (id === 'qwen') {
    return {
      apiKey: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY,
      model: env.QWEN_MODEL,
      baseUrl: env.QWEN_BASE_URL,
      capabilities: env.QWEN_CAPABILITIES,
      costTier: env.QWEN_COST_TIER,
      qualityTier: env.QWEN_QUALITY_TIER,
      priority: env.QWEN_PRIORITY,
      supportsResponseFormat: env.QWEN_SUPPORTS_RESPONSE_FORMAT,
    };
  }
  if (id === 'gemini') {
    return {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      baseUrl: env.GEMINI_BASE_URL,
      capabilities: env.GEMINI_CAPABILITIES,
      costTier: env.GEMINI_COST_TIER,
      qualityTier: env.GEMINI_QUALITY_TIER,
      priority: env.GEMINI_PRIORITY,
      supportsResponseFormat: env.GEMINI_SUPPORTS_RESPONSE_FORMAT,
    };
  }
  return {
    apiKey: env.KIMI_API_KEY || env.MOONSHOT_API_KEY,
    model: env.KIMI_MODEL || env.MOONSHOT_MODEL,
    baseUrl: env.KIMI_BASE_URL || env.MOONSHOT_BASE_URL,
    capabilities: env.KIMI_CAPABILITIES || env.MOONSHOT_CAPABILITIES,
    costTier: env.KIMI_COST_TIER || env.MOONSHOT_COST_TIER,
    qualityTier: env.KIMI_QUALITY_TIER || env.MOONSHOT_QUALITY_TIER,
    priority: env.KIMI_PRIORITY || env.MOONSHOT_PRIORITY,
    supportsResponseFormat: env.KIMI_SUPPORTS_RESPONSE_FORMAT || env.MOONSHOT_SUPPORTS_RESPONSE_FORMAT,
  };
}

function loadAiProviderConfigs(options = {}) {
  const env = options.env || process.env;
  const legacyQwen = options.legacyQwenConfig || loadQwenConfig();
  const configPath = options.configPath
    || env.KAOYAN_AI_CONFIG_PATH
    || path.join(legacyQwen.assistantRoot, 'ai-providers.json');
  const localConfig = options.localConfig || readJsonFile(configPath);

  const legacyQwenInput = {
    apiKey: legacyQwen.apiKey,
    model: legacyQwen.model,
    baseUrl: legacyQwen.baseUrl,
    capabilities: inferCapabilities('qwen', legacyQwen.model),
  };

  const defaults = {
    qwen: legacyQwenInput,
    // Gemini and Kimi remain opt-in because a key and model are still required;
    // the standard OpenAI-compatible endpoints are safe defaults.
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    kimi: { baseUrl: 'https://api.moonshot.cn/v1' },
  };

  const providers = ['qwen', 'gemini', 'kimi']
    .map((id) => {
      const environment = envProviderConfig(env, id);
      const merged = nonEmptyOverride(
        nonEmptyOverride(defaults[id], getLocalProvider(localConfig, id)),
        environment,
      );
      // A model explicitly selected in the environment must override a local
      // multi-model list as well, rather than becoming an unused sibling field.
      if (cleanString(environment.model)) delete merged.models;
      return providerFromObject(id, merged);
    })
    .filter((provider) => provider.enabled && provider.apiKey && provider.baseUrl && provider.models.length > 0);

  const routing = localConfig.routing && typeof localConfig.routing === 'object'
    ? localConfig.routing
    : {};

  return {
    configPath,
    providers,
    routing: {
      timeoutMs: toFiniteNumber(
        env.AI_TIMEOUT_MS || routing.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        1,
        300_000,
      ),
      circuitThreshold: toFiniteNumber(
        env.AI_CIRCUIT_THRESHOLD || routing.circuitThreshold,
        DEFAULT_CIRCUIT_THRESHOLD,
        1,
        20,
      ),
      circuitCooldownMs: toFiniteNumber(
        env.AI_CIRCUIT_COOLDOWN_MS || routing.circuitCooldownMs,
        DEFAULT_CIRCUIT_COOLDOWN_MS,
        100,
        86_400_000,
      ),
      networkRetries: toFiniteNumber(
        env.AI_NETWORK_RETRIES || routing.networkRetries,
        1,
        0,
        3,
      ),
      jsonRepairRetries: toFiniteNumber(
        env.AI_JSON_REPAIR_RETRIES || routing.jsonRepairRetries,
        1,
        0,
        2,
      ),
    },
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === 'string' ? item : item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return cleanString(content);
}

function extractJsonValue(text) {
  const raw = cleanString(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Continue with common fenced/prose response recovery.
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    // Continue with the outermost object or array.
  }
  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const opening = candidate[start];
  const closing = opening === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closing);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateJsonAgainstSchema(value, schema, currentPath = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map((variant) => validateJsonAgainstSchema(value, variant, currentPath));
    if (!variants.some((variantErrors) => variantErrors.length === 0)) {
      errors.push(`${currentPath} does not match any allowed schema`);
    }
    return errors;
  }

  if (Array.isArray(schema.oneOf)) {
    const matchCount = schema.oneOf
      .map((variant) => validateJsonAgainstSchema(value, variant, currentPath))
      .filter((variantErrors) => variantErrors.length === 0).length;
    if (matchCount !== 1) errors.push(`${currentPath} must match exactly one schema`);
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${currentPath} must equal the configured constant`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${currentPath} is not an allowed value`);
  }

  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => typeMatches(value, type))) {
      errors.push(`${currentPath} must be ${allowedTypes.join(' or ')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${currentPath} is shorter than ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${currentPath} is longer than ${schema.maxLength}`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${currentPath} has an invalid format`);
      } catch {
        errors.push(`${currentPath} uses an invalid schema pattern`);
      }
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${currentPath} is too small`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${currentPath} is too large`);
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${currentPath} has too few items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${currentPath} has too many items`);
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonAgainstSchema(item, schema.items, `${currentPath}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${currentPath}.${key} is required`);
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateJsonAgainstSchema(value[key], childSchema, `${currentPath}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${currentPath}.${key} is not allowed`);
      }
    }
  }

  return errors;
}

function containsImage(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(containsImage);
  if (typeof value !== 'object') return false;
  if (value.type === 'image_url' || value.type === 'input_image' || value.image_url) return true;
  return Object.values(value).some(containsImage);
}

function normalizeDifficulty(value, fallback) {
  return ['low', 'medium', 'high'].includes(value) ? value : fallback;
}

function buildRequirements(request) {
  const profile = TASK_PROFILES[request.task] || TASK_PROFILES.custom;
  const difficulty = normalizeDifficulty(request.difficulty, profile.difficulty);
  const capabilities = new Set(profile.capabilities);
  (request.requiredCapabilities || []).forEach((capability) => {
    const normalized = normalizeCapabilityName(capability);
    if (normalized) capabilities.add(normalized);
  });
  if (containsImage(request.messages)) capabilities.add('vision');
  if (request.responseSchema || request.json === true) capabilities.add('json');
  return { difficulty, capabilities: [...capabilities] };
}

function modelScore(provider, model, difficulty) {
  const qualityWeight = difficulty === 'high' ? 18 : difficulty === 'medium' ? 9 : 3;
  const costWeight = difficulty === 'low' ? 14 : difficulty === 'medium' ? 7 : 2;
  return (
    provider.priority
    + model.priority
    + model.qualityTier * qualityWeight
    + (4 - model.costTier) * costWeight
  );
}

function safeAttempt(provider, model, phase, outcome, error) {
  return {
    provider,
    model,
    phase,
    outcome,
    code: error?.code || null,
    status: error?.status || null,
  };
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAiRouter(options = {}) {
  const loaded = options.config
    ? { providers: options.config.providers || [], routing: options.config.routing || {} }
    : loadAiProviderConfigs(options);
  const providers = loaded.providers.map((provider) => providerFromObject(provider.id, provider));
  const routing = {
    timeoutMs: toFiniteNumber(options.timeoutMs ?? loaded.routing.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000),
    circuitThreshold: toFiniteNumber(
      options.circuitThreshold ?? loaded.routing.circuitThreshold,
      DEFAULT_CIRCUIT_THRESHOLD,
      1,
      20,
    ),
    circuitCooldownMs: toFiniteNumber(
      options.circuitCooldownMs ?? loaded.routing.circuitCooldownMs,
      DEFAULT_CIRCUIT_COOLDOWN_MS,
      100,
      86_400_000,
    ),
    networkRetries: toFiniteNumber(options.networkRetries ?? loaded.routing.networkRetries, 1, 0, 3),
    jsonRepairRetries: toFiniteNumber(options.jsonRepairRetries ?? loaded.routing.jsonRepairRetries, 1, 0, 2),
  };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AiRouterError('当前 Node.js 环境没有可用的 fetch', { code: 'AI_FETCH_UNAVAILABLE' });
  }
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || sleepDefault;
  const circuits = new Map();

  function getCircuit(providerId) {
    if (!circuits.has(providerId)) {
      circuits.set(providerId, { consecutiveFailures: 0, openUntil: 0 });
    }
    return circuits.get(providerId);
  }

  function isCircuitOpen(providerId) {
    const state = getCircuit(providerId);
    if (state.openUntil > now()) return true;
    if (state.openUntil > 0) {
      state.openUntil = 0;
      state.consecutiveFailures = 0;
    }
    return false;
  }

  function recordSuccess(providerId) {
    const state = getCircuit(providerId);
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }

  function recordFailure(providerId) {
    const state = getCircuit(providerId);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= routing.circuitThreshold) {
      state.openUntil = now() + routing.circuitCooldownMs;
    }
  }

  function candidatesFor(request) {
    const requirements = buildRequirements(request);
    const allowed = Array.isArray(request.allowedProviders) && request.allowedProviders.length > 0
      ? new Set(request.allowedProviders)
      : null;
    const blocked = new Set(request.blockedProviders || []);
    const maxCostTier = Number.isFinite(request.maxCostTier)
      ? Math.min(3, Math.max(1, request.maxCostTier))
      : null;

    const candidates = [];
    for (const provider of providers) {
      if (!provider.enabled || !provider.apiKey || !provider.baseUrl || provider.models.length === 0) continue;
      if (allowed && !allowed.has(provider.id)) continue;
      if (blocked.has(provider.id) || isCircuitOpen(provider.id)) continue;
      for (const model of provider.models) {
        if (maxCostTier && model.costTier > maxCostTier) continue;
        if (!requirements.capabilities.every((capability) => model.capabilities.includes(capability))) continue;
        candidates.push({ provider, model, score: modelScore(provider, model, requirements.difficulty) });
      }
    }
    return {
      ...requirements,
      candidates: candidates.sort((left, right) => right.score - left.score),
    };
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiRouterError('AI 请求超时', { code: 'AI_TIMEOUT', retryable: true }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AiRouterError) throw error;
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      throw new AiRouterError(aborted ? 'AI 请求超时' : 'AI 网络请求失败', {
        code: aborted ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestModel(provider, model, request, messages) {
    const isKimiThinkingModel = provider.id === 'kimi' && /kimi-k2\.(?:5|6)/i.test(model.id);
    const payload = {
      model: model.id,
      messages,
    };
    if (!isKimiThinkingModel) {
      payload.temperature = request.temperature ?? (request.responseSchema || request.json ? 0.1 : 0.3);
    }
    if (Number.isFinite(request.maxTokens)) {
      if (isKimiThinkingModel) payload.max_completion_tokens = request.maxTokens;
      else payload.max_tokens = request.maxTokens;
    }
    if ((request.responseSchema || request.json) && model.supportsResponseFormat) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetchWithTimeout(
      provider.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.headers,
        },
        body: JSON.stringify(payload),
      },
      toFiniteNumber(request.timeoutMs, routing.timeoutMs, 1, 300_000),
    );

    if (!response || typeof response.ok !== 'boolean') {
      throw new AiRouterError('AI 服务返回了无效响应', { code: 'AI_INVALID_RESPONSE', retryable: true });
    }
    if (!response.ok) {
      const status = response.status;
      const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
      throw new AiRouterError(`AI 服务请求失败（HTTP ${status}）`, {
        code: status === 401 || status === 403 ? 'AI_AUTH_ERROR' : 'AI_HTTP_ERROR',
        retryable,
        status,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new AiRouterError('AI 服务没有返回有效 JSON 包装', {
        code: 'AI_INVALID_RESPONSE',
        retryable: true,
        cause: error,
      });
    }
    const text = contentToText(data?.choices?.[0]?.message?.content);
    if (!text) {
      throw new AiRouterError('AI 服务返回了空内容', { code: 'AI_EMPTY_RESPONSE', retryable: true });
    }
    return { text, usage: data?.usage || null };
  }

  function validateResult(raw, request) {
    if (!request.responseSchema && request.json !== true && typeof request.validate !== 'function') {
      return { text: raw.text, json: undefined, usage: raw.usage };
    }
    const json = extractJsonValue(raw.text);
    if (json === null) {
      throw new AiRouterError('AI 没有返回可解析的 JSON', { code: 'AI_JSON_INVALID', retryable: true });
    }
    const schemaErrors = request.responseSchema
      ? validateJsonAgainstSchema(json, request.responseSchema)
      : [];
    if (schemaErrors.length > 0) {
      throw new AiRouterError(`AI JSON 不符合要求：${schemaErrors.slice(0, 4).join('；')}`, {
        code: 'AI_SCHEMA_INVALID',
        retryable: true,
      });
    }
    if (typeof request.validate === 'function') {
      const validation = request.validate(json);
      if (validation !== true && validation !== undefined) {
        const message = typeof validation === 'string' ? validation : '自定义校验未通过';
        throw new AiRouterError(`AI JSON 不符合要求：${message}`, {
          code: 'AI_SCHEMA_INVALID',
          retryable: true,
        });
      }
    }
    return { text: raw.text, json, usage: raw.usage };
  }

  function repairMessages(messages, error, responseText, schema) {
    const schemaText = schema ? JSON.stringify(schema) : '一个有效 JSON 值';
    return [
      ...messages,
      { role: 'assistant', content: String(responseText || '').slice(0, 16_000) },
      {
        role: 'user',
        content: [
          '上一条输出无法通过程序校验。请只返回修正后的 JSON，不要使用 Markdown，也不要解释。',
          `校验问题：${error.message.slice(0, 500)}`,
          `目标 JSON Schema：${schemaText.slice(0, 8_000)}`,
        ].join('\n'),
      },
    ];
  }

  async function complete(request = {}) {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new AiRouterError('messages 不能为空', { code: 'AI_REQUEST_INVALID' });
    }
    const route = candidatesFor(request);
    if (route.candidates.length === 0) {
      throw new AiRouterError(
        `没有满足能力要求的可用 AI（${route.capabilities.join(', ')}）`,
        { code: 'AI_NO_PROVIDER' },
      );
    }

    const attempts = [];
    for (const { provider, model } of route.candidates) {
      let messages = request.messages;
      let networkAttempt = 0;
      let repairAttempt = 0;
      while (true) {
        try {
          const raw = await requestModel(provider, model, request, messages);
          try {
            const validated = validateResult(raw, request);
            recordSuccess(provider.id);
            attempts.push(safeAttempt(provider.id, model.id, repairAttempt > 0 ? 'repair' : 'request', 'success'));
            return {
              ...validated,
              provider: provider.id,
              model: model.id,
              difficulty: route.difficulty,
              attempts,
            };
          } catch (validationError) {
            attempts.push(safeAttempt(provider.id, model.id, 'validation', 'failed', validationError));
            if (repairAttempt < routing.jsonRepairRetries) {
              repairAttempt += 1;
              messages = repairMessages(messages, validationError, raw.text, request.responseSchema);
              continue;
            }
            recordFailure(provider.id);
            break;
          }
        } catch (error) {
          const safeError = error instanceof AiRouterError
            ? error
            : new AiRouterError('AI 调用失败', { code: 'AI_PROVIDER_ERROR', retryable: true, cause: error });
          attempts.push(safeAttempt(provider.id, model.id, 'request', 'failed', safeError));
          if (safeError.retryable && networkAttempt < routing.networkRetries) {
            networkAttempt += 1;
            await sleep(Math.min(2_000, 200 * (2 ** (networkAttempt - 1))));
            continue;
          }
          recordFailure(provider.id);
          break;
        }
      }
    }

    throw new AiRouterError('所有可用 AI 均调用失败', {
      code: 'AI_ALL_PROVIDERS_FAILED',
      attempts,
    });
  }

  function getStatus() {
    return {
      providers: providers.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled && Boolean(provider.apiKey),
        models: provider.models.map((model) => ({
          id: model.id,
          capabilities: [...model.capabilities],
          costTier: model.costTier,
          qualityTier: model.qualityTier,
        })),
        circuit: {
          open: isCircuitOpen(provider.id),
          consecutiveFailures: getCircuit(provider.id).consecutiveFailures,
          openUntil: getCircuit(provider.id).openUntil || null,
        },
      })),
    };
  }

  function resetCircuit(providerId) {
    if (providerId) circuits.delete(providerId);
    else circuits.clear();
  }

  return {
    complete,
    getStatus,
    resetCircuit,
  };
}

module.exports = {
  AiRouterError,
  TASK_PROFILES,
  createAiRouter,
  extractJsonValue,
  loadAiProviderConfigs,
  normalizeChatCompletionUrl,
  validateJsonAgainstSchema,
};
