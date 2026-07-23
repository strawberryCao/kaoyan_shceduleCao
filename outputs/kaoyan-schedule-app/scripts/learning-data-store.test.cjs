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
    deletedNotes: {},
  });
});

test('keeps editable study thoughts attached to a note across classification changes', (t) => {
  const store = makeFixture(t);
  let snapshot = store.createNote({
    noteUid: 'thought-timeline-note',
    capturedDate: '2026-07-10',
    title: '页表地址转换',
    subject: '操作系统',
    noteType: 'mistake',
  });

  snapshot = store.updateNote('thought-timeline-note', {
    thoughtAction: { action: 'add', text: '第一次重做：页内偏移位数只由页面大小决定。' },
  }, { expectedRevision: snapshot.revision });
  let note = snapshot.days['2026-07-10'].autoNotes[0];
  assert.equal(note.studyNotes.length, 1);
  assert.equal(note.studyNotes[0].text, '第一次重做：页内偏移位数只由页面大小决定。');
  const thoughtId = note.studyNotes[0].id;

  snapshot = store.updateNote('thought-timeline-note', {
    subject: '计算机组成',
    knowledgePath: ['计算机组成', '存储系统'],
  }, { expectedRevision: snapshot.revision });
  note = snapshot.days['2026-07-10'].autoNotes[0];
  assert.equal(note.studyNotes[0].id, thoughtId);

  snapshot = store.updateNote('thought-timeline-note', {
    thoughtAction: { action: 'update', id: thoughtId, text: '第二次理解：先拆页号与页内偏移，再查页表。' },
  }, { expectedRevision: snapshot.revision });
  note = snapshot.days['2026-07-10'].autoNotes[0];
  assert.equal(note.studyNotes[0].text, '第二次理解：先拆页号与页内偏移，再查页表。');

  snapshot = store.updateNote('thought-timeline-note', {
    thoughtAction: { action: 'delete', id: thoughtId },
  }, { expectedRevision: snapshot.revision });
  assert.deepEqual(snapshot.days['2026-07-10'].autoNotes[0].studyNotes, []);
});

test('supports note and card CRUD with recoverable tombstones that survive sync and rebuild', (t) => {
  const store = makeFixture(t);
  let snapshot = store.createNote({
    noteUid: 'manual-mistake-note',
    capturedDate: '2026-07-16',
    title: '二叉树遍历错题',
    remark: '先写递归出口',
    subject: '数据结构',
    knowledgePath: ['数据结构', '树'],
    noteType: 'mistake',
    tags: ['重点'],
    createCard: true,
  }, { expectedRevision: 0 });
  let note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.manualCreated, true);
  assert.equal(note.classificationSource, 'manual');
  assert.deepEqual(note.tags, ['重点', '错题']);
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.cards[0].status, 'active');
  assert.equal(snapshot.cards[0].dueDate, '2026-07-17');
  assert.equal(snapshot.cards[0].front, '二叉树遍历错题');

  snapshot = store.updateNote('manual-mistake-note', {
    subject: '操作系统',
  }, { expectedRevision: snapshot.revision });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.subject, '操作系统');
  assert.deepEqual(note.knowledgePath, ['操作系统', '树']);
  assert.equal(snapshot.cards[0].subject, '操作系统');
  assert.deepEqual(snapshot.cards[0].knowledgePath, ['操作系统', '树']);

  snapshot = store.updateNote('manual-mistake-note', {
    title: '二叉树遍历与递归',
    remark: '检查递归出口和访问顺序',
    tags: ['错题', '递归'],
    noteType: 'mistake',
    wrongReason: '前序与中序混淆',
  }, { expectedRevision: snapshot.revision });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.title, '二叉树遍历与递归');
  assert.equal(note.remark, '检查递归出口和访问顺序');
  assert.equal(note.wrongReason, '前序与中序混淆');

  snapshot = store.createCard({
    noteUid: 'manual-mistake-note',
    kind: 'memory',
    front: '三种深度优先遍历？',
    back: '前序、中序、后序',
    status: 'draft',
  }, { expectedRevision: snapshot.revision });
  const customCard = snapshot.cards.find((card) => card.front === '三种深度优先遍历？');
  assert.ok(customCard);
  snapshot = store.updateCard(customCard.id, { back: '前序 / 中序 / 后序' }, { expectedRevision: snapshot.revision });
  assert.equal(snapshot.cards.find((card) => card.id === customCard.id).back, '前序 / 中序 / 后序');
  snapshot = store.deleteCard(customCard.id, { expectedRevision: snapshot.revision });
  assert.equal(snapshot.cards.some((card) => card.id === customCard.id), false);

  snapshot = store.deleteNote('manual-mistake-note', { expectedRevision: snapshot.revision });
  assert.equal(Object.values(snapshot.days).flatMap((day) => day.autoNotes).length, 0);
  assert.equal(snapshot.cards.length, 0);
  assert.equal(snapshot.deletedNotes['manual-mistake-note'].note.title, '二叉树遍历与递归');
  assert.equal(snapshot.deletedNotes['manual-mistake-note'].cards.length, 1);

  snapshot = store.syncNote({
    noteUid: 'manual-mistake-note',
    title: 'AI 不应复活',
    subject: '数据结构',
    createdAt: '2026-07-16T04:00:00.000Z',
  }, { enrichment: { capturedDate: '2026-07-16', noteType: 'mistake' } });
  assert.equal(Object.values(snapshot.days).flatMap((day) => day.autoNotes).length, 0);
  assert.ok(snapshot.deletedNotes['manual-mistake-note']);

  snapshot = store.rebuildNoteIndex([{
    metadata: {
      noteUid: 'manual-mistake-note',
      title: '重建也不应复活',
      subject: '数据结构',
      createdAt: '2026-07-16T04:00:00.000Z',
    },
    enrichment: { capturedDate: '2026-07-16', noteType: 'mistake' },
  }]);
  assert.equal(Object.values(snapshot.days).flatMap((day) => day.autoNotes).length, 0);
  assert.ok(snapshot.deletedNotes['manual-mistake-note']);

  snapshot = store.restoreNote('manual-mistake-note', { expectedRevision: snapshot.revision });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.title, '二叉树遍历与递归');
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.deletedNotes['manual-mistake-note'], undefined);

  snapshot = store.syncNote({
    noteUid: 'manual-mistake-note',
    title: 'AI 新标题',
    remark: 'AI 新备注',
    subject: '数据结构',
    createdAt: '2026-07-16T04:00:00.000Z',
  }, { enrichment: { capturedDate: '2026-07-16', tags: ['AI'], noteType: 'memory' } });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.title, '二叉树遍历与递归');
  assert.equal(note.remark, '检查递归出口和访问顺序');
  assert.deepEqual(note.tags, ['错题', '递归']);
  assert.equal(note.noteType, 'mistake');
});

