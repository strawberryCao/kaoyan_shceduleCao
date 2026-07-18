const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireOrganizerLock, organizeNotes, recoverMoves } = require('./organize-notes.cjs');

function makeFixture(prefix = 'kaoyan-organizer-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const sourceDir = path.join(notesRoot, '默认文件夹');
  const metadataDir = path.join(sourceDir, '.metadata');
  fs.mkdirSync(metadataDir, { recursive: true });
  const imagePath = path.join(sourceDir, '默认文件夹_待整理_20260717_090000.png');
  const sidecarPath = path.join(metadataDir, '默认文件夹_待整理_20260717_090000.note.json');
  fs.writeFileSync(imagePath, Buffer.from('not-a-real-png-but-enough-for-file-tests'));
  fs.writeFileSync(sidecarPath, JSON.stringify({
    id: '默认文件夹_待整理_20260717_090000',
    kind: 'single',
    subject: '默认文件夹',
    title: '待整理',
    remark: 'p108 3.1题 #错题 #背诵 错因：忘记讨论定义域',
    createdAt: '2026-07-17T01:00:00.000Z',
    fileName: path.basename(imagePath),
    filePath: imagePath,
    mime: 'image/png',
  }, null, 2));
  return { root, notesRoot, assistantRoot, sourceDir, imagePath, sidecarPath };
}

test('enriches metadata but keeps physical storage at subject depth', async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let analyzerCalls = 0;
  let syncCalls = 0;
  const analyzer = async () => {
    analyzerCalls += 1;
    return {
      subject: '高等数学',
      knowledgePoint: '函数极限',
      title: '函数极限定义域错题',
      confidence: 0.96,
      provider: 'test',
      model: 'fake-model',
      tags: ['定义域'],
      cards: [{ sourceKey: 'ai:0', kind: 'mistake', front: '为什么要讨论定义域？', back: '先确定函数有定义。' }],
    };
  };
  analyzer.analyzerVersion = 'test-v1';
  const syncNote = async (metadata, options) => {
    syncCalls += 1;
    assert.equal(metadata.noteUid.length > 10, true);
    assert.equal(options.cards.length, 1);
  };

  const first = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    analyzeNote: analyzer,
    syncNote,
    cadenceMs: 0,
  });
  assert.equal(first.processed, 1);
  assert.equal(first.moved, 1);
  assert.equal(first.synced, 1);
  assert.equal(fs.existsSync(fixture.imagePath), false);

  const destinationDir = path.join(fixture.notesRoot, '高等数学');
  const destinationImage = path.join(destinationDir, path.basename(fixture.imagePath));
  const destinationSidecar = path.join(destinationDir, '.metadata', '默认文件夹_待整理_20260717_090000.note.json');
  assert.equal(fs.existsSync(destinationImage), true);
  assert.equal(fs.existsSync(path.join(destinationDir, '函数极限')), false);
  const metadata = JSON.parse(fs.readFileSync(destinationSidecar, 'utf8'));
  const noteUid = metadata.noteUid;
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.classification.knowledgePointName, '函数极限');
  assert.deepEqual(metadata.extracted.pages, [108]);
  assert.deepEqual(metadata.extracted.questions, ['3.1']);
  assert.equal(metadata.organizer.learningSyncStatus, 'synced');
  assert.equal(metadata.learning.cards.length, 1);

  const second = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    analyzeNote: analyzer,
    syncNote,
    cadenceMs: 0,
  });
  assert.equal(second.skipped, 1);
  assert.equal(analyzerCalls, 1);
  assert.equal(syncCalls, 1);
  const afterSecond = JSON.parse(fs.readFileSync(destinationSidecar, 'utf8'));
  assert.equal(afterSecond.noteUid, noteUid);
});

test('dry run reports the move without changing metadata or files', async (t) => {
  const fixture = makeFixture('kaoyan-organizer-dry-');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const originalSidecar = fs.readFileSync(fixture.sidecarPath, 'utf8');
  const report = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    dryRun: true,
    syncNote: false,
    analyzeNote: async () => ({ subject: '高等数学', knowledgePoint: '导数', confidence: 0.99 }),
  });
  assert.equal(report.wouldMove, 1);
  assert.equal(fs.existsSync(fixture.imagePath), true);
  assert.equal(fs.readFileSync(fixture.sidecarPath, 'utf8'), originalSidecar);
  assert.equal(fs.existsSync(path.join(fixture.assistantRoot, 'note-taxonomy.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.assistantRoot, 'note-organizer-state.json')), false);
});

test('keeps low-confidence category changes in place for review', async (t) => {
  const fixture = makeFixture('kaoyan-organizer-review-');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const report = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    syncNote: false,
    cadenceMs: 0,
    analyzeNote: async () => ({ subject: '高等数学', knowledgePoint: '极限', confidence: 0.55 }),
  });
  assert.equal(report.moved, 0);
  assert.equal(report.needsReview, 1);
  assert.equal(fs.existsSync(fixture.imagePath), true);
  const metadata = JSON.parse(fs.readFileSync(fixture.sidecarPath, 'utf8'));
  assert.equal(metadata.subject, '默认文件夹');
  assert.equal(metadata.organizer.status, 'needs_review');
  assert.deepEqual(metadata.organizer.proposed, { subject: '高等数学', knowledgePoint: '极限' });
});

