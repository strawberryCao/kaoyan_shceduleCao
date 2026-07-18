const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LearningDataConflictError,
  createLearningDataStore,
  formatDateInTimeZone,
} = require('./learning-data-store.cjs');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-learning-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = () => new Date('2026-07-17T04:00:00.000Z');
  return createLearningDataStore({ assistantRoot: root, now, timeZone: 'Asia/Shanghai' });
}

test('returns an empty versioned snapshot before the first write', (t) => {
  const store = makeFixture(t);
  assert.deepEqual(store.getSnapshot(), {
    version: 1,
    revision: 0,
    updatedAt: null,
    days: {},
    cards: [],
  });
});

test('removes a stale write lock without blocking the service', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-learning-stale-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'learning-data.json.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1 }), 'utf8');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, old, old);

  const store = createLearningDataStore({ assistantRoot: root, lockPath });
  const snapshot = store.upsertDayManual('2026-07-18', { note: '服务已恢复' });

  assert.equal(snapshot.days['2026-07-18'].manual.note, '服务已恢复');
  assert.equal(fs.existsSync(lockPath), false);
});

test('keeps the default coordination lock in the writable temp directory', (t) => {
  const store = makeFixture(t);
  assert.equal(path.dirname(store.lockPath).startsWith(os.tmpdir()), true);
  store.upsertDayManual('2026-07-18', { note: '临时锁写入测试' });
  assert.equal(fs.existsSync(store.lockPath), false);
});

test('stores long-term manual records without touching generated notes', (t) => {
  const store = makeFixture(t);
  store.upsertDayManual('2027-01-05', {
    completedTaskIds: ['math', 'math'],
    note: '手写备注',
    mistakes: '手写错题',
  });

  store.syncNote({
    noteUid: 'note-1',
    title: '极限经典例题',
    subject: '高等数学',
    remark: 'p108 3.1题 [错题]',
    createdAt: '2027-01-05T02:00:00.000Z',
    filePath: 'C:\\notes\\one.png',
  });

  const snapshot = store.upsertDayManual('2027-01-05', { debt: '需要重做' });
  assert.equal(snapshot.days['2027-01-05'].manual.note, '手写备注');
  assert.equal(snapshot.days['2027-01-05'].manual.mistakes, '手写错题');
  assert.equal(snapshot.days['2027-01-05'].manual.debt, '需要重做');
  assert.deepEqual(snapshot.days['2027-01-05'].manual.completedTaskIds, ['math']);
  assert.equal(snapshot.days['2027-01-05'].autoNotes.length, 1);
});

test('syncNote is idempotent by noteUid and deterministic card sourceKey', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'note-108',
    title: '一元函数极值',
    subject: '高等数学',
    remark: 'p108 3.1题 错题 背诵',
    createdAt: '2026-07-16T17:30:00.000Z',
    filePath: 'C:\\notes\\math.png',
  };
  const first = store.syncNote(metadata, {
    enrichment: {
      pageRefs: [{ raw: 'p108 3.1题', page: 108, question: '3.1' }],
      tags: ['错题', '背诵'],
      knowledgePath: ['高等数学', '极值'],
      noteType: 'problem',
      confidence: 0.94,
    },
    cards: [{
      sourceKey: 'mistake-main',
      kind: 'mistake',
      front: '这题的易错点是什么？',
      back: '先检查导数为零的点。',
    }],
  });
  const second = store.syncNote(metadata, {
    enrichment: {
      tags: ['错题', '背诵', '经典'],
      knowledgePath: ['高等数学', '极值'],
    },
    cards: [{
      sourceKey: 'mistake-main',
      kind: 'mistake',
      front: '这题的错因是什么？',
      back: '检查导数为零的点和端点。',
    }],
  });

  assert.equal(first.days['2026-07-17'].autoNotes.length, 1, 'UTC time converts to China date');
  assert.equal(second.days['2026-07-17'].autoNotes.length, 1);
  assert.equal(second.cards.length, 1);
  assert.equal(second.cards[0].front, '这题的错因是什么？');
  assert.deepEqual(second.days['2026-07-17'].autoNotes[0].tags, ['错题', '背诵', '经典']);
  assert.deepEqual(second.days['2026-07-17'].autoNotes[0].pageRefs, [{ raw: 'p108 3.1题', page: 108, question: '3.1' }]);
  assert.deepEqual(second.days['2026-07-17'].autoNotes[0].cardIds, [second.cards[0].id]);
});

