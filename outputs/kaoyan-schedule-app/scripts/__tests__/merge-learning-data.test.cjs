const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeSnapshots, sanitizeNote } = require('../merge-learning-data.cjs');

const base = () => ({
  version: 1,
  revision: 1,
  updatedAt: '2026-07-24T00:00:00.000Z',
  days: {
    '2026-07-24': {
      manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
      autoNotes: [{
        noteUid: 'n1',
        capturedDate: '2026-07-24',
        title: '题目',
        subject: '默认文件夹',
        filePath: 'github://data/assets/n1.jpg',
        updatedAt: '2026-07-24T00:00:00.000Z',
        studyNotes: [],
      }],
    },
  },
  cards: [{
    id: 'c1',
    noteUid: 'n1',
    updatedAt: '2026-07-24T00:00:00.000Z',
    reviewCount: 0,
    reviewHistory: [],
  }],
  deletedNotes: {},
});

test('merges local study thoughts with remote review progress', () => {
  const previous = base();
  const local = structuredClone(previous);
  local.updatedAt = '2026-07-24T01:00:00.000Z';
  local.days['2026-07-24'].autoNotes[0].updatedAt = local.updatedAt;
  local.days['2026-07-24'].autoNotes[0].studyNotes = [{
    id: 'thought-1',
    text: '追加想法',
    createdAt: local.updatedAt,
    updatedAt: local.updatedAt,
  }];

  const remote = structuredClone(previous);
  remote.updatedAt = '2026-07-24T02:00:00.000Z';
  remote.cards[0].updatedAt = remote.updatedAt;
  remote.cards[0].reviewCount = 1;
  remote.cards[0].reviewHistory = [{
    id: 'review-1',
    reviewedAt: remote.updatedAt,
    result: 'remembered',
    thought: '今天已复习',
  }];

  const merged = mergeSnapshots(local, remote, previous);
  assert.equal(merged.days['2026-07-24'].autoNotes[0].studyNotes[0].text, '追加想法');
  assert.equal(merged.cards[0].reviewHistory[0].thought, '今天已复习');
  assert.equal(merged.cards[0].reviewCount, 1);
});

test('repairs historical assets subject to default folder', () => {
  const note = sanitizeNote({
    noteUid: 'n2',
    subject: 'assets',
    knowledgePath: ['assets'],
    filePath: 'github://data/assets/n2.jpg',
    classificationSource: 'local',
    organizationStatus: 'confirmed',
    reviewStatus: 'auto_applied',
  });
  assert.equal(note.subject, '默认文件夹');
  assert.deepEqual(note.knowledgePath, ['默认文件夹']);
  assert.equal(note.reviewStatus, 'pending');
});


test('field-level merge preserves independent note changes and future fields', () => {
  const previous = base();
  const local = structuredClone(previous);
  const remote = structuredClone(previous);
  const localNote = local.days['2026-07-24'].autoNotes[0];
  const remoteNote = remote.days['2026-07-24'].autoNotes[0];
  local.updatedAt = '2026-07-24T01:00:00.000Z';
  localNote.updatedAt = local.updatedAt;
  localNote.title = '本地修改后的标题';
  localNote.localFuture = { retained: true };

  remote.updatedAt = '2026-07-24T02:00:00.000Z';
  remoteNote.updatedAt = remote.updatedAt;
  remoteNote.attachments = [{
    id: 'asset-1',
    kind: 'pdf',
    name: '讲义.pdf',
    filePath: 'github://data/assets/n1/讲义.pdf',
    checksum: 'sha256:future',
  }];
  remoteNote.facets = ['quick', 'knowledge'];
  remoteNote.sourceType = 'material-note';
  remoteNote.sourceBatchId = 'batch-remote';
  remoteNote.remoteFuture = { retained: true };

  const merged = mergeSnapshots(local, remote, previous);
  const note = merged.days['2026-07-24'].autoNotes[0];
  assert.equal(note.title, '本地修改后的标题');
  assert.deepEqual(note.facets, ['quick', 'knowledge']);
  assert.equal(note.attachments[0].checksum, 'sha256:future');
  assert.equal(note.sourceBatchId, 'batch-remote');
  assert.deepEqual(note.localFuture, { retained: true });
  assert.deepEqual(note.remoteFuture, { retained: true });
});

