const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  SyncProtocolError,
  createSyncStore,
  operationPayloadHash,
  sha256,
} = require('../sync-core.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-sync-core-'));
  const store = createSyncStore({
    databasePath: path.join(root, 'sync.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    now: () => new Date('2026-09-05T08:00:00.000Z'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

function operation(overrides = {}) {
  const value = {
    schemaVersion: 1,
    operationId: 'op-1',
    deviceId: 'windows-main',
    entityType: 'learning-note',
    entityId: 'note-1',
    baseRevision: 0,
    clientSequence: 1,
    createdAt: '2026-09-05T07:59:00.000Z',
    assetHashes: [],
    mutation: { kind: 'patch', source: 'human', fields: { title: '人工标题' } },
    ...overrides,
  };
  value.payloadHash = operationPayloadHash(value);
  return value;
}

test('an older authority runtime refuses to downgrade a future database schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-sync-future-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'sync.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA user_version = 99');
  database.close();
  assert.throws(() => createSyncStore({ databasePath, assetsRoot: path.join(root, 'assets') }), (error) => (
    error.code === 'SYNC_DATABASE_TOO_NEW'
  ));
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 99);
  reopened.close();
});

test('operation replay returns the original receipt and rejects changed content', (t) => {
  const { store } = fixture(t);
  const first = operation();
  const receipt = store.applyOperation(first);
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.revision, 1);
  assert.deepEqual(store.applyOperation(first), receipt);
  assert.equal(store.readEvents().events.length, 1);

  const reused = { ...first, mutation: { ...first.mutation, fields: { title: '偷换内容' } } };
  reused.payloadHash = operationPayloadHash(reused);
  assert.throws(() => store.applyOperation(reused), (error) => (
    error instanceof SyncProtocolError && error.code === 'OPERATION_ID_REUSED'
  ));
});

test('independent fields merge while concurrent human edits become explicit conflicts', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const independent = operation({
    operationId: 'op-2',
    deviceId: 'ipad',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { remark: '平板批注' } },
  });
  const independentReceipt = store.applyOperation(independent);
  assert.equal(independentReceipt.status, 'applied');
  assert.deepEqual(store.getEntity('learning-note', 'note-1').document, {
    remark: '平板批注',
    title: '人工标题',
  });

  const concurrent = operation({
    operationId: 'op-3',
    deviceId: 'ipad',
    clientSequence: 2,
    mutation: { kind: 'patch', source: 'human', fields: { title: '平板标题' } },
  });
  const conflictReceipt = store.applyOperation(concurrent);
  assert.equal(conflictReceipt.status, 'conflict');
  assert.equal(conflictReceipt.conflicts[0].field, 'title');
  assert.equal(store.getEntity('learning-note', 'note-1').document.title, '人工标题');
  assert.equal(store.getOpenConflicts('learning-note', 'note-1').length, 1);
});

test('human fields defeat stale AI while new human input can replace AI output', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const staleAi = operation({
    operationId: 'op-ai',
    deviceId: 'mac-ai',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'ai', fields: { title: 'AI 标题' } },
  });
  const aiReceipt = store.applyOperation(staleAi);
  assert.equal(aiReceipt.status, 'applied');
  assert.deepEqual(aiReceipt.protectedFields, ['title']);
  assert.equal(store.getEntity('learning-note', 'note-1').document.title, '人工标题');

  const aiBase = operation({
    operationId: 'op-ai-base',
    entityId: 'note-2',
    deviceId: 'mac-ai',
    clientSequence: 2,
    mutation: { kind: 'patch', source: 'ai', fields: { title: 'AI 初稿' } },
  });
  store.applyOperation(aiBase);
  const human = operation({
    operationId: 'op-human',
    entityId: 'note-2',
    deviceId: 'windows-main',
    clientSequence: 2,
    mutation: { kind: 'patch', source: 'human', fields: { title: '我的标题' } },
  });
  assert.equal(store.applyOperation(human).status, 'applied');
  assert.equal(store.getEntity('learning-note', 'note-2').document.title, '我的标题');
});

test('concurrent set deltas converge without turning independent tag edits into conflicts', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation({
    mutation: { kind: 'patch', source: 'human', fields: {}, sets: { tags: { add: ['重点'], remove: [] } } },
  }));
  const concurrent = operation({
    operationId: 'op-tags-ipad',
    deviceId: 'ipad',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: {}, sets: { tags: { add: ['错题'], remove: [] } } },
  });
  const receipt = store.applyOperation(concurrent);
  assert.equal(receipt.status, 'applied');
  assert.deepEqual(store.getEntity('learning-note', 'note-1').document.tags, ['错题', '重点']);
});

