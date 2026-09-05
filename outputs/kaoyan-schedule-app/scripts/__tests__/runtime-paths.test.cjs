const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertSafeRuntimePaths,
  atomicWriteJson,
  createRuntimeEnvironment,
  provisionRuntimeLayout,
  resolveRuntimePaths,
  withoutLegacyAiProviderEnvironment,
} = require('../runtime-paths.cjs');

test('keeps the existing Windows desktop layout unless managed mode is explicit', () => {
  const runtime = resolveRuntimePaths({
    platform: 'win32',
    homeDir: 'C:\\Users\\Study',
    pathImpl: path.win32,
    env: {},
  });
  assert.equal(runtime.layout, 'legacy');
  assert.equal(runtime.notesRoot, 'C:\\Users\\Study\\Desktop\\笔记');
  assert.equal(runtime.assistantRoot, 'C:\\Users\\Study\\Desktop\\考研桌面助手');
});

test('uses Application Support for an interactive Mac and the system root for a LaunchDaemon', () => {
  const userRuntime = resolveRuntimePaths({
    platform: 'darwin',
    homeDir: '/Users/study',
    pathImpl: path.posix,
    env: {},
  });
  assert.equal(userRuntime.layout, 'managed');
  assert.equal(userRuntime.runtimeRoot, '/Users/study/Library/Application Support/KaoyanStudyCenter');
  assert.equal(userRuntime.notesRoot, '/Users/study/Library/Application Support/KaoyanStudyCenter/data/notes');
  assert.equal(userRuntime.aiConfigPath, '/Users/study/Library/Application Support/KaoyanStudyCenter/secrets/ai-providers.json');

  const serviceRuntime = resolveRuntimePaths({
    platform: 'darwin',
    homeDir: '/Users/study',
    pathImpl: path.posix,
    env: { KAOYAN_SERVICE_MODE: 'system' },
  });
  assert.equal(serviceRuntime.runtimeRoot, '/Library/Application Support/KaoyanStudyCenter');
});

test('an explicit runtime root creates one self-contained managed layout', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-runtime-layout-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: temporaryRoot } });
  provisionRuntimeLayout(runtime);

  for (const directory of [
    runtime.configRoot,
    runtime.secretsRoot,
    runtime.notesRoot,
    runtime.assistantRoot,
    runtime.assetsRoot,
    runtime.backupsRoot,
    runtime.logsRoot,
    runtime.runRoot,
    runtime.releasesRoot,
  ]) {
    assert.equal(fs.statSync(directory).isDirectory(), true, directory);
  }
  const manifest = JSON.parse(fs.readFileSync(runtime.runtimeConfigPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.paths.runtimeRoot, runtime.runtimeRoot);

  const environment = createRuntimeEnvironment(runtime, { SENTINEL: 'keep' });
  assert.equal(environment.SENTINEL, 'keep');
  assert.equal(environment.KAOYAN_NOTES_ROOT, runtime.notesRoot);
  assert.equal(environment.KAOYAN_AI_CONFIG_PATH, runtime.aiConfigPath);
});

test('secure JSON writes replace complete files and leave no temporary artifact', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-atomic-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'secrets', 'provider.json');
  atomicWriteJson(target, { value: 1 });
  atomicWriteJson(target, { value: 2, nested: { ok: true } });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { value: 2, nested: { ok: true } });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['provider.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o077, 0);
});

test('refuses a filesystem root or home directory as a runtime root', () => {
  const root = path.parse(process.cwd()).root;
  const unsafeRoot = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  assert.throws(() => assertSafeRuntimePaths(unsafeRoot), /unsafe runtime root/);
  const home = os.homedir();
  const unsafeHome = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: home } });
  assert.throws(() => assertSafeRuntimePaths(unsafeHome), /unsafe runtime root/);
});

test('a managed layout cannot redirect data or secrets outside its runtime root', () => {
  const runtimeRoot = path.join(os.tmpdir(), 'kaoyan-contained-runtime');
  const escapedNotes = resolveRuntimePaths({
    env: {
      KAOYAN_RUNTIME_ROOT: runtimeRoot,
      KAOYAN_NOTES_ROOT: path.join(os.tmpdir(), 'escaped-notes'),
    },
  });
  assert.throws(() => assertSafeRuntimePaths(escapedNotes), /must stay inside/);
  const escapedSecrets = resolveRuntimePaths({
    env: {
      KAOYAN_RUNTIME_ROOT: runtimeRoot,
      KAOYAN_AI_CONFIG_PATH: path.join(os.tmpdir(), 'escaped-ai.json'),
    },
  });
  assert.throws(() => assertSafeRuntimePaths(escapedSecrets), /AI config must stay inside/);
});

test('managed services discard every legacy AI provider override but preserve unrelated environment', () => {
  const sanitized = withoutLegacyAiProviderEnvironment({
    QWEN_API_KEY: 'secret-a',
    DASHSCOPE_API_KEY: 'secret-b',
    GEMINI_MODEL: 'stale-model',
    KIMI_BASE_URL: 'https://stale.example',
    MOONSHOT_API_KEY: 'secret-c',
    DEEPSEEK_PRIORITY: '99',
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    KAOYAN_NOTE_PORT: '5174',
  });
  assert.deepEqual(sanitized, {
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    KAOYAN_NOTE_PORT: '5174',
  });
});