test('uses the learning data store when available and skips a successful run for 72 hours', async (t) => {
  const fixture = makeFixture('kaoyan-organizer-learning-');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let calls = 0;
  const analyzer = async (context) => {
    calls += 1;
    return { subject: context.currentCategory.subject, confidence: 1, summary: '极限题复盘' };
  };
  const first = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    analyzeNote: analyzer,
  });
  assert.equal(first.synced, 1);
  const learningData = JSON.parse(fs.readFileSync(path.join(fixture.assistantRoot, 'learning-data.json'), 'utf8'));
  const day = learningData.days['2026-07-17'];
  assert.equal(day.autoNotes.length, 1);
  assert.equal(learningData.cards.length, 2);

  const second = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    analyzeNote: analyzer,
  });
  assert.equal(second.cadenceSkipped, true);
  assert.equal(calls, 1);
});

test('persists AI items and combines semantic AI intent with local flags', async (t) => {
  const fixture = makeFixture('kaoyan-organizer-intent-');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const original = JSON.parse(fs.readFileSync(fixture.sidecarPath, 'utf8'));
  original.remark = '极限定义中的量词顺序';
  fs.writeFileSync(fixture.sidecarPath, JSON.stringify(original, null, 2));
  const report = await organizeNotes({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    syncNote: false,
    cadenceMs: 0,
    analyzeNote: async () => ({
      subject: '默认文件夹',
      title: '极限定义量词顺序',
      summary: '先任意给定 epsilon，再寻找 delta。',
      confidence: 0.95,
      intent: { isQuestion: false, isMistake: false, shouldMemorize: true },
      items: [{
        title: '量词顺序',
        knowledgePoint: '极限定义',
        summary: 'epsilon 在 delta 之前给定。',
        tags: ['定义'],
        wrongReason: null,
        intent: { isQuestion: false, isMistake: false, shouldMemorize: true },
      }],
    }),
  });
  assert.equal(report.processed, 1);
  const metadata = JSON.parse(fs.readFileSync(fixture.sidecarPath, 'utf8'));
  assert.equal(metadata.items.length, 1);
  assert.equal(metadata.organizer.intent.shouldMemorize, true);
  assert.equal(metadata.learning.intent.shouldMemorize, true);
  assert.equal(metadata.learning.noteType, 'memory');
  assert.equal(metadata.learning.items[0].title, '量词顺序');
  assert.equal(metadata.learning.tags.includes('背诵'), true);
  assert.equal(metadata.learning.cards.length, 1);
});

test('recovers a planned move after interruption', (t) => {
  const fixture = makeFixture('kaoyan-organizer-recover-');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(fixture.assistantRoot, { recursive: true });
  const destinationDir = path.join(fixture.notesRoot, '高等数学', '极限');
  const destinationImage = path.join(destinationDir, path.basename(fixture.imagePath));
  const destinationSidecar = path.join(destinationDir, '.metadata', '默认文件夹_待整理_20260717_090000.note.json');
  const logPath = path.join(fixture.assistantRoot, 'moves.jsonl');
  fs.writeFileSync(logPath, `${JSON.stringify({
    operationId: 'operation-1',
    phase: 'planned',
    at: new Date().toISOString(),
    noteUid: 'stable-note-1',
    sourceImage: fixture.imagePath,
    destinationImage,
    sourceSidecar: fixture.sidecarPath,
    destinationSidecar,
    sourceDir: fixture.sourceDir,
    destinationDir,
  })}\n`);
  const result = recoverMoves({ notesRoot: fixture.notesRoot, logPath });
  assert.deepEqual(result, { recovered: 1, failed: 0 });
  assert.equal(fs.existsSync(fixture.imagePath), false);
  assert.equal(fs.existsSync(fixture.sidecarPath), false);
  assert.equal(fs.existsSync(destinationImage), true);
  const metadata = JSON.parse(fs.readFileSync(destinationSidecar, 'utf8'));
  assert.equal(metadata.noteUid, 'stable-note-1');
  assert.equal(metadata.filePath, destinationImage);
});

test('replaces a stale organizer lock and release removes the live lock file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-organizer-lock-'));
  const lockPath = path.join(root, 'note-organizer.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: '2020-01-01T00:00:00.000Z' }), 'utf8');

  const release = acquireOrganizerLock(lockPath, 1);
  assert.equal(fs.existsSync(lockPath), true);
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(owner.pid, process.pid);

  release();
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmdirSync(root);
});
