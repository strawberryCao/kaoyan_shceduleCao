const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAiRouter,
  extractJsonValue,
  loadAiProviderConfigs,
  validateJsonAgainstSchema,
} = require('../ai-router.cjs');

function fakeResponse(status, content, usage = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {
        choices: [{ message: { content } }],
        usage,
      };
    },
  };
}

function provider(id, options = {}) {
  return {
    id,
    enabled: true,
    apiKey: options.apiKey || `${id}-very-secret-key`,
    baseUrl: options.baseUrl || `https://${id}.example/v1`,
    priority: options.priority || 0,
    models: [
      {
        id: options.model || `${id}-model`,
        capabilities: options.capabilities || ['text', 'vision', 'json', 'longContext'],
        costTier: options.costTier || 2,
        qualityTier: options.qualityTier || 2,
        supportsResponseFormat: options.supportsResponseFormat ?? true,
      },
    ],
  };
}

function makeRouter(providers, fetchImpl, overrides = {}) {
  return createAiRouter({
    config: {
      providers,
      routing: {
        timeoutMs: 100,
        circuitThreshold: 3,
        circuitCooldownMs: 1_000,
        networkRetries: 0,
        jsonRepairRetries: 1,
        ...overrides.routing,
      },
    },
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

test('loads the existing Qwen configuration and optional Gemini/Kimi environment providers', () => {
  const config = loadAiProviderConfigs({
    env: {
      GEMINI_API_KEY: 'gemini-secret',
      GEMINI_MODEL: 'gemini-fast',
      GEMINI_BASE_URL: 'https://generativelanguage.googleapis.test/v1beta/openai',
      GEMINI_CAPABILITIES: 'text,vision,json,long-context',
      MOONSHOT_API_KEY: 'kimi-secret',
      MOONSHOT_MODEL: 'kimi-strong',
      MOONSHOT_BASE_URL: 'https://api.moonshot.test/v1',
      MOONSHOT_CAPABILITIES: 'text,json,long-context,reasoning',
    },
    localConfig: {},
    legacyQwenConfig: {
      apiKey: 'qwen-secret',
      model: 'qwen-vl-plus',
      baseUrl: 'https://dashscope.test/compatible-mode/v1/chat/completions',
      assistantRoot: 'C:\\private-config',
    },
  });

  assert.deepEqual(config.providers.map((item) => item.id), ['qwen', 'gemini', 'kimi']);
  assert.equal(config.providers[0].models[0].id, 'qwen-vl-plus');
  assert.equal(config.providers[1].baseUrl, 'https://generativelanguage.googleapis.test/v1beta/openai/chat/completions');
  assert.equal(config.providers[2].baseUrl, 'https://api.moonshot.test/v1/chat/completions');
  assert.ok(config.providers[1].models[0].capabilities.includes('vision'));
  assert.ok(config.providers[2].models[0].capabilities.includes('longContext'));
});

test('an environment model selection overrides a local multi-model list', () => {
  const config = loadAiProviderConfigs({
    env: {
      GEMINI_API_KEY: 'gemini-secret',
      GEMINI_MODEL: 'gemini-env-model',
    },
    localConfig: {
      providers: {
        gemini: {
          baseUrl: 'https://generativelanguage.googleapis.test/v1beta/openai',
          models: ['gemini-local-cheap', 'gemini-local-strong'],
        },
      },
    },
    legacyQwenConfig: {
      apiKey: '',
      model: 'qwen-vl-plus',
      baseUrl: 'https://dashscope.test/v1',
      assistantRoot: 'C:\\private-config',
    },
  });

  assert.deepEqual(config.providers.map((item) => item.id), ['gemini']);
  assert.deepEqual(config.providers[0].models.map((item) => item.id), ['gemini-env-model']);
});

test('keeps official Gemini and Kimi base URLs when private config omits them', () => {
  const config = loadAiProviderConfigs({
    env: {},
    localConfig: {
      providers: {
        gemini: { apiKey: 'g-secret', model: 'gemini-model' },
        kimi: { apiKey: 'k-secret', model: 'kimi-model' },
      },
    },
    legacyQwenConfig: {
      apiKey: '', model: 'qwen-vl-plus', baseUrl: 'https://dashscope.test/v1', assistantRoot: 'C:\\private-config',
    },
  });
  assert.match(config.providers.find((item) => item.id === 'gemini').baseUrl, /generativelanguage\.googleapis\.com/);
  assert.match(config.providers.find((item) => item.id === 'kimi').baseUrl, /api\.moonshot\.cn/);
});

test('omits incompatible temperature and uses completion tokens for Kimi K2 thinking models', async () => {
  let requestBody;
  const router = makeRouter(
    [provider('kimi', { model: 'kimi-k2.6', costTier: 3, qualityTier: 3 })],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return fakeResponse(200, '{"ok":true}');
    },
  );
  await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'hello' }],
    json: true,
    temperature: 0.1,
    maxTokens: 256,
  });
  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
  assert.equal(Object.hasOwn(requestBody, 'max_tokens'), false);
  assert.equal(requestBody.max_completion_tokens, 256);
});

test('routes low difficulty to the cheaper model and high difficulty to the stronger model', async () => {
  const calls = [];
  const router = makeRouter(
    [
      provider('cheap', { costTier: 1, qualityTier: 1 }),
      provider('strong', { costTier: 3, qualityTier: 3 }),
    ],
    async (url) => {
      calls.push(url);
      return fakeResponse(200, '{"subject":"高数"}');
    },
  );

  const low = await router.complete({
    task: 'note_naming',
    difficulty: 'low',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    json: true,
  });
  const high = await router.complete({
    task: 'note_naming',
    difficulty: 'high',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    json: true,
  });

  assert.equal(low.provider, 'cheap');
  assert.equal(high.provider, 'strong');
  assert.match(calls[0], /cheap\.example/);
  assert.match(calls[1], /strong\.example/);
});