test('a human can resolve an explicit field conflict against the latest revision', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const concurrent = operation({
    operationId: 'op-conflicting-title',
    deviceId: 'ipad',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { title: 'iPad 并发标题' } },
  });
  const conflict = store.applyOperation(concurrent).conflicts[0];
  const resolution = operation({
    operationId: 'op-resolve-title',
    deviceId: 'ipad',
    clientSequence: 2,
    baseRevision: 1,
    mutation: { kind: 'patch', source: 'human', fields: { title: '人工确认后的标题' } },
  });
  const result = store.resolveConflict(conflict.conflictId, resolution);
  assert.equal(result.receipt.status, 'applied');
  assert.equal(store.getEntity('learning-note', 'note-1').document.title, '人工确认后的标题');
  assert.deepEqual(store.getOpenConflicts('learning-note', 'note-1'), []);
});

test('the user-facing conflict flow can choose either value and undo only before newer work', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const conflict = store.applyOperation(operation({
    operationId: 'op-ipad-title-ui',
    deviceId: 'ipad',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { title: 'iPad 标题' } },
  })).conflicts[0];
  const listed = store.listConflicts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].entityTitle, '人工标题');
  assert.equal(listed[0].canUndo, false);

  const resolved = store.resolveConflictValue(conflict.conflictId, {
    choice: 'incoming',
    deviceId: 'mobile-user',
    operationId: 'mobile-resolve-incoming',
  });
  assert.equal(resolved.conflict.status, 'resolved');
  assert.equal(resolved.conflict.canUndo, true);
  assert.equal(store.getEntity('learning-note', 'note-1').document.title, 'iPad 标题');
  assert.equal(store.listConflicts().length, 0);

  const undone = store.undoConflictResolution(conflict.conflictId, {
    deviceId: 'mobile-user',
    operationId: 'mobile-undo-resolution',
  });
  assert.equal(undone.conflict.status, 'undone');
  assert.equal(store.getEntity('learning-note', 'note-1').document.title, '人工标题');
});

test('conflict undo refuses to overwrite edits made after the resolution', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const conflict = store.applyOperation(operation({
    operationId: 'op-ipad-title-stale-undo',
    deviceId: 'ipad', clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { title: 'iPad 标题' } },
  })).conflicts[0];
  store.resolveConflictValue(conflict.conflictId, {
    choice: 'incoming', deviceId: 'mobile-user', operationId: 'mobile-resolve-before-edit',
  });
  store.applyOperation(operation({
    operationId: 'windows-newer-remark', clientSequence: 2, baseRevision: 2,
    mutation: { kind: 'patch', source: 'human', fields: { remark: '之后的新修改' } },
  }));
  assert.throws(() => store.undoConflictResolution(conflict.conflictId, {
    deviceId: 'mobile-user', operationId: 'mobile-stale-undo',
  }), (error) => error.code === 'SYNC_CONFLICT_UNDO_STALE');
});

test('tombstones cannot be revived by stale patches and restore requires the exact revision', (t) => {
  const { store } = fixture(t);
  store.applyOperation(operation());
  const deletion = operation({
    operationId: 'op-delete',
    baseRevision: 1,
    clientSequence: 2,
    mutation: { kind: 'delete', source: 'human' },
  });
  assert.equal(store.applyOperation(deletion).revision, 2);
  assert.equal(store.getEntity('learning-note', 'note-1').deleted, true);

  const stalePatch = operation({
    operationId: 'op-stale',
    deviceId: 'ipad',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { title: '旧副本复活' } },
  });
  assert.throws(() => store.applyOperation(stalePatch), (error) => error.code === 'ENTITY_DELETED');

  const staleRestore = operation({
    operationId: 'op-restore-stale',
    deviceId: 'ipad',
    clientSequence: 2,
    baseRevision: 1,
    mutation: { kind: 'restore', source: 'human' },
  });
  assert.throws(() => store.applyOperation(staleRestore), (error) => error.code === 'RESTORE_REVISION_REQUIRED');
  const restore = operation({
    operationId: 'op-restore',
    deviceId: 'ipad',
    clientSequence: 3,
    baseRevision: 2,
    mutation: { kind: 'restore', source: 'human' },
  });
  assert.equal(store.applyOperation(restore).revision, 3);
  assert.equal(store.getEntity('learning-note', 'note-1').deleted, false);
});

test('assets are content addressed, verified and announced through the event cursor', (t) => {
  const { store } = fixture(t);
  const bytes = Buffer.from('immutable attachment bytes');
  const hash = sha256(bytes);
  const create = operation({ assetHashes: [hash] });
  const receipt = store.applyOperation(create);
  assert.deepEqual(receipt.missingAssets, [hash]);
  assert.throws(() => store.putAsset(hash, Buffer.from('wrong')), (error) => error.code === 'ASSET_HASH_MISMATCH');
  const uploaded = store.putAsset(hash, bytes, 'text/plain');
  assert.equal(uploaded.created, true);
  assert.equal(store.putAsset(hash, bytes, 'text/plain').created, false);
  assert.deepEqual(fs.readFileSync(store.getAsset(hash).filePath), bytes);
  const events = store.readEvents(0, 10);
  assert.deepEqual(events.events.map((event) => event.eventType), ['entity.changed', 'asset.available']);
  assert.equal(events.nextCursor, 2);
});
