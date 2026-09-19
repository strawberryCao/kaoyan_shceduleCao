const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportBundle, verify, stageBundle, prepareRuntime, rewriteWindowsPath, safeName } = require('../windows-migration-bundle.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = { notes: path.join(root, 'source-notes'), assistant: path.join(root, 'source-assistant') };
  for (const dir of Object.values(roots)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(roots.notes, '图片.png'), Buffer.from([0, 1, 255, 9]));
  fs.writeFileSync(path.join(roots.assistant, 'learning-data.json'), JSON.stringify({ cards: [{ id: 'one', title: '人工标题' }], deletedNotes: { gone: true }, unknown: { preserved: true } }));
  fs.writeFileSync(path.join(roots.assistant, 'ai-providers.json.old.bak'), 'SECRET');
  fs.writeFileSync(path.join(roots.assistant, 'qwen-config.json'), 'SECRET');
  return { root, roots, bundle: path.join(root, 'bundle') };
}
test('business bundle preserves exact bytes including unknown fields and tombstones, excludes credential backups', t => {
  const f = fixture(t);
  const result = exportBundle(f.roots, f.bundle);
  assert.equal(result.files, 2);
  assert.equal(result.excluded, 2);
  const stage = path.join(f.root, 'shadow');
  assert.equal(stageBundle(f.bundle, stage).activationReady, false);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'assistant/learning-data.json')), fs.readFileSync(path.join(f.roots.assistant, 'learning-data.json')));
  assert.equal(verify(stage).files.length, 2);
  assert.throws(() => stageBundle(f.bundle, stage), /exist/i);
});
test('corrupt bundles never create staging destination', t => {
  const f = fixture(t);
  exportBundle(f.roots, f.bundle);
  fs.appendFileSync(path.join(f.bundle, 'notes/图片.png'), 'corrupt');
  const destination = path.join(f.root, 'shadow');
  assert.throws(() => stageBundle(f.bundle, destination), /verification failed/);
  assert.equal(fs.existsSync(destination), false);
});
test('rejects traversal, alternate streams and cross-platform ambiguous paths', () => {
  for (const name of ['notes/../secret', 'notes/C:secret', 'notes/a\\b', 'notes/CON', 'notes/a.', 'notes//a']) assert.throws(() => safeName(name));
});
test('rejects unlisted files and exporting back into source', t => {
  const f = fixture(t);
  assert.throws(() => exportBundle(f.roots, path.join(f.roots.notes, 'bundle')), /outside/);
  exportBundle(f.roots, f.bundle);
  fs.writeFileSync(path.join(f.bundle, 'extra'), 'unexpected');
  assert.throws(() => verify(f.bundle), /Unlisted/);
});
test('prepares a Mac shadow runtime and rewrites stored Windows roots', t => {
  const f = fixture(t);
  const sourcePath = path.join(f.roots.notes, '图片.png');
  fs.writeFileSync(path.join(f.roots.assistant, 'learning-data.json'), JSON.stringify({
    cards: [], deletedNotes: { gone: true }, filePath: sourcePath,
    nested: { sourceFilePath: sourcePath, unknown: 'preserved' },
  }));
  exportBundle(f.roots, f.bundle);
  const runtime = path.join(f.root, 'runtime-shadow');
  const prepared = prepareRuntime(f.bundle, runtime);
  assert.equal(prepared.activationReady, true);
  assert.equal(prepared.rewrittenPaths, 2);
  const migrated = JSON.parse(fs.readFileSync(path.join(runtime, 'data/assistant/learning-data.json')));
  assert.equal(migrated.filePath, path.join(runtime, 'data/notes/图片.png'));
  assert.equal(migrated.nested.sourceFilePath, migrated.filePath);
  assert.equal(migrated.nested.unknown, 'preserved');
  assert.deepEqual(migrated.deletedNotes, { gone: true });
});
test('keeps unknown external Windows paths visible and blocks activation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.roots.assistant, 'learning-data.json'), JSON.stringify({ filePath: 'D:\\external\\missing.png' }));
  exportBundle(f.roots, f.bundle);
  const prepared = prepareRuntime(f.bundle, path.join(f.root, 'runtime-shadow'));
  assert.equal(prepared.activationReady, false);
  assert.equal(prepared.unresolvedWindowsPaths, 1);
});
test('reports a source-stale internal reference without blaming or blocking the byte-complete migration', t => {
  const f = fixture(t);
  const missingSourcePath = path.join(f.roots.notes, 'historical-missing.png');
  fs.writeFileSync(path.join(f.roots.assistant, 'learning-data.json'), JSON.stringify({
    deletedNotes: { old: { filePath: missingSourcePath } },
  }));
  exportBundle(f.roots, f.bundle);
  const runtime = path.join(f.root, 'runtime-shadow');
  const prepared = prepareRuntime(f.bundle, runtime);
  assert.equal(prepared.activationReady, true);
  assert.equal(prepared.brokenInternalPaths, 0);
  assert.equal(prepared.preexistingMissingPaths, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'migration-manifest.json'), 'utf8'));
  assert.equal(manifest.preexistingMissingPathsRequireReview, true);
  assert.equal(manifest.preexistingMissingPaths[0].expectedBundlePath, 'notes/historical-missing.png');
});
test('rewrites only paths rooted in the declared source', () => {
  const sources = { notes: 'C:\\Users\\ASUS\\Desktop\\笔记', assistant: 'C:\\Users\\ASUS\\Desktop\\考研桌面助手' };
  const targets = { notes: '/tmp/runtime/data/notes', assistant: '/tmp/runtime/data/assistant' };
  assert.equal(rewriteWindowsPath('c:\\users\\asus\\desktop\\笔记\\高数\\a.png', sources, targets), path.join(targets.notes, '高数', 'a.png'));
  assert.equal(rewriteWindowsPath('D:\\outside\\a.png', sources, targets), 'D:\\outside\\a.png');
});
