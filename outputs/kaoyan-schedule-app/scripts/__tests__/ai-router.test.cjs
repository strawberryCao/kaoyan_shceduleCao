const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAiRouter,
  extractJsonValue,
  loadAiProviderConfigs,
  normalizeTaskConfigurations,
  resolveTaskOptions,
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
      tasks: overrides.tasks || {},
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
  assert.equal(config.providers[0].models[0].id, 'gemini-env-model');
  assert.ok(config.providers[0].models.some((item) => item.id === 'gemini-2.5-flash'));
});

test('a saved provider key wins over a stale environment key', () => {
  const config = loadAiProviderConfigs({
    env: { MOONSHOT_API_KEY: 'stale-environment-key' },
    localConfig: {
      providers: {
        kimi: {
          apiKey: 'current-saved-key',
          model: 'kimi-k3',
          baseUrl: 'https://api.moonshot.test/v1',
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

  assert.equal(config.providers[0].id, 'kimi');
  assert.equal(config.providers[0].apiKey, 'current-saved-key');
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

test('normalizes safe per-task settings and ignores unknown tasks or fields', () => {
  assert.deepEqual(normalizeTaskConfigurations({
    note_naming: {
      enabled: true,
      providerId: ' GEMINI ',
      modelId: 'gemini-fast',
      fallback: false,
      difficulty: 'high',
      temperature: 9,
      timeoutMs: 20,
      customInstructions: ' 标题不超过 12 个字 ',
      options: {
        titleStyle: 'question_type',
        titleMinLength: -10,
        titleMaxLength: 999,
        useRemark: false,
        unknownOption: 'must-not-survive',
      },
      namingRules: [{
        id: 'tank rule!',
        name: ' 缸号命名 ',
        enabled: true,
        when: ' 图片中有缸号 ',
        extract: ' 提取缸号字段 ',
        titleTemplate: '{value}',
        validationHint: ' 例如 250626-088 ',
      }],
      apiKey: 'must-not-survive',
    },
    unknown_task: { modelId: 'ignored' },
  }), {
    note_naming: {
      enabled: true,
      providerId: 'gemini',
      modelId: 'gemini-fast',
      fallback: false,
      difficulty: 'high',
      temperature: 2,
      timeoutMs: 1_000,
      customInstructions: '标题不超过 12 个字',
      namingRules: [{
        id: 'tankrule',
        name: '缸号命名',
        enabled: true,
        when: '图片中有缸号',
        extract: '提取缸号字段',
        titleTemplate: '{value}',
        validationHint: '例如 250626-088',
      }],
      options: {
        titleStyle: 'question_type',
        titleMinLength: 4,
        titleMaxLength: 80,
        useRemark: false,
      },
    },
  });
});

test('infers Kimi K3 as a vision-capable selectable model', () => {
  const config = loadAiProviderConfigs({
    env: {},
    localConfig: {
      providers: { kimi: { apiKey: 'k-secret', model: 'kimi-k3' } },
    },
    legacyQwenConfig: { apiKey: '', model: '', baseUrl: '', assistantRoot: 'C:\\private-config' },
  });
  const kimi = config.providers.find((provider) => provider.id === 'kimi');
  assert.ok(kimi);
  assert.ok(kimi.models[0].capabilities.includes('vision'));
});

test('applies the selected task model and custom instructions to the request', async () => {
  const calls = [];
  const router = makeRouter(
    [
      provider('qwen', { priority: 100 }),
      provider('gemini', { model: 'gemini-naming' }),
    ],
    async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return fakeResponse(200, '{"title":"极限求导"}');
    },
    {
      tasks: {
        note_naming: {
          providerId: 'gemini',
          modelId: 'gemini-naming',
          fallback: false,
          difficulty: 'high',
          temperature: 0.25,
          customInstructions: '标题不超过 12 个字。',
          options: { titleStyle: 'source_wording', titleMaxLength: 16 },
        },
      },
    },
  );

  const result = await router.complete({
    task: 'note_naming',
    messages: [{ role: 'user', content: '命名这张图' }],
    json: true,
  });

  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-naming');
  assert.equal(result.difficulty, 'high');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini\.example/);
  assert.equal(calls[0].body.temperature, 0.25);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /标题不超过 12 个字/);
  assert.match(calls[0].body.messages[0].content, /标题最多字数：16/);
  assert.equal(calls[0].body.messages[1].content, '命名这张图');
  assert.equal(router.getTaskOptions('note_naming').titleStyle, 'source_wording');
  assert.equal(router.getTaskOptions('note_naming').titleMinLength, 8);
});

test('can explicitly route to a catalog model that is not the provider default', async () => {
  const calls = [];
  const router = makeRouter(
    [provider('gemini', { model: 'gemini-default' })],
    async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return fakeResponse(200, '{"title":"目录模型"}');
    },
    {
      tasks: {
        note_naming: {
          providerId: 'gemini',
          modelId: 'gemini-2.5-flash',
          fallback: false,
        },
      },
    },
  );

  const result = await router.complete({
    task: 'note_naming',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    json: true,
  });
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(calls[0].model, 'gemini-2.5-flash');
});

test('does not fall back when a task is pinned to one model', async () => {
  const calls = [];
  const router = makeRouter(
    [provider('qwen'), provider('gemini')],
    async (url) => {
      calls.push(url);
      return url.includes('qwen.example') ? fakeResponse(503, 'failed') : fakeResponse(200, 'unexpected');
    },
    {
      tasks: {
        custom: { providerId: 'qwen', modelId: 'qwen-model', fallback: false },
      },
    },
  );

  await assert.rejects(
    router.complete({ task: 'custom', messages: [{ role: 'user', content: 'hello' }] }),
    { code: 'AI_ALL_PROVIDERS_FAILED' },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /qwen\.example/);
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

test('omits incompatible temperature and uses completion tokens for Kimi K3', async () => {
  let requestBody;
  const router = makeRouter(
    [provider('kimi', { model: 'kimi-k3', costTier: 2, qualityTier: 3 })],
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

test('maps the canvas reasoning mode to official Kimi model parameters', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return fakeResponse(200, '{"ok":true}');
  };
  const k26 = makeRouter(
    [provider('kimi', { model: 'kimi-k2.6', costTier: 3, qualityTier: 3 })],
    fetchImpl,
    { tasks: { canvas_organization: { providerId: 'kimi', modelId: 'kimi-k2.6', fallback: false, options: { reasoningMode: 'fast' } } } },
  );
  await k26.complete({
    task: 'canvas_organization',
    messages: [{ role: 'user', content: 'layout' }],
    json: true,
  });
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });

  const k3 = makeRouter(
    [provider('kimi', { model: 'kimi-k3', costTier: 3, qualityTier: 3 })],
    fetchImpl,
    { tasks: { canvas_organization: { providerId: 'kimi', modelId: 'kimi-k3', fallback: false, options: { reasoningMode: 'balanced' } } } },
  );
  await k3.complete({
    task: 'canvas_organization',
    messages: [{ role: 'user', content: 'layout' }],
    json: true,
  });
  assert.equal(bodies[1].reasoning_effort, 'high');
});

test('reports when Kimi reasoning exhausts the completion budget before final content', async () => {
  const router = makeRouter(
    [provider('kimi', { model: 'kimi-k2.6', costTier: 3, qualityTier: 3 })],
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: '', reasoning_content: 'long reasoning' }, finish_reason: 'length' }],
          usage: { completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1980 } },
        };
      },
    }),
    { routing: { networkRetries: 0 } },
  );
  await assert.rejects(router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'organize' }],
    maxTokens: 2000,
  }), (error) => {
    assert.match(error.message, /完成 Token 2000\/2000/);
    assert.match(error.message, /推理 Token 1980/);
    assert.match(error.message, /耗尽了完成 Token 预算/);
    assert.equal(error.attempts[0].code, 'AI_TOKEN_BUDGET_EXHAUSTED');
    return true;
  });
});