test('keeps manual good-question membership across AI resyncs', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'good-question-membership',
    title: '链表错题',
    subject: '数据结构',
    remark: '指针更新顺序写反了',
    createdAt: '2026-07-16T04:00:00.000Z',
  };
  let snapshot = store.syncNote(metadata, {
    enrichment: { capturedDate: '2026-07-16', noteType: 'mistake', tags: ['错题'] },
  });

  snapshot = store.updateNote('good-question-membership', {
    goodQuestion: true,
    tags: ['错题', '好题'],
  }, { expectedRevision: snapshot.revision });
  let note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.goodQuestion, true);
  assert.equal(note.userEditedFields.includes('goodQuestion'), true);

  snapshot = store.syncNote({ ...metadata, title: 'AI 再次分析的标题' }, {
    enrichment: { capturedDate: '2026-07-16', noteType: 'mistake', tags: ['错题'] },
  });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.goodQuestion, true);

  snapshot = store.updateNote('good-question-membership', { goodQuestion: false }, {
    expectedRevision: snapshot.revision,
  });
  note = snapshot.days['2026-07-16'].autoNotes[0];
  assert.equal(note.goodQuestion, false);
  assert.throws(
    () => store.updateNote('good-question-membership', { goodQuestion: null }),
    (error) => error?.code === 'INVALID_LEARNING_NOTE',
  );
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

test('manual classification updates notes and cards and survives later AI syncs', (t) => {
  const store = makeFixture(t);
  const metadata = {
    noteUid: 'note-manual-classification',
    title: '被错误放进收件箱的数学题',
    subject: '默认文件夹',
    createdAt: '2026-07-17T03:00:00.000Z',
  };
  let snapshot = store.syncNote(metadata, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: '默认文件夹',
      knowledgePath: ['默认文件夹'],
      organizationStatus: 'pending',
      classificationSource: 'ai',
    },
    cards: [{ sourceKey: 'mistake:0', kind: 'mistake', front: '重做这道题', back: '答案' }],
  });
  assert.equal(snapshot.cards[0].status, 'draft');

  snapshot = store.updateNote('note-manual-classification', {
    subject: '高等数学',
    knowledgePath: ['高等数学', '数列极限'],
    questionType: '极限计算',
    wrongReason: '忽略等价无穷小条件',
  });
  const corrected = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(corrected.subject, '高等数学');
  assert.deepEqual(corrected.knowledgePath, ['高等数学', '数列极限']);
  assert.equal(corrected.organizationStatus, 'confirmed');
  assert.equal(corrected.classificationSource, 'manual');
  assert.equal(snapshot.cards[0].subject, '高等数学');
  assert.deepEqual(snapshot.cards[0].knowledgePath, ['高等数学', '数列极限']);
  assert.equal(snapshot.cards[0].status, 'active');

  snapshot = store.syncNote({ ...metadata, subject: '概率论' }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: '概率论',
      knowledgePath: ['概率论', '随机变量'],
      questionType: '选择题',
      wrongReason: 'AI 新判断',
      organizationStatus: 'confirmed',
      classificationSource: 'ai',
    },
    cards: [{ sourceKey: 'mistake:0', kind: 'mistake', front: '重做这道题', back: '新答案' }],
  });
  const afterAi = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(afterAi.subject, '高等数学');
  assert.deepEqual(afterAi.knowledgePath, ['高等数学', '数列极限']);
  assert.equal(afterAi.questionType, '极限计算');
  assert.equal(afterAi.wrongReason, '忽略等价无穷小条件');
  assert.equal(afterAi.classificationSource, 'manual');
});

