'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSnapshot } = require('../learning-data-store.cjs');

test('normalization preserves future snapshot, note, attachment and card fields', () => {
  const snapshot = normalizeSnapshot({
    version: 1,
    revision: 3,
    updatedAt: '2026-07-24T00:00:00.000Z',
    futureSnapshot: { enabled: true },
    days: {
      '2026-07-24': {
        futureDay: 'kept',
        manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
        autoNotes: [{
          noteUid: 'future-note',
          capturedDate: '2026-07-24',
          title: '未来字段',
          subject: '默认文件夹',
          futureNote: { value: 7 },
          attachments: [{
            id: 'asset-1',
            name: '资料.pdf',
            filePath: 'github://data/assets/future-note/资料.pdf',
            futureAttachment: 'kept',
          }],
        }],
      },
    },
    cards: [{
      id: 'future-card',
      noteUid: 'future-note',
      futureCard: 'kept',
    }],
    deletedNotes: {},
  });

  assert.deepEqual(snapshot.futureSnapshot, { enabled: true });
  assert.equal(snapshot.days['2026-07-24'].futureDay, 'kept');
  assert.deepEqual(snapshot.days['2026-07-24'].autoNotes[0].futureNote, { value: 7 });
  assert.equal(snapshot.days['2026-07-24'].autoNotes[0].attachments[0].futureAttachment, 'kept');
  assert.equal(snapshot.cards[0].futureCard, 'kept');
});
