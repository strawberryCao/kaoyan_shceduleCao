const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activationPlan,
  parseArguments,
  promotePreparedPaths,
  seedAuthority,
  verifyPreparedRuntime,
} = require('../activate-macmini-migration.cjs');
const { createCanvasDocumentStore } = require('../canvas-document-store.cjs');
const { createLearningDataStore } = require('../learning-data-store.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const { createSyncStore } = require('../sync-core.cjs');
const { exportBundle, prepareRuntime } = require('../windows-migration-bundle.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-activation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notes = path.join(root, 'source-notes');
  const assistant = path.join(root, 'source-assistant');
  fs.mkdirSync(notes);
  fs.mkdirSync(assistant);
  const assetPath = path.join(notes, '英语', '题目.png');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from('migration-image'));
  const learning = createLearningDataStore({ assistantRoot: assistant, lockPath: path.join(root, 'learning.lock') });
  learning.createNote({
    noteUid: 'active-note',
    capturedDate: '2026-09-19',
    title: 'Windows 主记录',
    subject: '英语',
    attachments: [{ id: 'asset-1', kind: 'image', name: '题目.png', mimeType: 'image/png', filePath: assetPath }],
  });
  learning.createNote({ noteUid: 'deleted-note', capturedDate: '2026-09-18', title: '保留删除历史', subject: '高等数学' });
  learning.deleteNote('deleted-note');
  learning.upsertDayManual('2026-09-19', { note: 'Windows 人工记录' });

  const canvas = createCanvasDocumentStore({ rootDir: path.join(assistant, 'canvas-projects') });
  canvas.saveDocument({
    id: 'canvas-import',
    version: 1,
    title: 'Windows 画布',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:01:00.000Z',
    images: [{ id: 'image-a', src: 'data:image/png;base64,aW1hZ2U=', name: '图.png', x: 0, y: 0, width: 100, height: 100, naturalWidth: 100, naturalHeight: 100, z: 1 }],
    texts: [], anchors: [], annotations: [], strokes: [], groups: [], relations: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
  });
  const bundle = path.join(root, 'bundle');
  exportBundle({ notes, assistant }, bundle);
  return { root, notes, assistant, bundle, assetPath };
}

test('activation plan is read-only and requires an explicit Windows-authority confirmation for apply', (t) => {
  const f = fixture(t);
  const parsed = parseArguments(['plan', `--bundle=${f.bundle}`, '--runtime-root=/Library/Application Support/KaoyanStudyCenter']);
  const plan = activationPlan(parsed);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.activationPerformed, false);
  assert.equal(plan.preservesPreviousMacDataAsRollback, true);
  assert.equal(plan.verifiedFiles > 0, true);
  assert.throws(() => parseArguments(['plan']), /bundle/);
});

test('prepared Windows data seeds Mac authority, tombstones, attachments and canvas before promotion', (t) => {
  const f = fixture(t);
  const preparedRoot = path.join(f.root, 'prepared');
  assert.equal(prepareRuntime(f.bundle, preparedRoot).activationReady, true);
  const manifest = verifyPreparedRuntime(preparedRoot);
  assert.equal(manifest.activationReady, true);

  const seeded = seedAuthority(preparedRoot);
  assert.equal(seeded.deletedNotes, 1);
  assert.equal(seeded.canvases, 1);
  assert.equal(seeded.status.openConflictCount, 0);
  const authority = createSyncStore({
    databasePath: path.join(preparedRoot, 'data', 'sync', 'authority.sqlite'),
    assetsRoot: path.join(preparedRoot, 'data', 'assets', 'sha256'),
  });
  try {
    const active = authority.getEntity('learning-note', 'active-note');
    assert.equal(active.document.title, 'Windows 主记录');
    assert.equal(active.assetHashes.length, 1);
    assert.equal(authority.hasAsset(active.assetHashes[0]), true);
    assert.equal(authority.getEntity('learning-note', 'deleted-note').deleted, true);
    assert.equal(authority.getEntity('learning-day', '2026-09-19').document.note, 'Windows 人工记录');
    assert.equal(authority.getEntity('canvas-project', 'canvas-import').assetHashes.length, 1);
  } finally {
    authority.close();
  }

  const finalRoot = path.join(f.root, 'final-runtime');
  const runtime = resolveRuntimePaths({
    env: { KAOYAN_RUNTIME_LAYOUT: 'managed', KAOYAN_RUNTIME_ROOT: finalRoot },
    platform: process.platform,
  });
  const promoted = promotePreparedPaths(preparedRoot, runtime);
  assert.equal(promoted.rewritten > 0, true);
  const snapshot = JSON.parse(fs.readFileSync(path.join(preparedRoot, 'data', 'assistant', 'learning-data.json'), 'utf8'));
  assert.equal(snapshot.days['2026-09-19'].autoNotes[0].attachments[0].filePath,
    path.join(runtime.notesRoot, '英语', '题目.png'));
});

test('tampered prepared data is rejected before authority seeding or service changes', (t) => {
  const f = fixture(t);
  const preparedRoot = path.join(f.root, 'prepared-tampered');
  prepareRuntime(f.bundle, preparedRoot);
  fs.appendFileSync(path.join(preparedRoot, 'data', 'assistant', 'learning-data.json'), 'tamper');
  assert.throws(() => verifyPreparedRuntime(preparedRoot), /verification failed/);
  assert.equal(fs.existsSync(path.join(preparedRoot, 'data', 'sync', 'authority.sqlite')), false);
});