test('keeps a user-edited card intact when AI sync runs again', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'note-lock',
    title: '背诵定义',
    subject: '数据结构',
    createdAt: '2026-07-17T03:00:00.000Z',
  };
  const initial = store.syncNote(metadata, {
    cards: [{ sourceKey: 'definition', front: 'AI 问题', back: 'AI 答案' }],
  });
  const cardId = initial.cards[0].id;
  store.updateCard(cardId, { front: '我修改后的问题', back: '我修改后的答案', status: 'active' });

  const resynced = store.syncNote(metadata, {
    cards: [{ sourceKey: 'definition', front: 'AI 新问题', back: 'AI 新答案' }],
  });
  assert.equal(resynced.cards[0].front, '我修改后的问题');
  assert.equal(resynced.cards[0].back, '我修改后的答案');
  assert.equal(resynced.cards[0].status, 'active');
  assert.equal(resynced.cards[0].userEdited, true);
});

test('manual record replacement preserves autoNotes and cards', (t) => {
  const store = makeFixture(t);
  store.syncNote({
    noteUid: 'note-preserve',
    title: '需要保留',
    createdAt: '2026-07-17T01:00:00.000Z',
  }, {
    cards: [{ sourceKey: 'one', front: '正面', back: '背面' }],
  });
  const snapshot = store.replaceManualRecords({
    '2026-07-17': { note: '导入后的手写备注' },
  });

  assert.equal(snapshot.days['2026-07-17'].manual.note, '导入后的手写备注');
  assert.equal(snapshot.days['2026-07-17'].autoNotes.length, 1);
  assert.equal(snapshot.cards.length, 1);
});

test('rebuildNoteIndex atomically replaces generated notes while preserving manual data and edited cards', (t) => {
  const store = makeFixture(t);
  store.upsertDayManual('2026-07-17', { note: '保留我的课表备注' });
  store.syncNote({
    noteUid: 'stale-note',
    title: '已经删除的旧索引',
    createdAt: '2026-07-15T03:00:00.000Z',
  }, {
    cards: [{ sourceKey: 'old', front: '旧问题', back: '旧答案' }],
  });
  let snapshot = store.syncNote({
    noteUid: 'note-rebuild',
    title: '旧标题',
    createdAt: '2026-07-16T03:00:00.000Z',
  }, {
    cards: [{ sourceKey: 'remark-mistake:0', kind: 'mistake', front: 'AI 问题', back: 'AI 答案' }],
  });
  const editedCardId = snapshot.cards.find((card) => card.noteUid === 'note-rebuild').id;
  store.updateCard(editedCardId, { front: '我修改的问题', status: 'active' });

  snapshot = store.rebuildNoteIndex([
    {
      metadata: {
        noteUid: 'note-rebuild',
        title: '重复记录旧副本',
        createdAt: '2026-07-16T03:00:00.000Z',
      },
      enrichment: { capturedDate: '2026-07-16', tags: ['错题'] },
      cards: [{ sourceKey: 'remark-mistake:0', kind: 'mistake', front: '重建问题一', back: '重建答案一' }],
    },
    {
      metadata: {
        noteUid: 'note-rebuild',
        title: '当前记录',
        createdAt: '2026-07-17T03:00:00.000Z',
      },
      enrichment: { capturedDate: '2026-07-17', tags: ['错题', '背诵'] },
      cards: [{ sourceKey: 'remark-mistake:0', kind: 'mistake', front: '重建问题二', back: '重建答案二' }],
    },
  ]);

  assert.equal(snapshot.days['2026-07-17'].manual.note, '保留我的课表备注');
  assert.equal(snapshot.days['2026-07-17'].autoNotes.length, 1);
  assert.equal(snapshot.days['2026-07-17'].autoNotes[0].title, '当前记录');
  assert.deepEqual(snapshot.days['2026-07-17'].autoNotes[0].tags, ['错题', '背诵']);
  assert.equal(Object.values(snapshot.days).flatMap((day) => day.autoNotes).some((note) => note.noteUid === 'stale-note'), false);
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.cards[0].id, editedCardId);
  assert.equal(snapshot.cards[0].front, '我修改的问题');
  assert.equal(snapshot.cards[0].status, 'active');
});