test('three-way set and attachment merge respects explicit local removals', () => {
  const previous = base();
  const previousNote = previous.days['2026-07-24'].autoNotes[0];
  previousNote.facets = ['quick', 'knowledge'];
  previousNote.tags = ['速记', '知识'];
  previousNote.attachments = [
    { id: 'a', name: '保留.pdf', filePath: 'github://data/assets/n1/a.pdf', createdAt: '2026-07-24T00:00:00.000Z' },
    { id: 'b', name: '删除.pdf', filePath: 'github://data/assets/n1/b.pdf', createdAt: '2026-07-24T00:00:00.000Z' },
  ];

  const local = structuredClone(previous);
  local.updatedAt = '2026-07-24T02:00:00.000Z';
  const localNote = local.days['2026-07-24'].autoNotes[0];
  localNote.updatedAt = local.updatedAt;
  localNote.facets = ['quick'];
  localNote.tags = ['速记'];
  localNote.attachments = [localNote.attachments[0]];

  const remote = structuredClone(previous);
  remote.updatedAt = '2026-07-24T03:00:00.000Z';

  const note = mergeSnapshots(local, remote, previous).days['2026-07-24'].autoNotes[0];
  assert.deepEqual(note.facets, ['quick']);
  assert.deepEqual(note.tags, ['速记']);
  assert.deepEqual(note.attachments.map((item) => item.id), ['a']);
});

test('an agreed attachment order stays stable across repeated merges', () => {
  const previous = base();
  const current = structuredClone(previous);
  const note = current.days['2026-07-24'].autoNotes[0];
  note.attachments = [
    { id: 'z-last-by-id', name: '第一页.png', createdAt: '2026-07-24T00:00:00.000Z' },
    { id: 'a-first-by-id', name: '第二页.png', createdAt: '2026-07-24T00:00:00.000Z' },
  ];

  const merged = mergeSnapshots(current, structuredClone(current), previous);
  assert.deepEqual(merged.days['2026-07-24'].autoNotes[0].attachments.map((item) => item.id), [
    'z-last-by-id',
    'a-first-by-id',
  ]);
});

test('card text edits and remote review progress merge independently', () => {
  const previous = base();
  const local = structuredClone(previous);
  const remote = structuredClone(previous);
  local.updatedAt = '2026-07-24T01:00:00.000Z';
  local.cards[0].updatedAt = local.updatedAt;
  local.cards[0].front = '本地改过的问题';

  remote.updatedAt = '2026-07-24T02:00:00.000Z';
  remote.cards[0].updatedAt = remote.updatedAt;
  remote.cards[0].reviewHistory = [{
    id: 'review-remote',
    reviewedAt: remote.updatedAt,
    result: 'remembered',
    thought: '远端完成复习',
  }];
  remote.cards[0].reviewCount = 1;

  const card = mergeSnapshots(local, remote, previous).cards[0];
  assert.equal(card.front, '本地改过的问题');
  assert.equal(card.reviewHistory[0].thought, '远端完成复习');
  assert.equal(card.reviewCount, 1);
});

test('a local tombstone cannot be resurrected by a newer remote enrichment', () => {
  const previous = base();
  const local = structuredClone(previous);
  const remote = structuredClone(previous);

  local.updatedAt = '2026-07-24T02:00:00.000Z';
  local.days['2026-07-24'].autoNotes = [];
  local.cards = [];
  local.deletedNotes.n1 = {
    noteUid: 'n1',
    deletedAt: local.updatedAt,
    note: previous.days['2026-07-24'].autoNotes[0],
    cards: previous.cards,
  };

  remote.updatedAt = '2026-07-24T03:00:00.000Z';
  remote.days['2026-07-24'].autoNotes[0].updatedAt = remote.updatedAt;
  remote.days['2026-07-24'].autoNotes[0].title = 'remote enrichment must not restore this note';

  const merged = mergeSnapshots(local, remote, previous);
  assert.equal(merged.days['2026-07-24'].autoNotes.length, 0);
  assert.equal(merged.cards.length, 0);
  assert.equal(merged.deletedNotes.n1.deletedAt, local.updatedAt);
});
