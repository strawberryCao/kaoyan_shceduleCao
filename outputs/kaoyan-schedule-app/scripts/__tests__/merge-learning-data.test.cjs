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
