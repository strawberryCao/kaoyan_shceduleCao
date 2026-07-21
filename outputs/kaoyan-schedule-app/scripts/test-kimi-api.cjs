#!/usr/bin/env node

const { loadAiProviderConfigs } = require('./ai-router.cjs');

function modelsUrl(completionsUrl) {
  const url = new URL(completionsUrl);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
  url.search = '';
  return url.toString();
}

async function timedFetch(url, init, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - startedAt, body };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function probeModel(provider, model, timeoutMs) {
  const result = await timedFetch(provider.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.headers || {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '只返回严格 JSON：{"ok":true}' }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 512,
    }),
  }, timeoutMs);
  const data = safeJson(result.body);
  const choice = data?.choices?.[0];
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
  return {
    model,
    ok: result.ok,
    status: result.status,
    elapsedMs: result.elapsedMs,
    finishReason: choice?.finish_reason || null,
    contentChars: content.length,
    reasoningChars: reasoning.length,
    usage: data?.usage || null,
    error: result.error || data?.error?.message || data?.message || null,
  };
}

async function main() {
  const loaded = loadAiProviderConfigs();
  const provider = loaded.providers.find((item) => item.id === 'kimi');
  if (!provider?.apiKey || !provider?.baseUrl) throw new Error('Kimi is not configured');
  const modelResult = await timedFetch(modelsUrl(provider.baseUrl), {
    headers: { Authorization: `Bearer ${provider.apiKey}`, ...(provider.headers || {}) },
  }, 15_000);
  const modelData = safeJson(modelResult.body);
  const availableModels = Array.isArray(modelData?.data) ? modelData.data.map((item) => item?.id).filter(Boolean) : [];
  const report = {
    endpoint: new URL(provider.baseUrl).origin,
    modelsRequest: {
      ok: modelResult.ok,
      status: modelResult.status,
      elapsedMs: modelResult.elapsedMs,
      error: modelResult.error || modelData?.error?.message || null,
      selectedModelsAvailable: ['kimi-k3', 'kimi-k2.6'].filter((id) => availableModels.includes(id)),
      returnedModelCount: availableModels.length,
    },
    probes: [],
  };
  for (const model of ['kimi-k3', 'kimi-k2.6']) {
    report.probes.push(await probeModel(provider, model, 45_000));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
