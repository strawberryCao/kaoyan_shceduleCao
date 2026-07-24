import { getAgentTask } from './agent-runtime.js';
import { HttpError } from './http.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeUrl(value) {
  const raw = text(value, 1000).replace(/\/+$/g, '');
  if (!raw || raw === '__LOCAL_ONLY_URL__') return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

function capabilities(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => text(item, 40)).filter(Boolean))];
}

function modelEntries(provider) {
  const source = Array.isArray(provider?.models) ? provider.models : [];
  return source.map((item) => typeof item === 'string' ? { id: item } : item)
    .filter(isObject)
    .map((model) => ({
      id: text(model.id || model.model, 160),
      capabilities: capabilities(model.capabilities),
      costTier: number(model.costTier, 2, 1, 3),
      qualityTier: number(model.qualityTier, 2, 1, 3),
      priority: number(model.priority, 0, -100, 100),
      supportsResponseFormat: model.supportsResponseFormat !== false,
    }))
    .filter((model) => Boolean(model.id));
}

function requiredCapabilities(task, request) {
  const result = new Set(Array.isArray(task.profile?.capabilities) ? task.profile.capabilities : ['text']);
  for (const item of request.requiredCapabilities || []) result.add(item);
  if (request.imageDataUrl) result.add('vision');
  if (request.json !== false) result.add('json');
  return [...result];
}

function scoreModel(provider, model, difficulty) {
  const qualityWeight = difficulty === 'high' ? 18 : difficulty === 'medium' ? 9 : 3;
  const costWeight = difficulty === 'low' ? 14 : difficulty === 'medium' ? 7 : 2;
  return number(provider.priority, 0, -100, 100)
    + model.priority
    + model.qualityTier * qualityWeight
    + (4 - model.costTier) * costWeight;
}

