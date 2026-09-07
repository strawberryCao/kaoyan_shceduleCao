const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

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
    if (child.exitCode !== null) throw new Error(`note server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Windows replica note server did not become ready.');
}

test('Windows quick-note service saves locally, queues Mac sync and refuses local AI execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-windows-note-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'note-server.cjs')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      KAOYAN_RUNTIME_LAYOUT: 'managed',
      KAOYAN_RUNTIME_ROOT: root,
      KAOYAN_NOTES_ROOT: path.join(root, 'data', 'notes'),
      KAOYAN_ASSISTANT_ROOT: path.join(root, 'data', 'assistant'),
      KAOYAN_NOTE_PORT: String(port),
      KAOYAN_SYNC_ROLE: 'windows-replica',
      KAOYAN_SYNC_DEVICE_ID: 'windows-e2e',
      KAOYAN_INTERNAL_SYNC_TOKEN: 'windows-e2e-internal-token-that-is-long-enough',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);
  let response = await fetch(`${baseUrl}/save-material-note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      noteUid: 'windows-local-first-note',
      title: '本地优先速记',
      remark: 'Mac 离线时也能保存',
      subject: '数据结构',
      facets: ['quick'],
      files: [],
    }),
  });
  assert.equal(response.status, 201, stderr);
  const saved = await response.json();
  assert.deepEqual(saved.sync, { localSaved: true, state: 'queued', pending: 1, conflicts: 0 });
  assert.equal(fs.existsSync(path.join(root, 'data', 'assistant', 'learning-data.json')), true);

  response = await fetch(`${baseUrl}/replica/status`);
  const replicaStatus = await response.json();
  assert.equal(replicaStatus.pending, 1);
  assert.equal(replicaStatus.capture.state, 'healthy');

  response = await fetch(`${baseUrl}/internal/replica/materialized`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kaoyan-internal-sync-token': 'wrong-token' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  response = await fetch(`${baseUrl}/internal/replica/materialized`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kaoyan-internal-sync-token': 'windows-e2e-internal-token-that-is-long-enough',
    },
    body: JSON.stringify({ learningChanged: true, canvasEvents: [] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).learningBroadcast, true);

  response = await fetch(`${baseUrl}/ai/html-note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kaoyan-ai-action': 'user' },
    body: JSON.stringify({ prompt: '不应在 Windows 运行' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_REMOTE_AUTHORITY_REQUIRED');
});