test('manual move to the default bucket is not reverted from the previous file folder', (t) => {
  const store = makeFixture(t);
  const oldFilePath = path.join('C:', 'Users', 'ASUS', 'Desktop', '笔记', '计算机视觉', '图像.png');
  let snapshot = store.syncNote({
    noteUid: 'note-manual-default',
    title: '图像噪声分析',
    subject: '计算机视觉',
    filePath: oldFilePath,
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: '计算机视觉',
      knowledgePath: ['计算机视觉', '图像噪声'],
      organizationStatus: 'confirmed',
      classificationSource: 'ai',
    },
  });

  snapshot = store.updateNote('note-manual-default', {
    subject: '默认文件夹',
    knowledgePath: ['默认文件夹', '图像噪声'],
    organizationStatus: 'pending',
  });
  let note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.subject, '默认文件夹');
  assert.deepEqual(note.knowledgePath, ['默认文件夹', '图像噪声']);
  assert.equal(note.classificationSource, 'manual');

  snapshot = store.syncNote({
    noteUid: 'note-manual-default',
    title: '图像噪声分析',
    subject: '默认文件夹',
    filePath: path.join('C:', 'Users', 'ASUS', 'Desktop', '笔记', '默认文件夹', '图像.png'),
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: '默认文件夹',
      knowledgePath: ['默认文件夹', '图像噪声'],
      organizationStatus: 'confirmed',
      classificationSource: 'manual',
    },
  });
  note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.subject, '默认文件夹');
  assert.deepEqual(note.knowledgePath, ['默认文件夹', '图像噪声']);
});

test('repairs a stale inbox subject from the existing subject folder', (t) => {
  const store = makeFixture(t);
  const snapshot = store.syncNote({
    noteUid: 'note-stale-inbox',
    title: '已经移动过的数学题',
    subject: '默认文件夹',
    filePath: path.join('C:', 'Users', 'ASUS', 'Desktop', '笔记', '高等数学', '数学题.png'),
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: '默认文件夹',
      knowledgePath: ['默认文件夹'],
      organizationStatus: 'pending',
    },
  });
  const note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.subject, '高等数学');
  assert.deepEqual(note.knowledgePath, ['高等数学']);
  assert.equal(note.organizationStatus, 'confirmed');
  assert.equal(note.classificationSource, 'local');
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

test('auto-activates cards and retires a card after three consecutive correct reviews', (t) => {
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
  assert.equal(snapshot.cards[0].status, 'active');

  snapshot = store.syncNote(metadata, {
    cards: [{ sourceKey: 'review', front: 'AI 更新问题', back: 'AI 更新答案' }],
  });
  assert.equal(snapshot.cards[0].status, 'active');

  const expectedDates = ['2026-07-18', '2026-07-20'];
  for (const expectedDate of expectedDates) {
    snapshot = store.updateCard(cardId, { reviewResult: 'remembered' });
    assert.equal(snapshot.cards[0].dueDate, expectedDate);
    assert.equal(snapshot.cards[0].status, 'active');
  }
  snapshot = store.updateCard(cardId, { reviewResult: 'remembered' });
  assert.equal(snapshot.cards[0].dueDate, '');
  assert.equal(snapshot.cards[0].status, 'archived');
  assert.equal(snapshot.cards[0].reviewCount, 3);
  assert.equal(snapshot.cards[0].correctStreak, 3);

  snapshot = store.updateCard(cardId, { reviewResult: 'forgotten' });
  assert.equal(snapshot.cards[0].dueDate, '2026-07-18');
  assert.equal(snapshot.cards[0].status, 'active');
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

test('ordinary content edits do not complete a pending review', (t) => {
  const store = makeFixture(t);
  let snapshot = store.syncNote({
    noteUid: 'note-content-only-edit',
    title: 'AI draft title',
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: 'Inbox',
      organizationStatus: 'pending',
      classificationSource: 'ai',
      reviewStatus: 'pending',
      proposalId: 'proposal-content-edit',
    },
  });
  snapshot = store.updateNote('note-content-only-edit', {
    title: 'User title',
    remark: 'User note text',
  });
  const note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.reviewStatus, 'pending');
  assert.equal(note.organizationStatus, 'pending');
  assert.equal(note.decisionRevision, 0);
});

