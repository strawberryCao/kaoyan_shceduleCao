const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireRuntimeLock,
  createChildSpecifications,
  parseArguments,
  runDoctor,
} = require('../macmini-runtime.cjs');
const { provisionRuntimeLayout, resolveRuntimePaths } = require('../runtime-paths.cjs');

test('parses runtime commands without accepting unknown flags', () => {
  assert.deepEqual(parseArguments(['doctor', '--json', '--web-port=6173', '--note-port=6174']), {
    command: 'doctor',
    json: true,
    runtimeRoot: '',
    notePort: 6174,
    webPort: 6173,
  });
  assert.throws(() => parseArguments(['serve', '--secret=leak']), /Unknown argument/);
});

test('child services share one managed layout and bind the web gateway to loopback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-runtime-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  const specs = createChildSpecifications(runtime, {
    notePort: 6174,
    webPort: 6173,
    nodePath: process.execPath,
    environment: { QWEN_API_KEY: 'must-not-survive', GEMINI_MODEL: 'stale-model' },
  });
  assert.deepEqual(specs.map((spec) => spec.id), ['note-service', 'web-gateway', 'backup-scheduler']);
  assert.deepEqual(specs.map((spec) => spec.critical), [true, true, false]);
  for (const spec of specs) {
    assert.equal(spec.environment.KAOYAN_RUNTIME_ROOT, runtime.runtimeRoot);
    assert.equal(spec.environment.KAOYAN_NOTES_ROOT, runtime.notesRoot);
    assert.equal(spec.environment.KAOYAN_AI_CONFIG_PATH, runtime.aiConfigPath);
    assert.equal(spec.environment.KAOYAN_WEB_HOST, '127.0.0.1');
    assert.equal(spec.environment.KAOYAN_NOTE_PORT, '6174');
    assert.equal(spec.environment.KAOYAN_WEB_PORT, '6173');
    assert.equal(spec.environment.KAOYAN_SYNC_ROLE, 'mac-authority');
    assert.equal(spec.environment.KAOYAN_TRUST_LOOPBACK_INGRESS, '1');
    assert.equal(spec.environment.KAOYAN_MOBILE_AUTH_CONFIG_PATH, path.join(runtime.secretsRoot, 'mobile-access.json'));
    assert.equal(spec.environment.QWEN_API_KEY, undefined);
    assert.equal(spec.environment.GEMINI_MODEL, undefined);
  }
});

test('runtime lock rejects a live owner, replaces a stale lock, and uses an ownership token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-runtime-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  provisionRuntimeLayout(runtime);
  const lockPath = path.join(runtime.runRoot, 'macmini-runtime.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 42, token: 'old' }), 'utf8');
  assert.throws(() => acquireRuntimeLock(lockPath, {
    pid: 99,
    processKill(pid) {
      assert.equal(pid, 42);
    },
  }), /already running/);

  const lock = acquireRuntimeLock(lockPath, {
    pid: 99,
    processKill() {
      const error = new Error('missing');
      error.code = 'ESRCH';
      throw error;
    },
  });
  const stored = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(stored.pid, 99);
  assert.notEqual(stored.token, 'old');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 100, token: 'replacement' }), 'utf8');
  lock.release();
  assert.equal(fs.existsSync(lockPath), true, 'another process lock must not be removed');
});

test('doctor reports a manually corrupted provider as an error without exposing its key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-runtime-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  provisionRuntimeLayout(runtime);
  fs.writeFileSync(runtime.aiConfigPath, JSON.stringify({
    version: 2,
    providers: {
      qwen: {
        apiKey: 'sk-never-print-this-12345',
        baseUrl: 'http://remote.example.com/v1',
        models: [{ id: 'qwen3-vl-plus' }],
      },
    },
  }), 'utf8');
  const report = runDoctor(runtime, { projectRoot: path.resolve(__dirname, '..', '..') });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'ai-provider-config').ok, false);
  assert.doesNotMatch(JSON.stringify(report), /sk-never-print-this/);
});
