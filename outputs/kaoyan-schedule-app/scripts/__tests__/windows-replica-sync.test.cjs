const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSyncClient } = require('../sync-client.cjs');
const { createSyncStore, operationPayloadHash } = require('../sync-core.cjs');
const { authenticateRequest, createDevice } = require('../sync-device-auth.cjs');
const { createSyncHttpApi } = require('../sync-http-api.cjs');
const { createWindowsReplicaStore } = require('../windows-replica-store.cjs');

async function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-windows-replica-'));
  const authorityRoot = path.join(root, 'authority');
  const replicaRoot = path.join(root, 'replica');
  const configPath = path.join(authorityRoot, 'sync-devices.json');
  const credentials = createDevice(configPath, { deviceId: 'windows-main', label: 'Windows 主机' });
  const authority = createSyncStore({
    databasePath: path.join(authorityRoot, 'authority.sqlite'),
    assetsRoot: path.join(authorityRoot, 'assets'),
  });
  const api = createSyncHttpApi({ store: authority, authenticate: (request) => authenticateRequest(request, configPath) });
  const server = http.createServer(async (request, response) => {
    if (!await api.handle(request, response)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const replicaOptions = {
    databasePath: path.join(replicaRoot, 'windows-replica.sqlite'),
    assetsRoot: path.join(replicaRoot, 'assets'),
    deviceId: 'windows-main',
  };
  const replica = createWindowsReplicaStore(replicaOptions);
  const client = createSyncClient({ replica, baseUrl, token: credentials.token });
  const context = { authority, baseUrl, client, credentials, replica, replicaOptions, root };
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { context.replica.close(); } catch {}
    authority.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return context;
}

test('an older Windows runtime refuses to downgrade a future replica schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-replica-future-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'replica.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA user_version = 99');
  database.close();
  assert.throws(() => createWindowsReplicaStore({
    databasePath,
    assetsRoot: path.join(root, 'assets'),
    deviceId: 'windows-main',
  }), (error) => error.code === 'REPLICA_DATABASE_TOO_NEW');
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 99);
  reopened.close();
});

test('local mutation and its outbox survive a Windows process restart', async (t) => {
  const env = await environment(t);
  const queued = env.replica.queueMutation({
    operationId: 'durable-op',
    entityType: 'learning-note',
    entityId: 'offline-note',
    mutation: { kind: 'patch', source: 'human', fields: { title: '断网时的标题', remark: '先保存在本机' } },
  });
  assert.equal(queued.entity.document.title, '断网时的标题');
  assert.equal(env.replica.status().pending, 1);
  env.replica.close();

  const reopened = createWindowsReplicaStore(env.replicaOptions);
  env.replica = reopened;
  env.client = createSyncClient({ replica: reopened, baseUrl: env.baseUrl, token: env.credentials.token });
  assert.equal(reopened.listPending()[0].operation.operationId, 'durable-op');
  const result = await env.client.syncOnce();
  assert.equal(result.pushed, 1);
  assert.equal(reopened.status().pending, 0);
  assert.equal(reopened.getEntity('learning-note', 'offline-note').document.remark, '先保存在本机');
});

test('sequential offline edits are rebased one by one without creating a false conflict', async (t) => {
  const { authority, client, replica } = await environment(t);
  replica.queueMutation({
    operationId: 'edit-one',
    entityType: 'learning-note',
    entityId: 'note-sequence',
    mutation: { kind: 'patch', source: 'human', fields: { title: '第一次' } },
  });
  replica.queueMutation({
    operationId: 'edit-two',
    entityType: 'learning-note',
    entityId: 'note-sequence',
    mutation: { kind: 'patch', source: 'human', fields: { title: '第二次' } },
  });
  assert.deepEqual(replica.listPending().map((item) => item.operation.baseRevision), [0, 0]);
  const result = await client.syncOnce();
  assert.equal(result.pushed, 2);
  assert.equal(result.replica.conflicts, 0);
  assert.equal(authority.getEntity('learning-note', 'note-sequence').document.title, '第二次');
  assert.equal(replica.getEntity('learning-note', 'note-sequence').document.title, '第二次');
});

test('a lost response is recovered by operation replay without duplicate data', async (t) => {
  const { authority, client, replica } = await environment(t);
  const queued = replica.queueMutation({
    operationId: 'lost-response-op',
    entityType: 'learning-note',
    entityId: 'note-retry',
    mutation: { kind: 'patch', source: 'human', fields: { title: '只创建一次' } },
  });
  const accepted = authority.applyOperation(queued.operation);
  assert.equal(accepted.revision, 1);
  const result = await client.syncOnce();
  assert.equal(result.pushed, 1);
  assert.equal(authority.readEvents().events.filter((event) => event.entityId === 'note-retry').length, 1);
  assert.equal(replica.status().acknowledged, 1);
});

test('remote edits and immutable assets download into the complete Windows replica', async (t) => {
  const { authority, client, replica } = await environment(t);
  const bytes = Buffer.from('remote attachment');
  const uploaded = authority.putAsset(require('../sync-core.cjs').sha256(bytes), bytes, 'text/plain');
  const remote = {
    schemaVersion: 1,
    operationId: 'ipad-op',
    deviceId: 'ipad',
    entityType: 'learning-note',
    entityId: 'remote-note',
    baseRevision: 0,
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    assetHashes: [uploaded.hash],
    mutation: { kind: 'patch', source: 'human', fields: { title: '来自 iPad' } },
  };
  remote.payloadHash = operationPayloadHash(remote);
  authority.applyOperation(remote);
  const pull = await client.pullEvents();
  assert.equal(pull.pulled, 2);
  assert.equal(pull.downloaded, 1);
  assert.equal(replica.getEntity('learning-note', 'remote-note').document.title, '来自 iPad');
  assert.deepEqual(fs.readFileSync(replica.getAsset(uploaded.hash).filePath), bytes);
  assert.equal(replica.getRemoteCursor(), 2);
});

test('tombstones pulled from Mac remain visible and block stale local editing', async (t) => {
  const { client, replica } = await environment(t);
  replica.queueMutation({
    operationId: 'create-before-delete',
    entityType: 'learning-note',
    entityId: 'deleted-note',
    mutation: { kind: 'patch', source: 'human', fields: { title: '即将删除' } },
  });
  await client.syncOnce();
  replica.queueMutation({
    operationId: 'delete-local',
    entityType: 'learning-note',
    entityId: 'deleted-note',
    mutation: { kind: 'delete', source: 'human' },
  });
  await client.syncOnce();
  assert.equal(replica.getEntity('learning-note', 'deleted-note').deleted, true);
  assert.throws(() => replica.queueMutation({
    operationId: 'stale-revive',
    entityType: 'learning-note',
    entityId: 'deleted-note',
    mutation: { kind: 'patch', source: 'human', fields: { title: '错误复活' } },
  }), (error) => error.code === 'LOCAL_ENTITY_DELETED');
});
