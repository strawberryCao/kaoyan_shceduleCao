const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  emptyAiConfig,
  maskApiKey,
  normalizeApiKey,
  normalizeBaseUrl,
  providerStatus,
  readAiConfig,
  removeProvider,
  upsertProvider,
  validateStoredProvider,
  writeAiConfig,
} = require('../secure-ai-config.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const { safeResponseSummary } = require('../test-ai-provider.cjs');

test('validates keys and HTTPS provider endpoints before they reach disk', () => {
  assert.equal(normalizeApiKey('  sk-1234567890abcdef  '), 'sk-1234567890abcdef');
  assert.throws(() => normalizeApiKey('replace-me'), /short|placeholder/);
  assert.throws(() => normalizeApiKey('sk-valid but spaced'), /whitespace/);
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => normalizeBaseUrl('http://api.example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://user:secret@example.com/v1'), /credentials/);
});

test('provider updates preserve unknown task configuration and do not duplicate models', () => {
  const original = {
    ...emptyAiConfig(),
    futureField: { keep: true },
    tasks: { canvas_organizer: { enabled: true, futureOption: 7 } },
  };
  const updated = upsertProvider(original, {
    id: 'qwen',
    apiKey: 'sk-1234567890abcdef',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: 'qwen3-vl-plus,qwen3-vl-plus,qwen3-max',
  });
  assert.deepEqual(updated.futureField, { keep: true });
  assert.equal(updated.tasks.canvas_organizer.futureOption, 7);
  assert.deepEqual(updated.providers.qwen.models.map((model) => model.id), ['qwen3-vl-plus', 'qwen3-max']);

  const rotated = upsertProvider(updated, { id: 'qwen', apiKey: 'sk-fedcba0987654321' });
  assert.equal(rotated.providers.qwen.apiKey, 'sk-fedcba0987654321');
  assert.deepEqual(rotated.providers.qwen.models, updated.providers.qwen.models);
});

test('status output masks credentials and secret removal is provider-scoped', () => {
  const configured = upsertProvider(emptyAiConfig(), {
    id: 'gemini',
    apiKey: 'AIzaSy1234567890abcdef',
    models: ['gemini-2.5-flash'],
  });
  const statusText = JSON.stringify(providerStatus(configured));
  assert.doesNotMatch(statusText, /AIzaSy1234567890abcdef/);
  assert.match(statusText, /AIza…cdef/);
  assert.equal(maskApiKey('AIzaSy1234567890abcdef'), 'AIza…cdef (长度 22)');
  const removed = removeProvider(configured, 'gemini');
  assert.equal(removed.providers.gemini, undefined);
});

test('writes secrets separately from a non-secret status document', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-secure-config-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: temporaryRoot } });
  const secret = 'sk-1234567890abcdef';
  const config = upsertProvider(emptyAiConfig(), { id: 'deepseek', apiKey: secret, models: 'deepseek-chat' });
  writeAiConfig(runtime, config);

  assert.equal(readAiConfig(runtime.aiConfigPath).providers.deepseek.apiKey, secret);
  const publicStatus = fs.readFileSync(path.join(runtime.configRoot, 'ai-provider-status.json'), 'utf8');
  assert.doesNotMatch(publicStatus, new RegExp(secret));
  assert.doesNotMatch(publicStatus, /apiKey/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(runtime.aiConfigPath).mode & 0o077, 0);
});

test('invalid existing JSON fails closed instead of being silently overwritten', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-invalid-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'ai-providers.json');
  fs.writeFileSync(configPath, '{invalid', 'utf8');
  assert.throws(() => readAiConfig(configPath), /not valid JSON/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{invalid');
});

test('stored provider validation rejects manually corrupted complete-looking values', () => {
  assert.throws(() => validateStoredProvider('qwen', {
    apiKey: 'sk-1234567890abcdef',
    baseUrl: 'http://remote.example.com/v1',
    models: [{ id: 'qwen3-vl-plus' }],
  }), /HTTPS/);
  const status = providerStatus({
    providers: {
      qwen: {
        apiKey: 'sk-1234567890abcdef',
        baseUrl: 'http://remote.example.com/v1',
        models: [{ id: 'qwen3-vl-plus' }],
      },
    },
  }).find((provider) => provider.id === 'qwen');
  assert.equal(status.configured, false);
  assert.match(status.validationError, /HTTPS/);
});

test('live provider diagnostics redact a key even when an upstream reflects it', () => {
  const secret = 'unusual-provider-secret-1234567890';
  const summary = safeResponseSummary(JSON.stringify({
    error: { message: `Authorization failed for ${secret} and sk-reflected123456` },
  }), [secret]);
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, /sk-reflected123456/);
  assert.match(text, /已隐藏的 API Key/);
});