test('organization decisions survive later note syncs and full index rebuilds', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'note-confirmed',
    title: 'Confirmed classification',
    createdAt: '2026-07-17T03:00:00.000Z',
  };

  let snapshot = store.syncNote(metadata, {
    enrichment: { capturedDate: '2026-07-17', confidence: 0.42 },
  });
  assert.equal(snapshot.days['2026-07-17'].autoNotes[0].organizationStatus, 'pending');

  snapshot = store.updateNote('note-confirmed', { organizationStatus: 'confirmed' });
  assert.equal(snapshot.days['2026-07-17'].autoNotes[0].organizationStatus, 'confirmed');

  snapshot = store.syncNote(metadata, {
    enrichment: {
      capturedDate: '2026-07-17',
      confidence: 0.98,
      organizationStatus: 'pending',
    },
  });
  assert.equal(snapshot.days['2026-07-17'].autoNotes[0].organizationStatus, 'confirmed');

  snapshot = store.rebuildNoteIndex([{
    metadata,
    enrichment: {
      capturedDate: '2026-07-17',
      confidence: 0.99,
      organizationStatus: 'pending',
    },
  }]);
  assert.equal(snapshot.days['2026-07-17'].autoNotes[0].organizationStatus, 'confirmed');
  assert.throws(
    () => store.updateNote('missing-note', { organizationStatus: 'ignored' }),
    { code: 'NOTE_NOT_FOUND' },
  );
  assert.throws(
    () => store.updateNote('note-confirmed', { organizationStatus: 'unknown' }),
    /Invalid note organization status/,
  );
});

test('restoreSnapshot restores a normalized recovery payload without lowering the live revision', (t) => {
  const store = makeFixture(t);
  store.upsertDayManual('2026-07-18', { note: '当前数据' });
  const restored = store.restoreSnapshot({
    version: 1,
    revision: 0,
    updatedAt: null,
    days: {
      '2026-07-17': {
        manual: { note: '备份数据' },
        autoNotes: [],
      },
    },
    cards: [],
  });
  assert.equal(restored.revision, 2);
  assert.equal(restored.days['2026-07-17'].manual.note, '备份数据');
  assert.equal(restored.days['2026-07-18'], undefined);
});

test('keeps activation state across AI reruns and schedules 1/3/7/14 day reviews', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'note-review',
    title: '复习卡',
    createdAt: '2026-07-17T03:00:00.000Z',
  };
  let snapshot = store.syncNote(metadata, {
    cards: [{ sourceKey: 'review', front: '问题', back: '答案' }],
  });
  const cardId = snapshot.cards[0].id;
  snapshot = store.updateCard(cardId, { status: 'active' });
  assert.equal(snapshot.cards[0].status, 'active');

  snapshot = store.syncNote(metadata, {
    cards: [{ sourceKey: 'review', front: 'AI 更新问题', back: 'AI 更新答案' }],
  });
  assert.equal(snapshot.cards[0].status, 'active');

  const expectedDates = ['2026-07-18', '2026-07-20', '2026-07-24', '2026-07-31'];
  for (const expectedDate of expectedDates) {
    snapshot = store.updateCard(cardId, { reviewResult: 'remembered' });
    assert.equal(snapshot.cards[0].dueDate, expectedDate);
  }
  assert.equal(snapshot.cards[0].reviewCount, 4);

  snapshot = store.updateCard(cardId, { reviewResult: 'forgotten' });
  assert.equal(snapshot.cards[0].dueDate, '2026-07-18');
  assert.equal(snapshot.cards[0].reviewStep, 0);
  assert.equal(snapshot.cards[0].lastReviewResult, 'forgotten');
});

test('rejects stale revisions and keeps a backup after subsequent writes', (t) => {
  const store = makeFixture(t);
  const first = store.upsertDayManual('2026-07-17', { note: '第一版' });
  assert.throws(
    () => store.upsertDayManual('2026-07-17', { note: '过期修改' }, { expectedRevision: 0 }),
    (error) => error instanceof LearningDataConflictError && error.code === 'REVISION_CONFLICT',
  );
  const second = store.upsertDayManual('2026-07-17', { note: '第二版' }, { expectedRevision: first.revision });
  assert.equal(second.revision, 2);
  assert.equal(store.getSnapshot().days['2026-07-17'].manual.note, '第二版');
  assert.equal(fs.existsSync(store.backupPath), true);
});

test('formats captured dates in the configured timezone', () => {
  assert.equal(formatDateInTimeZone('2026-07-16T17:30:00.000Z', 'Asia/Shanghai'), '2026-07-17');
});
