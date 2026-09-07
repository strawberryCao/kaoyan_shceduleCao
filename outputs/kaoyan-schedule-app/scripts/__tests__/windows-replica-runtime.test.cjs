const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createChildSpecifications,
  parseArguments,
  runtimePathsForArguments,
} = require('../windows-replica-runtime.cjs');
const { notifyLocalNoteService } = require('../windows-sync-service.cjs');

test('Windows replica runtime rejects unknown flags and resolves a managed local root', () => {
  const root = path.join(os.tmpdir(), 'kaoyan-windows-runtime-test');
  const parsed = parseArguments([`--runtime-root=${root}`, '--note-port=7174']);
  assert.equal(parsed.runtimeRoot, path.resolve(root));
  assert.equal(parsed.notePort, 7174);
  assert.throws(() => parseArguments(['--token=must-not-appear']), /Unknown argument/);
  const runtime = runtimePathsForArguments(parsed, { LOCALAPPDATA: root });
  assert.equal(runtime.layout, 'managed');
  assert.equal(runtime.platform, 'win32');
});

test('Windows child services share the replica role and inherit no legacy AI keys', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-windows-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = runtimePathsForArguments({ runtimeRoot: root, notePort: 7174 }, { LOCALAPPDATA: root });
  const specs = createChildSpecifications(runtime, {
    projectRoot: path.resolve(__dirname, '..', '..'),
    nodePath: process.execPath,
    notePort: 7174,
    deviceId: 'windows-laptop',
    environment: { QWEN_API_KEY: 'old-windows-key', GEMINI_MODEL: 'old-model' },
  });
  assert.deepEqual(specs.map((spec) => spec.id), ['windows-note-service', 'windows-sync-service']);
  assert.equal(new Set(specs.map((spec) => spec.environment.KAOYAN_INTERNAL_SYNC_TOKEN)).size, 1);
  assert.match(specs[0].environment.KAOYAN_INTERNAL_SYNC_TOKEN, /^[A-Za-z0-9_-]{40,}$/);
  for (const spec of specs) {
    assert.equal(spec.environment.KAOYAN_SYNC_ROLE, 'windows-replica');
    assert.equal(spec.environment.KAOYAN_RUNTIME_ROOT, runtime.runtimeRoot);
    assert.equal(spec.environment.KAOYAN_NOTE_PORT, '7174');
    assert.equal(spec.environment.KAOYAN_SYNC_DEVICE_ID, 'windows-laptop');
    assert.equal(spec.environment.QWEN_API_KEY, undefined);
    assert.equal(spec.environment.GEMINI_MODEL, undefined);
    assert.equal(spec.environment.KAOYAN_AI_CONFIG_PATH, undefined);
  }
});

test('the sync worker authenticates its local UI refresh notification', async (t) => {
  let received = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      received = {
        path: request.url,
        token: request.headers['x-kaoyan-internal-sync-token'],
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = { learningChanged: true, canvasEvents: [] };
  assert.equal(await notifyLocalNoteService(payload, {
    port: server.address().port,
    token: 'private-process-token',
  }), true);
  assert.deepEqual(received, {
    path: '/internal/replica/materialized',
    token: 'private-process-token',
    payload,
  });
});