test('review actions are idempotent, revision guarded, and ignored notes cannot reactivate cards', (t) => {
  const store = makeFixture(t);
  let snapshot = store.syncNote({
    noteUid: 'note-review-actions',
    title: 'Pending mistake',
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: 'Inbox',
      knowledgePath: ['Inbox'],
      organizationStatus: 'pending',
      classificationSource: 'ai',
      reviewStatus: 'pending',
      proposalId: 'proposal-review-actions',
    },
    cards: [{ sourceKey: 'mistake:0', kind: 'mistake', front: 'Question text', back: 'Answer text' }],
  });
  const accepted = store.applyNoteReviewAction({
    noteUid: 'note-review-actions',
    action: 'accept',
    operationId: 'review-op-accept',
    expectedDecisionRevision: 0,
    proposalId: 'proposal-review-actions',
    patch: { subject: 'Mathematics', knowledgePath: ['Mathematics', 'Limits'] },
  });
  snapshot = accepted.snapshot;
  let note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.reviewStatus, 'accepted');
  assert.equal(note.organizationStatus, 'confirmed');
  assert.equal(note.decisionRevision, 1);
  assert.equal(snapshot.cards[0].status, 'active');

  const replay = store.applyNoteReviewAction({
    noteUid: 'note-review-actions',
    action: 'accept',
    operationId: 'review-op-accept',
    expectedDecisionRevision: 0,
    proposalId: 'proposal-review-actions',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.revision, snapshot.revision);
  assert.throws(() => store.applyNoteReviewAction({
    noteUid: 'note-review-actions',
    action: 'correct',
    operationId: 'review-op-stale',
    expectedDecisionRevision: 0,
    patch: { subject: 'Linear Algebra' },
  }), { code: 'NOTE_REVIEW_CONFLICT' });

  const ignored = store.applyNoteReviewAction({
    noteUid: 'note-review-actions',
    action: 'ignore',
    operationId: 'review-op-ignore',
    expectedDecisionRevision: 1,
  });
  snapshot = ignored.snapshot;
  note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.reviewStatus, 'ignored');
  assert.equal(note.organizationStatus, 'ignored');
  assert.equal(note.decisionRevision, 2);
  assert.equal(snapshot.cards.every((card) => card.noteUid !== note.noteUid || card.status === 'archived'), true);

  snapshot = store.syncNote({
    noteUid: 'note-review-actions',
    title: 'New AI output',
    createdAt: '2026-07-17T03:00:00.000Z',
  }, {
    enrichment: {
      capturedDate: '2026-07-17',
      subject: 'Probability',
      reviewStatus: 'auto_applied',
      organizationStatus: 'confirmed',
      classificationSource: 'ai',
    },
    cards: [{ sourceKey: 'mistake:1', kind: 'mistake', front: 'New question', back: 'New answer' }],
  });
  note = snapshot.days['2026-07-17'].autoNotes[0];
  assert.equal(note.reviewStatus, 'ignored');
  assert.equal(snapshot.cards.some((card) => card.noteUid === note.noteUid && card.status === 'active'), false);
});

test('legacy manual and ignored notes migrate to durable review states', (t) => {
  const store = makeFixture(t);
  const snapshot = store.restoreSnapshot({
    version: 1,
    revision: 4,
    days: {
      '2026-07-17': {
        autoNotes: [
          { noteUid: 'legacy-manual', subject: 'Mathematics', classificationSource: 'manual', organizationStatus: 'confirmed' },
          { noteUid: 'legacy-ignored', subject: 'Inbox', classificationSource: 'ai', organizationStatus: 'ignored' },
        ],
      },
    },
  });
  const notes = snapshot.days['2026-07-17'].autoNotes;
  assert.equal(notes.find((note) => note.noteUid === 'legacy-manual').reviewStatus, 'corrected');
  assert.equal(notes.find((note) => note.noteUid === 'legacy-manual').decisionRevision, 1);
  assert.equal(notes.find((note) => note.noteUid === 'legacy-ignored').reviewStatus, 'ignored');
  assert.equal(notes.find((note) => note.noteUid === 'legacy-ignored').decisionRevision, 1);
});