test('filters out models without vision capability when a request contains an image', async () => {
  const calls = [];
  const router = makeRouter(
    [
      provider('text-only', { priority: 100, capabilities: ['text', 'json'] }),
      provider('vision', { capabilities: ['text', 'vision', 'json'] }),
    ],
    async (url) => {
      calls.push(url);
      return fakeResponse(200, '{"ok":true}');
    },
  );

  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    json: true,
  });

  assert.equal(result.provider, 'vision');
  assert.equal(calls.length, 1);
});

test('falls back to the next provider after a retryable provider failure', async () => {
  const calls = [];
  const router = makeRouter(
    [
      provider('qwen', { priority: 20 }),
      provider('gemini'),
    ],
    async (url) => {
      calls.push(url);
      if (url.includes('qwen.example')) return fakeResponse(500, 'ignored');
      return fakeResponse(200, '{"title":"成功"}');
    },
  );

  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'classify' }],
    json: true,
  });

  assert.equal(result.provider, 'gemini');
  assert.equal(calls.length, 2);
  assert.deepEqual(result.attempts.map((item) => item.outcome), ['failed', 'success']);
});

test('repairs malformed JSON once on the same provider before falling back', async () => {
  const bodies = [];
  const router = makeRouter(
    [provider('qwen')],
    async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return fakeResponse(200, 'not-json');
      return fakeResponse(200, '{"subject":"高数","confidence":0.9}');
    },
  );

  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'classify' }],
    responseSchema: {
      type: 'object',
      required: ['subject', 'confidence'],
      properties: {
        subject: { type: 'string', minLength: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  });

  assert.equal(result.json.subject, '高数');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.at(-2).role, 'assistant');
  assert.match(bodies[1].messages.at(-1).content, /只返回修正后的 JSON/);
  assert.deepEqual(result.attempts.map((item) => item.phase), ['validation', 'repair']);
});

test('falls back when JSON remains schema-invalid', async () => {
  const router = makeRouter(
    [
      provider('qwen', { priority: 20 }),
      provider('kimi'),
    ],
    async (url) => {
      if (url.includes('qwen.example')) return fakeResponse(200, '{"title":123}');
      return fakeResponse(200, '{"title":"正确"}');
    },
    { routing: { jsonRepairRetries: 0 } },
  );

  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'name' }],
    responseSchema: {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' } },
    },
  });

  assert.equal(result.provider, 'kimi');
  assert.equal(result.json.title, '正确');
});

test('times out a stuck provider and falls back without waiting for its fetch promise', async () => {
  const router = makeRouter(
    [
      provider('qwen', { priority: 20 }),
      provider('gemini'),
    ],
    async (url) => {
      if (url.includes('qwen.example')) return new Promise(() => {});
      return fakeResponse(200, 'fallback-ok');
    },
    { timeoutMs: 5 },
  );

  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.provider, 'gemini');
  assert.equal(result.text, 'fallback-ok');
  assert.equal(result.attempts[0].code, 'AI_TIMEOUT');
});

test('opens a provider circuit after repeated failures and does not expose credentials in status', async () => {
  let currentTime = 10_000;
  let fetchCount = 0;
  const router = makeRouter(
    [provider('qwen', { apiKey: 'do-not-leak-this', baseUrl: 'https://private-qwen.example/v1' })],
    async () => {
      fetchCount += 1;
      return fakeResponse(503, 'ignored');
    },
    {
      now: () => currentTime,
      routing: { circuitThreshold: 2, circuitCooldownMs: 1_000 },
    },
  );

  const request = { task: 'custom', messages: [{ role: 'user', content: 'hello' }] };
  await assert.rejects(router.complete(request), { code: 'AI_ALL_PROVIDERS_FAILED' });
  await assert.rejects(router.complete(request), { code: 'AI_ALL_PROVIDERS_FAILED' });
  await assert.rejects(router.complete(request), { code: 'AI_NO_PROVIDER' });
  assert.equal(fetchCount, 2);

  const statusText = JSON.stringify(router.getStatus());
  assert.doesNotMatch(statusText, /do-not-leak-this/);
  assert.doesNotMatch(statusText, /private-qwen\.example/);
  assert.equal(router.getStatus().providers[0].circuit.open, true);

  currentTime += 1_001;
  assert.equal(router.getStatus().providers[0].circuit.open, false);
});

test('extracts fenced JSON and validates the supported JSON Schema subset', () => {
  const value = extractJsonValue('说明：\n```json\n{"tags":["错题"],"page":108}\n```');
  assert.deepEqual(value, { tags: ['错题'], page: 108 });
  assert.deepEqual(validateJsonAgainstSchema(value, {
    type: 'object',
    required: ['tags', 'page'],
    additionalProperties: false,
    properties: {
      tags: { type: 'array', minItems: 1, items: { type: 'string' } },
      page: { type: 'integer', minimum: 1 },
    },
  }), []);
  assert.ok(validateJsonAgainstSchema({ tags: [], page: 0, extra: true }, {
    type: 'object',
    required: ['tags'],
    additionalProperties: false,
    properties: {
      tags: { type: 'array', minItems: 1 },
      page: { type: 'integer', minimum: 1 },
    },
  }).length >= 3);
});