function routeCandidates(env, runtime, task, request) {
  const settings = task.settings || {};
  const preferredProvider = text(settings.providerId, 80).toLowerCase();
  const preferredModel = text(settings.modelId, 160);
  const hasPreference = Boolean(preferredProvider || preferredModel);
  const allowFallback = settings.fallback !== false;
  const required = requiredCapabilities(task, request);
  const difficulty = ['low', 'medium', 'high'].includes(settings.difficulty)
    ? settings.difficulty
    : text(task.profile?.difficulty, 20) || 'medium';
  const candidates = [];
  const unavailable = [];

  for (const [providerId, provider] of Object.entries(runtime.providers || {})) {
    if (!isObject(provider) || provider.enabled === false || provider.cloudUsable === false) continue;
    const baseUrl = normalizeUrl(provider.baseUrl);
    const secretRef = text(provider.secretRef, 120);
    const apiKey = secretRef ? text(env?.[secretRef], 10000) : '';
    if (!baseUrl) {
      unavailable.push({ providerId, reason: 'base-url-unavailable' });
      continue;
    }
    if (!apiKey) {
      unavailable.push({ providerId, reason: 'secret-missing', secretRef: secretRef || null });
      continue;
    }
    for (const model of modelEntries(provider)) {
      const preferred = hasPreference
        && (!preferredProvider || providerId === preferredProvider)
        && (!preferredModel || model.id === preferredModel);
      if (hasPreference && !allowFallback && !preferred) continue;
      if (!required.every((capability) => model.capabilities.includes(capability))) continue;
      candidates.push({
        providerId,
        provider,
        model,
        baseUrl,
        apiKey,
        preferred,
        score: scoreModel(provider, model, difficulty) + (preferred ? 10000 : 0),
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    const preferredSecret = preferredProvider && runtime.providers?.[preferredProvider]?.secretRef;
    if (preferredSecret && !env?.[preferredSecret]) {
      throw new HttpError(503, `Cloudflare 尚未配置 ${preferredSecret}。`, 'PROVIDER_SECRET_MISSING');
    }
    throw new HttpError(
      503,
      `没有满足局域网任务约束的公网 AI 模型（需要：${required.join('、')}）。`,
      'LOCAL_AGENT_PROVIDER_UNAVAILABLE',
    );
  }
  return { candidates, unavailable, required, difficulty, allowFallback };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function parseJsonText(value) {
  const raw = text(value, 200000);
  if (!raw) return null;
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const closing = raw[start] === '{' ? '}' : ']';
    const end = raw.lastIndexOf(closing);
    if (end > start) candidates.push(raw.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch {}
  }
  return null;
}

function safeProviderMessage(value) {
  return text(value, 600).replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/gi, '[已隐藏密钥]');
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new HttpError(504, 'AI 请求超时。', 'AI_TIMEOUT');
    }
    throw new HttpError(502, 'AI 网络请求失败。', 'AI_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

function requestPayload(candidate, task, request) {
  const settings = task.settings || {};
  const options = settings.options || {};
  const isKimiThinking = candidate.providerId === 'kimi' && /kimi-(?:k3|k2\.(?:5|6))/i.test(candidate.model.id);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const payload = { model: candidate.model.id, messages };
  const temperature = Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : request.temperature;
  if (!isKimiThinking) payload.temperature = number(temperature, request.json === false ? 0.3 : 0.1, 0, 2);
  const maxTokens = number(request.maxTokens ?? options.maxTokens, 1600, 64, 16000);
  if (isKimiThinking) payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;
  if (request.json !== false && candidate.model.supportsResponseFormat) payload.response_format = { type: 'json_object' };
  const reasoningMode = options.reasoningMode;
  if (candidate.providerId === 'kimi' && ['fast', 'balanced', 'deep'].includes(reasoningMode)) {
    if (/kimi-k2\.(?:5|6)/i.test(candidate.model.id)) payload.thinking = { type: reasoningMode === 'fast' ? 'disabled' : 'enabled' };
    if (/kimi-k3/i.test(candidate.model.id)) payload.reasoning_effort = reasoningMode === 'fast' ? 'low' : reasoningMode === 'balanced' ? 'high' : 'max';
  }
  return payload;
}

async function requestCandidate(candidate, task, request) {
  const payload = requestPayload(candidate, task, request);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${candidate.apiKey}`,
  };
  if (isObject(candidate.provider.headers)) {
    for (const [key, value] of Object.entries(candidate.provider.headers)) {
      if (!/^(?:authorization|cookie)$/i.test(key) && typeof value === 'string' && !value.includes('__SECRET')) headers[key] = value;
    }
  }
  const timeoutMs = number(task.settings?.timeoutMs ?? request.timeoutMs, 45000, 1000, 300000);
  const response = await fetchWithTimeout(candidate.baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = safeProviderMessage(data?.error?.message || data?.message || data?.detail || '');
    } catch {
      try { detail = safeProviderMessage(await response.text()); } catch {}
    }
    const status = response.status;
    const code = status === 401 || status === 403 ? 'AI_AUTH_ERROR' : 'AI_HTTP_ERROR';
    throw new HttpError(status >= 500 ? 502 : status, `AI 服务请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, code);
  }
  let data;
  try { data = await response.json(); } catch {
    throw new HttpError(502, 'AI 服务没有返回有效响应包装。', 'AI_INVALID_RESPONSE');
  }
  const choice = data?.choices?.[0] || {};
  const output = contentText(choice?.message?.content);
  if (!output) throw new HttpError(502, 'AI 服务返回了空内容。', 'AI_EMPTY_RESPONSE');
  const json = request.json === false ? null : parseJsonText(output);
  if (request.json !== false && json === null) throw new HttpError(502, 'AI 没有返回可解析的 JSON。', 'AI_JSON_INVALID');
  return {
    provider: candidate.providerId,
    model: candidate.model.id,
    text: output,
    json,
    usage: data?.usage || null,
  };
}

export async function runLocalAgentTask(env, taskId, request = {}) {
  const { runtime, task } = await getAgentTask(env, taskId);
  const route = routeCandidates(env, runtime, task, request);
  const attempts = [];
  const maxAttempts = route.allowFallback ? route.candidates.length : Math.min(1, route.candidates.length);
  for (const candidate of route.candidates.slice(0, maxAttempts)) {
    try {
      const result = await requestCandidate(candidate, task, request);
      return {
        ...result,
        taskId,
        configurationHash: runtime.source.configurationHash,
        workflowHash: runtime.source.workflowHash,
        attempts: [...attempts, { provider: candidate.providerId, model: candidate.model.id, outcome: 'success' }],
      };
    } catch (error) {
      attempts.push({
        provider: candidate.providerId,
        model: candidate.model.id,
        outcome: 'failed',
        code: error?.code || 'AI_PROVIDER_ERROR',
        message: safeProviderMessage(error instanceof Error ? error.message : String(error)),
      });
      if (!route.allowFallback) throw error;
    }
  }
  const final = attempts.at(-1);
  throw new HttpError(502, `所有符合局域网约束的 AI 均调用失败${final?.message ? `：${final.message}` : ''}`, 'AI_ALL_PROVIDERS_FAILED');
}

export const agentProviderInternals = Object.freeze({
  normalizeUrl,
  parseJsonText,
  routeCandidates,
});
