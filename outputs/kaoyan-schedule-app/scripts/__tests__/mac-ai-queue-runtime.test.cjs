const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createSyncStore } = require('../sync-core.cjs');

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xf0fWQAAAABJRU5ErkJggg==';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Mac note server exited with ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Mac note server did not become ready.');
}

async function waitForTask(baseUrl, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/ai/tasks`);
    const payload = await response.json();
    const job = payload.jobs.find(predicate);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Durable AI task did not reach the expected state.');
}

test('Mac note service persists AI work, avoids paid restart replay and publishes task state to sync', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-mac-ai-runtime-'));
  const projectRoot = path.resolve(__dirname, '..', '..');
  let child = null;
  let stderr = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  };
  t.after(async () => {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = async () => {
    const port = await freePort();
    child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'note-server.cjs')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        KAOYAN_RUNTIME_LAYOUT: 'managed',
        KAOYAN_RUNTIME_ROOT: root,
        KAOYAN_NOTES_ROOT: path.join(root, 'data', 'notes'),
        KAOYAN_ASSISTANT_ROOT: path.join(root, 'data', 'assistant'),
        KAOYAN_AI_CONFIG_PATH: path.join(root, 'secrets', 'missing-ai-providers.json'),
        KAOYAN_NOTE_PORT: String(port),
        KAOYAN_SYNC_ROLE: 'mac-authority',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child);
    return baseUrl;
  };

  let baseUrl = await start();
  const response = await fetch(`${baseUrl}/save-note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      noteUid: 'mac-ai-persist-001',
      imageDataUrl: `data:image/png;base64,${tinyPng}`,
      subject: '默认文件夹',
      remark: '持久 AI 队列验收',
    }),
  });
  assert.equal(response.status, 202, stderr);
  const failed = await waitForTask(baseUrl, (job) => job.subjectId === 'mac-ai-persist-001' && job.status === 'failed');
  assert.equal(failed.billableAttemptCount, 0);
  assert.equal(failed.requiresExplicitRetry, true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'ai', 'tasks.sqlite')), true);

  await stop();
  baseUrl = await start();
  const restored = await waitForTask(baseUrl, (job) => job.id === failed.id);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.attemptCount, failed.attemptCount, 'restart must not retry a failed task');
  assert.equal(restored.billableAttemptCount, 0);

  const retry = await fetch(`${baseUrl}/ai/tasks/${encodeURIComponent(failed.id)}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kaoyan-ai-action': 'user' },
    body: '{}',
  });
  assert.equal(retry.status, 202, stderr);
  const retried = await waitForTask(baseUrl, (job) => job.id === failed.id && job.status === 'failed' && job.attemptCount > failed.attemptCount);
  assert.equal(retried.billableAttemptCount, 0);

  await stop();
  const sync = createSyncStore({
    databasePath: path.join(root, 'data', 'sync', 'authority.sqlite'),
    assetRoot: path.join(root, 'data', 'sync', 'assets'),
  });
  try {
    const entity = sync.getEntity('ai-task', failed.id);
    assert.equal(entity.document.subjectId, 'mac-ai-persist-001');
    assert.equal(entity.document.status, 'failed');
    assert.equal(Object.hasOwn(entity.document, 'payload'), false);
    assert.equal(Object.hasOwn(entity.document, 'idempotencyKey'), false);
  } finally {
    sync.close();
  }
});
