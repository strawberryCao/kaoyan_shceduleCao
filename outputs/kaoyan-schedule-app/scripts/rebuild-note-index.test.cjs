const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLearningDataStore } = require('./learning-data-store.cjs');
const {
  rebuildNoteIndex,
  resolveCapturedAt,
  scanNoteIndex,
} = require('./rebuild-note-index.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-rebuild-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const nestedDir = path.join(notesRoot, '高等数学', '导数与切线');
  const imagePath = path.join(nestedDir, '高数_切线错题.png');
  const currentSidecar = path.join(nestedDir, '.metadata', '高数_切线错题.note.json');
  const oldSidecar = path.join(notesRoot, '高等数学', '.metadata', '旧目录副本.note.json');
  const orphanImage = path.join(notesRoot, '操作系统', '页面置换.png');
  fs.mkdirSync(path.dirname(currentSidecar), { recursive: true });
  fs.mkdirSync(path.dirname(orphanImage), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('current-image'));
  fs.writeFileSync(orphanImage, Buffer.from('orphan-image'));
  const shared = {
    noteUid: 'same-note-uid',
    subject: '高等数学',
    title: '切线与导数错题',
    remark: 'p108 3.1题 错因：审题遗漏 要背 经典题',
    createdAt: '2026-07-16T17:30:00.000Z',
    fileName: path.basename(imagePath),
    filePath: imagePath,
  };
  writeJson(oldSidecar, { ...shared, title: '旧目录副本' });
  writeJson(currentSidecar, {
    ...shared,
    classification: { subjectName: '高等数学', knowledgePointName: '导数与切线' },
    learning: { questionType: '计算题', items: [{ title: '分项', tags: ['易错'] }] },
  });
  const oldTime = new Date('2026-07-17T00:00:00.000Z');
  const newTime = new Date('2026-07-18T00:00:00.000Z');
  fs.utimesSync(oldSidecar, oldTime, oldTime);
  fs.utimesSync(currentSidecar, newTime, newTime);
  const orphanTime = new Date('2026-07-14T04:00:00.000Z');
  fs.utimesSync(orphanImage, orphanTime, orphanTime);
  const invalidSidecar = path.join(notesRoot, '操作系统', '.metadata', '损坏.note.json');
  fs.mkdirSync(path.dirname(invalidSidecar), { recursive: true });
  fs.writeFileSync(invalidSidecar, '{broken', 'utf8');
  return { root, notesRoot, assistantRoot, imagePath, currentSidecar, oldSidecar, orphanImage };
}

test('scan deduplicates noteUid, prefers the current enriched sidecar and indexes deterministic signals', (t) => {
  const fixture = makeFixture(t);
  const scan = scanNoteIndex({ notesRoot: fixture.notesRoot });

  assert.equal(scan.entries.length, 2);
  assert.equal(scan.report.duplicates.length, 1);
  assert.equal(scan.report.duplicates[0].kept, fixture.currentSidecar);
  assert.equal(scan.report.invalidSidecars.length, 1);
  assert.equal(scan.flattenPlans.length, 1);
  const mistake = scan.entries.find((entry) => entry.metadata.noteUid === 'same-note-uid');
  assert.equal(mistake.enrichment.capturedDate, '2026-07-17');
  assert.equal(mistake.enrichment.noteType, 'mistake');
  assert.equal(mistake.enrichment.tags.includes('错题'), true);
  assert.equal(mistake.enrichment.tags.includes('背诵'), true);
  assert.equal(mistake.enrichment.tags.includes('经典'), true);
  assert.deepEqual(mistake.enrichment.pageRefs, [{ raw: 'p108 3.1题', page: 108, question: '3.1' }]);
  assert.deepEqual(mistake.cards.map((card) => card.kind).sort(), ['memory', 'mistake']);
  const orphan = scan.entries.find((entry) => entry.imagePath === fixture.orphanImage);
  assert.match(orphan.metadata.noteUid, /^legacy-[a-f0-9]{24}$/);
  const secondScan = scanNoteIndex({ notesRoot: fixture.notesRoot });
  assert.equal(
    secondScan.entries.find((entry) => entry.imagePath === fixture.orphanImage).metadata.noteUid,
    orphan.metadata.noteUid,
  );
});

