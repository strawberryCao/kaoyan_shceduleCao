const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLearningDataStore } = require('../learning-data-store.cjs');
const { createReplicaLearningMaterializer } = require('../replica-learning-materializer.cjs');
const { createSyncStore, operationPayloadHash, sha256 } = require('../sync-core.cjs');
const { createWindowsReplicaStore } = require('../windows-replica-store.cjs');

function operation(overrides) {
  const value = {
    schemaVersion: 1,
    operationId: overrides.operationId,
    deviceId: overrides.deviceId || 'ipad',
    entityType: overrides.entityType,
    entityId: overrides.entityId,
    baseRevision: overrides.baseRevision || 0,
    clientSequence: overrides.clientSequence,
    createdAt: '2026-09-05T12:00:00.000Z',
    assetHashes: overrides.assetHashes || [],
    mutation: overrides.mutation,
  };
  value.payloadHash = operationPayloadHash(value);
  return value;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-replica-materializer-'));
  const authority = createSyncStore({ databasePath: path.join(root, 'authority.sqlite'), assetsRoot: path.join(root, 'authority-assets') });
  const replica = createWindowsReplicaStore({
    databasePath: path.join(root, 'replica.sqlite'),
    assetsRoot: path.join(root, 'notes', '.sync-assets'),
    deviceId: 'windows-main',
  });
  const learning = createLearningDataStore({
    assistantRoot: path.join(root, 'assistant'),
    lockPath: path.join(root, 'learning.lock'),
  });
  const materializer = createReplicaLearningMaterializer({ replica, learningData: learning });
  t.after(() => {
    replica.close();
    authority.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { authority, learning, materializer, replica, root };
}

test('Mac notes, cards, day records and attachment bytes become usable Windows learning data', (t) => {
  const { authority, learning, materializer, replica } = fixture(t);
  learning.createNote({
    noteUid: 'local-unrelated',
    capturedDate: '2026-09-04',
    title: '本机未迁移旧记录',
    subject: '英语',
  });
  const bytes = Buffer.from('remote-image');
  const hash = sha256(bytes);
  replica.storeAssetBytes(bytes, 'image/png');
  authority.putAsset(hash, bytes, 'image/png');
  authority.applyOperation(operation({
    operationId: 'remote-note-op',
    entityType: 'learning-note',
    entityId: 'remote-note',
    clientSequence: 1,
    assetHashes: [hash],
    mutation: {
      kind: 'patch',
      source: 'human',
      fields: {
        noteUid: 'remote-note',
        capturedDate: '2026-09-05',
        title: 'Mac 正式记录',
        subject: '高等数学',
        attachments: [{ id: 'image-1', name: '题目.png', kind: 'image', mimeType: 'image/png', assetHash: hash }],
      },
    },
  }));
  authority.applyOperation(operation({
    operationId: 'remote-card-op',
    entityType: 'learning-card',
    entityId: 'card-1',
    clientSequence: 2,
    mutation: { kind: 'patch', source: 'human', fields: { id: 'card-1', noteUid: 'remote-note', kind: 'memory', front: '定义', back: '答案', status: 'active' } },
  }));
  authority.applyOperation(operation({
    operationId: 'remote-day-op',
    entityType: 'learning-day',
    entityId: '2026-09-05',
    clientSequence: 3,
    mutation: { kind: 'patch', source: 'human', fields: { note: 'Mac 上的日计划', completedTaskIds: ['math'] } },
  }));
  const page = authority.readEvents();
  replica.applyRemoteEvents(page.events, page.nextCursor);
  const result = materializer.reconcile();
  assert.equal(result.changed, true);
  const snapshot = learning.getSnapshot();
  assert.equal(snapshot.days['2026-09-04'].autoNotes[0].title, '本机未迁移旧记录');
  assert.equal(snapshot.days['2026-09-05'].manual.note, 'Mac 上的日计划');
  assert.equal(snapshot.days['2026-09-05'].autoNotes[0].title, 'Mac 正式记录');
  assert.equal(snapshot.cards[0].front, '定义');
  const attachmentPath = snapshot.days['2026-09-05'].autoNotes[0].attachments[0].filePath;
  assert.deepEqual(fs.readFileSync(attachmentPath), bytes);
  assert.equal(materializer.reconcile().changed, false, 'reconciliation must be idempotent');
});

test('Mac tombstone removes the live note without deleting unrelated local records', (t) => {
  const { authority, learning, materializer, replica } = fixture(t);
  authority.applyOperation(operation({
    operationId: 'create-delete-target',
    entityType: 'learning-note',
    entityId: 'delete-target',
    clientSequence: 1,
    mutation: { kind: 'patch', source: 'human', fields: { noteUid: 'delete-target', capturedDate: '2026-09-05', title: '将删除', subject: '政治' } },
  }));
  let page = authority.readEvents();
  replica.applyRemoteEvents(page.events, page.nextCursor);
  materializer.reconcile();
  authority.applyOperation(operation({
    operationId: 'delete-target-op',
    entityType: 'learning-note',
    entityId: 'delete-target',
    baseRevision: 1,
    clientSequence: 2,
    mutation: { kind: 'delete', source: 'human' },
  }));
  page = authority.readEvents(replica.getRemoteCursor());
  replica.applyRemoteEvents(page.events, page.nextCursor);
  materializer.reconcile();
  const snapshot = learning.getSnapshot();
  assert.equal(snapshot.days['2026-09-05'].autoNotes.length, 0);
  assert.equal(snapshot.deletedNotes['delete-target'].note.title, '将删除');
});
