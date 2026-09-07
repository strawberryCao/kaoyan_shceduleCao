const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { operationPayloadHash, sha256 } = require('../sync-core.cjs');
const { createDevice } = require('../sync-device-auth.cjs');

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`authority note server exited with ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Mac authority note server did not become ready.');
}

test('Mac app writes emit events and authenticated Windows operations materialize into the existing app store', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-mac-authority-e2e-'));
  const credentials = createDevice(path.join(root, 'secrets', 'sync-devices.json'), { deviceId: 'windows-main' });
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
      KAOYAN_SYNC_ROLE: 'mac-authority',
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
  const authorization = { authorization: `Bearer ${credentials.token}` };
  await waitForServer(baseUrl, child);

  let response = await fetch(`${baseUrl}/learning-data/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { noteUid: 'mac-created', capturedDate: '2026-09-05', title: 'Mac 新建', subject: '英语' } }),
  });
  assert.equal(response.status, 201, stderr);
  response = await fetch(`${baseUrl}/sync/v1/events?after=0`, { headers: authorization });
  let page = await response.json();
  assert.equal(page.events.some((event) => event.deviceId === 'mac-local' && event.entityId === 'mac-created'), true);

  const bytes = Buffer.from('windows attachment to Mac');
  const hash = sha256(bytes);
  const operation = {
    schemaVersion: 1,
    operationId: 'windows-to-mac-op',
    deviceId: 'windows-main',
    entityType: 'learning-note',
    entityId: 'windows-created',
    baseRevision: 0,
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    assetHashes: [hash],
    mutation: {
      kind: 'patch',
      source: 'human',
      fields: {
        noteUid: 'windows-created',
        capturedDate: '2026-09-05',
        title: 'Windows 离线新建',
        subject: '数据结构',
        attachments: [{ id: 'asset-1', name: '离线资料.txt', kind: 'file', mimeType: 'text/plain', assetHash: hash }],
      },
    },
  };
  operation.payloadHash = operationPayloadHash(operation);
  response = await fetch(`${baseUrl}/sync/v1/operations`, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ operations: [operation] }),
  });
  assert.equal(response.status, 200, stderr);
  assert.deepEqual((await response.json()).receipts[0].missingAssets, [hash]);
  response = await fetch(`${baseUrl}/sync/v1/assets/${hash}`, {
    method: 'PUT',
    headers: { ...authorization, 'content-type': 'text/plain' },
    body: bytes,
  });
  assert.equal(response.status, 201, stderr);
  response = await fetch(`${baseUrl}/learning-data`);
  const snapshot = await response.json();
  const remoteNote = snapshot.days['2026-09-05'].autoNotes.find((note) => note.noteUid === 'windows-created');
  assert.equal(remoteNote.title, 'Windows 离线新建');
  assert.deepEqual(fs.readFileSync(remoteNote.attachments[0].filePath), bytes);

  response = await fetch(`${baseUrl}/sync/v1/operations`, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ operations: [operation] }),
  });
  assert.equal(response.status, 200);
  page = await (await fetch(`${baseUrl}/sync/v1/events?after=0`, { headers: authorization })).json();
  assert.equal(page.events.filter((event) => event.operationId === 'windows-to-mac-op').length, 1);
});