test('default rebuild is preview-only and --apply flattens safely, backs up and atomically rebuilds the index', (t) => {
  const fixture = makeFixture(t);
  const now = () => new Date('2026-07-18T08:00:00.000Z');
  const store = createLearningDataStore({ assistantRoot: fixture.assistantRoot, now, timeZone: 'Asia/Shanghai' });
  store.upsertDayManual('2026-07-17', { note: '必须保留的课表备注' });
  store.syncNote({ noteUid: 'stale-index', title: '旧索引', createdAt: '2026-07-13T00:00:00.000Z' });
  const revisionBefore = store.getSnapshot().revision;
  const lockPath = path.join(fixture.assistantRoot, 'note-organizer.lock');
  writeJson(lockPath, { pid: 999999, startedAt: '2020-01-01T00:00:00.000Z' });

  const preview = rebuildNoteIndex({ notesRoot: fixture.notesRoot, assistantRoot: fixture.assistantRoot, now });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.flattenMoves.length, 1);
  assert.equal(store.getSnapshot().revision, revisionBefore);
  assert.equal(fs.existsSync(fixture.imagePath), true);
  assert.equal(fs.existsSync(lockPath), true, 'preview must not even clean a stale lock');

  assert.throws(() => rebuildNoteIndex({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    apply: true,
    now,
  }), { code: 'NOTE_INDEX_REVIEW_REQUIRED' });

  const applied = rebuildNoteIndex({
    notesRoot: fixture.notesRoot,
    assistantRoot: fixture.assistantRoot,
    apply: true,
    allowPartial: true,
    now,
    lockStaleMs: 1,
  });
  assert.equal(applied.dryRun, false);
  assert.equal(applied.moved.length, 1);
  assert.equal(fs.existsSync(applied.backupPath), true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(fixture.imagePath), false);
  const flattenedImage = path.join(fixture.notesRoot, '高等数学', path.basename(fixture.imagePath));
  assert.equal(fs.existsSync(flattenedImage), true);
  assert.equal(
    fs.existsSync(path.dirname(fixture.imagePath)),
    false,
    'empty knowledge-point directory should be removed',
  );
  const orphanSidecar = path.join(
    path.dirname(fixture.orphanImage),
    '.metadata',
    `${path.parse(fixture.orphanImage).name}.note.json`,
  );
  assert.equal(fs.existsSync(orphanSidecar), true, 'orphan image must receive a persistent sidecar and uid');
  const journalPath = path.join(fixture.assistantRoot, 'note-organizer-moves.jsonl');
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(journal.some((entry) => entry.phase === 'planned'), true);
  assert.equal(journal.some((entry) => entry.phase === 'completed'), true);

  const snapshot = store.getSnapshot();
  const notes = Object.values(snapshot.days).flatMap((day) => day.autoNotes);
  assert.equal(notes.length, 2);
  assert.equal(notes.some((note) => note.noteUid === 'stale-index'), false);
  assert.equal(snapshot.days['2026-07-17'].manual.note, '必须保留的课表备注');
  const mistake = notes.find((note) => note.noteUid === 'same-note-uid');
  assert.equal(mistake.filePath, flattenedImage);
  assert.equal(mistake.tags.includes('错题'), true);
  assert.equal(mistake.pageRefs[0].question, '3.1');
  const orphan = notes.find((note) => note.filePath.endsWith('页面置换.png'));
  assert.equal(orphan.capturedDate, '2026-07-14');
  assert.equal(snapshot.cards.filter((card) => card.noteUid === 'same-note-uid').length, 2);
});

test('capturedAt and createdAt win over mtimes, then image mtime is used', () => {
  const imageStat = { mtime: new Date('2026-07-10T00:00:00.000Z') };
  const sidecarStat = { mtime: new Date('2026-07-09T00:00:00.000Z') };
  assert.equal(
    resolveCapturedAt({ capturedAt: '2026-07-12T03:00:00.000Z', createdAt: '2026-07-11T03:00:00.000Z' }, imageStat, sidecarStat).toISOString(),
    '2026-07-12T03:00:00.000Z',
  );
  assert.equal(
    resolveCapturedAt({}, imageStat, sidecarStat).toISOString(),
    '2026-07-10T00:00:00.000Z',
  );
});
