const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLearningDataStore } = require('../learning-data-store.cjs');
const { createReplicaLearningBridge } = require('../replica-learning-bridge.cjs');
const { createWindowsReplicaStore } = require('../windows-replica-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-replica-bridge-'));
  const replica = createWindowsReplicaStore({
    databasePath: path.join(root, 'replica.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    deviceId: 'windows-main',
  });
  const errors = [];
  const bridge = createReplicaLearningBridge({ replica, onError: (error) => errors.push(error) });
  const learning = createLearningDataStore({
    assistantRoot: path.join(root, 'assistant'),
    lockPath: path.join(root, 'learning.lock'),
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    onCommitted: bridge.captureCommit,
    onCommittedError: (error) => errors.push(error),
  });
  t.after(() => {
    replica.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, errors, learning, replica, root };
}

test('new learning records are locally durable before entering the outbox', (t) => {
  const { bridge, learning, replica } = fixture(t);
  assert.equal(replica.status().pending, 0, 'opening existing data must not scan or upload history');
  learning.createNote({
    noteUid: 'bridge-note',
    capturedDate: '2026-09-05',
    title: '本机先保存',
    subject: '数据结构',
    remark: '等待 Mac',
  });
  assert.equal(learning.getSnapshot().days['2026-09-05'].autoNotes[0].title, '本机先保存');
  assert.equal(replica.status().pending, 1);
  assert.deepEqual(bridge.noteStatus('bridge-note'), { state: 'queued', pending: 1, conflicts: 0 });
  assert.equal(replica.getEntity('learning-note', 'bridge-note').document.remark, '等待 Mac');
});

test('attachment bytes enter content storage while absolute Windows paths never enter operations', (t) => {
  const { learning, replica, root } = fixture(t);
  const filePath = path.join(root, 'private', '题目.png');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('fake image bytes'));
  learning.createNote({
    noteUid: 'attachment-note',
    capturedDate: '2026-09-05',
    title: '带附件',
    subject: '高等数学',
    attachments: [{ id: 'image-1', kind: 'image', name: '题目.png', mimeType: 'image/png', filePath }],
    items: [{ id: 'source', sourceFilePath: 'C:\\private\\hidden.png', title: '题目来源' }],
  });
  const operation = replica.listPending()[0].operation;
  assert.equal(operation.assetHashes.length, 1);
  assert.equal(replica.getAsset(operation.assetHashes[0])?.state, 'local');
  assert.doesNotMatch(JSON.stringify(operation), /private|\\|[A-Za-z]:/);
  assert.equal(operation.mutation.fields.attachments[0].name, '题目.png');
});

test('delete and explicit restore remain separate queued operations', (t) => {
  const { learning, replica } = fixture(t);
  let snapshot = learning.createNote({
    noteUid: 'restore-note',
    capturedDate: '2026-09-05',
    title: '可恢复',
    subject: '英语',
  });
  snapshot = learning.deleteNote('restore-note', { expectedRevision: snapshot.revision });
  learning.restoreNote('restore-note', { expectedRevision: snapshot.revision });
  assert.deepEqual(replica.listPending().map((item) => item.operation.mutation.kind), ['patch', 'delete', 'restore', 'patch']);
});

test('replica capture failure never rolls back an already durable learning snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-replica-capture-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failures = [];
  const learning = createLearningDataStore({
    assistantRoot: root,
    lockPath: path.join(root, 'learning.lock'),
    onCommitted() { throw Object.assign(new Error('disk full'), { code: 'REPLICA_DISK_FULL' }); },
    onCommittedError(error) { failures.push(error.code); },
  });
  const snapshot = learning.upsertDayManual('2026-09-05', { note: '不能丢' });
  assert.equal(snapshot.days['2026-09-05'].manual.note, '不能丢');
  assert.equal(learning.getSnapshot().days['2026-09-05'].manual.note, '不能丢');
  assert.deepEqual(failures, ['REPLICA_DISK_FULL']);
});
