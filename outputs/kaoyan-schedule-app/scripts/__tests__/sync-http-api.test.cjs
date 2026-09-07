const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSyncStore, operationPayloadHash, sha256 } = require('../sync-core.cjs');
const {
  authenticateRequest,
  createDevice,
  listDevices,
  readDeviceConfig,
  revokeDevice,
} = require('../sync-device-auth.cjs');
const { createSyncHttpApi } = require('../sync-http-api.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-sync-http-'));
  const configPath = path.join(root, 'secrets', 'sync-devices.json');
  const credentials = createDevice(configPath, { deviceId: 'windows-main', label: '主 Windows' });
  const store = createSyncStore({ databasePath: path.join(root, 'sync.sqlite'), assetsRoot: path.join(root, 'assets') });
  const api = createSyncHttpApi({ store, authenticate: (request) => authenticateRequest(request, configPath) });
  const server = http.createServer(async (request, response) => {
    if (!await api.handle(request, response)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { baseUrl, configPath, credentials, store };
}

function makeOperation(overrides = {}) {
  const operation = {
    schemaVersion: 1,
    operationId: 'http-op-1',
    deviceId: 'windows-main',
    entityType: 'learning-note',
    entityId: 'note-http-1',
    baseRevision: 0,
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    assetHashes: [],
    mutation: { kind: 'patch', source: 'human', fields: { title: '离线先存' } },
    ...overrides,
  };
  operation.payloadHash = operationPayloadHash(operation);
  return operation;
}

test('device configuration never lists token hashes and revoked tokens stop working', async (t) => {
  const { baseUrl, configPath, credentials } = await fixture(t);
  assert.deepEqual(listDevices(configPath).map((device) => device.deviceId), ['windows-main']);
  assert.doesNotMatch(JSON.stringify(listDevices(configPath)), /tokenHash|ksc_sync_/);
  let response = await fetch(`${baseUrl}/sync/v1/status`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deviceId, 'windows-main');
  assert.equal(revokeDevice(configPath, 'windows-main'), true);
  response = await fetch(`${baseUrl}/sync/v1/status`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'SYNC_AUTH_INVALID');
});

test('device management refuses to overwrite a future configuration schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-sync-device-future-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'sync-devices.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 99, devices: [] }));
  assert.throws(() => readDeviceConfig(configPath), (error) => error.code === 'SYNC_DEVICE_CONFIG_TOO_NEW');
  assert.throws(() => createDevice(configPath, { deviceId: 'windows-main' }), (error) => error.code === 'SYNC_DEVICE_CONFIG_TOO_NEW');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion, 99);
});

test('authenticated HTTP API accepts operations, serves cursors and verifies assets', async (t) => {
  const { baseUrl, credentials } = await fixture(t);
  const headers = { authorization: `Bearer ${credentials.token}` };
  let response = await fetch(`${baseUrl}/sync/v1/operations`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ operations: [makeOperation()] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).receipts[0].revision, 1);

  response = await fetch(`${baseUrl}/sync/v1/events?after=0&limit=10`, { headers });
  const eventPage = await response.json();
  assert.equal(eventPage.events[0].entity.document.title, '离线先存');
  assert.equal(eventPage.nextCursor, 1);

  const bytes = Buffer.from('asset served from Mac');
  const hash = sha256(bytes);
  response = await fetch(`${baseUrl}/sync/v1/assets/${hash}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'text/plain' },
    body: bytes,
  });
  assert.equal(response.status, 201);
  response = await fetch(`${baseUrl}/sync/v1/assets/${hash}`, { headers });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  response = await fetch(`${baseUrl}/sync/v1/status`, { headers });
  const status = await response.json();
  assert.deepEqual({
    authority: status.authority,
    role: status.role,
    entities: status.entityCount,
    operations: status.operationCount,
    assets: status.assetCount,
    cursor: status.latestCursor,
  }, { authority: true, role: 'mac-authority', entities: 1, operations: 1, assets: 1, cursor: 2 });

  const wrongDevice = makeOperation();
  wrongDevice.operationId = 'wrong-device-op';
  wrongDevice.deviceId = 'ipad';
  wrongDevice.payloadHash = operationPayloadHash(wrongDevice);
  response = await fetch(`${baseUrl}/sync/v1/operations`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ operations: [wrongDevice] }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'SYNC_DEVICE_MISMATCH');
});

test('HTTP clients can inspect and resolve explicit conflicts without bypassing device auth', async (t) => {
  const { baseUrl, credentials, store } = await fixture(t);
  const headers = { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' };
  store.queueLocalMutation({
    deviceId: 'mac-local',
    entityType: 'learning-note',
    entityId: 'note-http-conflict',
    mutation: { kind: 'patch', source: 'human', fields: { title: 'Mac 标题' } },
  });
  const incoming = makeOperation({
    operationId: 'http-conflict-op',
    entityId: 'note-http-conflict',
    mutation: { kind: 'patch', source: 'human', fields: { title: 'Windows 标题' } },
  });
  let response = await fetch(`${baseUrl}/sync/v1/operations`, {
    method: 'POST', headers, body: JSON.stringify({ operations: [incoming] }),
  });
  const conflictReceipt = (await response.json()).receipts[0];
  assert.equal(conflictReceipt.status, 'conflict');

  response = await fetch(`${baseUrl}/sync/v1/entities/learning-note/note-http-conflict/conflicts`, { headers });
  const conflict = (await response.json()).conflicts[0];
  assert.equal(conflict.incoming, 'Windows 标题');

  const resolution = makeOperation({
    operationId: 'http-conflict-resolution',
    entityId: 'note-http-conflict',
    baseRevision: 1,
    clientSequence: 2,
    mutation: { kind: 'patch', source: 'human', fields: { title: '人工确认标题' } },
  });
  response = await fetch(`${baseUrl}/sync/v1/conflicts/${conflict.conflictId}/resolve`, {
    method: 'POST', headers, body: JSON.stringify({ operation: resolution }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).receipt.status, 'applied');
  assert.equal(store.getEntity('learning-note', 'note-http-conflict').document.title, '人工确认标题');
});
