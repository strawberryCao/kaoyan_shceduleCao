const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { AI_TASK_DEFINITIONS } = require('../ai-router.cjs');
const { classify, providerSecretRef, sanitizeValue } = require('../export-agent-runtime.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runExport(assistantRoot, outputRoot) {
  const script = path.resolve(__dirname, '..', 'export-agent-runtime.cjs');
  const result = spawnSync(process.execPath, [script, '--assistant-root', assistantRoot, '--output-root', outputRoot], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('classifies uploaded assistant JSON by purpose instead of treating runtime data as Agent config', () => {
  assert.equal(classify('ai-providers.json'), 'agent-config');
  assert.equal(classify('qwen-config.json'), 'agent-config');
  assert.equal(classify('note-taxonomy.json'), 'agent-config');
  assert.equal(classify('desktop-layout.json'), 'ui-setting');
  assert.equal(classify('learning-data.json'), 'user-data');
  assert.equal(classify('canvas-projects/document-1/document.json'), 'user-data');
  assert.equal(classify('canvas-projects/.trash/document-1/document.json'), 'backup');
  assert.equal(classify('note-save-receipts/id.json'), 'runtime-state');
  assert.equal(classify('review-github-sync/status.json'), 'runtime-state');
  assert.equal(classify('repair-backups/a/learning-data.json'), 'backup');
});

test('redacts secret values, local paths and local-only URLs while preserving structure', () => {
  const report = { redactedFields: 0, redactedValues: 0, localPaths: 0, localUrls: 0 };
  const sanitized = sanitizeValue({
    apiKey: 'sk-very-secret-value',
    nested: {
      Authorization: 'Bearer abcdefghijklmnop',
      output: 'C:\\Users\\ASUS\\Desktop\\笔记',
      endpoint: 'http://127.0.0.1:8000/v1',
    },
  }, report);
  assert.match(sanitized.apiKey, /^__SECRET_REF:/);
  assert.match(sanitized.nested.Authorization, /^__SECRET_REF:/);
  assert.equal(sanitized.nested.output, '__LOCAL_PATH__');
  assert.equal(sanitized.nested.endpoint, '__LOCAL_ONLY_URL__');
  assert.ok(report.redactedFields >= 2);
  assert.equal(providerSecretRef('kimi'), 'KIMI_API_KEY');
});

test('exports every local Agent task contract, excludes runtime data, and stays stable when only receipts change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-agent-export-'));
  const assistantRoot = path.join(root, 'assistant');
  const outputRoot = path.join(root, 'out');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeJson(path.join(assistantRoot, 'ai-providers.json'), {
    providers: {
      kimi: {
        enabled: true,
        apiKey: 'sk-do-not-publish-this-value',
        baseUrl: 'https://api.moonshot.cn/v1',
        models: [{ id: 'kimi-k3', capabilities: ['text', 'vision', 'json'] }],
      },
    },
    routing: { timeoutMs: 30000 },
    tasks: {
      note_naming: {
        providerId: 'kimi',
        modelId: 'kimi-k3',
        customInstructions: '只输出中文标题',
      },
    },
  });
  writeJson(path.join(assistantRoot, 'qwen-config.json'), {
    apiKey: 'sk-qwen-secret',
    model: 'qwen3-vl-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  });
  writeJson(path.join(assistantRoot, 'note-taxonomy.json'), { subjects: [] });
  writeJson(path.join(assistantRoot, 'note-save-receipts', 'receipt.json'), {
    filePath: 'C:\\Users\\ASUS\\Desktop\\笔记\\a.png',
  });
  writeJson(path.join(assistantRoot, 'canvas-projects', 'canvas-1', 'document.json'), { id: 'canvas-1' });

  const first = runExport(assistantRoot, outputRoot);
  const runtime = JSON.parse(fs.readFileSync(path.join(outputRoot, 'agent-runtime.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
  const firstRuntimeText = fs.readFileSync(path.join(outputRoot, 'agent-runtime.json'), 'utf8');
  const firstManifestText = fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8');
  const serialized = JSON.stringify({ runtime, manifest });

  assert.equal(runtime.strictMode, true);
  assert.equal(runtime.failClosed, true);
  assert.deepEqual(Object.keys(runtime.tasks).sort(), Object.keys(AI_TASK_DEFINITIONS).sort());
  assert.equal(runtime.tasks.note_naming.settings.customInstructions, '只输出中文标题');
  assert.equal(runtime.providers.kimi.secretRef, 'KIMI_API_KEY');
  assert.doesNotMatch(serialized, /do-not-publish|qwen-secret/);
  assert.deepEqual(manifest.excludedByRule, ['backup', 'runtime-state', 'user-data', 'unclassified']);
  assert.equal(first.excludedCounts['runtime-state'], 1);
  assert.equal(first.excludedCounts['user-data'], 1);
  assert.equal(fs.existsSync(path.join(outputRoot, 'files', 'note-save-receipts', 'receipt.json')), false);
  assert.equal(fs.existsSync(path.join(outputRoot, 'files', 'canvas-projects', 'canvas-1', 'document.json')), false);

  writeJson(path.join(assistantRoot, 'note-save-receipts', 'another-receipt.json'), { status: 'new' });
  const second = runExport(assistantRoot, outputRoot);
  assert.equal(second.runtimeHash, first.runtimeHash);
  assert.equal(fs.readFileSync(path.join(outputRoot, 'agent-runtime.json'), 'utf8'), firstRuntimeText);
  assert.equal(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'), firstManifestText);
});