test('uses a fixed canvas completion budget by default for reasoning models', () => {
  const options = resolveTaskOptions('canvas_organization', {});
  assert.equal(options.tokenBudgetMode, 'fixed');
  assert.equal(options.maxTokens, 4096);
  assert.equal(options.reasoningMode, 'fast');
});

test('includes the provider error detail in the final router error', async () => {
  const router = makeRouter(
    [provider('kimi', { model: 'kimi-k3' })],
    async () => ({
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({ error: { message: 'invalid temperature: only 1 is allowed for this model' } });
      },
    }),
  );

  await assert.rejects(
    router.complete({ task: 'custom', messages: [{ role: 'user', content: 'hello' }] }),
    (error) => {
      assert.match(error.message, /invalid temperature/);
      assert.match(error.attempts[0].message, /HTTP 400/);
      return true;
    },
  );
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

test('opens the provider circuit immediately after an authentication failure', async () => {
  let fetchCount = 0;
  const router = makeRouter(
    [provider('kimi')],
    async () => {
      fetchCount += 1;
      return fakeResponse(401, 'ignored');
    },
  );
  const request = { task: 'custom', messages: [{ role: 'user', content: 'hello' }] };
  await assert.rejects(router.complete(request), { code: 'AI_ALL_PROVIDERS_FAILED' });
  await assert.rejects(router.complete(request), { code: 'AI_NO_PROVIDER' });
  assert.equal(fetchCount, 1);
  assert.equal(router.getStatus().providers[0].circuit.open, true);
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

test('repairs common LaTeX backslashes and trailing commas in model JSON', () => {
  const value = extractJsonValue(String.raw`{"formula":"f(x)=\frac{1}{x}+\sqrt{x}","tags":["公式",],}`);
  assert.deepEqual(value, { formula: String.raw`f(x)=\frac{1}{x}+\sqrt{x}`, tags: ['公式'] });
});

test('prunes harmless unknown fields before rejecting a structured response', async () => {
  let calls = 0;
  const router = makeRouter(
    [provider('qwen')],
    async () => {
      calls += 1;
      return fakeResponse(200, '{"ok":true,"message":"图片可读取"}');
    },
    { routing: { jsonRepairRetries: 0 } },
  );
  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'probe' }],
    responseSchema: {
      type: 'object',
      required: ['ok'],
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
    },
  });
  assert.deepEqual(result.json, { ok: true });
  assert.equal(calls, 1);
});

