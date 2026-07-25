'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLearningDataStore, normalizeSnapshot } = require('./learning-data-store.cjs');

test('legacy filePath becomes a primary attachment and synced provenance survives normalization', () => {
  const snapshot = normalizeSnapshot({
    version: 1, revision: 7, days: {
      '2026-07-24': { manual: {}, autoNotes: [{
        noteUid: 'legacy-note', capturedDate: '2026-07-24', title: 'legacy', subject: '高等数学',
        filePath: 'C:/Users/ASUS/Desktop/笔记/高等数学/legacy.png', sourceType: 'ai-multi-question',
        sourceBatchId: 'batch-1', sourceSplitIndex: 2, wrongReasonSource: 'ai', wrongReasonConfidence: 0.88,
        noteType: 'mistake', tags: ['错题'], cardIds: [],
      }] },
    }, cards: [], deletedNotes: {},
  });
  const note = snapshot.days['2026-07-24'].autoNotes[0];
  assert.equal(note.sourceType, 'ai-multi-question');
  assert.equal(note.sourceBatchId, 'batch-1');
  assert.equal(note.sourceSplitIndex, 2);
  assert.equal(note.wrongReasonSource, 'ai');
  assert.equal(note.wrongReasonConfidence, 0.88);
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].kind, 'image');
  assert.equal(note.attachments[0].filePath, note.filePath);
  assert.deepEqual(note.facets, ['mistake']);
});

test('manual notes can create and patch multiple attachments without losing legacy fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-multimaterial-'));
  const store = createLearningDataStore({ assistantRoot: root, now: () => new Date('2026-07-25T00:00:00.000Z') });
  let snapshot = store.createNote({
    noteUid: 'quick-1', capturedDate: '2026-07-25', title: '速记', subject: '高等数学', noteType: 'quick',
    remark: '同一条记录挂多份资料', facets: ['quick', 'knowledge'], attachments: [
      { id: 'img', name: '题图.png', mimeType: 'image/png', filePath: 'D:/kaoyandata/assets/题图.png', size: 12 },
      { id: 'pdf', name: '推导.pdf', mimeType: 'application/pdf', filePath: 'D:/kaoyandata/assets/推导.pdf', size: 34 },
    ],
  });
  let note = snapshot.days['2026-07-25'].autoNotes[0];
  assert.equal(note.filePath, 'D:/kaoyandata/assets/题图.png');
  assert.equal(note.attachments.length, 2);
  assert.deepEqual(note.facets, ['quick', 'knowledge']);

  snapshot = store.updateNote('quick-1', {
    facets: ['quick', 'memory'],
    attachments: [...note.attachments, { id: 'html', name: '演示.html', mimeType: 'text/html', filePath: 'D:/kaoyandata/assets/演示.html' }],
  });
  note = snapshot.days['2026-07-25'].autoNotes[0];
  assert.equal(note.attachments.length, 3);
  assert.deepEqual(note.facets, ['quick', 'memory']);
  assert.equal(note.remark, '同一条记录挂多份资料');
});