test('normalizes a provider JSON result before strict schema validation', async () => {
  const router = makeRouter(
    [provider('qwen')],
    async () => fakeResponse(200, '{"layouts":[{"id":"a","x":"10","y":"20"}]}'),
  );
  const result = await router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'layout' }],
    normalizeJson(value) {
      return {
        summary: value.summary || 'fallback summary',
        layouts: value.layouts.map((item) => ({ ...item, x: Number(item.x), y: Number(item.y) })),
      };
    },
    responseSchema: {
      type: 'object',
      required: ['summary', 'layouts'],
      additionalProperties: false,
      properties: {
        summary: { type: 'string', minLength: 1 },
        layouts: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'x', 'y'], properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } },
      },
    },
  });
  assert.equal(result.json.summary, 'fallback summary');
  assert.equal(result.json.layouts[0].x, 10);
});

test('lets a time-sensitive task disable same-model retries and report attempts', async () => {
  let calls = 0;
  const attempts = [];
  const router = makeRouter(
    [provider('kimi')],
    async () => {
      calls += 1;
      return fakeResponse(503, 'temporarily unavailable');
    },
    { routing: { networkRetries: 1 } },
  );
  await assert.rejects(router.complete({
    task: 'custom',
    messages: [{ role: 'user', content: 'organize' }],
    timeoutMs: 90_000,
    networkRetries: 0,
    onAttempt: (attempt) => attempts.push(attempt),
  }), { code: 'AI_ALL_PROVIDERS_FAILED' });
  assert.equal(calls, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider, 'kimi');
  assert.equal(attempts[0].timeoutMs, 90_000);
  assert.equal(attempts[0].allowFallback, true);
});
